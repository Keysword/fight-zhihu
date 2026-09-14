# SDK 直连与专用个人 Agent 性能改造执行方案

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `executing-plans` 按任务执行；实施前使用 `using-git-worktrees`，修改行为前使用 `test-driven-development`，交付前使用 `verification-before-completion`。本方案交给另一个 Agent 执行，不要求创建其他任务或子 Agent。复选框用于记录真实进度。

**Goal:** 在新分支中用 SDK 直连模型，完善项目自己的个人事务指导 Agent，通过隔离环境中的真实对照实验定位并降低延迟，同时保留来源校验、反馈适应和知乎检索价值。

**Architecture:** 保留 SvelteKit、SQLite、现有指导协议和业务运行时。增加 `openai` Node SDK 模型适配器，以显式配置切换旧调用链与 SDK；由现有运行时统一负责总预算、有限重试、搜索和保存。知乎作为独立检索工具，不默认串联知乎直答二次生成。

**Tech Stack:** TypeScript、SvelteKit、Node、pnpm、Vitest、Playwright、SQLite、`openai` Node SDK、知乎 HTTP 搜索 API。

---

## 0. 执行范围与交接约定

用户要求：**新开分支，使用 SDK，完善个人 Agent，并实际测试。** 本次交付是方案；执行 Agent 负责实现、测试、记录结果和提交。不要把交付变成只写建议或只更换环境变量。

“个人 Agent”指本项目处理个人事务的业务 Agent，即 `guidance-runtime.ts`；不要求再部署一个通用编程 Agent，也不要求训练模型。

执行范围包含：

1. 新建隔离 worktree 和 `codex/sdk-personal-agent-latency` 分支。
2. SDK 真正承载模型请求，保留现有调用链作为对照和回退。
3. 补充模型调用观测、总预算、搜索限时、取消旧运行、上下文去重。
4. 使用固定合成案例开展协议测试、业务回归和真实模型性能/质量对照。
5. 交付可复现命令、匿名测量数据、质量评分与明确的上线建议。

默认不部署、不重启线上服务、不修改线上模型配置、不写生产案例、不购买新模型服务。用户已经要求测试，可以使用已配置且可用于本项目的服务进行有界合成测试；若缺少直连 URL、模型 ID 或凭证，仅请求缺失项，继续完成不依赖它们的实施与测试。不要将 OpenCode Basic 密码当作模型 API Key，不要猜测 `tome/` 前缀后的模型 ID 必然可用于直连。

测试最多预设 150 次**实际模型请求**和 30 次**真实搜索请求**，包含预热、重试与修复；没有用户新增授权不得扩大。达到上限立即记录未完成部分。默认只测已有模型，不购买候选模型。必须支持更低的执行上限。

## 1. 已确认基线与尚待验证的假设

方案编写时：

- 仓库：`/home/wangjian/项目/Fight zhihu`。
- 当前分支：`plan/full-assessment-and-improvement`。
- 当前提交：`0217d2a25301bd559340fc60271ed21f8ad7d9ce`。
- 2026-09-13 线上 release：`20260913T145715Z`；新版指导已启用。
- 线上通过 OpenCode 调用；读取到的服务配置模型为 `tome/deepseek-v4-flash`。
- 最近一条完成记录：总耗时 174076 ms，第一次模型调用 90017 ms 超时，第二次 83633 ms 成功；搜索 0、修复 0。
- 同日另有单次成功 13431、14482、49415 ms；旧版本有两次约 300754 ms 的失败。
- 现有模型计时包含中间服务和模型，不能据此断言 OpenCode 或模型单独占多少。
- 新版默认单次 90000 ms、整轮 240000 ms、最多额外重试 2 次。`app/.env.example` 仍将整轮默认写为 120000，存在文档漂移。
- 知乎搜索当前没有显式 AbortSignal；前端进度轮询周期 1500 ms，并非流式正文。

实施时先重新核对提交与配置；线上读数是历史证据，不是部署状态保证。不要重复读取生产内容来构造测试集。

待检验假设：

| 假设 | 验证方法 | 不能据此推导的结论 |
| --- | --- | --- |
| SDK 直连减少中间服务开销 | 同供应商、同模型、同参数、同 prompt 的交错对照 | 换了供应商/模型后不能归因于 SDK |
| 长超时后的同路径重试放大等待 | 统计每次 attempt 和整轮耗时；模拟超时 | 更快失败不代表更快成功 |
| 专用预算和检索策略降低尾部等待 | 同 SDK 下比较策略关闭/开启 | 取消搜索不能损害明确要求检索的任务 |
| 上下文冗余影响长对话 | 记录去重前后字符数与长历史案例质量 | 不能任意删掉用户约束换速度 |

