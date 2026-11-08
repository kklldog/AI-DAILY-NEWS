import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  apiConfig, dayWindow, parseFeed, extractSource, collectNews,
  responseJson, validateSelection, validateReport, renderMarkdown, generate, cachedReport,
  sourceUrl, isChineseContent, parseInfoqList, parseArchive, NEWS_SITES, publicationTime,
  articleHash, markPreviewSent, checkApproval, ModelJsonError,
} from './generate-article.mjs';
import { renderArticlePreview } from './notify.mjs';

const date = '2026-11-07';
const config = apiConfig({
  GPT_ENDPOINT: 'https://gpt.example/v1/responses',
  GPT_API_KEY: 'test-key-not-a-real-secret', GPT_MODEL: 'provider-gpt-6.1', GPT_JSON_MODE: 'json_object',
});
const evidence = 'The company announced its new AI model today, November 7, 2026.';
const sources = Array.from({ length: 6 }, (_, i) => ({
  id: `S${i + 1}`, title: `AI Event ${i + 1}`, url: `https://www.ithome.com/event-${i + 1}`,
  published: '2026-11-07T10:00:00Z', text: `${evidence} ${'这是一段公开中文报道，介绍人工智能产品与行业动态。'.repeat(40)}`,
}));
const selected = sources.map(s => ({
  id: s.id, key: `event-${s.id}`, reportedDate: date, eventDate: date, eventTime: '11月7日发布', evidence,
  reason: 'The source explicitly states the announcement happened on November 7, 2026.',
  safety: 'safe', category: '模型',
}));
const selection = (items = selected, available = sources) => ({
  selected: items,
  rejected: available.filter(s => !items.some(item => item.id === s.id)).map(s => ({ id: s.id, reason: '优先级较低，未进入本期选题' })),
});
const fixture = (count = 6) => ({
  date, title: 'AI News Daily Report 11-07｜模型与算力更新', summary: `今日${count}条人工智能新闻摘要。`, safety: 'safe',
  keywords: ['模型', '算力', '研究'], intro: '今天的重要事件横跨模型和算力。',
  stories: selected.slice(0, count).map(s => ({
    id: s.id, key: s.key, eventTime: s.eventTime, title: `事件 ${s.id}`,
    what: ['这是一段根据公开原文改写的事实。'.repeat(7), '这是一段有来源支持的产品说明。'.repeat(7)],
    context: ['这是一段有来源支持的背景说明。'.repeat(7)], commentary: '这是一段明确标注为分析的点评。'.repeat(3),
  })),
  conclusion: '综合来看，这些动态反映了人工智能产业的变化。',
  icons: ['🤖', '🧠', '💰', '⚡', '🎬', '🔬'],
});
const envelope = result => ({
  status: 'completed',
  output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
  usage: { input_tokens: 100, output_tokens: 200 },
});
const clone = value => structuredClone(value);
const temporary = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-daily-api-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('Beijing date window includes UTC previous-day 16:00 but excludes next-day boundary', () => {
  const { start, end } = dayWindow(date);
  assert.equal(new Date(start).toISOString(), '2026-11-06T16:00:00.000Z');
  assert.equal(end - start, 86400e3);
  assert.throws(() => dayWindow('2026-02-30'), /invalid calendar/);
  assert.equal(publicationTime('2026-11-07'), start);
  assert.equal(publicationTime('2026-11-07 23:15:00'), Date.parse('2026-11-07T23:15:00+08:00'));
  const item = (title, published) => `<item><title>${title}</title><link>https://www.ithome.com/${title}?utm_source=rss</link><pubDate>${published}</pubDate></item>`;
  const xml = `<rss><channel>${item('old', 'Fri, 06 Nov 2026 15:59:59 GMT')}${item('today', 'Fri, 06 Nov 2026 16:00:00 GMT')}${item('next', 'Sat, 07 Nov 2026 16:00:00 GMT')}</channel></rss>`;
  assert.deepEqual(parseFeed(xml, date).map(x => x.url), ['https://www.ithome.com/today']);
});

