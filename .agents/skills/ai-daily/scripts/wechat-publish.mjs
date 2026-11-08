// Publish (发表) an existing WeChat MP draft.
// usage: node wechat-publish.mjs --appmsgid <id> [--port 9333] [--wait 600] [--dry-run]
//        node wechat-publish.mjs --check-title "AI News Daily Report 11-06"   (only check 发表记录: exit 0 found / 2 not found)
// Flow: draft editor → bottom「发表」→ .new_mass_send_dialog「发表」→ confirm dialogs
//       (e.g. "未开启群发通知") → optional admin WeChat QR verification → verify in 发表记录.
// Output markers: "[publish] NEED_QR_SCAN" (admin must scan in Chrome), "[publish] PUBLISHED" (exit 0),
// "[publish] FAILED ..." (exit 1), "[publish] NOT_VERIFIED" (exit 2: flow finished but not found in 发表记录).
// --dry-run opens the publish dialog, prints it and clicks 取消 (nothing is published).
import { ensureChrome, targets as cdpTargets, sleep } from './chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notify } from './notify.mjs';
import { findPublishedTitle, hasStandaloneAdminVerification } from './publication-utils.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((a, v, i, arr) => (v.startsWith('--') && a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]), a), []));
const port = +(args.port || 9333);
const appmsgid = args.appmsgid;
const waitSec = +(args.wait || 600);
const dryRun = !!args['dry-run'];
if (!appmsgid && !args['check-title']) { console.error('[publish] FAILED need --appmsgid'); process.exit(1); }

const targets = () => cdpTargets(port);
const fail = msg => { console.error(`[publish] FAILED ${msg}`); process.exit(1); };

try { await ensureChrome(port, 'publish'); } catch (e) { fail(e.message); }

let ws, wsTarget, id = 0; const pending = new Map();
async function attach(match) {
  const t = ((await targets()) || []).find(x => x.type === 'page' && x.url.includes(match));
  if (!t) return false;
  if (ws && wsTarget === t.id && ws.readyState === 1) return true;
  const old = ws;
  const sock = ws = new WebSocket(t.webSocketDebuggerUrl); wsTarget = t.id;
  if (old) { old.onclose = null; try { old.close(); } catch {} }
  sock.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  sock.onclose = () => { if (ws !== sock) return; for (const [k, r] of pending) { r({ error: 'closed' }); pending.delete(k); } };
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
  return true;
}
const send = (method, params = {}) => new Promise(r => {
  const i = ++id; pending.set(i, r);
  try { ws.send(JSON.stringify({ id: i, method, params })); } catch { pending.delete(i); r({ error: 'send' }); }
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); r({ error: 'timeout' }); } }, 20000);
});
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

// shared in-page helpers
const H = `const vis=e=>!!(e&&(e.offsetParent||e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden');
const dialogs=()=>[...document.querySelectorAll('.weui-desktop-dialog,.weui-desktop-dialog__wrp,[role=dialog]')].filter(vis);
const txt=e=>(e.innerText||'').trim();`;

// 1. wait for login
let token;
for (let i = 0; i < 120; i++) {
  const t = ((await targets()) || []).find(x => x.type === 'page' && /mp\.weixin\.qq\.com.*token=\d+/.test(x.url));
  if (t) { token = t.url.match(/token=(\d+)/)[1]; break; }
  if (i === 0) console.log('[publish] NEED_LOGIN waiting for login - scan the QR code in Chrome...');
  await sleep(2000);
}
if (!token) fail('login timeout');

// --check-title: only check 发表记录 (exit 0 if already published, 2 if not)
if (args['check-title']) await verify(String(args['check-title']), '');

