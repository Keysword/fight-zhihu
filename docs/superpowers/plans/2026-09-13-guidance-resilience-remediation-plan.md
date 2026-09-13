# 背景板：等待可见、失败可用、结论可收尾 —— 整改方案

> 状态：待执行。基线 HEAD `95ddaf5`，分支 `plan/full-assessment-and-improvement`，工作区干净。
> 本方案针对受控个人试用（2026-09-13 上线，发布版本 `20260913T120254Z`）暴露的三个问题。

**Goal:** 让用户在等待期间知道系统在做什么、在模型输出部分不合规时仍能拿到可用的理解、在事情已经了结时看到收尾而不是又一个"下一步"。

**不改变的前提：** 模型仍然只能提交受约束的 JSON 动作，不获得文件/Shell/任意写入权限；程序仍然只硬校验结构、来源归属、链接、预算、并发与版本冲突，不用自然语言规则认证模型概括是否正确；原材料、用户反馈、模型指导仍然分开存储，模型不能改写用户内容。

---

## 0. 问题定性

三个现象共享同一个根因：**整轮推理被放在一次阻塞式 HTTP 请求里，中间状态既不外传也不落库，且模型输出只有"全部合规"与"整轮作废"两种结局。**

| 现象 | 直接原因 | 代码位置 |
| --- | --- | --- |
| 慢且看不见 | 接口 await 完整 agent 循环才返回；模型调用非流式、无超时、无重试；分步遥测只在结束时一次性落库 | `app/src/routes/api/cases/[id]/guidance/+server.ts:9`、`app/src/lib/server/agent/model-client.ts:89`、`app/src/lib/server/agent/guidance-runtime.ts:151` |
| 一错就只剩报错 | `.strict()` 全有全无校验；引用非法整份否决；修复预算解析与引用共用 1 次；真实案例无兜底 | `app/src/lib/domain/guidance.ts:70`、`app/src/lib/server/agent/guidance-runtime.ts:287`、`:367` |
| 结论已明还在推进 | 数据合同没有终态字段，`nextStep: null` 语义是"这轮没想出来"而非"不需要了"；prompt 要求"只推荐一个下一步"且两个示例都带完整 nextStep；保存反馈后无条件触发下一轮 | `app/src/lib/domain/guidance.ts:70`、`app/src/lib/server/agent/guidance-prompt.ts:12`、`:24`、`app/src/routes/cases/[id]/+page.svelte:151` |

需要澄清一点：agent 循环本身**不会**失控无限跑。合法 `provide_guidance` 会立即结束本轮（`guidance-runtime.ts:397`），且有 5 次模型调用、2 次搜索的硬预算。第三个问题是产品语义缺失，不是循环缺陷。

---

## 1. 阶段与优先级

按"对用户伤害 ÷ 改动量"排序，四个阶段可独立交付、独立回退。

| 阶段 | 内容 | 依赖 | 交付价值 |
| --- | --- | --- | --- |
| A | 模型调用超时、取消与重试 | 无 | 消除 300 秒空转；瞬时抖动不再报废整轮 |
| B | 分层降级校验与引用净化 | 无（与 A 并行） | 部分合规的输出仍然可用 |
| C | 运行进度可见 | A | 等待期间有真实步骤反馈 |
| D | 终态语义与收尾 | B | 事情了结时正确收尾 |

只做一个阶段的话做 A：它同时缓解现象一和现象二，改动最小。

---

## 2. 阶段 A：模型调用超时、取消与重试

### 现状

`model-client.ts` 的 `complete()` 直接 `await fetchImpl(...)`，全仓库除 SQLite `busy_timeout` 外没有任何超时或 `AbortSignal`。上游挂住时请求一路挂到 nginx `proxy_read_timeout 300s`（`deploy/nginx-background-board.conf:21`）。运行时对模型异常只有一次 catch 就判定整轮失败（`guidance-runtime.ts:250-270`）。

### 改动

**A1. `ModelClient` 接口接受调用选项。**

```ts
export interface ModelCallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ModelClient {
	complete(messages: ModelMessage[], options?: ModelCallOptions): Promise<string>;
}
```