## 2. 成功标准

### 必须通过的工程与质量门禁

- 新分支中完成 SDK 接入，实测确认没有 SDK 内部重试叠加。
- 所有原有单元测试、类型检查、lint、构建、legacy/guided E2E 通过。
- 超时、搜索、取消均受同一个整轮截止时间控制；默认 fast 策略 60000 ms，测试夹具容差不超过 1000 ms。
- 同一 revision 重复启动复用现有运行；新版输入取消旧运行，旧结果不得覆盖新版。
- 不展示未校验 JSON；非法来源不能因为提速被接纳。
- 固定案例中严重误导为 0；首次/最终协议通过率、成功率和质量得分均报告，不能只筛成功样本。

### 性能目标（待实验验证，不能承诺达成）

- 普通无搜索案例：成功响应 p50 ≤ 30 秒，成功响应 p95 ≤ 60 秒。
- fast 策略所有运行均在 60 秒预算附近明确结束；失败与取消单独计数。
- 相对于同批基线，端到端 p50 目标下降 ≥ 30%；质量平均分下降不得超过 0.2/2，配对成功率下降不得超过 5 个百分点。
- 样本少时 p95 仅作探索性统计，报告样本量，不作稳定 SLA 承诺。
- 任何一项未达到：交付已完成的实现和完整失败数据，明确“未通过上线门禁”。不得改低门槛、延长预算或隐藏失败来宣称完成优化。

## 3. 配置与接口决策

### 配置

新增配置由专门的策略模块解析、校验，并在 `.env.example` 中说明：

```dotenv
# 未设置时沿用旧路由与旧预算，不能因代码发布自动切换线上。
AGENT_TRANSPORT=legacy
# sdk 时必填；base URL 示例形态是 https://provider.example/v1。
AGENT_SDK_BASE_URL=
AGENT_API_KEY=
AGENT_MODEL=
AGENT_SDK_STREAM=0

# legacy | fast；仅 fast 使用下面的默认值。
GUIDANCE_POLICY=legacy
GUIDANCE_RUN_BUDGET_MS=60000
GUIDANCE_MODEL_TIMEOUT_MS=40000
GUIDANCE_MODEL_MAX_RETRIES=1
GUIDANCE_SEARCH_TIMEOUT_MS=8000
GUIDANCE_MAX_SEARCHES=1
GUIDANCE_MAX_MODEL_STEPS=3
```

上面的 60/40 秒值是 **fast 示例**；实际 `.env.example` 必须分别列清 legacy 默认 240/90 秒与 fast 默认 60/40 秒，不能把 fast 参数当作全局默认填进旧部署。显式环境覆盖必须是合法数值；非法值在 fast/sdk 配置下报明确配置错误，禁止静默回退到更慢路由。

保留 `AGENT_API_URL` 的旧完整 `/chat/completions` URL 语义；新增 `AGENT_SDK_BASE_URL` 避免 base URL 混淆。SDK 仅在 `AGENT_TRANSPORT=sdk` 时选用；`legacy` 完全保留原优先级和知乎直答后备逻辑。SDK 配置缺失不得自动转入知乎直答。

第一轮不强行开启供应商特定 `reasoning_effort`、JSON schema 或输出长度参数。先确认模型端点实际支持情况，再显式记录并开展独立对照。禁止用 `as any` 绕过不支持的请求字段。

### 模型接口

保持 `ModelClient.complete()` 返回 `Promise<string>`，避免重写所有协议与测试。将以下可选观测扩展合入已有类型：

```ts
export interface ModelObservation {
  transport: 'legacy-http' | 'opencode' | 'sdk';
  durationMs: number;
  firstContentMs: number | null;
  inputCharacters: number;
  outputCharacters: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  finishReason: string | null;
  sessionCreateMs?: number;
  sessionCleanupMs?: number;
}

export interface ModelCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onObservation?: (observation: ModelObservation) => void;
}
```

`firstContentMs` 只表示首个非空正文 delta，不把响应头、role delta 或推理内容算成正文；非流式无法观测时填 null。缺失 token 用量填 null，不能填 0。观测回调异常不得让已成功请求失败。失败尝试也记录已知耗时、输出字符数和已观测值。

