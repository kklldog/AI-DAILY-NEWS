import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import { generate, articleHash, recordPublication } from './generate-article.mjs';
import { sendPreview } from './send-preview.mjs';
import { addresses, reviewConfig, matchingPreview, isConfirmation, loadPreviews,
  acceptReply, processApprovals, pollMailbox, executePublication } from './review-replies.mjs';
import { findPublishedTitle, hasStandaloneAdminVerification } from './publication-utils.mjs';

const date = '2026-11-08';
const env = { MAIL_APPROVAL_ENABLED: '1', SMTP_HOST: 'smtp.qq.com',
  SMTP_USER: 'bot@qq.com', SMTP_PASS: 'fake-test-password', MAIL_TO: 'Owner <owner@example.com>' };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-daily-mail-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function fixture(t) {
  const root = temp(t), out = path.join(root, date);
  const evidence = '这是一条根据公开资料核实的人工智能模型更新，说明具体功能与适用范围。';
  const sources = [{ id: 'S1', url: 'https://www.ithome.com/example', title: 'AI模型更新',
    published: '2026-11-08T01:00:00Z', text: evidence.repeat(20) }];
  const selected = [{ id: 'S1', key: 'model', reportedDate: date, eventDate: date, eventTime: '11月8日',
    evidence, reason: '这条报道提供了可核实的模型更新信息。', category: '模型' }];
  const report = { date, title: 'AI News Daily Report 11-08｜模型更新', summary: '今日1条AI资讯。',
    keywords: ['模型', '产品', '技术'], intro: '今天关注人工智能模型。', conclusion: '后续关注真实使用效果。',
    icons: ['🤖', '🧠', '💰', '⚡', '🎬', '🔬'],
    stories: [{ id: 'S1', key: 'model', eventTime: '11月8日', title: '模型更新',
      what: ['这是依据原文核实的人工智能模型功能。'.repeat(7), '这是依据原文核实的人工智能应用范围。'.repeat(7)],
      context: ['这是依据原文核实的研究背景和产品说明。'.repeat(7)],
      commentary: '实际效果还需要通过公开测试判断。'.repeat(3) }] };
  let call = 0;
  await generate({ date, out, config: {}, collect: async () => sources,
    request: async () => ++call === 1 ? { selected, rejected: [] } : report });
  fs.writeFileSync(path.join(out, 'cover.png'), 'fixture-cover');
  return { root, out };
}
async function reviewed(t) {
  const f = await fixture(t);
  const sent = [];
  await sendPreview({ ...f, date, env, send: async mail => { sent.push(mail); return true; } });
  return { ...f, sent, preview: loadPreviews(f.root)[0] };
}
function rawReply(id, { from = 'owner@example.com', text = '确认', html, headers = '', subject = 'Re: Preview' } = {}) {
  return Buffer.from(`From: ${from}\r\nTo: bot@qq.com\r\nSubject: ${subject}\r\nMessage-ID: <reply-1@example.com>\r\nIn-Reply-To: ${id}\r\n${headers}MIME-Version: 1.0\r\nContent-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html || text).toString('base64')}\r\n`);
}
const parse = source => simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true });

test('systemd shell entrypoints have executable Unix shebangs and LF line endings', () => {
  for (const name of ['run-daily.sh', 'check-replies.sh', 'install.sh']) {
    const source = fs.readFileSync(new URL(`../server/${name}`, import.meta.url), 'utf8');
    assert(source.startsWith('#!/usr/bin/env bash\n'), name);
    assert(!source.includes('\r'), name);
  }
});

