import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { readGit } from './git.js';
import { diagnosticFromTs, extractAst, importNodes } from './extract.js';
import { loadWorkspace, type Project } from './projects.js';
import { compare, isDeclaration, isImplementation, isJavaScript } from './policy.js';
import type { Diagnostic, IndexedFile, IndexedProject, IndexResult, Omission } from './types.js';
export { discoverProjects } from './projects.js';
export { extractSource } from './extract.js';
export type * from './types.js';

export const hashContent = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function indexProject(repository: string, projectId?: string): IndexResult {
  const workspace = loadWorkspace(repository);
  const { root, policy, projects } = workspace;
  const initialGit = readGit(root);
  const selected = projectId === undefined
    ? projects.get('tsconfig.json') ?? (projects.size === 1 ? [...projects.values()][0] : undefined)
    : projects.get(projectId);
  if (!selected) throw new Error(`Select a valid project using --project: ${[...projects.keys()].sort(compare).join(', ')}`);
  if (selected.diagnostics.some(d => d.severity === 'error')) throw new Error(`Selected project configuration is unusable: ${selected.id}`);
  const diagnostics: Diagnostic[] = [...workspace.diagnostics];
  if (initialGit.error) diagnostics.push({ code: 'GIT_UNAVAILABLE', severity: 'warning', message: initialGit.error });
  const omissions: Omission[] = workspace.skippedDirectories.map(file => ({ path: file, reason: 'excluded-directory', affectsCompleteness: false }));
  const results = new Map<string, IndexedProject>();
  const queue = [selected];
  const snapshots = new Map<string, Buffer>();

  const ownerOf = (file: string, current: Project): Project | 'ambiguous' => {
    const candidates = [...projects.values()].filter(project =>
      (file === project.directory || file.startsWith(project.directory + path.sep)) &&
      project.parsed.fileNames.some(name => policy.canonical(name) === file));
    if (!candidates.length) return current;
    const deepest = Math.max(...candidates.map(p => p.directory.length));
    const nearest = candidates.filter(p => p.directory.length === deepest);
    if (nearest.includes(current)) return current;
    const canonical = nearest.filter(p => p.configPath && path.basename(p.configPath) === 'tsconfig.json');
    return canonical.length === 1 ? canonical[0]! : nearest.length === 1 ? nearest[0]! : 'ambiguous';
  };

  for (let position = 0; position < queue.length; position++) {
    const project = queue[position]!;
    if (results.has(project.id)) continue;
    const result: IndexedProject = { id: project.id, configPath: project.configPath, status: 'complete', dependencies: [], files: [] };
    results.set(project.id, result);
    const addDiagnostic = (diagnostic: Diagnostic) => {
      diagnostics.push({ ...diagnostic, project: project.id });
      if (diagnostic.severity === 'error') result.status = 'partial';
    };
    const omit = (omission: Omission) => {
      omissions.push({ ...omission, project: project.id });
      if (omission.affectsCompleteness) result.status = 'partial';
    };
    const enqueue = (id: string) => {
      const dependency = projects.get(id);
      if (id !== project.id && !result.dependencies.includes(id)) result.dependencies.push(id);
      if (dependency) queue.push(dependency);
      else addDiagnostic({ code: 'PROJECT_UNAVAILABLE', severity: 'error', message: 'Referenced project is excluded, outside the repository, or unavailable', path: id });
    };
    project.diagnostics.forEach(addDiagnostic);
    if (result.status === 'partial') continue;
    project.references.forEach(enqueue);
    const options: ts.CompilerOptions = { ...project.parsed.options, noEmit: true, incremental: false };
    const defaultLibDirectory = path.dirname(ts.getDefaultLibFilePath(options));
    const readable = (file: string) => !policy.blocked(file) ||
      (isDeclaration(file) && path.dirname(file) === defaultLibDirectory);
    const host = ts.createCompilerHost(options, true);
    host.getCurrentDirectory = () => root;
    host.fileExists = file => readable(file) && ts.sys.fileExists(file);
    host.directoryExists = directory => (!policy.blocked(directory) || directory === defaultLibDirectory) && ts.sys.directoryExists(directory);
    host.readFile = file => readable(file) ? ts.sys.readFile(file) : undefined;
    host.realpath = file => policy.canonical(file);
    const allowed = new Set<string>();
    const fileQueue: string[] = [];
    for (const candidate of project.parsed.fileNames) {
      const file = policy.canonical(candidate);
      if (policy.excluded(file)) {
        if (!isDeclaration(file)) omit({ path: policy.relative(candidate), reason: 'excluded-source', affectsCompleteness: false });
      } else if (isJavaScript(file)) {
        omit({ path: policy.relative(file), reason: 'unsupported-javascript', affectsCompleteness: true });
      } else if (isImplementation(file)) {
        allowed.add(file); fileQueue.push(file);
      }
    }
    const sources = new Map<string, ts.SourceFile>();
    host.getSourceFile = (filename, languageVersion) => {
      const file = policy.canonical(filename);
      if (!readable(file) || (!isDeclaration(file) && !allowed.has(file))) return undefined;
      if (sources.has(file)) return sources.get(file);
      try {
        const bytes = fs.readFileSync(file);
        const source = ts.createSourceFile(file, bytes.toString('utf8'), languageVersion, true);
        sources.set(file, source);
        if (!policy.blocked(file)) snapshots.set(file, bytes);
        return source;
      } catch { return undefined; }
    };
    let program = ts.createProgram({ rootNames: [...allowed, ...project.parsed.fileNames.filter(file => isDeclaration(file) && readable(file))], options, host });
    const resolutionCache = ts.createModuleResolutionCache(root, file => file, options);
    const visited = new Set<string>();
    for (let filePosition = 0; filePosition < fileQueue.length; filePosition++) {
      const file = fileQueue[filePosition]!;
      if (visited.has(file)) continue;
      visited.add(file);
      let source = program.getSourceFile(file);
      if (!source) {
        // Imported local files need not be listed in tsconfig include/exclude roots.
        program = ts.createProgram({ rootNames: [...allowed, ...project.parsed.fileNames.filter(name => isDeclaration(name) && readable(name))], options, host });
        source = program.getSourceFile(file);
      }
      const relative = policy.relative(file);
      if (!source) {
        const diagnostic: Diagnostic = { code: 'SOURCE_UNREADABLE', severity: 'error', path: relative, message: 'Cannot read implementation source' };
        addDiagnostic(diagnostic);
        result.files.push({ path: relative, status: 'partial', contentHash: null, gitState: 'unknown', symbols: [], imports: [], diagnostics: [{ ...diagnostic, project: project.id }] });
        continue;
      }
      const extraction = extractAst(source, program.getSyntacticDiagnostics(source));
      extraction.diagnostics = extraction.diagnostics.map(d => ({ ...d, project: project.id, path: relative }));
      const indexed: IndexedFile = { ...extraction, path: relative, contentHash: hashContent(snapshots.get(file)!), gitState: 'unknown' };
      result.files.push(indexed);
      extraction.diagnostics.forEach(addDiagnostic);
      for (const literal of importNodes(source)) {
        const specifier = literal.text;
        if (isBuiltin(specifier)) continue;
        const resolved = ts.resolveModuleName(specifier, file, options, host, resolutionCache, undefined,
          program.getModeForUsageLocation(source, literal)).resolvedModule;
        if (!resolved) {
          const ambient = program.getTypeChecker().getAmbientModules().some(symbol => {
            const name = symbol.name.slice(1, -1);
            const star = name.indexOf('*');
            return name === specifier || (star >= 0 && specifier.startsWith(name.slice(0, star)) && specifier.endsWith(name.slice(star + 1)));
          });
          if (!ambient) omit({ from: relative, specifier, reason: 'unresolved-import', affectsCompleteness: true });
          continue;
        }
        const target = policy.canonical(resolved.resolvedFileName);
        if (isDeclaration(target)) continue;
        if (policy.excluded(target)) {
          omit({ from: relative, path: policy.relative(target), specifier, reason: policy.blocked(target) ? 'outside-repository' : 'excluded-source', affectsCompleteness: !target.split(path.sep).includes('node_modules') });
        } else if (isJavaScript(target)) {
          omit({ from: relative, path: policy.relative(target), specifier, reason: 'unsupported-javascript', affectsCompleteness: true });
        } else if (isImplementation(target)) {
          const owner = ownerOf(target, project);
          if (owner === 'ambiguous') {
            addDiagnostic({ code: 'AMBIGUOUS_PROJECT', severity: 'error', path: policy.relative(target), message: 'Imported implementation belongs to multiple equally specific projects' });
            omit({ from: relative, path: policy.relative(target), specifier, reason: 'ambiguous-project', affectsCompleteness: true });
          } else if (owner.id !== project.id) enqueue(owner.id);
          else { allowed.add(target); fileQueue.push(target); }
        } else omit({ from: relative, path: policy.relative(target), specifier, reason: 'unsupported-source', affectsCompleteness: true });
      }
    }
    for (const source of program.getSourceFiles()) {
      if (policy.blocked(source.fileName)) continue;
      for (const reference of source.referencedFiles) {
        const target = path.resolve(path.dirname(source.fileName), reference.fileName);
        if (!host.fileExists(target)) addDiagnostic({ code: 'MISSING_DECLARATION', severity: 'error', path: policy.relative(source.fileName), message: `Referenced file is unavailable: ${policy.relative(target)}` });
      }
      for (const reference of source.typeReferenceDirectives) {
        if (!ts.resolveTypeReferenceDirective(reference.fileName, source.fileName, options, host).resolvedTypeReferenceDirective) {
          addDiagnostic({ code: 'MISSING_DECLARATION', severity: 'error', path: policy.relative(source.fileName), message: `Referenced types are unavailable: ${reference.fileName}` });
        }
      }
    }
    for (const diagnostic of program.getOptionsDiagnostics()) {
      if (diagnostic.category === ts.DiagnosticCategory.Error && ![6053].includes(diagnostic.code)) {
        addDiagnostic(diagnosticFromTs(diagnostic, diagnostic.file ? policy.relative(diagnostic.file.fileName) : project.configPath ?? undefined));
      }
    }
    result.files.sort((a, b) => compare(a.path, b.path));
    result.dependencies.sort(compare);
  }
  const orderedProjects = [...results.values()].sort((a, b) => compare(a.id, b.id));
  const finalGit = readGit(root, orderedProjects.flatMap(project => project.files.map(file => path.join(root, file.path))));
  const gitChanged = initialGit.signature !== finalGit.signature || initialGit.provenance.available !== finalGit.provenance.available;
  if (gitChanged) {
    diagnostics.push({ code: 'GIT_CHANGED', severity: 'error', message: 'Git HEAD or working-tree state changed during indexing; results are not an immutable snapshot' });
    for (const result of orderedProjects) result.status = 'partial';
  }
  for (const result of orderedProjects) {
    for (const file of result.files) {
      const absolute = path.join(root, file.path);
      file.gitState = initialGit.states.get(absolute) ?? (finalGit.states.get(absolute) === 'ignored' ? 'ignored' : initialGit.provenance.available ? 'untracked' : 'unknown');
      if (gitChanged) { file.gitState = 'unknown'; file.status = 'partial'; }
      if (file.contentHash === null) continue;
      let currentHash: string | null = null;
      try { currentHash = hashContent(fs.readFileSync(absolute)); } catch { /* A disappeared file is a consistency failure. */ }
      if (currentHash !== file.contentHash) {
        const diagnostic: Diagnostic = { code: 'SOURCE_CHANGED', severity: 'error', project: result.id, path: file.path, message: 'Source bytes changed during indexing; locations describe the captured bytes' };
        file.status = 'partial'; result.status = 'partial';
        file.gitState = 'unknown';
        file.diagnostics.push(diagnostic); diagnostics.push(diagnostic);
      }
    }
  }
  return {
    schemaVersion: 1, repository: root,
    status: orderedProjects.some(p => p.status === 'partial') || diagnostics.some(d => d.severity === 'error') ? 'partial' : 'complete',
    git: initialGit.provenance,
    projects: orderedProjects,
    diagnostics: diagnostics.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
    omissions: [...new Map(omissions.map(item => [JSON.stringify(item), item])).values()].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
  };
}