## 4. 文件地图

下表路径均相对新 worktree 根目录；既有文件必须先阅读，避免重复实现。

| 文件 | 操作与职责 |
| --- | --- |
| `app/package.json`、`app/pnpm-lock.yaml` | 安装并锁定 `openai` 依赖 |
| `app/src/lib/server/agent/model-client.ts` | 保留公共接口、旧路由与错误分类，增加观测字段 |
| `app/src/lib/server/agent/sdk-model-client.ts` | 新建 SDK 适配器 |
| `app/src/lib/server/agent/sdk-model-client.test.ts` | 新建可控 fetch/流式夹具测试 |
| `app/src/lib/server/agent/model-client.test.ts` | 回归旧路由及 OpenCode 分段计时 |
| `app/src/lib/server/agent/guidance-policy.ts`、对应 `.test.ts` | 新建策略解析、预算与重试规则 |
| `app/src/lib/server/app-context.ts`、对应 `.test.ts` | 显式选择 SDK 与策略；注入共享依赖 |
| `app/src/lib/server/agent/guidance-runtime.ts`、对应 `.test.ts` | 总截止时间、观测、搜索次数、取消调度 |
| `app/src/lib/server/agent/guidance-prompt.ts`、对应 `.test.ts` | 检索原则与上下文确定性去重 |
| `app/src/lib/server/zhihu/client.ts`、对应 `.test.ts` | 搜索 signal、timeout，保持来源处理 |
| `app/src/lib/server/agent/search-cache.ts`、对应 `.test.ts` | 新建单案例内有界短期缓存 |
| `app/src/lib/server/services/case-service.ts`、对应 `.test.ts` | 将排队/取消结果适配到现有服务接口 |
| `app/src/routes/cases/[id]/+page.svelte` | 取消/过期运行提示，保留现有进度展示 |
| `app/tests/fixtures/guidance-model.mjs`、`app/tests/guidance.spec.ts` | SDK HTTP/SSE 夹具和反馈/取消交互回归 |
| `app/evals/guidance/latency.test.ts` | 新建显式启用的真实评测入口，Vitest 路径别名复用现有环境 |
| `app/evals/guidance/latency-cases.json` | 新建六个最小合成性能场景 |
| `app/evals/guidance/README.md` | 评测命令、计数上限、评分办法 |
| `app/.env.example`、`README.md`、`deploy/README.md` | 配置、回退、真实限制 |
| `docs/superpowers/reports/2026-09-13-sdk-personal-agent-results.md` | 最终实验与实施报告 |
| `docs/superpowers/reports/data/sdk-personal-agent/` | 匿名 JSONL、汇总 JSON、合成输出和评分 |

## Task 1：建立分支与基线

- [x] 阅读根目录及父目录适用的 `AGENTS.md`；运行 `git status --short`，记录 HEAD。不要 stash、覆盖或提交他人修改。
- [x] 如果实施起点已不同于上述 HEAD，先检查新的模型/runtime/测试改动，更新本方案中的兼容判断并记录差异；不要倒退丢弃用户新改动。
- [x] 当前分支若尚未包含本方案文件，先将本方案复制到新 worktree 对应路径。下列命令创建分支，分支已存在时先检查其状态，禁止强制覆盖：

```bash
cd '/home/wangjian/项目/Fight zhihu'
git worktree add -b codex/sdk-personal-agent-latency ../Fight-zhihu-sdk-latency HEAD
cd '/home/wangjian/项目/Fight-zhihu-sdk-latency/app'
pnpm install --frozen-lockfile
pnpm check
pnpm test:unit -- --run
pnpm build
pnpm exec playwright test
```

- [x] 记录命令、实际测试数及失败；区分基线已有失败与新引入失败。
- [x] 创建实施报告，填入开始时 HEAD、工具版本、任务状态与尚缺的直连配置。配置只记录非敏感标识；不输出密钥或完整配置文件。
- [x] 提交基线报告和方案：`docs: record SDK latency implementation baseline`。

## Task 2：SDK 适配器与可回退配置

- [x] 核对 SDK 官方 README/API 和当前 Node 兼容性。已核对官方 README 明确 SDK 默认存在自动重试与长默认超时；本项目必须覆盖，不能依赖默认值。
- [x] 安装 SDK：在新 worktree 的 `app` 中运行 `pnpm add --save-exact openai`，记录解析到的确切版本，提交 lockfile；只安装这一个必需 SDK，不顺便升级其他依赖。
- [x] 在 `sdk-model-client.test.ts` 写以下请求契约测试，先确认因适配器不存在而失败。此测试可直接使用：

