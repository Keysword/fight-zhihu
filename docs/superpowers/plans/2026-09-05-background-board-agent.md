# Background Board Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a mobile-first Background Board PWA whose stateful general agent autonomously investigates a case, uses constrained tools, searches Zhihu when useful, and writes evidence-linked conclusions back to a persistent board.

**Architecture:** A SvelteKit/Node application serves both the responsive UI and server APIs. Each case is a persistent blackboard in SQLite; an event-triggered general-agent runtime reads the board, chooses tools dynamically through a JSON action protocol, and records its actions without following a fixed workflow. The production process runs under systemd on `127.0.0.1:3210` and Nginx exposes it at `/background-board/`.

**Tech Stack:** SvelteKit 2, Svelte 5, TypeScript, Node 24 `node:sqlite`, Zod, Vitest 5, Playwright, CSS, Zhihu HTTP APIs, OpenAI-compatible chat-completions API.

---

## File map

- `app/src/lib/domain/types.ts`: board, evidence, participant, claim, action and agent event types.
- `app/src/lib/domain/schemas.ts`: Zod validation for persisted and model-produced objects.
- `app/src/lib/domain/demo-case.ts`: fully anonymized dorm case and cached demonstration board.
- `app/src/lib/privacy/redact.ts`: deterministic PII detection and replacement.
- `app/src/lib/server/db.ts`: SQLite connection and schema initialization.
- `app/src/lib/server/cases/repository.ts`: case/evidence/event persistence interface.
- `app/src/lib/server/agent/model-client.ts`: configurable chat-completions client.
- `app/src/lib/server/agent/protocol.ts`: JSON action parsing and validation.
- `app/src/lib/server/agent/prompt.ts`: general-agent constitution and tool descriptions.
- `app/src/lib/server/agent/tools.ts`: constrained blackboard and search tools.
- `app/src/lib/server/agent/runtime.ts`: bounded autonomous tool loop.
- `app/src/lib/server/zhihu/client.ts`: authenticated Zhihu and global search adapter.
- `app/src/lib/server/services/case-service.ts`: API-facing application service.
- `app/src/routes/api/**`: health, demo, case, evidence and agent-run endpoints.
- `app/src/lib/components/**`: responsive board cards and activity presentation.
- `app/src/routes/**`: landing, new-case and case-board pages.
- `app/static/**`: PWA manifest and icon assets.
- `app/tests/**`: unit and browser tests.
- `deploy/background-board.service`: systemd unit.
- `deploy/nginx-background-board.conf`: Nginx location snippet.
- `deploy/deploy.sh`: reproducible release deployment script.

## Task 1: Repository and SvelteKit foundation

**Files:**
- Create: `.gitignore`
- Create: `app/**` from the official Svelte CLI
- Modify: `app/svelte.config.js`
- Modify: `app/package.json`
- Test: `app/src/demo.spec.ts`

- [ ] **Step 1: Initialize version control**

Run:

```bash
git init
git branch -M main
```

Expected: an empty repository on branch `main` without changing existing research files.

- [ ] **Step 2: Scaffold the application and test tools**

Run:

```bash
npx --yes sv create app --template minimal --types ts \
  --add prettier eslint 'vitest=usages:unit' playwright 'sveltekit-adapter=adapter:node' \
  --install pnpm
cd app && pnpm add zod
```

Expected: SvelteKit app with Node adapter, Vitest, Playwright, ESLint and Prettier.

- [ ] **Step 3: Configure the deployment base path**

Set `app/svelte.config.js` to use `adapter-node`, precompression and the fixed base path:

```js
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ precompress: true }),
    paths: { base: '/background-board' }
  }
};

export default config;
```

- [ ] **Step 4: Run foundation checks**

Run:

```bash
cd app
pnpm check
pnpm test:unit -- --run
pnpm build
```