// 2. open draft editor
await attach('token=');
await send('Page.navigate', { url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${appmsgid}&token=${token}&lang=zh_CN` });
await sleep(7000);
if (!(await attach('appmsg_edit'))) fail('editor not opened');
const title = await evaluate(`(document.querySelector('#title')||document.querySelector('textarea[name=title],input[name=title]'))?.value||''`);
console.log('[publish] title:', title);
if (!title) fail('draft not found or has no title (wrong appmsgid?)');

// 3. bottom「发表」→ wait for publish dialog
const opened = await evaluate(`(async()=>{${H}
const b=[...document.querySelectorAll('button,a,span')].filter(vis).filter(e=>txt(e)==='发表'&&!e.closest('.weui-desktop-dialog')).pop();
if(!b) return 'no-button'; b.scrollIntoView({block:'center'}); b.click();
for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,500)); const d=document.querySelector('.new_mass_send_dialog'); if(d&&vis(d)) return txt(d).slice(0,400);}
return 'no-dialog';})()`);
if (!opened || opened === 'no-button' || opened === 'no-dialog') fail(`cannot open publish dialog (${opened})`);
console.log('[publish] dialog:', opened.replace(/\s+/g, ' '));

if (dryRun) {
  await evaluate(`(()=>{${H}const d=document.querySelector('.new_mass_send_dialog');const b=[...d.querySelectorAll('button')].filter(vis).find(b=>txt(b)==='取消');b&&b.click();return !!b;})()`);
  console.log('[publish] DRY_RUN ok - dialog cancelled, nothing published');
  ws.close(); process.exit(0);
}

// 4. click 发表 inside the dialog
const clicked = await evaluate(`(()=>{${H}const d=document.querySelector('.new_mass_send_dialog');const b=[...d.querySelectorAll('button')].filter(vis).find(b=>txt(b)==='发表');if(!b) return false;b.click();return true;})()`);
if (!clicked) fail('no 发表 button in publish dialog');
console.log('[publish] clicked 发表 in dialog');

// 5. handle confirmations / QR verification until success or timeout
const confirmTexts = ['继续发表', '确定', '确认', '发表', '我知道了'];
let qrNotified = false, done = false;
const deadline = Date.now() + waitSec * 1000;
while (Date.now() < deadline) {
  await sleep(2000);
  let st;
  try {
    st = await evaluate(`(()=>{${H}
const body=document.body.innerText;
const standaloneQr=${hasStandaloneAdminVerification.toString()};
if(standaloneQr(document,vis)) return {s:'qr',t:'微信验证：扫码后，请联系管理员进行验证'};
if(/发表成功|已发表|群发成功/.test(body)&&!dialogs().some(d=>/扫码|验证/.test(txt(d)))) return {s:'ok'};
const ds=dialogs().filter(d=>!d.closest('.new_mass_send_dialog')||d.closest('.double_check_dialog'));
for(const d of ds.reverse()){
  const t=txt(d);
  if(/扫码|扫一扫|微信验证|身份验证|管理员/.test(t)&&(d.querySelector('img,canvas,iframe'))) return {s:'qr',t:t.slice(0,200)};
  const btn=[...d.querySelectorAll('button')].filter(vis).find(b=>${JSON.stringify(confirmTexts)}.includes(txt(b)));
  if(btn&&!/扫码/.test(t)){btn.click();return {s:'confirm',t:t.slice(0,200),b:txt(btn)};}
}
return {s:'wait',url:location.href};})()`);
  } catch { st = null; }
  if (!st) { // page navigated or socket dropped → reattach and check url
    const t = ((await targets()) || []).find(x => x.type === 'page' && x.url.includes('mp.weixin.qq.com'));
    if (t && !t.url.includes('appmsg_edit')) { console.log('[publish] navigated to', t.url); done = true; break; }
    await attach('mp.weixin.qq.com').catch(() => {});
    continue;
  }
  if (st.s === 'ok') { done = true; break; }
  if (st.s === 'confirm') console.log(`[publish] confirmed「${st.b}」: ${st.t.replace(/\s+/g, ' ')}`);
  if (st.s === 'qr' && !qrNotified) {
    qrNotified = true;
    console.log('[publish] NEED_QR_SCAN admin verification required');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result?.data) fail('cannot capture administrator verification QR');
    const file = path.resolve(args['qr-out'] || path.join(os.tmpdir(), 'wechat-publish-qr.png'));
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'), { mode: 0o600 });
    const delivered = await notify({ subject: '【AI News Daily Report】发表需要管理员扫码确认',
      text: `已收到邮件确认，正在发表「${title}」。请用管理员微信扫描下图中的验证码，服务器最多等待 ${Math.ceil(waitSec / 60)} 分钟。`,
      images: [file] });
    if (!delivered) fail('administrator verification email was not delivered');
  }
  if (st.s === 'wait' && st.url && !st.url.includes('appmsg_edit')) { done = true; break; }
}
if (!done) console.log('[publish] flow did not reach a success state before timeout; checking 发表记录 anyway');

// 6. verify in 发表记录
await verify(title, '(draft kept)');

async function verify(title, failNote) {
  await sleep(3000);
  await attach('mp.weixin.qq.com');
  await send('Page.navigate', { url: `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10&token=${token}&lang=zh_CN` });
  const key = title.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    if (i === 10) await send('Page.reload');
    if (!(await attach('appmsgpublish').catch(() => false))) continue;
    // WeChat renders title spaces as &nbsp; → normalize all whitespace before matching
    const st = await evaluate(`(()=>{const b=document.body.innerText.replace(/\\s+/g,' ');const find=${findPublishedTitle.toString()};const i=find(b,${JSON.stringify(key)},${Boolean(args['check-title'])});return i<0?null:b.slice(Math.max(0,i-20),i);})()`);
    if (st != null) { console.log('[publish] PUBLISHED - found in 发表记录 (' + st.trim() + '):', title); ws.close(); process.exit(0); }
  }
  console.log(`[publish] NOT_VERIFIED - title not found in 发表记录 ${failNote}. title:`, title);
  ws.close(); process.exit(2);
}
