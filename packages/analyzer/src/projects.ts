import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { diagnosticFromTs } from './extract.js';
import { compare, FilePolicy, isImplementation, isJavaScript } from './policy.js';
import type { Diagnostic } from './types.js';

export interface Project {
  id: string;
  configPath: string | null;
  directory: string;
  parsed: ts.ParsedCommandLine;
  diagnostics: Diagnostic[];
  references: string[];
}
export interface Workspace {
  root: string;
  policy: FilePolicy;
  projects: Map<string, Project>;
  skippedDirectories: string[];
  diagnostics: Diagnostic[];
}

export function loadWorkspace(repository: string): Workspace {
  let root: string;
  try {
    root = fs.realpathSync(repository);
    if (!fs.statSync(root).isDirectory()) throw new Error();
    fs.readdirSync(root);
  } catch { throw new Error('Repository path must be a readable directory'); }
  const policy = new FilePolicy(root);
  const files: string[] = [];
  const links: string[] = [];
  const skippedDirectories: string[] = [];
  const diagnostics: Diagnostic[] = [];
  function walk(directory: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch {
      diagnostics.push({ code: 'DIRECTORY_UNREADABLE', severity: 'error', path: policy.relative(directory), message: 'Cannot read directory' });
      return;
    }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { links.push(file); continue; }
      if (policy.blocked(file)) continue;
      if (entry.isDirectory()) {
        if (policy.excluded(file) && !policy.mayReinclude(file)) skippedDirectories.push(policy.relative(file));
        else walk(file);
      } else if (entry.isFile()) files.push(file);
    }
  }
  walk(root);
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: file => !policy.blocked(file) && ts.sys.fileExists(file),
    readFile: file => !policy.blocked(file) ? ts.sys.readFile(file) : undefined,
    readDirectory: (directory, extensions, excludes, includes, depth) => {
      if (policy.blocked(directory)) return [];
      return ts.sys.readDirectory(directory, extensions, [...excludes ?? [], ...links], includes, depth)
        .filter(file => !policy.blocked(file));
    },
  };
  const projects = new Map<string, Project>();
  const queue = files.filter(file => /^tsconfig.*\.json$/i.test(path.basename(file)) && !policy.excluded(file));
  for (let index = 0; index < queue.length; index++) {
    const configFile = path.resolve(queue[index]!);
    const id = policy.relative(configFile);
    if (projects.has(id)) continue;
    const read = ts.readConfigFile(configFile, host.readFile);
    const parsed = read.error
      ? { options: {}, fileNames: [], errors: [read.error] } as ts.ParsedCommandLine
      : ts.parseJsonConfigFileContent(read.config, host, path.dirname(configFile), undefined, configFile);
    // Empty projects and solution configs are valid discovery results.
    const errors = parsed.errors.filter(d => d.code !== 18002 && d.code !== 18003);
    const projectDiagnostics = errors.map(d => ({ ...diagnosticFromTs(d, id), project: id }));
    const references = (parsed.projectReferences ?? []).map(ref => {
      const target = ref.path.endsWith('.json') ? ref.path : path.join(ref.path, 'tsconfig.json');
      if (policy.blocked(target)) {
        projectDiagnostics.push({ code: 'PROJECT_OUTSIDE_REPOSITORY', severity: 'error', project: id, path: id, message: 'Project reference leaves the repository boundary' });
      } else queue.push(target);
      return policy.relative(target);
    }).sort(compare);
    for (const dir of [parsed.options.outDir, parsed.options.declarationDir]) {
      if (dir && !policy.blocked(dir)) policy.outputDirectories.add(path.resolve(dir));
    }
    projects.set(id, { id, configPath: id, directory: path.dirname(configFile), parsed, diagnostics: projectDiagnostics, references });
  }
  for (const [id, project] of projects) {
    if (policy.excluded(path.join(root, id))) { projects.delete(id); skippedDirectories.push(policy.relative(project.directory)); }
  }
  if (!projects.size) {
    projects.set('.', {
      id: '.', configPath: null, directory: root, references: [], diagnostics: [],
      parsed: { options: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve, allowJs: true }, fileNames: files.filter(file => (isImplementation(file) || isJavaScript(file)) && !policy.excluded(file)), errors: [] },
    });
  }
  return { root, policy, projects, skippedDirectories: [...new Set(skippedDirectories)].sort(compare), diagnostics };
}

export function discoverProjects(repository: string) {
  const workspace = loadWorkspace(repository);
  const { root, policy } = workspace;
  const projects = [...workspace.projects.values()].sort((a, b) => compare(a.id, b.id));
  const diagnostics = [...workspace.diagnostics, ...projects.flatMap(project => project.diagnostics)];
  return {
    schemaVersion: 1 as const,
    repository: root,
    status: diagnostics.some(d => d.severity === 'error') ? 'partial' as const : 'complete' as const,
    projects: projects.map(project => ({
      id: project.id, configPath: project.configPath, references: project.references,
      files: project.parsed.fileNames.filter(file => !policy.excluded(file)).map(file => policy.relative(file)).sort(compare),
    })),
    diagnostics,
    omissions: workspace.skippedDirectories.map(file => ({ path: file, reason: 'excluded-directory', affectsCompleteness: false })),
  };
}