Expected: all commands exit 0 and `app/build/index.js` exists.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: scaffold background board application"
```

## Task 2: Domain contracts and anonymized demo case

**Files:**
- Create: `app/src/lib/domain/types.ts`
- Create: `app/src/lib/domain/schemas.ts`
- Create: `app/src/lib/domain/demo-case.ts`
- Test: `app/src/lib/domain/schemas.test.ts`
- Test: `app/src/lib/domain/demo-case.test.ts`

- [ ] **Step 1: Write failing schema tests**

Tests must prove that a confirmed fact requires at least one evidence ID, an inference requires rationale, and a key completer requires rationale, confidence and uncertainty:

```ts
expect(() => ClaimSchema.parse({ id: 'c1', kind: 'fact', text: '已分房', evidenceIds: [] })).toThrow();
expect(() => ClaimSchema.parse({ id: 'c2', kind: 'inference', text: '人力能协调物业', evidenceIds: [], rationale: '' })).toThrow();
expect(KeyCompleterSchema.parse(validCompleter).confidence).toBe('high');
```

- [ ] **Step 2: Run tests and confirm failure**

Run `cd app && pnpm vitest run src/lib/domain/schemas.test.ts`.

Expected: FAIL because the schemas do not exist.

- [ ] **Step 3: Implement domain types and schemas**

Define these discriminated states and top-level board contract:

```ts
export type ClaimKind = 'fact' | 'statement' | 'inference' | 'unknown' | 'conflict';
export type CaseStage = 'collecting' | 'understanding' | 'waiting' | 'actionable' | 'resolved';
export type Confidence = 'low' | 'medium' | 'high';

export interface BackgroundBoard {
  caseId: string;
  title: string;
  goal: string;
  stage: CaseStage;
  currentBlocker: string;
  claims: Claim[];
  participants: Participant[];
  keyCompleter: KeyCompleter | null;
  nextAction: NextAction | null;
  externalClues: ExternalClue[];
  updatedAt: string;
}
```

Zod schemas must mirror the interfaces exactly and reject unknown keys at model boundaries.

- [ ] **Step 4: Add the dorm demo fixture**

Create anonymized evidence for department contact, guide colleague, HR and property management. The cached board must split admission, accommodation eligibility, room assignment, key handoff and official notification into separate claims. It must identify HR/accommodation management as the most likely key completer without claiming malicious intent.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cd app
pnpm vitest run src/lib/domain
pnpm check
git add src/lib/domain
git commit -m "feat: define evidence-linked background board domain"
```

Expected: tests pass and type checking exits 0.

## Task 3: Privacy redaction

**Files:**
- Create: `app/src/lib/privacy/redact.ts`
- Test: `app/src/lib/privacy/redact.test.ts`

- [ ] **Step 1: Write failing redaction tests**

Cover mainland phone numbers, 18-character identity numbers, email addresses and explicit user-defined replacements:

```ts
expect(redactText('电话 13812345678').redacted).toBe('电话 [手机号]');
expect(redactText('身份证 110101199001011234').redacted).toBe('身份证 [证件号码]');
expect(redactText('邮件 a@example.com').redacted).toBe('邮件 [邮箱]');
expect(redactText('联系赵老师', [{ from: '赵老师', to: '人力老师' }]).redacted).toBe('联系人力老师');
```

- [ ] **Step 2: Confirm failure, implement, then verify**

Implement `redactText(text, replacements)` returning `{ redacted, findings }`. Findings include type, original span and replacement, but API logs must never print original values.

Run `cd app && pnpm vitest run src/lib/privacy/redact.test.ts`.

