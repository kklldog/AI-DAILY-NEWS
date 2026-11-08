import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { simpleParser } from 'mailparser';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { ImapFlow } from 'imapflow';
import { checkApproval, dayWindow } from './generate-article.mjs';
import { loadConfig, notify } from './notify.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const optional = file => fs.existsSync(file) ? read(file) : null;
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
const normalized = value => String(value || '').trim().toLowerCase();
export function addresses(value) {
  return addressparser(value, { flatten: true }).map(a => normalized(a.address))
    .filter(a => /^[^\s<>@]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(a));
}

export function reviewConfig(env) {
  if (env.MAIL_APPROVAL_ENABLED !== '1') throw new Error('Email approval is disabled');
  const user = env.IMAP_USER || env.SMTP_USER;
  const pass = env.IMAP_PASS || env.SMTP_PASS;
  const host = env.IMAP_HOST || ((env.SMTP_HOST || 'smtp.qq.com') === 'smtp.qq.com' ? 'imap.qq.com' : '');
  const port = Number(env.IMAP_PORT || 993);
  const replyTo = addresses(env.MAIL_REPLY_TO || user || '');
  const senders = addresses(env.MAIL_APPROVERS || env.MAIL_TO || '');
  if (!host || !user || !pass || !Number.isInteger(port) || port < 1 || port > 65535 ||
      replyTo.length !== 1 || !senders.length) throw new Error('IMAP/MAIL_APPROVERS/MAIL_REPLY_TO configuration is incomplete');
  return { host, port, user, pass, replyTo: replyTo[0], senders, mailbox: env.IMAP_MAILBOX || 'INBOX' };
}

export function matchingPreview(mail, previews, senders) {
  const from = mail.from?.value || [];
  if (from.length !== 1 || !senders.includes(normalized(from[0].address))) return null;
  const auto = String(mail.headers.get('auto-submitted') || 'no').toLowerCase();
  if (auto !== 'no' || mail.headers.has('list-id') ||
      /^(bulk|list|junk)$/i.test(String(mail.headers.get('precedence') || ''))) return null;
  const tokens = [...String(mail.subject || '').matchAll(/\[AI-REVIEW:([a-f0-9]{32})\]/g)].map(m => m[1]);
  const matches = previews.filter(p => p.email?.token && tokens.length === 1 && p.email.token === tokens[0]);
  return matches.length === 1 ? matches[0] : null;
}

export function isConfirmation(mail) {
  let text = mail.text;
  if (!text && mail.html) {
    const $ = load(mail.html);
    $('script,style,blockquote,.gmail_quote,.gmail_signature,.qqmail_signature').remove();
    $('br').replaceWith('\n');
    $('p,div,tr,li').each((_, node) => { $(node).append('\n'); });
    text = $.root().text();
  }
  const own = [];
  for (const raw of String(text || '').replace(/[\u200b\ufeff]/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(>|On .{1,300}wrote:|在.{1,300}(写道|写到)[：:]|[-_]{2,}|发件人[：:]|From:|发自我的|Sent from my)/i.test(line) ||
        /^(原始邮件|原邮件|Original Message)[：:]?$/i.test(line)) break;
    own.push(line);
  }
  return own.join('\n').trim() === '确认';
}

export function loadPreviews(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map(entry => {
      const out = path.join(root, entry.name);
      const preview = optional(path.join(out, 'preview.sent.json'));
      if (!preview?.email?.token) return null;
      dayWindow(entry.name);
      if (preview.date !== entry.name || !/^[a-f0-9]{32}$/.test(preview.email.token) ||
          !Array.isArray(preview.email.recipients)) throw new Error('Invalid stored email preview');
      return { ...preview, out };
    }).filter(Boolean);
}

