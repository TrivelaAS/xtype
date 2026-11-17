import fs from 'node:fs';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CreateJobInput,
  ExtensionStateSnapshot,
  JobStatus,
  WsExtensionMessage,
  WsServerMessage,
} from '../shared/types';
import { JobQueue, QueueValidationError } from './queue';

export interface XTypeServerOptions {
  port?: number;
  host?: string;
  dataFilePath?: string;
  cooldownMs?: number;
  apiKey?: string;
  mockHtmlPath?: string;
}

export interface XTypeServerHandle {
  queue: JobQueue;
  start: () => Promise<number>;
  close: () => Promise<void>;
  getPort: () => number;
  getExtensionState: () => ExtensionStateSnapshot;
}

const DEFAULT_MOCK_HTML_PATH = path.resolve(process.cwd(), 'test/mock-x.html');

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const maxBytes = 1024 * 1024; // 1MB safety limit

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new QueueValidationError('Request payload too large');
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new QueueValidationError('Invalid JSON payload');
  }
}

function isAuthorized(req: IncomingMessage, apiKey?: string): boolean {
  if (!apiKey) {
    return true;
  }

  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey === apiKey) {
    return true;
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim() === apiKey;
  }

  return false;
}

export function createXTypeServer(options: XTypeServerOptions = {}): XTypeServerHandle {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 4110;
  const cooldownMs = options.cooldownMs ?? 1200;
  const apiKey = options.apiKey ?? process.env.XTYPE_API_KEY;
  const mockHtmlPath = options.mockHtmlPath ?? DEFAULT_MOCK_HTML_PATH;
  const queue = new JobQueue(options.dataFilePath);

  let activeSocket: WebSocket | null = null;
  let boundWindowId: number | null = null;
  let boundTabId: number | null = null;
  let lastHeartbeatAt: string | null = null;
  let cooldownTimer: NodeJS.Timeout | null = null;
  let pingInterval: NodeJS.Timeout | null = null;
  let boundPort = requestedPort;

  function sendWsMessage(socket: WebSocket | null, message: WsServerMessage): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  function dispatchNext(): void {
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }

    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const nextJob = queue.popNextQueued();
    if (!nextJob) {
      return;
    }

    const sent = sendWsMessage(activeSocket, {
      type: 'job:dispatch',
      job: nextJob,
    });

    if (!sent) {
      queue.updateStatus(nextJob.id, 'queued', { progress: 0 });
    }
  }

  function scheduleNextDispatch(): void {
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }

    if (cooldownMs <= 0) {
      dispatchNext();
      return;
    }

    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      dispatchNext();
    }, cooldownMs);
    cooldownTimer.unref();
  }

  function getExtensionState(): ExtensionStateSnapshot {
    const activeJob = queue.getActiveJob();
    return {
      connected: Boolean(activeSocket && activeSocket.readyState === WebSocket.OPEN),
      boundWindowId,
      boundTabId,
      activeJobId: activeJob?.id ?? null,
      lastHeartbeatAt,
    };
  }

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      const jobs = queue.list();
      const queuedCount = jobs.filter((j) => j.status === 'queued').length;
      const ext = getExtensionState();
      sendJson(res, 200, {
        ok: true,
        extensionConnected: ext.connected,
        boundWindowId: ext.boundWindowId,
        boundTabId: ext.boundTabId,
        activeJobId: ext.activeJobId,
        lastHeartbeatAt: ext.lastHeartbeatAt,
        queuedCount,
        totalJobs: jobs.length,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/mock-x') {
      if (!fs.existsSync(mockHtmlPath)) {
        sendJson(res, 404, { error: 'mock-x.html not found' });
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(mockHtmlPath, 'utf8'));
      return;
    }

    if (pathname.startsWith('/api/') && !isAuthorized(req, apiKey)) {
      sendJson(res, 401, { error: 'Unauthorized: invalid or missing API key' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/jobs') {
      sendJson(res, 200, { jobs: queue.list() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/jobs') {
      try {
        const body = (await readJsonBody(req)) as CreateJobInput;
        const job = queue.enqueue(body);
        dispatchNext();
        const latest = queue.get(job.id) ?? job;
        sendJson(res, 201, { job: latest });
      } catch (error) {
        if (error instanceof QueueValidationError) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
      return;
    }

    const singleMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && singleMatch) {
      const job = queue.get(singleMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }
      sendJson(res, 200, { job });
      return;
    }

    const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const result = queue.cancel(cancelMatch[1]);
      if (!result) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }
      if (result.wasActive) {
        sendWsMessage(activeSocket, {
          type: 'job:cancel',
          jobId: result.job.id,
        });
        scheduleNextDispatch();
      }
      sendJson(res, 200, { job: result.job });
      return;
    }

    const completeMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/complete$/);
    if (req.method === 'POST' && completeMatch) {
      try {
        const body = (await readJsonBody(req)) as {
          status?: JobStatus;
          error?: string;
          progress?: number;
        };
        const status: JobStatus =
          body.status === 'failed' || body.status === 'cancelled' ? body.status : 'completed';
        const updated = queue.updateStatus(completeMatch[1], status, {
          progress: body.progress ?? (status === 'completed' ? 100 : undefined),
          error: body.error,
        });
        if (!updated) {
          sendJson(res, 404, { error: 'Job not found' });
          return;
        }
        scheduleNextDispatch();
        sendJson(res, 200, { job: updated });
      } catch (error) {
        if (error instanceof QueueValidationError) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    if (apiKey) {
      const token = url.searchParams.get('token');
      const headerOk = isAuthorized(req, apiKey);
      if (!headerOk && token !== apiKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    if (activeSocket && activeSocket !== ws && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.close(1000, 'Replaced by new extension connection');
    }

    activeSocket = ws;
    lastHeartbeatAt = new Date().toISOString();

    sendWsMessage(ws, {
      type: 'welcome',
      serverTime: lastHeartbeatAt,
    });

    // Dispatch any job that was queued before extension connected
    dispatchNext();

    ws.on('message', (data) => {
      let msg: WsExtensionMessage;
      try {
        msg = JSON.parse(data.toString('utf8')) as WsExtensionMessage;
      } catch {
        return;
      }

      lastHeartbeatAt = new Date().toISOString();

      if (msg.type === 'hello' || msg.type === 'pong') {
        boundWindowId = msg.boundWindowId;
        boundTabId = msg.boundTabId;
        if (msg.type === 'hello') {
          dispatchNext();
        }
      } else if (msg.type === 'window:bound') {
        boundWindowId = msg.windowId;
        boundTabId = msg.tabId;
      } else if (msg.type === 'job:status') {
        const updated = queue.updateStatus(msg.jobId, msg.status, {
          progress: msg.progress,
          error: msg.error,
        });
        if (
          updated &&
          (msg.status === 'completed' || msg.status === 'failed' || msg.status === 'cancelled')
        ) {
          scheduleNextDispatch();
        }
      }
    });

    ws.on('close', () => {
      if (activeSocket === ws) {
        activeSocket = null;
      }
    });
  });

  return {
    queue,
    getPort: () => boundPort,
    getExtensionState,
    start: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, host, () => {
          server.removeListener('error', reject);
          const addr = server.address() as AddressInfo | null;
          boundPort = addr?.port ?? requestedPort;

          pingInterval = setInterval(() => {
            if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
              sendWsMessage(activeSocket, { type: 'ping' });
            }
          }, 20000);
          pingInterval.unref();

          resolve(boundPort);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (cooldownTimer) {
          clearTimeout(cooldownTimer);
          cooldownTimer = null;
        }
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        for (const client of wss.clients) {
          client.terminate();
        }
        activeSocket = null;
        wss.close(() => {
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }),
  };
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.PORT ?? 4110);
  const host = process.env.HOST ?? '127.0.0.1';
  const srv = createXTypeServer({ port, host });
  srv
    .start()
    .then((actualPort) => {
      console.log(`XType bridge server listening on http://${host}:${actualPort}`);
      console.log(`WebSocket endpoint: ws://${host}:${actualPort}/ws`);
      console.log(`Mock X test page:   http://${host}:${actualPort}/mock-x`);
    })
    .catch((err) => {
      console.error('Failed to start XType server:', err);
      process.exit(1);
    });
}
