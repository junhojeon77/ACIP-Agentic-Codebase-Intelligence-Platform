# ACIP ai

ACIP ai is a planned **Agentic Codebase Intelligence Platform** for understanding
repositories, investigating code, and generating technical documentation backed by
source evidence. It will track which documentation may be affected when code changes.

## Current status

This monorepo contains an apps/packages layout, documentation, and development
instructions only. All milestones below are **planned**. Application scaffolding,
dependencies, executable checks, workspace tooling, and CI are not yet configured.
The selected technologies describe the intended architecture, not working features.

## Planned architecture

The platform uses a hybrid Python and TypeScript architecture:

- **API (`apps/api`):** Python services will expose APIs, coordinate AI agents,
  and run background indexing and analysis jobs using analyzer output.
- **Analyzer (`packages/analyzer`):** An independent TypeScript package will
  extract native code structure, symbols, source locations, references, and
  dependencies. M1 starts with a TypeScript CLI accepting a repository path and
  emitting JSON; the exact schema and Python invocation boundary remain to be
  implemented.
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
instructions for all three components. Empty `.gitkeep` files preserve the
component directories until source files exist. The current workspace is the
monorepo root; no additional ACIP directory is required.

## Selected stack

| Area | Selected technologies |
| --- | --- |
| Frontend | Next.js, React, TypeScript, Tailwind CSS, shadcn/ui; pnpm, ESLint |
| APIs and jobs | Python, FastAPI, Pydantic v2, HTTPX, dedicated Python worker; uv, Ruff |
| Code analysis | TypeScript Compiler API; ts-morph as needed for M2; pnpm, ESLint, TypeScript checks |
| Persistence | PostgreSQL, pgvector, Alembic |
| AI | LangGraph, OpenAI API for explanations, documentation, and embeddings |
| Documentation output | Pydantic claim validation, Markdown, Mermaid |
| Testing | pytest, pytest-asyncio, Vitest, React Testing Library, Playwright |
| Integration and operations | Git CLI, GitHub API and webhooks, Docker Compose, GitHub Actions, OpenTelemetry, JSON logs |

## Milestone roadmap

All milestones are **planned**. This is the canonical roadmap, including the
reasoning, intended implementation, and completion criteria for each milestone.
The approaches below describe how we plan to build the system, not completed work.
All milestones also require the applicable checks in [AGENTS.md](AGENTS.md).

### M1 — Source Code Indexer

**Owner:** `packages/analyzer`. **Technologies:** TypeScript, Compiler API, Vitest.

**What:** Build a CLI that accepts a local repository path and outputs structured
JSON describing files, named functions, classes, methods, imports, and source
locations. The intended interaction is an `index` command with a repository-path
argument; the executable name and exact output contract are not finalized.

Illustrative output, not an implemented contract:

```json
{
  "repository": "./my-nextjs-app",
  "files": [
    {
      "path": "src/auth.ts",
      "symbols": [
        {
          "name": "authenticate",
          "kind": "function",
          "startLine": 3,
          "endLine": 5
        }
      ],
      "imports": ["./database"]
    }
  ]
}
```

**Why:** Investigation needs trustworthy structural information. Deterministic
lookup tools let an agent find declarations and relationships without depending
on guesses from an entire repository placed in a prompt.

**How:** Start with individual TypeScript AST parsing, then load a project through
its `tsconfig.json` and the compiler's `Program` abstraction. Define the JSON
contract for Python consumers during M1. Start with TypeScript fixtures; broader
language support needs an explicit requirement.

**Pass criteria:** Fixtures correctly identify named functions, classes, methods,
and imports with accurate source locations. Comments and strings do not produce
false declarations; generated output and dependency directories are excluded.
Malformed input produces clear diagnostics, and analyzer/Python contract checks
verify compatibility as the consumer boundary is introduced.

### M2 — Code Knowledge Graph

**Owners:** Analyzer for resolution; API for persistence and queries.
**Technologies:** TypeScript Compiler API or ts-morph, PostgreSQL.

**What:** Resolve relationships across files, such as `authenticate()` in
`auth.ts` calling the original `findUser()` declaration in `database.ts`, rather
than only recording that one file imports another.

**Why:** Feature explanations depend on connected symbols. Start with PostgreSQL
nodes and edges, indexed lookups, and recursive queries because the initial graph
is expected to be small and relational. Add a separate graph database such as
Neo4j only if measured requirements demonstrate PostgreSQL is insufficient.

**How:** Begin with the following planned storage responsibilities:

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

No setup or execution commands are verified yet. As scaffolding is introduced,
maintain the command reference here, grouped by component, with actual working
directories and required environment variable names without secrets.

| Component | Commands to document once configured | Current status |
| --- | --- | --- |
| Web (`apps/web`) | Install, development server, build, component/browser tests, lint, type checks | Not configured |
| API (`apps/api`) | Install, service/worker startup, migrations, tests, lint, configured type checks | Not configured |
| Analyzer (`packages/analyzer`) | Install, build, analysis invocation, tests, lint, type checks | Not configured |

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
