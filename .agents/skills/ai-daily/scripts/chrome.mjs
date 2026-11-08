// Shared Chrome helpers for the ai-daily scripts (Windows / Linux / macOS).
// Env: CHROME_PATH (browser binary), BAOYU_CHROME_PROFILE_DIR (profile, shared with baoyu-post-to-wechat).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function chromePath() {
  return [process.env.CHROME_PATH, process.env.WECHAT_BROWSER_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && fs.existsSync(p));
}

export function profileDir() {
  if (process.env.BAOYU_CHROME_PROFILE_DIR) return process.env.BAOYU_CHROME_PROFILE_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA, 'baoyu-skills', 'chrome-profile');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'baoyu-skills', 'chrome-profile');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'baoyu-skills', 'chrome-profile');
}

export async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { return null; }
}

// Chrome's sandbox can't start as root or inside most containers; CHROME_NO_SANDBOX=1 forces it off.
export function noSandbox() {
  return process.getuid?.() === 0 || process.env.CHROME_NO_SANDBOX === '1' || fs.existsSync('/.dockerenv');
}

// Make sure a Chrome with the shared profile is listening on `port`; launch one if not.
export async function ensureChrome(port, tag = 'chrome', url = 'https://mp.weixin.qq.com/') {
  if (await targets(port)) return;
  const bin = chromePath();
  if (!bin) throw new Error('Chrome not found (set CHROME_PATH)');
  const profile = profileDir();
  fs.mkdirSync(profile, { recursive: true });
  const flags = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,900'];
  if (noSandbox()) flags.push('--no-sandbox');
  if (process.platform === 'linux') flags.push('--disable-dev-shm-usage', '--password-store=basic', '--no-proxy-server');
  console.log(`[${tag}] launching Chrome`, bin, profile);
  spawn(bin, [...flags, url], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await targets(port)) return; }
  throw new Error(`Chrome did not open debug port ${port}`);
}

// Gracefully close the browser (flushes cookies to disk).
export async function closeChrome(port) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(1500);
    return true;
  } catch { return false; }
}
