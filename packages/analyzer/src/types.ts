export type AnalysisStatus = 'complete' | 'partial';
export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  project?: string;
  path?: string;
  line?: number;
  column?: number;
}
export interface SourceSymbol {
  name: string;
  kind: 'function' | 'class' | 'method';
  startLine: number;
  endLine: number;
}
export interface SourceImport {
  specifier: string;
  startLine: number;
  endLine: number;
}
export interface Extraction {
  status: AnalysisStatus;
  symbols: SourceSymbol[];
  imports: SourceImport[];
  diagnostics: Diagnostic[];
}
export interface Omission {
  project?: string;
  path?: string;
  specifier?: string;
  from?: string;
  reason: string;
  affectsCompleteness: boolean;
}
export type GitState = 'tracked-clean' | 'modified' | 'untracked' | 'ignored' | 'unknown';
export interface IndexedFile extends Extraction {
  path: string;
  contentHash: string | null;
  gitState: GitState;
}
export interface IndexedProject {
  id: string;
  configPath: string | null;
  status: AnalysisStatus;
  dependencies: string[];
  files: IndexedFile[];
}
export interface GitProvenance {
  available: boolean;
  headCommit: string | null;
  dirty: boolean | null;
}
export interface IndexResult {
  schemaVersion: 1;
  repository: string;
  status: AnalysisStatus;
  git: GitProvenance;
  projects: IndexedProject[];
  diagnostics: Diagnostic[];
  omissions: Omission[];
}
