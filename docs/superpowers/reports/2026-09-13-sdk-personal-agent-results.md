# SDK 直连与专用个人 Agent 性能改造实施报告

- 日期：2026-09-13
- 分支：`codex/sdk-personal-agent-latency`（worktree `/home/wangjian/项目/Fight-zhihu-sdk-latency`）
- 起点：`0217d2a25301bd559340fc60271ed21f8ad7d9ce`；终点：见下文提交列表
- 方案：`docs/superpowers/plans/2026-09-13-sdk-personal-agent-latency-plan.md`
- 交付模板（第 10 节要求的最终输出）见文末

## 1. 提交列表

| 提交         | 内容                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `2c61193`    | docs: record SDK latency implementation baseline（基线报告 + 方案入库）                                 |
| `24e8338`    | feat: add explicit SDK model transport（openai SDK 7.15.0、sdk-model-client、AGENT_TRANSPORT）          |
| `69b948b`    | feat: measure model transport and run latency（传输层观测、queueMs、评测入口与固定场景）                |
| `4393ea6`    | feat: bound personal agent execution and retries（guidance-policy、整轮截止、fast 重试）                |
| `be2986c`    | feat: bound and reuse contextual searches（搜索限时/取消、单案例有界缓存、检索原则）                    |
| `b13d2fe`    | feat: supersede stale guidance and deduplicate context（新版替代旧运行、上下文去重、OpenCode 后台清理） |
| `754843c`    | test: cover SDK personal agent workflows（SDK/SSE E2E 夹具、guided-sdk 项目、全门禁）                   |
| （本次提交） | docs: report SDK personal agent latency evaluation（本报告、数据、评分、文档）                          |

## 2. 实施内容（对照方案）

- **SDK 适配器**（Task 2）：`createSdkModelClient` 显式 `maxRetries: 0`（实测无 SDK 内部重试叠加）、按调用超时、错误映射（cancelled/timeout/http/network/payload，不把 DOMException 一概归 timeout）、非流式 + 独立流式分支（首个非空正文计时、流中断判 payload、finish_reason=length 不交给保存）。
- **配置选择**：`AGENT_TRANSPORT=legacy|sdk`；sdk 缺配置直接报错，不回落知乎直答；非法值报错。`AGENT_SDK_BASE_URL` 与旧 `AGENT_API_URL` 全 URL 语义分离。
- **观测**（Task 3）：`ModelObservation` 合入 `ModelCallOptions`；legacy-http/OpenCode/SDK 三种传输都发观测；OpenCode 会话创建/清理分别计时，总时长包含两者；`guidance.run.finished` 增加 `queueMs/requestedAt`；`modelCalls` 每条 attempt 记录 transport、字符数、firstContentMs、token 用量、finishReason；观测不含 prompt、密钥或模型输出正文（有测试）。
- **专用预算**（Task 4）：`resolveGuidancePolicy`（legacy 240/90/2；fast 60/40/1/8s/1 次/3 步）；fast 数值覆盖非法即报错（sdk 传输下 legacy 也严格）；`canRetryFast` 按方案固定逻辑；整轮 `AbortController` + finally 清理；fast 固定 200ms 退避；剩余不足 10s 优先 salvage 而非再花一次模型调用。
- **搜索**（Task 5）：`SearchCallOptions(signal, timeoutMs)` 向后兼容；搜索共享整轮取消、自身超时返回 SEARCH_UNAVAILABLE 让本轮继续；429 不循环；prompt 增加四条检索原则（上下文含"知乎"不再强制搜索）；`search-cache.ts` 单案例 TTL 5 分钟、每案例 20 项、100 案例、淘汰最旧、不落盘、失败不缓存、命中仍走引用校验并记录 cacheHit。
- **替代与去重**（Task 6）：新版输入取消旧运行（`CaseFlightState.activeController` + 单调 generation 清理所有权）；旧运行本地结算为 `superseded`，迟到正文一律丢弃（runtime 侧主动检查，防模型无视取消信号）；排队运行立即建立进度条目（runId 不再 404）；UI 显示"已由更新后的整理替代"；上下文确定性去重（input.id 去重、剔除 requestId/createdAt、latestGuidance 与 referencedGuidance 去重），不引入总结调用、不做长度硬截断。
- **E2E**（Task 7）：夹具支持 SDK 流式 SSE（先空 delta 后正文、分段正文、finish_reason=stop）、慢速响应、503、搜索失败、非法来源；新增 `guided-sdk` Playwright 项目（SDK 直连 + SSE，端口 4175，独立 mkdtemp 数据目录）；新增三个 guided E2E：新版替代旧运行、搜索失败后明确状态且无 JSON 泄漏、非法来源不进入最终指导。

