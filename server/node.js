import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { getDb, initDb } from './db.js';
import { words } from './text.js';
import { ingest, recomputeFacts } from './ingest.js';
import { ask, entityDetail, graph, insights, memory, search, stats } from './query.js';
import { wikiSearch } from './sources.js';
import { llmStatus } from './llm.js';
import { labelFor } from './verify.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

initDb();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/* ------------------------------------------------------------------ jobs */

const jobs = new Map();
const listeners = new Map();
let queue = Promise.resolve();

function newJob(kind, label, input) {
  const job = {
    id: randomUUID().slice(0, 8), kind, label, input, status: 'queued',
    createdAt: new Date().toISOString(), finishedAt: null, steps: [], result: null, error: null,
  };
  jobs.set(job.id, job);
  emit(job, 'Queued', 'info');
  queue = queue.then(() => runJob(job)).catch(() => {});
  return job;
}

async function runJob(job) {
  job.status = 'running';
  emit(job, 'Started', 'info');
  try {
    const result = await ingest(job.input, (message, level = 'info') => emit(job, message, level));
    job.status = 'done';
    job.result = result;
    emit(job, 'Finished', 'success');
  } catch (err) {
    job.status = 'error';
    job.error = err.message || String(err);
    emit(job, job.error, 'error');
  } finally {
    job.finishedAt = new Date().toISOString();
    const set = listeners.get(job.id);
    if (set) for (const close of set) { try { close(); } catch { /* gone */ } }
    listeners.delete(job.id);
  }
}

function emit(job, message, level = 'info') {
  const step = { at: new Date().toISOString(), message, level };
  job.steps.push(step);
  const set = listeners.get(job.id);
  if (set) for (const send of set) send(step);
}

/* ---------------------------------------------------------------- helpers */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      if (!raw) return resolveBody({});
      try { resolveBody(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep) && file !== PUBLIC) return json(res, 403, { error: 'Forbidden' });
  let target = file;
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
  if (!existsSync(target)) {
    // SPA fallback for view routes
    target = join(PUBLIC, 'index.html');
    if (!existsSync(target)) return json(res, 404, { error: 'Not found' });
  }
  const type = MIME[extname(target)] || 'application/octet-stream';
  const immutable = target.includes('/vendor/');
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=86400' : 'no-store',
  });
  createReadStream(target).pipe(res);
}

/* ------------------------------------------------------------------ docs */

function listDocs({ q = '', limit = 40 } = {}) {
  const db = getDb();
  const args = [];
  let where = '';
  if (q) { where = "WHERE d.title LIKE ? OR d.content LIKE ?"; args.push(`%${q}%`, `%${q}%`); }
  return db.prepare(`
    SELECT d.id, d.title, d.url, d.domain, d.kind, d.trust, d.summary, d.word_count, d.retrieved_at, d.published_at, d.status,
      (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks,
      (SELECT COUNT(*) FROM doc_entities de WHERE de.doc_id = d.id) AS entities
    FROM docs d ${where} ORDER BY d.retrieved_at DESC LIMIT ?`).all(...args, Math.min(200, limit));
}

function deleteDoc(id) {
  const db = getDb();
  const doc = db.prepare('SELECT id, title FROM docs WHERE id = ?').get(id);
  if (!doc) return null;
  const affected = db.prepare('SELECT DISTINCT entity_id FROM doc_entities WHERE doc_id = ?').all(id).map((r) => r.entity_id);
  const factIds = db.prepare('SELECT id, sources FROM facts WHERE doc_id = ?').all(id);
  db.prepare('UPDATE facts SET doc_id = NULL WHERE doc_id = ?').run(id);
  db.prepare('DELETE FROM docs WHERE id = ?').run(id); // chunks cascade via FK
  db.prepare('DELETE FROM doc_entities WHERE doc_id = ?').run(id);
  const upd = db.prepare('UPDATE facts SET sources = ?, updated_at = ? WHERE id = ?');
  const del = db.prepare('DELETE FROM facts WHERE id = ?');
  const now = new Date().toISOString();
  for (const f of factIds) {
    const rest = JSON.parse(f.sources || '[]').filter((s) => s.docId !== id);
    if (!rest.length) del.run(f.id);
    else upd.run(JSON.stringify(rest), now, f.id);
  }
  const recompute = db.prepare(`UPDATE entities SET
      mentions = (SELECT COALESCE(SUM(count),0) FROM doc_entities WHERE entity_id = entities.id),
      salience = ROUND(
        (SELECT COALESCE(SUM(count),0) FROM doc_entities WHERE entity_id = entities.id) * 0.12
        + (SELECT COUNT(*) FROM edges WHERE src = entities.id OR dst = entities.id) * 0.35
        + (SELECT COUNT(*) FROM doc_entities WHERE entity_id = entities.id) * 0.8, 4),
      updated_at = ? WHERE id = ?`);
  for (const eid of affected) recompute.run(now, eid);
  db.prepare('DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM doc_entities) AND id NOT IN (SELECT src FROM edges UNION SELECT dst FROM edges)').run();
  recomputeFacts();
  return doc;
}

