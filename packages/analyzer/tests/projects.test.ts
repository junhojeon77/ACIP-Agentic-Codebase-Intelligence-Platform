import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { discoverProjects } from '../src/projects.js';
import { config, repository } from './helpers.js';

describe('project discovery', () => {
  it('discovers configurations and custom references without reading implementation files', () => {
    const root = repository({
      'tsconfig.json': config({ files: [], references: [{ path: './packages/lib/custom.json' }] }),
      'apps/web/tsconfig.json': config({ include: ['src'] }),
      'apps/web/src/page.tsx': 'export const Page = () => <main />;',
      'packages/lib/custom.json': config({ include: ['src'] }),
      'packages/lib/src/lib.ts': 'export function lib() {}',
      'node_modules/other/tsconfig.json': '{}',
      '.next/tsconfig.json': '{}',
      '.migration-backups/old/tsconfig.json': '{}',
    });
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const result = discoverProjects(root);
      expect(result.projects.map(p => p.id)).toEqual(['apps/web/tsconfig.json', 'packages/lib/custom.json', 'tsconfig.json']);
      expect(result.projects.find(p => p.id === 'tsconfig.json')?.references).toEqual(['packages/lib/custom.json']);
      expect(read.mock.calls.some(([file]) => /\.(?:ts|tsx)$/.test(String(file)))).toBe(false);
    } finally { read.mockRestore(); }
  });

  it('honors inherited files/include/exclude and reports membership without crossing directory symlinks', () => {
    const root = repository({
      'tsconfig.base.json': config({ compilerOptions: { target: 'ES2022' } }),
      'apps/a/tsconfig.json': config({ extends: '../../tsconfig.base.json', include: ['src'], exclude: ['src/skip.ts'] }),
      'apps/a/src/a.ts': 'export const a = 1;',
      'apps/a/src/skip.ts': 'export const skip = 1;',
    });
    fs.symlinkSync(path.join(root, 'apps'), path.join(root, 'linked'), 'dir');
    const result = discoverProjects(root);
    expect(result.projects.map(p => p.id)).not.toContain('linked/a/tsconfig.json');
    expect(result.projects.find(p => p.id === 'apps/a/tsconfig.json')?.files).toEqual(['apps/a/src/a.ts']);
  });

  it('applies configured output exclusions and allows explicit re-inclusion', () => {
    const root = repository({
      'tsconfig.json': config({ compilerOptions: { outDir: 'generated' }, files: ['main.ts', 'generated/a.ts', 'dist/b.ts'] }),
      'main.ts': '', 'generated/a.ts': '', 'dist/b.ts': '',
      'acip.config.json': config({ includeExcluded: ['dist/**'] }),
    });
    expect(discoverProjects(root).projects.find(p => p.id === 'tsconfig.json')?.files).toEqual(['dist/b.ts', 'main.ts']);
  });

  it('keeps invalid dependency configurations discoverable with diagnostics and handles reference cycles', () => {
    const root = repository({
      'tsconfig.json': config({ files: [], references: [{ path: './lib' }, { path: './missing' }] }),
      'lib/tsconfig.json': config({ files: [], references: [{ path: '..' }] }),
      'bad/tsconfig.json': '{ invalid',
    });
    const result = discoverProjects(root);
    expect(result.status).toBe('partial');
    expect(result.projects.map(p => p.id)).toEqual(['bad/tsconfig.json', 'lib/tsconfig.json', 'missing/tsconfig.json', 'tsconfig.json']);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('creates a synthetic project when there is no tsconfig', () => {
    const root = repository({ 'src/a.ts': '', 'src/x.js': '', 'dist/out.ts': '' });
    expect(discoverProjects(root).projects).toMatchObject([{ id: '.', configPath: null, files: ['src/a.ts', 'src/x.js'] }]);
  });

  it.each([{ unknown: [] }, { exclude: 3 }, { exclude: ['../private/**'] }, { includeExcluded: ['/absolute'] }, { exclude: ['[broken'] }])('rejects invalid analyzer configuration: %j', value => {
    const root = repository({ 'acip.config.json': config(value) });
    expect(() => discoverProjects(root)).toThrow(/acip\.config\.json/);
  });
});