```ts
import { expect, it, vi } from 'vitest';
import { createSdkModelClient } from './sdk-model-client';

it('uses the SDK base URL and performs no hidden retry', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
    JSON.stringify({ error: { message: 'busy', type: 'server_error' } }),
    { status: 503, headers: { 'content-type': 'application/json' } }
  ));
  const client = createSdkModelClient({
    baseURL: 'https://unit.invalid/v1', apiKey: 'test-key', model: 'test-model',
    stream: false
  }, { fetchImpl });
  await expect(client.complete([{ role: 'user', content: 'test' }]))
    .rejects.toMatchObject({ reason: 'http', status: 503 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
```

- [x] 实现适配器。构造与调用的核心必须符合下列代码；在同一文件补齐数据消费和错误映射，不改变 SDK 请求为手写 fetch：

```ts
import OpenAI from 'openai';

export interface SdkConfiguration {
  baseURL: string;
  apiKey: string;
  model: string;
  stream: boolean;
}

// 放在 createSdkModelClient(configuration, options) 内。
const sdk = new OpenAI({
  baseURL: configuration.baseURL,
  apiKey: configuration.apiKey,
  maxRetries: 0,
  timeout: 40_000,
  fetch: options.fetchImpl
});

// 放在 complete(messages, callOptions) 内。
const timeoutMs = callOptions?.timeoutMs ?? 40_000;
const deadline = AbortSignal.timeout(timeoutMs);
const signal = callOptions?.signal
  ? AbortSignal.any([callOptions.signal, deadline]) : deadline;
const response = await sdk.chat.completions.create({
  model: configuration.model,
  messages,
  stream: false
}, { signal, timeout: timeoutMs, maxRetries: 0 });
```

- [x] 非流式读取 `choices[0].message.content`；空值、空字符串、非法 payload 归类为 payload 失败。`finish_reason=length` 不作为完整答案交给保存阶段。
- [x] 实现独立的 `stream:true` 分支，`for await` 拼接 `choices[0]?.delta.content`，记录首个非空正文时间；正文仅在流完成后交给原协议校验。暂不向页面输出半成品，不默认发送 `stream_options` 等兼容性未验证字段。
- [x] 错误映射顺序：上级 signal 已取消 → cancelled；自身 deadline 已触发或 SDK timeout → timeout；SDK HTTP error → http 与 status；连接失败 → network；其余协议/正文错误 → payload。不得把所有 `DOMException` 一概归为 timeout。
- [x] 增加测试：正确 URL 为 `/v1/chat/completions`、Bearer 头、正常正文、空正文、401 无重试、429/503 无 SDK 重试、网络异常、主动取消、读 body 时超时、流中断、空 delta 不计首字、截断正文不保存、观测回调失败不影响成功结果。
- [x] 在 `app-context.ts` 接入 `AGENT_TRANSPORT`；配置选择测试覆盖 sdk 明确启用、legacy 不变、错误配置直接报错、SDK 不偷偷使用知乎直答。
- [x] 验证与提交：

```bash
pnpm exec vitest run src/lib/server/agent/sdk-model-client.test.ts src/lib/server/agent/model-client.test.ts src/lib/server/app-context.test.ts
pnpm check
git add src/lib/server/agent src/lib/server/app-context.ts src/lib/server/app-context.test.ts package.json pnpm-lock.yaml
git commit -m 'feat: add explicit SDK model transport'
```

## Task 3：可归因观测与 SDK 同模型对照

