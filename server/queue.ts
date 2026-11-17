import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CreateJobInput,
  DEFAULT_TYPING_PROFILE,
  Job,
  JobStatus,
  JobType,
  TypingProfile,
} from '../shared/types';

export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueValidationError';
  }
}

const VALID_JOB_TYPES: ReadonlySet<JobType> = new Set(['post', 'reply', 'repost', 'quote']);
const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set(['navigating', 'reading', 'typing']);
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['completed', 'failed', 'cancelled']);
const ALLOWED_TARGET_HOSTS: ReadonlySet<string> = new Set([
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'localhost',
  '127.0.0.1',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeProfile(override?: Partial<TypingProfile>): TypingProfile {
  const wpmMean =
    typeof override?.wpmMean === 'number' && Number.isFinite(override.wpmMean)
      ? clamp(override.wpmMean, 15, 220)
      : DEFAULT_TYPING_PROFILE.wpmMean;

  const wpmStdDev =
    typeof override?.wpmStdDev === 'number' && Number.isFinite(override.wpmStdDev)
      ? clamp(override.wpmStdDev, 0, 60)
      : DEFAULT_TYPING_PROFILE.wpmStdDev;

  const typoRate =
    typeof override?.typoRate === 'number' && Number.isFinite(override.typoRate)
      ? clamp(override.typoRate, 0, 0.5)
      : DEFAULT_TYPING_PROFILE.typoRate;

  let readingDelayMs: [number, number] = [...DEFAULT_TYPING_PROFILE.readingDelayMs];
  if (
    Array.isArray(override?.readingDelayMs) &&
    override.readingDelayMs.length === 2 &&
    typeof override.readingDelayMs[0] === 'number' &&
    typeof override.readingDelayMs[1] === 'number' &&
    Number.isFinite(override.readingDelayMs[0]) &&
    Number.isFinite(override.readingDelayMs[1])
  ) {
    const min = clamp(override.readingDelayMs[0], 0, 60000);
    const max = clamp(override.readingDelayMs[1], min, 60000);
    readingDelayMs = [min, max];
  }

  return {
    wpmMean,
    wpmStdDev,
    typoRate,
    readingDelayMs,
  };
}

function validateTargetUrl(rawUrl: unknown, required: boolean): string | undefined {
  if (rawUrl === undefined || rawUrl === null || rawUrl === '') {
    if (required) {
      throw new QueueValidationError('targetUrl is required for reply, repost, and quote jobs');
    }
    return undefined;
  }

  if (typeof rawUrl !== 'string') {
    throw new QueueValidationError('targetUrl must be a string URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new QueueValidationError('targetUrl must be a valid URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new QueueValidationError('targetUrl must use http or https');
  }

  if (!ALLOWED_TARGET_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new QueueValidationError(
      `targetUrl host "${parsed.hostname}" is not allowed (expected x.com, twitter.com, or localhost mock)`
    );
  }

  return parsed.toString();
}

export class JobQueue {
  private readonly filePath: string;
  private jobs: Job[] = [];

  constructor(filePath = path.resolve(process.cwd(), 'data/jobs.json')) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.jobs = [];
      this.save();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const now = new Date().toISOString();
        let modified = false;
        this.jobs = parsed.map((item) => {
          const job = item as Job;
          if (ACTIVE_STATUSES.has(job.status)) {
            modified = true;
            return {
              ...job,
              status: 'failed' as JobStatus,
              error: 'Interrupted by server restart',
              updatedAt: now,
              completedAt: now,
            };
          }
          return job;
        });
        if (modified) {
          this.save();
        }
      } else {
        this.jobs = [];
      }
    } catch {
      this.jobs = [];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.jobs, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  enqueue(input: CreateJobInput): Job {
    if (!input || typeof input !== 'object') {
      throw new QueueValidationError('Request body must be a JSON object');
    }

    if (!VALID_JOB_TYPES.has(input.type)) {
      throw new QueueValidationError('type must be one of: post, reply, repost, quote');
    }

    const needsText = input.type === 'post' || input.type === 'reply' || input.type === 'quote';
    const text = typeof input.text === 'string' ? input.text : '';
    if (needsText && text.trim().length === 0) {
      throw new QueueValidationError(`text must be a non-empty string for ${input.type} jobs`);
    }

    const needsTargetUrl =
      input.type === 'reply' || input.type === 'repost' || input.type === 'quote';
    const targetUrl = validateTargetUrl(input.targetUrl, needsTargetUrl);

    const now = new Date().toISOString();
    const job: Job = {
      id: crypto.randomUUID(),
      type: input.type,
      text,
      targetUrl,
      autoSubmit: Boolean(input.autoSubmit),
      profile: normalizeProfile(input.profile),
      status: 'queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.push(job);
    this.save();
    return { ...job };
  }

  list(): Job[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  get(id: string): Job | undefined {
    const found = this.jobs.find((job) => job.id === id);
    return found ? { ...found } : undefined;
  }

  getActiveJob(): Job | undefined {
    const found = this.jobs.find((job) => ACTIVE_STATUSES.has(job.status));
    return found ? { ...found } : undefined;
  }

  popNextQueued(): Job | undefined {
    if (this.getActiveJob()) {
      return undefined;
    }

    const next = this.jobs.find((job) => job.status === 'queued');
    if (!next) {
      return undefined;
    }

    next.status = 'navigating';
    next.updatedAt = new Date().toISOString();
    this.save();
    return { ...next };
  }

  updateStatus(
    id: string,
    status: JobStatus,
    extra?: { progress?: number; error?: string }
  ): Job | undefined {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) {
      return undefined;
    }

    // Do not let stale extension updates overwrite a cancelled job
    if (job.status === 'cancelled' && status !== 'cancelled') {
      return { ...job };
    }

    const now = new Date().toISOString();
    job.status = status;
    job.updatedAt = now;

    if (typeof extra?.progress === 'number' && Number.isFinite(extra.progress)) {
      job.progress = clamp(Math.round(extra.progress), 0, 100);
    } else if (status === 'completed') {
      job.progress = 100;
    }

    if (extra?.error !== undefined) {
      job.error = extra.error;
    }

    if (TERMINAL_STATUSES.has(status)) {
      job.completedAt = now;
    }

    this.save();
    return { ...job };
  }

  cancel(id: string): { job: Job; wasActive: boolean } | undefined {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) {
      return undefined;
    }

    if (TERMINAL_STATUSES.has(job.status)) {
      return { job: { ...job }, wasActive: false };
    }

    const wasActive = ACTIVE_STATUSES.has(job.status);
    const now = new Date().toISOString();
    job.status = 'cancelled';
    job.error = job.error ?? 'Cancelled';
    job.updatedAt = now;
    job.completedAt = now;
    this.save();

    return { job: { ...job }, wasActive };
  }
}
