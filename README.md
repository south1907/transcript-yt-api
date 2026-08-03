# YouTube Transcript API

Flask server + Chrome extension worker. The API runs on your server; the extension (on a machine with a residential/browser IP) fetches YouTube captions via Innertube (same approach as `thamkhao`) and returns them over **native WebSocket** (`/ws/worker`).

> Chrome MV3 service workers do not support `XMLHttpRequest`, so Socket.IO polling (`xhr poll error`) cannot work there.

```
Client (youtuhoc-be)
  POST /api/transcript/get  {"url":"https://www.youtube.com/watch?v=..."}
        │
        ▼
  Flask transcript-api  ──WebSocket──►  Chrome extension worker
        │                                      │
        │◄──────── transcript segments ────────┘
        ▼
  { "success": true, "data": [ {"c":"...","s":0.0,"dur":2.1}, ... ] }
```

Compatible with `youtuhoc-be` `TRANSCRIPT_API_URL` (`.../api/transcript/get`).

## Quick start (local)

### 1. Server

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # optional
# macOS: port 5000 is often AirPlay → use 5001
PORT=5001 python app.py
```

Health check: `curl http://127.0.0.1:5001/health`

### 2. Chrome extension

1. Open `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder (or click Reload)
3. Popup → Server URL = `http://127.0.0.1:5001` → **Save & Connect**
4. Optional: Worker token = `WORKER_TOKEN` on server
5. Badge should show **ON**

### 3. Test

```bash
curl -X POST http://127.0.0.1:5001/api/transcript/get \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
```

## Deploy on server

```bash
docker compose up -d --build
```

Nginx needs WebSocket upgrade for `/ws/worker`:

```nginx
location / {
  proxy_pass http://127.0.0.1:5000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_read_timeout 120s;
}
```

```
TRANSCRIPT_API_URL=https://your-domain/api/transcript/get
```

## API

| Method | Path | Body | Notes |
|--------|------|------|--------|
| GET | `/health` | — | workers / idle count |
| GET | `/api/workers` | — | list connected workers |
| POST | `/api/transcript/get` | `{"url"}` or `{"video_id"}` | waits for extension |
| WS | `/ws/worker` | JSON messages | extension worker channel |

## Env vars

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `5000` | listen port |
| `API_KEY` | empty | if set, require `X-API-Key` on HTTP API |
| `WORKER_TOKEN` | empty | if set, extension must pass `?token=` on WS |
| `JOB_TIMEOUT_SEC` | `45` | max wait for worker |

## Notes

- Keep **one** gunicorn worker (`-w 1`) with gthread: job state is in-memory.
- Extension must stay connected (Chrome open). Use a dedicated always-on browser profile for 24/7.
- Transcript logic mirrors `thamkhao/content/utils/transcriptClient.js`.
