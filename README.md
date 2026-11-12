# ACIP ai

ACIP ai is a planned **Agentic Codebase Intelligence Platform** for understanding
repositories, investigating code, and generating technical documentation backed by
source evidence. It will track which documentation may be affected when code changes.

## Current status

M1 and the analyzer slice of M2 are implemented. The CLI discovers TypeScript
projects and indexes a selected project with its needed local dependencies,
including symbol identities, imports, references, and static calls. M2 persistence
and queries, M3–M7, API/web applications, and CI remain unimplemented. Current
validation results and known Windows baseline failures are recorded below.

## Planned architecture

The platform uses a hybrid Python and TypeScript architecture:

- **API (`apps/api`):** Python services will expose APIs, coordinate AI agents,
  and run background indexing and analysis jobs using analyzer output.
- **Analyzer (`packages/analyzer`):** The implemented CLI discovers TypeScript
  projects and extracts declarations, source locations, and relationships into JSON.
  Persisted knowledge remains planned.
- **Knowledge storage:** PostgreSQL with pgvector will store repositories,
  symbols, relationships, embeddings, and documentation with source provenance.
- **Investigation and documentation:** LangGraph will start with one bounded
  investigator using structured tools. Documentation generation and evidence
  verification are separate responsibilities; multiple agents will be adopted
  only if evaluation demonstrates a benefit.
- **Web (`apps/web`):** A Next.js dashboard will provide a repository explorer
  and documentation viewer through backend APIs, preserving source references,
  unsupported-claim indications, drift indicators, and relevant job status.
- **Git integration:** Git and GitHub will supply repository revisions and changes
  for indexing, drift detection, and automation.

The intended flow is repository source → TypeScript analysis → stored knowledge →
agent investigation and documentation → FastAPI → dashboard. Later commits will
be compared with documented source dependencies to identify possible drift.

## Monorepo layout

```text
apps/
├── web/              # Next.js dashboard
└── api/              # Python/FastAPI services and jobs
packages/
└── analyzer/         # TypeScript source analysis
README.md
AGENTS.md
.gitignore
```

This README is the project reference; [AGENTS.md](AGENTS.md) contains development
instructions for all three components. Only the analyzer has application code;
API and web are future component locations. The current workspace is the monorepo
root; no additional ACIP directory is required.

## Selected stack

| Area | Selected technologies |
| --- | --- |
| Frontend | Next.js, React, TypeScript, Tailwind CSS, pnpm, ESLint |
| APIs and jobs | Python, FastAPI, Pydantic v2, HTTPX, dedicated Python worker; uv, Ruff |
| Code analysis | TypeScript Compiler API; pnpm, ESLint, TypeScript checks |
| Persistence | PostgreSQL, pgvector, Alembic |
| AI | LangGraph, OpenAI API for explanations, documentation, and embeddings |
| Documentation output | Pydantic claim validation, Markdown, Mermaid |
| Testing | pytest, pytest-asyncio, Vitest, React Testing Library, Playwright |
| Integration and operations | Git CLI, GitHub API and webhooks, Docker Compose, GitHub Actions, OpenTelemetry, JSON logs |

## Milestone roadmap

This is the canonical roadmap. M1 and M2's analyzer slice are implemented; M2
persistence/queries and M3–M7 remain **planned**. Each milestone explains the reasoning, implementation approach,
and completion criteria; planned capabilities are not claims of completed work.
All milestones also require the applicable checks in [AGENTS.md](AGENTS.md).

### M1 — Source Code Indexer

**Owner:** `packages/analyzer`. **Technologies:** Node.js 22, TypeScript 6.0.3
Compiler API, Vitest, ESLint, and minimatch for configured glob patterns.

**Status:** Complete for the documented M1 scope. All 45 tests and configured
checks pass; broader production-repository evaluation belongs to later work.

**Why:** Investigation needs trustworthy structural information. Compiler-backed
parsing avoids false declarations in comments or strings and preserves TypeScript
project semantics. Discovery is separate from analysis so selecting one app does
not parse every unrelated project. JSON keeps the analyzer independent of Python
services, and partial results retain useful evidence without hiding omissions.

