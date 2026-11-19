import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'loom-test-'));
process.env.LOOM_DB = join(dir, 'loom.db');

const { chunkText, htmlToText, tokenize, splitSentences } = await import('../server/text.js');
const { embed, cosine, rrf } = await import('../server/embed.js');
const { extract } = await import('../server/extract.js');
const { confidenceFor, statusFor, labelFor } = await import('../server/verify.js');
const { ingest, recomputeFacts } = await import('../server/ingest.js');
const { search, graph, memory, ask, stats, entityDetail } = await import('../server/query.js');
const { getDb } = await import('../server/db.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

/* ------------------------------------------------------------- text utils */

test('htmlToText drops markup, scripts and entities', () => {
  const text = htmlToText('<html><head><style>x{}</style><script>evil()</script></head><body><h1>Hello&nbsp;World</h1><p>A &amp; B</p></body></html>');
  assert.match(text, /Hello World/);
  assert.match(text, /A & B/);
  assert.doesNotMatch(text, /evil|<h1>/);
});

test('chunkText keeps passages bounded and numbered', () => {
  const body = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about knowledge graphs and RDF.`).join(' ');
  const chunks = chunkText(body, { target: 600, max: 900, overlap: 80 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= 1000, `chunk too long: ${c.text.length}`);
    assert.equal(typeof c.text, 'string');
    assert.ok('heading' in c);
  }
});

test('tokenize drops stopwords and splitSentences splits on terminal punctuation', () => {
  assert.deepEqual(tokenize('The graph is a graph of the things'), ['graph', 'graph', 'things']);
  assert.ok(splitSentences('One longer thing. Two longer things! Three longer things here.').length >= 3);
});

/* ------------------------------------------------------------- embeddings */

test('embeddings are deterministic and rank similar text higher', () => {
  const a = embed('knowledge graph entity relations');
  const b = embed('knowledge graph entity relations');
  const c = embed('banana bread recipe with walnuts');
  assert.deepEqual([...a], [...b]);
  assert.ok(cosine(a, b) > 0.99);
  assert.ok(cosine(a, c) < cosine(a, b));
});

test('rrf fuses lists without letting one ranking dominate', () => {
  const fused = rrf([['a', 'b', 'c'], ['b', 'd']]);
  assert.equal(fused[0][0], 'b');
  assert.ok(fused.find((r) => r[0] === 'a')[1] > 0);
});

/* ------------------------------------------------------------- extraction */

test('extraction types named entities and links agents to what they made', () => {
  const r = extract('Tim Berners-Lee created the World Wide Web at CERN. The World Wide Web runs on HTTP.', { title: 'Web' });
  const names = r.entities.map((e) => e.name);
  assert.ok(names.includes('World Wide Web'), names.join(', '));
  const created = r.edges.find((e) => e.rel === 'created');
  assert.ok(created, 'expected a created edge');
  assert.match(created.srcKey, /berners/);
});

test('passive sentences only assert one direction', () => {
  const r = extract('The Semantic Web was invented by Tim Berners-Lee.', { title: 'Semantic Web' });
  const toPerson = r.edges.filter((e) => e.rel === 'created' && /berners/.test(e.dstKey));
  assert.equal(toPerson.length, 0, 'must not claim the Semantic Web created Berners-Lee');
  assert.ok(r.edges.some((e) => e.rel === 'created' && /berners/.test(e.srcKey)));
});

test('definition objects stay short noun phrases', () => {
  const r = extract('RDF is a data model, which is used by many tools and has been standardized since 2004.', { title: 'RDF' });
  for (const f of r.facts) {
    assert.ok(f.object.length <= 80, f.object);
    assert.doesNotMatch(f.object, /,|;|\bwhich\b/i);
  }
});

/* ------------------------------------------------------------ verification */

test('confidence rises with corroboration and falls on conflict', () => {
  const one = confidenceFor({ supports: 1, domains: ['a.example'], trust: 0.8 });
  const two = confidenceFor({ supports: 2, domains: ['a.example', 'b.example'], trust: 0.8 });
  const conflict = confidenceFor({ supports: 2, domains: ['a.example', 'b.example'], trust: 0.8, hasConflict: true });
  assert.ok(two > one);
  assert.ok(conflict < two);
  assert.equal(statusFor({ supports: 2, domains: ['a.example', 'b.example'], confidence: 0.9 }), 'verified');
  assert.equal(statusFor({ supports: 1, domains: ['a.example'], confidence: 0.5 }), 'single-source');
  assert.equal(labelFor('born_in'), 'born in');
});

/* ---------------------------------------------------------------- pipeline */

const article = `Tim Berners-Lee created the World Wide Web at CERN.
The World Wide Web Consortium maintains the standards behind the Web.
RDF is a data model for the Semantic Web.
SPARQL queries RDF graphs and is standardized by the World Wide Web Consortium.
Knowledge graphs store entities and the relations between them.`;

const note = `Working notes on the Semantic Web.
Tim Berners-Lee created the World Wide Web while at CERN.
Knowledge graphs store entities and the relations between them.`;

test('ingest stores a document, chunks, entities and claims', async () => {
  const doc = await ingest({ kind: 'text', title: 'Web history', text: article, url: 'https://example.org/web', useLLM: false });
  assert.equal(doc.duplicate, false);
  assert.ok(doc.chunks > 0 && doc.entities > 0);

  const db = getDb();
  const row = db.prepare('SELECT * FROM docs WHERE id = ?').get(doc.docId);
  assert.equal(row.title, 'Web history');
  assert.ok(row.word_count > 20);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM chunks WHERE doc_id = ?').get(doc.docId).n >= 1);
});

test('ingesting identical content twice is deduplicated', async () => {
  const again = await ingest({ kind: 'text', title: 'Web history', text: article, url: 'https://example.org/web', useLLM: false });
  assert.equal(again.duplicate, true);
});

test('search fuses keyword and vector ranking and cites a source', async () => {
  const res = await search('semantic web data model', { limit: 5 });
  assert.ok(res.results.length > 0);
  assert.ok(res.results[0].docId);
  assert.ok(res.results[0].text.length > 0);
  assert.ok(res.tookMs >= 0);
});

test('a second independent source verifies the shared claim', async () => {
  const claim = 'SPARQL is a query language for RDF graphs.';
  await ingest({ kind: 'text', title: 'Alpha read', url: 'https://alpha.example/a', useLLM: false, text: `${claim} Federated endpoints answer these queries.` });
  const before = memory({ limit: 200 }).find((f) => f.predicate === 'is_a' && /query language/.test(f.object));
  assert.ok(before, 'expected the SPARQL claim');
  assert.equal(before.status, 'single-source');

  await ingest({ kind: 'text', title: 'Beta read', url: 'https://beta.example/b', useLLM: false, text: `${claim} Knowledge graphs store entities and relations in a graph.` });
  recomputeFacts();
  const after = memory({ limit: 200 }).find((f) => f.id === before.id);
  assert.equal(after.status, 'verified');
  assert.equal(after.supports, 2);
  assert.equal(after.domains.length, 2);
});

test('concept subjects cannot be born or create people', async () => {
  await ingest({
    kind: 'text',
    title: 'Noise',
    useLLM: false,
    text: 'The Semantic Web was born in Dresden. Queen Elizabeth II created Berners-Lee in London.',
  });
  recomputeFacts();
  const claims = memory({ limit: 300 });
  assert.equal(claims.filter((f) => f.predicate === 'born_in' && /Semantic Web|Web/.test(f.subject_name)).length, 0);
  assert.equal(claims.filter((f) => f.predicate === 'created' && /Berners-Lee/.test(f.object)).length, 0);
});

test('graph exposes nodes, links and insights that reference real ids', async () => {
  const g = graph({ limit: 80 });
  assert.ok(g.nodes.length > 0);
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const l of g.links.slice(0, 40)) {
    assert.ok(ids.has(l.source), 'link source missing from nodes');
    assert.ok(ids.has(l.target), 'link target missing from nodes');
  }
  const detail = entityDetail(g.nodes[0].id);
  assert.ok(detail.name);
  assert.ok(Array.isArray(detail.neighbors));
});

test('ask answers extractively and cites passages without a model', async () => {
  const res = await ask('Who created the World Wide Web?');
  assert.equal(res.mode, 'extractive');
  assert.match(res.answer, /\[1\]/);
  assert.ok(res.sources.length > 0);
  assert.ok(res.sources[0].docId);
});

test('stats count what was ingested', () => {
  const s = stats();
  assert.ok(s.counts.docs >= 3, `expected 3+ docs, got ${s.counts.docs}`);
  assert.ok(s.counts.chunks >= s.counts.docs);
  assert.ok(Array.isArray(s.top));
});

test('malformed input is refused, not crashed on', async () => {
  await assert.rejects(() => ingest({ kind: 'text', title: 'Empty', text: '   ' }));
  await assert.rejects(() => ingest({ kind: 'url', url: 'not a url' }));
  await assert.rejects(() => ingest({ kind: 'nonsense' }));
});