两个实现（OpenAI 兼容与 OpenCode）都用 `AbortSignal.any([外部 signal, AbortSignal.timeout(timeoutMs)])` 合成后传给 `fetchImpl`。默认 `timeoutMs` 取 `GUIDANCE_MODEL_TIMEOUT_MS`，缺省 30000。

**A2. 区分可重试与不可重试失败。** 新增 `ModelClientError` 的 `retryable: boolean` 与 `reason: 'timeout' | 'network' | 'http' | 'payload'`：

- `timeout`、`network`、HTTP 429/5xx → `retryable: true`
- HTTP 4xx（除 429）、`payload` 解析失败 → `retryable: false`

判定逻辑写在 model-client，运行时不再靠猜。

**A3. 运行时重试。** `guidance-runtime.ts` 单次模型调用最多重试 2 次（总计 3 次尝试），退避 500ms / 1500ms，加 ±20% 抖动。重试**不计入** `MAX_MODEL_CALLS` 预算——预算约束的是推理步数，不是网络抖动。每次尝试都进 `modelCalls` 遥测，新增 `attempt` 与 `retryReason` 字段。

**A4. 整轮墙钟上限。** 新增 `GUIDANCE_RUN_BUDGET_MS`，缺省 120000。超出后不再发起新的模型调用，走阶段 B 的降级路径产出当前能给的东西；无任何可用内容时返回 `TIME_BUDGET_EXCEEDED`。这是 nginx 300 秒之外的应用层保险。

**A5. OpenCode 会话清理不吞掉取消。** `finally` 里的 `DELETE /session/:id` 要用独立的短超时（5 秒），且父调用被取消时不要因为清理失败而改写错误原因。

### 文件

| 文件 | 操作 |
| --- | --- |
| `app/src/lib/server/agent/model-client.ts` | 加 `ModelCallOptions`、超时合成、错误分类；两个客户端实现同步 |
| `app/src/lib/server/agent/model-client.test.ts` | 加超时触发、可重试分类、取消不被清理覆盖 |
| `app/src/lib/server/agent/guidance-runtime.ts` | 加退避重试、整轮墙钟预算、遥测字段 |
| `app/src/lib/server/agent/guidance-runtime.test.ts` | 加"首次超时二次成功"、"连续超时归类 MODEL_CALL_FAILED"、"墙钟耗尽走降级" |
| `app/.env.example`、`README.md` | 记录两个新环境变量 |

### 验收

- 注入一个永不响应的 fetch，`complete()` 在 `timeoutMs + 2s` 内以 `retryable: true` 的 `timeout` 拒绝。
- 首次超时、第二次成功的夹具下，整轮 `outcome: 'ready'`，`modelCalls` 含两条记录且 `MAX_MODEL_CALLS` 只消耗 1。
- 墙钟耗尽时不再发新调用，返回值符合阶段 B 的降级约定。

---

## 3. 阶段 B：分层降级校验与引用净化

### 现状

`guidanceDraftSchema` 是 `.strict()` + `superRefine`（`guidance.ts:70-114`），任一字段不合规则整个 draft 作废，连带丢掉可能写得很好的 `understanding.summary`。`invalidReferences` 发现一个非法 source id 就否决整份指导（`guidance-runtime.ts:367`）。修复预算 `repairCount === 1` 由解析错误与引用错误共用，"先格式错再引用错"这一常见组合直接判死。失败时 `guidance: null`，真实案例无任何兜底——`fallback.ts` 只服务匿名宿舍演示。

### 设计原则

把 draft 分成两层，**必要层缺失才算失败**：

- 必要层：`understanding.summary`
- 可选层：`understanding.openPoint`、`communicationChecks`、`nextStep`、`question`、`changeSummary`

可选层任一块不合规，丢弃该块并记录，不影响其余内容呈现。这与 README 已声明的"如实提示本轮未完成"一致，比"要么完美要么白屏"对用户有用得多。

### 改动

**B1. 新增 `guidance-salvage.ts`（新文件，严格 schema 保持不动）。**

