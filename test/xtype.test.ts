import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  buildKeystrokePlan,
  KeystrokeStep,
  QWERTY_NEIGHBORS,
  simulatePlanOutput,
} from '../extension/src/humanTyper';
import { createXTypeServer, XTypeServerHandle } from '../server/index';
import { Job, WsServerMessage } from '../shared/types';

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function nextWsMessage(ws: WebSocket, predicate?: (msg: WsServerMessage) => boolean): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, 5000);

    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString('utf8')) as WsServerMessage;
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };

    ws.on('message', onMessage);
  });
}

describe('humanTyper cadence & typo engine', () => {
  it('reconstructs exact intended text across 25 diverse strings even at 15% typoRate', () => {
    const samples = [
      'Hello world!',
      'Distribution beats pure product craft every single week.',
      'Line one.\nLine two!\nLine three?',
      'Numbers: 0123456789 and symbols: !@#$%^&*()_+-=[]{}|;:\'",.<>/?',
      'Norwegian test: Blåbærsyltetøy og ærlig øl på Ås!',
      'Emojis stay intact: 🚀🔥💡👨‍👩‍👧',
      'A',
      'Quick brown fox jumps over the lazy dog.',
      'UPPERCASE AND mixedCase Testing 100%.',
      'Commas, colons: semicolons; dashes - all pause naturally.',
      'Repeated letters: coool, bookkeeper, balloon, committee.',
      'Left hand vs right hand alternation: island, formal, authentic.',
      'Same-finger bigrams: deck, cedar, jump, muscle, union.',
      'https://x.com/test/status/1850000000000000000',
      'First paragraph.\n\nSecond paragraph with spacing.',
      'Tabs\tand\nnewlines\nwork.',
      'Trailing space ',
      ' Leading space',
      'Wait... really?! Yes!!',
      'Quote: "Ship fast, listen closely."',
      "Apostrophes: don't, won't, it's, founder's.",
      '10x ROI vs $500 MRR in Q4 2026.',
      'Multi-emoji sequence: ✅🎯⚡🔥🚀',
      'Short.',
      'Final verification string #25 with punctuation, numbers 42, æøå, and 🚀!',
    ];

    expect(samples).toHaveLength(25);

    samples.forEach((sample, idx) => {
      const rng = createSeededRng(1000 + idx);
      const steps = buildKeystrokePlan(
        sample,
        {
          wpmMean: 68,
          wpmStdDev: 14,
          typoRate: 0.15,
        },
        rng
      );
      expect(simulatePlanOutput(steps)).toBe(sample);
    });
  });

  it('produces longer pauses after sentence/clause punctuation than intra-word characters', () => {
    const rng = createSeededRng(4242);
    const text = 'aaaa. aaaa. aaaa. aaaa. aaaa. aaaa. aaaa. aaaa. aaaa. aaaa. aaaa. aaaa.';
    const steps = buildKeystrokePlan(
      text,
      {
        wpmMean: 70,
        wpmStdDev: 5,
        typoRate: 0,
      },
      rng
    );

    const postPeriodDelays: number[] = [];
    const intraWordDelays: number[] = [];

    for (let i = 1; i < steps.length; i += 1) {
      const prev = steps[i - 1];
      const curr = steps[i];
      if (prev.char === '.' && curr.char === ' ') {
        postPeriodDelays.push(curr.delayBeforeMs);
      } else if (prev.char === 'a' && curr.char === 'a') {
        intraWordDelays.push(curr.delayBeforeMs);
      }
    }

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    expect(postPeriodDelays.length).toBeGreaterThan(5);
    expect(intraWordDelays.length).toBeGreaterThan(10);
    expect(avg(postPeriodDelays)).toBeGreaterThan(avg(intraWordDelays) + 300);
  });

  it('only picks physically adjacent QWERTY neighbors for typos followed by backspace', () => {
    const rng = createSeededRng(777);
    const text = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const steps = buildKeystrokePlan(
      text,
      {
        wpmMean: 65,
        wpmStdDev: 10,
        typoRate: 0.35,
      },
      rng
    );

    let typoCount = 0;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (step.kind === 'key' && step.isTypo) {
        typoCount += 1;
        const backspaceStep = steps[i + 1];
        const intendedStep = steps[i + 2] as KeystrokeStep | undefined;

        expect(backspaceStep?.kind).toBe('backspace');
        expect(intendedStep?.kind).toBe('key');
        if (intendedStep && intendedStep.kind === 'key') {
          const allowedNeighbors = QWERTY_NEIGHBORS[intendedStep.char.toLowerCase()];
          expect(allowedNeighbors).toContain(step.char.toLowerCase());
        }
      }
    }

    expect(typoCount).toBeGreaterThan(3);
    expect(simulatePlanOutput(steps)).toBe(text);
  });
});

