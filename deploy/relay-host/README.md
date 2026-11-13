# 172.17.13.62 端口转接

同事访问 **http://172.17.13.62/**，流量这样走：

```
同事浏览器
   → 172.17.13.62:80          systemd-socket-proxyd（本目录脚本安装，root）
   → 172.17.13.62:127.0.0.1:3000   反向 SSH 隧道（WSL 的 regwatch-relay.service 维持）
   → 本机 WSL 127.0.0.1:3000   web（SSR + /api 代理到 3001）
```

## 为什么是反向隧道

WSL 的 web 只监听 `127.0.0.1:3000`，Windows 防火墙也不会让 .62 直接访问
`172.17.188.68:3000`。反向隧道由本机主动连出去，所以：

- 不用在 Windows 上开防火墙端口，3000/3001 继续只给本机用
- 本机 IP 变了也不用改 .62 的配置
- .62 上只需要一个监听 80 的 socket 代理

## 一次性安装（在 .62 上，需要 root）

```bash
scp deploy/relay-host/install-web-relay.sh zkye@172.17.13.62:~/
ssh 172.17.13.62 'sudo bash ~/install-web-relay.sh'
```

脚本会写两个 unit 并启用：

- `/etc/systemd/system/regwatch-web.socket`：`ListenStream=80`
- `/etc/systemd/system/regwatch-web.service`：`systemd-socket-proxyd 127.0.0.1:3000`

最后用 `curl http://127.0.0.1/api/health` 自检。返回
`{"ok":true,...}` 就说明隧道和本地栈都通了。

## 本机这一侧

`deploy/systemd-user/regwatch-relay.service` 由 `regwatch.target` 拉起：

```bash
systemctl --user status regwatch-relay
journalctl --user -u regwatch-relay -f
```

它用 `~/.ssh/regwatch-relay` 这把专用密钥连 `zkye@172.17.13.62`，
在对面绑 `127.0.0.1:3000`，断线每 10 秒重连。公钥已经写进 .62 的
`~/.ssh/authorized_keys`。

## 验证

```bash
# 本机
curl -s http://127.0.0.1:3000/api/health

# .62 上（隧道终点）
curl -s http://127.0.0.1:3000/api/health

# .62 上（公网入口）
curl -s http://127.0.0.1/api/health

# 任意同事机器
curl -s http://172.17.13.62/api/health
```

## 排错

| 现象 | 检查 |
|---|---|
| `172.17.13.62` 拒绝连接 | .62 上 `systemctl status regwatch-web.socket` |
| 502 / 连接被重置 | 本机 `systemctl --user status regwatch-relay`，.62 上 `ss -lntp \| grep :3000` 是否有人监听 |
| 隧道反复重连 | `journalctl --user -u regwatch-relay -n 50`，确认 .62 的 sshd 允许 `AllowTcpForwarding`（默认允许） |
| 页面能开但链接跳到 127.0.0.1 | `.env.local` 的 `SITE_URL` 要写成 `http://172.17.13.62:80`，然后重启 `regwatch-web` |

## 卸载

```bash
sudo systemctl disable --now regwatch-web.socket
sudo rm /etc/systemd/system/regwatch-web.socket /etc/systemd/system/regwatch-web.service
sudo systemctl daemon-reload
```

本机再 `systemctl --user disable --now regwatch-relay`。
