# 背景板部署

运行时位于 `/srv/background-board`，systemd 只监听 `127.0.0.1:3210`，Nginx 对外提供 `/background-board/`。SQLite 状态单独保存在 `/srv/background-board/data`，不会随版本切换丢失。

首次安装：

1. 通过标准输入或宿主 Secret Store 创建 `/etc/background-board.env`；不要把密钥写入仓库或 shell 参数。部署脚本会校正所有者和 `0600` 权限，但不会生成或覆盖 Secret。
2. 在目标 TLS server 中加入 `include /etc/nginx/snippets/background-board.conf;`。脚本会安装 snippet，并在发现 active 配置没有该 location 时中止。
3. 执行 `./deploy/deploy.sh`。脚本会幂等创建系统用户和运行目录、安装 systemd unit/snippet、验证 Nginx、完成原子发布，并检查本机和公网健康端点。

引导模式不会由部署脚本自动打开。受控试用时，在 `/etc/background-board.env` 中把 `BACKGROUND_BOARD_GUIDANCE_V2` 精确设为 `1`；关闭时设为 `0`，然后重启 `background-board.service`。健康接口只说明模型配置存在，不探测模型实际连通，也不返回当前模式；发布后还要检查首页文案并运行一个合成案例。

部署脚本不自动备份 SQLite。升级前应使用 SQLite 的在线备份能力为 `/srv/background-board/data/background-board.sqlite` 建立一致性快照；不要直接复制一个仍在使用 WAL 的数据库文件。

回滚到上一版本：

```bash
previous=$(cat /srv/background-board/previous-release)
version=$(basename "$previous")
ln -sfn "$previous" /srv/background-board/current.next
mv -Tf /srv/background-board/current.next /srv/background-board/current
sed -i '/^APP_VERSION=/d; /^BACKGROUND_BOARD_GUIDANCE_V2=/d' /etc/background-board.env
printf 'APP_VERSION=%s\nBACKGROUND_BOARD_GUIDANCE_V2=0\n' "$version" >> /etc/background-board.env
systemctl restart background-board
```

验证：

```bash
curl --fail http://127.0.0.1:3210/background-board/api/health
curl --fail https://projects.wangjian7410.cc/background-board/api/health
```

## 多人使用与用户状态（2026-09-14 代码核查）

当前可以按不同案例分别处理请求，但还没有账号系统，不能把“案例分开保存”当作“用户权限隔离”。

| 状态 | 当前实现 | 多人使用的边界 |
| --- | --- | --- |
| 登录与案例归属 | 没有用户表、登录会话或案例所有者 | 持有案例 UUID 链接即可读写，不能用于正式的私有用户空间 |
| 材料、补充、指导历史 | SQLite 按 case_id 持久化 | 不同案例分别保存；同一案例链接代表同一份共享状态 |
| 同一案例并发整理 | 运行时按案例串行，同版本复用运行；版本比较阻止旧结果覆盖新上下文 | 仅在同一个 Node 进程内协调，不能直接扩成多个 worker 或多个副本 |
| 运行中任务与进度 | 内存 Map | 服务重启丢失运行状态；已写入 SQLite 的材料和结果仍保留，未完成任务没有自动恢复 |
| 流量与模型额度 | 进程内按 IP 限流，共用服务端模型凭据 | 同一出口 IP 的用户共用限额；没有用户额度、全局模型并发上限或持久队列 |

### 参赛 Demo 的部署约定

本项目当前定位为参赛演示 Demo，保留免登录体验。账号、用户归属和管理后台不属于当前实施范围；以后转为正式产品时再评估。

- 分享应用首页，让每位体验者新建自己的案例。不同案例分别保存；直接分享某个案例详情链接，就表示共同查看和操作同一份内容。
- 保持单个 Node 进程和本地 SQLite，沿用当前部署方式。演示期间避免重启或发布，以免打断正在进行的整理。
- 使用匿名或合成材料。已有材料和整理结果持久保存，案例链接可用于再次打开。
- 运行状态提示、失败重试和完整的演示流程是当前重点。现场共用网络时，留意现有 IP 限流；具体并发容量需实际验证，不承诺同时在线人数。

如果之后面向正式用户开放，再评估登录会话、案例所有权、用户额度、任务持久化和多实例协调；这些不作为本次参赛的前置要求。

## 模型传输模式（2026-09-14 起线上为 SDK 直连）

`/etc/background-board.env` 通过 `AGENT_TRANSPORT` 选择模型调用链：

- `AGENT_TRANSPORT=legacy`（默认）：按 `AGENT_API_URL` → OpenCode Server → 知乎直答的旧优先级解析；未设置 `AGENT_API_URL` 时需要保留 `OPENCODE_SERVER_*` 凭证。
- `AGENT_TRANSPORT=sdk`：openai Node SDK 直连 `AGENT_SDK_BASE_URL`（形如 `https://provider.example/v1`，不带 `/chat/completions` 后缀），Bearer 密钥复用 `AGENT_API_KEY`，模型用 `AGENT_MODEL`（注意区分大小写）。缺失必填项时启动报错，不自动回落知乎直答或 OpenCode。
- `AGENT_SDK_STREAM=1` 可开启服务端流式拼装（默认 0）。
- `GUIDANCE_POLICY=fast` 启用 60 秒整轮预算、40 秒单次超时、最多 1 次重试；`legacy` 保持 240/90 秒与 2 次重试。两者可与任意传输组合。

当前线上配置为 `AGENT_TRANSPORT=sdk` + `GUIDANCE_POLICY=fast`（凭证见服务器密钥文件，不入库）。回退到 OpenCode：删除 `AGENT_TRANSPORT`、`GUIDANCE_POLICY` 两行并保留原 `OPENCODE_SERVER_*` 配置，然后 `systemctl restart background-board`。切换前先备份 `/etc/background-board.env`。

回退补充：如果之前在 fast 模式下显式覆盖过 `GUIDANCE_RUN_BUDGET_MS`、`GUIDANCE_MODEL_TIMEOUT_MS`、`GUIDANCE_MODEL_MAX_RETRIES`，仅改回 `GUIDANCE_POLICY=legacy` 不会清除这些覆盖，回退时必须一并恢复原值。无需数据库 schema 回滚。