describe('XType bridge server & persistent queue', () => {
  const handles: XTypeServerHandle[] = [];
  const tempDirs: string[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      ws.terminate();
    }
    for (const h of handles.splice(0)) {
      await h.close();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function setupServer(cooldownMs = 20) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtype-test-'));
    tempDirs.push(tempDir);
    const dataFilePath = path.join(tempDir, 'jobs.json');
    const server = createXTypeServer({
      port: 0,
      cooldownMs,
      dataFilePath,
    });
    handles.push(server);
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    return { server, port, baseUrl, wsUrl };
  }

  it('validates job payloads cleanly on POST /api/jobs', async () => {
    const { baseUrl } = await setupServer();

    const missingUrlRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'reply', text: 'Nice!' }),
    });
    expect(missingUrlRes.status).toBe(400);

    const badHostRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'reply',
        text: 'Nice!',
        targetUrl: 'https://example.com/status/123',
      }),
    });
    expect(badHostRes.status).toBe(400);

    const emptyTextRes = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'post', text: '   ' }),
    });
    expect(emptyTextRes.status).toBe(400);
  });

  it('enforces FIFO single-job concurrency, dispatches next after completion, and cancels active jobs', async () => {
    const { baseUrl, wsUrl } = await setupServer(15);

    const ws = new WebSocket(wsUrl);
    sockets.push(ws);
    await nextWsMessage(ws, (m) => m.type === 'welcome');

    ws.send(JSON.stringify({ type: 'hello', boundWindowId: 101, boundTabId: 202 }));

    const dispatch1Promise = nextWsMessage(ws, (m) => m.type === 'job:dispatch');
    const res1 = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'post', text: 'First queued post' }),
    });
    expect(res1.status).toBe(201);
    const { job: job1 } = (await res1.json()) as { job: Job };

    const dispatch1 = await dispatch1Promise;
    expect(dispatch1.type).toBe('job:dispatch');
    if (dispatch1.type === 'job:dispatch') {
      expect(dispatch1.job.id).toBe(job1.id);
      expect(dispatch1.job.status).toBe('navigating');
    }

    // Enqueue Job 2 while Job 1 is active -> must stay 'queued'
    const res2 = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'reply',
        targetUrl: 'https://x.com/user/status/1850000000000000000',
        text: 'Second queued reply',
      }),
    });
    expect(res2.status).toBe(201);
    const { job: job2 } = (await res2.json()) as { job: Job };
    expect(job2.status).toBe('queued');

    // Complete Job 1 via WS -> Job 2 dispatches automatically after cooldown
    const dispatch2Promise = nextWsMessage(ws, (m) => m.type === 'job:dispatch');
    ws.send(
      JSON.stringify({
        type: 'job:status',
        jobId: job1.id,
        status: 'completed',
        progress: 100,
      })
    );

    const dispatch2 = await dispatch2Promise;
    expect(dispatch2.type).toBe('job:dispatch');
    if (dispatch2.type === 'job:dispatch') {
      expect(dispatch2.job.id).toBe(job2.id);
    }

    // Cancel active Job 2 -> transitions to 'cancelled' and emits job:cancel over WS
    const cancelWsPromise = nextWsMessage(ws, (m) => m.type === 'job:cancel');
    const cancelRes = await fetch(`${baseUrl}/api/jobs/${job2.id}/cancel`, {
      method: 'POST',
    });
    expect(cancelRes.status).toBe(200);
    const { job: cancelledJob2 } = (await cancelRes.json()) as { job: Job };
    expect(cancelledJob2.status).toBe('cancelled');

    const cancelMsg = await cancelWsPromise;
    expect(cancelMsg).toEqual({ type: 'job:cancel', jobId: job2.id });
  });
});
