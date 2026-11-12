import path from 'node:path';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { declarationNodes, importNodes } from './extract.js';
import { compare, isDeclaration } from './policy.js';
import type { Project } from './projects.js';
import type { Diagnostic, IndexedFile, IndexedProject, IndexedSymbol, Relationship, RelationshipTarget } from './types.js';

export function indexedSymbols(source: ts.SourceFile, projectId: string, file: string): IndexedSymbol[] {
  const nodes = declarationNodes(source);
  const byNode = new Map<ts.Node, IndexedSymbol>();
  return nodes.map(({ node, name, kind }) => {
    const startOffset = node.getStart(source);
    let parent = node.parent;
    while (parent && !byNode.has(parent)) parent = parent.parent;
    const symbol: IndexedSymbol = {
      name, kind, startOffset, endOffset: node.getEnd(),
      startLine: source.getLineAndCharacterOfPosition(startOffset).line + 1,
      endLine: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1,
      id: createHash('sha256').update(JSON.stringify([projectId, file, kind, startOffset])).digest('hex'),
      parentSymbolId: parent ? byNode.get(parent)!.id : null,
    };
    byNode.set(node, symbol);
    return symbol;
  });
}

interface GraphInput {
  root: string;
  projects: Map<string, Project>;
  results: IndexedProject[];
  snapshots: Map<string, Buffer>;
  canonical: (file: string) => string;
  blocked: (file: string) => boolean;
  ownerOf: (file: string, current: Project) => Project | 'ambiguous';
  diagnostics: Diagnostic[];
}

