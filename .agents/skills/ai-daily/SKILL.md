---
name: ai-daily
description: 写一篇当天的「AI News Daily Report」AI 新闻日报公众号文章，并自动生成封面、发布到微信公众号草稿箱（提示词含「自动发表」时直接发表）。当用户说「写一篇 AI News Daily Report」「AI News Daily Report」「写一篇 AI Daily」「AI Daily」「今天的 AI 日报」「发一篇 AI 日报到公众号」时使用。
---

# AI News Daily Report：AI 日报 → 公众号

流程：中文互联网当天发布的最多 6 条 AI 资讯 → 核对原文与实际事件时间 → 写文章（带参考链接）→ 封面 → 完整邮件预览 → 用户回复邮件「确认」→ 服务器发表。

**默认自动完成到邮件预览并停止**，不逐步询问选题或封面。用户必须明确确认这份预览，才能创建公众号草稿或发表。

**发表模式**：
- 默认：仅发完整正文和封面的预览邮件，不创建公众号草稿，不发表。
- 用户已阅对应预览并明确确认发布后，才执行 Step 4–5；确认发表后才执行 Step 5b。
- 定时触发消息里的“自动发表”不等于用户已审阅并批准该篇内容。服务器以邮件预览编号绑定批准，不发布修改后的新版本。

回复用户一律用中文，简洁。

## Linux 服务器模式

服务器部署方案见 `server/README.md`，由 `server/run-daily.sh` 调度，**不安装、不调用 Copilot CLI**。
`scripts/generate-article.mjs` 从 RSS、InfoQ公开接口和AI智库导航栏目发现当天报道、下载中文正文，再直接调用用户配置的 GPT Responses API 核对与写稿。
endpoint、Key 和模型 ID 只放在服务器的 `~/.ai-daily/config.env`，不要让用户把 Key 发到聊天里。
服务器默认从 IT之家、量子位、雷峰网、爱范儿、InfoQ AI&大模型、AI智库导航六个入口发现资讯，也可引用其他公网中文网站；取消原四家域名白名单和敏感关键词一刀切。最多6条，不足按实际数量写，0条只发暂无合适新闻通知。
服务器 `PUBLISH_MODE=preview` 是默认模式，邮件正文含完整文章和封面，发送成功后停止，不登录公众号。`DRY_RUN=1` 也仅发预览。
仅在用户明确确认对应预览后，使用 `REPORT_DATE` 和 `APPROVED_ARTICLE_SHA256` 调用发布模式；不得自行填写批准编号绕过用户确认。

服务器已支持独立邮件审批：`MAIL_APPROVAL_ENABLED=1` 配合 `ai-daily-review.timer` 每分钟读取 IMAP。用户直接回复新预览邮件、保留原标题，正文只写「确认」。程序核对主题里的随机唯一编号、允许发件人和文章/封面指纹后自动执行缓存发布，不依赖Message-ID，不需要回到聊天。重复回复不重复发表；结果不明时邮件告警并停止，不自行重试。完整说明见 `server/README.md`；不得通过伪造用户确认邮件来测试真实发表。
允许确认的邮箱来自 `MAIL_APPROVERS`，未设置则使用 `MAIL_TO`。QQ别名/数字地址不同需用户明确授权后加入，不自动信任任意声称是同一用户的地址。
公众号作者栏通过服务器 `WECHAT_AUTHOR` 配置为用户自己的署名（最多8个字）。它覆盖公众号作者栏，不修改已审稿文件；标题品牌仍为 AI News Daily Report。

## 固定配置

| 项 | 值 |
|---|---|
| 日期 | 北京时间当天 `YYYY-MM-DD`（以 `<current_datetime>` 为准） |
| 输出目录 | 当前 session 的 `files/` 目录：`files/ai-daily-YYYY-MM-DD.md`，封面放 `files/imgs/` |
| frontmatter title | `AI News Daily Report MM-DD｜<一至两条最重要新闻的短标题>`，**必须 ≤ 64 字符** |
| author | `AI News Daily Report` |
| 封面 | conceptual + cool（科技蓝）+ digital + clean 无衬线，title-only：`AI News` / `Daily Report` / `YYYY-MM-DD`，2.35:1，无水印 |
| 发布 | baoyu-post-to-wechat，**browser 方式**，`--theme default --color blue --submit`（可选偏好存于 `~/.baoyu-skills/baoyu-post-to-wechat/EXTEND.md`，仓库只提供示例） |
| 公众号 | 用户登录并有权运营的公众号 |

## Step 1：收集新闻（最多6条，当天报道，不凑数）

报道时间窗口：北京时间当天 00:00 至次日 00:00（即 UTC 前一天 16:00 起）。