test('QQ IMAP configuration reuses SMTP credentials but never disables TLS', () => {
  assert.deepEqual(addresses('Owner <OWNER@example.com>'), ['owner@example.com']);
  const config = reviewConfig(env);
  assert.equal(config.host, 'imap.qq.com');
  assert.equal(config.port, 993);
  assert.equal(config.user, env.SMTP_USER);
  assert.equal(config.replyTo, env.SMTP_USER);
  assert.throws(() => reviewConfig({ ...env, MAIL_APPROVAL_ENABLED: '0' }), /disabled/);
  assert.throws(() => reviewConfig({ ...env, SMTP_HOST: 'smtp.other.example' }), /incomplete/);
  assert.throws(() => reviewConfig({ ...env, MAIL_TO: '' }), /incomplete/);
  assert.deepEqual(reviewConfig({ ...env, MAIL_APPROVERS: 'owner@example.com, alias@example.com' }).senders,
    ['owner@example.com', 'alias@example.com']);
});

test('explicit approver aliases can confirm an existing preview without changing its delivery recipients', async t => {
  const { preview } = await reviewed(t);
  const mail = await parse(rawReply('<rewritten@example.com>', {
    from: 'alias@example.com', subject: `[AI-REVIEW:${preview.email.token}]`,
  }));
  assert.equal(matchingPreview(mail, [preview], ['owner@example.com']), null);
  assert.equal(matchingPreview(mail, [preview], ['owner@example.com', 'alias@example.com']), preview);
  assert.deepEqual(preview.email.recipients, ['owner@example.com']);
  assert.equal(matchingPreview(mail, [preview], ['different@example.com']), null);
});

test('successful full preview binds an unpredictable Message-ID to exact article and cover', async t => {
  const { out, sent, preview } = await reviewed(t);
  assert.match(preview.email.messageId, /^<ai-daily\.2026-11-08\.[a-f0-9-]+@qq.com>$/);
  assert.equal(preview.email.messageId, sent[0].messageId);
  assert.equal(preview.email.replyTo, 'bot@qq.com');
  assert.deepEqual(preview.email.recipients, ['owner@example.com']);
  assert.equal(preview.articleHash, articleHash(out, date));
  assert(sent[0].text.includes('正文只写：确认'));
  assert.match(preview.email.token, /^[a-f0-9]{32}$/);
  assert(sent[0].subject.includes(`[AI-REVIEW:${preview.email.token}]`));
  assert(sent[0].article.includes('发生了什么'));
  assert.equal(sent[0].images.length, 1);
});

test('an explicit publication byline is displayed without rewriting reviewed content', async t => {
  const f = await fixture(t);
  const before = articleHash(f.out, date);
  await sendPreview({ ...f, date, env: { ...env, WECHAT_AUTHOR: 'EDITOR' }, send: async mail => {
    assert(mail.text.includes('公众号作者署名：EDITOR'));
    return true;
  } });
  assert.equal(articleHash(f.out, date), before);
});

test('failed SMTP, changed cover and DRY_RUN never arm an email approval', async t => {
  const f = await fixture(t);
  await assert.rejects(() => sendPreview({ ...f, date, env, send: async () => false }), /delivery failed/);
  assert(!fs.existsSync(path.join(f.out, 'preview.sent.json')));
  await assert.rejects(() => sendPreview({ ...f, date, env, send: async () => {
    fs.writeFileSync(path.join(f.out, 'cover.png'), 'modified');
    return true;
  } }), /Cover changed/);
  assert(!fs.existsSync(path.join(f.out, 'preview.sent.json')));
  await sendPreview({ ...f, date, env: { ...env, DRY_RUN: '1' }, send: async () => true });
  assert(!read(path.join(f.out, 'preview.sent.json')).email);
});

test('confirmation parsing ignores quoted originals, not contradictory new instructions', async () => {
  for (const text of ['确认', ' 确认 \r\n', '确认\n\n> 原文含有其他内容',
    '确认\n\n------------------ 原始邮件 ------------------\n原文',
    '确认\n\nOn Sun, Nov 8, Bot wrote:\n原文', '确认\n\n发自我的QQ邮箱',
    '确认\n\n         原始邮件\n\n发件人：日报机器人\n原文']) {
    assert(isConfirmation(await parse(rawReply('<nonce@example.com>', { text }))), text);
  }
  for (const text of ['', '不确认', '确认后别发', '确认\n不要发布', '> 确认',
    '请修改文章\n\n> 确认', '确认。']) {
    assert(!isConfirmation(await parse(rawReply('<nonce@example.com>', { text }))), text);
  }
  assert(isConfirmation(await parse(rawReply('<nonce@example.com>', {
    html: '<div>确认</div><blockquote>上一封邮件内容</blockquote>',
  }))));
  assert(!isConfirmation(await parse(rawReply('<nonce@example.com>', {
    html: '<div>先不要发</div><blockquote>确认</blockquote>',
  }))));
});