export function resolveRelationships(input: GraphInput): void {
  const { root, projects, results, snapshots, canonical, blocked, ownerOf, diagnostics } = input;
  const indexed = new Map<string, { project: IndexedProject; file: IndexedFile }[]>();
  for (const project of results) for (const file of project.files) {
    const absolute = canonical(path.join(root, file.path));
    const entries = indexed.get(absolute) ?? [];
    entries.push({ project, file }); indexed.set(absolute, entries);
  }
  for (const result of results) {
    const project = projects.get(result.id)!;
    const entryFor = (absolute: string) => {
      const owner = ownerOf(absolute, project);
      if (owner === 'ambiguous') return undefined;
      const entries = indexed.get(absolute);
      return entries?.find(entry => entry.project.id === owner.id) ?? (entries?.length === 1 ? entries[0] : undefined);
    };
    const options: ts.CompilerOptions = { ...project.parsed.options, noEmit: true, incremental: false };
    const defaultLibDirectory = path.dirname(ts.getDefaultLibFilePath(options));
    const readable = (file: string) => !blocked(file) || (isDeclaration(file) && path.dirname(file) === defaultLibDirectory);
    const host = ts.createCompilerHost(options, true);
    host.getCurrentDirectory = () => root;
    host.realpath = canonical;
    host.fileExists = file => readable(file) && (snapshots.has(canonical(file)) || ts.sys.fileExists(file));
    host.directoryExists = directory => (!blocked(directory) || directory === defaultLibDirectory) && ts.sys.directoryExists(directory);
    host.readFile = file => {
      const absolute = canonical(file);
      return readable(absolute) ? snapshots.get(absolute)?.toString('utf8') ??
        (isDeclaration(absolute) || path.basename(absolute) === 'package.json' ? ts.sys.readFile(absolute) : undefined) : undefined;
    };
    host.getSourceFile = (filename, languageVersion) => {
      const file = canonical(filename);
      if (!readable(file) || (!isDeclaration(file) && !indexed.has(file))) return undefined;
      const text = host.readFile(file);
      return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
    };
    const resolutionContexts = new Map(results.map(result => {
      const options: ts.CompilerOptions = { ...projects.get(result.id)!.parsed.options, noEmit: true, incremental: false };
      return [result.id, { options, cache: ts.createModuleResolutionCache(root, file => file, options) }];
    }));
    const resolveModule = (literal: ts.StringLiteralLike, source: ts.SourceFile): ts.ResolvedModuleWithFailedLookupLocations => {
      const absolute = canonical(source.fileName);
      const entry = entryFor(absolute);
      const owner = entry ? projects.get(entry.project.id)! : indexed.has(absolute) ? 'ambiguous' : ownerOf(absolute, project);
      const context = owner === 'ambiguous' ? undefined : resolutionContexts.get(owner.id);
      if (!context) return { resolvedModule: undefined };
      return ts.resolveModuleName(literal.text, source.fileName, context.options, host, context.cache, undefined,
        ts.getModeForUsageLocation(source, literal, context.options));
    };
    host.resolveModuleNameLiterals = (literals, _containingFile, _redirectedReference, _options, source) =>
      literals.map(literal => resolveModule(literal, source));
    const program = ts.createProgram({ rootNames: [
      ...result.files.filter(f => f.contentHash !== null).map(f => canonical(path.join(root, f.path))),
      ...project.parsed.fileNames.filter(f => isDeclaration(f) && readable(f)),
    ], options, host });
    const checker = program.getTypeChecker();
    const externalModule = (resolved: ts.ResolvedModuleFull | undefined) => !!resolved &&
      (isDeclaration(resolved.resolvedFileName) ||
        (resolved.isExternalLibraryImport && !indexed.has(canonical(resolved.resolvedFileName))));
    const targetFor = (declaration: ts.Declaration): RelationshipTarget | undefined => {
      const absolute = canonical(declaration.getSourceFile().fileName);
      const entry = entryFor(absolute);
      if (!entry || entry.file.status !== 'complete') return undefined;
      const symbol = entry.file.symbols.find(s => s.startOffset === declaration.getStart() && s.endOffset === declaration.getEnd());
      return symbol ? { projectId: entry.project.id, path: entry.file.path, symbolId: symbol.id } : undefined;
    };
    for (const file of result.files) {
      if (file.status !== 'complete') continue;
      const source = program.getSourceFile(canonical(path.join(root, file.path)));
      if (!source) continue;
      const byNode = new Map(declarationNodes(source).map(({ node }, position) => [node, file.symbols[position]!]));
      const sourceSymbol = (node: ts.Node): string | null => {
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (byNode.has(parent)) return byNode.get(parent)!.id;
          if (ts.isFunctionLike(parent)) {
            if ((ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) && byNode.has(parent.parent)) return byNode.get(parent.parent)!.id;
            return null;
          }
        }
        return null;
      };
      const emit = (kind: Relationship['kind'], node: ts.Node, resolution: Relationship['resolution'], target: RelationshipTarget | null, reason: string | null) => {
        file.relationships.push({ kind, sourceSymbolId: sourceSymbol(node), startOffset: node.getStart(source), endOffset: node.getEnd(),
          startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          endLine: source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1, resolution, target, reason });
      };
      for (const literal of importNodes(source)) {
        if (isBuiltin(literal.text)) { emit('imports', literal, 'external', null, 'external-module'); continue; }
        const resolved = resolveModule(literal, source).resolvedModule;
        const entry = resolved && entryFor(canonical(resolved.resolvedFileName));
        if (entry && entry.file.status === 'complete') emit('imports', literal, 'static', { projectId: entry.project.id, path: entry.file.path, symbolId: null }, null);
        else {
          const ambient = checker.getSymbolAtLocation(literal)?.declarations?.some(d => d.getSourceFile().isDeclarationFile);
          const malformed = entry?.file.status === 'partial';
          const external = externalModule(resolved) || ambient;
          emit('imports', literal, malformed ? 'unsupported' : external ? 'external' : 'unresolved', null,
            malformed ? 'malformed-target' : external ? 'external-module' : 'unavailable-local-module');
        }
      }
      const resolveSymbol = (node: ts.Node): { target?: RelationshipTarget; symbol?: ts.Symbol } => {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const declarations = symbol?.declarations ?? [];
        const implementations = declarations.filter(d => ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) ? !!d.body : true);
        const targets = implementations.map(targetFor).filter((t): t is RelationshipTarget => !!t);
        const unique = [...new Map(targets.map(t => [JSON.stringify(t), t])).values()];
        return { symbol, ...(unique.length === 1 && targets.length === implementations.length ? { target: unique[0] } : {}) };
      };
      const externalOrigin = (node: ts.Node): boolean => {
        let root = node;
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
        const symbol = checker.getSymbolAtLocation(root);
        return !!symbol?.declarations?.some(declaration => {
          if (declaration.getSourceFile().isDeclarationFile) return true;
          for (let parent: ts.Node | undefined = declaration; parent; parent = parent.parent) {
            if (ts.isImportDeclaration(parent) && ts.isStringLiteralLike(parent.moduleSpecifier)) {
              const literal = parent.moduleSpecifier;
              if (isBuiltin(literal.text)) return true;
              const resolved = resolveModule(literal, declaration.getSourceFile()).resolvedModule;
              return externalModule(resolved) ||
                !!checker.getSymbolAtLocation(literal)?.declarations?.some(d => d.getSourceFile().isDeclarationFile);
            }
          }
          return false;
        });
      };
      const callResolution = (node: ts.CallExpression | ts.NewExpression): Pick<Relationship, 'resolution' | 'target' | 'reason'> => {
        const expression = node.expression;
        const uncertain = (resolution: Relationship['resolution'], reason: string) => ({ resolution, target: null, reason });
        if (ts.isElementAccessExpression(expression)) return uncertain('dynamic', 'computed-call-target');
        if ((ts.isCallExpression(node) && node.questionDotToken) || (ts.isPropertyAccessExpression(expression) && expression.questionDotToken)) return uncertain('dynamic', 'optional-call-target');
        if (ts.isPropertyAccessExpression(expression)) {
          if (['call', 'apply', 'bind'].includes(expression.name.text)) return uncertain('unsupported', 'indirect-function-invocation');
          if (checker.getTypeAtLocation(expression.expression).isUnion()) return uncertain('dynamic', 'multiple-possible-targets');
        }
        const resolved = resolveSymbol(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
        if (resolved.target) return { resolution: 'static', target: resolved.target, reason: null };
        const declarations = resolved.symbol?.declarations ?? [];
        if (declarations.some(d => entryFor(canonical(d.getSourceFile().fileName))?.file.status === 'partial')) return uncertain('unsupported', 'malformed-target');
        if (externalOrigin(expression) || declarations.some(d => d.getSourceFile().isDeclarationFile)) return uncertain('external', 'external-declaration');
        if (declarations.some(d => ts.isParameter(d) || ts.isPropertySignature(d))) return uncertain('dynamic', 'runtime-callable-value');
        if (declarations.some(d => ts.isVariableDeclaration(d))) return uncertain('unsupported', 'variable-alias-data-flow');
        if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return uncertain('dynamic', 'runtime-call-target');
        if (declarations.length) return uncertain('unsupported', 'unindexed-declaration');
        return uncertain('unresolved', 'unresolved-call');
      };
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
            const resolution = callResolution(node);
            emit('calls', node, resolution.resolution, resolution.target, resolution.reason);
          }
        }
        if (ts.isIdentifier(node)) {
          const parent = node.parent;
          const declarationName = 'name' in parent && parent.name === node;
          const importBinding = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
          if (!importBinding && (!declarationName || ts.isPropertyAccessExpression(parent))) {
            const resolved = resolveSymbol(node);
            if (resolved.target) emit('references', node, 'static', resolved.target, null);
            else {
              const expression = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
              const call = expression.parent;
              const isCallee = (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === expression;
              const declarations = resolved.symbol?.declarations ?? [];
              const callable = checker.getTypeAtLocation(node).getCallSignatures().length > 0;
              if (isCallee) {
                const resolution = callResolution(call);
                emit('references', node, resolution.resolution, resolution.target, resolution.reason);
              } else if (callable || declarations.some(d => ts.isClassDeclaration(d))) {
                const malformed = declarations.some(d => entryFor(canonical(d.getSourceFile().fileName))?.file.status === 'partial');
                const external = externalOrigin(node) || declarations.some(d => d.getSourceFile().isDeclarationFile);
                emit('references', node, malformed ? 'unsupported' : external ? 'external' : 'dynamic', null,
                  malformed ? 'malformed-target' : external ? 'external-declaration' : 'runtime-callable-value');
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      file.relationships.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset || compare(a.kind, b.kind));
    }
  }
  // Supported local resolution failures are reported with source locations.
  for (const result of results) for (const file of result.files) for (const relationship of file.relationships) {
    if (relationship.resolution !== 'unresolved') continue;
    const diagnostic: Diagnostic = { code: 'RELATIONSHIP_UNRESOLVED', severity: 'error', project: result.id, path: file.path,
      line: relationship.startLine, message: relationship.reason! };
    file.diagnostics.push(diagnostic); diagnostics.push(diagnostic); file.status = 'partial'; result.status = 'partial';
  }
}
