"""
YouTube Transcript API — Flask + native WebSocket bridge to Chrome extension workers.

Chrome MV3 service workers have no XMLHttpRequest, so Socket.IO polling fails
with "xhr poll error". Native WebSocket works in service workers.

Flow:
  Client POST /api/transcript/get {url|video_id}
    → server assigns job to a connected Chrome extension worker (WS)
    → worker fetches transcript in browser (Innertube)
    → worker returns segments via WebSocket
    → HTTP response {success, data: [{c,s,dur}, ...]}
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_sock import Sock

from config import Config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("transcript-api")

app = Flask(__name__)
app.config["SECRET_KEY"] = Config.SECRET_KEY
CORS(app, resources={r"/*": {"origins": Config.CORS_ORIGINS}})
sock = Sock(app)

# ---------------------------------------------------------------------------
# In-memory worker + job state (single-process)
# ---------------------------------------------------------------------------
_lock = threading.Lock()
# sid -> {"busy": bool, "ws": ws, "connected_at": float, "jobs_done": int}
workers: Dict[str, Dict[str, Any]] = {}
# job_id -> {"done": bool, "result": list|None, "error": str|None, "worker_sid": str}
jobs: Dict[str, Dict[str, Any]] = {}

VIDEO_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{11}$")


def extract_video_id(url_or_id: str) -> Optional[str]:
    raw = (url_or_id or "").strip()
    if not raw:
        return None
    if VIDEO_ID_RE.match(raw):
        return raw

    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()

    if "youtu.be" in host:
        vid = parsed.path.strip("/").split("/")[0]
        return vid if VIDEO_ID_RE.match(vid) else None

    if "youtube.com" in host or "youtube-nocookie.com" in host:
        qs = parse_qs(parsed.query)
        if "v" in qs and VIDEO_ID_RE.match(qs["v"][0]):
            return qs["v"][0]
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in ("embed", "shorts", "live", "v"):
            if VIDEO_ID_RE.match(parts[1]):
                return parts[1]
    return None


def require_api_key() -> Optional[tuple]:
    if not Config.API_KEY:
        return None
    key = request.headers.get("X-API-Key") or request.args.get("api_key")
    if key != Config.API_KEY:
        return jsonify({"success": False, "message": "Invalid or missing API key"}), 401
    return None


def ws_send(ws, payload: dict) -> bool:
    try:
        ws.send(json.dumps(payload))
        return True
    except Exception as exc:
        logger.warning("ws_send failed: %s", exc)
        return False


def pick_idle_worker() -> Optional[str]:
    with _lock:
        idle = [sid for sid, w in workers.items() if not w.get("busy")]
        if not idle:
            return None
        idle.sort(key=lambda s: workers[s].get("jobs_done", 0))
        sid = idle[0]
        workers[sid]["busy"] = True
        return sid


def release_worker(sid: Optional[str]) -> None:
    if not sid:
        return
    with _lock:
        if sid in workers:
            workers[sid]["busy"] = False
            workers[sid]["jobs_done"] = workers[sid].get("jobs_done", 0) + 1


def wait_for_job(job_id: str, timeout: float) -> Dict[str, Any]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with _lock:
            job = jobs.get(job_id)
            if not job:
                return {"success": False, "message": "Job not found"}
            if job.get("done"):
                break
        time.sleep(0.05)
    else:
        with _lock:
            job = jobs.pop(job_id, None)
        release_worker((job or {}).get("worker_sid"))
        return {"success": False, "message": "Timeout waiting for extension worker"}

    with _lock:
        job = jobs.pop(job_id, None) or {}

    release_worker(job.get("worker_sid"))

    if job.get("error"):
        return {"success": False, "message": job["error"]}
    return {
        "success": True,
        "data": job.get("result") or [],
        "language": job.get("language") or "",
        "source_language": job.get("source_language") or "",
        "kind": job.get("kind") or "",
        "pick_reason": job.get("pick_reason") or "",
        "available_languages": job.get("available_languages") or [],
    }


def handle_worker_message(sid: str, msg: dict) -> None:
    mtype = msg.get("type")

    if mtype == "worker_ready":
        with _lock:
            if sid in workers:
                workers[sid]["busy"] = False
        return

    if mtype == "ping":
        with _lock:
            ws = workers.get(sid, {}).get("ws")
        if ws:
            ws_send(ws, {"type": "pong", "t": time.time()})
        return

    if mtype == "transcript_result":
        job_id = msg.get("job_id")
        if not job_id:
            return
        with _lock:
            job = jobs.get(job_id)
            if not job:
                logger.warning("Orphan transcript_result for job %s", job_id)
                return
            if msg.get("success"):
                job["result"] = msg.get("data") or []
                job["language"] = msg.get("language") or ""
                job["source_language"] = msg.get("source_language") or ""
                job["kind"] = msg.get("kind") or ""
                job["pick_reason"] = msg.get("pick_reason") or ""
                job["available_languages"] = msg.get("available_languages") or []
                job["error"] = None
            else:
                job["error"] = msg.get("error") or "Unknown worker error"
                job["result"] = None
            job["done"] = True
        return

    logger.debug("Unknown worker message type=%s sid=%s", mtype, sid)


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    with _lock:
        total = len(workers)
        idle = sum(1 for w in workers.values() if not w.get("busy"))
    return jsonify(
        {
            "ok": True,
            "workers": total,
            "idle_workers": idle,
            "pending_jobs": len(jobs),
            "transport": "websocket",
        }
    )


@app.get("/api/workers")
def list_workers():
    denied = require_api_key()
    if denied:
        return denied
    with _lock:
        data = [
            {
                "sid": sid,
                "busy": w.get("busy"),
                "jobs_done": w.get("jobs_done", 0),
                "connected_at": w.get("connected_at"),
            }
            for sid, w in workers.items()
        ]
    return jsonify({"success": True, "workers": data})


@app.post("/api/transcript/get")
def get_transcript():
    """
    Compatible with youtuhoc-be TranscriptAPIService.
    Body: {"url": "..."} or {"video_id": "..."}
    Optional: {"languages": ["en"]}
    """
    denied = require_api_key()
    if denied:
        return denied

    body = request.get_json(silent=True) or {}
    video_id = extract_video_id(body.get("video_id") or body.get("url") or "")
    if not video_id:
        return jsonify({"success": False, "message": "Invalid or missing url/video_id"}), 400

    languages = body.get("languages") or body.get("language") or ["en"]
    if isinstance(languages, str):
        languages = [x.strip() for x in languages.split(",") if x.strip()]
    elif not isinstance(languages, list):
        languages = ["en"]
    languages = [str(x).strip() for x in languages if str(x).strip()]
    if not languages:
        languages = ["en"]

    with _lock:
        if not workers:
            return (
                jsonify(
                    {
                        "success": False,
                        "message": (
                            "No Chrome extension workers connected. "
                            "Open Chrome with the extension installed and connected."
                        ),
                    }
                ),
                503,
            )

    worker_sid = pick_idle_worker()
    if not worker_sid:
        return (
            jsonify(
                {
                    "success": False,
                    "message": "All extension workers are busy. Retry shortly.",
                }
            ),
            503,
        )

    job_id = str(uuid.uuid4())
    with _lock:
        jobs[job_id] = {
            "done": False,
            "result": None,
            "error": None,
            "worker_sid": worker_sid,
            "created_at": time.time(),
        }
        ws = workers.get(worker_sid, {}).get("ws")

    logger.info(
        "Dispatch job %s video=%s langs=%s → worker %s",
        job_id,
        video_id,
        languages,
        worker_sid,
    )
    if not ws or not ws_send(
        ws,
        {
            "type": "fetch_transcript",
            "job_id": job_id,
            "video_id": video_id,
            "languages": languages,
        },
    ):
        with _lock:
            jobs.pop(job_id, None)
        release_worker(worker_sid)
        return jsonify({"success": False, "message": "Failed to reach extension worker"}), 502

    outcome = wait_for_job(job_id, Config.JOB_TIMEOUT_SEC)
    if not outcome.get("success"):
        status = 504 if "Timeout" in (outcome.get("message") or "") else 502
        return jsonify(outcome), status

    data: List[dict] = outcome["data"]
    logger.info(
        "Job %s done — %d segments lang=%s reason=%s",
        job_id,
        len(data),
        outcome.get("language"),
        outcome.get("pick_reason"),
    )
    return jsonify(
        {
            "success": True,
            "data": data,
            "video_id": video_id,
            "language": outcome.get("language") or "",
            "source_language": outcome.get("source_language") or "",
            "kind": outcome.get("kind") or "",
            "pick_reason": outcome.get("pick_reason") or "",
            "available_languages": outcome.get("available_languages") or [],
        }
    )


# ---------------------------------------------------------------------------
# Native WebSocket — Chrome extension workers
# ---------------------------------------------------------------------------
@sock.route("/ws/worker")
def worker_ws(ws):
    token = (request.args.get("token") or "").strip()
    if Config.WORKER_TOKEN and token != Config.WORKER_TOKEN:
        logger.warning("Worker auth failed")
        ws_send(ws, {"type": "error", "message": "unauthorized"})
        return

    sid = str(uuid.uuid4())
    with _lock:
        workers[sid] = {
            "busy": False,
            "ws": ws,
            "connected_at": time.time(),
            "jobs_done": 0,
        }
    logger.info("Worker connected sid=%s (total=%d)", sid, len(workers))
    ws_send(ws, {"type": "connected", "sid": sid, "message": "worker registered"})

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(msg, dict):
                handle_worker_message(sid, msg)
    finally:
        with _lock:
            workers.pop(sid, None)
            for _job_id, job in list(jobs.items()):
                if job.get("worker_sid") == sid and not job.get("done"):
                    job["error"] = "Worker disconnected"
                    job["done"] = True
        logger.info("Worker disconnected sid=%s (total=%d)", sid, len(workers))


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logger.info("Starting transcript-api on %s:%s (websocket)", Config.HOST, Config.PORT)
    # threaded=True so HTTP API and WS workers don't block each other
    app.run(
        host=Config.HOST,
        port=Config.PORT,
        debug=os.getenv("FLASK_DEBUG", "0") == "1",
        threaded=True,
    )