**How:** `discoverProjects()` reads project configuration and file metadata;
`indexProject()` creates compiler Programs only for selected/reachable projects.
`extractSource()` provides single-file extraction. The CLI wraps these functions,
records Git provenance with read-only commands, and emits versioned JSON. The
workspace exposes a binary rather than a pnpm script so `pnpm acip` has no command
banner mixed into its JSON. No repository code, plugins, or builds are executed.

#### Usage and selection

After installation and build, run from the ACIP workspace root:

```sh
pnpm acip discover /path/to/repository
pnpm acip index /path/to/repository --project apps/web/tsconfig.json
```

Discovery finds `tsconfig*.json` and custom configurations reached through project
references, without reading implementation source. Project IDs are repository-relative
config paths. Invalid discovered configs remain visible with diagnostics.

Without `--project`, indexing selects root `tsconfig.json`, otherwise the sole
project. Multiple candidates require selection. A repository with no config uses
an in-memory project (`id: "."`) over eligible source files. Valid empty projects
are supported.

Indexing follows transitive local project references and compiler-resolved imports,
re-exports, and literal dynamic imports. Each project uses its own compiler options.
Nearest containing project membership determines imported source ownership; an
already selected configuration keeps its own files. Otherwise canonical
`tsconfig.json` wins over same-directory alternatives, and unresolved ownership
is reported rather than guessed. Cycles terminate; shared files retain separate
results when explicitly analyzed in multiple project contexts.

#### Supported inputs and exclusions

- Index `.ts`, `.tsx`, `.mts`, and `.cts` implementation files, including named
  functions, identifier-bound arrow/function expressions, named classes, named
  class methods, nested declarations, and import specifiers.
- Use `.d.ts`, `.d.mts`, and `.d.cts` as resolution context, including available
  dependency and generated declarations. Do not emit them as indexed implementations.
- Respect inherited TypeScript configurations, source membership, aliases, JSX,
  module resolution, and project references. Imported local files may enter a
  Program even when absent from the config's initial include list.
- Record relevant `.js`, `.jsx`, `.mjs`, and `.cjs` inputs as unsupported omissions;
  JavaScript implementation indexing is deferred, even when `allowJs` is enabled.
- By default, skip implementation discovery/indexing in `node_modules`, `.next`,
  `dist`, `build`, `out`, `coverage`, configured output/declaration directories, and
  local `.codex`, `.agents`, and `.aws` directories. Declaration resolution remains
  available independently of these exclusions.
- Never index outside the canonical repository root, Git metadata, or migration
  backups. Discovery does not follow directory symlinks. Compiler-resolved workspace
  links may refer to implementation source inside the repository.

Optional repository-root `acip.config.json`:

```json
{
  "exclude": ["vendor/**"],
  "includeExcluded": ["packages/example/dist/**"]
}
```

Only these two string-array fields are accepted. Patterns use repository-relative,
forward-slash glob syntax. `exclude` adds exclusions; matching a directory excludes
its descendants. `includeExcluded` overrides default/custom exclusions for matching
paths, but never protected boundaries, unsupported extensions, or TypeScript project
membership. Absolute paths, parent traversal, negation, backslashes, control
characters, and unbalanced bracket/brace patterns are rejected. Malformed analyzer
configuration is fatal. Re-including large dependency trees can make discovery costly.

#### JSON contract and errors

Discovery emits `schemaVersion: 1`; indexing emits `schemaVersion: 2`.
Both commands emit `repository` (canonical absolute root),
`status` (`complete` or `partial`), `git`, `projects`, `diagnostics`, and `omissions`.
Paths and project IDs inside results are repository-relative with forward slashes.

| Record | Fields and meaning |
| --- | --- |
| Discovery project | `id`, nullable `configPath`, `references`, and config-member `files` (which may include declarations used for resolution) |
| Indexed project | `id`, nullable `configPath`, `status`, local project `dependencies`, and implementation `files` |
| Indexed file | `path`, `status`, nullable SHA-256 `contentHash`, `gitState`, `symbols`, `imports`, `relationships`, and file `diagnostics` |
| Symbol | `name`, `kind` (`function`, `class`, `method`), one-based inclusive `startLine`/`endLine`, excluding leading comments and trailing whitespace |
| Indexed symbol | Symbol fields plus deterministic `id`, nullable `parentSymbolId`, zero-based UTF-16 `startOffset`, and exclusive `endOffset` |
| Relationship | `kind` (`imports`, `references`, `calls`), nullable `sourceSymbolId`, `startOffset`/`endOffset`, inclusive `startLine`/`endLine`, `resolution`, nullable `target`, and nullable `reason` |
| Relationship target | `projectId`, repository-relative `path`, and nullable `symbolId` (null for module/file targets) |
| Import | Raw `specifier` and one-based inclusive `startLine`/`endLine` |
| Diagnostic | `code`, `severity`, `message`, with `project`, `path`, `line`, and `column` where available |
| Omission | `reason`, `affectsCompleteness`, and `project`, `path`, `specifier`, or originating `from` file where known |
| Git provenance | `available`, nullable baseline `headCommit`, and nullable `dirty` state |

