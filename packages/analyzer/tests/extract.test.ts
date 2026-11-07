import { describe, expect, it } from 'vitest';
import { extractSource } from '../src/extract.js';

describe('source extraction', () => {
  it('extracts real declarations, nested functions, methods, and imports with exact lines', () => {
    const text = [
      '// function fake() {}',
      'import { db } from "./db";',
      'export function authenticate() {',
      '  function nested() {}',
      '  return db;',
      '}',
      'export class Session {',
      '  async validate() {}',
      '  "end"() {}',
      '}',
      'const arrow = () => true;',
      'const expression = function () {};',
      'const text = "class Fake {}";',
    ].join('\r\n');
    const result = extractSource('auth.ts', text);
    expect(result.symbols).toEqual([
      { name: 'authenticate', kind: 'function', startLine: 3, endLine: 6 },
      { name: 'nested', kind: 'function', startLine: 4, endLine: 4 },
      { name: 'Session', kind: 'class', startLine: 7, endLine: 10 },
      { name: 'validate', kind: 'method', startLine: 8, endLine: 8 },
      { name: 'end', kind: 'method', startLine: 9, endLine: 9 },
      { name: 'arrow', kind: 'function', startLine: 11, endLine: 11 },
      { name: 'expression', kind: 'function', startLine: 12, endLine: 12 },
    ]);
    expect(result.imports.map(i => i.specifier)).toEqual(['./db']);
    expect(result.diagnostics).toEqual([]);
  });

  it.each(['ts', 'tsx', 'mts', 'cts'])('parses %s, imports and re-exports without treating strings as declarations', extension => {
    const result = extractSource(`view.${extension}`, [
      'export { x } from "./one";',
      'import item = require("./two");',
      'const load = () => import("./three");',
      'function café() { return "function imaginary() {}"; }',
      ...(extension === 'tsx' ? ['export const View = () => <main>Hello</main>;'] : []),
    ].join('\n'));
    expect(result.imports.map(i => i.specifier)).toEqual(['./one', './two', './three']);
    expect(result.symbols.map(s => s.name)).toContain('café');
    expect(result.symbols.map(s => s.name)).not.toContain('imaginary');
    expect(result.diagnostics).toEqual([]);
  });

  it('recovers valid declarations while reporting malformed syntax without invented names', () => {
    const result = extractSource('broken.ts', 'function before() {}\nconst broken = ;\nfunction after() {}\nfunction () {}');
    expect(result.status).toBe('partial');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.symbols.map(s => s.name)).toEqual(['before', 'after']);
    expect(result.diagnostics[0]).toMatchObject({ path: 'broken.ts', line: 2, severity: 'error' });
  });
});