- [x] 每条 `modelCalls` 保留原有 index、attempt、durationMs、ok、parsed，增加 transport、字符数、firstContentMs、token 用量和 finishReason。旧事件缺字段仍可读。
- [x] OpenCode 分别计时会话创建和清理；总调用计时仍包含两者。不要修改服务端默认模型来做实验；如果无法得知底层供应商参数，报告“路径对照，存在配置混杂”，不声称纯 SDK 收益。
- [x] `guidance.run.finished` 增加 `requestedAt/queueMs` 或等价计时字段，区分排队与 execute 时间。保留逐 attempt 数据，修正报告中“一个 reasoning step = 一次请求”的误读。
- [x] 以假的单调时钟和分块流验证：第二个 chunk 才有正文时 firstContentMs 正确；失败样本有记录；一次运行只产生一条 finished；观测数据不包含 prompt、密钥、完整模型输出。
- [x] 新建真实评测入口。默认 `GUIDANCE_REAL_EVAL !== '1'` 时整个 suite 使用 `describe.skip`；通过共享模型工厂和真实 runtime 构造 isolated repository，不能另写一套绕过业务校验的伪应用。
- [x] 先跑 2 次非流式兼容性 smoke（双通道均提交合法指导。注意：用户提供的两个 key 实测与预期相反——key1 对该模型 401 过期，key2 有效；模型名区分大小写，有效 id 为 `Deepseek-v4-flash`），分别确认 SDK 与旧路径都能提交合法指导。再按第 9 节实验 A 执行传输对照，记录结果；此时禁止顺便调整 prompt、模型或搜索策略。
- [x] 如果直连权限不可用，写明缺少的 URL/model/key，完成全部 mock 测试并继续 Task 4–7；真实对照保持未完成状态。
- [x] 提交：`feat: measure model transport and run latency`。

## Task 4：专用 Agent 总预算与重试策略

- [x] 创建 `guidance-policy.ts`，导出 `resolveGuidancePolicy(values)`，返回 mode、runBudgetMs、modelTimeoutMs、maxModelRetries、searchTimeoutMs、maxSearches、maxModelSteps。legacy 保留旧行为，fast 使用第 3 节默认值。
- [x] 导出并单测重试判断，逻辑固定为：

```ts
import { ModelClientError } from './model-client';

export function canRetryFast(
  error: unknown, attemptMs: number, remainingMs: number,
  retriesUsed: number, maxRetries: number
): boolean {
  if (!(error instanceof ModelClientError)) return false;
  if (retriesUsed >= maxRetries || remainingMs < 10_000 || attemptMs > 3_000) return false;
  return error.reason === 'network' ||
    (error.reason === 'http' && error.status !== null && error.status >= 500);
}
```

- [x] 在 fast 模式测试：timeout 不重试；cancelled 不重试；401/429 不盲目重试；快速 network/503 最多重试一次；不足 10 秒不重试。延迟退避固定 200 ms，并受剩余预算控制。legacy 保留原重试契约。
- [x] 每次执行创建总 `AbortController` 与截止定时器，在 finally 清除；组合调用方取消和单次超时；模型、搜索和退避都收到有效 signal。预算从执行开始计算，排队另计并受调度任务约束。
- [x] fast 的三步是**逻辑决策上限**，真实请求数另外记录并受评测全局计数器限制。搜索耗用一步后，下一步仍可提交；搜索超限返回工具错误要求直接指导，不循环检索。
- [x] 修复策略保留原有 schema/reference 安全规则；剩余时间不足时优先调用已有 salvage 函数，只保存其判定为可用的草稿。不得自行放宽事实、引用或联系人职责校验。无法安全 salvage 就明确失败。
- [x] 测试模型永不返回、搜索永不返回、重试耗尽、超时后的迟到结果不能写入、salvage 安全失败。使用假计时器/可注入等待，不让单测真实等一分钟。
- [x] 运行 runtime、policy、salvage、protocol 测试与类型检查，通过后提交 `feat: bound personal agent execution and retries`。

## Task 5：知乎检索平衡与有界缓存

- [x] 在搜索接口增加可选第三参数，旧调用仍兼容：

```ts
export interface SearchCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
// ZhihuClient 中两个方法都增加 options?: SearchCallOptions。
// search() 内取 options.timeoutMs 默认值，并将 signal 传到 GET 和 body 消费阶段。
const deadline = AbortSignal.timeout(callOptions?.timeoutMs ?? 8_000);
const signal = callOptions?.signal
  ? AbortSignal.any([callOptions.signal, deadline]) : deadline;
```

- [x] SDK 与检索共享整轮取消；搜索本身超时可返回 `SEARCH_UNAVAILABLE` 让模型继续，整轮取消则立即停止。保留 429 分类，不在搜索工具内部额外自动重试。
- [x] 修改提示词，追加以下规则；不得在上下文含“知乎”两个字时就强制搜索：

```text
解释用户已有材料、改写联系话术、回答上一轮追问，通常不需要外部检索。
当外部经验可能改变可尝试入口，或用户明确要求查找知乎/外部经验时，才请求搜索。
用户明确要求检索时应尝试检索；检索失败必须说明未获取外部结果，不得声称已经查证。
检索结果只启发行动，不证明本单位职责或本案例事实。工具提示本轮不可继续搜索后，请提交指导或一个必要追问。
```

