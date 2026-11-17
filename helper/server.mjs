import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { JobStore, atomicJSON, ACTIVE } from './jobs.mjs';
import { NativeKeyboard } from './native.mjs';

const extensionOrigin = /^chrome-extension:\/\/([a-p]{32})$/;
const secureEqual = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const delay = ms => new Promise(r => setTimeout(r, ms));

export async function createServer({ dataDir, port = 17843, native = new NativeKeyboard() } = {}) {
  const isCustomDataDir = Boolean(dataDir);
  if (!dataDir) dataDir = process.env.TYPED_POSTX_DATA || join(process.env.LOCALAPPDATA || process.cwd(), 'TypedPostX');
  mkdirSync(dataDir, { recursive: true });
  const dataLogPath = join(dataDir, 'trace.log');
  const exeLogPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'TypedPostX-trace.log');
  const traceRing = [];
  const traceLog = (source, message, details) => {
    const extra = details !== undefined ? ` ${typeof details === 'string' ? details : JSON.stringify(details)}` : '';
    const line = `[${new Date().toISOString()}] [${source || 'HELPER'}] ${message || ''}${extra}`;
    traceRing.push(line);
    if (traceRing.length > 1000) traceRing.shift();
    try { appendFileSync(dataLogPath, line + '\n', 'utf8'); } catch {}
    if (!isCustomDataDir) {
      try { appendFileSync(exeLogPath, line + '\n', 'utf8'); } catch {}
    }
  };
  const configPath = join(dataDir, 'config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {
    token: randomBytes(32).toString('hex'), extensionId: null, expectedAccount: '', delayMs: 100, paused: false
  };
  if (!/^[a-f0-9]{64}$/.test(config.token)) throw Error('Invalid helper token configuration');
  const saveConfig = () => atomicJSON(configPath, config);
  saveConfig();
  const store = new JobStore(dataDir);
  if (store.list().some(j => j.status === 'needs-attention')) { config.paused = true; saveConfig(); }
  let client = null, active = null, closed = false;
  const send = (socket, message) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const publicConfig = () => ({ expectedAccount: config.expectedAccount, delayMs: config.delayMs, paused: config.paused });
  const status = () => ({ name: 'Typed PostX', version: '0.1.0', connected: !!client, paired: !!config.extensionId, ...publicConfig(), activeJob: active?.id || null, jobs: store.list().slice(-100).reverse() });
  const notify = () => send(client, { type: 'status', ...publicConfig() });
  function dispatch() {
    if (closed || !client || active || config.paused || !config.expectedAccount) return;
    const job = store.claim(); if (!job) return;
    active = { id: job.id, index: 0, chars: Array.from(job.text), lastKeyAt: 0 };
    traceLog('BROKER', `Dispatching job id=${job.id} action=${job.action} mode=${job.mode} len=${active.chars.length}`);
    send(client, { type: 'job', job, settings: publicConfig() });
  }
  async function stop(reason) {
    traceLog('BROKER', `Stop active=${active?.id || 'none'} reason="${reason}"`);
    config.paused = true; saveConfig();
    if (active) { store.update(active.id, { status: 'needs-attention', error: reason }); active = null; }
    send(client, { type: 'stop', reason });
    await native.request('disarm').catch(() => {}); notify();
  }
  function allowedOrigin(origin) {
    if (!origin) return true;
    const match = extensionOrigin.exec(origin);
    return !!match && (!config.extensionId || config.extensionId === match[1]);
  }
  function checkHost(req) { return req.headers.host === `127.0.0.1:${server.address()?.port}`; }
  async function body(req) {
    let length = 0; const chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > 131072) throw Error('Request too large'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('Invalid JSON body'); }
  }
  const server = http.createServer(async (req, res) => {
    const reply = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      if (!checkHost(req) || !allowedOrigin(req.headers.origin)) return reply(403, { error: 'Origin or host is not allowed' });
      if (!secureEqual(req.headers.authorization, `Bearer ${config.token}`)) return reply(401, { error: 'A valid bearer token is required' });
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === '/status') return reply(200, status());
      if (req.method === 'GET' && pathname === '/trace') {
        let lines = traceRing.slice(-250);
        if (!lines.length && existsSync(dataLogPath)) {
          lines = readFileSync(dataLogPath, 'utf8').trim().split(/\r?\n/).slice(-250).filter(Boolean);
        }
        return reply(200, { logPath: dataLogPath, exeLogPath: isCustomDataDir ? null : exeLogPath, lines });
      }
      if (req.method === 'POST' && pathname === '/trace') {
        const value = await body(req);
        traceLog(value.source || 'EXT', `${value.step || ''} ${value.message || ''}`.trim(), value.data ?? value.details);
        return reply(200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/jobs') return reply(200, store.list());
      if (req.method === 'GET' && pathname.startsWith('/jobs/')) {
        const job = store.get(decodeURIComponent(pathname.slice(6)));
        return reply(job ? 200 : 404, job || { error: 'Job not found' });
      }
      if (req.method === 'POST' && pathname === '/jobs') {
        const result = store.add(await body(req)); reply(result.created ? 201 : 200, result.job); dispatch(); return;
      }
      if (req.method === 'POST' && pathname === '/settings') {
        if (active) throw Error('Pause the queue before changing settings');
        const value = await body(req);
        const account = String(value.expectedAccount ?? config.expectedAccount).replace(/^@/, '');
        if (!/^[A-Za-z0-9_]{1,15}$/.test(account)) throw Error('Enter the expected X account handle');
        const ms = Number(value.delayMs ?? config.delayMs);
        if (!Number.isFinite(ms) || ms < 40 || ms > 2000) throw Error('Key interval must be 40–2000 milliseconds');
        config.expectedAccount = account; config.delayMs = ms; saveConfig(); notify(); reply(200, publicConfig()); dispatch(); return;
      }
      if (req.method === 'POST' && pathname === '/control') {
        const value = await body(req);
        if (value.action === 'pause') await stop('Paused by user. Inspect any partial draft before sending a new command.');
        else if (value.action === 'resume') { config.paused = false; saveConfig(); notify(); }
        else if (value.action === 'retry') {
          const job = store.get(value.id);
          if (!job || !['needs-attention', 'cancelled'].includes(job.status)) throw Error('Only stopped or cancelled jobs can be retried');
          store.update(job.id, { status: 'queued', error: null });
          config.paused = false; saveConfig(); notify();
        }
        else if (value.action === 'cancel') {
          const job = store.get(value.id);
          if (!job || job.status !== 'queued') throw Error('Only queued jobs can be cancelled; pause an active job instead');
          store.update(job.id, { status: 'cancelled' });
        } else throw Error('Unknown control action');
        reply(200, status()); dispatch(); return;
      }
      reply(404, { error: 'Route not found' });
    } catch (error) { if (!res.headersSent) reply(400, { error: error.message }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 131072 });
  server.on('upgrade', (req, socket, head) => {
    if (!checkHost(req) || req.url !== '/extension' || !extensionOrigin.test(req.headers.origin || '') || !allowedOrigin(req.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  async function rpc(message) {
    if (!active || active.id !== message.jobId || config.paused) throw Error('Job is not active');
    const run = active;
    const job = store.get(run.id);
    const args = message.args || {};
    const requireState = (...states) => { if (!states.includes(job.status)) throw Error(`Operation invalid while ${job.status}`); };
    switch (message.method) {
      case 'arm':
        requireState('opening');
        if (!/^TypedPostX:[a-zA-Z0-9-]{16,80}$/.test(args.marker || '')) throw Error('Invalid window marker');
        for (let attempt = 1; ; attempt++) {
          try { await native.request('arm', { marker: args.marker }); break; }
          catch (error) { if (attempt >= 10 || active !== run || config.paused) throw error; await delay(150); }
        }
        if (active !== run || config.paused) throw Error('Job stopped');
        store.update(job.id, { status: 'typing' }); return {};
      case 'key':
        requireState('typing');
        if (args.text !== run.chars[run.index] || run.index >= run.chars.length) throw Error('Key does not match next supplied character');
        {
          const targetDelay = Math.round(config.delayMs * (0.7 + Math.random() * 0.6));
          await delay(Math.max(0, targetDelay - (Date.now() - run.lastKeyAt)));
        }
        if (active !== run || config.paused) throw Error('Job stopped');
        try { await native.request('key', { text: args.text }); } catch (error) { await stop(error.message); throw error; }
        run.index++; run.lastKeyAt = Date.now(); return { typed: run.index };
      case 'ready':
        requireState('typing');
        if (run.index !== run.chars.length || args.text !== job.text) throw Error('Typed content does not match supplied text');
        await native.request('check');
        store.update(job.id, { status: 'ready' }); return {};
      case 'submit':
        requireState('ready');
        if (job.mode !== 'publish') throw Error('Draft mode cannot publish');
        await native.request('check');
        if (active !== run || config.paused) throw Error('Job stopped');
        store.update(job.id, { status: 'submitting' }); return {};
      case 'complete': {
        if (job.mode === 'draft') {
          requireState('ready'); store.update(job.id, { status: 'draft-ready' }); config.paused = true; saveConfig();
        } else {
          requireState('submitting');
          const match = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/([0-9]+)$/.exec(args.url || '');
          if (!match || match[1].toLowerCase() !== config.expectedAccount.toLowerCase()) throw Error('A verified post URL for the expected account is required');
          if (job.url?.endsWith(`/status/${match[2]}`)) throw Error('Result URL points to the original post');
          store.update(job.id, { status: 'published', resultUrl: args.url });
        }
        active = null; await native.request('disarm'); notify(); setTimeout(dispatch, 500); return {};
      }
      case 'fail': await stop(String(args.error || 'Extension stopped the job').slice(0, 1000)); return {};
      default: throw Error('Unknown operation');
    }
  }

  wss.on('connection', (ws, req) => {
    let authenticated = false, chain = Promise.resolve();
    const timer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    let lastSeen = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - lastSeen > 45000) ws.terminate(); }, 15000);
    ws.on('message', raw => {
      chain = chain.then(async () => {
        let m; try { m = JSON.parse(raw.toString()); } catch { ws.close(1008, 'Invalid JSON'); return; }
        if (!m || typeof m !== 'object') return ws.close(1008, 'Invalid message');
        lastSeen = Date.now();
        if (!authenticated) {
          const originId = extensionOrigin.exec(req.headers.origin)?.[1];
          if (m.type !== 'auth' || !secureEqual(m.token, config.token) || m.extensionId !== originId || (config.extensionId && config.extensionId !== originId)) return ws.close(1008, 'Authentication, pairing, or exclusive connection failed');
          if (client && client !== ws) { const prev = client; client = null; prev.close(1000, 'Replaced by new connection'); }
          config.extensionId = originId; saveConfig(); authenticated = true; clearTimeout(timer); client = ws;
          send(ws, { type: 'ready', ...publicConfig() }); dispatch(); return;
        }
        if (m.type === 'ping') return send(ws, { type: 'pong' });
        if (m.type === 'trace') {
          traceLog(m.source || 'EXT', `${m.step || ''} ${m.message || ''}`.trim(), m.data ?? m.details);
          return;
        }
        if (m.type !== 'rpc' || typeof m.id !== 'string') return ws.close(1008, 'Invalid request');
        try { send(ws, { type: 'result', id: m.id, ok: true, result: await rpc(m) }); }
        catch (error) {
          traceLog('RPC', `RPC failed method=${m.method} jobId=${m.jobId} error="${error.message}"`);
          send(ws, { type: 'result', id: m.id, ok: false, error: error.message });
        }
      }).catch(() => ws.close(1011, 'Internal error'));
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(timer); clearInterval(watchdog);
      if (client === ws) { client = null; if (active) void stop('Extension disconnected. Inspect X before resubmitting.'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, store, port: server.address().port, token: config.token, dataDir, async close() {
    closed = true;
    if (active) await stop('Helper stopped during job; inspect X before resubmitting.');
    for (const ws of wss.clients) ws.terminate();
    native.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); wss.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await createServer();
    console.log(`Typed PostX is listening on http://127.0.0.1:${app.port}`);
    console.log(`Pairing token is stored in ${join(app.dataDir, 'config.json')}. Use scripts/show-token.ps1 to view it locally.`);
    console.log('Keep this helper running. Press Ctrl+C to stop.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
