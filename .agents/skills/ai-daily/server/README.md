# AI News Daily Report：中文互联网当天报道、最多6条、邮件先审

服务器直接调用用户配置的 GPT Responses API，不安装、不调用 Copilot CLI。每日任务只生成**邮件预览**；用户直接回复对应邮件「确认」后，独立的服务器邮件监听任务才会发表，不依赖聊天或开发电脑。定时器只有在用户要求启用时才启动，每天北京时间 22:00 生成预览。

## 新闻来源与内容规则

| 来源 | 发现方式 |
|---|---|
| IT之家 | https://www.ithome.com/rss/ |
| 量子位 | https://www.qbitai.com/feed |
| 雷峰网 | https://www.leiphone.com/feed |
| 爱范儿 | https://www.ifanr.com/feed |
| InfoQ AI&大模型 | https://www.infoq.cn/topic/AI&LLM ，频道公开列表 API |
| AI智库导航 | https://aiguide.cc/每日最新ai资讯/ ，栏目 HTML 和文章发布时间 |

默认从以上六个入口发现资讯，不使用 Bing 等境外搜索入口。**已取消原四家媒体的域名白名单**，文章及引用可以来自其他中文互联网网站，包括个人博客和聚合站；以可读正文的中文内容判断，不以域名后缀或公司所在地判断。英文原文不入稿。

InfoQ 使用页面实际调用的公开 `public/v1/article/getList` 接口（AI频道 id=31），最多翻3页，不是把动态页面空 HTML 当作没有新闻。AI智库导航已关闭 RSS，直接解析栏目卡片及文章的 `article:published_time`；栏目最新一期若不是当天，不伪装成今天的新稿。聚合文章可提供多条不同资讯。

不再局限模型、产品、科研、算力、商业五类，也不因“政策”“争议”“隐私”等关键词整篇弃选。科普、行业观点、法规、社会应用、研究解读等 AI 资讯均可考虑。保留原文事实核对、消息归因和人工邮件确认，不提供违法、自伤实施步骤或个人敏感资料。**网站公开发布不等于已通过公众号审核，最终仍须用户审阅。**

- 按北京时间当天的**中文报道发布时间**选题。事件可以发生在几天前，正文单独注明实际时间；原文未注明时如实写日期不详，不猜测。
- RSS、InfoQ列表和文章发布时间必须落在当天。明确时区的时间按原时区转换；中文网站仅给日期或无时区的时间时按北京时间解释。
- 最多 6 条独立新闻；只有 1–5 条合格时按实际数量写，不凑数。
- 0 条合格时只发“暂无合适新闻”邮件，不生成空文章。
- 所有媒体请求失败、所有原文无法读取、API 失败等是故障，发失败通知，不冒充“没有新闻”。
- 不仅按标题关键词筛选；会读取正文确认AI相关性。至多读取100个发现候选、补读12个引用链接，保留最多60份当天中文正文；各站点至少优先处理一条候选，避免新来源被其他站点挤掉。
- URL和每次重定向都保留公网地址校验、无凭据 URL 和请求体积上限，不能访问内网/本机服务。
- 每条正文 300–500 字符，摘要 ≤120 字符、标题 ≤64 字符。正文引用序号及文末 URL 由程序补全。
- 中文新闻网站直连；可选 HTTP/SOCKS 代理仅用于 GPT 请求及安装下载。

## 邮件先审与发布

`PUBLISH_MODE=preview`（默认）：

1. 抓取六个入口和少量引用的中文来源，调用 GPT 按当天报道选出 0–6 条资讯，并记录所有未选来源的原因。
2. 有新闻时调用 GPT 写稿，本地校验结构、中文来源、报道日期、事件时间说明、去重和数量。
3. HTML 模板生成 1536×654 封面。
4. 邮件正文展示**完整排版文章**和封面，附 Markdown，注明新闻实际数量和预览编号。
5. 邮件发送成功后保存 `preview.sent.json`，立即退出。开启邮件审批时，记录主题里的随机唯一编号、允许的收件人和内容指纹；回复地址指向服务器监听的邮箱。

### 回复邮件自动发表

用户**直接回复最新完整预览邮件，保留原标题，新增正文只写 `确认`**。无需回到聊天，也不需要手输编号。普通客户端附带的引用正文（含手机邮箱的「原始邮件」区块）会被忽略；「不确认」「确认但不要发表」等不会触发操作。

服务器的 `ai-daily-review.timer` 约每分钟连接 IMAP（TLS），只下载能匹配唯一编号和允许发件人的邮件正文。`MAIL_APPROVERS` 是允许确认的地址集合，未设置时默认 `MAIL_TO`。QQ别名与数字账号可能发出不同的From地址：仅在用户明确授权后把这些地址都加入 `MAIL_APPROVERS`（逗号分隔），不改变实际收件人，也无需重发原预览。自动回复、群发邮件、旧预览编号和不明确命令不能触发发布。主题含128位随机 `[AI-REVIEW:...]` 唯一编号，每次发预览重新生成，并绑定该版文章和封面的SHA-256；不依赖QQ可能改写的Message-ID或回复头，也不按日期猜测版本。此机制依赖收件邮箱及其反伪造保护；不要公开转发带审核编号的预览邮件。