## 3. 工程门禁实测（终点提交）

| 命令                        | 结果                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`         | PASS                                                                                                   |
| `pnpm lint`                 | PASS（0 error）                                                                                        |
| `pnpm check`                | PASS（0 errors, 0 warnings）                                                                           |
| `pnpm test:unit -- --run`   | PASS（29 文件 / 266 用例，0 失败；不含真实模型访问，评测入口默认 describe.skip 且不在单测 include 内） |
| `pnpm build`                | PASS                                                                                                   |
| `pnpm exec playwright test` | PASS（24 用例：legacy 5 + guided 8 + guided-sdk 11…实际 8+8+8，三项目全部通过，约 1.8 分钟）           |

基线（0217d2a）当时为 207 单测 / 11 E2E 全绿；终点 266 单测 / 24 E2E 全绿，无遗留失败。

## 4. 真实验证

- **凭证**：用户提供 `https://chatapi.weixin.qq.com/openai/v1/chat/completions` 与两个 key。实测（诊断请求均计入 ledger，共 7 次）：key1（脱敏代号，内容不记录）对该模型返回 401 invalid or expired；key2（脱敏代号，内容不记录）有效（两个 key 以脱敏代号区分，内容不记录）。模型名**区分大小写**，有效 id 为 `Deepseek-v4-flash`（小写 `deepseek-v4-flash` 返回 400 invalid model）。密钥只存于 0600 gitignored `app/.env.eval`，未进入任何报告或提交。
- **请求上限执行**：全局 ledger `docs/superpowers/reports/data/sdk-personal-agent/ledger.json`。最终 `modelRequests: 94`（150 上限）：12 次诊断+smoke、38 次实验 A（2 预热 + 36 主样本）、44 次实验 B（24 轮端到端运行共 44 次出站请求）。`searchRequests: 0`。每次执行前检查剩余预算，失败也计数，重启复读 ledger。
- **实验 A（传输对照）**：2 次预热 + 6 场景 × 3 次 × 2 臂 = 38 次请求。A1（OpenCode 臂）因 `OPENCODE_SERVER_URL`/密码未配置而无法执行，标记为**基线缺失**；实际对照为 legacy-http vs sdk（同一供应商/端点/模型/密钥，无传输外混杂）。
- **实验 B（策略对照）**：6 场景 × 2 次 × 2 臂 = 24 次端到端运行（多步请求计入同一上限）。
- **实验 C（知乎/取消）**：真实知乎小样本**未完成**——`ZHIHU_ACCESS_SECRET` 在项目 `.env` 中为空且用户未提供。夹具覆盖部分全部通过（搜索超时、429 不循环、整轮取消、缓存命中/隔离/TTL/失败不缓存、替代旧运行）。30 次搜索预算未消耗。

## 5. 性能结果

### 实验 A：仅比较调用链（冻结 prompt 单次请求，n=18/臂）

| 指标       | legacy-http               | sdk（非流式）             |
| ---------- | ------------------------- | ------------------------- |
| 协议通过   | 16/18（2 次 JSON 未闭合） | 14/18（4 次 JSON 未闭合） |
| 成功 p50   | 5593 ms                   | 5011 ms                   |
| 成功 p95   | 6990 ms                   | 6590 ms                   |
| 最大       | 7270 ms                   | 9726 ms                   |
| 真实请求数 | 18（无重试叠加）          | 18（无重试叠加）          |

