// Local HTTP proxy that forwards everything through an upstream SOCKS5 proxy,
// for clients that only understand HTTP(S)_PROXY (GPT API/news downloads, ...).
// usage: node socks-bridge.mjs --socks socks5h://host:port [--listen 127.0.0.1:18080]
import http from 'node:http';
import { SocksClient } from 'socks';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((a, v, i, arr) => (v.startsWith('--') && a.push([v.slice(2), arr[i + 1]]), a), []));
if (!args.socks) { console.error('usage: node socks-bridge.mjs --socks socks5h://host:port [--listen 127.0.0.1:18080]'); process.exit(1); }
const up = new URL(args.socks);
const proxy = {
  host: up.hostname, port: Number(up.port) || 1080, type: up.protocol.startsWith('socks4') ? 4 : 5,
  ...(up.username ? { userId: decodeURIComponent(up.username), password: decodeURIComponent(up.password) } : {}),
};
const listen = args.listen || '127.0.0.1:18080';
const i = listen.lastIndexOf(':');
const [lhost, lport] = [listen.slice(0, i), Number(listen.slice(i + 1))];

const dial = async (host, port) =>
  (await SocksClient.createConnection({ proxy, command: 'connect', destination: { host, port: Number(port) }, timeout: 20000 })).socket;

const server = http.createServer(async (req, res) => {
  try {
    const t = new URL(req.url);
    const port = t.port || 80;
    const sock = await dial(t.hostname, port);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const fwd = http.request({ createConnection: () => sock, host: t.hostname, port, method: req.method, path: t.pathname + t.search, headers }, (pr) => {
      res.writeHead(pr.statusCode, pr.headers);
      pr.pipe(res);
    });
    fwd.on('error', () => res.destroy());
    req.pipe(fwd);
  } catch (e) {
    if (!res.headersSent) res.writeHead(502);
    res.end(String(e.message));
  }
});

server.on('connect', async (req, client, head) => {
  const m = req.url.match(/^\[?([^\]]+)\]?:(\d+)$/);
  client.on('error', () => {});
  if (!m) return client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  try {
    const s = await dial(m[1], m[2]);
    s.on('error', () => client.destroy());
    client.on('error', () => s.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) s.write(head);
    s.pipe(client);
    client.pipe(s);
  } catch (e) {
    console.error(`[bridge] ${req.url}: ${e.message}`);
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  }
});

server.listen(lport, lhost, () => console.log(`[bridge] http://${lhost}:${lport} -> ${args.socks}`));
