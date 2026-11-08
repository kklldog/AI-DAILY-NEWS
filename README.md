# AI News Daily Report

面向 Linux / systemd 的中文 AI 日报程序：每天北京时间 **22:00** 收集当天报道，
直接调用 GPT Responses API 写稿，本地绘制封面，先发送完整邮件预览；
只有收件人回复对应预览邮件、正文只写 **`确认`**，才会通过浏览器保存公众号草稿并发表。
**不依赖 Copilot CLI，不默认无人审核发表。**

本仓库整理自实际部署源码，保留 `.agents/skills` 布局和运行所需的本地修改版
`baoyu-post-to-wechat`。没有包含密钥、真实邮件、日报产物或浏览器登录数据。

## 功能与边界

- 从 IT之家、量子位、雷峰网、爱范儿、InfoQ、AI智库导航发现中文资讯，可核对其他公网中文来源。
  按北京时间当天的**报道日期**选取最多 6 条，单独说明事件时间；不足不凑数，0 条仅发送无新闻通知。
- 直接使用配置的 Responses API，校验文章结构、来源、日期、数量及长度；封面由本地 HTML / Chrome 渲染。
- SMTP 邮件含完整正文、封面和 Markdown 附件；默认 `PUBLISH_MODE=preview`，预览阶段不操作公众号。
- IMAP 约每分钟检查回复，通过随机主题编号、允许发件人、精确“确认”和文章/封面 SHA-256 绑定批准。
  支持显式配置 `MAIL_APPROVERS` 邮箱别名，忽略手机邮件的引用内容。
- 发布阶段复用已审阅内容，保留公众号首页 token、可配置的 `WECHAT_AUTHOR` 和 8 字作者预检。
  登录或管理员“微信验证”需要扫码时发邮件；失败或发表结果不确定时停止，不盲目重复发表。

邮件确认依赖邮箱及其反伪造保护，不能替代公众号内容审核。不要转发含审批编号的预览，
不要伪造确认邮件进行真实发布测试，也不要把 `DRY_RUN=1` 当成离线测试：
它仍会抓取新闻、调用收费 API、生成封面并发送邮件。

## 目录

| 路径 | 内容 |
|---|---|
| `.agents/skills/ai-daily/scripts/` | 写稿、封面、邮件审批、浏览器发布、测试、npm 锁文件 |
| `.agents/skills/ai-daily/server/` | 安装器、Bash 入口、systemd 单元、示例配置及详细部署文档 |
| `.agents/skills/baoyu-post-to-wechat/` | 本地修改版公众号脚本、测试、参考文档、Bun 锁文件及上游 MIT 许可证 |
| `.baoyu-skills/baoyu-post-to-wechat/EXTEND.example.md` | 不含个人信息的可选偏好模板 |
| `THIRD_PARTY_NOTICES.md` | 第三方来源、许可及本地修改说明 |

## 安装到用户目录

适用于带 systemd 用户服务的 Ubuntu / Debian，使用有 `sudo` 权限的**普通用户**，
不要以 root 运行安装器。需要访问新闻站点、模型服务、SMTP/IMAP 和公众号网站。
安装器会安装浏览器、Xvfb、字体和剪贴板工具；Node.js 低于 22 时安装用户私有 Node 22，
Bun 也安装到该用户的专用目录，不修改系统 Node 或全局 npm 配置。

以下命令在目标 Linux 主机上执行。首次部署使用新的普通用户，或先备份已有同名 skill；
不要覆盖正在运行的部署。仓库可放在任意目录，但这两个 skill 必须按默认布局放到 `$HOME` 下。

```bash
git clone https://github.com/kklldog/AI-DAILY-NEWS.git
cd AI-DAILY-NEWS
mkdir -p "$HOME/.agents/skills"
cp -a .agents/skills/ai-daily .agents/skills/baoyu-post-to-wechat "$HOME/.agents/skills/"

# 推荐先只装运行环境，配置完成前不注册、启用定时任务。
SKIP_SYSTEMD=1 bash "$HOME/.agents/skills/ai-daily/server/install.sh"
export PATH="$HOME/.local/share/ai-daily/node/bin:$HOME/.local/share/ai-daily/npm/bin:$PATH"
```

安装使用 `npm ci` 和 `bun install --frozen-lockfile` 复现随源码锁定的运行依赖。
不要另装最新版 baoyu skill 替换仓库版本，否则可能丢失已部署的浏览器适配。
如需下载代理，可在安装命令前设置 `PROXY=socks5h://proxy.example.com:7890`；
详见[部署文档](.agents/skills/ai-daily/server/README.md)。

可选偏好模板不含作者及账号信息；**仅首次使用时**复制，不覆盖已有个人偏好：

```bash
mkdir -p "$HOME/.baoyu-skills/baoyu-post-to-wechat"
test -e "$HOME/.baoyu-skills/baoyu-post-to-wechat/EXTEND.md" ||
  cp .baoyu-skills/baoyu-post-to-wechat/EXTEND.example.md \
     "$HOME/.baoyu-skills/baoyu-post-to-wechat/EXTEND.md"
```

不要设置独立的 `chrome_profile_path`，默认目录可让日报和 baoyu 脚本共享登录状态。

### 本地填写配置

安装器只在文件不存在时，从
[`config.example.env`](.agents/skills/ai-daily/server/config.example.env) 创建 `~/.ai-daily/config.env`。
在服务器上编辑它并保持 `chmod 600`，不要把内容提交 Git、发到聊天或截图中。
它会被 Bash 读取，含空格或特殊字符的值需正确加引号。