test('Atom alternate links, namespaces, XML errors and original-page extraction', () => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>AI &amp; chips</title><published>2026-11-07T04:00:00Z</published><link rel="self" href="https://api.example/a"/><link rel="alternate" href="https://www.qbitai.com/a"/></entry></feed>';
  assert.equal(parseFeed(atom, date)[0].title, 'AI & chips');
  assert.equal(parseFeed(atom, date)[0].url, 'https://www.qbitai.com/a');
  assert.deepEqual(parseFeed('<rss><channel><title>No news</title></channel></rss>', date), []);
  assert.throws(() => parseFeed('<html>Bad gateway', date), /invalid RSS/);
  const html = `<html><head><meta property="og:title" content="Model launch"/><meta property="article:published_time" content="2026-11-07"/></head><body><nav>IGNORE NAV</nav><article><h1>Model launch</h1><p>${evidence.repeat(20)}</p><script>IGNORE SCRIPT</script></article></body></html>`;
  const source = extractSource(html, 'https://news.example/a');
  assert.equal(source.pagePublished, '2026-11-07');
  assert(source.text.includes(evidence));
  assert(!source.text.includes('IGNORE'));
  assert.throws(() => extractSource('<title>Paywall</title><p>Subscribe</p>', 'https://news.example/a'), /too little/);
});

test('collects and deduplicates readable original URLs without sending them to any API', async () => {
  const feeds = ['https://www.ithome.com/rss', 'https://www.qbitai.com/broken'];
  const items = sources.map(s => `<item><title>${s.title}</title><link>${s.url}</link><pubDate>2026-11-07T10:00:00Z</pubDate></item>`).join('');
  const xml = `<rss><channel>${items}${items}</channel></rss>`;
  const getText = async url => {
    if (url.endsWith('/broken')) throw new Error('HTTP 503');
    if (url.endsWith('/rss')) return { text: xml, url };
    return { text: `<title>AI announcement</title><article><p>${(`${evidence} 这是一段中文人工智能新闻。`).repeat(20)}</p></article>`, url };
  };
  const result = await collectNews(date, { feeds, getText });
  assert.equal(result.length, 6);
  assert.equal(new Set(result.map(s => s.url)).size, 6);
  const recovered = await collectNews(date, { feeds: [...feeds].reverse(), getText });
  assert.equal(recovered.length, 6, 'a failed first feed must not prevent using the next media site');
  await assert.rejects(() => collectNews(date, {
    feeds: [feeds[0]], getText: async url => url.endsWith('/rss') ? { text: xml, url } : Promise.reject(new Error('paywall')),
  }), /only 0 readable/);
});

test('public Chinese websites are not limited to a four-media domain allowlist', () => {
  assert.equal(sourceUrl('https://www.ithome.com/a?utm_source=rss#top'), 'https://www.ithome.com/a');
  for (const url of ['https://www.infoq.cn/article/a', 'https://aiguide.cc/1/', 'https://www.chinanews.com.cn/a', 'https://new-chinese-blog.example/a']) {
    assert.equal(sourceUrl(url), url);
  }
  for (const url of [
    'http://127.0.0.1/a', 'http://192.168.1.1/a', 'http://localhost/a',
    'file:///a', 'https://qbitai.com@attacker.example/a', 'https://www.ithome.com:9000/a',
  ]) assert.throws(() => sourceUrl(url));
  assert(isChineseContent('这是一段有关人工智能科普与政策争议的中文报道。'.repeat(8)));
  assert(!isChineseContent('An English AI news article with no Chinese body.'.repeat(8)));
});

