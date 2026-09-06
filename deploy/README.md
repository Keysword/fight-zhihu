# 背景板部署

运行时位于 `/srv/background-board`，systemd 只监听 `127.0.0.1:3210`，Nginx 对外提供 `/background-board/`。SQLite 状态单独保存在 `/srv/background-board/data`，不会随版本切换丢失。

首次安装：

1. 通过标准输入或宿主 Secret Store 创建 `/etc/background-board.env`；不要把密钥写入仓库或 shell 参数。部署脚本会校正所有者和 `0600` 权限，但不会生成或覆盖 Secret。
2. 在目标 TLS server 中加入 `include /etc/nginx/snippets/background-board.conf;`。脚本会安装 snippet，并在发现 active 配置没有该 location 时中止。
3. 执行 `./deploy/deploy.sh`。脚本会幂等创建系统用户和运行目录、安装 systemd unit/snippet、验证 Nginx、完成原子发布，并检查本机和公网健康端点。

回滚到上一版本：

```bash
previous=$(cat /srv/background-board/previous-release)
ln -sfn "$previous" /srv/background-board/current.next
mv -Tf /srv/background-board/current.next /srv/background-board/current
systemctl restart background-board
```

验证：

```bash
curl --fail http://127.0.0.1:3210/background-board/api/health
curl --fail https://projects.wangjian7410.cc/background-board/api/health
```