export async function acceptReply(mail, preview, source, { verify = checkApproval, send = notify } = {}) {
  const file = path.join(preview.out, 'email-approval.json');
  const previous = optional(file);
  if (previous && (previous.token === preview.email.token ||
      ['running', 'completed', 'failed', 'uncertain'].includes(previous.status))) return false;
  if (!isConfirmation(mail)) {
    await send({ subject: `【AI News Daily Report】${preview.date} 未执行发表`,
      text: '收到回复，但新增正文不是单独的“确认”。如需发表，请直接回复对应的完整预览邮件，正文只写：确认。' });
    return false;
  }
  try { verify(preview.out, preview.date, preview.articleHash); }
  catch {
    await send({ subject: `【AI News Daily Report】${preview.date} 预览版本失效`,
      text: '文章或封面已不再匹配这封预览，未执行发表。请等待更新的完整预览并重新确认。' });
    return false;
  }
  save(file, {
    status: 'pending', date: preview.date, articleHash: preview.articleHash,
    coverHash: preview.coverHash, token: preview.email.token,
    sender: normalized(mail.from.value[0].address),
    replyMessageId: mail.messageId || null, receivedAt: new Date().toISOString(), ...source,
  });
  console.log(`[review] confirmation queued for ${preview.date}`);
  return true;
}

function makeClient(config) {
  const client = new ImapFlow({
    host: config.host, port: config.port, secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false, logRaw: false,
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
  client.on('error', () => console.error('[review] IMAP connection error'));
  return client;
}

export async function pollMailbox({ config, root, stateDir, checkOnly = false, client = makeClient(config), send = notify }) {
  const cursorFile = path.join(stateDir, 'mail-cursor.json');
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox, { readOnly: true });
    try {
      const validity = String(client.mailbox.uidValidity);
      const end = client.mailbox.uidNext - 1;
      const account = `${config.host}:${config.port}/${config.user}/${config.mailbox}`;
      const old = optional(cursorFile);
      if (!old || old.account !== account || old.validity !== validity) {
        save(cursorFile, { account, validity, lastUid: end });
        if (old) await send({ subject: '【AI News Daily Report】邮件监听游标重置',
          text: '邮箱身份或UID有效期发生变化。为避免旧邮件重放，已从当前时刻重新监听。尚未处理的确认请重新回复对应预览。' });
        console.log('[review] IMAP ready; mailbox cursor initialized');
        return;
      }
      if (checkOnly) { console.log('[review] IMAP TLS login and mailbox access verified'); return; }
      if (!Number.isSafeInteger(old.lastUid) || old.lastUid < 0) throw new Error('Invalid IMAP cursor');
      if (end <= old.lastUid) return;
      const previews = loadPreviews(root);
      const found = await client.search({ uid: `${old.lastUid + 1}:${end}` }, { uid: true });
      if (!Array.isArray(found)) throw new Error('IMAP search failed');
      const batch = found.sort((a, b) => a - b).slice(0, 100);
      for (const uid of batch) {
        const meta = await client.fetchOne(uid, {
          size: true, headers: ['From', 'Subject', 'Auto-Submitted', 'Precedence', 'List-Id'],
        }, { uid: true });
        if (meta) {
          const header = await simpleParser(meta.headers, { skipHtmlToText: true, skipTextToHtml: true });
          const preview = matchingPreview(header, previews, config.senders);
          if (preview && meta.size <= 5 * 1024 * 1024) {
            const full = await client.fetchOne(uid, { source: true }, { uid: true });
            if (full?.source) {
              const mail = await simpleParser(full.source, { skipHtmlToText: true, skipTextToHtml: true });
              if (matchingPreview(mail, [preview], config.senders)) {
                await acceptReply(mail, preview, { uid, validity }, { send });
              }
            }
          } else if (preview) {
            await send({ subject: `【AI News Daily Report】${preview.date} 确认邮件过大`,
              text: '未执行发表。请回复对应预览，只保留“确认”，删除引用中的图片和附件后重发（限5MB）。' });
          }
        }
        save(cursorFile, { account, validity, lastUid: uid });
      }
      if (batch.length < 100) save(cursorFile, { account, validity, lastUid: end });
    } finally { lock.release(); }
  } finally { if (client.usable) await client.logout(); else client.close(); }
}