- [x] fast 默认一次搜索，返回 3 条摘要；用户明确检索场景放入回归集，确认没有被一刀切禁用。知乎与全网不默认同时调用。
- [x] 实现 `search-cache.ts`：每个 runtime 实例中按 caseId 隔离，key 包含来源、脱敏 query、count；TTL 5 分钟，每个案例最多 20 项，最多 100 个案例，淘汰最旧项。缓存不落盘，失败/超时不缓存，不跨用户复用。
- [x] 缓存命中仍在本轮 gatheredClues 注册同一来源并通过原引用校验；记录 `cacheHit`，将实际请求数与逻辑搜索数分开。评测 A/B 禁用缓存以便公平比较；另测缓存收益。
- [x] 测试：超时不中断已保存输入、429 不循环、整轮取消、搜索词脱敏、同 case 命中、不同 case 隔离、过期重新请求、失败不缓存、缓存来源在本轮可引用。
- [x] 运行 zhihu、cache、prompt、runtime 测试，通过后提交 `feat: bound and reuse contextual searches`。

## Task 6：新版输入取消旧运行与上下文去重

- [x] 先写调度反例：revision 1 的 model promise 保持未完成；输入新增到 revision 2 后启动运行；断言旧 signal 被取消，新版无需等旧模型自然完成，旧结果即使迟到也不能成为当前指导。
- [x] 扩展 `CaseFlightState` 保存 active controller；同 revision 复用，较新 revision 取消旧 controller。取消后新运行启动前完成旧运行的本地终态结算，但不得等待长时间远端 session 清理。OpenCode 清理改成有界后台 best effort，并单独观测。
- [x] 用单调 generation/runId 校验清理所有权，防止旧 promise finally 删除新状态；以 repository 的 contextRevision 校验作为最后写入保护，不能只靠前端。
- [x] 复用现有 `superseded` outcome 表示新版替代，不虚构成功；在进度和 UI 中显示“已由更新后的整理替代”。若运行尚未进入 execute，也应能查询 queued/取消状态，不能返回 runId 后立即 404。
- [x] 不新增用户主动取消按钮，本轮只实现新输入替代旧输入；避免同时扩大交互范围。
- [x] 上下文只做确定性去重：latestGuidance 已出现于 referencedGuidance 时只传一次；按 input.id 去重，移除模型不需要的 requestId/createdAt 等传输字段。保留原始用户正文、限制、纠正、deadline、来源 ID 和引用关系。
- [x] 不引入额外“总结历史”的模型调用，不按字符串长度硬截断正文。超过既有上下文上限仍明确报错；后续压缩不纳入本轮必需交付。
- [x] 测试：相同 revision 去重、连续三次新输入只保留最后有效运行、旧 run finished 恰好一次、迟到旧输出不覆盖、保留联系人限制与历史引用、重复指导删除前后来源可用。
- [x] 运行 runtime/service/prompt 单测与 guided E2E，通过后提交 `feat: supersede stale guidance and deduplicate context`。

## Task 7：完整回归与隔离验收

- [x] 扩展本地模型夹具支持 SDK 路径和 SSE：至少覆盖正常正文、先空 delta 后正文、延迟响应、超时、503、非法来源；不使用真实服务做 E2E。
- [x] 保留 legacy/guided 两套原有项目；增加 SDK 环境组合的执行方式，测试数据目录每次 `mkdtemp`，只清理当前执行拥有的目录。不要复用 `app/data`。
- [x] guided E2E 验证：首次整理；补充输入后新指导；失败后材料保留；同 revision 多次请求不重复推理；新版替代旧版；搜索失败后明确状态；最终内容无原始 JSON 泄漏。
- [x] 完成一次全门禁；后续只有修复新增问题才重复相关检查：

```bash
pnpm format:check
pnpm lint
pnpm check
pnpm test:unit -- --run
pnpm build
pnpm exec playwright test
```

- [x] 确认运行 `pnpm test:unit -- --run` 不会自动访问真实模型。评测入口必须 opt-in，真实凭证缺失不能影响普通测试。
- [x] 提交：`test: cover SDK personal agent workflows`。

## 8. 评测入口必须实现的契约

给 `app/package.json` 增加：

```json
"eval:guidance:latency": "vitest run evals/guidance/latency.test.ts --maxWorkers=1"
```