默认发现入口：IT之家 `https://www.ithome.com/rss/`、量子位 `https://www.qbitai.com/feed`、雷峰网 `https://www.leiphone.com/feed`、爱范儿 `https://www.ifanr.com/feed`、InfoQ `https://www.infoq.cn/topic/AI&LLM`、AI智库导航 `https://aiguide.cc/每日最新ai资讯/`。
允许其他公网中文网站、博客和聚合站，不要求原四家媒体域名，也不按域名后缀判定中文。英文原文不入稿；保留网址无凭据、公网和重定向校验。
不限于五类：AI 科普、行业观点、法律监管、社会应用、产品、科研、算力、商业等都可以选，不因某个敏感关键词一概删除。公开发布不等于公众号审核通过，最终仍须用户审阅。消息明确归因，不提供违法、自伤实施步骤、暴力细节或个人敏感资料。
1–5条合格时按实际数量写，0条只发暂无合适新闻通知，不生成空日报；抓取故障须报错，不能当成没有新闻。

用 PowerShell `Invoke-RestMethod` 拉 RSS，按 `pubDate` 过滤，去重。

**核实（必须做）**：
- 每条用原文确认**中文报道确实在当天发布**，事件可以更早发生，单独注明实际时间。科普、观点与研究解读不能写成今天刚发布产品；日期不详则明确未注明，不猜日期。
- 关键数字（金额、百分比、估值）必须能在所引用的那篇来源里找到；找不到就换来源或删掉数字。
- 二手转引可以跟到其他公网中文网站；证据不足时删掉相关断言或明确是该机构/媒体的说法，不虚构确认。

同一聚合文章可以提供多条不同资讯；跨站转述同一事件要去重。按重要性和多样性选前6条，记录未选原因，不能把超出篇幅上限叫作不合格。

## Step 2：写文章

用 `create` 写入 `files/ai-daily-YYYY-MM-DD.md`，结构：

```markdown
---
title: AI News Daily Report MM-DD｜<短标题1>，<短标题2>
author: AI News Daily Report
summary: 今日 N 条 AI 要闻：<按实际数量写>……   （≤120 字，N≤6）
---

# AI News Daily Report YYYY-MM-DD

> 今天的关键词是：**词1、词2、词3**。
> <一两句话串起当天主线>

---

## 📌 今日速览

1. ...
（N 条一句话标题，最多6条）

---

## 1. <标题>

**报道日期：** YYYY-MM-DD　**事件时间：** <实际时间或原文未注明>

**发生了什么**

<2-3 段，含具体数字、人物、时间，句末用 [n] 标注来源>

**背景** / **细节** / **为什么是现在？** / **各方反应**（按需选 1-2 个小节）

<1-2 段>

**💡 点评：** <2-3 句有观点的分析，不要空话>

---

（其余新闻按同样结构写，不补满6条）

## 写在最后

<一段总结当天趋势>

---

## 🔗 参考链接

[1] 媒体名 | 原文标题
https://...

[2] ...

---

*整理时间：YYYY-MM-DD。本文内容整理自公开报道，不构成投资建议。*
```

写作要求：
- 每条 300-500 字，全文长度随实际条数变化；中文写作，专有名词保留英文。
- 正文用 `[n]` 引用，**不要在正文里放 markdown 链接**（公众号正文外链不可点击），所有 URL 放到文末「参考链接」，每条单独一行纯文本。
- 写完用 `open_canvas`（editor，scope workspace）打开给用户看，然后**直接继续**下一步。

## Step 3：生成封面

不需要走 baoyu-cover-image 的确认问答（风格已固定）。

1. 用 `image_generation` 工具，`size: 1536x1024`，prompt：

```
Wide banner cover image for a tech newsletter, clean polished digital illustration, conceptual style.
Layout: ultra-wide horizontal composition. Keep all important content inside the central horizontal band (top and bottom 15% will be cropped to 2.35:1). Left 45%: title text vertically centered, placed slightly ABOVE center. Right 55%: concept illustration.
Text (the ONLY visible text, rendered exactly): first line "AI News" and second line "Daily Report", both in large bold navy-blue geometric sans-serif; third line "YYYY-MM-DD" in engineering blue, smaller. Text block must fit fully inside the left 45%. No other words, letters, or numbers anywhere.
Illustration: <根据当天主题替换：例如 a glowing AI chip at the center of a network of connected nodes ... floating frosted-glass UI cards with icons: 搜索/代码/服务器/盾牌/图表 等与当天新闻相关的 4-6 个图标>. Subtle light 3D elevation, soft consistent shadows, smooth gradients.
Background: light gray-white with a faint blueprint grid and alignment guide lines.
Colors: engineering blue, navy, cyan glows, with a small amber accent highlight. Medium contrast, balanced saturation. Technical, professional, precise, modern. No watermark.
```

   （标题略偏上，是因为公众号消息列表会把文章标题叠在封面底部。）

2. 生成的图片保存在 session `files/transcript-images/` 下（找最近 10 分钟内的 png）。用 System.Drawing 裁成 2.35:1（1536×654，从 y=143 开始裁），保存为 `files/imgs/cover.png`：

```powershell
Add-Type -AssemblyName System.Drawing
$im=[System.Drawing.Image]::FromFile($src); $out=New-Object System.Drawing.Bitmap 1536,654
$g=[System.Drawing.Graphics]::FromImage($out); $g.InterpolationMode='HighQualityBicubic'
$g.DrawImage($im,(New-Object System.Drawing.Rectangle 0,0,1536,654),(New-Object System.Drawing.Rectangle 0,143,1536,654),'Pixel')
$out.Save("$imgs\cover.png",[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose();$out.Dispose();$im.Dispose()
```

   （本机没有 Python PIL，不要用 python。）