Expected: all redaction tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/privacy
git commit -m "feat: preview and redact sensitive case material"
```

## Task 4: Persistent blackboard and event log

**Files:**
- Create: `app/src/lib/server/db.ts`
- Create: `app/src/lib/server/cases/repository.ts`
- Test: `app/src/lib/server/cases/repository.test.ts`

- [ ] **Step 1: Write repository contract tests**

Use a temporary SQLite database and prove create/read, evidence append, optimistic board update and ordered event history:

```ts
const repo = createCaseRepository(tempDbPath);
const created = repo.createCase({ title: '宿舍入住', goal: '确认能否入住', confusion: '没有房间信息' });
repo.appendEvidence(created.id, { kind: 'message', content: '以邮件为准' });
repo.appendEvent(created.id, { type: 'agent.action', payload: { tool: 'read_case' } });
expect(repo.getCase(created.id)?.evidence).toHaveLength(1);
expect(repo.listEvents(created.id)[0].type).toBe('agent.action');
```

- [ ] **Step 2: Confirm failure and implement SQLite schema**

Create `cases`, `evidence` and `events` tables. Store board and event payloads as validated JSON. Enable WAL mode, foreign keys and a busy timeout. Use `crypto.randomUUID()` for unguessable case IDs.

- [ ] **Step 3: Implement optimistic board updates**

`saveBoard(caseId, expectedRevision, board)` must increment revision in one transaction and throw `RevisionConflictError` if another update won.

- [ ] **Step 4: Verify and commit**

Run `cd app && pnpm vitest run src/lib/server/cases/repository.test.ts`.

Expected: repository tests pass using isolated temporary files.

```bash
git add app/src/lib/server/db.ts app/src/lib/server/cases
git commit -m "feat: persist stateful agent cases and events"
```

## Task 5: Zhihu search tool

**Files:**
- Create: `app/src/lib/server/zhihu/client.ts`
- Create: `app/src/lib/server/zhihu/types.ts`
- Test: `app/src/lib/server/zhihu/client.test.ts`

- [ ] **Step 1: Write failing HTTP client tests**

Inject a fake `fetch` and assert that search uses the documented endpoint, `Query`/`Count`, Bearer authorization and a seconds-level `X-Request-Timestamp`. Also assert that non-zero `Code`, rate limits and empty results become typed errors or empty arrays without retries.

- [ ] **Step 2: Implement the client**

Expose:

```ts
searchZhihu(query: string, count = 5): Promise<ExternalClue[]>;
searchGlobal(query: string, count = 5): Promise<ExternalClue[]>;
```

Read `ZHIHU_ACCESS_SECRET` only in server code. Strip tracking parameters for display, preserve title, excerpt, author, edit time, authority level and original source type, and label every item as an external clue rather than a fact.

- [ ] **Step 3: Verify and commit**

Run `cd app && pnpm vitest run src/lib/server/zhihu/client.test.ts`.

Expected: tests pass without making live network requests.

```bash
git add app/src/lib/server/zhihu
git commit -m "feat: add constrained Zhihu research tool"
```

## Task 6: General-agent protocol and model client

**Files:**
- Create: `app/src/lib/server/agent/protocol.ts`
- Create: `app/src/lib/server/agent/model-client.ts`
- Create: `app/src/lib/server/agent/prompt.ts`
- Test: `app/src/lib/server/agent/protocol.test.ts`
- Test: `app/src/lib/server/agent/model-client.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Accept only these autonomous actions:

```ts
type AgentAction =
  | { type: 'search_zhihu'; query: string; count: number }
  | { type: 'search_global'; query: string; count: number }
  | { type: 'propose_board_patch'; board: BackgroundBoard; summary: string }
  | { type: 'ask_user'; question: string }
  | { type: 'finish'; summary: string };
```

Reject unknown tools, markdown-only responses, facts without evidence and key completers without rationale.

- [ ] **Step 2: Implement strict JSON extraction**

Parse a direct JSON object or one fenced JSON block, validate with Zod and return a typed protocol error on failure. Never evaluate model output as code.

- [ ] **Step 3: Implement configurable model client**

Use `AGENT_API_URL`, `AGENT_API_KEY` and `AGENT_MODEL`. When only `ZHIHU_ACCESS_SECRET` is present, default to `https://developer.zhihu.com/v1/chat/completions` with model `zhida-agent`. Send only `model`, `messages` and `stream: false` for Zhihu compatibility.

- [ ] **Step 4: Write the agent constitution**

The system prompt must state:

- pursue the user's case goal rather than fill fields in order;
- choose tools and their order autonomously;
- maximize information gain and stop when a useful user action exists;
- never promote external content or inference to fact;
- cite evidence IDs for factual claims;
- distinguish information capability from intent;
- output only the validated action JSON, with a short action summary rather than private reasoning.

- [ ] **Step 5: Verify and commit**

Run `cd app && pnpm vitest run src/lib/server/agent/protocol.test.ts src/lib/server/agent/model-client.test.ts`.

Expected: all tests pass with a mocked model endpoint.

```bash
git add app/src/lib/server/agent
git commit -m "feat: define autonomous background agent protocol"
```

## Task 7: Stateful autonomous runtime and constrained tools

**Files:**
- Create: `app/src/lib/server/agent/tools.ts`
- Create: `app/src/lib/server/agent/runtime.ts`
- Create: `app/src/lib/server/agent/fallback.ts`
- Test: `app/src/lib/server/agent/runtime.test.ts`

- [ ] **Step 1: Write a failing autonomy test**

Use a scripted fake model whose first action searches Zhihu, second action proposes a board, and third action finishes. Assert that the runtime follows the model-selected order, appends tool results to the conversation, records each event and persists the proposed board.

- [ ] **Step 2: Write failing safety tests**

Assert that the runtime rejects unsupported actions, limits a run to six model turns, limits search to two calls, rejects board patches with unsupported facts, and leaves the previous board intact on revision conflict.

- [ ] **Step 3: Implement the agent loop**

`runAgent(caseId)` loads the case, evidence, current board and recent events; calls the model; executes one or more allowed actions; appends action/result events; and stops on `finish`, `ask_user`, limit or error. There is no fixed action order.

