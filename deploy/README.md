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

## SDK 直连传输与 fast 策略（本轮未灰度，仅预留开关）

模型传输由 `AGENT_TRANSPORT` 控制：`legacy`（默认，保持原 `AGENT_API_URL` → OpenCode → 知乎直答顺序）或 `sdk`（OpenAI Node SDK 直连 `AGENT_SDK_BASE_URL`，需要同时显式配置 `AGENT_API_KEY`、`AGENT_MODEL`；缺失时启动报明确配置错误，不会回落旧路由或知乎直答）。`AGENT_SDK_STREAM=1` 启用流式传输（服务端聚合后才做协议校验）。指导预算策略由 `GUIDANCE_POLICY` 控制：`legacy`（默认，240s 整轮 / 90s 单次 / 2 次重试）或 `fast`（60s 整轮 / 40s 单次 / 1 次重试 / 1 次搜索 / 3 步）。

本轮（2026-09-13 评测）**未部署、未切换任何线上配置**。未来灰度的推荐路径：先在一个独立实例上设置 `AGENT_TRANSPORT=sdk` 与所需 `GUIDANCE_POLICY`，确认质量门禁后再切换线上；切换时保留原有 `AGENT_API_URL`/OpenCode 凭证，不得删除旧链路。

回退（如已获授权灰度后需要回退）：把 `/etc/background-board.env` 中 `AGENT_TRANSPORT` 改回 `legacy`、`GUIDANCE_POLICY` 改回 `legacy`，并一并恢复原有 `GUIDANCE_RUN_BUDGET_MS`、`GUIDANCE_MODEL_TIMEOUT_MS`、`GUIDANCE_MODEL_MAX_RETRIES` 的显式覆盖值（仅改 policy 不会清除 fast 的显式环境覆盖），然后按原发布流程重启实例。无需数据库 schema 回滚。

