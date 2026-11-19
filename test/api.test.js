import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'loom-api-'));
process.env.LOOM_DB = join(dir, 'loom.db');
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const { server } = await import('../server/node.js');
const { ingest } = await import('../server/ingest.js');

await new Promise((res) => (server.listening ? res() : server.once('listening', res)));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (p) => fetch(base + p);

async function waitForJob(id, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const { body } = await json(`/api/jobs/${id}`);
    if (body.status === 'done' || body.status === 'error') {
      assert.equal(body.status, 'done', body.error || 'job failed');
      return body;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish in time');
}
const json = async (p, init) => {
  const r = await fetch(base + p, init);
  const body = await r.json();
  return { status: r.status, body };
};

test('health and stats answer with JSON', async () => {
  const health = await json('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  const stats = await json('/api/stats');
  assert.equal(stats.status, 200);
  assert.equal(typeof stats.body.counts.docs, 'number');
});

test('the single-page shell is served for app routes and static modules exist', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<div id="app"|<main/);
  assert.match(html, /js\/app\.js/);
  for (const p of ['/js/app.js', '/js/api.js', '/css/app.css', '/favicon.svg']) {
    assert.equal((await get(p)).status, 200, `${p} should be served`);
  }
  assert.equal((await get('/#/library')).status, 200);
});

test('a note can be ingested over HTTP and then found by search', async () => {
  const res = await json('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'text',
      title: 'API note',
      url: 'https://api.example/note',
      useLLM: false,
      text: 'OWL is an ontology language for the Semantic Web. It builds on RDF and is standardized at the W3C.',
    }),
  });
  assert.equal(res.status, 202);
  const job = await waitForJob(res.body.jobId);
  const docId = job.result.docId;
  assert.ok(docId, JSON.stringify(job.result));

  const search = await json('/api/search?q=ontology language');
  assert.equal(search.status, 200);
  assert.ok(search.body.results.some((r) => r.docId === docId));

  const ask = await json('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is OWL?' }),
  });
  assert.equal(ask.status, 200);
  assert.ok(ask.body.answer.length > 0);
  assert.ok(ask.body.sources.every((s) => 'n' in s));
  assert.ok(ask.body.sources.some((s) => s.docId), 'citations need a document id to link to');
});

test('graph, memory and insights payloads match the views', async () => {
  const g = await json('/api/graph?limit=40');
  assert.equal(g.status, 200);
  assert.ok(Array.isArray(g.body.nodes) && Array.isArray(g.body.links));
  const m = await json('/api/memory?limit=20');
  assert.ok(Array.isArray(m.body.facts));
  for (const f of m.body.facts) {
    assert.equal(typeof f.subject_name, 'string');
    assert.ok(Array.isArray(f.sources));
    assert.equal(typeof f.label, 'string');
  }
  const ins = await json('/api/insights');
  assert.ok(ins.body.orphans && ins.body.thin && ins.body.bridges);
  assert.ok(Array.isArray(ins.body.contested));
});

test('deleting a document removes its passages and claims', async () => {
  const created = await ingest({ kind: 'text', title: 'Temporary', useLLM: false, text: 'Ephemeral notes about zeppelins and airships fill this paragraph with enough real words.' });
  assert.equal((await fetch(`${base}/api/docs/${created.docId}`, { method: 'DELETE' })).status, 200);
  const docs = await json('/api/docs');
  assert.ok(!docs.body.docs.some((d) => d.id === created.docId));
  const search = await json('/api/search?q=zeppelins');
  assert.ok(!search.body.results.some((r) => r.docId === created.docId));
});

test('bad requests and unknown routes fail cleanly', async () => {
  const bad = await json('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"kind":"text"',
  });
  assert.ok(bad.status >= 400 && bad.status < 500);
  assert.ok(bad.body.error);

  const empty = await json('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'text', title: 'Empty', text: 'too short' }),
  });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /dozen words|too short|at least/i);

  const missing = await json('/api/nope');
  assert.equal(missing.status, 404);
});