| 配置 | 说明 |
|---|---|
| `GPT_ENDPOINT`、`GPT_API_KEY`、`GPT_MODEL` | 完整 `/v1/responses` URL、密钥及服务商实际支持的模型 ID |
| `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`MAIL_TO` | 发信服务及预览收件人；QQ 使用 IMAP/SMTP 授权码，不是登录密码 |
| `WECHAT_AUTHOR` | 填写自己的公众号署名，最多 8 个 Unicode 字符；例如 `AI日报`。Markdown 的品牌署名较长，浏览器发表前应配置此覆盖值 |
| `PUBLISH_MODE` | 日常保持 `preview`，不是 `publish` |
| `MAIL_APPROVAL_ENABLED` | 首次保持 `0`；确定要通过回复触发发表时改为 `1` |
| `IMAP_HOST`、`IMAP_PORT` | 收信服务；默认复用 SMTP 用户名与授权码，可单独设置 `IMAP_USER` / `IMAP_PASS` |
| `MAIL_APPROVERS` | 经授权的确认发件人，逗号分隔；默认 `MAIL_TO`，QQ 别名须显式加入 |
| `MAIL_REPLY_TO` | 必须指向被监听的邮箱；默认 IMAP 用户名或 SMTP 用户名 |

仅核对配置格式（不连接 GPT）：

```bash
node "$HOME/.agents/skills/ai-daily/scripts/generate-article.mjs" --check-config
```

首次人工试运行以下命令会**访问新闻及模型服务、产生 API 费用并发送预览邮件**，
但不会创建公众号草稿或发表：

```bash
DRY_RUN=1 bash "$HOME/.agents/skills/ai-daily/server/run-daily.sh"
```

### 明确启用定时任务

完成配置并决定启用后，再安装 systemd 用户单元：

```bash
mkdir -p "$HOME/.config/systemd/user"
cp "$HOME/.agents/skills/ai-daily/server/"*.service \
   "$HOME/.agents/skills/ai-daily/server/"*.timer "$HOME/.config/systemd/user/"
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now ai-daily.timer
systemctl --user list-timers ai-daily.timer
```

定时器设为北京时间 22:00，附带最多 60 秒随机延迟，错过触发时可补跑。
原安装器在**不设置** `SKIP_SYSTEMD=1` 时会注册并 `enable` 每日定时器（不立即 `start`，
但后续登录/重启可能启动）；首次安装请采用上面的分步流程。

决定允许邮件确认自动发表后，在配置中设置 `MAIL_APPROVAL_ENABLED=1`，再执行：

```bash
# 会连接真实 IMAP；首次仅建立游标，不处理历史邮件。
bash "$HOME/.agents/skills/ai-daily/server/check-replies.sh" --check
systemctl --user enable --now ai-daily-review.timer
```

只回复开启审批后收到的**最新完整预览邮件**，保留主题，新增正文只写 `确认`。
`DRY_RUN=1` 产生的预览不会登记可发表的邮件审批；正常预览应保持 `DRY_RUN=0`。
登录状态和运行记录都保存在用户目录，不在仓库中。

## 无外部业务副作用的测试

在仓库目录使用 Node.js 22.20+、npm、Bun（也可用 `npx --yes bun`）及 Bash。
下列测试使用合成新闻/邮件、临时目录、mock 和本地回环服务，不访问真实 GPT、
新闻站点、邮箱或公众号，不启动实际浏览器。依赖安装本身需要访问包源。

```bash
(cd .agents/skills/ai-daily/scripts && npm ci --ignore-scripts --no-audit --no-fund && npm test)
(cd .agents/skills/baoyu-post-to-wechat/scripts && bun install --frozen-lockfile --ignore-scripts)
node --experimental-strip-types --test .agents/skills/baoyu-post-to-wechat/scripts/*.test.ts
bash -n .agents/skills/ai-daily/server/install.sh
bash -n .agents/skills/ai-daily/server/run-daily.sh
bash -n .agents/skills/ai-daily/server/check-replies.sh
```

Windows 可通过 Git Bash 运行这些命令；实际部署仍要求 Linux。
涉及真实 Linux 进程调度的缓存发布集成用例在 Windows 上会跳过。

## 运维与隐私

详细配置、输出文件、恢复规则和日志命令见
[服务器文档](.agents/skills/ai-daily/server/README.md)。
默认运行数据位于 `~/ai-daily/output/` 和 `~/ai-daily/review/`；
Linux 默认浏览器 profile 位于 `${XDG_DATA_HOME:-$HOME/.local/share}/baoyu-skills/chrome-profile`。
不要公开这些目录、真实配置、邮件审批编号、日志或扫码图片。
`.gitignore` 排除了常见敏感路径，但不能替代每次提交前的人工检查。

本次仓库导入不包含生产端到端发布操作，浏览器界面变化仍可能需要维护。
停止自动任务可执行 `systemctl --user disable --now ai-daily.timer ai-daily-review.timer`；
若服务已在执行，先核实当前状态，避免中断发表后盲目重试。

## 许可

baoyu 代码保留 **MIT / Copyright (c) 2026 Jim Liu**，详见
[第三方声明](THIRD_PARTY_NOTICES.md)及[原许可证](.agents/skills/baoyu-post-to-wechat/LICENSE)。
依赖包适用各自许可证；本仓库未将第三方代码重新授权，也未给其余代码新增整体开源许可。
