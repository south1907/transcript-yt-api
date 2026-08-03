/**
 * Chrome MV3 service worker — native WebSocket to Flask transcript-api.
 * (Socket.IO polling needs XHR, which MV3 service workers do not provide.)
 */
import { getTranscriptFromClient } from './transcript.js?v=1.4.1';

const DEFAULT_SERVER = 'http://127.0.0.1:5001';
const RECONNECT_ALARM = 'transcript-worker-reconnect';
const KEEPALIVE_ALARM = 'transcript-worker-keepalive';

let ws = null;
let workerSid = null;
let reconnectTimer = null;
/** Bumps on every connect() so stale socket handlers are ignored. */
let connectGen = 0;

let status = {
  connected: false,
  serverUrl: DEFAULT_SERVER,
  lastError: null,
  jobsDone: 0,
  lastJobAt: null,
};

async function loadSettings() {
  return chrome.storage.sync.get({
    serverUrl: DEFAULT_SERVER,
    workerToken: '',
  });
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {
    /* ignore */
  }
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS', payload: { ...status } }).catch(() => {});
}

function toWsUrl(httpUrl, token) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws/worker';
  u.search = '';
  if (token) u.searchParams.set('token', token);
  return u.toString();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

async function handleFetchJob(payload) {
  const jobId = payload?.job_id;
  const videoId = payload?.video_id;
  const languages =
    Array.isArray(payload?.languages) && payload.languages.length
      ? payload.languages
      : ['en'];
  console.log('[transcript-worker] job', jobId, videoId, 'langs=', languages);

  if (!jobId || !videoId) {
    send({ type: 'transcript_result', job_id: jobId, success: false, error: 'Invalid job payload' });
    return;
  }

  try {
    const result = await getTranscriptFromClient(videoId, languages);
    send({
      type: 'transcript_result',
      job_id: jobId,
      success: true,
      data: result.segments,
      language: result.language,
      source_language: result.sourceLanguage,
      kind: result.kind,
      name: result.name,
      pick_reason: result.pickReason,
      available_languages: result.available,
    });
    status.jobsDone += 1;
    status.lastJobAt = Date.now();
    broadcastStatus();
  } catch (err) {
    console.error('[transcript-worker] job failed', err);
    send({
      type: 'transcript_result',
      job_id: jobId,
      success: false,
      error: err?.message || String(err),
    });
  } finally {
    send({ type: 'worker_ready' });
  }
}

async function connect() {
  const { serverUrl, workerToken } = await loadSettings();
  const httpBase = serverUrl.replace(/\/$/, '');
  const wsUrl = toWsUrl(httpBase, workerToken);

  // Already connected to the same endpoint — keep it
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) &&
    status.serverUrl === httpBase &&
    status._wsUrl === wsUrl
  ) {
    console.log('[transcript-worker] already connected/connecting, skip');
    return;
  }

  const gen = ++connectGen;
  clearReconnectTimer();
  status.serverUrl = httpBase;
  status._wsUrl = wsUrl;

  const prev = ws;
  ws = null;
  workerSid = null;
  if (prev) {
    try {
      prev.close();
    } catch (_) {
      /* ignore */
    }
  }

  console.log('[transcript-worker] connecting to', wsUrl);

  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (err) {
    if (gen !== connectGen) return;
    status.connected = false;
    status.lastError = err?.message || String(err);
    setBadge('ERR', '#dc2626');
    broadcastStatus();
    scheduleReconnect();
    return;
  }

  ws = socket;

  socket.onopen = () => {
    if (gen !== connectGen) {
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    status.connected = true;
    status.lastError = null;
    console.log('[transcript-worker] ws open');
    setBadge('ON', '#16a34a');
    send({ type: 'worker_ready' });
    broadcastStatus();
  };

  socket.onmessage = (ev) => {
    if (gen !== connectGen) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'connected') {
      workerSid = msg.sid || null;
      console.log('[transcript-worker] registered', workerSid);
      return;
    }
    if (msg.type === 'fetch_transcript') {
      handleFetchJob(msg);
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type === 'error') {
      status.lastError = msg.message || 'server error';
      broadcastStatus();
    }
  };

  socket.onerror = () => {
    if (gen !== connectGen) return;
    status.lastError = 'WebSocket error';
    console.error('[transcript-worker] ws error');
    setBadge('ERR', '#dc2626');
    broadcastStatus();
  };

  socket.onclose = (ev) => {
    // Ignore close from a superseded socket (fixes reconnect flap ~3s after connect)
    if (gen !== connectGen) return;
    if (ws === socket) ws = null;
    status.connected = false;
    workerSid = null;
    console.warn('[transcript-worker] ws closed', ev.code, ev.reason || '');
    setBadge('OFF', '#dc2626');
    broadcastStatus();
    scheduleReconnect();
  };
}

function ensureAlarms() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s — keep SW alive
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM || alarm.name === RECONNECT_ALARM) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    } else {
      send({ type: 'ping' });
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.serverUrl || changes.workerToken)) {
    // Force reconnect to new settings
    status._wsUrl = null;
    connect();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_STATUS') {
    sendResponse({
      ...status,
      socketId: workerSid,
      readyState: ws?.readyState ?? -1,
    });
    return true;
  }
  if (msg?.type === 'RECONNECT') {
    status._wsUrl = null;
    connect().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'TEST_FETCH') {
    getTranscriptFromClient(msg.videoId, ['en'])
      .then((data) =>
        sendResponse({
          success: true,
          count: data.segments.length,
          language: data.language,
          sample: data.segments.slice(0, 2),
        })
      )
      .catch((e) => sendResponse({ success: false, error: e.message }));
    return true;
  }
  return false;
});

ensureAlarms();
connect();
setBadge('…', '#ca8a04');