test('only an allowed human sender with the current unique subject ID matches, independent of Message-ID', async t => {
  const { preview } = await reviewed(t);
  const sender = ['owner@example.com'], id = preview.email.messageId;
  const subject = `Re: Daily [AI-REVIEW:${preview.email.token}]`;
  assert.equal(matchingPreview(await parse(rawReply(id, { subject })), [preview], sender), preview);
  for (const options of [{ from: 'attacker@example.com' }, { from: 'owner@example.com, attacker@example.com' },
    { headers: 'Auto-Submitted: auto-replied\r\n' }, { headers: 'Precedence: bulk\r\n' }]) {
    assert.equal(matchingPreview(await parse(rawReply(id, { subject, ...options })), [preview], sender), null);
  }
  assert.equal(matchingPreview(await parse(rawReply('<old@example.com>')), [preview], sender), null);
  const subjectOnly = await parse(Buffer.from('From: owner@example.com\r\nSubject: Re: AI News Daily Report 11-08\r\n\r\n确认'));
  assert.equal(matchingPreview(subjectOnly, [preview], sender), null);
  const refs = await parse(Buffer.from(`From: owner@example.com\r\nReferences: <old@example.com> ${id}\r\n\r\n`));
  assert.equal(matchingPreview(refs, [preview], sender), null, 'Message-ID alone is not an approval identifier');
  const rewritten = await parse(rawReply('<provider-rewritten@qq.com>', {
    subject,
  }));
  assert.equal(matchingPreview(rewritten, [preview], sender), preview);
  rewritten.subject = `Re: Daily [AI-REVIEW:${'0'.repeat(32)}]`;
  assert.equal(matchingPreview(rewritten, [preview], sender), null);
  rewritten.subject = `Re: Daily [AI-REVIEW:${preview.email.token}]`;
  delete rewritten.inReplyTo;
  assert.equal(matchingPreview(rewritten, [preview], sender), preview, 'subject ID does not depend on reply headers');
  rewritten.subject += ` [AI-REVIEW:${'1'.repeat(32)}]`;
  assert.equal(matchingPreview(rewritten, [preview], sender), null, 'ambiguous identifiers are rejected');
});

test('confirmation is persisted once and only a verified publication counts as complete', async t => {
  const { root, out, preview } = await reviewed(t);
  const mail = await parse(rawReply(preview.email.messageId));
  const notices = [], send = async m => { notices.push(m); return true; };
  assert(await acceptReply(mail, preview, { uid: 7, validity: '1' }, { send }));
  assert.equal(await acceptReply(mail, preview, { uid: 8, validity: '1' }, { send }), false);
  let attempts = 0;
  const execute = async a => {
    attempts++;
    recordPublication(out, date, a.articleHash, 'published');
    return 0;
  };
  await processApprovals({ root, senders: ['owner@example.com'], execute, send });
  await processApprovals({ root, senders: ['owner@example.com'], execute, send });
  assert.equal(attempts, 1);
  assert.equal(read(path.join(out, 'email-approval.json')).status, 'completed');
});