- [ ] **Step 4: Implement the constrained tool registry**

Each tool receives a case-scoped capability object rather than raw database access. Search tools receive only the model-generated abstract query. Board writes pass through Zod, evidence checks, intent-language checks and optimistic revision control.

- [ ] **Step 5: Add demonstration fallback**

When model configuration or the remote model is unavailable, only the built-in dorm demo may return its cached board. User-created cases must show an actionable configuration/service error rather than pretending a heuristic result came from the agent.

- [ ] **Step 6: Verify and commit**

Run `cd app && pnpm vitest run src/lib/server/agent/runtime.test.ts`.

Expected: autonomy, limits, safety and fallback tests all pass.

```bash
git add app/src/lib/server/agent
git commit -m "feat: run stateful general agent against case blackboards"
```

## Task 8: Application services and API routes

**Files:**
- Create: `app/src/lib/server/services/case-service.ts`
- Create: `app/src/routes/api/health/+server.ts`
- Create: `app/src/routes/api/demo/+server.ts`
- Create: `app/src/routes/api/cases/+server.ts`
- Create: `app/src/routes/api/cases/[id]/+server.ts`
- Create: `app/src/routes/api/cases/[id]/evidence/+server.ts`
- Create: `app/src/routes/api/cases/[id]/run/+server.ts`
- Test: `app/src/lib/server/services/case-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Cover demo creation, redacted case creation, unknown case IDs, evidence append, agent run response and safe public serialization that omits secrets and internal model messages.

- [ ] **Step 2: Implement the service and routes**

All routes return `{ ok, data }` or `{ ok: false, error: { code, message } }`. Enforce request body limits, reject empty goals/evidence, map typed errors to 400/404/409/429/502, and never return stack traces in production.

- [ ] **Step 3: Add health reporting**

`GET /api/health` returns application version, database readiness and boolean model/Zhihu configuration flags without returning credential values.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cd app
pnpm vitest run src/lib/server/services
pnpm check
git add src/lib/server/services src/routes/api
git commit -m "feat: expose case and agent APIs"
```

## Task 9: Mobile-first product interface

**Files:**
- Modify: `app/src/app.html`
- Create: `app/src/app.css`
- Create: `app/src/lib/components/StageBadge.svelte`
- Create: `app/src/lib/components/EvidenceRail.svelte`
- Create: `app/src/lib/components/ClaimStack.svelte`
- Create: `app/src/lib/components/ParticipantCard.svelte`
- Create: `app/src/lib/components/CompleterCard.svelte`
- Create: `app/src/lib/components/NextActionCard.svelte`
- Create: `app/src/lib/components/ClueShelf.svelte`
- Create: `app/src/lib/components/AgentActivity.svelte`
- Create: `app/src/routes/+layout.svelte`
- Create: `app/src/routes/+page.svelte`
- Create: `app/src/routes/cases/new/+page.svelte`
- Create: `app/src/routes/cases/[id]/+page.ts`
- Create: `app/src/routes/cases/[id]/+page.svelte`
- Test: `app/tests/home.spec.ts`
- Test: `app/tests/demo-case.spec.ts`

- [ ] **Step 1: Write failing browser tests**

The home test must find the product promise, “体验宿舍案例” and “新建一件卡住的事”. The demo test must create the demo, open its board, find the current blocker, key completer rationale, evidence source, copyable help request and agent activity.

- [ ] **Step 2: Build the visual system**

Use a calm “working dossier” aesthetic rather than a generic dashboard: warm neutral canvas, ink-like typography, blue for confirmed information, amber for unknowns, coral for conflicts and green for actionable state. Use CSS custom properties, visible focus rings, reduced-motion support and a single responsive breakpoint.

- [ ] **Step 3: Build the landing and new-case pages**

Keep landing navigation minimal. The new-case page shows goal, confusion, evidence, local redaction preview and explicit confirmation before sending data to the server.

- [ ] **Step 4: Build the three-column board**

Desktop columns are evidence, understanding and action. Mobile order is blocker/action, key completer, claims, evidence and clues. The UI shows agent action summaries, not hidden chain-of-thought.

- [ ] **Step 5: Support case continuation**

Add an evidence composer to the board. After submission, run the same stateful agent session and visually highlight changed claims, blocker and next action.

- [ ] **Step 6: Verify and commit**

Run:

```bash
cd app
pnpm check
pnpm test:e2e -- home.spec.ts demo-case.spec.ts
git add src tests
git commit -m "feat: deliver mobile-first background board experience"
```

## Task 10: PWA, production hardening and full verification

