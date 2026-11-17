import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const extDir = path.join(rootDir, 'extension');
const srcDir = path.join(extDir, 'src');
const distDir = path.join(extDir, 'dist');

async function main(): Promise<void> {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  await Promise.all([
    build({
      entryPoints: [
        path.join(srcDir, 'background.ts'),
        path.join(srcDir, 'offscreen.ts'),
        path.join(srcDir, 'popup.ts'),
      ],
      outdir: distDir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome120',
      sourcemap: true,
      logLevel: 'info',
    }),
    build({
      entryPoints: [path.join(srcDir, 'content.ts')],
      outfile: path.join(distDir, 'content.js'),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'chrome120',
      sourcemap: true,
      logLevel: 'info',
    }),
  ]);

  const staticFiles: Array<{ from: string; to: string }> = [
    { from: path.join(srcDir, 'manifest.json'), to: path.join(distDir, 'manifest.json') },
    { from: path.join(srcDir, 'popup.html'), to: path.join(distDir, 'popup.html') },
    { from: path.join(srcDir, 'offscreen.html'), to: path.join(distDir, 'offscreen.html') },
  ];

  for (const file of staticFiles) {
    fs.copyFileSync(file.from, file.to);
  }

  console.log(`Built extension bundle into ${distDir}`);
}

main().catch((err) => {
  console.error('Extension build failed:', err);
  process.exit(1);
});