export function executePublication(approval, env = process.env) {
  const skill = env.AI_DAILY_SKILL || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(skill, 'server', 'run-daily.sh')], {
      env: { ...env, PUBLISH_MODE: 'publish', DRY_RUN: '0', RUN_AFTER_HOUR: '',
        REPORT_DATE: approval.date, APPROVED_ARTICLE_SHA256: approval.articleHash },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? null : code));
  });
}

export async function processApprovals({ root, senders, execute = executePublication, verify = checkApproval, send = notify }) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const out = path.join(root, entry.name);
    const file = path.join(out, 'email-approval.json');
    const approval = optional(file);
    if (!approval || !['pending', 'running'].includes(approval.status)) continue;
    const finish = status => { approval.status = status; approval.updatedAt = new Date().toISOString(); save(file, approval); };
    if (approval.status === 'running') {
      const result = optional(path.join(out, 'publication.result.json'));
      if (result?.date === approval.date && result.articleHash === approval.articleHash &&
          ['published', 'already-published'].includes(result.status)) {
        finish('completed');
        await send({ subject: `【AI News Daily Report】${entry.name} 已恢复发表结果`,
          text: '已找到此前保存的、经发表记录核实的成功结果。本次没有再次执行发表。' });
        continue;
      }
      finish('uncertain');
      await send({ subject: `【AI News Daily Report】${entry.name} 发布执行中断，需核查`,
        text: '上次执行被中断，是否已发表尚不明确。为防止重复发表，不会自动重试；请先检查公众号发表记录和服务器日志。' });
      continue;
    }
    try {
      const preview = read(path.join(out, 'preview.sent.json'));
      if (approval.date !== entry.name || !senders.includes(approval.sender) ||
          !approval.token || preview.email?.token !== approval.token || preview.coverHash !== approval.coverHash) {
        throw new Error('Reply no longer matches the current preview');
      }
      verify(out, approval.date, approval.articleHash);
    } catch {
      finish('stale');
      await send({ subject: `【AI News Daily Report】${entry.name} 确认版本失效，未发表`,
        text: '预览版本、封面或确认发件人已变化，未执行发表。请重新审阅更新后的预览并回复确认。' });
      continue;
    }
    finish('running');
    let code;
    try { code = await execute(approval); }
    catch { code = null; console.error('[review] Failed to start publication process'); }
    if (code === 75) { finish('pending'); continue; }
    const result = optional(path.join(out, 'publication.result.json'));
    if (code === 0 && result?.date === approval.date && result.articleHash === approval.articleHash &&
        ['published', 'already-published'].includes(result.status)) {
      finish('completed');
    } else {
      finish(code === null || code === 0 ? 'uncertain' : 'failed');
      await send({ subject: `【AI News Daily Report】${entry.name} 邮件确认后的发表未完成`,
        text: '已收到确认，但未取得可核实的成功结果。不会重复执行这次确认；请检查失败通知、公众号发表记录和服务器日志。文章和草稿均保留。' });
    }
  }
}

async function main() {
  const env = loadConfig();
  const stateDir = path.join(env.AI_DAILY_HOME || path.join(os.homedir(), 'ai-daily'), 'review');
  try {
    const config = reviewConfig(env);
    const root = path.join(env.AI_DAILY_HOME || path.join(os.homedir(), 'ai-daily'), 'output');
    const checkOnly = process.argv.includes('--check');
    await pollMailbox({ config, root, stateDir, checkOnly });
    if (!checkOnly) await processApprovals({ root, senders: config.senders });
  } catch (error) {
    const message = error.authenticationFailed ? 'IMAP登录失败，请检查IMAP服务是否开启及授权码。' :
      '邮件确认监听失败，请检查IMAP连接、配置及服务器日志。未开始新的发表操作。';
    console.error(`[review] ${message}`);
    const file = path.join(stateDir, 'error-notice.json');
    const previous = optional(file);
    if (!previous || Date.now() - previous.at > 3600e3) {
      if (await notify({ subject: '【AI News Daily Report】邮件确认监听异常', text: message })) {
        save(file, { at: Date.now() });
      }
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