合法确认先持久化到 `email-approval.json`，再次核对当前文章和封面的 SHA-256，然后执行 `run-daily.sh` 的缓存发布模式。每日任务忙时排队，下次轮询再试。重复回复不会重复发表；执行失败、进程中断或结果不明时停止并发邮件，不自动重试可能已发表的内容。出现这些异常需要检查公众号记录和服务器日志后人工恢复。

公众号登录失效时二维码通过邮件发送；发表要求管理员验证时也发截图邮件。核实发表记录后保存 `publication.result.json` 并通知结果。发布阶段不调用 GPT，也不需要 GPT 代理；服务器的 IMAP、SMTP 和公众号均直连。

QQ 邮箱需开启 **IMAP/SMTP**，默认复用现有 SMTP 账号和授权码，无需把授权码发给聊天。`MAIL_REPLY_TO` 默认是 IMAP 用户名（未设置则为 SMTP 用户名），必须指向实际被监听的邮箱；其他服务商填写其 IMAP 地址。

公众号作者栏最多8个字，可用 `WECHAT_AUTHOR` 显式覆盖Markdown元数据中的长署名，预览邮件会展示该署名。请设置为自己的署名（例如 `AI日报`），不改动已审稿的标题、正文及封面。超长作者在打开浏览器前报错，避免到保存草稿时才发现平台校验失败。

```bash
# 在服务器 config.env 中设置 MAIL_APPROVAL_ENABLED=1，并确认 IMAP_HOST/IMAP_PORT
bash ~/.agents/skills/ai-daily/server/check-replies.sh --check
systemctl --user enable --now ai-daily-review.timer
```

首次检查只建立当前邮箱 UID 游标，不处理历史邮件。邮箱 UID 有效期变化时重建游标并通知，避免重放旧邮件；需重新回复未处理的确认。邮件以只读方式打开，不删除、移动或标记用户邮件。功能启用前的预览没有线程绑定，须重发完整预览后才能回复确认；重发不重写正文或封面。

预览邮件未发送成功则失败，不生成成功标记，更不会发表。确认后只使用同一份已邮件预览的文章；修改内容、来源或日期后必须重新预览。

邮件监听会在核验明确确认后自动执行以下等价流程；手动操作也必须已获得用户对该预览的确认：

```bash
# 日期和SHA-256均取自用户确认的那封预览；不要把批准编号写进长期配置。
REPORT_DATE=YYYY-MM-DD \
PUBLISH_MODE=publish \
APPROVED_ARTICLE_SHA256=preview.sent.json中的articleHash \
bash ~/.agents/skills/ai-daily/server/run-daily.sh
```

`draft` 模式同样需要该内容的明确确认，但只保存公众号草稿。单独设置 `PUBLISH_MODE=publish` 不足以发表：编号必须匹配 `preview.sent.json`、当前文章、当前策略和日期。它是人工审稿操作约束，不是防止拥有服务器权限的人绕过的安全授权系统。

批准后才启动 Xvfb/Chrome、复用已保存的登录状态；失效时扫码二维码发邮件。同时核对邮件封面的指纹，发布时不重新绘制封面；扫码等待后、保存草稿前及发表前会再次核对内容。检查发表记录后再保存草稿、上传封面、发表、核对。未确认发表状态时不会盲目重试。

## 安装与配置

```bash
# Ubuntu/Debian普通用户；首次部署，已有同名 skill 请先备份并停止相关任务
git clone https://github.com/kklldog/AI-DAILY-NEWS.git
cd AI-DAILY-NEWS
mkdir -p "$HOME/.agents/skills"
cp -a .agents/skills/ai-daily .agents/skills/baoyu-post-to-wechat "$HOME/.agents/skills/"
SKIP_SYSTEMD=1 bash ~/.agents/skills/ai-daily/server/install.sh
export PATH="$HOME/.local/share/ai-daily/node/bin:$HOME/.local/share/ai-daily/npm/bin:$PATH"

# 下载需要代理时
PROXY=socks5h://proxy.example.com:7890 SKIP_SYSTEMD=1 bash ~/.agents/skills/ai-daily/server/install.sh
```

