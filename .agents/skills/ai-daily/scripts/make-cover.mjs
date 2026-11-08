// Render the AI News Daily Report cover (2.35:1, 1536x654) from an HTML template with headless Chrome.
// usage: node make-cover.mjs --date 2026-11-05 --icons "🛡️,🗳️,🔌,📦,🦾,📈" --out cover.png
// Icons: 6 emoji related to the day's news (fewer → padded with defaults). Needs an emoji font
// (Linux: fonts-noto-color-emoji; Windows: Segoe UI Emoji built in).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { noSandbox } from './chrome.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((a, v, i, arr) => (v.startsWith('--') && a.push([v.slice(2), arr[i + 1]]), a), []));
const date = args.date || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const out = path.resolve(args.out || 'cover.png');
const defaults = ['🧠', '💬', '🖥️', '📈', '🔐', '🌐'];
const icons = [...(args.icons || '').split(/[,，\s]+/).filter(Boolean), ...defaults].slice(0, 6);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const W = 1536, H = 654, cx = 1110, cy = 330;
// card centres around the chip (hexagon-ish)
const pos = [[-305, -165], [0, -212], [305, -165], [-305, 165], [0, 212], [305, 165]];
const cards = pos.map(([dx, dy], i) => `<div class="card" style="left:${cx + dx - 70}px;top:${cy + dy - 62}px">${esc(icons[i])}</div>`).join('');
const lines = pos.map(([dx, dy]) => `<line x1="${cx}" y1="${cy}" x2="${cx + dx * 0.78}" y2="${cy + dy * 0.78}"/><circle cx="${cx + dx * 0.62}" cy="${cy + dy * 0.62}" r="7"/>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:"Inter","Segoe UI","Noto Sans","Helvetica Neue",Arial,sans-serif;
 background:#f3f6fb;
 background-image:linear-gradient(rgba(37,99,235,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(37,99,235,.07) 1px,transparent 1px),
  linear-gradient(rgba(37,99,235,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(37,99,235,.035) 1px,transparent 1px);
 background-size:120px 120px,120px 120px,24px 24px,24px 24px;position:relative}
.guide{position:absolute;border:0 dashed rgba(37,99,235,.35)}
.gh{left:0;right:0;border-top-width:1px}.gv{top:0;bottom:0;border-left-width:1px}
.mark{position:absolute;width:22px;height:22px;border:1.5px solid rgba(37,99,235,.55);border-radius:50%}
.title{position:absolute;left:120px;top:150px}
.t1,.t2{font-weight:800;font-size:96px;line-height:1.02;color:#0b2a6b;letter-spacing:-2px}
.date{margin-top:26px;font-weight:700;font-size:60px;color:#1677ff;letter-spacing:1px}
svg{position:absolute;left:0;top:0}
svg line{stroke:#3b82f6;stroke-width:3;opacity:.75}
svg circle{fill:#60a5fa;stroke:#fff;stroke-width:3;filter:drop-shadow(0 0 6px #38bdf8)}
.ring{position:absolute;left:${cx - 330}px;top:${cy - 250}px;width:660px;height:500px;border:2px dashed rgba(59,130,246,.25);border-radius:50%}
.chip{position:absolute;left:${cx - 105}px;top:${cy - 85}px;width:210px;height:170px;border-radius:26px;
 background:linear-gradient(145deg,#2563eb,#1e3a8a);box-shadow:0 0 0 10px rgba(219,234,254,.9),0 0 60px 12px rgba(56,189,248,.55),0 18px 30px rgba(30,58,138,.35);
 display:flex;align-items:center;justify-content:center}
.chip:before{content:"";position:absolute;inset:-26px 22px;background:repeating-linear-gradient(90deg,#3b82f6 0 8px,transparent 8px 20px);z-index:-1;border-radius:6px}
.chip:after{content:"";position:absolute;inset:22px -26px;background:repeating-linear-gradient(0deg,#3b82f6 0 8px,transparent 8px 20px);z-index:-1;border-radius:6px}
.core{width:150px;height:112px;border:3px solid #7dd3fc;border-radius:16px;display:flex;align-items:center;justify-content:center;
 color:#e0f2fe;font-weight:800;font-size:58px;text-shadow:0 0 18px #38bdf8;background:rgba(30,64,175,.6)}
.card{position:absolute;width:140px;height:124px;border-radius:22px;background:rgba(255,255,255,.72);
 border:1.5px solid rgba(255,255,255,.95);box-shadow:0 14px 30px rgba(30,64,175,.16),inset 0 0 0 1px rgba(147,197,253,.5);
 display:flex;align-items:center;justify-content:center;font-size:64px;
 font-family:"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif}
.amber{position:absolute;left:${cx + 92}px;top:${cy - 98}px;width:16px;height:16px;border-radius:50%;background:#f59e0b;box-shadow:0 0 14px #fbbf24}
</style></head><body>
<div class="guide gh" style="top:36px"></div><div class="guide gh" style="bottom:36px"></div>
<div class="guide gv" style="left:36px"></div><div class="guide gv" style="right:36px"></div>
<div class="mark" style="left:25px;top:25px"></div><div class="mark" style="right:25px;top:25px"></div>
<div class="mark" style="left:25px;bottom:25px"></div><div class="mark" style="right:25px;bottom:25px"></div>
<div class="title"><div class="t1">AI News</div><div class="t2">Daily Report</div><div class="date">${esc(date)}</div></div>
<div class="ring"></div>
<svg width="${W}" height="${H}">${lines}</svg>
<div class="chip"><div class="core">AI</div></div><div class="amber"></div>
${cards}
</body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cover-'));
const htmlFile = path.join(tmp, 'cover.html');
fs.writeFileSync(htmlFile, html);
const chrome = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && fs.existsSync(p));
if (!chrome) { console.error('[cover] Chrome not found (set CHROME_PATH)'); process.exit(1); }
const flags = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${W},${H}`,
  `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', `--screenshot=${out}`, '--virtual-time-budget=3000'];
if (noSandbox()) flags.push('--no-sandbox');
const r = spawnSync(chrome, [...flags, pathToFileURL(htmlFile).href], { encoding: 'utf8', timeout: 60000 });
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (!fs.existsSync(out) || fs.statSync(out).size < 10000) { console.error('[cover] screenshot failed', r.stderr?.slice(-500)); process.exit(1); }
console.log('[cover] saved', out, `(${icons.join(' ')})`);
