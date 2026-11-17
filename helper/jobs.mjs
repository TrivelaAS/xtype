import { mkdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const ACTIVE = new Set(['opening', 'typing', 'ready', 'submitting']);
export function atomicJSON(path, value) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function normalizeJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Expected a job object');
  const { id, action } = input;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw Error('id must contain 1–100 letters, numbers, hyphens or underscores');
  if (!['NEW-POST', 'REPLY-TO', 'QUOTE'].includes(action)) throw Error('Unknown action');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 25000 || !input.text.isWellFormed()) throw Error('Text must be valid Unicode, nonempty, and at most 25,000 UTF-16 units');
  const text = input.text.replace(/\r\n?/g, '\n');
  if (/[\x00-\x09\x0b-\x1f\x7f]/.test(text)) throw Error('Control characters other than newlines are not supported');
  const mode = input.mode ?? 'publish';
  if (!['publish', 'draft'].includes(mode)) throw Error('mode must be publish or draft');
  let url = null;
  if (action !== 'NEW-POST') {
    let parsed;
    try { parsed = new URL(input.url); } catch { throw Error('A valid X post URL is required'); }
    if (parsed.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(parsed.pathname)) throw Error('Use an https://x.com/user/status/123 post URL');
    url = `https://x.com${parsed.pathname.replace(/\/$/, '')}`;
  } else if (input.url) throw Error('NEW-POST does not take a target URL');
  return { id, action, url, text, mode };
}

export class JobStore {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'jobs.json');
    this.jobs = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : [];
    if (!Array.isArray(this.jobs)) throw Error('Invalid jobs file; refusing to discard stored history');
    for (const job of this.jobs) if (ACTIVE.has(job.status)) Object.assign(job, {
      status: 'needs-attention', error: 'Helper restarted during this job. Inspect X before submitting anything again.', updatedAt: new Date().toISOString()
    });
    this.save();
  }
  save() { atomicJSON(this.path, this.jobs); }
  list() { return this.jobs.map(job => ({ ...job })); }
  get(id) { return this.jobs.find(job => job.id === id); }
  add(input) {
    const normalized = normalizeJob(input);
    const existing = this.get(normalized.id);
    if (existing) {
      if (JSON.stringify(normalizeJob(existing)) !== JSON.stringify(normalized)) throw Error('Job ID already exists with a different payload');
      return { job: existing, created: false };
    }
    if (this.jobs.length >= 10000) throw Error('Job history is full (10,000 jobs); archive the data directory manually before starting a new history');
    const job = { ...normalized, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.jobs.push(job); this.save();
    return { job, created: true };
  }
  claim() {
    if (this.jobs.some(job => ACTIVE.has(job.status))) return null;
    const next = this.jobs.find(job => job.status === 'queued');
    return next ? this.update(next.id, { status: 'opening' }) : null;
  }
  update(id, patch) {
    const job = this.get(id);
    if (!job) throw Error('Job not found');
    Object.assign(job, patch, { updatedAt: new Date().toISOString() }); this.save(); return job;
  }
}