**Files:**
- Create: `app/static/manifest.webmanifest`
- Create: `app/static/icon-192.png`
- Create: `app/static/icon-512.png`
- Create: `app/src/service-worker.ts`
- Modify: `app/src/app.html`
- Test: `app/tests/new-case.spec.ts`

- [ ] **Step 1: Add installable metadata and safe caching**

Cache only hashed static assets and the application shell. Do not cache API responses containing case data. Add theme color, icons and mobile viewport metadata.

- [ ] **Step 2: Add end-to-end new-case coverage**

Test redaction preview, case creation, model-unavailable error, successful mocked agent run, adding a reply and board revision rendering.

- [ ] **Step 3: Run the complete local gate**

Run:

```bash
cd app
pnpm format:check
pnpm lint
pnpm check
pnpm test:unit -- --run
pnpm test:e2e
pnpm build
```

Expected: every command exits 0, no tests are skipped and `build/index.js` exists.

- [ ] **Step 4: Scan for credentials and personal information**

Run:

```bash
git grep -nE 'Bearer [A-Za-z0-9_-]{20,}|ZHIHU_ACCESS_SECRET=.+|AGENT_API_KEY=.+' -- ':!*.md' || true
git grep -nE '雷媛越|赵佳琪|张名芸|谢添羽|010[0-9-]{8,}' -- app || true
```

Expected: no secret values or real-case personal identifiers in application files.

- [ ] **Step 5: Commit**

```bash
git add app
git commit -m "feat: harden installable background board PWA"
```

## Task 11: Reproducible server deployment

**Files:**
- Create: `deploy/background-board.service`
- Create: `deploy/nginx-background-board.conf`
- Create: `deploy/deploy.sh`
- Create: `deploy/README.md`

- [ ] **Step 1: Create the systemd unit**

Run the Node adapter as a dedicated `background-board` system user, with `HOST=127.0.0.1`, `PORT=3210`, trusted proxy headers, `/srv/background-board/data` as writable state and `/etc/background-board.env` as a root-readable environment file. Restart on failure and apply systemd hardening without blocking SQLite writes.

- [ ] **Step 2: Create the Nginx location**

Proxy `/background-board/` to `http://127.0.0.1:3210` while preserving the base path and forwarding trusted protocol/host headers. Set a 2 MiB request limit and a 90-second timeout for agent runs.

- [ ] **Step 3: Create an atomic deployment script**

The script must build locally, upload a timestamped archive to `/srv/background-board/releases`, install production dependencies, switch `/srv/background-board/current` atomically, restart the service, verify local health, test Nginx configuration before reload and retain the previous release for rollback.

- [ ] **Step 4: Deploy without exposing credentials**

Transfer the configured Zhihu secret directly from the local secret store or process input into `/etc/background-board.env` with mode `0600`; never place it in the repository, archive, command output or shell history. Configure the default agent endpoint/model and install the Nginx snippet without altering unrelated locations.

- [ ] **Step 5: Verify production**

Run server-local and public checks:

```bash
curl --fail http://127.0.0.1:3210/background-board/api/health
curl --fail https://projects.wangjian7410.cc/background-board/api/health
curl --fail https://projects.wangjian7410.cc/background-board/
```

Then execute the demo case through the public API, verify an agent event log exists, confirm a Zhihu search returns source links, inspect service/Nginx logs for errors and verify no credential appears in responses.

- [ ] **Step 6: Commit deployment assets**

```bash
git add deploy
git commit -m "ops: deploy background board agent service"
```

## Task 12: Completion audit and handoff

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-05-background-board-agent.md`

- [ ] **Step 1: Document operation and product usage**

README must contain the public URL, architecture summary, local setup, environment variable names without values, test commands, deployment/rollback commands, privacy model and known P1 omissions.

- [ ] **Step 2: Audit every requirement**

Compare the implementation against the approved product-form spec and this plan. Record concrete evidence for the Web/PWA shape, autonomous tool selection, state persistence, evidence-linked board, key completer safety, Zhihu clues, dorm demo, responsive UI, privacy preview, test gates and public deployment.

- [ ] **Step 3: Run final verification**

Repeat the full local gate and public smoke tests from Tasks 10 and 11. Inspect current service status and the latest deployment logs.

- [ ] **Step 4: Mark plan checkboxes and commit**

Update this plan only for steps proven by current outputs, then commit documentation:

```bash
git add README.md docs/superpowers/plans/2026-09-05-background-board-agent.md
git commit -m "docs: complete background board delivery audit"
```