test('empty feeds return zero, but policy keywords do not discard Chinese AI news', async () => {
  const feed = 'https://www.ithome.com/rss/';
  assert.deepEqual(await collectNews(date, {
    feeds: [feed], getText: async url => ({ text: '<rss><channel><title>Empty</title></channel></rss>', url }),
  }), []);
  const policy = `<rss><channel><item><title>AI政策争议报道</title><link>https://www.ithome.com/a</link><pubDate>2026-11-07T10:00:00Z</pubDate></item></channel></rss>`;
  const result = await collectNews(date, { feeds: [feed], getText: async url => ({
    text: url === feed ? policy : `<title>AI政策争议报道</title><article><p>${'人工智能行业的政策与隐私保护是这份公开中文报道讨论的主题。'.repeat(15)}</p></article>`, url,
  }) });
  assert.equal(result.length, 1);
  await assert.rejects(() => collectNews(date, {
    feeds: [feed], getText: async () => { throw new Error('HTTP 503'); },
  }), /all news discovery sources failed/);
});

test('InfoQ list and AI guide HTML adapters discover dated, readable Chinese articles', async () => {
  assert(NEWS_SITES.some(s => s.url === 'https://www.infoq.cn/topic/AI&LLM'));
  const infoq = { code: 0, data: [
    { uuid: 'newModel', article_title: '自动路由成本研究', publish_time: Date.parse('2026-11-07T04:00:00Z'), score: 2 },
    { uuid: 'older', article_title: '旧文章', publish_time: Date.parse('2026-11-06T04:00:00Z'), score: 1 },
  ] };
  assert.equal(parseInfoqList(infoq, date).length, 1);
  assert.throws(() => parseInfoqList({ code: 1, data: [] }, date), /invalid InfoQ/);
  const archive = '<main class="content"><div class="list-item"><h2><a href="/123/">今日AI资讯</a></h2></div></main>';
  assert.equal(parseArchive(archive, 'https://aiguide.cc/')[0].url, 'https://aiguide.cc/123/');
  assert.throws(() => parseArchive('<html>blocked</html>', 'https://aiguide.cc/'), /layout/);
  const guideBody = extractSource(`<title>今日AI资讯</title><main><div class="panel-body single"><h2>智能体研究</h2><div class="paragraph">${'真实新闻描述写在div里，不应只提取标题而漏掉正文。'.repeat(20)}</div></div></main>`, 'https://aiguide.cc/123/');
  assert(guideBody.text.includes('真实新闻描述'));
  assert(guideBody.text.length > 400);
  const sites = [
    NEWS_SITES.find(s => s.kind === 'infoq'),
    { kind: 'archive', url: 'https://aiguide.cc/daily/' },
  ];
  const result = await collectNews(date, { sites, getText: async (url, options) => {
    if (url.includes('getList')) {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).id, 31);
      return { text: JSON.stringify(infoq), url };
    }
    if (url.endsWith('/daily/')) return { text: archive, url };
    return { text: `<title>AI中文报道</title><meta property="article:published_time" content="2026-11-07T04:00:00Z"><article><p>${'这是一篇当天发布的人工智能资讯与研究解读，中文正文可以完整阅读。'.repeat(12)}</p></article>`, url };
  } });
  assert.equal(result.length, 2);
  assert(result.some(s => s.url.startsWith('https://www.infoq.cn/article/')));
  assert(result.some(s => s.url.startsWith('https://aiguide.cc/')));
});

