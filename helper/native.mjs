import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class NativeKeyboard {
  constructor(executable = fileURLToPath(new URL('../native/bin/TypedPostX.Keyboard.exe', import.meta.url))) {
    this.executable = executable; this.pending = new Map(); this.seq = 0; this.child = null;
  }
  start() {
    if (this.child) return;
    const child = spawn(this.executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const fail = () => {
      if (this.child === child) this.child = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Windows keyboard helper stopped. Run scripts/build.ps1 and restart.')); }
      this.pending.clear();
    };
    child.on('error', fail); child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', () => {});
    createInterface({ input: child.stdout }).on('line', line => {
      let result; try { result = JSON.parse(line); } catch { return fail(); }
      const p = this.pending.get(result.id); if (!p) return;
      this.pending.delete(result.id); clearTimeout(p.timer);
      result.ok ? p.resolve(result.result) : p.reject(Error(result.error || 'Keyboard operation failed'));
    });
  }
  request(op, args = {}) {
    this.start();
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Windows keyboard helper timed out')); this.child?.kill(); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }
  close() { this.child?.kill(); }
}