SDK 直连 p50 快约 10%、p95 快约 6%；样本量小（18），只能作探索性结论：该端点的中间层开销本身很小，与 OpenCode 时代的 90s 级延迟差异主要来自中间服务与模型路径，而非本端点。

### 实验 B：专用策略对照（SDK 同一传输，端到端，n=12/臂）

| 指标                      | legacy 策略           | fast 策略                   |
| ------------------------- | --------------------- | --------------------------- |
| 成功（ready/needs_input） | 11/12（91.7%）        | 11/12（91.7%）              |
| 失败                      | 1（GUIDANCE_INVALID） | 1（GUIDANCE_INVALID）       |
| 成功 p50                  | 9961 ms               | 13023 ms                    |
| 成功 p95                  | 17181 ms              | 23728 ms                    |
| 最大                      | 17181 ms              | 23728 ms（全部 < 60s 预算） |
| 修复次数合计              | 10                    | 10                          |

两臂各有一次 `GUIDANCE_INVALID`（模型两次输出不合规 JSON 后按方案明确失败，不同场景：legacy 在"两个目标"、fast 在"条件否定"）；取消/超时 0；搜索 0（合成场景未触发真实检索动作）。

### 实验 C：知乎与取消

真实搜索未执行（缺密钥）。缓存与取消行为由 34 个 runtime/缓存单测 + E2E 替代场景覆盖（全绿）。

## 6. 质量评审（实验 B 输出，单盲评分）

- 方法：24 份输出先随机重命名（`blind/.mapping.json`），按固定文本评分后解盲；五维度各 0–2（梳理/启发/沟通判断/可执行性/反馈适应；无反馈上下文的样本"反馈适应"记 N/A 并降低分母）；严重误导清单逐项核查。
- **平均总分**：fast 1.723 vs legacy 策略 1.736，下降 0.013（阈值 0.2，通过）。
- **配对成功率**：两臂均 91.7%，下降 0 个百分点（通过）。
- **严重误导**：0 例。逐案例：条件否定场景三份全部保留"尚未批准/如果审批通过"条件；已试过场景无一份重复邮件建议；长历史场景全部尊重"不能直接联系物业"；两目标场景职责引用均来自材料（未编造）。个别扣分点：一处 changeSummary 用词错误（"直接入股"）、一处时间线偏差（"今天下午"应为"明天下午"）、一份无 nextStep 且无 question、一份 wait 步骤与当天截止匹配较弱（明细见 `quality-scores-policy.json`）。

## 7. 判断：是否通过上线门禁

**未通过上线门禁（性能相对目标一项未达标），不建议本轮切换线上默认路由。**

- 通过项：工程质量门禁全绿；绝对性能目标达成（成功 p50 ≈ 10–13s ≤ 30s，p95 ≈ 17–24s ≤ 60s；fast 全部运行在 60s 预算内明确结束，最长 23.7s）；质量门禁达成（分数下降 0.013 ≤ 0.2、成功率无下降、严重误导 0）；无 SDK 隐藏重试；来源校验/协议/salvage 语义未被提速削弱。
- 未通过项：**"相对同批基线端到端 p50 下降 ≥ 30%"**。fast 相对同批 legacy 策略臂 p50 反而更慢（13.0s vs 10.0s，样本小，属噪声级差异）；OpenCode 基线臂因缺配置缺失，无法完成方案定义的 A1 基线比较。未改低门槛、未延长预算、未隐藏失败。
- 归因说明：本端点（chatapi.weixin.qq.com 直连）本身延迟低（单次请求 p50 ≈ 5s），策略参数（预算/重试/搜索上限）在"模型已快"的路径上没有可削减的等待；历史上 90s 级延迟来自 OpenCode 中间链路，缺少其凭证即无法量化该链路的收益。
- 混杂标记：A 实验为"路径对照"（legacy-http vs sdk，同端点同模型）；无跨供应商混杂；OpenCode 基线缺失已在 `summary.json` 声明。