如果现有 Vitest include 不覆盖 evals 路径，增加独立 eval 配置并在该命令指定 `--config`，复用 SvelteKit alias；禁止因此让真实评测进入默认单测。

运行方式（环境凭证事先通过 shell 环境或权限 0600 的 gitignored 配置注入，不能出现在命令参数或报告中）：

```bash
cd '/home/wangjian/项目/Fight-zhihu-sdk-latency/app'
GUIDANCE_REAL_EVAL=1 GUIDANCE_EVAL_PHASE=transport GUIDANCE_EVAL_MAX_REQUESTS=60 pnpm eval:guidance:latency
GUIDANCE_REAL_EVAL=1 GUIDANCE_EVAL_PHASE=policy GUIDANCE_EVAL_MAX_REQUESTS=60 pnpm eval:guidance:latency
GUIDANCE_REAL_EVAL=1 GUIDANCE_EVAL_PHASE=search GUIDANCE_EVAL_MAX_REQUESTS=30 pnpm eval:guidance:latency
```

三个阶段的上限合计 150，程序在独立评测会话 ledger 中累计；重新执行必须读旧 ledger，不能重置计数绕过限额。独立 smoke/预热也计入。真实搜索另有 30 次总上限。

评测进程在模型 SDK/legacy 的实际出站请求边界计数，而不是只数 reasoning step；OpenCode 的建/删 session 不算模型请求，但 message 请求要计数。计数前检查全局剩余预算，失败也计入。

单条结果至少包含：

```ts
interface EvaluationRow {
  sampleId: string;
  phase: 'smoke' | 'transport' | 'policy' | 'search';
  arm: string;
  caseId: string;
  repeat: number;
  commit: string;
  sdkVersion: string;
  modelLabel: string;
  promptHash: string;
  configurationHash: string; // 只 hash 非敏感配置，不 hash 密钥。
  outcome: string;
  totalMs: number;
  queueMs: number;
  modelAttempts: number;
  logicalSteps: number;
  searchRequests: number;
  searchCacheHits: number;
  repairCount: number;
  firstContentMs: number | null;
  errorCode: string | null;
}
```

结果逐行 append JSONL，确保中途退出前已完成样本不丢失。存储完整逐 attempt 元数据。合成测试的输出可存匿名文件作质量评分；禁止保存生产案例、prompt 中凭证、原始 provider 错误 body。

## 9. 实验设计与质量评审

### 实验 A：仅比较调用链

固定六种合成输入：

1. 材料不足：只知道“已经帮你申请”，应保留未落实的不确定性。
2. 材料充分：房间、时间、领取地点明确，不能凭空增加怀疑。
3. 用户补充：已联系过对接人，不能重复推荐同一个无效动作。
4. 否定/条件：出现“尚未批准”“如果审批通过”，不能当作已落实。
5. 长历史：20 条合成输入，最早的“不能直接联系物业”限制仍有效。
6. 需要追问：存在两个不同目标，追问应具体，不能编造机构职责。

将确切文本固定写入 `latency-cases.json`；生成后不能按模型输出临时修改评分标准。优先从现有 `cases.json` 选取或派生，并记录映射。

- 每种输入 3 次，每臂 18 次；A1=OpenCode+legacy策略，A2=SDK非流式+legacy策略。
- 使用同一供应商、模型与可核实参数；若无法一致则明确标记混杂。预热各一次并记录，不纳入主统计。
- 交错 A1/A2、下一组 A2/A1；串行执行，避免并发抢占影响归因。
- 使用相同初始消息；本阶段以相同冻结 prompt 的单次模型请求对照为主，返回内容仍跑真实 parse/validation 并报告是否通过。不得用不同上下文的多轮总时间冒充纯传输对照。
- 第一轮结果统计完成后再决定是否启用流式兼容性 smoke；流式开启不能与非流式样本混为同一臂。

### 实验 B：专用 Agent 策略对照

- 使用同一 SDK、模型、流式设置，B1=legacy策略，B2=fast策略。
- 六场景各两次，每臂 12 个端到端运行；包含创建案例、两轮反馈场景，实际模型请求共享上限。
- 独立数据库，相同合成输入；缓存关闭。
- 总请求数接近上限时停止新增运行，写明不完整样本；不丢弃失败，不以无答案超时当“快速成功”。

### 实验 C：知乎和取消

- 真实知乎小样本：明确要求知乎经验 3 次、普通材料解释 3 次；确认检索触发/非必要搜索率，失败如实报告。
- 同案例重复查询单测验证缓存命中；若真实测试缓存，冷/热样本分开统计。
- 限流、永久挂起、旧运行取消、迟到结果，使用夹具验证；不人为压测公共接口。

