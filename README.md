# 背景板

背景板是一款面向职场新人的移动端优先 PWA。用户把一件卡住的事、零散材料和现实限制放进来，应用先形成一版可以纠正的工作理解，再帮助用户发现可能改变行动的沟通断点，并给出一个值得尝试的下一步。

这轮改造的重点是“帮助、启发、引导”。模型不负责给人或说法做最终裁决，程序也不再用自然语言规则认证模型概括是否绝对正确。用户可以补充新情况、指出理解有误、说明联系不上或反馈已经问过；提示要求下一版据此调整，实际适应效果纳入真实模型评测。

仓库仍保留旧背景板及其数据结构。新引导模式通过服务端开关整体启用，目前需要完成真实模型产品评测后再决定是否默认切换。本轮代码尚未部署到线上地址：[projects.wangjian7410.cc/background-board/](https://projects.wangjian7410.cc/background-board/)。

## 一次完整使用

1. 输入目标、困惑和已有的聊天、邮件或通知，并检查脱敏预览。
2. 查看“当前理解”。它是一版工作假设，可以纠正，不是程序认证的事实。
3. 模型认为本案例材料提示沟通断点时，查看至多两个“值得核对的沟通疑点”。每项都要引用相关材料，仍可由用户纠正；模型没有提出疑点时这一栏不显示。
4. 尝试一个下一步。建议可以是联系、查看材料、等待或先回答一个关键问题。
5. 用“理解有误”“联系不上”“我问过了”“有新回复”补充现实反馈。输入先持久保存，再触发下一轮整理。
6. 刷新后继续查看反馈、当前指导和历史版本；失败不会吞掉已经保存的输入。

没有模型配置时，匿名宿舍演示使用明确标注的固定样例。普通案例会保留材料与反馈，并如实提示本轮未完成。

## 产品原则

- 先理解用户的目标、限制和已经尝试过的动作，再寻找能改变下一步的缺口。
- 沟通提醒必须落到具体环节：观察到了什么、可能怎样误读、影响哪个决定、如何低成本核对。
- 不给人物做可信度评分，不从局部信息推断对方动机，也不把抱怨扩写成指控。
- 只推荐一个最值得尝试的下一步，不重复用户已经说明不可行的办法。
- 外部经验只用来发现新角度或待验证入口，不能证明本单位的情况。
- 原材料、用户反馈和模型指导分别保存。模型只能产生新的指导快照，不能改写用户内容。
- 产品只生成沟通建议，不冒充用户发送消息；复制建议也不会被记录为已经执行。

## 架构

```text
响应式 SvelteKit PWA
        │
        ▼
SvelteKit API（校验、脱敏、限流、模式切换）
        │
        ├── SQLite
        │     ├── 案例与原材料
        │     ├── 用户反馈与上下文版本
        │     ├── 引导快照及历史
        │     └── 旧背景板、待审提案与事件
        │
        ├── Guidance 运行时（新模式）
        │     ├── provide_guidance
        │     ├── search_zhihu / search_global（可选）
        │     └── 单案例串行 + 版本比较 + 有界调用
        │
        └── 旧 Background Board Agent（兼容模式）
```

新运行时最多调用模型 5 次、搜索 2 次、修复结构或引用 1 次。有效的 `provide_guidance` 会直接结束本轮，不需要额外的完成调用。程序只硬校验结构、来源存在与归属、链接、预算、并发和版本冲突；建议是否有帮助由用户反馈和产品评测检验。

生产模型可以使用 OpenAI Chat Completions 兼容接口、OpenCode Server 或知乎直答。模型没有文件、Shell 或任意写入权限，只能提交受约束的 JSON 动作。

## 本地运行

需要 Node.js 24、Corepack 和 pnpm。

```bash
cd app
corepack pnpm install --frozen-lockfile
cp .env.example .env
BACKGROUND_BOARD_GUIDANCE_V2=1 pnpm dev
```

应用固定使用 `/background-board` 路径。常用环境变量：

- `BACKGROUND_BOARD_GUIDANCE_V2=1`：启用整套引导模式；关闭或移除后使用旧页面和旧运行路径。
- `BACKGROUND_BOARD_DATA_DIR`：SQLite 数据目录；本地留空时使用 `app/data`。
- `AGENT_API_URL`、`AGENT_API_KEY`、`AGENT_MODEL`：OpenAI 兼容模型。
- `OPENCODE_SERVER_URL`、`OPENCODE_SERVER_USERNAME`、`OPENCODE_SERVER_PASSWORD`：OpenCode Server。
- `ZHIHU_ACCESS_SECRET`：知乎开放平台搜索；没有其他模型配置时也用于知乎直答。
- `APP_VERSION`：健康检查展示的版本。

模型选择顺序是 `AGENT_*`、OpenCode Server、知乎直答。具体凭据只放在本地或部署环境，不提交到仓库。

## 验证

```bash
cd app
pnpm format:check
pnpm lint
pnpm check
pnpm exec vitest run
pnpm exec playwright test
pnpm build
test -f build/index.js
```

浏览器测试分别启动关闭开关的旧模式和开启开关的引导模式。引导模式只连接本地脚本模型，使用独立的临时 SQLite 目录，并显式清空真实模型与知乎凭据。固定的 10 个产品场景位于 `app/evals/guidance/cases.json`；脚本模型只验证工程合同，不能替代真实模型效果评价。

## 数据、隐私与回退

- 浏览器先展示手机号、证件号码、邮箱及用户指定词的脱敏预览；服务端再次脱敏后才持久化。
- 修改任何待发送内容或替换规则后，原来的预览确认立即失效。
- 沟通疑点必须引用本案例材料或用户反馈；外部结果不能单独支撑对本次沟通的判断。
- 较晚返回的旧分析可以留在历史中，但不能覆盖更新后的上下文。
- 模型日志不含原始回复或完整提示，也不会进入下一轮产品上下文。
- 当前没有账号系统。案例 UUID 仍是能力链接，公开体验只能使用匿名或合成材料。

回退只需移除或关闭 `BACKGROUND_BOARD_GUIDANCE_V2` 并重启应用。旧背景板仍可读取；新增反馈和指导快照不会被删除，之后重新启用开关仍可恢复。

## 部署

生产进程以独立的 `background-board` 用户运行，只监听 `127.0.0.1:3210`；Nginx 从 `/background-board/` 反向代理。SQLite 数据位于 `/srv/background-board/data`，发布版本位于 `/srv/background-board/releases`。首次安装和回滚命令见 [部署说明](deploy/README.md)。

本轮没有执行部署。默认切换应以完整工程闭环和真实模型产品评测为依据，不能只凭输出看起来更温和。

## 文档

- [当前产品设计](docs/superpowers/specs/2026-09-11-guided-help-product-design.md)
- [当前实施计划](docs/superpowers/plans/2026-09-11-guided-help-implementation-plan.md)
- [本轮实施结果](docs/superpowers/reports/2026-09-11-guided-help-results.md)
- [最初项目说明（历史）](背景板-项目说明.md)
- [第一版产品形态（历史）](docs/superpowers/specs/2026-09-05-background-board-product-form-design.md)
- [线上可靠性治理报告](docs/superpowers/reports/2026-09-10-线上可靠性治理报告.md)
