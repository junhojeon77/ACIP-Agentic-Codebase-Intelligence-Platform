import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { indexProject } from '../src/index.js';
import { repository, write } from './helpers.js';

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}
function initialize(root: string) {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'Fixture');
}
function commit(root: string) { git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD'); }

describe('Git provenance', () => {
  it('does not label newly captured bytes as clean at the old HEAD if Git changes before the read', () => {
    const root = repository({ 'a.ts': 'export function before() {}' }); initialize(root); const initial = commit(root);
    const originalRead = fs.readFileSync;
    let changed = false;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (!changed && String(args[0]) === path.join(root, 'a.ts')) {
        changed = true;
        write(root, 'a.ts', 'export function after() {}'); commit(root);
      }
      return originalRead(...args);
    });
    try {
      const result = indexProject(root);
      expect(result.git.headCommit).toBe(initial);
      expect(result.projects[0]?.files[0]).toMatchObject({ status: 'partial', gitState: 'unknown', symbols: [expect.objectContaining({ name: 'after' })] });
    } finally { read.mockRestore(); }
  });

  it('records a clean baseline and hashes the exact indexed bytes without changing the repository', () => {
    const text = 'export function café() {}\r\n';
    const root = repository({ 'a.ts': text });
    initialize(root);
    const head = commit(root);
    const before = fs.readFileSync(path.join(root, '.git/index'));
    const result = indexProject(root);
    expect(result.git).toEqual({ available: true, headCommit: head, dirty: false });
    expect(result.projects[0]?.files[0]).toMatchObject({ gitState: 'tracked-clean', contentHash: createHash('sha256').update(Buffer.from(text)).digest('hex') });
    expect(fs.readFileSync(path.join(root, '.git/index'))).toEqual(before);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('distinguishes staged/unstaged changes, untracked and ignored files, including unusual paths', () => {
    const root = repository({ 'staged.ts': '', 'unstaged.ts': '', '.gitignore': 'ignored.ts\n' });
    initialize(root); const head = commit(root);
    write(root, 'staged.ts', 'export const staged = 1;'); git(root, 'add', 'staged.ts');
    write(root, 'unstaged.ts', 'export const unstaged = 1;');
    const unusualName = process.platform === 'win32' ? 'new name café.ts' : 'new name\nfile.ts';
    write(root, unusualName, 'export const fresh = 1;');
    write(root, 'ignored.ts', 'export const ignored = 1;');
    const result = indexProject(root);
    expect(result.git).toEqual({ available: true, headCommit: head, dirty: true });
    expect(Object.fromEntries(result.projects[0]!.files.map(f => [f.path, f.gitState]))).toEqual({
      'ignored.ts': 'ignored', [unusualName]: 'untracked', 'staged.ts': 'modified', 'unstaged.ts': 'modified',
    });
  });

  it('handles unborn HEAD and non-Git repositories without inventing revision identifiers', () => {
    const root = repository({ 'a.ts': '' }); initialize(root);
    expect(indexProject(root).git).toEqual({ available: true, headCommit: null, dirty: true });
    expect(indexProject(repository({ 'b.ts': '' })).git).toEqual({ available: false, headCommit: null, dirty: null });
  });

  it('detects source and HEAD changes during indexing instead of claiming a consistent snapshot', () => {
    const root = repository({ 'a.ts': 'export function original() {}' }); initialize(root); const initial = commit(root);
    const originalRead = fs.readFileSync;
    let changed = false;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      const value = originalRead(...args);
      if (!changed && String(args[0]) === path.join(root, 'a.ts')) {
        changed = true;
        write(root, 'a.ts', 'export function changed() {}');
        commit(root);
      }
      return value;
    });
    try {
      const result = indexProject(root);
      expect(result.git.headCommit).toBe(initial);
      expect(result.status).toBe('partial');
      expect(result.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['SOURCE_CHANGED', 'GIT_CHANGED']));
      expect(result.projects[0]?.files[0]?.status).toBe('partial');
      expect(result.projects[0]?.files[0]?.symbols[0]?.name).toBe('original');
    } finally { read.mockRestore(); }
  });

  it('disables repository-configured Git filesystem monitors', () => {
    const root = repository({ 'a.ts': '' }); initialize(root); commit(root);
    write(root, 'monitor.sh', '#!/bin/sh\ntouch "' + path.join(root, 'executed') + '"\n');
    fs.chmodSync(path.join(root, 'monitor.sh'), 0o755);
    git(root, 'config', 'core.fsmonitor', path.join(root, 'monitor.sh'));
    indexProject(root);
    expect(fs.existsSync(path.join(root, 'executed'))).toBe(false);
  });
});
