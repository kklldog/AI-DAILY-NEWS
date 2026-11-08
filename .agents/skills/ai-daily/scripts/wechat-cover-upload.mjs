// Upload a cover image to an existing WeChat MP draft and save it.
// usage: node wechat-cover-upload.mjs --appmsgid <id> --cover <abs path to png/jpg> [--port 9333]
// Requires Chrome logged in to mp.weixin.qq.com. If no Chrome with CDP is on the port,
// launches one with the shared baoyu-skills profile (same login as baoyu-post-to-wechat).
import fs from 'node:fs';
import path from 'node:path';
import { ensureChrome, targets as cdpTargets, sleep } from './chrome.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') && a.push([v.slice(2), arr[i + 1]]), a), []));
const port = +(args.port || 9333);
const appmsgid = args.appmsgid;
const cover = args.cover && path.resolve(args.cover);
if (!appmsgid || !cover || !fs.existsSync(cover)) { console.error('need --appmsgid and existing --cover'); process.exit(1); }

const targets = async () => (await cdpTargets(port)) || [];
await ensureChrome(port, 'cover');

let ws, id = 0; const pending = new Map();
async function attach(match) {
  const t = (await targets()).find(x => x.type === 'page' && x.url.includes(match));
  if (!t) return false;
  if (ws) ws.close();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise(r => ws.onopen = r);
  return true;
}
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

// 1. wait for login (token in URL)
let token;
for (let i = 0; i < 120; i++) {
  const t = (await targets()).find(x => x.type === 'page' && /mp\.weixin\.qq\.com.*token=\d+/.test(x.url));
  if (t) { token = t.url.match(/token=(\d+)/)[1]; break; }
  if (i === 0) console.log('[cover] waiting for login - scan the QR code in Chrome...');
  await sleep(2000);
}
if (!token) { console.error('[cover] login timeout'); process.exit(1); }

// 2. open draft editor
await attach('token=');
await send('Page.navigate', { url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${appmsgid}&token=${token}&lang=zh_CN` });
await sleep(6000);
await attach('appmsg_edit');

// 3. open image library dialog from cover area
const opened = await evaluate(`(async()=>{const a=document.querySelector('a.js_imagedialog'); if(!a) return false; document.querySelector('.js_cover_btn_area')?.scrollIntoView({block:'center'}); a.click(); await new Promise(r=>setTimeout(r,2500)); return !!document.querySelector('.js_upload_btn_container input[type=file]');})()`);
if (!opened) { console.error('[cover] cannot open image dialog'); process.exit(1); }

// 4. upload file
await send('DOM.enable');
const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
const q = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: '.js_upload_btn_container input[type=file]' });
const nodeId = q.result.nodeIds.at(-1);
await send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(cover)] });
console.log('[cover] uploading...');
await sleep(8000);

// 5. next -> crop -> confirm -> save draft
const clickBtn = text => evaluate(`(()=>{const b=[...document.querySelectorAll('.weui-desktop-dialog button')].find(b=>b.offsetParent&&b.innerText.trim()==='${text}'); if(!b) return false; b.click(); return true;})()`);
if (!(await clickBtn('下一步'))) { console.error('[cover] no 下一步 button (upload may have failed)'); process.exit(1); }
await sleep(3000);
if (!(await clickBtn('确认'))) { console.error('[cover] no 确认 button in crop dialog'); process.exit(1); }
await sleep(4000);
const result = await evaluate(`(async()=>{const s=[...document.querySelectorAll('button,a,span')].find(b=>b.offsetParent&&b.innerText.trim()==='保存为草稿'); s.scrollIntoView({block:'center'}); s.click(); await new Promise(r=>setTimeout(r,4000)); const p=document.querySelector('.js_cover_preview_new'); return {cover:p&&getComputedStyle(p).backgroundImage, saved:document.body.innerText.includes('已保存')};})()`);
console.log('[cover] result', JSON.stringify(result));
if (!result?.cover?.includes('mmbiz')) { console.error('[cover] cover not detected'); process.exit(1); }
console.log('[cover] done. Draft saved with cover. Browser left open.');
ws.close(); process.exit(0);