Projects/files and aggregate diagnostics/omissions are sorted deterministically;
symbols/imports retain source order. No source excerpts are emitted. The TypeScript
interfaces are exported from the analyzer's built entry point; the Python consumer
smoke test reads actual CLI JSON without requiring an API service.

Malformed source retains recoverable declarations with real names and spans, but
its file is marked partial. Recovery is not proof that the source is valid.
Unreadable files have no symbols and a null hash. Broken dependency configs,
missing declarations, unresolved imports, ambiguous ownership, and unsupported
required source produce diagnostics or omissions and partial results. Expected
exclusions and declaration-only context do not alone make a run partial.

Completed full **and partial** runs return exit code `0`; consumers must inspect
`status` and `affectsCompleteness`. Invalid arguments, unreadable repository roots,
invalid analyzer configuration, and unusable selected project configurations return
`1` with a concise stderr error and no JSON. Successful output uses stdout only.

#### Working-tree provenance and limits

`headCommit` identifies the baseline, not an assertion that all indexed bytes came
from that commit. Each emitted file hashes the exact bytes parsed and records
`tracked-clean`, `modified`, `untracked`, `ignored`, or `unknown` Git state. Git HEAD
and working-tree status are checked before/after indexing; implementation hashes
are rechecked. Detected changes produce partial consistency diagnostics; a changed Git baseline
marks file provenance unknown rather than attributing new bytes to the old HEAD. A normal
working tree is not an atomic snapshot, even when these checks find no change.

Non-Git repositories have unavailable provenance and null revision/dirty values.
If Git cannot run, indexing still works and records a warning. Git optional locks,
filesystem-monitor helpers, and hooks are disabled. Inspection does not install
dependencies or generate missing Next.js declarations; those gaps remain explicit.

M1 does not resolve call graphs, prove runtime behavior, enforce full semantic type
correctness, support arbitrary computed/anonymous declarations, index selected
commit snapshots, or provide watch mode, caching, AI, persistence, or a UI.

**Verification:** Tests cover extraction and recovery, Next.js-style TSX/declarations,
config inheritance/exclusions, selective dependency traversal and cycles, overlapping
projects, local links, unsupported inputs, CLI/Python contracts, and disposable Git
repositories. The target fixtures are checked for unwanted modifications. Each
behavior group was introduced with observed failing tests before implementation;
final check results are recorded in the command reference below.

### M2 — Code Knowledge Graph

**Owners:** Analyzer for resolution; API for persistence and queries.
**Technologies:** TypeScript Compiler API; PostgreSQL planned.

**Implemented analyzer slice:** A second checker pass runs after selective dependency
discovery, preserving each project's compiler options and captured source bytes.
Dependency imports and re-exports resolve with their owning project's options,
including when the importing project defines conflicting path aliases.
Captured project ownership also applies to reachable implementations absent
from a configuration's initial file list; ambiguous ownership stays unresolved.
It uses already selected implementations as resolution context without widening
the emitted project/file set. The existing Compiler API supports this directly,
so no additional analysis dependency is needed.

Index schema v2 adds SHA-256 symbol IDs derived from the JSON tuple
`[projectId, path, kind, startOffset]`. IDs distinguish overlapping project
contexts within an analysis; they are not stable identities across revisions.
Standalone `extractSource()` keeps its original declaration contract.

Relationships retain individual source occurrences, ordered by start offset,
end offset, then kind. Imports/re-exports target files; references and direct
calls target original declarations through named/default/namespace imports and
re-export chains. Functions (including named function-valued variables), class
methods, constructors targeting classes, and overload implementations are supported.
References remain separate from calls. Unindexed anonymous function bodies have
no source symbol attribution; indexed nested declarations retain parent IDs.