## 8. 部署与回退

- **本轮未部署**，未重启线上服务，未修改线上模型配置，未写任何生产案例。
- 未来灰度：先独立实例 `AGENT_TRANSPORT=sdk`（+ `GUIDANCE_POLICY` 按需），质量门禁确认后再切线上；保留旧凭证。
- 回退：`AGENT_TRANSPORT=legacy` + `GUIDANCE_POLICY=legacy` 并一并恢复原有 tuning 显式覆盖值（fast 的显式覆盖不会因改 policy 而清除），按原发布流程重启；无需 schema 回滚。详见 `deploy/README.md`。
- 文档修正：`.env.example` 已把整轮默认 120 秒的文档漂移修正为 legacy 240 秒 / fast 60 秒分列，并补齐 `GUIDANCE_SEARCH_TIMEOUT_MS`、`GUIDANCE_MAX_SEARCHES`、`GUIDANCE_MAX_MODEL_STEPS`、`GUIDANCE_RUN_RATE_LIMIT`（新增的启动限流覆盖，默认 10 次/10 分钟不变）。

## 9. 未完成项与后续建议

1. 实验 C 真实知乎小样本未执行（缺 `ZHIHU_ACCESS_SECRET`）——补齐密钥后按 `app/evals/guidance/README.md` 的 search 阶段命令即可执行（预算 30 次仍在）。
2. OpenCode 基线臂（A1）未执行（缺 `OPENCODE_SERVER_URL`/密码）——补齐后可量化"去掉中间链路"的真实收益。
3. 协议合规是当前主要失败源（单次对照 2–4/18 截断 JSON；端到端每臂 1 次 GUIDANCE_INVALID 且两臂对称）：后续可评估在显式验证端点支持后启用 JSON 输出约束（方案 3 节留作第二轮），而不是放宽校验。
4. fast 策略在本端点上无延迟收益但保留价值：在慢链路（OpenCode）或供应商抖动场景下，60s 硬预算与取消语义仍把最坏等待从 4 分钟压到 1 分钟。
5. 候选模型测试未做（未授权新增服务，150 请求预算余 56 次）。

## 10. 最终交付模板

```text
分支：codex/sdk-personal-agent-latency
起点/终点提交：0217d2a → 754843c + 本次 docs 提交
实施完成：SDK 适配、调用观测、专用预算、知乎限时缓存、旧运行取消、上下文去重
工程验证：format:check PASS；lint PASS；check PASS；单测 266/266 PASS；build PASS；Playwright 24/24 PASS（legacy/guided/guided-sdk 三项目）
真实验证：模型请求 94/150（ledger 计数：12 诊断+smoke、38 实验 A、44 实验 B 的全部出站请求）；搜索请求 0/30（缺 ZHIHU_ACCESS_SECRET，真实搜索未完成，已单列）
性能：实验 A n=18/臂（legacy p50 5593ms / sdk 5011ms，p95 6990/6590）；实验 B n=12/臂（legacy 策略 p50 9961ms / fast 13023ms，p95 17181/23728；成功率 11/12 vs 11/12；fast 全部 <60s 预算）
质量：fast 1.723 vs legacy 1.736（下降 0.013 ≤ 0.2）；严重误导 0；逐案例偏差见 quality-scores-policy.json
判断：未通过上线门禁（相对 p50 下降 ≥30% 未达成，OpenCode 基线臂缺失）；绝对目标与质量门禁均达成
部署：本轮未部署
产物：本报告、docs/superpowers/reports/data/sdk-personal-agent/{ledger.json,summary.json,results-*.jsonl,attempts/,outputs/,blind/,quality-*.json}、复现命令见 app/evals/guidance/README.md
```

---

# 2026-09-14 返工补记（复核报告 2026-09-14-sdk-personal-agent-review.md 的修复与重测）

## 返工修复（commit `6cf3214`）

