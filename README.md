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
  dependencies. Its output contract, transport, supported source languages, and
  initial invocation method will be defined during M1 implementation.
- **Knowledge storage:** PostgreSQL with pgvector will store repositories,
  symbols, relationships, embeddings, and documentation with source provenance.
- **Agents:** LangGraph will coordinate Investigator, Documenter, and Verifier
  agents to inspect code through structured tools, write documentation, and check
  claims against source evidence.
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
| Code analysis | TypeScript Compiler API, ts-morph; pnpm, ESLint, TypeScript checks |
| Persistence | PostgreSQL, pgvector, Alembic |
| AI | LangGraph, OpenAI API for explanations, documentation, and embeddings |
| Testing | pytest, pytest-asyncio, Vitest, React Testing Library, Playwright |
| Integration and operations | Git CLI, GitHub API and webhooks, Docker Compose, GitHub Actions, OpenTelemetry, JSON logs |

## Milestone roadmap

All milestones are planned. This is the canonical roadmap. Completion requires
the observable results below and the checks in [AGENTS.md](AGENTS.md).

| Milestone | Ownership and deliverables | Completion criteria |
| --- | --- | --- |
| **M1 — Source Code Indexer** | Analyzer: extract files, symbols, and source locations. | Local fixtures verify expected structure and source locations; malformed input produces clear diagnostics; analyzer/Python contracts are tested. |
| **M2 — Code Knowledge Graph** | API: persist and query relationships with source provenance; analyzer: extract source relationships. | Analyzer fixtures verify supported relationships and provenance; isolated PostgreSQL tests verify storage and traversal; disposable databases validate migrations; pgvector-specific retrieval is tested when introduced. |
| **M3 — Agentic Investigator** | API: investigate code with structured tools and LangGraph, consuming analyzer evidence. | Contract checks preserve tool evidence; deterministic fake model adapters verify tool-driven investigation, workflow transitions, evidence collection, and tool/job failure handling. |
| **M4 — Documentation Engine** | API: coordinate Documenter and Verifier workflows to generate source-backed documentation; analyzer: supply source references. | References resolve to fixture source locations; deterministic tests demonstrate traceable claims and explicitly identify unsupported claims. |
| **M5 — Drift Detection** | API: compare Git revisions and connect commit changes to affected symbols and documentation; analyzer: supply revision analysis. | Analyzer fixtures cover changed/deleted source results; disposable Git repositories verify affected documentation is flagged and unrelated documentation is not. |
| **M6 — Backend + Frontend** | Shared: integrate APIs with the dashboard, repository explorer, and documentation viewer, including available source references, drift indicators, and job status. | API validation, contract, and error tests pass; a Playwright flow opens repository content and related documentation and follows a source reference; component tests cover loading, empty, failure, and available drift/status states. |
| **M7 — GitHub + Reliability** | API: GitHub automation, evaluations, and service reliability. Web: integration status and recoverable failures. Analyzer: deterministic analysis checks. Shared: CI, deployment support, and observability. | Verify webhook validation, duplicate side-effect protection, deterministic evaluations, and UI status/failure presentation; configured tests, lint, type, build, browser, and operational checks pass where applicable. |

M1–M5 establish analyzer and API capabilities for the UI; they do not require a
separate frontend implementation per milestone, a graph visualization in M2, or
an investigator UI in M3. M6 delivers usable integration, and M7 adds operational
polish. Introduce service interfaces with their owning capability; add retries
and other infrastructure only when implemented behavior requires them.

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

## Repository migration

Complete local copies of the original repositories, including Git histories, are
retained under the ignored `.migration-backups/` directory. Keep these backups
until they are no longer needed; they are not part of the new repository's history.

Publish and verify the replacement monorepo before deleting the old GitHub
repositories. Preserve any needed issues, pull requests, releases, and settings
separately: local Git backups do not capture that GitHub-specific information.