test('busy pipeline is retried, but crashes, uncertain success and interrupted attempts are not replayed', async t => {
  for (const exit of [0, 1, null]) {
    const { root, out, preview } = await reviewed(t);
    await acceptReply(await parse(rawReply(preview.email.messageId)), preview, { uid: 9 }, { send: async () => true });
    const opts = { root, senders: ['owner@example.com'], send: async () => true };
    await processApprovals({ ...opts, execute: async () => 75 });
    assert.equal(read(path.join(out, 'email-approval.json')).status, 'pending');
    await processApprovals({ ...opts, execute: async () => exit });
    assert(['failed', 'uncertain'].includes(read(path.join(out, 'email-approval.json')).status));
    await processApprovals({ ...opts, execute: () => assert.fail('must not replay') });
  }
  const { root, out, preview } = await reviewed(t);
  await acceptReply(await parse(rawReply(preview.email.messageId)), preview, { uid: 10 });
  const file = path.join(out, 'email-approval.json');
  write(file, { ...read(file), status: 'running' });
  await processApprovals({ root, senders: ['owner@example.com'], send: async () => true,
    execute: () => assert.fail('interrupted publication requires review') });
  assert.equal(read(file).status, 'uncertain');
});

test('changed content or preview identity blocks queued approvals before starting a browser', async t => {
  const { root, out, preview } = await reviewed(t);
  await acceptReply(await parse(rawReply(preview.email.messageId)), preview, { uid: 1 });
  fs.writeFileSync(path.join(out, 'cover.png'), 'changed-after-approval');
  await processApprovals({ root, senders: ['owner@example.com'], send: async () => true,
    execute: () => assert.fail('changed preview must not publish') });
  assert.equal(read(path.join(out, 'email-approval.json')).status, 'stale');
});

test('IMAP startup skips historical mail; later polls only download matching replies and persist a cursor', async t => {
  const { root, out, preview } = await reviewed(t);
  const stateDir = path.join(root, 'state'), config = reviewConfig(env), downloads = [];
  const unrelated = rawReply('<unrelated@example.com>');
  const reply = rawReply(preview.email.messageId, { subject: `[AI-REVIEW:${preview.email.token}]` });
  const client = {
    usable: true, mailbox: { uidValidity: 123n, uidNext: 11 },
    connect: async () => {}, logout: async () => {}, close: () => {},
    getMailboxLock: async (_, options) => { assert(options.readOnly); return { release() {} }; },
    search: async () => [11, 12],
    fetchOne: async (uid, query) => {
      const source = uid === 11 ? unrelated : reply;
      if (query.source) { downloads.push(uid); return { source }; }
      return { size: source.length, headers: Buffer.from(source.toString().split('\r\n\r\n')[0] + '\r\n\r\n') };
    },
  };
  await pollMailbox({ config, root, stateDir, client });
  assert.equal(read(path.join(stateDir, 'mail-cursor.json')).lastUid, 10);
  client.mailbox.uidNext = 13;
  await pollMailbox({ config, root, stateDir, client });
  assert.deepEqual(downloads, [12]);
  assert.equal(read(path.join(out, 'email-approval.json')).status, 'pending');
  assert.equal(read(path.join(stateDir, 'mail-cursor.json')).lastUid, 12);
  await pollMailbox({ config, root, stateDir, client });
  assert.deepEqual(downloads, [12]);
  client.mailbox.uidValidity = 124n;
  let warned = false;
  await pollMailbox({ config, root, stateDir, client, send: async () => { warned = true; return true; } });
  assert(warned);
  assert.equal(read(path.join(stateDir, 'mail-cursor.json')).validity, '124');
});

test('publication lookup compares the full date/title, not the shared AI News Daily prefix', () => {
  const body = '已发表 AI News Daily Report 11-07｜旧稿 阅读 123';
  assert.equal(findPublishedTitle(body, 'AI News Daily Report 11-08', true), -1);
  assert(findPublishedTitle(body, 'AI News Daily Report 11-07', true) >= 0);
  assert.equal(findPublishedTitle(body, 'AI News Daily Report 11-07｜新稿'), -1);
  assert(findPublishedTitle(body, 'AI News Daily Report 11-07｜旧稿') >= 0);
  assert(findPublishedTitle(body.replaceAll(' ', '\u00a0'), 'AI News Daily Report 11-07', true) >= 0);
});