```ts
export interface SalvageOutcome {
	draft: GuidanceDraft | null;          // 净化后可用的 draft
	completeness: 'full' | 'partial';     // partial 表示丢弃过内容
	dropped: Array<{
		field: 'understanding.openPoint' | 'communicationChecks' | 'nextStep' | 'question' | 'changeSummary';
		reason: 'schema' | 'reference';
		detail: string;
	}>;
}

export function salvageGuidance(
	raw: unknown,
	allowed: { evidence: ReadonlySet<string>; input: ReadonlySet<string>; external: ReadonlySet<string> }
): SalvageOutcome;
```

处理顺序：

1. 先跑完整 `guidanceDraftSchema`。通过则再做引用净化；无非法引用即 `completeness: 'full'`，走原路径。
2. 不通过则逐块解析：`understanding` 用必要层 schema（只要求 `summary`，`sources` 可为空数组）；`communicationChecks` 逐条独立解析，失败的条目单独丢弃；`nextStep`、`question`、`changeSummary` 各自独立解析。
3. `understanding.summary` 拿不到 → `draft: null`，视为真失败。
4. 未知多余字段（`.strict()` 现在会整体拒绝）改为剥离并记入 `dropped`，不再否决。

**B2. 引用净化取代引用否决。** 非法 source id 从数组中剔除而非否决整份：

- `understanding.sources` 剔空可以接受。
- `communicationChecks[i].sources` 剔除后若不再满足"至少一条 evidence 或 input"（`guidance.ts:96-104` 的既有规则），丢弃该条疑点而非整份指导。
- `nextStep.contact.basis === 'case_material'` 且剔除后无本地来源，则把 `contact` 降为 `null`；若 `nextStep.kind === 'contact'`（此时 contact 不可为 null，见 `guidance.ts:80`），整块 `nextStep` 丢弃。

这条不放松安全边界：外部线索仍不能单独支撑对本次沟通的判断，非法引用仍然不会呈现给用户，只是不再连坐。

**B3. 修复预算分开计数。** `repairCount: number` 改为 `repairs: { schema: number; reference: number }`，各自上限 1（保持现有严格度，但不再共用）。`GuidanceRunResult.repairCount` 保留为两者之和，避免破坏既有事件消费方。

**B4. 极简重问兜底。** 严格路径与净化路径都拿不到必要层，且模型调用与墙钟预算都还有余量时，发起一次**极简 prompt**：只要一段"当前理解"文字与一个可选追问，不要 sources、不要疑点、不要下一步。产出物按 `completeness: 'minimal'` 保存，界面明确标注"这一版只整理出了理解"。

**B5. 首轮失败也要有内容。** 无历史快照时，`CaseView` 增加 `fallbackEcho`：回显用户已保存的目标、困惑与材料条数，加一句"你的材料已经保存，本轮没有整理完成"。这不是模型输出，不写入 `guidance_snapshots`，仅用于渲染。

**B6. 快照记录降级信息。** `guidance_snapshots` 加两列：`completeness TEXT NOT NULL DEFAULT 'full'`、`dropped_json TEXT NOT NULL DEFAULT '[]'`。迁移沿用 `db.ts:57-81` 的既有做法——`PRAGMA table_info` 查列是否存在，缺失才 `ALTER TABLE ... ADD COLUMN`，整段在同一个 `BEGIN IMMEDIATE` 事务内。`GuidanceSnapshot` 类型同步扩展。旧行取默认值 `full`，读取兼容。

### 文件

| 文件 | 操作 |
| --- | --- |
| `app/src/lib/server/agent/guidance-salvage.ts` | 新建；分块解析、引用净化、丢弃清单 |
| `app/src/lib/server/agent/guidance-salvage.test.ts` | 新建；每类丢弃、必要层缺失、全合规直通 |
| `app/src/lib/domain/guidance.ts` | 加必要层 schema 与 `completeness`、`dropped` 类型；严格 schema 本身不放松 |
| `app/src/lib/server/agent/guidance-runtime.ts` | 接入 salvage、分开修复预算、极简重问 |
| `app/src/lib/server/db.ts` | 两列幂等迁移 |
| `app/src/lib/server/cases/repository.ts` | 读写新列 |
| `app/src/lib/server/services/case-service.ts` | `CaseView` 增加 `fallbackEcho` |
| `app/src/lib/components/GuidancePanel.svelte` | 渲染 `partial` / `minimal` 标注与"未整理出的部分" |
| 对应 `*.test.ts` | 同步扩展 |

