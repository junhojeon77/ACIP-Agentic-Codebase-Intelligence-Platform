import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { discoverProjects, extractSource, indexProject } from '../src/index.js';
import { config, repository } from './helpers.js';

describe('indexed relationship graph', () => {
  it('versions only indexing and resolves an imported function with stable identities and exact spans', () => {
    const auth = 'import { findUser as find } from "./database";\nexport function authenticate() { return find(); }';
    const root = repository({
      'tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' } }),
      'auth.ts': auth,
      'database.ts': 'export function findUser() {}',
    });
    const result = indexProject(root);
    expect(result.schemaVersion).toBe(2);
    expect(discoverProjects(root).schemaVersion).toBe(1);
    expect(extractSource('a.ts', 'function a() {}').symbols[0]).toEqual({ name: 'a', kind: 'function', startLine: 1, endLine: 1 });
    const files = result.projects[0]!.files;
    const source = files.find(f => f.path === 'auth.ts')!;
    const target = files.find(f => f.path === 'database.ts')!.symbols[0]!;
    const caller = source.symbols[0]!;
    const start = auth.indexOf('export function');
    expect(caller).toMatchObject({
      id: createHash('sha256').update(JSON.stringify(['tsconfig.json', 'auth.ts', 'function', start])).digest('hex'),
      parentSymbolId: null, startOffset: start, endOffset: auth.length,
    });
    expect(source.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'imports', resolution: 'static', sourceSymbolId: null, target: { projectId: 'tsconfig.json', path: 'database.ts', symbolId: null } }),
      expect.objectContaining({ kind: 'calls', resolution: 'static', sourceSymbolId: caller.id, startOffset: auth.indexOf('find()'), endOffset: auth.indexOf('find()') + 6, startLine: 2, endLine: 2, target: { projectId: 'tsconfig.json', path: 'database.ts', symbolId: target.id }, reason: null }),
      expect.objectContaining({ kind: 'references', resolution: 'static', target: { projectId: 'tsconfig.json', path: 'database.ts', symbolId: target.id } }),
    ]));
    expect(result.status).toBe('complete');
    expect(indexProject(root)).toEqual(result);
  });

  it('resolves re-exports, default and namespace imports, methods, constructors, overload implementations and nested identities', () => {
    const root = repository({
      'tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' } }),
      'api.ts': 'export default function lookup() {}\nexport class Store { read(value: string): void; read(value: string) {} }\nexport function overloaded(x: string): void; export function overloaded(x: string) {}',
      'barrel.ts': 'export { default, Store, overloaded as run } from "./api";',
      'main.ts': 'import lookup, { Store, run } from "./barrel"; import * as ns from "./barrel";\nexport function outer() { function lookup() {} lookup(); const inner = () => ns.run("x"); const store = new Store(); store.read("x"); run("x"); return inner; }\nlookup();',
    });
    const result = indexProject(root);
    const files = result.projects[0]!.files;
    const api = files.find(f => f.path === 'api.ts')!;
    const main = files.find(f => f.path === 'main.ts')!;
    const calls = main.relationships.filter(r => r.kind === 'calls');
    const implementations = api.symbols.filter(s => s.name === 'overloaded');
    expect(calls.map(c => c.target?.symbolId)).toEqual([
      main.symbols.find(s => s.name === 'lookup')!.id,
      implementations[1]!.id,
      api.symbols.find(s => s.kind === 'class')!.id,
      api.symbols.filter(s => s.name === 'read')[1]!.id,
      implementations[1]!.id,
      api.symbols.find(s => s.name === 'lookup')!.id,
    ]);
    expect(main.symbols.filter(s => s.name === 'lookup' || s.name === 'inner').every(s => s.parentSymbolId === main.symbols[0]!.id)).toBe(true);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });

  it('keeps callbacks, aliases, computed access, ambiguous dispatch and external calls explicitly uncertain', () => {
    const text = 'import { readFile } from "node:fs";\nfunction target() {}\nclass A { run() {} } class B { run() {} }\nexport function work(cb: () => void, value: A | B, key: string) { const alias = target; alias(); cb(); value[key](); value.run(); target.call(null); readFile("x", () => { target(); }); }';
    const root = repository({ 'a.ts': text });
    const result = indexProject(root);
    const file = result.projects[0]!.files[0]!;
    const calls = file.relationships.filter(r => r.kind === 'calls');
    expect(calls.map(r => r.resolution)).toEqual(['unsupported', 'dynamic', 'dynamic', 'dynamic', 'unsupported', 'external', 'static']);
    expect(calls.slice(0, -1).every(r => r.target === null && !!r.reason)).toBe(true);
    expect(calls.at(-1)!.sourceSymbolId).toBeNull();
    expect(file.relationships.some(r => r.kind === 'references' && r.target?.symbolId === file.symbols.find(s => s.name === 'target')!.id)).toBe(true);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });

  it('reports missing supported local targets and suppresses relationships involving recovered malformed declarations', () => {
    const root = repository({
      'a.ts': 'import { recovered } from "./broken"; export function caller() { recovered(); missing(); }',
      'broken.ts': 'export function recovered() {}\nconst broken = ;',
    });
    const result = indexProject(root);
    const files = result.projects[0]!.files;
    expect(files.find(f => f.path === 'broken.ts')!.relationships).toEqual([]);
    const calls = files.find(f => f.path === 'a.ts')!.relationships.filter(r => r.kind === 'calls');
    expect(calls.map(r => [r.resolution, r.reason])).toEqual([['unsupported', 'malformed-target'], ['unresolved', 'unresolved-call']]);
    expect(calls.every(r => r.target === null)).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.diagnostics.some(d => d.code === 'RELATIONSHIP_UNRESOLVED' && d.path === 'a.ts')).toBe(true);
  });

  it('uses dependency compiler options and retains selected closure across project cycles', () => {
    const root = repository({
      'app/tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@lib': ['../lib/lib.ts'] } }, files: ['main.ts'] }),
      'app/main.ts': 'import { lib } from "@lib"; export function main() { lib(); }',
      'lib/tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@dep': ['../dep/dep.ts'] } }, files: ['lib.ts'] }),
      'lib/lib.ts': 'import { dep } from "@dep"; export function lib() { dep(); }',
      'dep/tsconfig.json': config({ files: ['dep.ts'] }),
      'dep/dep.ts': 'import { lib } from "../lib/lib"; export function dep() { lib(); }',
      'unrelated/tsconfig.json': config({ files: ['bad.ts'] }),
      'unrelated/bad.ts': 'function ) {',
    });
    const result = indexProject(root, 'app/tsconfig.json');
    expect(result.projects.map(p => p.id)).toEqual(['app/tsconfig.json', 'dep/tsconfig.json', 'lib/tsconfig.json']);
    for (const project of result.projects) expect(project.files[0]!.relationships.find(r => r.kind === 'calls')!.resolution).toBe('static');
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });

  it('keeps overlapping project identities separate and uses UTF-16 offsets including non-ASCII source', () => {
    const text = '// 😀\nexport function shared() { shared(); }';
    const root = repository({
      'tsconfig.json': config({ files: [], references: [{ path: './tsconfig.a.json' }, { path: './tsconfig.b.json' }] }),
      'tsconfig.a.json': config({ files: ['shared.ts'] }), 'tsconfig.b.json': config({ files: ['shared.ts'] }),
      'shared.ts': text,
    });
    const result = indexProject(root);
    const projects = result.projects.filter(p => p.files.length);
    expect(new Set(projects.map(p => p.files[0]!.symbols[0]!.id)).size).toBe(2);
    for (const project of projects) {
      const file = project.files[0]!;
      expect(file.symbols[0]!.startOffset).toBe(text.indexOf('export'));
      expect(file.relationships.find(r => r.kind === 'calls')!.target?.symbolId).toBe(file.symbols[0]!.id);
    }
  });

  it('treats declaration-only and ambient targets as external and keeps ordinary non-call references', () => {
    const root = repository({
      'tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' } }),
      'types.d.ts': 'declare module "virtual" { export function remote(): void; }',
      'library.d.ts': 'export declare function library(): void;',
      'a.ts': 'import { remote } from "virtual"; import { library } from "./library";\nfunction local() {}\nexport const ref = local; remote(); library();',
    });
    const result = indexProject(root);
    const file = result.projects[0]!.files[0]!;
    expect(file.relationships.filter(r => r.kind === 'imports').map(r => r.resolution)).toEqual(['external', 'external']);
    expect(file.relationships.filter(r => r.kind === 'calls').map(r => r.resolution)).toEqual(['external', 'external']);
    expect(file.relationships.filter(r => r.kind === 'references' && r.resolution === 'external')).toHaveLength(2);
    expect(file.relationships.find(r => r.kind === 'references')!.target?.symbolId).toBe(file.symbols[0]!.id);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });

  it('reads package metadata for self-name exports without widening implementation indexing', () => {
    const root = repository({
      'package.json': config({ name: 'sample', type: 'module', exports: { '.': './lib.ts' } }),
      'tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' }, files: ['main.ts'] }),
      'main.ts': 'import { lib } from "sample"; export function main() { lib(); }',
      'lib.ts': 'export function lib() {}',
      'unrelated.ts': 'function ) {',
    });
    const result = indexProject(root);
    expect(result.projects[0]!.files.map(f => f.path)).toEqual(['lib.ts', 'main.ts']);
    expect(result.projects[0]!.files.find(f => f.path === 'main.ts')!.relationships.filter(r => r.kind === 'calls')[0]!.resolution).toBe('static');
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });

  it.each(['js', 'ts'])('keeps excluded node_modules %s implementations external', extension => {
    const root = repository({
      'tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' }, files: ['main.ts'] }),
      'main.ts': 'import { remote } from "plain"; export function main() { remote(); }',
      'node_modules/plain/package.json': config({ name: 'plain', main: `index.${extension}` }),
      [`node_modules/plain/index.${extension}`]: 'export function remote() {}',
    });
    const result = indexProject(root);
    const file = result.projects[0]!.files[0]!;
    expect(result.projects[0]!.files.map(f => f.path)).toEqual(['main.ts']);
    expect(file.relationships.filter(r => r.kind === 'imports' || r.kind === 'calls').map(r => r.resolution)).toEqual(['external', 'external']);
    expect(file.relationships.every(r => r.target === null)).toBe(true);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });

  it('resolves dependency re-export chains with the declaring project aliases rather than conflicting importer aliases', () => {
    const root = repository({
      'app/tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@lib': ['../lib/barrel.ts'], '@dep': ['./wrong.ts'] } }, files: ['main.ts', 'wrong.ts'] }),
      'app/main.ts': 'import { dep } from "@lib"; export function main() { dep(); }',
      'app/wrong.ts': 'export function dep() {}',
      'lib/tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@dep': ['../dep/dep.ts'] } }, files: ['barrel.ts'] }),
      'lib/barrel.ts': 'export { dep } from "@dep";',
      'dep/tsconfig.json': config({ files: ['dep.ts'] }),
      'dep/dep.ts': 'export function dep() {}',
    });
    const result = indexProject(root, 'app/tsconfig.json');
    const source = result.projects.find(p => p.id === 'app/tsconfig.json')!.files.find(f => f.path === 'app/main.ts')!;
    const target = result.projects.find(p => p.id === 'dep/tsconfig.json')!.files[0]!.symbols[0]!;
    expect(source.relationships.filter(r => r.kind === 'calls' || r.kind === 'references').map(r => r.target)).toEqual([
      { projectId: 'dep/tsconfig.json', path: 'dep/dep.ts', symbolId: target.id },
      { projectId: 'dep/tsconfig.json', path: 'dep/dep.ts', symbolId: target.id },
    ]);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });

  it('preserves unsupported local alias classification for explicitly indexed package implementations', () => {
    const root = repository({
      'acip.config.json': config({ includeExcluded: ['node_modules/plain/**'] }),
      'tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler' }, files: ['main.ts'] }),
      'main.ts': 'import { alias } from "plain"; export function main() { alias(); }',
      'node_modules/plain/package.json': config({ name: 'plain', main: 'index.ts' }),
      'node_modules/plain/index.ts': 'function local() {} export const alias = local;',
    });
    const result = indexProject(root);
    const file = result.projects[0]!.files.find(f => f.path === 'main.ts')!;
    expect(file.relationships.find(r => r.kind === 'imports')!.resolution).toBe('static');
    expect(file.relationships.find(r => r.kind === 'calls')).toMatchObject({ resolution: 'unsupported', reason: 'variable-alias-data-flow', target: null });
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });

  it('retains discovered dependency ownership for reachable files absent from config membership', () => {
    const root = repository({
      'app/tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@lib': ['../lib/barrel.ts'], '@dep': ['./wrong.ts'] } }, files: ['main.ts', 'wrong.ts'] }),
      'app/main.ts': 'import { helper, dep } from "@lib"; export function main() { helper(); dep(); }',
      'app/wrong.ts': 'export function dep() {}',
      'lib/tsconfig.json': config({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', paths: { '@dep': ['../dep/dep.ts'] } }, files: ['barrel.ts'] }),
      'lib/barrel.ts': 'export { helper, dep } from "./helper";',
      'lib/helper.ts': 'import { dep } from "@dep"; export { dep } from "@dep"; export function helper() { dep(); }',
      'dep/tsconfig.json': config({ files: ['dep.ts'] }),
      'dep/dep.ts': 'export function dep() {}',
    });
    const result = indexProject(root, 'app/tsconfig.json');
    expect(result.projects.map(p => p.id)).toEqual(['app/tsconfig.json', 'dep/tsconfig.json', 'lib/tsconfig.json']);
    const source = result.projects.find(p => p.id === 'app/tsconfig.json')!.files.find(f => f.path === 'app/main.ts')!;
    const helperFile = result.projects.find(p => p.id === 'lib/tsconfig.json')!.files.find(f => f.path === 'lib/helper.ts')!;
    const dep = result.projects.find(p => p.id === 'dep/tsconfig.json')!.files[0]!.symbols[0]!;
    const depTarget = { projectId: 'dep/tsconfig.json', path: 'dep/dep.ts', symbolId: dep.id };
    expect(source.relationships.filter(r => r.kind === 'calls').map(r => r.target)).toEqual([
      { projectId: 'lib/tsconfig.json', path: 'lib/helper.ts', symbolId: helperFile.symbols[0]!.id }, depTarget,
    ]);
    expect(helperFile.relationships.find(r => r.kind === 'calls')!.target).toEqual(depTarget);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('complete');
  });
});
