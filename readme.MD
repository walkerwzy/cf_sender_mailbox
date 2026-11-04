# CF Sender Mailbox · 私人邮局

使用 Cloudflare Workers + Static Assets 托管邮件页面，通过 Resend 发送邮件、读取发件箱，支持 Cloudflare Access 邮箱验证码和可选的每日密码登录。发件人始终为 `walker <登录邮箱>`，邮件页面及接口始终验证身份。

示例配置允许 `admin@wzy.one`、`hi@wzy.one` 登录，并使用 `mail.wzy.one` 作为页面域名。部署到自己的账号时，在 `.env.deploy` 中设置 `ALLOWED_EMAILS` 和 `APP_DOMAIN`；发件邮箱所属域名需要通过 Resend 验证。

## 本地开发

需要 Node.js 22+，推荐 Node.js 24。安装依赖后即可使用项目内的 Wrangler 和 workerd，无需全局安装。

```sh
git clone git@github.com:walkerwzy/cf_sender_mailbox.git
cd cf_sender_mailbox
npm ci
```

```sh
npm run dev
```

打开 `http://127.0.0.1:8787`。这是独立的本地预览入口，模拟 `admin@wzy.one` 登录，发送按钮只模拟成功。发件箱提供示例邮件，并保留进程内最近 20 封模拟邮件供预览；重启后重置，不连接 Resend。生产入口没有跳过鉴权的开关。

```sh
npm test
npm run check
npm run build
```

## 命令行部署

复制配置模板并填写自己的凭证；已有配置时直接编辑 `.env.deploy`。

```sh
cp .env.deploy.example .env.deploy
chmod 600 .env.deploy
```

```dotenv
CLOUDFLARE_API_TOKEN=你的CloudflareToken
RESEND_API_KEY=你的ResendToken
```

启用密码和邮箱验证码两种登录方式，在 `.env.deploy` 填写：

```dotenv
LOGIN_PASSWORD=你的固定密码前缀
```

每日登录密码为该值原样拼接当天的 `MMDD`，日期固定按北京时间（Asia/Shanghai）计算。例如前缀为 `mypass`，11 月 4 日输入 `mypass1104`，1 月 2 日输入 `mypass0102`。密码登录时选择 `admin@wzy.one` 或 `hi@wzy.one`，选择的邮箱成为发件地址。共享密码允许使用这两个地址；验证码登录的邮箱由 CF 验证。

填写后运行 `npm run deploy:worker`，脚本会将密码前缀作为 Worker Secret 上传，自动生成并复用 `.deploy/session-secret` 中的会话签名密钥。也可以自行提供至少 32 个字符的 `SESSION_SECRET`。这些值应保存在本地配置文件，不要贴到对话中。保留 `.deploy/session-secret` 可避免每次更新都重置登录会话。