### 验收

- 一条 communicationCheck 引用非法 → 该条消失，understanding 与 nextStep 正常呈现，`completeness: 'partial'`，`dropped` 含一条 `reference` 记录。
- draft 多出一个未知字段 → 字段被剥离，其余内容照常呈现。
- 只有 `understanding.summary` 合法 → 呈现理解，明确标注下一步未形成。
- `understanding.summary` 也拿不到 → 极简重问；仍失败则首轮显示 `fallbackEcho`，非首轮保留上一版并打 `stale`（现有行为，见 `+page.svelte:21`）。
- 先格式错、再引用错 → 各消耗一次修复预算，不再直接判死。

---

## 4. 阶段 C：运行进度可见

### 现状

前端等待期间唯一反馈是按钮文案变成"正在整理…"（`+page.svelte:377`）。运行时其实采集了每步耗时、动作类型、搜索结果数（`guidance-runtime.ts:16-30`），但只在 `finish()` 里一次性写入 `guidance.run.finished`，运行期间没有任何可读数据源。`AgentActivity.svelte` 本该承担这个展示，但它的 `label()` 只识别旧 `agent.*` 事件，`guidance.*` 全部落到兜底文案"案例状态更新"。

### 改动

**C1. 运行时逐步落库进度事件。** 在既有 `appendEvent` 上新增：

- `guidance.run.started`：`{ runId, contextRevision }`
- `guidance.step`：`{ runId, index, phase, detail }`，`phase ∈ 'thinking' | 'searching' | 'repairing' | 'saving'`
- 保留 `guidance.run.finished` 不变（现有消费方与报告依赖它）

事件只记录阶段与计数，不含原始模型回复或完整提示——延续 README 的日志约束。

**C2. 接口拆成启动 + 轮询。** 保留 `POST /api/cases/:id/guidance` 兼容现状（同步返回最终结果），另加：

- `POST /api/cases/:id/guidance/runs` → 立即返回 `{ runId }`，后台执行
- `GET /api/cases/:id/guidance/runs/:runId` → 返回 `{ phase, steps, elapsedMs, done, result? }`

前端默认走新接口，1.5 秒轮询。选轮询而非 SSE 的理由：SQLite + 单进程 + 已有事件表，轮询实现成本低得多，且 nginx 无需额外配置。

**C3. 进程内运行登记表。** `guidance-runtime.ts` 已有 `inFlight` Map（`:136`），扩展为同时保存 `runId → 最新进度`，并在完成后保留 5 分钟供轮询取结果。单进程部署（`127.0.0.1:3210` 单实例）下这样够用；将来多实例再改读事件表。

**C4. 界面显示真实步骤与已耗时。** `AgentActivity.svelte` 的 `label()` 补上 `guidance.*` 分支，文案对应用户能理解的说法："正在理解你的材料""正在检索相似经验""正在重新整理""正在保存这一版"。同时显示已耗时秒数，超过 20 秒追加"比平常久一些，仍在进行"。

**C5. 重试不再烧限流额度。** 现在限流是 10 次 / 10 分钟（`guidance/+server.ts:8`）；用户因看不到进度而反复点击会耗尽额度，然后收到与真实原因无关的 429。轮询接口（`GET`）不计入 `run-guidance` 限流；同一 `contextRevision` 已有在飞运行时，启动接口直接返回既有 `runId` 而不新计一次——`inFlight` 已有这个去重逻辑（`:490-496`），只需在限流前判断。

### 文件

