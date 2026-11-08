// Email notification (SMTP via nodemailer). Config from env or ~/.ai-daily/config.env:
//   SMTP_HOST (default smtp.qq.com) SMTP_PORT (default 465) SMTP_USER SMTP_PASS MAIL_TO [MAIL_FROM]
// CLI:    node notify.mjs --subject "..." --text "..." [--image a.png] [--attach log.txt]
// Module: import { notify } from './notify.mjs'; await notify({ subject, text, images: [path], attachments: [path] })
// When SMTP is not configured it only prints a warning (never throws).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

export function renderArticlePreview(markdown) {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const md = new MarkdownIt({ html: false, linkify: true });
  // Article images must not trigger third-party requests in the review email.
  md.renderer.rules.image = () => '';
  return `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.8;color:#222">${md.render(body)}</div>`;
}

export function loadConfig() {
  const file = process.env.AI_DAILY_CONFIG || path.join(os.homedir(), '.ai-daily', 'config.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return process.env;
}

export async function notify({ subject, text = '', images = [], attachments = [], article = '', messageId, replyTo }) {
  const env = loadConfig();
  if (!env.SMTP_USER || !env.SMTP_PASS || !env.MAIL_TO) {
    console.warn('[notify] SMTP not configured, skip email:', subject);
    return false;
  }
  try {
    const { default: nodemailer } = await import('nodemailer');
    const port = +(env.SMTP_PORT || 465);
    const t = nodemailer.createTransport({ host: env.SMTP_HOST || 'smtp.qq.com', port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
    const imgs = images.filter(f => f && fs.existsSync(f));
    const escHtml = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const html = `<div style="font-family:sans-serif;white-space:pre-wrap">${escHtml(text)}</div>` +
      imgs.map((f, i) => `<p><img src="cid:img${i}" style="max-width:100%;width:${/qr/i.test(path.basename(f)) ? '320px' : '100%'}"></p>`).join('') +
      (article ? renderArticlePreview(article) : '');
    const result = await t.sendMail({
      from: env.MAIL_FROM || env.SMTP_USER, to: env.MAIL_TO, subject,
      ...(messageId ? { messageId } : {}),
      ...(replyTo ? { replyTo } : {}),
      text: article ? `${text}\n\n${article.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')}` : text, html,
      attachments: [
        ...imgs.map((f, i) => ({ filename: path.basename(f), path: f, cid: `img${i}` })),
        ...attachments.filter(f => f && fs.existsSync(f)).map(f => ({ filename: path.basename(f), path: f })),
      ],
    });
    if (result.rejected?.length) throw new Error('Some configured recipients rejected the email');
    console.log('[notify] email sent:', subject);
    return true;
  } catch (e) {
    console.warn('[notify] email failed:', e.message);
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), get = k => { const r = []; argv.forEach((v, i) => v === `--${k}` && argv[i + 1] && r.push(argv[i + 1])); return r; };
  const text = get('text')[0] ?? (get('text-file')[0] ? fs.readFileSync(get('text-file')[0], 'utf8') : '');
  const article = get('article')[0] ? fs.readFileSync(get('article')[0], 'utf8') : '';
  const ok = await notify({ subject: get('subject')[0] || 'AI News Daily Report', text, images: get('image'), attachments: get('attach'), article });
  process.exit(ok ? 0 : 3);
}
