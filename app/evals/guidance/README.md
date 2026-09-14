# 指导延迟真实评测

本目录的评测入口用**真实模型请求**在隔离 SQLite 中运行固定合成场景，用于传输对照、策略对照与搜索小样本。默认单测（`pnpm test:unit`）不包含本目录；评测必须显式 opt-in。

## 运行命令

```bash
cd app
GUIDANCE_REAL_EVAL=1 GUIDANCE_EVAL_PHASE=smoke     GUIDANCE_EVAL_MAX_REQUESTS=4  pnpm eval:guidance:latency
GUIDANCE_REAL_EVAL=1 GUIDANCE_EVAL_PHASE=transport GUIDANCE_EVAL_MAX_REQUESTS=60 pnpm eval:guidance:latency
GUIDANCE_REAL_EVAL=1 GUIDANCE_EVAL_PHASE=policy    GUIDANCE_EVAL_MAX_REQUESTS=60 pnpm eval:guidance:latency
GUIDANCE_REAL_EVAL=1 GUIDANCE_EVAL_PHASE=search    GUIDANCE_EVAL_MAX_REQUESTS=30 pnpm eval:guidance:latency
```

- `GUIDANCE_REAL_EVAL=1` 才会真实执行；否则整个 suite `describe.skip`。
- `GUIDANCE_EVAL_PHASE` 选择阶段：`smoke` | `transport` | `policy` | `search`。
- `GUIDANCE_EVAL_MAX_REQUESTS` 限制**本次运行**的模型请求数；全局上限由 ledger 维护：

## 请求上限与 ledger

- 全局硬上限：**150 次模型请求、30 次真实搜索请求**（含预热、重试与修复；失败也计入）。
- 计数在模型客户端/搜索客户端的**实际出站请求边界**进行；OpenCode 的建/删 session 不计数。
- ledger 文件：`docs/superpowers/reports/data/sdk-personal-agent/ledger.json`。重新执行读取旧 ledger 累计；手工删除或改写 ledger 绕过限额属于违反实验纪律。

## 凭证注入

通过 shell 环境或 `app/.env.eval`（权限 0600，已 gitignore）注入，禁止出现在命令参数、报告或提交中：

```dotenv
# OpenAI 兼容直连端点（SDK 臂）
AGENT_SDK_BASE_URL=https://provider.example/v1
AGENT_API_KEY=...
AGENT_MODEL=deepseek-v4-flash
# legacy-http 臂（同一供应商/模型/密钥，用于传输对照）
AGENT_API_URL=https://provider.example/v1/chat/completions
# 可选：OpenCode 臂（路径对照，存在配置混杂）
OPENCODE_SERVER_URL=
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=
# 可选：真实搜索
ZHIHU_ACCESS_SECRET=
```

## 产物

- `docs/superpowers/reports/data/sdk-personal-agent/results-<phase>.jsonl`：逐样本 EvaluationRow。
- `docs/superpowers/reports/data/sdk-personal-agent/attempts/attempts-<phase>.jsonl`：逐 attempt 元数据（计数、耗时、错误分类；不含 prompt/密钥/正文）。
- `docs/superpowers/reports/data/sdk-personal-agent/outputs/<phase>/`：合成输出的匿名草稿 JSON，供五维质量评分（梳理、启发、沟通判断、可执行性、反馈适应，各 0–2；先隐臂评分后解盲）。

## 场景

`latency-cases.json` 固定六个合成性能场景（材料不足 / 材料充分 / 已试过 / 条件否定 / 20 条长历史 / 需要追问）。文本与评分口径在实验前冻结，不得按模型输出临时修改。