| 文件 | 操作 |
| --- | --- |
| `app/src/lib/server/agent/guidance-runtime.ts` | 逐步 `appendEvent`、进度登记表、`runId` 查询 |
| `app/src/routes/api/cases/[id]/guidance/runs/+server.ts` | 新建；启动运行 |
| `app/src/routes/api/cases/[id]/guidance/runs/[runId]/+server.ts` | 新建；查询进度 |
| `app/src/routes/cases/[id]/+page.svelte` | 改用启动 + 轮询，显示步骤与耗时 |
| `app/src/lib/components/AgentActivity.svelte` | 补 `guidance.*` 文案 |
| `app/src/lib/server/rate-limit.ts` 调用点 | 轮询免限流、在飞去重不重复计数 |
| `app/tests/guidance.spec.ts` | 加"等待期间可见步骤"浏览器断言 |

### 验收

- 脚本模型故意延迟 3 秒，界面在 2 秒内出现"正在理解你的材料"并显示递增耗时。
- 连点 5 次"开始整理"，只产生 1 个 `runId`，限流计数只 +1。
- 轮询接口在运行完成后 5 分钟内仍可取到结果。

---

## 5. 阶段 D：终态语义与收尾

### 现状

`GUIDANCE_CONSTITUTION` 要求"只推荐一个最值得尝试的下一步"（`guidance-prompt.ts:12`），从未授权模型判定事情已经办完。schema 里 `nextStep` 可为 `null`，但没有字段表达"结束"，`null` 只会被读成"这轮没想出来"。两个 few-shot 示例都带完整 `nextStep`（`guidance-prompt.ts:24-28`），模型会照着模仿，等于在诱导它永远给一个动作。`case_inputs` 已有 `kind: 'action_result'`（用户点"我问过了"），但没有任何代码把它当终止信号消费。前端 `saveFeedback` 保存成功后无条件 `void runGuidance('补充', caseId)`（`+page.svelte:151`）。

### 改动

**D1. 数据合同加显式终态。**

```ts
const resolutionSchema = z.object({
	status: z.enum(['open', 'resolved', 'blocked_externally']),
	reason: text.nullable()
}).strict();
```

加入 `guidanceDraftSchema`，默认 `{ status: 'open', reason: null }` 以兼容历史快照。`superRefine` 增加一条：`status !== 'open'` 时 `nextStep` 必须为 `null`——已经收尾就不该再派动作。

- `resolved`：用户目标看起来已达成
- `blocked_externally`：只能等待，当前没有值得做的动作（区别于"没想出来"）

**D2. prompt 授权判定终态并平衡示例。** `GUIDANCE_CONSTITUTION` 增加：目标看起来已达成或当前只能等待时，应给出 `resolution.status` 并把 `nextStep` 设为 `null`，不要为了凑动作而制造动作。同时补一个 `resolved` 的 few-shot 示例，与现有两个"带完整 nextStep"的示例形成平衡。这一条直接对治现象三。

**D3. 用户反馈参与终态判断。** `action_result` 类输入在 prompt 上下文中显式标注"用户报告的行动结果"，并提示：若结果表明目标已达成，应判定 `resolved`。判定权仍在模型，程序不做自然语言规则推断——与既有原则一致。

**D4. 界面收尾态。** `GuidancePanel.svelte` 在 `status !== 'open'` 时不渲染"可以先试这一步"，改为收尾卡片：这件事看起来已经了结（或当前只能等待）、原因、回顾经过、"情况有变可以重新打开"按钮。

**D5. 收尾后不自动触发下一轮。** `+page.svelte` 的 `saveFeedback` 在当前快照 `status !== 'open'` 时，保存输入后**不**自动 `runGuidance`，改为提示"已记录，如需重新整理请点击"。用户显式点击仍然可以运行。

**D6. 案例列表与首页体现终态。** `CaseSummary`（`app/src/lib/domain/types.ts:85`）目前只有案例自身字段，没有指导信息。`cases` 表已有 `current_guidance_id`，因此 `listCases()` 的查询左连接 `guidance_snapshots` 读出当前快照的 `resolution.status` 即可，不需要在 `cases` 上另存冗余列。`CaseSummary` 增加 `resolutionStatus: 'open' | 'resolved' | 'blocked_externally' | null`（`null` 表示还没有任何指导快照）。列表页对已收尾案例显示区别于"进行中"的样式，避免用户回到列表后以为还要继续处理。