test('standalone administrator QR prompts are recognized outside dialog wrappers and article content', () => {
  const element = (innerText, { visible = true, editor = false } = {}) =>
    ({ innerText, visible, closest: () => editor ? {} : null });
  const check = elements => hasStandaloneAdminVerification({ querySelectorAll: () => elements }, e => e.visible);
  const title = element('微信验证'), instruction = element('扫码后，请联系管理员进行验证');
  assert(check([title, instruction]));
  assert(check([element(' \n微信验证\n '), instruction]));
  assert.equal(check([title]), false);
  assert.equal(check([instruction]), false);
  assert.equal(check([title, element(instruction.innerText, { visible: false })]), false);
  assert.equal(check([title, element(instruction.innerText, { editor: true })]), false);
  assert.equal(check([element('文章讨论微信验证'), instruction]), false);
});

test('confirmed cached content runs through the real Linux pipeline with only browser and SMTP mocked',
  { skip: process.platform === 'win32' }, async t => {
    const { out: original, preview } = await reviewed(t);
    const home = temp(t), out = path.join(home, 'output', date);
    fs.cpSync(original, out, { recursive: true });
    const skill = path.join(home, 'skill'), scripts = path.join(skill, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(path.join(skill, 'server'));
    fs.copyFileSync(fileURLToPath(new URL('../server/run-daily.sh', import.meta.url)), path.join(skill, 'server', 'run-daily.sh'));
    const productionGenerator = new URL('./generate-article.mjs', import.meta.url).href;
    fs.writeFileSync(path.join(scripts, 'generate-article.mjs'), `
      import {cachedReport, checkApproval, recordPublication} from ${JSON.stringify(productionGenerator)};
      const args=process.argv.slice(2), get=k=>args[args.indexOf('--'+k)+1];
      if(args.includes('--check-config')) {}
      else if(args.includes('--check-approval')) checkApproval(get('out'),get('date'),get('sha'));
      else if(args.includes('--record-publication')) recordPublication(get('out'),get('date'),get('sha'),get('status'));
      else { if(!args.includes('--cached-only')) throw new Error('Must never regenerate an approved email'); console.log('TITLE '+cachedReport(get('out'),get('date')).title); }
    `);
    fs.writeFileSync(path.join(scripts, 'wechat-login.mjs'), "console.log('MOCK_LOGIN_OK');");
    fs.writeFileSync(path.join(scripts, 'wechat-publish.mjs'), `
      import fs from 'node:fs';
      if(process.argv.includes('--check-title')) process.exit(2);
      fs.appendFileSync(process.env.TEST_ATTEMPTS,'one-attempt\\n');
      console.log('[publish] PUBLISHED');
    `);
    fs.writeFileSync(path.join(scripts, 'chrome.mjs'), 'export async function closeChrome() {}');
    fs.writeFileSync(path.join(scripts, 'notify.mjs'), "console.log('MOCK_MAIL_OK');");
    fs.writeFileSync(path.join(out, 'appmsgid'), 'fixture-draft');
    fs.writeFileSync(path.join(out, 'cover.done'), '');
    const conf = path.join(home, 'config.env');
    fs.writeFileSync(conf, 'PUBLISH_MODE=preview\nDRY_RUN=1\nPROXY=socks5h://127.0.0.1:1\nRUN_AFTER_HOUR=99\n');
    const attempts = path.join(home, 'attempts');
    const result = await executePublication({ date, articleHash: preview.articleHash }, {
      ...process.env, AI_DAILY_SKILL: skill, AI_DAILY_HOME: home,
      AI_DAILY_CONFIG: conf, XDG_RUNTIME_DIR: home, DISPLAY: ':fixture', TEST_ATTEMPTS: attempts,
    });
    assert.equal(result, 0);
    assert.equal(fs.readFileSync(attempts, 'utf8'), 'one-attempt\n');
    assert.equal(read(path.join(out, 'publication.result.json')).status, 'published');
    assert.equal(articleHash(out, date), preview.articleHash);
  });
