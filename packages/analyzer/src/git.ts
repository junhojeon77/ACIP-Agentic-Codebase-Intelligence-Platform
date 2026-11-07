import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { GitProvenance, GitState } from './types.js';

export function readGit(repository: string, indexedFiles: string[] = []) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const run = (args: string[], input?: string) => spawnSync('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-C', repository, ...args,
  ], {
    encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  const top = run(['rev-parse', '--show-toplevel']);
  const unavailable: GitProvenance = { available: false, headCommit: null, dirty: null };
  if (top.status !== 0) return { provenance: unavailable, signature: '', states: new Map<string, GitState>(), error: top.error ? 'Git is unavailable in this environment' : undefined };
  const gitRoot = top.stdout.trimEnd();
  const head = run(['rev-parse', '--verify', 'HEAD']);
  const status = run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
  const tracked = run(['ls-files', '--cached', '-z']);
  const ignored = indexedFiles.length ? run(['check-ignore', '-z', '--stdin'], indexedFiles.map(file => path.relative(repository, file)).join('\0') + '\0') : undefined;
  if (status.status !== 0 || tracked.status !== 0 || (ignored && ignored.status !== 0 && ignored.status !== 1)) {
    return { provenance: unavailable, signature: '', states: new Map<string, GitState>(), error: 'Cannot read Git working-tree state' };
  }
  const states = new Map<string, GitState>();
  for (const file of tracked.stdout.split('\0').filter(Boolean)) states.set(path.resolve(repository, file), 'tracked-clean');
  for (const file of (ignored?.stdout ?? '').split('\0').filter(Boolean)) states.set(path.resolve(repository, file), 'ignored');
  const entries = status.stdout.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    states.set(path.resolve(gitRoot, entry.slice(3)), code === '??' ? 'untracked' : 'modified');
    if (code.includes('R') || code.includes('C')) index++;
  }
  const headCommit = head.status === 0 ? head.stdout.trim() : null;
  return {
    provenance: { available: true, headCommit, dirty: status.stdout.length > 0 } as GitProvenance,
    signature: `${headCommit}\0${status.stdout}`,
    states,
    error: undefined,
  };
}
