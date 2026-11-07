import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { config, repository } from './helpers.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

describe('built CLI', () => {
  it('prints only deterministic JSON for discovery and indexing, without modifying source', () => {
    const root = repository({ 'tsconfig.json': config({ files: ['a.ts'] }), 'a.ts': 'export function a() {}' });
    const before = fs.readFileSync(path.join(root, 'a.ts'));
    const discovery = run('discover', root);
    expect(discovery.status).toBe(0);
    expect(discovery.stderr).toBe('');
    expect(JSON.parse(discovery.stdout).projects[0].id).toBe('tsconfig.json');
    const result = run('index', root, '--project', 'tsconfig.json');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).projects[0].files[0].symbols[0].name).toBe('a');
    expect(run('index', root, '--project', 'tsconfig.json').stdout).toBe(result.stdout);
    expect(fs.readFileSync(path.join(root, 'a.ts'))).toEqual(before);
    expect(fs.readdirSync(root).sort()).toEqual(['a.ts', 'tsconfig.json']);
  });

  it('returns successful partial JSON consumed by Python without starting an API service', () => {
    const root = repository({ 'a.ts': 'export function a() {}\nconst broken = ;', 'helper.js': 'export const js = 1;' });
    const result = run('index', root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const python = spawnSync('python3', [fileURLToPath(new URL('./consume.py', import.meta.url))], { input: result.stdout, encoding: 'utf8' });
    expect(python.status, python.stderr).toBe(0);
    expect(python.stdout.trim()).toBe('contract accepted');
  });

  it.each([[], ['unknown', '.'], ['index'], ['index', '/does/not/exist'], ['discover', '.', '--project', 'x'], ['index', '.', '--unknown']].map(args => ({ args })))('rejects invalid requests with stderr and exit 1: $args', ({ args }) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('at file:');
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