3. `view` 一下裁剪结果，确认文字完整、日期正确。文字错了就重新生成。

## Step 3b：邮件预览后停止

用服务器通知脚本发送完整正文，不仅是摘要或附件：`notify.mjs --article <article.md> --image <cover.png> --attach <article.md>`。邮件注明实际新闻数量、来源和待用户确认。
发件成功后本次生成任务退出，不能直接继续 Step 4。服务器开启邮件审批后由独立监听任务等待用户回复「确认」并执行后续流程；不是要求用户回到聊天。使用 `send-preview.mjs --date <日期> --out <输出目录>` 发送可回复确认的完整预览，普通 `notify.mjs` 通知不会登记审批线程。邮件失败时提示失败，不操作公众号。

## Step 4：发布到公众号草稿箱（用户确认对应预览后）

1. 首次或依赖缺失时：在 `~/.agents/skills/baoyu-post-to-wechat/scripts` 执行 `npx -y bun install`（缺 `jimp` 会报 `Cannot find package`）。
2. 发布（async 模式运行，用 read_powershell 等待）：

```powershell
npx -y bun "$HOME\.agents\skills\baoyu-post-to-wechat\scripts\wechat-article.ts" --markdown <article.md> --theme default --color blue --submit
```

3. 如果输出 `Not logged in. Please scan QR code...`，立刻告诉用户：**「请在弹出的 Chrome 窗口扫码登录公众号」**，然后继续等待（最多 2 分钟）。
4. 成功输出：`Draft saved successfully! appmsgid: <id>`，记下 appmsgid。
5. 如果报 `Title too long`，缩短 frontmatter title（≤64 字符）后重试。

## Step 5：上传封面

browser 方式不会自动设置封面，用本 skill 自带脚本补上：

```powershell
node "$HOME\.agents\skills\ai-daily\scripts\wechat-cover-upload.mjs" --appmsgid <id> --cover "<files>\imgs\cover.png"
```

脚本会：连接/启动带 CDP（端口 9333）的 Chrome（共享 baoyu-skills 登录 profile）→ 打开草稿编辑页 → 封面「从图片库选择」→ 上传文件 → 下一步 → 确认裁剪（2.35:1 + 1:1 默认）→ 保存为草稿。输出 `done` 即成功；如需扫码登录同样提示用户。

失败时的手动兜底：DOM 选择器 `a.js_imagedialog`（打开图片库）、`.js_upload_btn_container input[type=file]`（用 CDP `DOM.setFileInputFiles` 上传，取最后一个）、对话框按钮文本「下一步」「确认」、底部「保存为草稿」。合成 drag-drop 事件对封面区域**无效**，不要用。

## Step 5b：发表（仅用户明确确认对应预览发表后）

发表前自检：标题 ≤64 字符、封面已设置（Step 5 输出 `done`）、文章和日期与用户确认的邮件预览完全一致。任一不满足则**不要发表**。服务器跨日确认时用 `REPORT_DATE` 指向对应预览，不能重写成新一天的新闻。

同一天只发一篇：**用户确认发表后、发表操作前**检查是否已发过。仅发邮件预览时不必登录公众号：

```powershell
node "$HOME\.agents\skills\ai-daily\scripts\wechat-publish.mjs" --check-title "AI News Daily Report MM-DD"
# exit 0 = 今天已发表 → 停止；exit 2 = 未发表 → 继续
```

发表：

```powershell
node "$HOME\.agents\skills\ai-daily\scripts\wechat-publish.mjs" --appmsgid <id> --wait 600
```

（async 模式运行，用 read_powershell 等待；可先加 `--dry-run` 只打开发表弹窗再取消，该选项仍会操作真实浏览器。是否需要管理员扫码以当前公众号界面为准；发表记录可能先显示「审核中」，不代表平台审核已经通过。）

脚本流程：打开草稿编辑页 → 底部「发表」→ 弹窗内「发表」（群发通知次数可能为 0，不影响发表）→ 自动点「未开启群发通知」等确认框 → 到「发表记录」页核实标题。输出标记：
- `[publish] NEED_LOGIN` / `NEED_QR_SCAN`：需要用户在 Chrome 里扫码（登录或管理员发表验证），立刻提醒用户，脚本最多等 `--wait` 秒
- `[publish] PUBLISHED`（exit 0）：发表成功
- `[publish] NOT_VERIFIED`（exit 2）/ `FAILED`（exit 1）：未确认发表，草稿保留，汇报给用户，**不要重试发表**（避免重复发文）

## Step 6：汇报

简短中文汇报（≤100 字左右）：
- 默认模式：已发完整预览邮件（N条，N≤6），待用户确认，没有创建草稿或发表。
- 确认后发布模式：已保存草稿 / 已发表 / 未发表的原因。
- 标题、实际新闻条数（可选，简短）
- ⚠️ 无法核实的链接/数字（如有）