| 发现                                   | 修复                                                                                                                                                   | 验证                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| F1 fast 评测未传 policyMode            | 提取 `createEvalRuntimeDependencies` 共享工厂（harness.ts），显式传 `policyMode: policy.mode`；评测与应用同一接线                                      | 契约测试：fast 模式超时恰好 1 次调用；legacy 模式 3 次                                                           |
| F2 搜索缓存未注入应用                  | `getCaseService()` 创建 `createSearchCache()` 注入 runtime                                                                                             | 集成测试：真实 service 两次运行同一检索词，底层 `searchZhihu` 只调 1 次，第二轮 `cacheHit: true`，两轮引用均有效 |
| F3 重试次数 0 被判非法                 | 次数类（retries/maxSearches）走非负整数解析；时间/步数要求正整数；小数严格模式报错、legacy 回退默认不 floor                                            | 边界测试：`GUIDANCE_MODEL_MAX_RETRIES=0` 在 legacy/strict 下均为 0；`maxSearches=0` 合法；负值/小数/非数字拒绝   |
| F4 `GUIDANCE_EVAL_MAX_REQUESTS` 未实现 | 单次上限取 options > 环境变量 > 全局默认的最小值；非法值报错；ledger 支持测试隔离目录                                                                  | 离线 ledger 测试 6 条：限额 1 生效、非法值报错、跨会话累计不可绕过、失败也计数、搜索预算独立                     |
| F5 知乎评测无正例无断言                | 新增固定场景 `eval-zhihu-experience-requested`（明确要求查知乎）；`expectSearch` 真实核对搜索次数；counted 包装透传 `SearchCallOptions`；补记 attempts | 离线跑通；真实执行见下                                                                                           |

## 重测结果

### 实验 C（真实知乎，commit 6cf3214，密钥已配置）

- 正例（用户明确要求查知乎经验）× 3：**3/3 发起真实检索**（每轮恰好 1 次搜索请求，30 次搜索预算用 3 次）；1/3 完成可用指导，2/3 模型在检索后的修复轮输出不稳定而失败（fast 不重试 payload 失败，属速度-稳健性权衡）。
- 负例（普通材料解释）× 3：**0 次搜索**——非必要检索没有发生，检索原则生效。
- 检索失败时输出未声称已查证（断言通过）。

### 实验 B 重跑（full fast，commit 6cf3214，n=13/臂）

| 指标     | legacy 策略 | fast 策略（完整）           |
| -------- | ----------- | --------------------------- |
| 成功     | 10/13       | 9/13                        |
| 成功 p50 | 11194 ms    | 7382 ms                     |
| 成功 p95 | 22987 ms    | 24660 ms                    |
| 最大     | 62665 ms    | 30512 ms（全部 < 60s 预算） |

- 修复后 fast p50（7.4s）**快于** legacy 策略（11.2s）；fast 最坏等待减半（30.5s vs 62.7s，legacy 一例逼近 240s 预算内 63s）。
- fast 成功率低 1 例：4 次失败均为"首次输出不合协议 → 修复调用立即返回空正文（payload，不重试）"；legacy 凭 2 次重试存活。已离线验证取消归因正确（aborted→cancelled），该现象为模型修复轮不稳定输出，非接线缺陷。
- 修复前（754843c）的实验 B 数据保留为"F1 缺陷下 fast 标签样本"，不覆盖、不混入（summary.json 分列）。

### 归因纠正（复核报告第 4 节的采纳）

1. 实验 A 只是同一新端点的手写 fetch vs SDK 对照，**不能**据此判定历史 90 秒由 OpenCode 服务造成——原链路基线臂在评测会话中缺失，"相对原应用基线 p50 下降 ≥30%"的目标仍未完成对照。
2. "约 30% 变慢是噪声"的说法撤回；修复后完整 fast 策略实测 p50 快约 34%，但样本量 13，仍为探索性结论。
3. 剩余预算：模型请求 150/150 已用尽，搜索 3/30；如需继续补 OpenCode 基线对照需用户追加预算授权。

## 部署

按用户指示，返工修复后直接部署（legacy 默认策略不变，仅代码与接线更新），部署记录见 `deploy/README.md` 与发布版本号。
