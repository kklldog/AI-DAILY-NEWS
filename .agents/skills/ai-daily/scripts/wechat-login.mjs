// Ensure Chrome (shared baoyu profile, CDP port) is logged in to mp.weixin.qq.com.
// If not logged in: screenshot the login QR code and email it (notify.mjs); refresh + resend when it expires.
// usage: node wechat-login.mjs [--port 9333] [--wait 3600] [--max-mails 8] [--qr-out qr.png] [--no-mail] [--close]
// Output: "[login] LOGGED_IN token=N" (exit 0) | "[login] NEED_QR_SCAN" | "[login] FAILED ..." (exit 1)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureChrome, targets as cdpTargets, closeChrome, sleep } from './chrome.mjs';
import { notify } from './notify.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((a, v, i, arr) => (v.startsWith('--') && a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]), a), []));
const port = +(args.port || 9333);
const waitSec = +(args.wait || 3600);
const maxMails = +(args['max-mails'] || 8);
const qrOut = path.resolve(args['qr-out'] || path.join(os.tmpdir(), 'wechat-login-qr.png'));
const noMail = !!args['no-mail'];
const QR_SEL = ['img.login__type__container__scan__qrcode', '.login__type__container__scan img', '.login_img img', 'img[src*="scanloginqrcode"]', 'img[src*="qrcode"]'];

const targets = async () => (await cdpTargets(port)) || [];
const loggedIn = async () => {
  const t = (await targets()).find(x => x.type === 'page' && /mp\.weixin\.qq\.com.*token=\d+/.test(x.url));
  return t && t.url.match(/token=(\d+)/)[1];
};
const done = async (code, msg) => {
  console.log(msg);
  if (args.close) await closeChrome(port);
  process.exit(code);
};

try { await ensureChrome(port, 'login'); } catch (e) { await done(1, `[login] FAILED ${e.message}`); }

// CDP session on the mp page
let ws, id = 0; const pending = new Map();
async function attach() {
  let t = (await targets()).find(x => x.type === 'page' && x.url.includes('mp.weixin.qq.com'));
  if (!t) {
    t = (await targets()).find(x => x.type === 'page');
    if (!t) return false;
  }
  try { ws?.close(); } catch {}
  ws = new WebSocket(t.webSocketDebuggerUrl);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return true;
}
const send = (method, params = {}) => new Promise(r => {
  const i = ++id; pending.set(i, r);
  try { ws.send(JSON.stringify({ id: i, method, params })); } catch { pending.delete(i); r({ error: 'send' }); }
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); r({ error: 'timeout' }); } }, 20000);
});
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

// already logged in? (give the start page a moment to redirect)
for (let i = 0; i < 8; i++) {
  const tk = await loggedIn();
  if (tk) await done(0, `[login] LOGGED_IN token=${tk}`);
  await sleep(1500);
}

if (!(await attach())) await done(1, '[login] FAILED no page');
await send('Page.enable');
await send('Page.navigate', { url: 'https://mp.weixin.qq.com/' });
await sleep(5000);

async function captureQr() {
  // Prefer exporting the already-loaded <img> through a canvas (exact pixels, no re-request);
  // fall back to a clipped screenshot if the canvas is tainted.
  const box = await evaluate(`(async()=>{
    const sels=${JSON.stringify(QR_SEL)};
    for(let i=0;i<20;i++){
      for(const s of sels){const e=document.querySelector(s);
        if(e&&e.complete&&e.naturalWidth>50){
          try{const k=Math.max(1,Math.ceil(400/e.naturalWidth)),w=e.naturalWidth*k,h=e.naturalHeight*k,p=Math.round(w*0.08);
            const c=document.createElement('canvas');c.width=w+2*p;c.height=h+2*p;const x=c.getContext('2d');
            x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.imageSmoothingEnabled=false;x.drawImage(e,p,p,w,h);
            return {data:c.toDataURL('image/png').split(',')[1]};}catch{}
          e.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>setTimeout(r,400));const r=e.getBoundingClientRect();if(r.width>50)return {x:r.x+window.scrollX,y:r.y+window.scrollY,w:r.width,h:r.height};}}
      await new Promise(r=>setTimeout(r,500));
    }
    return null;})()`);
  if (!box) return false;
  if (box.data) { fs.writeFileSync(qrOut, Buffer.from(box.data, 'base64')); return true; }
  const pad = 12;
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2, scale: 3 }, captureBeyondViewport: true });
  if (!r.result?.data) return false;
  fs.writeFileSync(qrOut, Buffer.from(r.result.data, 'base64'));
  return true;
}
async function fullShot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  return file;
}

const deadline = Date.now() + waitSec * 1000;
let mails = 0, lastSent = 0;
const expiredExpr = `/二维码已(失效|过期)|已过期|点击刷新/.test(document.body.innerText)&&!!document.querySelector('.login__type__container__scan')`;

async function sendQr(reason) {
  if (!(await captureQr())) { console.log('[login] QR element not found'); return false; }
  console.log(`[login] NEED_QR_SCAN QR saved to ${qrOut} (${reason})`);
  lastSent = Date.now();
  if (noMail || mails >= maxMails) return true;
  mails++;
  const left = Math.round((deadline - Date.now()) / 60000);
  await notify({
    subject: `【AI News Daily Report】公众号需要扫码登录 (${mails}/${maxMails})`,
    text: `服务器上的公众号后台登录已失效，请用「微信」扫描下方二维码，并在手机上选择你要运营的公众号确认登录。\n\n提示：请在电脑屏幕上打开这封邮件再用手机扫（同一部手机长按识别可能无效）。\n二维码约 5 分钟后过期，过期后会自动刷新并重新发送；脚本最多再等待约 ${left} 分钟。\n\n${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    images: [qrOut],
  });
  return true;
}

await sendQr('initial');
while (Date.now() < deadline) {
  await sleep(3000);
  const tk = await loggedIn();
  if (tk) {
    if (mails) await notify({ subject: '【AI News Daily Report】公众号登录成功', text: '扫码登录成功，今日任务继续执行。' });
    await done(0, `[login] LOGGED_IN token=${tk}`);
  }
  let expired = false;
  try { expired = await evaluate(expiredExpr); } catch {}
  // expired QR, or the page has been sitting > 4.5 min (WeChat QR lifetime ≈ 5 min): reload for a fresh code
  if (expired || Date.now() - lastSent > 270000) {
    if (!(await attach())) continue;
    await send('Page.navigate', { url: 'https://mp.weixin.qq.com/' });
    await sleep(5000);
    if (await loggedIn()) continue;
    if (mails >= maxMails && !noMail) { lastSent = Date.now(); console.log('[login] mail limit reached, still waiting'); continue; }
    await sendQr(expired ? 'expired, refreshed' : 'refresh');
  }
}

const shot = await fullShot(path.join(os.tmpdir(), 'wechat-login-timeout.png')).catch(() => null);
await notify({ subject: '【AI News Daily Report】扫码登录超时，今日未发布', text: `等待 ${Math.round(waitSec / 60)} 分钟仍未扫码登录，本次发表已中止。不会自动重复执行这次确认；请检查服务器日志。每日定时任务仍只发送预览。`, images: shot ? [shot] : [] });
await done(1, '[login] FAILED login timeout');