系统 Node 不足 22 时，官方 Node 22 安装在 `~/.local/share/ai-daily/node`，校验 SHA-256；bun 在 `~/.local/share/ai-daily/npm`。不升级系统 Node、不修改全局 npm 配置或 `.bashrc`。
依赖按仓库锁文件安装。首次推荐 `SKIP_SYSTEMD=1`，配置完成后按[仓库首页](../../../../README.md#明确启用定时任务)复制 systemd 单元并启用。
不设置该选项时，安装器会注册并启用每日定时器（不立即启动，但后续登录/重启可能启动）。

在服务器 `~/.ai-daily/config.env` 中本地填写，不把秘密发到聊天：

```bash
GPT_ENDPOINT=https://your-gpt-endpoint.example/v1/responses
GPT_API_KEY='本地填写'
GPT_MODEL=gpt-6.1-sol
GPT_JSON_MODE=prompt

SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=sender@example.com
SMTP_PASS='QQ邮箱SMTP授权码，不是QQ密码'
MAIL_TO=reviewer@example.com
WECHAT_AUTHOR=AI日报

PUBLISH_MODE=preview
DRY_RUN=0
MAIL_APPROVAL_ENABLED=1
IMAP_HOST=imap.qq.com
IMAP_PORT=993
```

endpoint 是完整 Responses API URL，建议 HTTPS；模型 ID 必须以服务商支持的名称为准，不自动切换模型。默认 `prompt` 用提示词要求 JSON 并本地严格校验；支持 `text.format` 的网关可以选 `json_object`。不兼容时会明确失败，不自动回退。

代理写入 `PROXY`；SOCKS 自动由本地 HTTP→SOCKS 桥转发 GPT 请求。endpoint 在内部网络时可设置 `PROXY_NO_PROXY=gpt.internal.example`，替换为实际端点的主机名。微信公众号 Chrome 始终直连。

```bash
chmod 600 ~/.ai-daily/config.env
node ~/.agents/skills/ai-daily/scripts/generate-article.mjs --check-config

# 写稿、封面和邮件预览，产生GPT token费用，但不操作公众号
bash ~/.agents/skills/ai-daily/server/run-daily.sh

# 用户明确要求每天自动发预览邮件后才执行；不会自动发表
systemctl --user enable --now ai-daily.timer
```

## 输出、续跑与故障

目录：`~/ai-daily/output/YYYY-MM-DD/`。

| 文件 | 用途 |
|---|---|
| `news-sources.json`、`selection-response.json`、`verified-news.json` | 中文原文、原始选题及逐条未选原因、有原文证据的选题 |
| `no-news.json` | 当天没有合适选题的说明 |
| `write-response.json`、`report.json` | 最后写稿响应、通过校验的稿件与策略版本 |
| `article.md`、`cover.json`、`cover.png` | 完整文章、封面图标和图片 |
| `preview.sent.json` | 成功发出的预览文章指纹、日期和时间 |
| `email-approval.json` | 邮件确认的发件人、线程、UID、版本及 pending/running/completed/failed 等执行状态 |
| `publication.result.json` | 经公众号发表记录核实的 published/already-published 结果 |
| `appmsgid`、`cover.done` | 经确认后保存的草稿编号和封面完成标记 |
| `run.log`、`gpt.log` | 日志，不打印 Key |

文章和封面数据都写完后才保存 `report.json`；续跑会重验中文来源、日期、数量、策略版本和文件一致性。新稿采用 `chinese-reporting-six-preview-v2`；此前已经发邮件的 `mainland-six-preview-v1` 稿件可以按原内容继续审阅，升级不会重写文章、封面或改变内容指纹。更早的10条/境外来源缓存不自动复用；已有草稿不静默改稿。升级保留密钥配置及旧输出，继续使用 `PUBLISH_MODE=preview`；只有用户明确授权才启用定时器和邮件审批。

429/5xx 最多请求3次，其他HTTP错误立即停止；每次默认超时600秒，整个抓取/写稿阶段60分钟。prompt模式接受完整JSON对象或仅包裹该对象的一对JSON代码围栏，不提取混杂说明中的片段。写稿JSON/文章结构不合法时只纠正一次，仍失败就停止；无法解析的输出以脱敏文本记录在 `selection-invalid.txt` / `write-invalid.txt`。报道日期由程序根据已核实的发布时间计算，模型只判断实际事件时间。纠正和重试可能增加费用。模型只收到新闻正文，不收到 API Key、邮箱授权码或 Chrome 登录状态；`store:false` 不能替第三方网关保证不留存。

```bash
systemctl --user list-timers ai-daily.timer
systemctl --user list-timers ai-daily-review.timer
journalctl --user -u ai-daily -n 100
journalctl --user -u ai-daily-review -n 100
tail -f ~/ai-daily/output/$(TZ=Asia/Shanghai date +%F)/run.log
```

`Persistent=true` 会在错过触发后补跑开机当天的预览，不补每个历史日。文件锁只能约束本机；如果另一个电脑也有同名任务，仍应避免同时运行。预览模式完全不碰公众号浏览器。

邮件监听的 UID 游标与节流错误通知记录位于 `~/ai-daily/review/`。一次最多处理100封新增邮件，5MB以上的匹配回复要求去掉图片附件后重发；无关邮件只检查必要邮件头，不下载正文。发布任务独立于生成任务，但共用每日文件锁；执行前写入 running 状态，重启后不盲目重复不确定的操作。

发表时如出现管理员验证，程序会识别普通弹窗或独立的“微信验证”界面，将当前二维码截图发到邮箱，等待管理员或运营者微信扫码；二维码邮件发送失败会明确报错，不静默等待。发表记录出现文章表示微信已受理，可能仍显示“审核中”，不代表平台审核已经通过。