Only `static` relationships have targets and a null reason. `external`, `dynamic`,
`unresolved`, and `unsupported` occurrences instead carry a reason and null target.
Declaration-only targets and excluded dependency-package implementations are
external; explicitly indexed package implementations retain local graph behavior.
Callback execution, computed call targets,
variable-alias data flow, and `.call`/`.apply`/`.bind` behavior are not inferred;
union/optional call dispatch stays uncertain. Static method resolution identifies
a declared target without proving runtime dispatch. Malformed files retain
recovered declarations but contribute no asserted relationships to/from them.
Supported local resolution failures produce `RELATIONSHIP_UNRESOLVED` diagnostics
and partial output; expected external/dynamic/unsupported cases do not alone do so.
Relationships inherit endpoint file hashes/status and the existing baseline Git
provenance; they do not establish immutable commit evidence.

**What:** Resolve relationships across files, such as `authenticate()` in
`auth.ts` calling the original `findUser()` declaration in `database.ts`, rather
than only recording that one file imports another.

**Why:** Feature explanations depend on connected symbols. Start with PostgreSQL
nodes and edges, indexed lookups, and recursive queries because the initial graph
is expected to be small and relational. Add a separate graph database such as
Neo4j only if measured requirements demonstrate PostgreSQL is insufficient.

**Remaining storage work:** Begin with the following planned responsibilities:

| Table | Responsibility |
| --- | --- |
| `repositories` | Repository identity |
| `revisions` | Analyzed commit SHAs |
| `source_files` | Paths and hashes per revision |
| `symbols` | Functions, methods, and classes |
| `symbol_edges` | Imports, references, and calls |

Associate every symbol and relationship with a specific revision. Initially
support imports, references, and statically resolved calls. Keep dynamic execution
paths explicitly uncertain; static resolution does not prove runtime behavior.

**Pass criteria:** A known project resolves a function reference across imports to
its original declaration. Fixtures verify supported relationships and provenance;
isolated PostgreSQL tests verify storage and traversal. Validate migrations on
disposable databases and pgvector retrieval when introduced.

### M3 — Agentic Investigator

**Owner:** `apps/api`. **Technologies:** Python, LangGraph, FastAPI, OpenAI API.

**What:** Introduce one investigator that gathers evidence using deterministic
tools and a maximum step count.

| Tool | Purpose |
| --- | --- |
| `list_files` | Find files matching a filter |
| `find_symbol` | Find declarations |
| `find_references` | Find symbol references |
| `get_source` | Retrieve bounded source excerpts |
| `get_dependencies` | Traverse code relationships |
| `get_commit_diff` | Inspect changes between revisions |

**Why:** LangGraph will support choosing the next action from the evidence already
collected. Start with one investigator because additional agents add complexity;
compare a planner–investigator–verifier design later and adopt it only if evaluation
shows a measurable improvement.

**How:** Find relevant symbols, inspect their references and bounded source,
assess whether the evidence is sufficient, then either investigate further within
the step limit or report findings and unresolved questions. Tools own analysis;
the model chooses how to use their results.

**Pass criteria:** For a known feature in a test repository, the investigator
finds the important symbols through tools and explicitly flags relationships it
cannot establish. Deterministic fake model adapters verify tool contracts,
evidence collection, workflow transitions, step limits, and tool/job failures.

### M4 — Documentation Engine

**Owner:** `apps/api`, consuming analyzer evidence.
**Technologies:** Python, Pydantic, Markdown, Mermaid.

**What:** Turn investigation evidence into technical documentation, diagrams, and
source citations, with substantive claims stored separately from rendered text.

**Why:** Validated structure makes generated results usable by the system. Separate
claims let later code changes trigger review of the specific statements and
sections that depend on them. Pydantic checks data shape; evidence review must
separately establish whether the cited source supports the statement.

**How:** Define a validated claim model with text, source file, start/end lines,
commit SHA, and an evidence excerpt. These are illustrative fields, not a final
schema; add field validation during implementation. Store claims and their links
to document sections, then render Markdown and Mermaid. Generation and verification
are required responsibilities, not a requirement to create multiple agents.

