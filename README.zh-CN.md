# iOS 锁屏 ChatGPT 用量

[English](README.md) | **简体中文**

通过服务器上的 Codex CLI 读取 ChatGPT Codex 限额，并在 iPhone 锁屏的
Scriptable 小组件中显示剩余用量与重置时间。

```text
Codex app-server → 本地缓存 API → HTTPS → Scriptable 锁屏小组件
```

服务只向手机返回窗口用量、窗口长度、重置时间和更新时间，不会向公网暴露
Codex app-server、`~/.codex/auth.json` 或 ChatGPT 登录凭据。

## 功能

- 通过官方 [Codex App Server](https://developers.openai.com/codex/app-server)
  的 `account/rateLimits/read` JSON-RPC 方法读取 ChatGPT Codex 限额。
- 自动兼容单窗口和双窗口账号，不硬编码 `5h` 或 `7d`。
- 服务器默认每 5 分钟刷新一次，失败时保留最后一次成功结果并标记为缓存。
- HTTP API 只监听 `127.0.0.1`，使用随机 Bearer Token 鉴权。
- Scriptable 将 URL 和 Token 保存在 iOS Keychain，并缓存最后一次成功结果。
- 显示剩余用量而非已用量，并支持周限额和短时限额两个独立的圆形小组件。
- 小组件请求 15 分钟后的下一次刷新；实际时间由 iOS WidgetKit 决定。

## 1. 服务器准备

需要 Python 3.11+、`uv` 和已登录 ChatGPT 的 Codex CLI：

```bash
codex --version
codex login status
uv --version
```

### 自动安装

在使用 systemd 的 Linux 服务器上，仓库内的安装脚本会生成带随机 Token 的
`.env`、自动选择空闲本地端口、验证 Codex 查询，并安装和启动 user service：

```bash
./scripts/setup-server.sh
```

脚本不会打印生成的 Token。如果 8787 已被其他服务占用，它会自动选择下一个空闲端口，
并将实际端口写入 `.env`。

这台服务器已经使用 Caddy 和 Cloudflare DNS；本地服务健康后，可以单独安装 HTTPS
路由：

```bash
sudo ./scripts/install-caddy-route.sh usage.dttutty.com
```

Caddy 安装脚本会先验证候选配置，再替换现有文件，同时保留带时间戳的备份。
该域名仍需在 Cloudflare DNS 中添加一条指向本服务器、开启代理的记录。

DNS 生效后，运行下面的脚本显示需要填入 iPhone 的两个值：

```bash
./scripts/show-scriptable-config.sh https://usage.dttutty.com/v1/usage
```

下面的命令说明了同一套流程的手动安装方式。

### 手动安装

如果 `codex` 不在 systemd 的 `PATH` 中，先找到它：

```bash
command -v codex
```

复制配置并生成一个只给手机使用的随机 Token：

```bash
cp .env.example .env
openssl rand -hex 32
```

把生成结果填入 `.env` 的 `USAGE_API_TOKEN`，并将 `CODEX_BIN` 改为
`command -v codex` 输出的绝对路径。`.env` 已被 `.gitignore` 排除。

先做一次只读查询，确认 Codex 登录和协议都正常：

```bash
uv run python server.py --once
```

启动本地服务：

```bash
uv run python server.py
```

另开一个终端验证鉴权和数据：

```bash
set -a
source .env
set +a
curl http://127.0.0.1:8787/healthz
curl -H "Authorization: Bearer $USAGE_API_TOKEN" \
  http://127.0.0.1:8787/v1/usage
```

接口响应示例：

```json
{
  "primary": {
    "usedPercent": 26,
    "windowDurationMins": 10080,
    "resetsAt": 1786436095
  },
  "secondary": null,
  "updatedAt": 1785878356,
  "stale": false
}
```

## 2. 后台运行

仓库提供了一个 systemd user service，默认项目路径为
`~/Projects/ios_lockscreen_chatgpt_usage`：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/ios-lockscreen-chatgpt-usage.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ios-lockscreen-chatgpt-usage.service
systemctl --user status ios-lockscreen-chatgpt-usage.service
```

需要在退出 SSH 后继续运行时，可启用 user lingering：

```bash
sudo loginctl enable-linger "$USER"
```

查看日志：

```bash
journalctl --user -u ios-lockscreen-chatgpt-usage.service -f
```

如果仓库不在默认路径，先修改 service 文件中的 `WorkingDirectory`、
`EnvironmentFile` 和 `ExecStart`。

## 3. 配置 HTTPS

不要把 `codex app-server` 或本服务的明文 HTTP 端口直接暴露到公网。
推荐给公网 IP 配一个域名，并用 Caddy 终止 TLS：

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

先将 `usage.example.com` 替换成自己的域名，并让域名的 DNS 记录指向服务器。
Caddy 只需反向代理到 `127.0.0.1:8787`。防火墙只开放 SSH、80 和 443，
不要开放 8787。

如果不希望公开服务，也可以让 iPhone 和服务器加入同一个 Tailscale 网络，并通过
有效 HTTPS 域名访问；无论哪种方式都保留 Bearer Token。

## 4. 安装 Scriptable 小组件

1. 在 iPhone 安装并打开 Scriptable。
2. 新建脚本，把
   [`scriptable/chatgpt-usage-widget.js`](scriptable/chatgpt-usage-widget.js)
   的内容完整复制进去。
3. 手动运行一次脚本，填写 `https://你的域名/v1/usage` 和 `.env` 中的 Token。
4. 长按锁屏进入自定义界面，在小组件区域添加两个圆形 Scriptable 小组件。
5. 点击第一个小组件，选择这个脚本，并将 Parameter 设置为 `weekly`。
6. 点击第二个小组件，选择这个脚本，并将 Parameter 设置为 `short`。

两个小组件使用同一份脚本。`weekly` 会选择时长最长的限额窗口，`short` 会选择
短于一天的窗口。显示的是剩余用量，而不是已用量：

```text
┌─────────┐  ┌─────────┐
│ 1W LEFT │  │ 5H LEFT │
│   70%   │  │    —    │
│  ↻ TUE  │  │   N/A   │
└─────────┘  └─────────┘
```

`N/A` 表示服务器没有返回该限额窗口；脚本不会把未知数据错误显示成 `0%` 或
`100%`。如果更喜欢单个矩形组件，可以添加矩形 Scriptable 小组件，并将
Parameter 留空（或设置为 `combined`）。

在 Scriptable 中手动运行脚本时，菜单可以分别预览周限额圆形组件、5 小时圆形
组件和合并矩形组件。

`refreshAfterDate` 只是向 iOS 请求“不早于 15 分钟后刷新”。WidgetKit 会根据
刷新预算、电量和使用频率决定实际执行时间，因此锁屏组件无法保证精确每 15 分钟刷新。

## 安全边界

- 不要把 `~/.codex/auth.json`、ChatGPT Cookie 或 OAuth Token 放进 Scriptable。
- 不要监听 `0.0.0.0` 后再直接暴露 8787；让 Caddy 或其他 HTTPS 反向代理访问
  loopback 服务。
- 为此服务单独生成高熵 Token；怀疑泄漏时立刻更换 `.env` 并重启服务。
- GitHub 仓库只提交 `.env.example`，绝不提交真实 `.env`。

## 开发与测试

```bash
uv run python -m unittest discover -s tests -v
uv run python -m compileall -q server.py tests
```

Codex app-server 仍属于实验接口。升级 Codex CLI 后，建议先运行 `--once` 和测试，
确认当前版本响应仍可解析，再重启后台服务。
