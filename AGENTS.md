# Project guidance

This file provides shared guidance for the ACIP monorepo: `apps/web`, `apps/api`,
and `packages/analyzer`.

Build ACIP ai, an Agentic Codebase Intelligence Platform, using a hybrid TypeScript
and Python architecture. Develop in small, test-driven steps and choose the
simplest implementation that fully meets the current requirement.

TypeScript handles the frontend in `apps/web` and native codebase analysis in
`packages/analyzer`. Python handles APIs, AI agents, orchestration, and background
jobs in `apps/api`. The Next.js dashboard provides a repository explorer and
documentation viewer backed by FastAPI. LangGraph coordinates Investigator,
Documenter, and Verifier agents to navigate code, write
documentation, and check claims using the TypeScript analyzer and stored knowledge.
PostgreSQL with pgvector stores repositories, symbols, relationships, embeddings,
and documentation; Git and GitHub integrations supply repository changes.

## Working approach

Act as a pragmatic software engineering collaborator. Prioritize correctness,
readability, and the simplest design that meets the current requirement.
Question unnecessary complexity, explain meaningful tradeoffs, and verify
assumptions with code and tests.

## Current state and commands

This project currently has an apps/packages layout, documentation, and instructions
only. The stack below is selected, but application scaffolding, dependencies,
workspace tooling, executable checks, and CI are not yet configured. Do not treat
the technology list as evidence that tooling exists.

