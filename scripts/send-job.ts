import { Job, JobType } from '../shared/types';

function printUsage(): void {
  console.log(
    `Usage: npm run send -- --type <post|reply|repost|quote> [--text "..."] [--url "..."] [--auto-submit] [--wpm 68] [--typo-rate 0.02] [--wait]`
  );
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const type = String(args.type ?? 'post') as JobType;
  const text = typeof args.text === 'string' ? args.text : undefined;
  const targetUrl =
    typeof args.url === 'string'
      ? args.url
      : typeof args['target-url'] === 'string'
        ? args['target-url']
        : undefined;
  const autoSubmit = Boolean(args['auto-submit']);
  const server = String(args.server ?? 'http://127.0.0.1:4110').replace(/\/+$/, '');
  const apiKey = typeof args['api-key'] === 'string' ? args['api-key'] : process.env.XTYPE_API_KEY;
  const wait = Boolean(args.wait);

  const profile: Record<string, unknown> = {};
  if (typeof args.wpm === 'string') {
    profile.wpmMean = Number(args.wpm);
  }
  if (typeof args['typo-rate'] === 'string') {
    profile.typoRate = Number(args['typo-rate']);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const res = await fetch(`${server}/api/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type,
      text,
      targetUrl,
      autoSubmit,
      profile: Object.keys(profile).length > 0 ? profile : undefined,
    }),
  });

  const data = (await res.json()) as { job?: Job; error?: string };
  if (!res.ok || !data.job) {
    console.error(`Error (${res.status}): ${data.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  let job = data.job;
  console.log(`Queued job ${job.id} [${job.type}] status=${job.status}`);

  if (!wait) {
    return;
  }

  let lastStatus = '';
  while (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
    const marker = `${job.status}:${job.progress}`;
    if (marker !== lastStatus) {
      console.log(`  status=${job.status} progress=${job.progress}%`);
      lastStatus = marker;
    }
    await sleep(500);
    const pollRes = await fetch(`${server}/api/jobs/${job.id}`, { headers });
    const pollData = (await pollRes.json()) as { job?: Job };
    if (pollData.job) {
      job = pollData.job;
    }
  }

  console.log(`Finished job ${job.id}: status=${job.status}${job.error ? ` (${job.error})` : ''}`);
  if (job.status === 'failed') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Failed to send job:', err);
  process.exit(1);
});