**Pass criteria:** Generate an authentication architecture document with a diagram
and citations. Every source reference resolves to a real file and location in the
analyzed revision; substantive claims pass evidence review. Deterministic tests
identify unsupported claims explicitly.

### M5 — Drift Detection

**Owner:** API, using analyzer results and stored claim dependencies.
**Technologies:** Git, symbol graphs, content hashing, PostgreSQL.

**What:** Identify potentially affected claims and sections when source changes,
then revalidate those claims and dependent sections.

**Why:** Git revisions provide explicit code versions; file timestamps are not a
reliable substitute. Regenerating every document adds cost, latency, and unnecessary
changes. A changed function can affect a claim without making that claim wrong.

**How:** Compare revisions, locate changed/deleted symbols using analysis and
content hashes, and follow stored evidence dependencies to claims and sections.
Retain commit references and distinguish **potentially impacted** from
**verified outdated** results.

**Pass criteria:** Disposable Git repositories verify affected and unrelated
claims, including changed/deleted source. On a labeled set of **20 code changes**,
target at least **90% recall** and **80% precision** for impacted-claim detection.
These are initial evaluation goals supplied for this milestone, not achieved
results or general code-coverage thresholds.

### M6 — Backend + Frontend

**Owners:** `apps/api` and `apps/web`.
**Technologies:** FastAPI, Next.js, PostgreSQL, a dedicated background worker.

**What:** Present the functioning analysis and documentation engine through a UI.

| Page | Purpose |
| --- | --- |
| Repository explorer | Browse indexed source structure |
| Codebase chat | Ask how features work |
| Architecture viewer | View generated diagrams |
| Documentation workspace | Read documents and inspect citations |
| Change impact dashboard | Review potential documentation drift |
| Job history | Inspect indexing and investigation outcomes |

**Why:** Establish engine accuracy before investing in dashboard development.
Keep request handling separate from long-running analysis so an HTTP connection
need not remain open for the entire job.

**How:** FastAPI initiates work and returns job/status identifiers; a separate
worker handles indexing and investigation. The web app consumes actual API
contracts and displays results, evidence, job progress, and recoverable failures.
M1–M5 must be usable without a GUI. Add service interfaces with their owning
capability; M6 integrates them rather than postponing all API work until then.

**Pass criteria:** A user selects a repository revision, asks a question, inspects
a cited explanation, views documentation, and reviews what changed without manual
CLI commands. API validation, contract, and error tests pass; Playwright covers
the critical flow, including source-reference navigation. Component tests cover
loading, empty, failure, and available drift/status states with accessible controls.

### M7 — GitHub + Reliability

**Owners:** API for integration; web for review/status; shared operational checks.
**Technologies:** GitHub API and webhooks, OpenTelemetry, Docker, CI/CD.

**What:** Make documentation maintenance continuous through the planned workflow:

```text
GitHub push → incremental indexing → impact analysis
            → proposed documentation update → human review
```

**Why:** Repository events can keep knowledge tied to current revisions. Evaluation
on unfamiliar repositories checks whether results generalize beyond our fixtures;
human review keeps proposed edits under developer control.

**How:** Use authenticated webhook events and revision comparisons, including the
GitHub compare-commits API where appropriate, to trigger reproducible analysis.
Inspect repositories without running their scripts, downloading arbitrary
dependencies, or exposing secrets. Treat source content and comments as untrusted
data, never as agent instructions.

**Pass criteria:** An authenticated event triggers reproducible analysis and a
proposed documentation update, without modifying the analyzed repository before
developer approval. Verify webhook validation, duplicate side-effect protection,
deterministic evaluations, UI status/failure presentation, and applicable configured
test, lint, type, build, browser, deployment, and observability checks.

## Why this development order matters

Each layer answers a different question and can be tested independently. Building
the investigator first could hide unreliable analysis behind plausible explanations.

| Layer | Responsibility and limit |
| --- | --- |
| Parser | Identify syntactic declarations in source |
| Type checker | Resolve references to symbols where supported |
| Knowledge graph | Represent and query revision-specific relationships |
| Investigator | Gather relevant evidence and report uncertainty |
| Documentation engine | Organize evidence into explanations |
| Verifier | Check evidence references and whether they support claims |
| Drift detector | Trigger targeted re-evaluation when code changes |

