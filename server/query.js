import { getDb } from './db.js';
import { STOPWORDS, splitSentences, tokenize, truncate } from './text.js';
import { cosine, embed, rrf, unpack } from './embed.js';
import { labelFor, recallWeight } from './verify.js';
import { llmGenerate, llmStatus } from './llm.js';

const MAX_SCAN = 8000;

function ftsQuery(q) {
  const toks = tokenize(q).slice(0, 12);
  if (!toks.length) return null;
  return toks.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

export function search(q, { limit = 10, kind = null } = {}) {
  const t0 = performance.now();
  const db = getDb();
  const trimmed = String(q || '').trim();
  if (!trimmed) return { query: '', results: [], entities: [], tookMs: 0 };

  const match = ftsQuery(trimmed);
  const lexical = [];
  if (match) {
    const rows = db.prepare(`
      SELECT c.id AS chunk_id, c.doc_id, bm25(chunk_fts) AS rank
      FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid
      JOIN docs d ON d.id = c.doc_id
      WHERE chunk_fts MATCH ? AND d.status = 'ready' ${kind ? 'AND d.kind = ?' : ''}
      ORDER BY rank LIMIT 60`).all(...(kind ? [match, kind] : [match]));
    for (const r of rows) lexical.push(r.chunk_id);
  }

  const qv = embed(trimmed);
  const vector = [];
  const candidates = db.prepare(`
    SELECT c.id AS chunk_id, c.vec FROM chunks c JOIN docs d ON d.id = c.doc_id
    WHERE d.status = 'ready' ${kind ? 'AND d.kind = ?' : ''}
    ORDER BY c.id DESC LIMIT ${MAX_SCAN}`).all(...(kind ? [kind] : []));
  const scored = [];
  for (const c of candidates) {
    const v = unpack(c.vec);
    if (!v) continue;
    const s = cosine(qv, v);
    if (s > 0.06) scored.push([c.chunk_id, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  for (const [id] of scored.slice(0, 60)) vector.push(id);

  const fused = rrf([lexical, vector]);
  const cosById = new Map(scored.map(([id, s]) => [id, s]));
  const limitN = Math.max(1, Math.min(50, limit));

  const getChunk = db.prepare('SELECT id, doc_id, idx, text, heading FROM chunks WHERE id = ?');
  const getDoc = db.prepare('SELECT id, title, url, domain, kind, trust, retrieved_at, published_at FROM docs WHERE id = ?');

  const entities = db.prepare(`
    SELECT id, name, type, salience, description,
      (SELECT COALESCE(SUM(count),0) FROM doc_entities WHERE entity_id = e.id) AS mentions
    FROM entities e
    WHERE key LIKE ? OR name LIKE ?
    ORDER BY salience DESC LIMIT 6`).all(`%${trimmed.toLowerCase()}%`, `%${trimmed}%`);

  const results = [];
  for (const [chunkId, score] of fused.slice(0, limitN * 2)) {
    if (results.length >= limitN) break;
    const c = getChunk.get(chunkId);
    if (!c) continue;
    const doc = getDoc.get(c.doc_id);
    if (!doc) continue;
    const factBoost = results.length; // placeholder to keep ordering stable
    results.push({
      chunkId,
      docId: doc.id,
      title: doc.title,
      url: doc.url,
      domain: doc.domain,
      kind: doc.kind,
      trust: doc.trust,
      retrievedAt: doc.retrieved_at,
      heading: c.heading,
      text: c.text,
      snippet: bestSnippet(c.text, trimmed),
      score: Number(score.toFixed(5)),
      similarity: Number((cosById.get(chunkId) || 0).toFixed(3)),
      mentions: factBoost === -1 ? 0 : undefined,
    });
  }

  // Attach the entities each passage talks about.
  for (const r of results) {
    r.entities = db.prepare(`
      SELECT e.id, e.name, e.type FROM doc_entities de JOIN entities e ON e.id = de.entity_id
      WHERE de.doc_id = ? AND instr(lower(?), e.key) > 0 ORDER BY e.salience DESC LIMIT 4`)
      .all(r.docId, r.text.toLowerCase());
  }

  return { query: trimmed, results, entities, tookMs: Math.round(performance.now() - t0), totalChunks: candidates.length };
}

export function bestSnippet(text, query, len = 260) {
  const terms = new Set(tokenize(query));
  const sents = splitSentences(text);
  if (!sents.length) return truncate(text, len);
  let best = sents[0];
  let bestScore = -1;
  sents.forEach((s, i) => {
    const st = new Set(tokenize(s));
    let hit = 0;
    for (const t of terms) if (st.has(t)) hit++;
    const score = hit * 2 - i * 0.05 - Math.abs(s.length - len) / 2000;
    if (score > bestScore) { bestScore = score; best = s; }
  });
  return truncate(best, len);
}

export function graph({ focus = null, depth = 2, limit = 140 } = {}) {
  const db = getDb();
  let ids = [];
  if (focus) {
    const seen = new Set([Number(focus)]);
    let frontier = [Number(focus)];
    for (let d = 0; d < Math.max(1, Math.min(3, depth)); d++) {
      const next = [];
      for (const id of frontier) {
        const rows = db.prepare(`SELECT src AS a, dst AS b FROM edges WHERE src = ? OR dst = ? ORDER BY weight DESC LIMIT 40`).all(id, id);
        for (const r of rows) {
          const other = r.a === id ? r.b : r.a;
          if (!seen.has(other)) { seen.add(other); next.push(other); }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    ids = [...seen];
  }

  let nodes;
  if (ids.length) {
    nodes = db.prepare(`SELECT * FROM entities WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  } else {
    nodes = db.prepare(`SELECT * FROM entities ORDER BY salience DESC, mentions DESC LIMIT ?`).all(Math.min(400, Math.max(20, limit)));
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  const links = db.prepare(`SELECT * FROM edges ORDER BY weight DESC LIMIT 4000`).all()
    .filter((e) => nodeIds.has(e.src) && nodeIds.has(e.dst))
    .map((e) => ({
      source: e.src, target: e.dst, rel: e.rel, label: labelFor(e.rel),
      weight: Number(e.weight.toFixed(2)), docs: JSON.parse(e.doc_ids || '[]').length,
    }));

  const degree = new Map();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }

  return {
    nodes: nodes.map((n) => ({
      id: n.id, name: n.name, type: n.type, description: n.description,
      salience: n.salience, mentions: n.mentions, degree: degree.get(n.id) || 0,
    })),
    links,
    focus: focus ? Number(focus) : null,
  };
}

export function entityDetail(id) {
  const db = getDb();
  const e = db.prepare('SELECT * FROM entities WHERE id = ?').get(Number(id));
  if (!e) return null;
  const neighbors = db.prepare(`
    SELECT e2.id, e2.name, e2.type, x.rel, x.weight, x.src AS from_id, x.dst AS to_id
    FROM edges x JOIN entities e2 ON e2.id = CASE WHEN x.src = ? THEN x.dst ELSE x.src END
    WHERE x.src = ? OR x.dst = ? ORDER BY x.weight DESC LIMIT 60`).all(e.id, e.id, e.id);
  const facts = db.prepare(`
    SELECT f.*, o.name AS object_name FROM facts f LEFT JOIN entities o ON o.id = f.object_id
    WHERE f.subject_id = ? AND f.status <> 'rejected' ORDER BY f.confidence DESC LIMIT 40`).all(e.id);
  const docs = db.prepare(`
    SELECT d.id, d.title, d.url, d.domain, d.kind, d.trust, de.count
    FROM doc_entities de JOIN docs d ON d.id = de.doc_id WHERE de.entity_id = ?
    ORDER BY de.count DESC LIMIT 20`).all(e.id);
  const events = db.prepare(`
    SELECT me.kind, me.detail, me.at, f.predicate, f.object
    FROM memory_events me JOIN facts f ON f.id = me.fact_id
    WHERE f.subject_id = ? ORDER BY me.at DESC LIMIT 25`).all(e.id);
  const related = db.prepare(`
    SELECT e2.id, e2.name, e2.type, COUNT(*) AS shared
    FROM doc_entities a JOIN doc_entities b ON a.doc_id = b.doc_id AND b.entity_id <> a.entity_id
    JOIN entities e2 ON e2.id = b.entity_id
    WHERE a.entity_id = ? GROUP BY e2.id ORDER BY shared DESC LIMIT 8`).all(e.id);

  return {
    ...e,
    neighbors: neighbors.map((n) => ({
      id: n.id, name: n.name, type: n.type, rel: n.rel,
      label: labelFor(n.rel), weight: n.weight, direction: n.from_id === e.id ? 'out' : 'in',
    })),
    facts: facts.map((f) => ({ ...f, sources: JSON.parse(f.sources || '[]'), label: labelFor(f.predicate) })),
    docs,
    events,
    related,
  };
}

export function memory({ status = null, limit = 60, subject = null } = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (status) { where.push('f.status = ?'); args.push(status); }
  if (subject) { where.push('f.subject_id = ?'); args.push(Number(subject)); }
  const sql = `SELECT f.*, s.name AS subject_name, s.type AS subject_type, o.name AS object_name
    FROM facts f JOIN entities s ON s.id = f.subject_id LEFT JOIN entities o ON o.id = f.object_id
    ${where.length ? `WHERE ${where.join(' AND ')} AND f.status <> 'rejected'` : "WHERE f.status <> 'rejected'"}
    ORDER BY f.confidence DESC, f.last_seen DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit).map((f) => {
    const sources = JSON.parse(f.sources || '[]');
    return {
      ...f,
      sources,
      domains: [...new Set(sources.map((s) => s.domain))],
      label: labelFor(f.predicate),
      recall: Number(recallWeight({ confidence: f.confidence, last_seen: f.last_seen, status: f.status }).toFixed(3)),
    };
  });
  return rows;
}

export function stats() {
  const db = getDb();
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const counts = {
    docs: one('SELECT COUNT(*) n FROM docs').n,
    chunks: one('SELECT COUNT(*) n FROM chunks').n,
    entities: one('SELECT COUNT(*) n FROM entities').n,
    edges: one('SELECT COUNT(*) n FROM edges').n,
    facts: one("SELECT COUNT(*) n FROM facts WHERE status <> 'rejected'").n,
    verified: one("SELECT COUNT(*) n FROM facts WHERE status = 'verified'").n,
    contested: one("SELECT COUNT(*) n FROM facts WHERE status = 'contested'").n,
    domains: one("SELECT COUNT(DISTINCT domain) n FROM docs WHERE domain IS NOT NULL").n,
    words: one('SELECT COALESCE(SUM(word_count),0) n FROM docs').n,
  };
  const types = db.prepare('SELECT type, COUNT(*) n FROM entities GROUP BY type ORDER BY n DESC').all();
  const top = db.prepare('SELECT id, name, type, salience, mentions FROM entities ORDER BY salience DESC LIMIT 8').all();
  const recent = db.prepare('SELECT id, title, domain, kind, word_count, retrieved_at FROM docs ORDER BY retrieved_at DESC LIMIT 6').all();
  const predicates = db.prepare("SELECT predicate, COUNT(*) n FROM facts WHERE status <> 'rejected' GROUP BY predicate ORDER BY n DESC LIMIT 10").all();
  return { counts, types, top, recent, predicates };
}

export function insights() {
  const db = getDb();
  const orphans = db.prepare(`
    SELECT e.id, e.name, e.type, e.salience FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM edges WHERE src = e.id OR dst = e.id)
    ORDER BY e.salience DESC LIMIT 6`).all();
  const thin = db.prepare(`
    SELECT e.id, e.name, e.type, e.mentions FROM entities e
    WHERE (SELECT COUNT(*) FROM doc_entities WHERE entity_id = e.id) = 1 AND e.mentions >= 2
    ORDER BY e.salience DESC LIMIT 6`).all();
  const contested = db.prepare(`
    SELECT f.id, f.predicate, f.object, f.confidence, s.name AS subject_name
    FROM facts f JOIN entities s ON s.id = f.subject_id
    WHERE f.status = 'contested' ORDER BY f.updated_at DESC LIMIT 6`).all();
  const undescribed = db.prepare(`
    SELECT id, name, type FROM entities WHERE description IS NULL AND salience > 0
    ORDER BY salience DESC LIMIT 6`).all();
  const bridges = db.prepare(`
    SELECT e.id, e.name, e.type, COUNT(DISTINCT d.domain) AS domains
    FROM entities e JOIN doc_entities de ON de.entity_id = e.id JOIN docs d ON d.id = de.doc_id
    GROUP BY e.id HAVING domains > 1 ORDER BY domains DESC, e.salience DESC LIMIT 6`).all();
  return { orphans, thin, contested, undescribed, bridges };
}

/** Retrieval-augmented answer. Uses the local model when present, else extracts. */
export async function ask(question, { limit = 6 } = {}) {
  const db = getDb();
  const found = search(question, { limit });
  const facts = memory({ limit: 8 }).filter((f) => {
    const q = question.toLowerCase();
    return q.includes(f.subject_name.toLowerCase().split(' ')[0].slice(0, 5))
      || f.subject_name.toLowerCase().includes(question.toLowerCase().split(' ')[0] || '§')
      || (f.object || '').toLowerCase().includes(question.toLowerCase().split(' ')[0] || '§');
  }).slice(0, 5);

  const sources = found.results.map((r, i) => ({
    n: i + 1, docId: r.docId, title: r.title, url: r.url, domain: r.domain, text: r.snippet, chunkId: r.chunkId, score: r.score,
  }));
  if (!sources.length) {
    return { question, answer: "I don't have anything indexed that speaks to that yet. Add a source and ask again.", mode: 'empty', sources: [], facts: [], llm: await llmStatus() };
  }

  const status = await llmStatus();
  if (status.available) {
    const context = found.results.map((r, i) => `[${i + 1}] ${r.title} (${r.domain})\n${truncate(r.text, 1100)}`).join('\n\n');
    const answer = await llmGenerate(
      `Sources:\n${context}\n\nQuestion: ${question}\n\nAnswer using only the sources above. Cite with [1], [2] right after claims. If the sources do not answer it, say so plainly. Keep it under 180 words.`,
      { system: 'You are a careful research assistant answering strictly from provided sources.', temperature: 0.1, maxTokens: 500 },
    );
    if (answer) return { question, answer, mode: 'llm', model: status.model, sources, facts, llm: status };
  }

  // Extractive fallback: pick the passages' most query-relevant sentences.
  const terms = new Set(tokenize(question));
  const picked = [];
  found.results.forEach((r, i) => {
    splitSentences(r.text).forEach((s) => {
      const st = new Set(tokenize(s));
      let hit = 0;
      for (const t of terms) if (st.has(t)) hit++;
      if (hit > 0) picked.push({ s, n: i + 1, score: hit / Math.sqrt(st.size || 1), domain: r.domain });
    });
  });
  picked.sort((a, b) => b.score - a.score);
  const top = [];
  for (const p of picked) {
    if (top.length >= 4) break;
    if (top.some((t) => t.s === p.s)) continue;
    top.push(p);
  }
  const body = top.length
    ? top.map((p) => `• ${truncate(p.s, 240)} [${p.n}]`).join('\n')
    : `• ${truncate(found.results[0].snippet, 240)} [1]`;
  return {
    question,
    answer: `Here is what your library says, from ${new Set(sources.map((s) => s.domain)).size} source${new Set(sources.map((s) => s.domain)).size > 1 ? 's' : ''}:\n\n${body}\n\n_Extractive summary — no local model is connected, so these are the source sentences that best match, not generated prose._`,
    mode: 'extractive',
    sources, facts, llm: status,
  };
}