### 评分

按现有 `app/evals/guidance/cases.json` 五维度各 0–2 分：梳理、启发、沟通判断、可执行性、反馈适应。不适用维度标为 N/A 并说明分母。先隐藏 arm/model 名称再评分，最后解盲。

严重误导清单：把申请写成获批；丢掉否定/条件；伪造或错配来源；把经验角色写成本单位确定职责；重复用户明确不可行的动作；未搜索却声称已检索。逐案例附判断理由，自动评分不能代替业务核查。

至少报告：所有请求的结果分布、成功率、失败率、超时率、取消数、首次协议通过率、修复次数；成功样本 p50/p95；全部样本耗时；逐 attempt 延迟；搜索冷/热耗时。取消样本不并入普通成功率，单独报告。

不得从一次抽样推出“模型永远快/慢”。性能目标不满足时，优先说明哪一层仍耗时；候选模型测试作为后续建议，不在未授权新增服务上继续消耗。

## Task 8：报告、配置回退与交付

- [x] 完成真实对照；如果缺少凭证
  - 完成：实验 A（legacy-http vs SDK，OpenCode 臂缺 OPENCODE_SERVER_URL 未执行）与实验 B（legacy 策略 vs fast）；实验 C 真实搜索因缺少 ZHIHU_ACCESS_SECRET 未执行，夹具覆盖部分全部通过。性能相对目标未达成，已在报告判定"未通过上线门禁"。，把“工程完成”和“真实验证未完成”分列，不得写已达性能目标。
- [x] 更新 `.env.example`，准确记录 legacy/fast 默认值，修正文档 120 秒与代码 240 秒漂移；记录 SDK 版本、配置选择与直接 URL/base URL 区别。
- [x] 更新部署文档：本轮未部署。未来灰度先通过独立实例启用 SDK，确认质量门禁后再切换；保留旧凭证/配置，不能切换时删除旧链路。
- [x] 回退方案：未来若已获授权灰度，设置 `AGENT_TRANSPORT=legacy`、`GUIDANCE_POLICY=legacy` 并恢复原有 tuning 覆盖值，按原发布流程重启实例。仅改 policy 不会清除 fast 的显式环境覆盖，因此必须一并恢复。无需数据库 schema 回滚。
- [x] 检查日志、提交 diff 和输出文件无凭证，无生产用户内容，无意外 lockfile 大范围升级。
- [x] 提交报告、数据、文档：`docs: report SDK personal agent latency evaluation`。
- [x] 最后输出以下内容：分支/worktree 路径、提交列表、各门禁实测结果、对照表、质量评分、未完成项、是否建议上线和回退办法。用户没有要求发布，不执行部署脚本。

## 10. 执行 Agent 的最终交付模板

```text
分支：codex/sdk-personal-agent-latency
起点/终点提交：实际 SHA
实施完成：SDK 适配、调用观测、专用预算、知乎限时缓存、旧运行取消、上下文去重
工程验证：逐项 PASS/FAIL 与实际用例数
真实验证：实际运行数、模型请求数、搜索请求数；缺失部分单列
性能：每臂样本量、成功率、成功 p50/p95、失败/超时耗时、修复与搜索次数
质量：五维评分、严重误导数、逐案例偏差
判断：通过/未通过上线门禁；有无供应商/参数混杂
部署：本轮未部署
产物：报告、JSONL、评分文件、复现命令
```

## 11. 参考与自检

- SDK 官方仓库与说明：https://github.com/openai/openai-node 。本方案编写时已读取官方 README；特别核对 `maxRetries`、`timeout`、`fetch` 和 Chat Completions。实施时以锁定版本类型与测试为准。
- 知乎本地接口说明：`/home/wangjian/.codex/skills/zhihu/references/http-api.md`。
- 既有性能数据：`docs/superpowers/reports/data/2026-09-11-task5-derived.json`。
- 既有质量用例：`app/evals/guidance/cases.json`。
- 最新进度/预算实现：提交 `0217d2a`；实际执行时检查后续变更。

计划自检：用户三项硬要求分别落在 Task 1（新分支）、Task 2（SDK）、Task 4–7/实验 B–C（完善 Agent 并测试）；实验 A 控制调用链变量；独立数据、真实请求上限、质量门禁、配置回退与凭证缺失路径均有执行说明。
