# dao-bridge · 独立后端 Agent

把**一台本地电脑**通过 **Cloudflare 快速隧道（`*.trycloudflare.com`）**暴露给云端——零账号、零公网 IP、零端口转发。去中心化，不依赖任何中继 Worker。

> 本目录是**纯 Node 独立后端**（无 VS Code 也能跑：NAS / 路由器 / 容器 / CI）。
> - 想要**随 IDE 自启**的插件形态见 `dao-bridge-ext/`（默认走 Cloudflare 快速隧道，配置账号才走命名隧道）。
> - Android 形态已迁入 `../rt-flow-app/`（独立 APK）。

```
云端 ──HTTPS──▶ https://<random>.trycloudflare.com
                     │  (Cloudflare 快速隧道，临时 URL)
本机 agent.js ──cloudflared 出站──┘  ──▶ 本机执行 ──▶ 真实 stdout 原路返回
```

默认走 Cloudflare 快速隧道（临时 URL，重启会变；插件形态自带看门狗自愈+实时刷新接入文档）。需要稳定 URL 时，配置自己的 Cloudflare 命名隧道。

### 两种穿透模式（`DAO_TUNNEL` 切换）

| 模式 | URL | 适用 |
|---|---|---|
| `cloudflare`（默认） | 动态 `https://<random>.trycloudflare.com`（重启会变） | 零账号、零配置、即开即用 |
| `tailscale` | 固定 `https://<host>.ts.net`（永不变） | 已组 tailnet、要稳定 URL；默认开 funnel 公网可达 |

```bash
# 固定 URL 模式：经 tailscale serve 把本机端口暴露到 tailnet（需先 `tailscale up` 登录）
DAO_TUNNEL=tailscale DAO_TOKEN=<token> node agent.js
# URL 自动从 `tailscale status` 推导；也可显式指定：
DAO_TUNNEL=tailscale DAO_PUBLIC_URL=https://henry.tailf52e02.ts.net DAO_TOKEN=<token> node agent.js
```

> tailscale 模式会自动执行两步：
> 1. `tailscale serve --bg --https=443 http://127.0.0.1:<port>` — 把本机端口反代到 tailnet（tailnet 内可达）。需 tailnet 后台开启 MagicDNS + HTTPS Certificates。
> 2. `tailscale funnel --bg 443` — 把 serve 暴露到公网（公网可达）。需 tailnet 后台 ACL 里开启 Funnel 权限（[nodeAttrs → funnel](https://tailscale.com/kb/1223/funnel#enable-funnel)）。
>
> 设 `DAO_TS_SERVE=0` 可关闭自动 serve（自行管理）；设 `DAO_TS_FUNNEL=0` 可关闭 funnel（仅 tailnet 内可达，不需要 funnel 权限）。

## 启动(本机)

```powershell
# 需要 Node.js 与 cloudflared（PATH 中可用，或用 DAO_CLOUDFLARED 指定路径）
cd addons/dao-bridge
.\start.ps1
```

启动后会拉起 cloudflared 快速隧道，拿到 URL 后打印云端入口：`https://<random>.trycloudflare.com`（Header `Authorization: Bearer <token>`）。token 随机生成、**仅存本机 conn.json、不入库**。

## 云端调用

```bash
curl -X POST https://<random>.trycloudflare.com/api/exec-sync \
  -H "Authorization: Bearer <token>" \
  -d '{"cmd":"hostname"}'
```

支持的 path（透明反代，直打）：`/api/health` `/api/exec` `/api/exec-sync` `/api/info` `/api/ls` `/api/read` `/api/write` `/api/agents` 等。

## 开机自启

```powershell
.\install-task.ps1            # 注册计划任务(登录自启 + 异常自动重启)
.\install-task.ps1 -Remove    # 卸载
```

## 配置(优先级:环境变量 > conn.json > 默认)

| 键 | 说明 | 默认 |
|---|---|---|
| `DAO_TOKEN` | 鉴权 token | 首启随机生成 |
| `DAO_PORT` | 本地 server 端口 | `9920` |
| `DAO_ROOT` | 工作根目录 | 用户目录 |
| `DAO_CLOUDFLARED` | cloudflared 可执行路径 | `cloudflared`（PATH） |
| `DAO_PROXY` | 出站代理（适配国内网络） | 自动探测 |
| `DAO_TUNNEL` | 穿透模式：`cloudflare`(动态) / `tailscale`(固定) | `cloudflare` |
| `DAO_TAILSCALE` | tailscale 可执行路径（仅 tailscale 模式） | `tailscale`（PATH） |
| `DAO_PUBLIC_URL` | 固定公网 URL 覆盖（留空自动从 `tailscale status` 推导） | 空 |
| `DAO_TS_SERVE` | 是否自动跑 `tailscale serve` 暴露端口；设 `0` 关闭自行 serve | `1` |
| `DAO_TS_FUNNEL` | 是否自动跑 `tailscale funnel` 暴露到公网；设 `0` 关闭（仅 tailnet 内可达） | `1` |
