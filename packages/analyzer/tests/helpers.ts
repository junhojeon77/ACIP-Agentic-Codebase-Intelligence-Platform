import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const roots: string[] = [];
export function repository(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acip-test-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) write(root, name, text);
  return root;
}
export function write(root: string, name: string, text: string) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
export function config(value: object = {}) { return JSON.stringify(value); }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
