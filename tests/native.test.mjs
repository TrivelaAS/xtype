import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NativeKeyboard } from '../helper/native.mjs';

test('native helper refuses disarmed input, malformed keys, and invalid arm markers', async t => {
  const path = fileURLToPath(new URL('../native/bin/TypedPostX.Keyboard.exe', import.meta.url));
  assert.ok(existsSync(path), 'native helper must be built');
  const native = new NativeKeyboard(path); t.after(() => native.close());
  await assert.rejects(native.request('key', { text: 'a' }), /armed/i);
  await assert.rejects(native.request('arm', { marker: 'anything' }), /marker/i);
  await assert.rejects(native.request('key', { text: 'bulk text' }), /character/i);
  assert.ok(await native.request('disarm'));
});
