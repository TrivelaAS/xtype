import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('../helper/jobs.mjs').catch(() => ({}));
const job = (extra = {}) => ({ id: 'one', action: 'NEW-POST', text: 'Hei æøå 👋\nNext', ...extra });

test('normalizes commands without trimming intended post text', () => {
  assert.equal(typeof core.normalizeJob, 'function', 'normalizeJob must exist');
  const result = core.normalizeJob(job({ text: ' hello\r\nworld ' }));
  assert.equal(result.text, ' hello\nworld ');
  assert.equal(result.mode, 'publish');
  assert.equal(core.normalizeJob(job({ action: 'REPLY-TO', url: 'https://x.com/person/status/123?s=20' })).url, 'https://x.com/person/status/123');
});

test('rejects unsafe URLs, missing targets, malformed text, and unknown commands', () => {
  assert.equal(typeof core.normalizeJob, 'function');
  for (const override of [
    { action: 'DELETE' }, { action: 'QUOTE' }, { text: ' ' }, { text: '\ud800' },
    { text: 'a\tb' }, { action: 'QUOTE', url: 'https://x.com.evil.test/a/status/123' },
    { action: 'QUOTE', url: 'https://user:pass@x.com/a/status/123' },
    { action: 'QUOTE', url: 'https://x.com:999/a/status/123' }, { mode: 'stealth' },
    { text: 'a'.repeat(25001) }, { id: '../file' }
  ]) assert.throws(() => core.normalizeJob(job(override)), JSON.stringify(override));
});

test('idempotency survives restart; changed payload cannot reuse an ID', () => {
  assert.equal(typeof core.JobStore, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'postx-jobs-'));
  let store = new core.JobStore(dir);
  store.add(job());
  assert.equal(store.add(job()).created, false);
  assert.throws(() => store.add(job({ text: 'different' })), /different/i);
  store = new core.JobStore(dir);
  assert.equal(store.list().length, 1);
  assert.equal(store.add(job()).created, false);
});

test('only one active job, interrupted submission never automatically requeues', () => {
  assert.equal(typeof core.JobStore, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'postx-recovery-'));
  let store = new core.JobStore(dir);
  store.add(job()); store.add(job({ id: 'two' }));
  assert.equal(store.claim().id, 'one');
  assert.equal(store.claim(), null);
  store.update('one', { status: 'submitting' });
  store = new core.JobStore(dir);
  assert.equal(store.get('one').status, 'needs-attention');
  assert.equal(store.get('two').status, 'queued');
});
