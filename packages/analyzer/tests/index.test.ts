import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { indexProject } from '../src/index.js';
import { config, repository, write } from './helpers.js';

const project = (extra: object = {}) => config({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', jsx: 'preserve' }, include: ['src'], ...extra });

describe('selective project indexing', () => {
  it('follows references, aliases, re-exports, and dynamic imports transitively without parsing unrelated projects', () => {
    const root = repository({
      'apps/web/tsconfig.json': project({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@lib/*': ['../../packages/lib/src/*'] } }, references: [{ path: '../../packages/ref' }] }),
      'apps/web/src/a.ts': 'import { lib } from "@lib/lib"; export function web() { return lib(); }',
      'packages/lib/tsconfig.json': project(),
      'packages/lib/src/lib.ts': 'export { deep } from "../../deep/src/deep"; export function lib() {}',
      'packages/deep/tsconfig.json': project(),
      'packages/deep/src/deep.ts': 'export const deep = () => import("../../ref/src/ref.js");',
      'packages/ref/tsconfig.json': project({ references: [{ path: '../../apps/web' }] }),
      'packages/ref/src/ref.ts': 'export class Ref {}',
      'apps/unrelated/tsconfig.json': project(),
      'apps/unrelated/src/broken.ts': 'function ) {',
    });
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const result = indexProject(root, 'apps/web/tsconfig.json');
      expect(result.projects.map(p => p.id)).toEqual(['apps/web/tsconfig.json', 'packages/deep/tsconfig.json', 'packages/lib/tsconfig.json', 'packages/ref/tsconfig.json']);
      expect(result.status, JSON.stringify({ diagnostics: result.diagnostics, omissions: result.omissions })).toBe('complete');
      expect(read.mock.calls.some(([file]) => String(file).endsWith('/unrelated/src/broken.ts'))).toBe(false);
      expect(result.projects.flatMap(p => p.files).map(f => f.path)).toContain('packages/lib/src/lib.ts');
    } finally { read.mockRestore(); }
  });

  it('uses Next.js and dependency declarations for resolution without independently indexing declarations', () => {
    const root = repository({
      'tsconfig.json': project({ include: ['src', 'next-env.d.ts', '.next/types/**/*.ts'] }),
      'next-env.d.ts': '/// <reference path="./.next/types/routes.d.ts" />',
      '.next/types/routes.d.ts': 'declare type Route = "/";',
      '.next/generated.ts': 'export function generated() {}',
      'src/page.tsx': 'import type { Props } from "widget"; export const Page = (props: Props) => <main />;',
      'src/a.mts': 'import type { A } from "./a.mjs"; export function a() {}',
      'src/a.d.mts': 'export interface A {}',
      'src/b.cts': 'import type { B } from "./b.cjs"; export function b() {}',
      'src/b.d.cts': 'export interface B {}',
      'node_modules/widget/package.json': config({ name: 'widget', types: 'index.d.ts' }),
      'node_modules/widget/index.d.ts': 'export interface Props {}',
    });
    const result = indexProject(root);
    expect(result.status).toBe('complete');
    expect(result.projects[0]?.files.map(f => f.path)).toEqual(['src/a.mts', 'src/b.cts', 'src/page.tsx']);
    expect(result.projects[0]?.files.find(f => f.path === 'src/page.tsx')?.symbols[0]?.name).toBe('Page');
  });

  it('reports JavaScript, required excluded source, missing imports, and missing generated declarations', () => {
    const root = repository({
      'tsconfig.json': project({ compilerOptions: { allowJs: true, moduleResolution: 'Bundler', module: 'ESNext' }, include: ['src', 'next-env.d.ts'] }),
      'next-env.d.ts': '/// <reference path="./.next/types/missing.d.ts" />',
      'src/a.ts': 'import "../dist/generated"; import "./missing"; export function ok() {}',
      'src/helper.js': 'export const helper = () => 1;',
      'dist/generated.ts': 'export function generated() {}',
    });
    const result = indexProject(root);
    expect(result.status).toBe('partial');
    expect(result.projects[0]?.files.map(f => f.path)).toEqual(['src/a.ts']);
    expect(result.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/helper.js', reason: 'unsupported-javascript', affectsCompleteness: true }),
      expect.objectContaining({ path: 'dist/generated.ts', reason: 'excluded-source', affectsCompleteness: true }),
      expect.objectContaining({ specifier: './missing', reason: 'unresolved-import', affectsCompleteness: true }),
    ]));
    expect(result.diagnostics.some(d => d.code === 'MISSING_DECLARATION')).toBe(true);
  });

  it('isolates broken files, missing explicit files, and invalid dependencies', () => {
    const root = repository({
      'tsconfig.json': project({ files: ['missing.ts'], references: [{ path: 'broken' }] }),
      'src/good.ts': 'export function good() {}',
      'src/bad.ts': 'const broken = ;\nexport function recovered() {}',
      'broken/tsconfig.json': '{ invalid',
    });
    const result = indexProject(root);
    expect(result.status).toBe('partial');
    expect(result.projects.find(p => p.id === 'tsconfig.json')?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/good.ts', status: 'complete' }),
      expect.objectContaining({ path: 'src/bad.ts', status: 'partial', symbols: [expect.objectContaining({ name: 'recovered' })] }),
      expect.objectContaining({ path: 'missing.ts', status: 'partial', symbols: [] }),
    ]));
    expect(result.projects.find(p => p.id === 'broken/tsconfig.json')?.status).toBe('partial');
  });

  it('requires unambiguous selection and rejects invalid selected configs and outside paths', () => {
    const root = repository({ 'a/tsconfig.json': '{}', 'b/tsconfig.json': '{}' });
    expect(() => indexProject(root)).toThrow(/--project/);
    expect(() => indexProject(root, '../outside.json')).toThrow(/project/i);
    write(root, 'a/tsconfig.json', '{ invalid');
    expect(() => indexProject(root, 'a/tsconfig.json')).toThrow(/configuration/i);
  });

  it('preserves distinct project contexts for overlapping files', () => {
    const root = repository({
      'tsconfig.json': config({ files: [], references: [{ path: './tsconfig.a.json' }, { path: './tsconfig.b.json' }] }),
      'tsconfig.a.json': config({ files: ['shared.ts'] }),
      'tsconfig.b.json': config({ files: ['shared.ts'] }),
      'shared.ts': 'export function shared() {}',
    });
    const result = indexProject(root);
    expect(result.projects.filter(p => p.files.some(f => f.path === 'shared.ts')).map(p => p.id)).toEqual(['tsconfig.a.json', 'tsconfig.b.json']);
  });

  it('reports ambiguous imported ownership instead of speculatively parsing candidates', () => {
    const root = repository({
      'app/tsconfig.json': project(),
      'app/src/a.ts': 'import "../../lib/shared";',
      'lib/tsconfig.a.json': config({ files: ['shared.ts'] }),
      'lib/tsconfig.b.json': config({ files: ['shared.ts'] }),
      'lib/shared.ts': 'export const shared = 1;',
    });
    const result = indexProject(root, 'app/tsconfig.json');
    expect(result.projects.map(p => p.id)).toEqual(['app/tsconfig.json']);
    expect(result.diagnostics.some(d => d.code === 'AMBIGUOUS_PROJECT')).toBe(true);
    expect(result.status).toBe('partial');
  });

  it('supports explicit exclusions/re-inclusions without changing TypeScript membership or protected boundaries', () => {
    const root = repository({
      'acip.config.json': config({ exclude: ['src/skipped.ts'], includeExcluded: ['dist/**', '.migration-backups/**'] }),
      'tsconfig.json': config({ files: ['src/a.ts', 'src/skipped.ts', 'dist/included.ts', '.migration-backups/secret.ts'] }),
      'src/a.ts': '', 'src/skipped.ts': '', 'dist/included.ts': '', 'dist/not-in-project.ts': '', '.migration-backups/secret.ts': '',
    });
    expect(indexProject(root).projects[0]?.files.map(f => f.path)).toEqual(['dist/included.ts', 'src/a.ts']);
  });

  it('resolves local workspace symlinks, but never indexes an implementation outside the root', () => {
    const outside = repository({ 'external.ts': 'export function secret() {}' });
    const root = repository({
      'tsconfig.json': config({ files: ['src/a.ts'], compilerOptions: { moduleResolution: 'Bundler', module: 'ESNext' } }),
      'src/a.ts': 'import "lib"; import "./external";',
      'packages/lib/package.json': config({ name: 'lib', types: 'src/lib.ts' }),
      'packages/lib/tsconfig.json': project(),
      'packages/lib/src/lib.ts': 'export function lib() {}',
    });
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(path.join(root, 'packages/lib'), path.join(root, 'node_modules/lib'), 'dir');
    fs.symlinkSync(path.join(outside, 'external.ts'), path.join(root, 'src/external.ts'));
    const result = indexProject(root);
    expect(result.projects.map(p => p.id)).toEqual(['packages/lib/tsconfig.json', 'tsconfig.json']);
    expect(result.projects.flatMap(p => p.files).some(f => f.path.includes('external'))).toBe(false);
    expect(result.status).toBe('partial');
  });

  it('indexes empty and non-Git folders deterministically, and reports unreadable source', () => {
    const root = repository({ 'ok.ts': 'export function ok() {}' });
    expect(indexProject(root)).toEqual(indexProject(root));
    const read = vi.spyOn(fs, 'readFileSync');
    const original = read.getMockImplementation();
    read.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('/ok.ts')) throw new Error('EACCES');
      return original!(...args);
    });
    try {
      const result = indexProject(root);
      expect(result.status).toBe('partial');
      expect(result.projects[0]?.files[0]).toMatchObject({ path: 'ok.ts', status: 'partial', symbols: [] });
    } finally { read.mockRestore(); }
    expect(indexProject(repository({})).status).toBe('complete');
  });
});
