# SDK 与个人 Agent 改造复核报告

审查日期：2026-09-14。审查范围：`0217d2a..28d0e4c`，分支 `codex/sdk-personal-agent-latency`，工作目录 `/home/wangjian/项目/Fight-zhihu-sdk-latency`。

## 结论

SDK 接入确有实现和真实实验；新端点的合成任务已能在十几秒完成，值得继续推进。但有 5 项可定位的实现/评测问题，不能把当前交付视为方案全部验收完成。建议先修复后重新评测，不直接上线。

本轮是审查，未修业务代码、未提交执行分支、未部署、未调用真实模型或知乎。临时复现测试在运行后已移除，执行 worktree 保持干净。

## 验证证据

- `pnpm test:unit -- --run`：29 文件、266 用例通过。
- `pnpm check`：0 errors、0 warnings。
- 新增临时复现测试 3 条：全部按预期失败，证实重试配置和 fast 评测接线缺陷，详见 F1/F3。
- 阅读 SDK、运行时、策略、app-context、搜索缓存、评测 harness/入口及提交报告；核对 JSONL 的样本数与结果分布。
- 未复跑构建、lint、Playwright；它们的通过状态来自执行 Agent 报告，不算本轮独立验证。

## F1 [P1] fast 评测未传 policyMode，实验 B 测到的是混合策略

位置：`app/evals/guidance/latency.test.ts:138-148`；search 阶段的 runtime 构造也存在同样问题。

`runFullGuidance()` 传了 fast 的时间、次数参数，却没有传 `policyMode: policy.mode`。runtime 在 `guidance-runtime.ts:232` 默认取 legacy。因此名为 fast 的实验没有启用 fast 的超时不重试、200 ms 退避和低剩余预算 salvage 分支。

复现：按评测入口的同一组依赖构造 runtime，模型每次抛 `ModelClientError(..., {reason:'timeout'})`。预期 fast 只调用 1 次，实际调用 2 次。

影响：现有数据可保留为“fast 数值参数 + legacy 行为”的历史样本，不能据此判断完整 fast 策略的性能和质量。当前生产工厂正确传了 policyMode，说明评测路径与实际应用路径不一致。

修复：评测和应用复用同一 runtime 依赖工厂，显式传 policyMode；增加评测构造契约测试。修复后在剩余请求预算内重跑实验 B，旧数据不覆盖，分别标注实现提交。

## F2 [P2] 搜索缓存未注入实际应用，只在测试中生效

位置：`app/src/lib/server/app-context.ts:139-150`。

应用工厂创建 runtime 时没有传 `searchCache`，runtime 默认值为 null。`createSearchCache()` 的调用仅出现在单测，正常服务不会创建缓存。

影响：用户补充输入后，即便请求相同检索词，也不会获得报告声称的缓存收益。模块和单测完成不等于功能已经接通。

修复：在 service/runtime 实例生命周期创建一份有界缓存并注入，保留评测禁用缓存的显式选择。增加通过真实 service 工厂的重复查询测试，断言底层搜索只请求一次、两轮来源引用都有效。

## F3 [P1] 重试次数 0 被当成非法，破坏已有关闭重试配置

位置：`app/src/lib/server/agent/guidance-policy.ts:45-64,97-103`。

所有数值统一走正数解析，`GUIDANCE_MODEL_MAX_RETRIES=0` 不被接受；旧版用 nonNegativeIntegerOr，允许 0。

两条实测反例：

```ts
resolveGuidancePolicy({ GUIDANCE_MODEL_MAX_RETRIES: '0' }).maxModelRetries
// 预期 0，实际 2：legacy 静默恢复默认重试。

resolveGuidancePolicy(
  { GUIDANCE_POLICY: 'fast', GUIDANCE_MODEL_MAX_RETRIES: '0' },
  { strictNumeric: true }
)
// 预期 maxModelRetries=0，实际抛 GuidancePolicyConfigurationError。
```

影响：原来明确关闭重试的部署可能重新重试慢请求；SDK/fast 配置为 0 时服务初始化报错。这直接违背本轮控制长等待、保留 legacy 兼容性的目标。