/* ---------------------------------------------------------------- routing */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  try {
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    if (p === '/api/health' && method === 'GET') {
      return json(res, 200, { ok: true, name: 'Loom', llm: await llmStatus(), time: new Date().toISOString() });
    }
    if (p === '/api/stats' && method === 'GET') return json(res, 200, stats());
    if (p === '/api/insights' && method === 'GET') return json(res, 200, insights());
    if (p === '/api/graph' && method === 'GET') {
      const focus = url.searchParams.get('focus');
      return json(res, 200, graph({
        focus: focus ? Number(focus) : null,
        depth: Number(url.searchParams.get('depth') || 2),
        limit: Number(url.searchParams.get('limit') || 140),
      }));
    }
    if (p === '/api/search' && method === 'GET') {
      return json(res, 200, search(url.searchParams.get('q') || '', {
        limit: Number(url.searchParams.get('limit') || 10),
        kind: url.searchParams.get('kind') || null,
      }));
    }
    if (p === '/api/memory' && method === 'GET') {
      return json(res, 200, { facts: memory({
        status: url.searchParams.get('status') || null,
        subject: url.searchParams.get('subject') || null,
        limit: Number(url.searchParams.get('limit') || 60),
      }) });
    }
    if (p === '/api/docs' && method === 'GET') {
      return json(res, 200, { docs: listDocs({ q: url.searchParams.get('q') || '', limit: Number(url.searchParams.get('limit') || 40) }) });
    }
    const docMatch = /^\/api\/docs\/([\w-]+)$/.exec(p);
    if (docMatch && method === 'GET') {
      const db = getDb();
      const doc = db.prepare('SELECT * FROM docs WHERE id = ?').get(docMatch[1]);
      if (!doc) return json(res, 404, { error: 'No such document' });
      const chunks = db.prepare('SELECT idx, text, heading FROM chunks WHERE doc_id = ? ORDER BY idx').all(doc.id);
      const ents = db.prepare(`SELECT e.id, e.name, e.type, de.count FROM doc_entities de JOIN entities e ON e.id = de.entity_id
        WHERE de.doc_id = ? ORDER BY de.count DESC`).all(doc.id);
      const facts = db.prepare("SELECT predicate, object, confidence, status FROM facts WHERE doc_id = ? AND status <> 'rejected'").all(doc.id);
      return json(res, 200, { ...doc, chunks, entities: ents, facts });
    }
    if (docMatch && method === 'DELETE') {
      const doc = deleteDoc(docMatch[1]);
      if (!doc) return json(res, 404, { error: 'No such document' });
      return json(res, 200, { ok: true, deleted: doc.title });
    }
    const entMatch = /^\/api\/entity\/(\d+)$/.exec(p);
    if (entMatch && method === 'GET') {
      const detail = entityDetail(entMatch[1]);
      if (!detail) return json(res, 404, { error: 'No such entity' });
      return json(res, 200, detail);
    }
    if (p === '/api/ask' && method === 'POST') {
      const body = await readBody(req);
      if (!body.question || !String(body.question).trim()) return json(res, 400, { error: 'A question is required' });
      return json(res, 200, await ask(String(body.question).trim(), { limit: Number(body.limit || 6) }));
    }
    if (p === '/api/wiki/search' && method === 'POST') {
      const body = await readBody(req);
      const q = String(body.q || '').trim();
      if (!q) return json(res, 400, { error: 'A search term is required' });
      return json(res, 200, { results: await wikiSearch(q, Number(body.limit || 8)) });
    }
    if (p === '/api/ingest' && method === 'POST') {
      const body = await readBody(req);
      const kind = body.kind || 'text';
      const input = { kind, title: body.title, text: body.text, url: body.url, useLLM: body.useLLM !== false };
      if (kind === 'text' && !String(body.text || '').trim()) return json(res, 400, { error: 'Nothing to index' });
      if (kind === 'text' && words(String(body.text)).length < 12) return json(res, 400, { error: 'A note needs at least a dozen words to be worth indexing' });
      if (kind === 'url' && !String(body.url || '').trim()) return json(res, 400, { error: 'A URL is required' });
      if (kind === 'wikipedia' && !String(body.title || '').trim()) return json(res, 400, { error: 'An article title is required' });
      const label = kind === 'text' ? (body.title || 'New note') : (body.title || body.url || 'Source');
      const job = newJob(kind, label, input);
      return json(res, 202, { jobId: job.id, job: publicJob(job) });
    }
    const jobMatch = /^\/api\/jobs\/([\w-]+)$/.exec(p);
    if (jobMatch && method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { error: 'No such job' });
      return json(res, 200, publicJob(job));
    }
    const sseMatch = /^\/api\/jobs\/([\w-]+)\/events$/.exec(p);
    if (sseMatch && method === 'GET') {
      const job = jobs.get(sseMatch[1]);
      if (!job) return json(res, 404, { error: 'No such job' });
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-store',
        connection: 'keep-alive', 'x-accel-buffering': 'no',
      });
      res.write(`retry: 2000\n\n`);
      for (const step of job.steps) res.write(`data: ${JSON.stringify({ ...step, status: job.status })}\n\n`);
      res.write(`data: ${JSON.stringify({ status: job.status, done: job.status === 'done' || job.status === 'error', result: job.result, error: job.error })}\n\n`);
      if (job.status === 'done' || job.status === 'error') return res.end();
      const send = (step) => res.write(`data: ${JSON.stringify({ ...step, status: job.status })}\n\n`);
      const set = listeners.get(job.id) || new Set();
      set.add(send);
      listeners.set(job.id, set);
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      req.on('close', () => { clearInterval(keepAlive); set.delete(send); });
      return;
    }
    if (p === '/api/memory/reinforce' && method === 'POST') {
      const body = await readBody(req);
      const fact = getDb().prepare('SELECT * FROM facts WHERE id = ?').get(Number(body.id));
      if (!fact) return json(res, 404, { error: 'No such claim' });
      const db = getDb();
      const now = new Date().toISOString();
      const confidence = Math.min(0.97, fact.confidence + 0.06);
      db.prepare("UPDATE facts SET confidence = ?, status = CASE WHEN status = 'single-source' THEN 'supported' ELSE status END, last_seen = ?, updated_at = ? WHERE id = ?")
        .run(confidence, now, now, fact.id);
      db.prepare('INSERT INTO memory_events (fact_id, kind, detail, at) VALUES (?, ?, ?, ?)')
        .run(fact.id, 'reinforce', 'Reinforced by you', now);
      return json(res, 200, { ok: true, confidence });
    }
    if (p === '/api/memory/status' && method === 'POST') {
      const body = await readBody(req);
      const status = String(body.status || '');
      if (!['verified', 'supported', 'single-source', 'contested', 'rejected'].includes(status)) {
        return json(res, 400, { error: 'Unknown status' });
      }
      const db = getDb();
      const fact = db.prepare('SELECT id FROM facts WHERE id = ?').get(Number(body.id));
      if (!fact) return json(res, 404, { error: 'No such claim' });
      const now = new Date().toISOString();
      db.prepare('UPDATE facts SET status = ?, updated_at = ? WHERE id = ?').run(status, now, fact.id);
      db.prepare('INSERT INTO memory_events (fact_id, kind, detail, at) VALUES (?, ?, ?, ?)')
        .run(fact.id, status === 'rejected' ? 'reject' : 'revise', `Status set to ${status} by you`, now);
      return json(res, 200, { ok: true, status });
    }
    if (p === '/api/export' && method === 'GET') {
      const db = getDb();
      const dump = {
        exportedAt: new Date().toISOString(),
        docs: db.prepare('SELECT id, title, url, domain, kind, trust, summary, retrieved_at FROM docs').all(),
        entities: db.prepare('SELECT id, name, type, description, salience FROM entities').all(),
        edges: db.prepare('SELECT src, dst, rel, weight FROM edges').all(),
        facts: db.prepare('SELECT subject_id, predicate, object, confidence, status, sources FROM facts').all(),
      };
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="loom-graph.json"',
        'cache-control': 'no-store',
      });
      return res.end(JSON.stringify(dump, null, 2));
    }
    if (p === '/api/memory/export' && method === 'GET') {
      const rows = memory({ limit: 5000 });
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="loom-memory.md"',
        'cache-control': 'no-store',
      });
      return res.end(`# Loom memory\n\n_Exported ${new Date().toISOString()}_\n\n`
        + rows.map((f) => `- **${f.subject_name}** ${labelFor(f.predicate)} **${f.object_name || f.object}** — ${f.status}, ${Math.round(f.confidence * 100)}% confidence (${f.domains.join(', ') || 'unknown sources'})`).join('\n') + '\n');
    }

    return json(res, 404, { error: `No route for ${method} ${p}` });
  } catch (err) {
    const message = err?.message || 'Internal error';
    const status = /required|Invalid JSON|too large|Nothing|URL is required|article title/i.test(message) ? 400 : 500;
    if (status === 500) console.error('[loom]', err);
    return json(res, status, { error: message });
  }
});

function publicJob(job) {
  return {
    id: job.id, kind: job.kind, label: job.label, status: job.status,
    steps: job.steps, result: job.result, error: job.error,
    createdAt: job.createdAt, finishedAt: job.finishedAt,
  };
}

server.listen(PORT, HOST, () => {
  const s = stats();
  console.log(`\n  Loom — personal knowledge OS`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  ${s.counts.docs} documents · ${s.counts.entities} entities · ${s.counts.facts} claims\n`);
});

export { server };
