# 背景板 Web 应用

这是“背景板”的 SvelteKit 应用。新一轮引导模式先形成一版可纠正的理解，在模型认为需要时指出至多两个值得核对的沟通环节，并给出一个下一步；旧背景板模式继续用于历史兼容。

## 本地运行

需要 Node.js 24、Corepack 和 pnpm。

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
BACKGROUND_BOARD_GUIDANCE_V2=1 pnpm dev
```

应用固定使用 `/background-board` 路径。没有配置模型时，宿舍演示会显示明确标注的固定样例；普通案例会保留用户输入并提示本轮未完成。

常用环境变量：

- `BACKGROUND_BOARD_GUIDANCE_V2=1`：启用整套引导模式；关闭或移除后使用旧背景板页面和运行路径。
- `BACKGROUND_BOARD_DATA_DIR`：SQLite 数据目录，留空时使用 `app/data`。
- `AGENT_API_URL`、`AGENT_API_KEY`、`AGENT_MODEL`：OpenAI Chat Completions 兼容模型。
- `AGENT_TRANSPORT=sdk` + `AGENT_SDK_BASE_URL` + `AGENT_API_KEY` + `AGENT_MODEL`：用 OpenAI Node SDK 直连的显式开关（默认 `legacy` 完全保留旧选择顺序；`AGENT_SDK_BASE_URL` 是 base URL，不带 `/chat/completions` 后缀；`AGENT_SDK_STREAM=1` 启用流式）。SDK 配置缺失会报明确配置错误，不会回落旧路由或知乎直答。
- `OPENCODE_SERVER_URL`、`OPENCODE_SERVER_USERNAME`、`OPENCODE_SERVER_PASSWORD`：OpenCode Server 模型。
- `ZHIHU_ACCESS_SECRET`：知乎开放平台搜索；没有其他模型配置时也可用于知乎直答。
- `APP_VERSION`：健康检查显示的版本。

模型选择顺序（legacy 传输）是 `AGENT_*`、OpenCode Server、知乎直答；`AGENT_TRANSPORT=sdk` 时只使用显式 SDK 配置。指导预算策略由 `GUIDANCE_POLICY`（`legacy` 默认 240s/90s/2 次重试；`fast` 60s/40s/1 次重试/1 次搜索/3 步）控制。密钥只放在本地或部署环境，不提交到仓库。

## 引导模式的数据边界

- 原材料、用户补充和模型指导分别保存，模型不能改写前两类内容。
- 用户补充先保存，再触发新一轮整理；模型失败时补充仍然保留。
- 新输入会让上一版理解标记为过时，较晚返回的旧分析不能覆盖新版本。
- 沟通疑点必须引用本案例材料或用户输入；程序只检查引用存在与归属，不判断它在语义上是否足以支持疑点。外部经验只能启发，不能单独证明本次沟通有问题。
- 页面不会把模型概括写成已认证事实，也不会因用户复制建议而记录为已经执行。
- 关闭引导开关不会删除新增输入、指导快照或旧背景板数据。

## 验证

```bash
pnpm format:check
pnpm lint
pnpm check
pnpm exec vitest run
pnpm exec playwright test
pnpm build
```

Playwright 使用独立的临时 SQLite 目录。引导模式测试连接本地脚本模型，不继承真实模型或知乎凭据，也不会访问线上服务。