修复：次数和时间分别解析；重试允许非负整数，时间和 maxModelSteps 要求正整数。若支持禁用搜索，maxSearches 也应允许 0；小数不能被静默 floor 成 0 或其他整数。增加 legacy/sdk/fast 对 0、负值、小数、空值的边界测试。

## F4 [P2] 文档规定的单次评测请求上限参数没有实现

位置：`app/evals/guidance/harness.ts:274-283`；对照 `app/evals/guidance/README.md:9-17`。

文档要求用 `GUIDANCE_EVAL_MAX_REQUESTS` 降低本次调用上限，但代码未读取该变量，实际使用构造函数里写死的 60/30 等数值。全局 ledger 上限仍有作用，此问题不是无限制请求，而是用户设定的更低单次上限失效。

影响：按文档传 1 仍可能执行多次付费/限额请求。

修复：本次上限取显式环境值、阶段上限与全局剩余额度的最小值；校验非法值，保留跨执行累计。用完全离线的 ledger 临时目录测试：设置 1，第二次 reserve 必须失败；重新创建 session 不能绕过全局计数。不要在测试中改写现有真实 ledger。

## F5 [P2] 真实知乎评测缺少正例与断言，补凭证也不能完成实验 C

位置：`app/evals/guidance/latency.test.ts:376-379,389-397` 及该阶段末尾断言。

两种场景都写为 `expectSearch:false`，没有明确要求知乎检索的正例；expectSearch 只用于测试名称，未用于核对实际搜索次数。最终只断言 outcome 属于 ready/needs_input/failed，完全不搜索也能通过。

另外，countedZhihu 包装函数丢弃第三参数 SearchCallOptions，导致评测不传递 runtime 的取消/时间预算，与实际搜索接口不一致。

影响：报告所说“补齐密钥后即可完成真实知乎小样本”不成立，必须先修评测。否则无法证明用户明确要求查知乎时会搜索，也无法评估真实搜索下的截止行为。

修复：增加明确要求知乎经验的固定场景，保留普通解释负例，分别验证搜索尝试和非必要检索；失败时核查输出未声称已查证。透传 search options；搜索超时和取消契约用离线夹具测，真实测试记录可用性。真实搜索不可用不能计为检索质量验证通过。

## 结果报告还需纠正的归因

1. 实验 A 实际比较同一新端点的手写 fetch 与 SDK，OpenCode 对照没有做。因此不能从这些数据判定历史 90 秒由 OpenCode 服务本身造成；它可能涉及底层供应商、模型参数、中间代理或排队，仍需同条件对照。
2. 实验 B 的 fast 标签受 F1 影响；不能把观察到的约 30% 变慢定性为“噪声级差异”。样本量小只能说明不确定，不能证明是噪声。
3. SDK 单次协议通过 14/18，手写 fetch 为 16/18；端到端两组各成功 11/12。直连速度有价值，但输出修复仍频繁（报告各臂 10 次），质量和格式稳定性仍需继续验证。
4. 方案里的“相对基线 p50 下降 30%”应针对原应用调用链。fast 对已经很快的 SDK 链路不再提速，并不自动否定 SDK 直连路线；当前正确结论是原应用基线缺失、full-fast 评测待修正，而非已经完成了原目标对照。
5. “20 条长历史”及反馈适应评测是把预制输入一次性装入案例，未完整覆盖先产出一版指导、再追加用户反馈并运行第二轮的真实流程；后续补一条端到端两轮案例，以验证 priorGuidance/引用历史/取消路径的组合行为。

## 建议给执行 Agent 的返工顺序

1. F3：恢复 0 重试配置兼容性。
2. F2：把缓存接入 service 工厂并补集成测试。
3. F1、F4、F5：修评测接线、限额和检索正例；先离线验证再消耗剩余真实额度。
4. 修正报告归因，保留既有原始数据。
5. 获取或复用可合法用于测试的 OpenCode/知乎配置，使用隔离数据库补完原链路对照与真实搜索；缺少配置就明确报告未完成。
6. 全门禁通过、业务质量复核完成后再提出灰度建议；本轮不部署。

不建议重新换 Agent 框架或推倒重做。现有 SDK 适配和专用 runtime 改造可以保留，先补接线与验证缺口。