### 文件

| 文件 | 操作 |
| --- | --- |
| `app/src/lib/domain/guidance.ts` | 加 `resolutionSchema` 与 `superRefine` 约束 |
| `app/src/lib/server/agent/guidance-prompt.ts` | 授权终态判定、补 `resolved` 示例、标注 `action_result` |
| `app/src/lib/server/agent/guidance-prompt.test.ts` | 断言新指令与示例平衡 |
| `app/src/lib/components/GuidancePanel.svelte` | 收尾卡片 |
| `app/src/routes/cases/[id]/+page.svelte` | 收尾后不自动重跑 |
| `app/src/lib/server/cases/repository.ts`、`app/src/routes/+page.svelte` | 列表终态标记 |
| `app/evals/guidance/cases.json` | 补 2 个应当收尾的场景 |
| `app/tests/guidance.spec.ts` | 加"收尾后不再出现下一步且不自动重跑" |

### 验收

- 脚本模型返回 `resolution.status: 'resolved'` 且 `nextStep: null` → 界面显示收尾卡片，无"可以先试这一步"。
- `status !== 'open'` 且 `nextStep` 非 null → schema 拒绝（防止模型自相矛盾）。
- 收尾态下提交反馈 → 输入保存成功，不自动触发新一轮。
- 历史快照（无 `resolution` 字段）读取后按 `open` 呈现，行为不变。

---

## 6. 环境变量

| 变量 | 缺省 | 用途 |
| --- | --- | --- |
| `GUIDANCE_MODEL_TIMEOUT_MS` | `30000` | 单次模型调用超时 |
| `GUIDANCE_RUN_BUDGET_MS` | `120000` | 整轮墙钟上限 |
| `GUIDANCE_MODEL_MAX_RETRIES` | `2` | 单次调用的额外重试次数 |

三者都要写进 `app/.env.example` 与 README 的环境变量清单。

---

## 7. 验证

每阶段完成后在 `app/` 执行完整门禁：

```bash
pnpm format:check
pnpm lint
pnpm check
pnpm exec vitest run
pnpm exec playwright test
pnpm build
test -f build/index.js
```

浏览器测试延续现有隔离方式：脚本模型夹具（`app/tests/fixtures/guidance-model.mjs`）、独立临时 SQLite 目录、显式清空真实模型与知乎凭据。

**脚本模型只验证工程合同，不能替代真实模型效果评价。** 阶段 B 与 D 改动了模型行为边界，合并前需要用 `app/evals/guidance/cases.json` 的 10 个固定场景（加 D 新增的 2 个）跑一遍真实模型并人工评分。README 已声明的"正式默认切换以完整 10 场景真实模型产品评测为依据"这一条不因本次整改放宽。

---

## 8. 回退

四个阶段都不改变 `BACKGROUND_BOARD_GUIDANCE_V2` 的开关语义，整体回退仍是移除或关闭该开关并重启。

阶段内回退：

- A：三个新环境变量设为极大值可近似恢复旧行为，代码回退无数据影响。
- B：新增两列有默认值，回退代码后旧读取路径仍然可用；已保存的 `partial` 快照会按 `full` 呈现（内容本身合法，只是不再显示降级标注）。
- C：新接口是新增路径，旧同步接口保留可用；前端回退到旧调用即可。
- D：`resolution` 有默认值，回退后历史快照按 `open` 呈现。

数据层只做加列，不改列不删列，任一阶段回退都不需要数据迁移。

---

## 9. 交付顺序建议

A 与 B 可并行（互不触碰同一函数体的关键路径，A 改调用层、B 改校验层），但 B 依赖 A 的墙钟预算来决定何时放弃重问，建议 A 先落。C 依赖 A 的遥测字段。D 独立，可随时插入。

一次提交一个阶段，每个提交都要通过完整门禁。合并前补一份结果报告到 `docs/superpowers/reports/`，如实记录哪些项经过真实模型验证、哪些只有脚本模型覆盖。
