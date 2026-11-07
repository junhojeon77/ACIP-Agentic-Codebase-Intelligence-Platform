import fs from 'node:fs';
import path from 'node:path';
import { Minimatch } from 'minimatch';

export const isDeclaration = (file: string) => /\.d\.(?:ts|mts|cts)$/i.test(file);
export const isImplementation = (file: string) => /\.(?:ts|tsx|mts|cts)$/i.test(file) && !isDeclaration(file);
export const isJavaScript = (file: string) => /\.(?:js|jsx|mjs|cjs)$/i.test(file);
export const slash = (file: string) => file.split(path.sep).join('/');
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const defaults = new Set(['node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.codex', '.agents', '.aws']);
const protectedNames = new Set(['.git', '.migration-backups']);

export class FilePolicy {
  readonly excludes: Minimatch[];
  readonly includes: Minimatch[];
  readonly outputDirectories = new Set<string>();

  constructor(readonly root: string) {
    const file = path.join(root, 'acip.config.json');
    if (this.blocked(file)) throw new Error('acip.config.json must remain inside the repository boundary');
    let value: unknown = {};
    if (fs.existsSync(file)) {
      try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new Error('Cannot read valid JSON from acip.config.json'); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['exclude', 'includeExcluded'].includes(key))) {
      throw new Error('acip.config.json accepts only exclude and includeExcluded arrays');
    }
    const config = value as Record<string, unknown>;
    const patterns = (key: string) => {
      const list = Object.hasOwn(config, key) ? config[key] : [];
      if (!Array.isArray(list)) throw new Error(`acip.config.json: ${key} must be an array`);
      return list.map((pattern: unknown) => {
        if (typeof pattern !== 'string' || !pattern || pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern) ||
            pattern.startsWith('!') || pattern.includes('\\') || /[\x00-\x1f]/.test(pattern) ||
            pattern.split('/').includes('..') || (pattern.match(/\[/g)?.length ?? 0) !== (pattern.match(/\]/g)?.length ?? 0) ||
            (pattern.match(/\{/g)?.length ?? 0) !== (pattern.match(/\}/g)?.length ?? 0)) {
          throw new Error(`acip.config.json: invalid ${key} pattern`);
        }
        const matcher = new Minimatch(pattern, { dot: true, nonegate: true, nocomment: true });
        if (!matcher.makeRe()) throw new Error(`acip.config.json: invalid ${key} pattern`);
        return matcher;
      });
    };
    this.excludes = patterns('exclude');
    this.includes = patterns('includeExcluded');
  }

  relative(file: string): string { return slash(path.relative(this.root, file)); }
  protected(file: string): boolean {
    const relative = this.relative(file);
    return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ||
      relative.split('/').some(part => protectedNames.has(part));
  }
  canonical(file: string): string { try { return fs.realpathSync(file); } catch { return path.resolve(file); } }
  blocked(file: string): boolean { return this.protected(file) || this.protected(this.canonical(file)); }
  excluded(file: string): boolean {
    if (this.blocked(file)) return true;
    const relative = this.relative(file);
    if (this.includes.some(pattern => pattern.match(relative))) return false;
    return relative.split('/').some(part => defaults.has(part)) ||
      [...this.outputDirectories].some(dir => file === dir || file.startsWith(dir + path.sep)) ||
      this.excludes.some(pattern => relative.split('/').some((_, index, parts) => pattern.match(parts.slice(0, index + 1).join('/'))));
  }
  mayReinclude(directory: string): boolean {
    return !this.blocked(directory) && this.includes.some(pattern => pattern.match(this.relative(directory), true));
  }
}
