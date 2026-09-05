# 背景板部署

运行时位于 `/srv/background-board`，systemd 只监听 `127.0.0.1:3210`，Nginx 对外提供 `/background-board/`。SQLite 状态单独保存在 `/srv/background-board/data`，不会随版本切换丢失。

首次安装：

1. 创建系统用户 `background-board` 和运行目录。
2. 将 `background-board.service` 安装到 `/etc/systemd/system/`。
3. 将 Nginx location snippet 安装到 `/etc/nginx/snippets/background-board.conf`，并在 `projects.wangjian7410.cc` 的 TLS server 中 include。
4. 通过标准输入或宿主 Secret Store 创建 `/etc/background-board.env`，权限设为 `0600`；不要把密钥写入仓库或 shell 参数。
5. 执行 `./deploy/deploy.sh`。

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
