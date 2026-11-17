let ws: WebSocket | null = null;
let currentWsUrl = 'ws://127.0.0.1:4110/ws';
let reconnectDelayMs = 1000;
let reconnectTimer: number | null = null;
let heartbeatTimer: number | null = null;
let isShuttingDown = false;

function notifyRuntime(payload: Record<string, unknown>): void {
  chrome.runtime.sendMessage(payload).catch(() => {
    // Background worker may be waking up; ignore transient send errors
  });
}

function scheduleReconnect(): void {
  if (isShuttingDown || reconnectTimer !== null) {
    return;
  }
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(10000, Math.round(reconnectDelayMs * 1.5));
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(currentWsUrl);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    reconnectDelayMs = 1000;
    notifyRuntime({ type: 'offscreen:ws-connected', wsUrl: currentWsUrl });
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(String(event.data)) as Record<string, unknown>;
      notifyRuntime({ type: 'offscreen:ws-message', data });
    } catch {
      // Ignore malformed JSON frames
    }
  });

  ws.addEventListener('close', () => {
    ws = null;
    notifyRuntime({ type: 'offscreen:ws-disconnected' });
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // 'close' event follows and schedules reconnect
  });
}

function startHeartbeat(): void {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = window.setInterval(() => {
    notifyRuntime({
      type: 'offscreen:keepalive',
      connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
    });
  }, 20000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
    return false;
  }

  if (msg.type === 'offscreen:send-ws') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg.payload));
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'WebSocket not open' });
    }
    return false;
  }

  if (msg.type === 'offscreen:set-url') {
    const nextUrl = typeof msg.wsUrl === 'string' ? msg.wsUrl : currentWsUrl;
    if (nextUrl !== currentWsUrl) {
      currentWsUrl = nextUrl;
      if (ws) {
        isShuttingDown = false;
        ws.close();
        ws = null;
      }
      connect();
    } else if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
    }
    sendResponse({ ok: true, connected: Boolean(ws && ws.readyState === WebSocket.OPEN) });
    return false;
  }

  if (msg.type === 'offscreen:get-status') {
    sendResponse({
      connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
      wsUrl: currentWsUrl,
    });
    return false;
  }

  return false;
});

startHeartbeat();
connect();
