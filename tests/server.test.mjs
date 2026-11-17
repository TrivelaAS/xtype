import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';

const serverModule = await import('../helper/server.mjs').catch(() => ({}));
const ext = 'a'.repeat(32);
async function setup(t) {
  assert.equal(typeof serverModule.createServer, 'function', 'createServer must exist');
  const inputs = [];
  const app = await serverModule.createServer({ dataDir: mkdtempSync(join(tmpdir(), 'postx-api-')), port: 0,
    native: { request: async (op, args) => { inputs.push({ op, ...args }); return {}; }, close() {} } });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const api = (path, data, headers = {}) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: {
    Authorization: `Bearer ${app.token}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers
  }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { app, api, base, inputs };
}

test('HTTP requires token and denies webpage origins and invalid Host', async t => {
  const { api, base, app } = await setup(t);
  assert.equal((await fetch(base + '/status')).status, 401);
  assert.equal((await api('/status', null, { Origin: 'https://evil.test' })).status, 403);
  const wrongHost = await new Promise(resolve => { http.get(base + '/status', { headers: { Host: 'evil.test', Authorization: `Bearer ${app.token}` } }, res => { res.resume(); resolve(res.statusCode); }); });
  assert.equal(wrongHost, 403);
  assert.equal((await api('/jobs', { id: 'a', action: 'NEW-POST', text: 'Hello' })).status, 201);
  assert.equal((await api('/jobs', { id: 'a', action: 'NEW-POST', text: 'Hello' })).status, 200);
});

test('authenticated extension pairs, consumes exact text, and records submit before completion', async t => {
  const { app, api, inputs } = await setup(t);
  await api('/settings', { expectedAccount: 'hans', delayMs: 80 });
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/extension`, { origin: `chrome-extension://${ext}` });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const messages = []; const pending = new Map();
  ws.on('message', data => { const m = JSON.parse(data); messages.push(m); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  ws.send(JSON.stringify({ type: 'auth', token: app.token, extensionId: ext }));
  const until = async fn => { for (let n = 0; n < 100; n++) { const result = fn(); if (result) return result; await new Promise(r => setTimeout(r, 10)); } throw Error('Timed out'); };
  await until(() => messages.find(m => m.type === 'ready'));
  await api('/jobs', { id: 'p', action: 'NEW-POST', text: 'æ👋', mode: 'publish' });
  await until(() => messages.find(m => m.type === 'job'));
  let seq = 0;
  const rpc = (method, args = {}) => new Promise(resolve => { const id = String(++seq); pending.set(id, resolve); ws.send(JSON.stringify({ type: 'rpc', id, jobId: 'p', method, args })); });
  assert.equal((await rpc('arm', { marker: 'TypedPostX:1234567890123456' })).ok, true);
  assert.equal((await rpc('key', { text: 'wrong' })).ok, false);
  assert.equal((await rpc('key', { text: 'æ' })).ok, true);
  assert.equal((await rpc('key', { text: '👋' })).ok, true);
  assert.equal(inputs.filter(i => i.op === 'key').length, 2);
  assert.equal((await rpc('ready', { text: 'æ👋' })).ok, true);
  assert.equal((await rpc('submit')).ok, true);
  assert.equal((await (await api('/jobs/p')).json()).status, 'submitting');
  ws.close();
  await until(() => app.store.get('p').status === 'needs-attention');
  assert.equal((await api('/jobs', { id: 'p', action: 'NEW-POST', text: 'æ👋' })).status, 200);
  assert.equal(app.store.get('p').status, 'needs-attention');
});