双登录模式下，`/login` 提供密码和验证码两个入口；Cloudflare Access 保护 `/auth/access`，验证码验证成功后 Worker 校验 Access JWT，并签发本站的会话 Cookie。密码验证成功也签发会话 Cookie，两种身份都由服务端签名，Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax` 和 host-only 范围。密码会话在北京时间午夜过期；验证码会话最长 24 小时，且不会超过 Access JWT 的有效期。退出登录清除本站 Cookie，验证码登录还会退出 CF 会话。

将 `LOGIN_PASSWORD` 留空并重新部署，则恢复整个域名的 CF Access 保护和仅验证码登录。更改密码前缀会使旧密码会话失效；更改 `SESSION_SECRET` 会使全部本站会话失效。

当前配置使用 `APP_DOMAIN=mail.wzy.one`，部署时绑定此自有域名，并关闭默认 workers.dev 地址及预览地址。将 `APP_DOMAIN` 留空则使用 `sendmail-cf.<账号子域名>.workers.dev`。

### Cloudflare Token

可复用已有 Token，或在 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建 Custom Token。配置下列权限，并将账号范围限制到你的账号：

| 范围 | 权限 | 级别 | 用途 |
| --- | --- | --- | --- |
| Account | Workers Scripts | Edit | 部署 Worker 和 Secret |
| Account | Account Settings | Read | 发现账号和 workers.dev 子域名 |
| Account | Access: Apps and Policies | Edit | 创建应用及登录邮箱策略 |
| Account | Access: Organizations, Identity Providers, and Groups | Edit | 创建或读取 Zero Trust 组织和邮箱验证码登录 |
| Zone | Zone | Read | 查找 `wzy.one` 的 DNS Zone |
| Zone | DNS | Edit | 添加 Resend 的发送 DNS 记录 |
| Zone | Workers Routes | Edit | 首次部署或重新绑定自有页面域名 |

Zone 范围选 `wzy.one`。如果 Resend 已验证发件域名，部署不会修改 DNS，可以不授予 DNS Edit。自有页面域名还需 Zone → Workers Routes → Edit。

如果 Token 能访问多个账号，在 `.env.deploy` 填写 `CLOUDFLARE_ACCOUNT_ID`。如已有 Zero Trust 组织，脚本自动复用；没有则尝试创建 `walker-<账号ID前10位>.cloudflareaccess.com`。

如果账号返回 `access.api.error.not_enabled`，脚本会先尝试通过组织 API 初始化；若仍被阻止，需要在 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) 选择对应账号，完成首次设置并选择 Free 套餐，再运行部署。API 返回的“到 dash.cloudflare.com 点击 Enable Access”提示可能与当前界面不一致。完成首次设置后，`ACCESS_TEAM_DOMAIN` 仍可留空，让脚本读取已有组织。

### Resend Token

在 [Resend API Keys](https://resend.com/api-keys) 获取 Token。自动配置域名、读取发件箱均需要 Full access 权限。最少配置为一个 Full access 的 `RESEND_API_KEY`，发送和读取共用此 Key。

也可以分开配置：

| 变量 | 用途 | 权限 | 上传 Worker |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | 发送邮件；未指定读取 Key 时也用于读取 | Sending access 或 Full access | 是 |
| `RESEND_READ_API_KEY` | 可选，单独读取发件箱 | Full access | 配置时上传 |
| `RESEND_ADMIN_API_KEY` | 可选，命令行管理发件域名；未指定时用发送 Key | Full access | 否 |

如果现有 `RESEND_API_KEY` 只有 Sending access，在 `.env.deploy` 补充 `RESEND_READ_API_KEY=你的FullAccessKey`，再运行 `npm run deploy:worker`。Resend 没有独立的只读 Key 权限；读取 Key 应始终保存在服务端 Secret 中。`RESEND_ADMIN_API_KEY` 只用于本地部署，不会自动转用或上传给发件箱。读取授权失败会显示错误，不影响发送邮件。

### 发件箱

Resend 提供 [已发送邮件列表](https://resend.com/docs/api-reference/emails/list-emails)（`GET /emails`）及 [邮件详情](https://resend.com/docs/api-reference/emails/retrieve-email)（`GET /emails/{id}`）。登录后点击侧栏或手机顶部的「发件箱」，可刷新、加载更早记录，并查看主题、收件人、发送时间、投递状态及正文；详情包含抄送、密送和回复地址。页面切换会保留正在编辑的邮件。

本站接口为 `GET /api/outbox`、`GET /api/outbox?cursor=<上一页的next_cursor>` 和 `GET /api/outbox/{id}`。列表返回 `data`、`has_more`、`next_cursor`。两种登录方式均按当前已验证的发件邮箱过滤列表，详情再次检查发件地址；其他邮箱的邮件返回 404。分页游标经过加密，绑定当前邮箱、站点和读取 Key，1 小时后失效。

每页只向 Resend 请求一次，最多读取 100 条记录后在服务端过滤。如果这一页都是其他邮箱的邮件，结果可能为空但仍有下一页，点击「加载更多」继续即可。状态来自 Resend 的 `last_event`，时间显示为北京时间。读取每个邮箱、每个 Cloudflare 数据中心每分钟最多 30 次；Resend 自身的限流也可能要求稍后重试。

发件箱查询读取 Key 可访问的 Resend 发送记录，可能包含同一邮箱通过其他工具发出的邮件。历史记录和正文是否仍可查询以 Resend 的保留范围为准；项目没有另建邮件存储或收件箱。HTML 正文以源码显示，不执行脚本或加载远程图片。

```sh
npm run deploy
```

部署脚本会：

上传之前先检查自有域名的 Zone 和 Workers 路由访问权限。失败时自动分析错误，并将本次输出保存在 `.deploy/deploy.log`。Wrangler 的详细日志位于 `.deploy/wrangler.log`。

1. 查找 Cloudflare 账号、Zero Trust 组织及 workers.dev 子域名。
2. 检查 Resend 的 `wzy.one` 发件域名，缺少时创建；添加 DKIM、SPF 及 `send.wzy.one` 的反馈 MX 记录，并触发验证。
3. 配置邮箱验证码登录和两位成员的 Access 策略，规划所选登录方式对应的保护范围。
4. 部署静态页面、Worker、JWT 验证配置、限流绑定和 Resend Secret。
5. Worker 发布成功后同步本项目的 Access 保护范围，再检查匿名请求和登录入口，输出页面地址。

已有的不同 DNS 记录不会被覆盖，根域名的收信 MX 不会被修改。DNS 验证若暂未完成，稍后重新运行同一命令即可。重复运行复用本项目的 Access 应用和策略；发现同域名的其他应用会停止。

```sh
npm run deploy:check
```

检查 Resend 发件域名、Access 邮箱验证码及成员策略与保护范围、Worker 线上变量和 Secret 名称（包括配置的读取 Key）、静态资源与发送/登录/发件箱限流绑定、自有域名绑定、workers.dev 与预览地址开关，以及所选登录方式的页面和接口行为。不修改线上配置，不发送邮件。此命令不读取真实邮件；读取 Key 是否有效及具备 Full access 需登录发件箱确认。

若已在 Cloudflare 后台手动绑定 `mail.wzy.one`，先运行此检查命令即可。只读检查使用账号级 Workers API，不要求 Zone → Workers Routes → Edit；重新部署仍需要此权限。检查通过后，打开页面用允许的邮箱登录，并实际发一封邮件确认结果。Secret 检查只确认密钥存在，不能证明发送 Key 有效或邮件已投递。

`npm run deploy` 每次重新检查并复用已有的 Zero Trust 组织、发件域名、DNS 记录、Access 应用和策略，然后重新上传 Worker 与静态资源。它会补齐缺项，也会更新本项目的 Access 配置；并非从日志记录的某一行继续。手动绑定域名不会绕过部署所需的 Token 权限检查。`.deploy/state.json` 只在所有上线检查通过后写入，缺少此文件不能单独证明 Worker 没有上传。

已有 Worker、Access 和发件域名，更新代码时可以运行：

```sh
npm run deploy:worker
```

通过 Workers Versions 上传代码、静态资源、环境变量和 Secret，再将本次版本发布到全部流量，保留现有自有域名绑定和路由。这种更新方式适合手动绑定域名后的修复，不需要 Zone → Workers Routes → Edit。Access 组织和 Resend 域名使用只读检查；登录方式发生变化时，会在新 Worker 发布后更新本项目的 Access 应用保护范围，因此仍需 Account → Access: Apps and Policies → Edit。缺少首次配置时，应先完成首次部署。更新失败的日志同样保存在 `.deploy/deploy.log`。

```sh
npm run deploy:diagnose
```

分析已有的部署日志，区分连接中断、DNS 解析、连接超时、代理拒绝连接、TLS 证书、明确的沙箱限制、Workers 路由权限不足、Access 尚未启用、Resend 权限不足及 DNS 验证等待等情况。

部署中的只读 API 请求遇到 `ECONNRESET` 等短暂连接错误，或 HTTP 429/500/502/503/504，会最多尝试 3 次，间隔通常为 1 秒和 2 秒。写入请求不会自动重复，以免连接断开时重复创建配置；重新运行部署会先读取已有状态。

`ECONNRESET` 表示连接在传输中被断开，可能来自网络、VPN/代理或 API 上游，不能直接归因为权限不足。可在报错的同一终端对比以下两个不带 API Key 的连接测试；返回 HTTP 401 表示请求到达了 Resend：

```sh
curl --connect-timeout 10 --max-time 20 -sS -o /dev/null -w 'HTTP %{http_code}\n' https://api.resend.com/domains
node --input-type=module -e 'try { const r = await fetch("https://api.resend.com/domains", { signal: AbortSignal.timeout(20000) }); console.log("HTTP", r.status); await r.body?.cancel(); } catch (e) { console.error(e.cause?.code || e.name); process.exitCode = 1; }'
```

如果 curl 能连接而 Node 不能，且终端已设置 `HTTP_PROXY` 或 `HTTPS_PROXY`，Node 24 可以用 `NODE_USE_ENV_PROXY=1 npm run deploy:worker` 启用这些代理变量。若没有设置代理变量，这个开关不会自动读取代理软件或 macOS 的代理配置。

## 功能及验证范围

支持纯文本、HTML 源码、多个收件人、抄送、密送及回复地址。每封最多 20 位收件人，正文最多 60,000 个字符，提交 JSON 最多 128 KiB。Cloudflare 的发送限流按登录邮箱计数，配置为每个数据中心每分钟 5 次请求。

密码登录单独按客户端 IP 限流，每个数据中心每分钟最多 10 次尝试；登录和退出接口都拒绝跨站提交。登录 JSON 最多 4 KiB，密码前缀最多 508 个字符。

发件地址在服务端从已验证的 Access JWT 或本站签名会话取得；前端无法覆盖。重复提交使用 Resend Idempotency-Key，内容不变的失败重试会复用编号。生产环境不持久保存邮件草稿或正文；发送成功表示 Resend 接受请求，不等同于已投递到收件箱。

自动测试覆盖 JWT 签名与授权、静态资源保护、动态发件人、发送调用、重试、跨站请求、限流、发件箱归属检查、加密分页、读取权限错误及 DNS 冲突处理，并在 workerd 运行时验证实际公钥请求、两种登录、模拟发送、发件箱列表及详情、加密分页和拒绝上游重定向。运行时测试使用本地服务，不监听端口，不发送真实邮件。部署流程及真实 Resend 接口需要实际账号凭证和网络才能完成在线验证。

受限命令执行环境可能同时禁止外网访问和监听本地端口。这种情况下单元测试与打包仍可运行；本地预览及在线部署需要在具备相应网络权限的终端中执行。Codex 的命令进程和普通终端可能采用不同权限；如果进程设置了 `CODEX_SANDBOX_NETWORK_DISABLED=1`，网络连接失败时脚本会明确提示此限制。切换 Bash 或重复安装 Wrangler 不会改变这项网络限制。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `src/` | Worker、Access JWT 验证、本站会话和发件箱读取 |
| `public/` | 登录页、邮件编辑页、发件箱和静态资源 |
| `scripts/` | 部署、Access 配置迁移、域名验证和失败诊断 |
| `test/` | Node.js 测试及 workerd 运行时测试 |

`.gitignore` 排除真实环境配置、签名密钥、部署状态与日志、构建产物、依赖目录及本地会话记录。仓库只包含空的 `.env.deploy.example` 模板；每台开发或部署机器需要自行准备 `.env.deploy`。
