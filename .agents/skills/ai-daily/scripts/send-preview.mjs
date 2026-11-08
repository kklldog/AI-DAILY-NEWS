import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { articleHash, cachedReport, markPreviewSent } from './generate-article.mjs';
import { loadConfig, notify } from './notify.mjs';
import { addresses, reviewConfig } from './review-replies.mjs';

export async function sendPreview({ out, date, env = loadConfig(), send = notify }) {
  const report = cachedReport(out, date);
  const hash = articleHash(out, date);
  const cover = path.join(out, 'cover.png');
  const coverHash = () => createHash('sha256').update(fs.readFileSync(cover)).digest('hex');
  const before = coverHash();
  const enabled = env.MAIL_APPROVAL_ENABLED === '1' && env.DRY_RUN !== '1';
  const config = enabled ? reviewConfig(env) : null;
  const recipients = addresses(env.MAIL_TO || '');
  if (!recipients.length) throw new Error('MAIL_TO must contain a valid review recipient');
  const sender = config?.replyTo || addresses(env.SMTP_USER || '')[0] || recipients[0];
  const messageId = `<ai-daily.${date}.${randomUUID()}@${sender.split('@')[1]}>`;
  const token = config ? randomBytes(16).toString('hex') : undefined;
  const instructions = enabled
    ? '审核通过后，请直接回复本邮件，正文只写：确认\n服务器约一分钟内识别后，将按本邮件对应的原文和封面自动发表到已登录的公众号。不需要回到聊天。\n请保留原邮件主题（末尾识别码无需手动输入），勿转发或新建邮件；修改过的内容必须重新预览。未回复不会发表。'
    : '当前仅预览，邮件确认监听未开启；请由操作者核对本预览并明确批准后发布。';
  const ok = await send({
    subject: `【AI News Daily Report】${date} 内容预览（${report.stories.length} 条，${enabled ? '回复“确认”后发表' : '待你确认'}）${token ? ` [AI-REVIEW:${token}]` : ''}`,
    text: `标题：${report.title}\n${env.WECHAT_AUTHOR ? `公众号作者署名：${env.WECHAT_AUTHOR}\n` : ''}本次共 ${report.stories.length} 条中文网站当天发布的 AI 资讯，正文注明实际事件时间。请检查事实、日期、归因和公众号适宜性。\n\n${instructions}\n\n目前未创建草稿、未发表。`,
    article: fs.readFileSync(path.join(out, 'article.md'), 'utf8'),
    images: [cover], attachments: [path.join(out, 'article.md')],
    messageId, ...(config ? { replyTo: config.replyTo } : {}),
  });
  if (!ok) throw new Error('Preview email delivery failed; no reply approval was registered');
  if (coverHash() !== before) throw new Error('Cover changed during email delivery; send a new preview');
  markPreviewSent(out, date, hash, config ? { messageId, token, recipients, replyTo: config.replyTo } : undefined);
  console.log(`[review] preview sent for ${date}; email approval ${enabled ? 'enabled' : 'disabled'}`);
  return messageId;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = name => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : '';
  sendPreview({ date: get('date'), out: path.resolve(get('out')) }).catch(error => {
    console.error(`[review] ${error.message}`); process.exitCode = 1;
  });
}
