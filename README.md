<div align="center">
  <h1>Unified Inbox</h1>
  <p><em>把散落在各处的邮箱收进一个自托管的网页收件箱，跑在 Cloudflare Workers 免费版上</em></p>
</div>

Unified Inbox 是 [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) 的个人分支。目标是把 Gmail、Outlook/Hotmail、163、论坛通知、自有域名邮件等十几个邮箱汇总到同一个列表里，统一阅读、整理和删除，删除/归档会尽量同步回源邮箱。

发信（写信、回复、转发）通过 [Resend](https://resend.com) 发出：在「设置 → 发信」里粘贴 Resend API Key，发件地址从 `SEND_FROM` 列表里选。

## 功能

- **统一收件箱**：所有来源合并为一个邮箱（`UNIFIED_MAILBOX`），一个列表按时间排列，每页 25 封。
- **多种来源**
  - **Gmail（OAuth）**：应用内「用 Google 登录」接入，refresh token 存在 Durable Object 里。删除/归档会镜像回 Gmail；Gmail 里删除或移出 INBOX 的邮件，也会同步到这里的垃圾箱/归档。
  - **IMAP（授权码）**：如 163、QQ 等，在应用内表单添加。只拉取，不回写。
  - **POP3**：只拉取。
  - **转发**：任何 `@你的域名` 地址都能收（Email Routing catch-all → Worker），适合 Outlook/Hotmail、论坛通知等。
- **同步频率**：Cron 每分钟拉取 IMAP/POP/Gmail 新邮件；Gmail 远端归档/删除的对账每 5 分钟一次。首次同步回溯 `IMAP_INITIAL_DAYS` 天。
- **验证码转 Telegram**：识别验证码邮件，推送到 Telegram Bot，原邮件放进「验证码」文件夹，24 小时后自动清除。设置里可随时开关，Bot token 存在 DO 中。
- **Agent 只读 API**：在设置 →「Agent 只读访问」生成 Bearer token（只显示一次，可限定来源、可撤销），供外部 agent 只读查询：
  - `GET /api/everest/inbox?since=<时间>&limit=50`：增量拉取，返回 `emails`、`next_since`、`has_more`
  - `GET /api/everest/search?q=<关键词>&from=<发件人>`
  - `GET /api/everest/mail?id=<id>`：读取正文

  该 API 只在 `AGENT_API_HOST` 指定的独立域名上提供，不经过 Cloudflare Access，只认 token。
- **列表操作**：勾选多封（或表头全选当前页）后批量标记已读/未读、归档、删除。删除先进垃圾箱，在垃圾箱里再删才是彻底删除；操作作用到整个会话，Gmail 来源会同步回源邮箱。
- **邮件分类（推广 / 垃圾邮件）**：新邮件入库时自动分到收件箱、「推广」或「垃圾邮件」，判断顺序：
  1. **发件人规则**：总是收件箱 / 推广 / 垃圾邮件，先匹配完整地址再匹配域名。规则可在设置里手动增删，也会从你的操作中学习：把邮件移进垃圾邮件或推广，就为该发件人记一条对应规则；从这两个文件夹移回收件箱或归档，就记为「总是收件箱」。
  2. 回复你自己发出邮件的、含验证码的邮件，始终留在收件箱。
  3. **可选模型分类**：在设置里填写 OpenAI 兼容端点、模型名和 API 密钥并开启后，规则判断不了的邮件交给模型决定（只发送发件人、主题和正文前 1500 字）。密钥只存在 Durable Object 里，不会返回给前端。调用失败时回退到下一步。
  4. **邮件头判断**：DMARC/SPF 失败、显示名冒充其他地址、Reply-To 域名不一致、常见垃圾词等累计打分，超过阈值进垃圾邮件；带 `List-Unsubscribe`、`Precedence: bulk`、营销平台邮件头且主题不像账单、订单、安全通知的，进推广。

  自动分类只在本地移动，不会改动源邮箱；手动移到垃圾邮件仍按原逻辑同步回 Gmail。设置里的「整理现有收件箱」会对从未分类过的旧邮件应用规则和邮件头判断（不调用模型，每次 300 封）。列表多选后可直接标为垃圾邮件、移到推广，或标为「不是垃圾邮件 / 不是推广」；邮件详情里用「移动到」文件夹也有同样的学习效果。
- **中英文界面**：所有界面文字都有中文和英文两套，在设置页顶部切换，选择保存在当前浏览器（`localStorage` 的 `ui-lang`），默认跟随浏览器语言。日期格式随语言变化。文案集中在 `app/lib/i18n.ts`。
- **正文渲染**：HTML 邮件原样显示（沙箱 iframe）；Markdown 邮件按 GFM 渲染；纯文本保留换行并自动识别链接。手机上宽邮件会自动重排或缩放。
- **PWA**：可添加到手机主屏幕，独立窗口运行，适配移动端（dvh 布局、iOS 输入框不缩放）。
- **AI 侧边栏**：保留上游的 Email Agent（Workers AI），可读取、搜索邮件；发送类操作在只收模式下不可用。上游的 `/mcp` 端点已关闭。

## 架构

```
 Gmail (OAuth) ─┐
 IMAP / POP3 ───┤  Cron 每分钟拉取
                ▼
 转发邮件 ──> Email Routing ──> Hono Worker ──> MailboxDO（SQLite，每个邮箱一个）
                                 │   │            └── R2：附件、邮箱设置
         浏览器 / PWA ──Access──┘   │
         外部 agent ──Bearer token──┘ (AGENT_API_HOST，只读)
```

- **前端**：React 19、React Router v7、Tailwind CSS、Zustand、`@cloudflare/kumo`
- **后端**：Hono、Cloudflare Workers、Durable Objects（SQLite）、R2、Email Routing、Cron Triggers
- **认证**：网页端走 Cloudflare Access（生产环境必须）；Agent API 走 Bearer token

## 部署

### 前提

- Cloudflare 账号和一个托管在 Cloudflare 的域名，开启 Email Routing
- Workers 免费版即可（拉取任务已拆小，避开 10ms CPU 限制）
- 可选：Google Cloud OAuth 客户端（接入 Gmail 用）、Telegram Bot（验证码推送用）、任一 OpenAI 兼容模型 API（邮件分类用）

### 步骤

1. **安装依赖**

   ```bash
   npm install
   ```

2. **创建 R2 存储桶**

   ```bash
   npx wrangler r2 bucket create unified-inbox
   ```

3. **复制配置**，再修改 `wrangler.jsonc`（已加入 `.gitignore`，你的域名和 Access 配置不会被提交）：

   ```bash
   cp wrangler.example.jsonc wrangler.jsonc
   ```

   `routes` 里的两个 custom domain 分别是网页端和 Agent API，按需修改或删掉（只用 `*.workers.dev` 也可以）。`vars` 说明：

   | 变量 | 说明 |
   | --- | --- |
   | `DOMAINS` | 收信域名，如 `example.com` |
   | `UNIFIED_MAILBOX` | 汇总到的邮箱地址，如 `inbox@example.com` |
   | `SEND_FROM` | 允许的发件地址列表，如 `["you@example.com"]`；域名需先在 Resend 验证 |
   | `IMAP_INITIAL_DAYS` | 首次同步回溯天数，默认 90 |
   | `AGENT_API_HOST` | Agent 只读 API 的独立域名（同时在 `routes` 里配置为 custom domain） |
   | `POLICY_AUD` / `TEAM_DOMAIN` | Cloudflare Access 的应用 AUD 和团队域名 |

4. **设置 secrets**（接入 Gmail 时需要）

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   Google Cloud 里创建「Web 应用」类型的 OAuth 客户端，并把应用发布为「正式版」，否则每 7 天要重新登录。

   回调地址按你打开网页时的域名生成，所以**每个用来访问的域名都要登记一条**重定向 URI，例如：

   ```
   https://unified-inbox.<你的子域>.workers.dev/oauth/google/callback
   https://mail.example.com/oauth/google/callback
   ```

   漏登记会在 Google 登录页看到「不符合 Google 的 OAuth 2.0 政策」。已接入的 Gmail 不受影响，token 与域名无关。

5. **部署**

   ```bash
   npm run deploy
   ```

   部署脚本会先构建，再把静态资源嵌入 Worker 包（`scripts/embed-assets.mjs`），然后 `wrangler deploy`。

6. **部署后**
   - **Cloudflare Access**：网页端的所有域名（`workers.dev` 和自定义域名）都要被 Access 保护。在 Worker 的 Settings → Domains & Routes 开启一键 Access，把弹窗里的 `POLICY_AUD`、`TEAM_DOMAIN` 填进配置。
   - **Agent API 放行**：在 Access 里给 `<AGENT_API_HOST>/api/everest` 加一条 Bypass 策略；如果开了 Bot Fight Mode，需要关闭，否则外部 agent 会被人机验证拦下。
   - **Email Routing**：域名 → Email Routing 建 catch-all 规则，指向这个 Worker。
   - 打开网页，在设置里添加 Gmail / IMAP / POP3 来源，按需开启验证码转 Telegram、配置邮件分类模型、生成 Agent token。

### 本地开发与测试

```bash
npm run dev
for f in test/*.test.ts; do npx tsx "$f"; done   # IMAP、网易 IMAP、POP3、验证码识别、邮件分类的测试（node:assert 脚本）
```

## 已知限制

- 发信依赖 Resend：Key 未配置时发送会直接报错；发件域名必须在 Resend 验证过。发出的邮件 Message-ID 由 Resend 生成，与「已发送」里保存的不同。
- Outlook/Hotmail 个人邮箱已不支持应用密码登录 IMAP，只能走转发，删除不会同步回去。
- IMAP（授权码）和 POP3 来源只拉取，不回写删除/归档。
- 删除整个邮箱时只删除了 R2 里的邮箱设置，Durable Object 中的数据和 R2 附件还没清理；用同一地址重建会看到旧邮件。单封邮件删除时附件会一并清除。
- 邮件头判断是简单规则，可能误判；推广和垃圾邮件文件夹不会自动清理，建议定期看一眼，误判的移回收件箱即可让该发件人以后不再被误分。
- 界面语言按浏览器保存，换设备需要重新选择。
- Cloudflare Access 是唯一的网页端信任边界：通过 Access 的人可以访问所有邮箱。

## 许可

Apache 2.0，见 [LICENSE](LICENSE)。基于 [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox)。
