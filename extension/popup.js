const $ = (id) => document.getElementById(id);

async function loadForm() {
  const data = await chrome.storage.sync.get({
    serverUrl: 'http://127.0.0.1:5001',
    workerToken: '',
  });
  $('serverUrl').value = data.serverUrl;
  $('workerToken').value = data.workerToken;
}

function renderStatus(s) {
  const on = !!s?.connected;
  $('dot').classList.toggle('on', on);
  $('statusText').textContent = on ? 'Connected to server' : 'Disconnected';
  $('jobsDone').textContent = String(s?.jobsDone ?? 0);
  $('socketId').textContent = s?.socketId || '—';
  $('lastError').textContent = s?.lastError ? `Error: ${s.lastError}` : '';
}

async function refresh() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    renderStatus(s);
  } catch (e) {
    renderStatus({ connected: false, lastError: e.message });
  }
}

$('saveBtn').addEventListener('click', async () => {
  const serverUrl = $('serverUrl').value.trim().replace(/\/$/, '');
  const workerToken = $('workerToken').value.trim();
  // storage.onChanged in background triggers reconnect — don't also send RECONNECT
  await chrome.storage.sync.set({ serverUrl, workerToken });
  setTimeout(refresh, 600);
});

$('reconnectBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RECONNECT' });
  setTimeout(refresh, 500);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATUS') renderStatus(msg.payload);
});

loadForm().then(refresh);
setInterval(refresh, 2000);