When scaffolding is added, maintain verified setup, service, migration, build,
analysis, test, lint, and type-check commands in the root
[README command reference](README.md#setup-and-contributing), grouped by component
with working directories and required environment variable names, never secrets.
Discover commands from actual configuration; do not invent them or report unrun
checks as passing.

## Roadmap and component guidance

Use the [canonical M1–M7 roadmap](README.md#milestone-roadmap) for ownership,
deliverables, and completion criteria. All milestones are planned. Implement only
the current requirement; the roadmap does not authorize speculative features or
infrastructure. These root instructions apply to all three component directories.

### API (`apps/api`)

- Own Python/FastAPI endpoints, persistence, agent orchestration, background jobs,
  and Git/GitHub integration. Consume analysis output from `packages/analyzer`;
  keep AST extraction and native relationship analysis in that package.
- Test API validation, response contracts, and async error paths. Verify the
  analyzer/Python contract as implemented; define its schema and transport during
  M1 rather than introducing a speculative interface or service process.
- Add job retries and duplicate side-effect protection where required by actual
  behavior, with deterministic failure and transition tests.

### Web (`apps/web`)

- Build the dashboard, repository explorer, and documentation viewer using the
  API's actual contracts. Keep fixtures consistent with those contracts; do not
  invent endpoints or change response meanings to make the UI work.
- Use semantic HTML, meaningful labels, keyboard navigation, visible focus, and
  appropriate focus management. Preserve shadcn/ui accessibility, readable
  contrast, responsive layouts, and status cues beyond color alone.
- Provide meaningful loading, empty, success, and error states. Distinguish
  unavailable data from a successful empty result; show job progress and recovery
  actions when supported by the API.
- Preserve source references, unsupported-claim indications, and drift status so
  users can assess documentation against the code.
- Treat repository text and generated documentation as untrusted content. Do not
  render unsanitized HTML or unsafe links. Keep backend credentials out of browser
  code and public environment variables, and sensitive content out of telemetry.
- Test interactions, keyboard access, accessible names, and data states with
  deterministic mocked API responses. Use Playwright for repository exploration,
  related documentation, and source-reference navigation as features arrive.

### Analyzer (`packages/analyzer`)

- Own AST extraction, symbols, source locations, and subsequent source relationship
  analysis. Keep the package independent of API and web implementations; do not
  put persistence, agent orchestration, GitHub integration, or UI code here.
- Produce analysis data with source provenance for Python consumers. Define the
  output contract, transport, supported source languages, and initial invocation
  method during M1 implementation. Add no schema framework or build framework
  solely for hypothetical future needs.
- Treat indexed source as data. Do not execute analyzed code or repository scripts.
  Keep credentials and sensitive source content out of logs and committed fixtures.
- Use small local Vitest fixtures to verify public extraction results, source
  positions, supported relationships, and malformed-input handling. Test consumer
  contracts rather than private compiler implementation details.

## Development workflow

1. Understand the requested behavior and inspect the relevant code and tests.
   Clarify ambiguous requirements or consequential design choices; otherwise
   complete routine work autonomously without approval between TDD phases.
2. **Red:** for each behavior change, write a focused test for the next observable
   behavior. Run it and confirm it fails for the intended missing behavior before
   implementing that behavior. Fix environment or unrelated test failures
   separately; they are not evidence of a valid red phase.
3. **Green:** implement the smallest correct solution that satisfies the test and
   requirement. Run the focused test and relevant existing tests.
4. **Refactor:** simplify where useful while preserving behavior. Rerun relevant
   tests and keep them green. Do not manufacture a refactor when none is needed.
5. Repeat in small increments, then run the applicable completion checks.

For bug fixes, add and observe a failing regression test before fixing the bug.
For pure refactors, establish passing coverage of affected behavior before editing;
add characterization tests if needed. Documentation, formatting, and configuration
changes use appropriate validation without artificial failing tests. Minimal test
harness setup may precede the first red phase; do not bundle feature implementation
into that setup.

## Simplicity and test quality

- Prefer readable, direct code, existing project patterns, and existing dependencies.
  Add dependencies only when the current requirement justifies them.
- Avoid speculative abstractions, generic frameworks, premature optimization,
  unrelated cleanup, and features intended only for hypothetical future needs.
- Test observable behavior and public contracts rather than private implementation
  details. Cover meaningful success, boundary, and failure cases for the change.
- Never weaken assertions, skip tests, or change expected behavior merely to make
  code pass. Update expectations only when the requirement actually changes.
- Keep ordinary tests deterministic and independent of live services. Use real
  isolated services for integration tests where their behavior matters.
- Simplicity must preserve required validation, error handling, security, and
  accessibility. Preserve unrelated user changes.

## Selected stack and testing boundaries

- **Frontend and styling:** Next.js, React, TypeScript, Tailwind CSS, and shadcn/ui
  for the dashboard, repository explorer, and documentation viewer; pnpm, ESLint,
  and TypeScript checks.
  Use Vitest with React Testing Library for component behavior. Use Playwright for
  critical browser flows and behavior requiring a running Next.js application.
- **Backend:** Python, FastAPI, Pydantic v2, HTTPX for REST APIs, analysis jobs,
  and service orchestration; uv, Ruff, pytest, and pytest-asyncio.
  Test API validation, response contracts, and error paths, including async behavior
  where relevant.
- **Code analysis (`packages/analyzer`):** TypeScript Compiler API and ts-morph for
  AST parsing, symbol resolution, references, and dependencies; pnpm, ESLint, and
  TypeScript checks. Use Vitest with small local repository fixtures to test
  observable analysis results and malformed-input handling. Test the data contracts
  exchanged between the TypeScript analyzer and Python services.
- **Persistence and retrieval:** PostgreSQL, pgvector, and Alembic for repository
  knowledge, documentation, and semantic code retrieval. Test database-specific
  queries and retrieval against an isolated PostgreSQL database with pgvector, not
  SQLite. Validate migrations on disposable databases; never run test cleanup
  against development or production data.
- **AI orchestration and background jobs:** LangGraph for stateful code investigation
  agents and a dedicated Python worker for repository indexing and long-running
  analysis. Test workflow transitions and job failure/retry behavior as implemented,
  including duplicate execution where side effects require protection. Do not add
  workflow infrastructure or retry mechanisms without a current requirement.
- **LLM and embeddings:** use the OpenAI API for code explanations, documentation
  generation, and code chunk embeddings behind focused interfaces. Use deterministic
  fake adapters for ordinary tests. Keep live API tests explicit, opt-in, and separate
  from the default test suite.
- **Git integration:** Git CLI, GitHub API, and webhooks for commits, repository
  changes, and pull requests. Test Git behavior with disposable local repositories
  and mock GitHub HTTP calls in ordinary tests. Cover webhook validation and duplicate
  delivery handling where side effects require protection.
- **External HTTP:** use HTTPX and mock outbound HTTP at service boundaries in
  ordinary tests. Exercise relevant response and failure handling.
- **Operations:** Docker Compose for local services; GitHub Actions for automated
  checks and deployment workflows as needed; OpenTelemetry and JSON logs for agent
  traces, latency, and tool monitoring. Keep credentials and sensitive repository
  content out of logs, traces, and committed fixtures.

## Definition of done

- The requested behavior is implemented and relevant tests pass, with an observed
  red-to-green cycle for behavior changes and passing checks after any refactor.
- Run the relevant test suites, lint checks, configured type checks, and applicable
  build/browser checks before declaring implementation complete. Expand validation
  when the change affects shared contracts, persistence, or cross-component behavior.
- Review the diff for unnecessary complexity, unrelated changes, accessibility
  regressions, and accidental exposure of secrets or sensitive data.
- Report what changed, exact check commands and their results, and any unresolved
  failures or unrun/blocked checks. If validation is blocked, state the reason and
  do not claim the work is fully verified.
- Keep the root README setup/check commands and affected public-contract
  documentation current.

## Documenting decisions and implementation

When implementing or changing a feature, update the root README to explain:

- **Why:** the problem being solved, why the approach or technology was chosen,
  and meaningful alternatives, tradeoffs, or constraints that informed the choice.
- **How:** how the feature was built, including the main components, data flow,
  important implementation steps, and how it was tested and verified.

Keep explanations concise and grounded in the actual work. Distinguish planned
designs from implemented behavior; do not invent decision history or claim unrun
checks passed. Update these explanations when the implementation or rationale
changes, using the existing README sections rather than adding separate documents
for routine choices.

## Scope and maintenance

Keep active project documentation in the root README and this file. Add separate
component documentation only when implemented features justify it. Keep this
guidance concise and specific to the actual project. Do not introduce
arbitrary coverage percentages, complexity thresholds, additional skills, or global
Codex/model configuration changes as part of this setup.

These instructions guide development; they do not mechanically enforce TDD.
Executable checks and CI enforcement arrive with application scaffolding. After
changing this file, confirm instruction discovery in a fresh Codex session opened
at this folder; report discovery as unverified if unavailable. During the first
feature, verify an actual failing test, passing implementation, and passing tests
after any refactor.
