# 背景板

背景板是一款面向职场新人的移动端优先 PWA。用户把一件卡住的事和零散材料放进来，后台的通用 Agent 会自主判断是整理背景、搜索外部线索、追问，还是结束本轮，并把结果写成一张有证据链的背景板：当前阻塞、事实/说法/推断/未知/冲突、关键补全者，以及一条可以直接参考的求助信息。

线上体验：[projects.wangjian7410.cc/background-board/](https://projects.wangjian7410.cc/background-board/)

推荐先点击“体验宿舍案例”。预置材料会形成一张等待确认的背景板；再加入“物业刚回复：房间已经分配，钥匙在前台领取。”，即可看到阻塞点、结论、关键补全者和下一步随新证据更新。

## 产品原则

- 一件事一张持续更新的板，不把状态只留在聊天上下文里。
- Agent 没有固定工作流；它在最多 6 个决策回合内自由选择受控工具，每轮最多搜索 2 次。
- 事实必须关联证据；他人说法、Agent 推断、未知和冲突分别标记。
- 只判断谁具备补全信息的职责、入口或协调能力，不推断对方故意隐瞒或推卸。
- 知乎及全网结果只能作为待核实线索，不会自动升级为事实。
- 产品只生成沟通建议，不冒充用户发送消息。

## 架构

```text
响应式 SvelteKit PWA
        │
        ▼
SvelteKit API（校验、脱敏、限流）
        │
        ├── SQLite：案例、证据、背景板修订、Agent 事件
        │
        └── 有状态通用 Agent 循环
              ├── propose_board_patch（受 Zod、证据和安全规则约束）
              ├── ask_user / finish
              └── search_zhihu / search_global（只发送抽象查询）
                    │
                    └── 知乎开放平台
```

生产环境的模型层复用本机 OpenCode Server。每次模型决策创建一个短会话，关闭 OpenCode 自带的文件、Shell、网络和子任务工具，只允许模型通过背景板定义的 JSON 动作协议申请操作；会话结束后删除。也可以改用任意 OpenAI Chat Completions 兼容接口，或仅使用知乎直答模型。

## 本地运行

需要 Node.js 24、Corepack 和 pnpm。

```bash
cd app
corepack pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

没有配置模型时，匿名宿舍演示仍使用已审核的降级分析；普通新案例会明确提示模型尚未配置。

环境变量名称如下，具体值不要提交到仓库：

- `BACKGROUND_BOARD_DATA_DIR`：SQLite 数据目录；本地可留空使用 `app/data`。
- `AGENT_API_URL`、`AGENT_API_KEY`、`AGENT_MODEL`：OpenAI 兼容模型配置。
- `OPENCODE_SERVER_URL`、`OPENCODE_SERVER_USERNAME`、`OPENCODE_SERVER_PASSWORD`：已有 OpenCode Server 配置。
- `ZHIHU_ACCESS_SECRET`：知乎开放平台检索凭据；没有其他模型配置时也用于知乎直答。
- `APP_VERSION`：健康检查展示的应用版本。

模型选择优先级为 `AGENT_*` → OpenCode Server → 知乎直答。

## 验证

```bash
cd app
pnpm format:check
pnpm lint
pnpm check
pnpm test:unit -- --run
pnpm exec playwright test
pnpm build
test -f build/index.js
```

浏览器测试覆盖首页、匿名演示、外部知乎链接、追加回复后的状态变化和高亮、敏感信息预览、新案例降级，以及禁止枚举案例列表。

## 部署与回滚

生产进程以独立的 `background-board` 用户运行，只监听 `127.0.0.1:3210`；Nginx 从 `/background-board/` 反向代理。SQLite 数据位于 `/srv/background-board/data`，发布版本位于 `/srv/background-board/releases`。

```bash
./deploy/deploy.sh root@106.52.185.151
```

脚本会本地构建、上传时间戳版本、安装生产依赖、原子切换 `current`、启用并重启 systemd 服务，再检查本机健康端点。Nginx 与 Secret 的首次安装步骤见 [deploy/README.md](deploy/README.md)。

回滚：

```bash
previous=$(cat /srv/background-board/previous-release)
ln -sfn "$previous" /srv/background-board/current.next
mv -Tf /srv/background-board/current.next /srv/background-board/current
systemctl restart background-board
```

## 隐私与安全模型

- 创建案例前，浏览器会展示手机号、证件号码、邮箱及用户指定词的脱敏预览；服务端再次执行同样的脱敏后才持久化。
- 模型和知乎密钥只存在于服务端环境文件，公开响应、浏览器包和仓库均不包含密钥。
- Agent 只能通过案例级受控工具读写；写入前校验完整数据结构、证据引用和动机归因禁令。
- 外部搜索只接收 Agent 生成的抽象查询，不直接上传整段原始材料。
- API 请求体限制为 2 MiB；高成本写接口按真实客户端 IP 限流；案例列表不公开。
- 当前无账号系统。案例 UUID 是能力链接：知道完整链接的人可以读取该案例，因此公开体验时只能使用匿名或合成材料。

## 当前边界

比赛版本已经完成文本输入闭环，以下能力留到 P1：

- 账号、访问控制、跨设备同步和真正的本地优先存储；
- 图片/聊天截图上传、OCR 与用户纠错；
- 持久化或分布式限流、多实例任务队列和长任务恢复；
- 案例删除、数据保留期限和用户数据导出；
- 户口迁移预置案例、个人背景地图和更丰富的答复分支。

详细产品说明见 [背景板-项目说明.md](背景板-项目说明.md)，产品形态和验收标准见 [产品形态设计](docs/superpowers/specs/2026-09-05-background-board-product-form-design.md)，实现记录见 [实施计划](docs/superpowers/plans/2026-09-05-background-board-agent.md)。
