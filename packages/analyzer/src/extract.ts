import ts from 'typescript';
import type { Diagnostic, Extraction, SourceSymbol } from './types.js';

export function diagnosticFromTs(diagnostic: ts.Diagnostic, path?: string): Diagnostic {
  const location = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
  return {
    code: `TS${diagnostic.code}`,
    severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ...(path ? { path } : {}),
    ...(location ? { line: location.line + 1, column: location.character + 1 } : {}),
  };
}

export function importNodes(source: ts.SourceFile): ts.StringLiteralLike[] {
  const result: ts.StringLiteralLike[] = [];
  function visit(node: ts.Node) {
    let literal: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal = node.moduleReference.expression;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      literal = node.arguments[0];
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal = node.argument.literal;
    }
    if (literal && ts.isStringLiteralLike(literal)) result.push(literal);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

export function extractAst(source: ts.SourceFile, diagnostics: readonly ts.Diagnostic[] = []): Extraction {
  const symbols: SourceSymbol[] = [];
  const lines = (node: ts.Node) => ({
    startLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    endLine: source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.getEnd() - 1)).line + 1,
  });
  function visit(node: ts.Node) {
    let kind: SourceSymbol['kind'] | undefined;
    let name: ts.Node | undefined;
    if (ts.isFunctionDeclaration(node)) { kind = 'function'; name = node.name; }
    else if (ts.isClassDeclaration(node)) { kind = 'class'; name = node.name; }
    else if (ts.isMethodDeclaration(node) && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) {
      kind = 'method'; name = node.name;
    } else if (ts.isVariableDeclaration(node) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && ts.isIdentifier(node.name)) {
      kind = 'function'; name = node.name;
    }
    if (kind && name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) &&
        name.getWidth(source) > 0 && name.text.length > 0 && node.getEnd() > node.getStart(source)) {
      symbols.push({ name: name.text, kind, ...lines(node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return {
    status: diagnostics.some(d => d.category === ts.DiagnosticCategory.Error) ? 'partial' : 'complete',
    symbols,
    imports: importNodes(source).map(node => ({ specifier: node.text, ...lines(node) })),
    diagnostics: diagnostics.map(d => diagnosticFromTs(d, source.fileName)),
  };
}

export function extractSource(path: string, text: string): Extraction {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, noEmit: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => file === path ? source : undefined;
  const program = ts.createProgram([path], options, host);
  return extractAst(source, program.getSyntacticDiagnostics(source));
}
