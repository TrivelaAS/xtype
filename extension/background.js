const HTTP = 'http://127.0.0.1:17843';
const SOCKET = 'ws://127.0.0.1:17843/extension';
let socket = null, heartbeat = null, connected = false, running = null, seq = 0;
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(path, data) {
  const { token } = await chrome.storage.local.get('token');
  if (!token) throw Error('Pair with the Windows helper first');
  const response = await fetch(HTTP + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(10000) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Helper request failed'); return result;
}
function rpc(method, jobId, args = {}) {
  if (!connected || socket?.readyState !== WebSocket.OPEN) return Promise.reject(Error('Helper disconnected'));
  const id = String(++seq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Helper timed out during ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ type: 'rpc', id, method, jobId, args }));
  });
}
let connecting = false;
async function connect() {
  if (connecting || (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState))) return;
  connecting = true;
  const { token } = await chrome.storage.local.get('token').finally(() => { connecting = false; });
  if (!token || (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState))) return;
  const ws = new WebSocket(SOCKET); socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token, extensionId: chrome.runtime.id }));
  ws.onmessage = event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ready') {
      connected = true; chrome.action.setBadgeText({ text: '' });
      clearInterval(heartbeat); heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 20000);
    } else if (message.type === 'result') {
      const p = pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(message.id); message.ok ? p.resolve(message.result) : p.reject(Error(message.error));
    } else if (message.type === 'job') void runJob(message.job, message.settings);
    else if (message.type === 'stop' && running) running.stopped = true;
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    connected = false; socket = null; clearInterval(heartbeat);
    if (running) running.stopped = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Helper disconnected')); } pending.clear();
    chrome.action.setBadgeText({ text: 'OFF' });
    setTimeout(() => void connect(), 5000);
  };
  ws.onerror = () => {};
}
async function content(tabId, method, args = {}) {
  const response = await chrome.tabs.sendMessage(tabId, { channel: 'typed-postx', method, args });
  if (!response?.ok) throw Error(response?.error || 'X page did not respond'); return response.result;
}
async function pageReady(tabId) {
  const deadline = Date.now() + 30000;
  do { try { const tab = await chrome.tabs.get(tabId); if (tab.status === 'complete' && tab.url?.startsWith('https://x.com/')) { await content(tabId, 'ping'); return; } } catch { /* Wait for content script after navigation. */ } await sleep(200); } while (Date.now() < deadline);
  throw Error('X did not load. Check the tab and login.');
}
async function checkRun(run) {
  if (running !== run || run.stopped) throw Error('Job stopped');
  const tab = await chrome.tabs.get(run.tabId);
  const win = await chrome.windows.get(tab.windowId);
  if (!tab.active || !win.focused) throw Error('Chrome window or tab focus changed');
}
async function runJob(job, settings) {
  if (running) { await rpc('fail', job.id, { error: 'An earlier job is still ending' }).catch(() => {}); return; }
  const run = { id: job.id, marker: `TypedPostX:${crypto.randomUUID()}`, stopped: false, tabId: null };
  running = run;
  try {
    chrome.action.setBadgeText({ text: 'TYPE' }); chrome.action.setBadgeBackgroundColor({ color: '#d75b2b' });
    // New job tabs preserve existing user tabs and never navigate away from a partial draft.
    const tab = await chrome.tabs.create({ url: job.url || 'https://x.com/home', active: true }); run.tabId = tab.id;
    await chrome.windows.update(tab.windowId, { focused: true });
    await pageReady(tab.id); await checkRun(run);
    await content(tab.id, 'prepare', { job, marker: run.marker, expectedAccount: settings.expectedAccount });
    await checkRun(run); await rpc('arm', job.id, { marker: run.marker });
    for (const character of job.text) {
      await checkRun(run); await content(tab.id, 'guard', { marker: run.marker });
      await rpc('key', job.id, { text: character });
    }
    await sleep(250); await checkRun(run);
    const readback = await content(tab.id, 'read', { marker: run.marker });
    await rpc('ready', job.id, readback);
    if (job.mode === 'draft') { await rpc('complete', job.id); return; }
    await checkRun(run);
    await rpc('submit', job.id);
    await checkRun(run);
    await content(tab.id, 'publish', { marker: run.marker, text: job.text });
    const candidate = await content(tab.id, 'publishedCandidate', { marker: run.marker });
    await content(tab.id, 'cleanup');
    await chrome.tabs.update(tab.id, { url: candidate.url });
    await pageReady(tab.id);
    const result = await content(tab.id, 'verify', { url: candidate.url, expectedAccount: settings.expectedAccount, text: job.text });
    await rpc('complete', job.id, result);
  } catch (error) {
    await rpc('fail', job.id, { error: error.message }).catch(() => {});
    chrome.action.setBadgeText({ text: '!' });
  } finally {
    if (run.tabId) await content(run.tabId, 'cleanup').catch(() => {});
    running = null; chrome.action.setBadgeText({ text: connected ? '' : 'OFF' });
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'interrupted' && sender.tab?.id === running?.tabId && message.marker === running?.marker) {
    running.stopped = true; void api('/control', { action: 'pause' }).catch(() => {}); return;
  }
  if (sender.url !== chrome.runtime.getURL('panel.html')) return;
  const handle = async () => {
    if (message.type === 'pair') {
      const token = String(message.token || '').trim(); if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Use the 64-character pairing token from the helper');
      if (running) throw Error('Pause before changing pairing');
      await chrome.storage.local.set({ token });
      const state = await api('/status'); socket?.close(); socket = null; connected = false; await connect(); return state;
    }
    if (message.type === 'status') return api('/status');
    if (message.type === 'submit') return api('/jobs', message.job);
    if (message.type === 'settings') return api('/settings', message.settings);
    if (message.type === 'control') return api('/control', message.control);
    throw Error('Unknown panel action');
  };
  handle().then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message })); return true;
});
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') }));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') void connect(); });
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.alarms.create('reconnect', { periodInMinutes: 0.5 }); await connect();
}
chrome.runtime.onInstalled.addListener(() => void initialize());
chrome.runtime.onStartup.addListener(() => void initialize());
void initialize();