test('Responses request uses configured model/key and handles reasoning plus output_text', async () => {
  let calls = 0;
  const result = await responseJson(config, 'Return JSON.', { publicNews: true }, {
    network: async (url, options) => {
      calls++;
      assert.equal(url, config.endpoint);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${config.key}`);
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'provider-gpt-6.1');
      assert.equal(payload.store, false);
      assert.equal(payload.stream, false);
      assert.equal(payload.text.format.type, 'json_object');
      assert.equal(payload.max_output_tokens, 24000);
      assert(!payload.input.includes(config.key));
      assert(!('tools' in payload));
      return new Response(JSON.stringify(envelope({ ok: true })), { status: 200 });
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test('actual HTTP transport posts to /v1/responses with Bearer auth and parses JSON', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(envelope({ selected })));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const local = { ...config, endpoint: `http://127.0.0.1:${server.address().port}/v1/responses` };
  const result = await responseJson(local, 'Return JSON.', { sources });
  assert.equal(result.selected.length, 6);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/responses');
  assert.equal(requests[0].auth, `Bearer ${config.key}`);
  assert.equal(requests[0].body.model, config.model);
});

test('prompt JSON mode omits unsupported gateway format parameters but still validates JSON', async () => {
  const prompt = apiConfig({
    GPT_ENDPOINT: config.endpoint, GPT_API_KEY: config.key, GPT_MODEL: config.model,
  });
  assert.equal(prompt.jsonMode, 'prompt');
  const result = await responseJson(prompt, 'Return only JSON.', {}, {
    network: async (_, options) => {
      assert(!('text' in JSON.parse(options.body)));
      return new Response(JSON.stringify(envelope({ ok: true })));
    },
  });
  assert.equal(result.ok, true);
  assert.throws(() => apiConfig({
    GPT_ENDPOINT: config.endpoint, GPT_API_KEY: config.key, GPT_MODEL: config.model, GPT_JSON_MODE: 'bad',
  }), /GPT_JSON_MODE/);
});

test('prompt JSON accepts one complete fenced object but never extracts arbitrary fragments', async () => {
  const fenced = envelope({});
  fenced.output[1].content[0].text = '```json\n{"ok":true}\n```';
  assert.equal((await responseJson(config, 'JSON', {}, {
    network: async () => new Response(JSON.stringify(fenced)),
  })).ok, true);
  let captured;
  fenced.output[1].content[0].text = `invalid output ${config.key}`;
  await assert.rejects(() => responseJson(config, 'JSON', {}, {
    network: async () => new Response(JSON.stringify(fenced)), onInvalidJson: text => { captured = text; },
  }), ModelJsonError);
  assert(!captured.includes(config.key));
});

test('429/5xx retries are bounded; 401/400 do not retry or disclose gateway error bodies', async () => {
  const waits = [];
  let calls = 0;
  await responseJson(config, 'JSON', {}, {
    pause: async ms => waits.push(ms),
    network: async () => ++calls < 3 ? new Response('', { status: calls === 1 ? 429 : 503, headers: { 'retry-after': '1' } }) :
      new Response(JSON.stringify(envelope({ ok: true }))),
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 1000]);
  for (const status of [400, 401, 403]) {
    calls = 0;
    await assert.rejects(() => responseJson(config, 'JSON', {}, {
      network: async () => { calls++; return new Response(config.key, { status }); },
    }), error => error.message.includes(`HTTP ${status}`) && !error.message.includes(config.key));
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(() => responseJson(config, 'JSON', {}, {
    pause: async () => {},
    network: async () => { calls++; return new Response('', { status: 503 }); },
  }), /after 3 attempts/);
  assert.equal(calls, 3);
});

test('incomplete/refusal/empty output/non-JSON responses never become success', async () => {
  for (const body of [
    { ...envelope({}), status: 'incomplete' },
    { status: 'completed', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not JSON' }] }] },
  ]) {
    await assert.rejects(() => responseJson(config, 'JSON', {}, {
      network: async () => new Response(JSON.stringify(body)),
    }));
  }
  assert.throws(() => apiConfig({}), /configure/);
  assert.throws(() => apiConfig({ GPT_ENDPOINT: 'https://gpt.example/v1', GPT_API_KEY: 'x', GPT_MODEL: 'x' }), /full Responses/);
});

test('selection uses reporting date, accepts earlier events and broad categories with complete reasons', () => {
  for (let count = 0; count <= 6; count++) assert.equal(validateSelection(selection(selected.slice(0, count)), sources, date).length, count);
  const broader = clone(selected);
  broader[0].eventDate = '2026-11-05';
  broader[0].eventTime = '11月5日发布，今天报道';
  broader[0].category = 'AI科普与政策';
  assert.equal(validateSelection(selection(broader), sources, date).length, 6);
  for (const change of [
    x => x.push({ ...x[0], id: 'S7' }),
    x => { x[1].id = x[0].id; },
    x => { x[0].reportedDate = '2026-11-06'; },
    x => { x[0].evidence = 'Invented facts that do not occur in the supplied source text.'; },
    x => { x[0].key = x[1].key; },
    x => { x[0].category = ''; },
    x => { x[0].eventTime = ''; },
  ]) {
    const invalid = clone(selected);
    change(invalid);
    assert.throws(() => validateSelection(selection(invalid), sources, date));
  }
  assert.throws(() => validateSelection({ selected: selected.slice(0, 1), rejected: [] }, sources, date), /every source/);
  const digestSource = { ...sources[0], text: sources[0].text + '另一条中文资讯讲述不同的人工智能科普活动，原文说明了具体内容。' };
  const digestItems = [
    selected[0],
    { ...selected[0], key: 'another-event', evidence: '另一条中文资讯讲述不同的人工智能科普活动，原文说明了具体内容。' },
  ];
  assert.equal(validateSelection(selection(digestItems, [digestSource]), [digestSource], date).length, 2);
});

test('exact report shape, Unicode title limits, 300-500 characters and emoji validation', () => {
  const report = fixture();
  assert.equal(validateReport(report, selected, date), report);
  for (const count of [1, 2, 5]) assert.equal(validateReport(fixture(count), selected.slice(0, count), date).stories.length, count);
  for (const change of [
    r => { r.date = '2026-11-06'; },
    r => { r.title += '过长'.repeat(30); },
    r => { r.stories.pop(); },
    r => { r.stories[0].id = 'S2'; },
    r => { r.stories[0].what = ['太短', '太短']; r.stories[0].context = ['背景']; r.stories[0].commentary = '点评'; },
    r => { r.stories[0].what[0] = '事实'.repeat(300); },
    r => { r.stories[0].context[0] = 'https://unverified.example/fake'; },
    r => { r.icons[0] = '🤖🤖'; },
    r => { r.summary = '今日十条人工智能新闻。'; },
    r => { r.stories[0].eventTime = '错误地标成今天刚发生'; },
    r => { r.stories[0].key = 'wrong-event'; },
  ]) {
    const invalid = fixture();
    change(invalid);
    assert.throws(() => validateReport(invalid, selected, date));
  }
  const markdown = renderMarkdown(report, sources);
  assert.equal((markdown.match(/^## \d+\./gm) ?? []).length, 6);
  const [body, references] = markdown.split('## 🔗 参考链接');
  assert(!body.includes('https://'));
  assert.equal((references.match(/^https:\/\//gm) ?? []).length, 6);
  assert(body.includes('[6]'));
});

test('HTML preview includes complete article and references, strips metadata and external images', () => {
  const html = renderArticlePreview(renderMarkdown(fixture(2), sources));
  assert(html.includes('<h1>'));
  assert(html.includes('发生了什么'));
  assert(html.includes('写在最后'));
  assert(html.includes('参考链接'));
  assert(!html.includes('author: AI News Daily Report'));
  const untrusted = renderArticlePreview('<script>alert(1)</script>\n\n![foreign](https://attacker.example/tracker.png)');
  assert(!untrusted.includes('<script>'));
  assert(!untrusted.includes('<img'));
});

test('pipeline corrects format once, persists evidence and reuses only matching validated outputs', async t => {
  const out = temporary(t);
  let calls = 0;
  const request = async () => {
    calls++;
    if (calls === 1) return selection();
    const report = fixture();
    if (calls === 2) report.title = 'invalid title';
    return report;
  };
  const report = await generate({ date, out, config, collect: async () => sources, request });
  assert.equal(calls, 3);
  assert.equal(report.title, fixture().title);
  for (const name of ['news-sources.json', 'selection-response.json', 'verified-news.json', 'write-response.json', 'report.json', 'article.md', 'cover.json']) {
    assert(fs.existsSync(path.join(out, name)));
    assert(!fs.readFileSync(path.join(out, name), 'utf8').includes(config.key));
  }
  await generate({ date, out, config, collect: () => assert.fail('cache must not refetch'), request: () => assert.fail('cache must not call API') });
  const hash = articleHash(out, date);
  assert.throws(() => checkApproval(out, date, hash), /ENOENT/);
  fs.writeFileSync(path.join(out, 'cover.png'), 'test-cover');
  markPreviewSent(out, date, hash);
  checkApproval(out, date, hash);
  assert.throws(() => checkApproval(out, date, '0'.repeat(64)), /approval does not match/);
  assert.throws(() => checkApproval(out, date, ''), /explicit approval/);
  fs.writeFileSync(path.join(out, 'cover.png'), 'changed-cover');
  assert.throws(() => checkApproval(out, date, hash), /approval does not match/);
  fs.appendFileSync(path.join(out, 'article.md'), 'unvalidated edit');
  assert.throws(() => cachedReport(out, date), /differs/);
});

test('invalid selection/writing/API failure leave no publishable article marker', async t => {
  for (const failure of ['selection', 'writing', 'api']) {
    const out = temporary(t);
    let calls = 0;
    await assert.rejects(() => generate({
      date, out, config, collect: async () => sources,
      request: async () => {
        calls++;
        if (failure === 'api') throw new Error('API timeout');
        if (calls === 1) return selection(failure === 'selection' ? [...selected, { ...selected[0] }] : selected);
        return { date };
      },
    }));
    assert(!fs.existsSync(path.join(out, 'report.json')));
    assert(!fs.existsSync(path.join(out, 'article.md')));
    if (failure === 'selection') assert(fs.existsSync(path.join(out, 'selection-response.json')));
    if (failure === 'writing') assert.equal(calls, 3);
  }
  const out = temporary(t);
  fs.writeFileSync(path.join(out, 'appmsgid'), '12345');
  await assert.rejects(() => generate({ date, out, config }), /existing draft/);
});

test('previous mainland-policy email stays byte-identical and reviewable after upgrade', async t => {
  const out = temporary(t);
  const oldSelected = selected.map(({ key, reportedDate, eventTime, ...item }) => item);
  const oldReport = fixture();
  oldReport.policyVersion = 'mainland-six-preview-v1';
  oldReport.stories.forEach(s => { delete s.key; delete s.eventTime; });
  const markdown = renderMarkdown(oldReport, sources);
  const json = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value));
  json('news-sources.json', sources);
  json('verified-news.json', { selected: oldSelected });
  json('report.json', oldReport);
  json('cover.json', { icons: oldReport.icons });
  fs.writeFileSync(path.join(out, 'article.md'), markdown);
  fs.writeFileSync(path.join(out, 'cover.png'), 'previous-cover');
  const hash = articleHash(out, date);
  markPreviewSent(out, date, hash);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'preview.sent.json'))).policyVersion, 'mainland-six-preview-v1');
  checkApproval(out, date, hash);
  await generate({ date, out, config, cachedOnly: true, request: () => assert.fail('no API rewriting old reviewed content') });
  assert.equal(fs.readFileSync(path.join(out, 'article.md'), 'utf8'), markdown);
});

test('the program derives reporting date from metadata even when the model confuses it with event date', async t => {
  const out = temporary(t);
  let calls = 0;
  await generate({ date, out, config, collect: async () => sources, request: async (_, __, input) => {
    if (++calls === 1) {
      assert(input.sources.every(s => s.reportedDate === date && s.publishedBeijing.endsWith('+08:00')));
      const raw = selection();
      raw.selected = clone(raw.selected);
      raw.selected[0].reportedDate = null;
      return raw;
    }
    return fixture();
  } });
  const raw = JSON.parse(fs.readFileSync(path.join(out, 'selection-response.json')));
  const verified = JSON.parse(fs.readFileSync(path.join(out, 'verified-news.json')));
  assert.equal(raw.selected[0].reportedDate, null);
  assert.equal(verified.selected[0].reportedDate, date);
});

test('malformed writing JSON gets one explicit correction, never an unvalidated report', async t => {
  const out = temporary(t);
  let calls = 0;
  await generate({ date, out, config, collect: async () => sources, request: async (_, __, input) => {
    if (++calls === 1) return selection();
    if (calls === 2) throw new ModelJsonError('writing JSON malformed');
    assert(input.correction.includes('JSON malformed'));
    return fixture();
  } });
  assert.equal(calls, 3);
  assert(fs.existsSync(path.join(out, 'report.json')));
});

test('zero verified events sends no fabricated article and requires no writing request', async t => {
  for (const available of [[], sources]) {
    const out = temporary(t);
    let calls = 0;
    const report = await generate({
      date, out, config, collect: async () => available,
      request: async () => { calls++; return { ...selection([], available), note: '没有可选报道' }; },
    });
    assert.equal(report, null);
    assert.equal(calls, available.length ? 1 : 0);
    assert(fs.existsSync(path.join(out, 'no-news.json')));
    assert(!fs.existsSync(path.join(out, 'article.md')));
    assert.throws(() => articleHash(out, date), /no validated report/);
  }
});

const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
test('explicit WeChat author is passed as one CLI argument without changing the reviewed file',
  { skip: !fs.existsSync(bash) }, () => {
    const script = fs.readFileSync(new URL('../server/run-daily.sh', import.meta.url), 'utf8');
    const start = script.indexOf('  DRAFT_FLAGS=(');
    const end = script.indexOf('  ( cd "$BAOYU"', start);
    assert(start >= 0 && end > start);
    for (const author of ['', 'EDITOR']) {
      const result = spawnSync(bash, ['-c', `OUT="/reviewed content"; ${script.slice(start, end)}\nprintf '%s\\n' "\${DRAFT_FLAGS[@]}"`],
        { env: { ...process.env, WECHAT_AUTHOR: author }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const args = result.stdout.trim().split(/\r?\n/);
      assert.equal(args[1], '/reviewed content/article.md');
      assert.equal(args.includes('--author'), Boolean(author));
      if (author) assert.deepEqual(args.slice(-2), ['--author', author]);
    }
  });
test('server DRY_RUN overrides config, skips WeChat/CLI and stops before publishing on writer failure',
  { skip: !fs.existsSync(bash) }, t => {
    const root = temporary(t);
    const skill = path.join(root, 'skill');
    const scripts = path.join(skill, 'scripts');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(bin);
    // Git Bash lacks flock; mock only the existing locking primitive on Windows.
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const conf = path.join(root, 'config.env');
    fs.writeFileSync(conf, 'DRY_RUN=0\nPROXY=\nPUBLISH_MODE=preview\n');
    fs.writeFileSync(path.join(scripts, 'generate-article.mjs'), `
      import fs from 'node:fs'; import path from 'node:path';
      const a=process.argv.slice(2);
      if(a.includes('--check-config')) { console.log('config checked'); }
      else if(a.includes('--check-approval')) { console.error('approval required'); process.exitCode=1; }
      else if(a.includes('--article-hash')) { console.log('a'.repeat(64)); }
      else if(a.includes('--mark-preview-sent')) { console.log('preview recorded'); }
      else if(process.env.TEST_WRITER_FAIL==='1') { console.error('mock API failure'); process.exitCode=1; }
      else if(process.env.TEST_NO_NEWS==='1') { console.log('NO_NEWS '+a[a.indexOf('--date')+1]); }
      else {
        const out=a[a.indexOf('--out')+1];
        fs.writeFileSync(path.join(out,'article.md'),'mock article');
        fs.writeFileSync(path.join(out,'cover.json'),JSON.stringify({icons:['🤖','🧠','💰','⚡','🎬','🔬']}));
        fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({stories:[{id:'S1'}]}));
        console.log('TITLE mock report');
      }
    `);
    fs.writeFileSync(path.join(scripts, 'make-cover.mjs'), `
      import fs from 'node:fs';
      fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1],'mock cover');
    `);
    fs.writeFileSync(path.join(scripts, 'notify.mjs'), "if(process.env.TEST_MAIL_FAIL==='1'){console.error('preview mail failed');process.exitCode=3;}else{console.log('mock notification');}\n");
    fs.writeFileSync(path.join(scripts, 'send-preview.mjs'), "if(process.env.TEST_MAIL_FAIL==='1'){console.error('preview mail failed');process.exitCode=3;}else{console.log('mock notification; preview recorded');}\n");
    for (const name of ['wechat-login.mjs', 'wechat-publish.mjs', 'chrome.mjs']) {
      fs.writeFileSync(path.join(scripts, name), "console.error('UNEXPECTED_WECHAT_CALL'); process.exitCode=99;\n");
    }
    const script = fileURLToPath(new URL('../server/run-daily.sh', import.meta.url));
    const env = {
      ...process.env, DRY_RUN: '1', AI_DAILY_CONFIG: conf, AI_DAILY_SKILL: skill,
      AI_DAILY_HOME: path.join(root, 'output'), XDG_RUNTIME_DIR: root, RUN_AFTER_HOUR: '',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    };
    const result = spawnSync(bash, [script], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert(result.stdout.includes('dry=1'));
    assert(result.stdout.includes('PREVIEW: email only; stop before draft/publish'));
    assert(!`${result.stdout}${result.stderr}`.includes('UNEXPECTED_WECHAT_CALL'));
    const failed = spawnSync(bash, [script], {
      env: { ...env, TEST_WRITER_FAIL: '1' }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert(failed.stdout.includes('mock API failure'));
    assert(!`${failed.stdout}${failed.stderr}`.includes('UNEXPECTED_WECHAT_CALL'));
    const preview = spawnSync(bash, [script], { env: { ...env, DRY_RUN: '0' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert(preview.stdout.includes('PREVIEW: email only'));
    assert(!`${preview.stdout}${preview.stderr}`.includes('UNEXPECTED_WECHAT_CALL'));
    const publish = spawnSync(bash, [script], {
      env: { ...env, DRY_RUN: '0', PUBLISH_MODE: 'publish' }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(publish.status, 1, publish.stdout + publish.stderr);
    assert(publish.stdout.includes('approval required'));
    assert(!`${publish.stdout}${publish.stderr}`.includes('UNEXPECTED_WECHAT_CALL'));
    const empty = spawnSync(bash, [script], {
      env: { ...env, DRY_RUN: '0', TEST_NO_NEWS: '1' }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(empty.status, 0, empty.stdout + empty.stderr);
    assert(empty.stdout.includes('NO_NEWS'));
    assert(!`${empty.stdout}${empty.stderr}`.includes('UNEXPECTED_WECHAT_CALL'));
    const mailFailed = spawnSync(bash, [script], {
      env: { ...env, DRY_RUN: '0', TEST_MAIL_FAIL: '1' }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(mailFailed.status, 1, mailFailed.stdout + mailFailed.stderr);
    assert(!mailFailed.stdout.includes('preview recorded'));
    assert(!`${mailFailed.stdout}${mailFailed.stderr}`.includes('UNEXPECTED_WECHAT_CALL'));
  });
