# SDK 直连与专用个人 Agent 性能改造实施报告

- 日期：2026-09-13
- 分支：`codex/sdk-personal-agent-latency`
- Worktree：`/home/wangjian/项目/Fight-zhihu-sdk-latency`
- 起点提交：`0217d2a25301bd559340fc60271ed21f8ad7d9ce`（`plan/full-assessment-and-improvement` HEAD，与方案基线一致）
- 方案：`docs/superpowers/plans/2026-09-13-sdk-personal-agent-latency-plan.md`

## 环境

- Node v24.15.0
- pnpm 11.21.0
- OS：linux x64

## 基线门禁（进入实施前）

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm check` | PASS（0 errors, 0 warnings） |
| `pnpm test:unit -- --run` | PASS（26 文件 / 207 用例，无失败） |
| `pnpm build` | PASS |
| `pnpm exec playwright test` | PASS（11 passed，48.7s） |

基线无既有失败；后续新增失败均视为本次改动引入。

## 直连配置缺口

- 端点（base URL）：用户提供 `https://chatapi.weixin.qq.com/openai/v1/chat/completions`（完整 `/chat/completions` URL；SDK 需要 base URL `https://chatapi.weixin.qq.com/openai/v1`）。
- 模型：`deepseek-v4-flash`（用户写作 Deepseek-v4-flash；实际 ID 以真实请求验证为准）。
- 凭证：用户提供两个 key，其一疑似过期。通过 0600 gitignored 配置注入，不写入本报告。

## 任务状态

- [x] Task 1 建分支与基线
- [ ] Task 2 SDK 适配器与可回退配置
- [ ] Task 3 可归因观测与对照
- [ ] Task 4 总预算与重试策略
- [ ] Task 5 知乎检索平衡与有界缓存
- [ ] Task 6 旧运行取消与上下文去重
- [ ] Task 7 完整回归与隔离验收
- [ ] 实验 A/B/C 真实对照
- [ ] Task 8 报告与交付