These are distinct responsibilities, not necessarily separate services or agents.
Keep their checks explicit rather than collapsing them into one large LLM prompt.

## Setup and contributing

Prerequisites: Node.js 22.12+ within the 22.x line, pnpm 10.33.4, Git for revision
provenance, and Python 3 for the consumer-contract test. No environment variables
or API credentials are required for M1.

Run these commands from the ACIP workspace root:

| Command | Purpose |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | Install the locked workspace dependencies without lifecycle scripts |
| `pnpm build` | Compile the analyzer and emit public TypeScript declarations |
| `pnpm test` | Build, then run the full Vitest suite including Git, CLI, and Python checks |
| `pnpm lint` | Check analyzer source, tests, and CLI launcher with ESLint |
| `pnpm typecheck` | Check analyzer source and TypeScript tests without emitting |
| `pnpm acip discover <repository>` | List projects and configuration diagnostics as JSON |
| `pnpm acip index <repository> --project <config-path>` | Index a project and its needed local dependencies as JSON |

Build before running the CLI; tests build automatically to prevent stale CLI tests.
Install dependencies only for ACIP itself, never automatically for analyzed targets.
The lockfile is versioned. The analyzer package also exposes `build`, `test`, `lint`,
and `typecheck` scripts through `pnpm --filter @acip/analyzer <script>`.
API/web service commands and database migrations are not configured.

Historical M1 verification on 2026-11-07:

- `pnpm install --offline --frozen-lockfile --ignore-scripts` passed using the local cache.
- `pnpm test` passed all 45 tests, including the compiled CLI and Python consumer.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed; tests also rebuild the CLI.
- `pnpm acip discover .` returned both analyzer configurations with no errors.
- `pnpm acip index . --project packages/analyzer/tsconfig.build.json` returned
  a complete index of seven implementation files, no test files, valid Git
  provenance, and no diagnostics or completeness-affecting omissions.

Analyzer M2 verification on 2026-11-11 using Node 22.16.0 and pnpm 10.33.4:

- `pnpm install --frozen-lockfile --ignore-scripts` passed.
- Focused graph/extraction tests observed red-to-green behavior; the CLI/Python
  consumer validates schema v2, target integrity, and explicit uncertainty.
- `pnpm test` passed all 58 tests, including observed failing regressions for
  external packages, dependency re-exports with conflicting path aliases, and
  ownership of reachable implementations absent from initial config membership.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed.
- `pnpm acip discover .` returned schema v1 and two projects with complete status;
  `pnpm acip index . --project packages/analyzer/tsconfig.build.json` returned
  schema v2 with complete status and no diagnostics.

Windows baseline failures were repaired by normalizing TypeScript config paths
and filesystem output-directory comparisons, invoking the real pnpm script
through Node, and using filesystem-valid unusual names. Windows link fixtures
use directory junctions and assert the exact canonical-boundary rejection;
POSIX retains actual file-symlink and newline-filename coverage. These changes
keep the same security and Git-state checks without requiring symlink privileges
or skipping tests. The CLI launcher contract runs through `pnpm test`, which
supplies the package-manager script path automatically.

Fresh-session instruction discovery has not been checked. In this environment, tests that spawn Git, Node, or Python require
execution outside the restricted sandbox; ordinary test fixtures remain local.

Follow [AGENTS.md](AGENTS.md) for the red → green → refactor workflow,
component-specific guidance, test boundaries, and completion checks. The
roadmap describes intended outcomes; each implementation task should address its
current requirement without building later milestones speculatively.

After every change, small or large, update both root README.md and AGENTS.md in
the same task before considering it complete. This includes code, tests,
configuration, dependencies, refactors, and documentation-only edits. Keeping both
documents current helps prevent the project explanation and development guidance
from drifting apart. Record what changed, why, how, and relevant validation here;
update project state, guidance, or verification details in AGENTS.md. Keep these
updates concise, proportional to the change, and grounded in actual work.

## Repository migration

Complete local copies of the original repositories, including Git histories, are
retained under the ignored `.migration-backups/` directory. Keep these backups
until they are no longer needed; they are not part of the new repository's history.

Publish and verify the replacement monorepo before deleting the old GitHub
repositories. Preserve any needed issues, pull requests, releases, and settings
separately: local Git backups do not capture that GitHub-specific information.
