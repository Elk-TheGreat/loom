import { getDb, tx } from './db.js';
import { chunkText, hostOf, sha1, summarize, truncate, words } from './text.js';
import { embed, pack } from './embed.js';
import { extract, keyOf } from './extract.js';
import { fetchPage, trustForDomain, wikiPage } from './sources.js';
import { refineExtraction } from './llm.js';
import { confidenceFor, statusFor } from './verify.js';

const FACT_PREDICATES = new Set([
  'is_a', 'founded', 'born', 'born_in', 'located_in', 'part_of', 'studied_at', 'worked_for',
  'led', 'created', 'influenced', 'based_on', 'succeeded', 'spouse', 'capital_of', 'uses',
  'caused', 'opposed', 'member_of', 'owns',
]);
const MAX_ENTITIES_PER_DOC = 60;
const MAX_FACTS_PER_DOC = 80;

export async function resolveSource(input) {
  const kind = input.kind || 'text';
  if (kind === 'wikipedia') {
    const page = await wikiPage(input.title);
    return { ...page, publishedAt: input.publishedAt || null };
  }
  if (kind === 'url') {
    const page = await fetchPage(input.url);
    return { ...page, publishedAt: null };
  }
  const text = String(input.text || '').trim();
  if (words(text).length < 12) throw new Error('A note needs at least a dozen words to be worth indexing');
  if (text.length > 400_000) throw new Error('That note is too large (400k character limit)');
  // A note may cite the page it is about; that page's domain is what makes the
  // note an independent witness of the same claim.
  const url = /^https?:\/\//i.test(String(input.url || '')) ? String(input.url) : null;
  const domain = input.domain || (url ? hostOf(url) : null) || 'local';
  return {
    title: (input.title || firstLine(text) || 'Untitled note').slice(0, 160),
    text,
    url,
    domain,
    kind: 'note',
    trust: url ? trustForDomain(domain) : 0.7,
    summary: summarize(text, 2),
    retrievedAt: new Date().toISOString(),
    publishedAt: input.publishedAt || null,
  };
}

function firstLine(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line ? truncate(line.replace(/[#*_`>]/g, ''), 90) : '';
}

/**
 * Full ingestion pipeline. `log(message, level?)` receives progress updates.
 */
const AGENT_ONLY = new Set(['created', 'founded', 'led', 'studied_at', 'worked_for', 'member_of']);
let typeOfStmt = null;
function typeOfEntity(id) {
  typeOfStmt ??= getDb().prepare('SELECT type FROM entities WHERE id = ?');
  return typeOfStmt.get(id);
}

/**
 * Only people and organisations create, lead, study or work. A concept as the
 * subject of "created" is almost always a reversed or mis-parsed sentence.
 */
// "Web created the Semantic Web", "RDF created W3C": a concept-shaped name is
// never the agent of a creation, whatever type inference guessed for it.
const NON_AGENT_NAME = /\b(web|graph|data|model|language|system|standard|protocol|network|consortium|framework|format|database|ontology|markup)\b/i;

function plausibleClaim(entityId, rel, objectId = null) {
  const subject = typeOfEntity(entityId);
  const type = subject?.type;
  if (rel === 'born_in' || rel === 'died_in') return type === 'person';
  if (objectId && rel === 'worked_for' && typeOfEntity(objectId)?.type === 'person') return false;
  if (objectId && rel === 'located_in') {
    const objType = typeOfEntity(objectId)?.type;
    if (objType === 'concept' && type === 'concept') return false;
  }
  if (!AGENT_ONLY.has(rel)) return true;
  if (NON_AGENT_NAME.test(subject?.name || '')) return false;
  if (type !== 'person' && type !== 'organization') return false;
  // "X created Y" where Y is a person is almost always a reversed passive.
  if ((rel === 'created' || rel === 'founded') && objectId) {
    const objType = typeOfEntity(objectId)?.type;
    if (objType === 'person') return false;
    // "RDF was created by the W3C" reversed would read "RDF created W3C":
    // only agents create organizations, never concepts.
    if (objType === 'organization' && type !== 'organization' && type !== 'person') return false;
  }
  return true;
}

export async function ingest(input, log = () => {}) {
  log('Resolving source…');
  const src = await resolveSource(input);
  const db = getDb();
  const hash = sha1(src.text);

  const existing = db.prepare('SELECT id, title FROM docs WHERE content_hash = ?').get(hash);
  if (existing) {
    log(`Already in the library as “${existing.title}” — nothing re-indexed.`, 'warn');
    return { docId: existing.id, title: existing.title, duplicate: true, entities: 0, edges: 0, facts: 0, chunks: 0 };
  }

  const docId = `doc_${sha1(`${hash}:${Date.now()}`).slice(0, 12)}`;
  const now = new Date().toISOString();
  const title = src.title;
  const chunks = chunkText(src.text);
  if (!chunks.length) throw new Error('No indexable text was found in that source');
  log(`Split into ${chunks.length} passages`);

  db.prepare(`INSERT INTO docs (id, title, url, kind, domain, summary, content, word_count, content_hash, published_at, retrieved_at, trust, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')`)
    .run(docId, title, src.url, src.kind, src.domain || hostOf(src.url), src.summary || summarize(src.text, 3),
      src.text, words(src.text).length, hash, src.publishedAt || null, now, src.trust ?? trustForDomain(src.domain));

  log('Embedding passages…');
  const insChunk = db.prepare('INSERT INTO chunks (doc_id, idx, text, heading, tokens, vec) VALUES (?, ?, ?, ?, ?, ?)');
  chunks.forEach((c, i) => {
    insChunk.run(docId, i, c.text, c.heading, words(c.text).length, pack(embed(`${c.heading || ''} ${c.text}`)));
  });

  log('Extracting entities and relations…');
  const parsed = extract(src.text, { title });

  let refined = null;
  if (input.useLLM !== false) {
    refined = await refineExtraction({ title, text: src.text, entities: parsed.entities });
    if (refined) log(`Local model refined ${refined.entities.length} entities, ${refined.relations.length} relations`, 'success');
  }

  const result = tx((d) => persist(d, { docId, src, parsed, refined, now }));
  log(`Linked ${result.entities} entities, ${result.edges} relations, ${result.facts} claims`, 'success');
  return { docId, title, duplicate: false, ...result, chunks: chunks.length };
}

function persist(db, { docId, src, parsed, refined, now }) {
  const domain = src.domain || hostOf(src.url) || 'local';
  const entityIds = new Map(); // key -> id
  const entityMeta = new Map();

  for (const e of parsed.entities.slice(0, MAX_ENTITIES_PER_DOC)) {
    entityMeta.set(e.key, { name: e.name, type: e.type, description: e.description, mentions: e.docMentions || e.mentions || 1 });
  }
  if (refined) {
    for (const e of refined.entities) {
      const key = keyOf(e.name);
      if (!key) continue;
      const prev = entityMeta.get(key);
      if (prev) {
        if (!prev.description) prev.description = null;
        if (prev.type === 'concept' && e.type !== 'concept') prev.type = e.type;
      } else {
        entityMeta.set(key, { name: e.name, type: e.type, description: null, mentions: 1 });
      }
    }
  }
  // Keep the graph's own subject: descriptions for title entities that the parser missed.
  const titleKey = keyOf(src.title || '');
  if (titleKey && !entityMeta.has(titleKey) && (src.text.toLowerCase().startsWith(src.title.toLowerCase()) || src.kind === 'wikipedia')) {
    entityMeta.set(titleKey, { name: src.title, type: 'concept', description: null, mentions: 2 });
  }
  if (titleKey && entityMeta.has(titleKey)) {
    const meta = entityMeta.get(titleKey);
    if (!meta.description && src.summary) {
      const m = /^[^.]{0,140}?\bis\s+(?:an?|the)\s+(.{3,140})/i.exec(src.summary);
      if (m) meta.description = m[1].replace(/[.]$/, '');
    }
  }

  const upsertEntity = db.prepare(`INSERT INTO entities (key, name, type, description, salience, mentions, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      name = CASE WHEN length(excluded.name) > length(entities.name) THEN excluded.name ELSE entities.name END,
      type = CASE WHEN entities.type = 'concept' AND excluded.type <> 'concept' THEN excluded.type ELSE entities.type END,
      description = COALESCE(entities.description, excluded.description),
      updated_at = excluded.updated_at
    RETURNING id`);
  const linkDoc = db.prepare(`INSERT INTO doc_entities (doc_id, entity_id, count) VALUES (?, ?, ?)
    ON CONFLICT(doc_id, entity_id) DO UPDATE SET count = count + excluded.count`);

  for (const [key, meta] of entityMeta) {
    const row = upsertEntity.get(key, meta.name, meta.type, meta.description || null, now, now);
    entityIds.set(key, row.id);
    linkDoc.run(docId, row.id, meta.mentions);
  }

  // Edges
  let edgeCount = 0;
  const upsertEdge = db.prepare(`INSERT INTO edges (src, dst, rel, weight, doc_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(src, dst, rel) DO UPDATE SET
      weight = edges.weight + excluded.weight,
      doc_ids = excluded.doc_ids,
      updated_at = excluded.updated_at
    RETURNING id`);
  const edges = [...parsed.edges];
  if (refined) {
    for (const r of refined.relations) {
      const a = keyOf(r.from);
      const b = keyOf(r.to);
      if (!entityIds.has(a) || !entityIds.has(b) || a === b) continue;
      if (edges.some((e) => e.srcKey === a && e.dstKey === b && e.rel === r.rel)) continue;
      edges.push({ srcKey: a, dstKey: b, rel: r.rel, weight: 1.1, sentence: `${r.from} ${r.rel.replace(/_/g, ' ')} ${r.to}` });
    }
  }

const upsertFact = db.prepare(`INSERT INTO facts (subject_id, predicate, object, object_id, doc_id, snippet, confidence, supports, sources, status, created_at, updated_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(subject_id, predicate, object) DO UPDATE SET
      supports = facts.supports + 1,
      sources = excluded.sources,
      confidence = excluded.confidence,
      status = excluded.status,
      snippet = COALESCE(facts.snippet, excluded.snippet),
      updated_at = excluded.updated_at,
      last_seen = excluded.last_seen
    RETURNING id`);

  const factStatements = [];
  for (const e of edges) {
    const a = entityIds.get(e.srcKey);
    const b = entityIds.get(e.dstKey);
    if (!a || !b) continue;
    const existing = db.prepare('SELECT doc_ids FROM edges WHERE src = ? AND dst = ? AND rel = ?').get(a, b, e.rel);
    const docs = existing ? JSON.parse(existing.doc_ids) : [];
    if (!docs.includes(docId)) docs.push(docId);
    upsertEdge.get(a, b, e.rel, e.weight, JSON.stringify(docs.slice(-40)), now, now);
    edgeCount++;
    if (FACT_PREDICATES.has(e.rel) && plausibleClaim(a, e.rel, b)) {
      const objName = db.prepare('SELECT name FROM entities WHERE id = ?').get(b)?.name || e.dstKey;
      factStatements.push({ subjectId: a, predicate: e.rel, object: objName, objectId: b, snippet: e.sentence });
    }
  }

  for (const f of parsed.facts.slice(0, MAX_FACTS_PER_DOC)) {
    const sid = entityIds.get(f.subjectKey);
    if (!sid) continue;
    if (factStatements.some((x) => x.subjectId === sid && x.predicate === f.predicate && x.object === f.object)) continue;
    factStatements.push({ subjectId: sid, predicate: f.predicate, object: f.object, objectId: null, snippet: f.snippet });
  }

  let factCount = 0;
  for (const f of factStatements.slice(0, MAX_FACTS_PER_DOC)) {
    const prev = db.prepare('SELECT sources, supports FROM facts WHERE subject_id = ? AND predicate = ? AND object = ?')
      .get(f.subjectId, f.predicate, f.object);
    const sources = prev ? JSON.parse(prev.sources) : [];
    if (!sources.some((s) => s.docId === docId)) sources.push({ docId, domain, trust: src.trust ?? 0.5 });
    const domains = sources.map((s) => s.domain);
    const trust = Math.max(...sources.map((s) => s.trust || 0.5));
    const supports = sources.length;
    const conflict = hasConflict(db, f, docId);
    const confidence = confidenceFor({ supports, domains, trust, hasConflict: conflict });
    const status = statusFor({ supports, domains, confidence, hasConflict: conflict });

    const row = upsertFact.get(f.subjectId, f.predicate, f.object, f.objectId, docId, f.snippet,
      confidence, JSON.stringify(sources), status, now, now, now);
    factCount++;
    db.prepare('INSERT INTO memory_events (fact_id, kind, detail, at) VALUES (?, ?, ?, ?)')
      .run(row.id, prev ? 'reinforce' : 'assert', prev ? `Corroborated by ${domain}` : `First asserted by ${domain}`, now);

    if (conflict) {
      db.prepare(`UPDATE facts SET status = 'contested', updated_at = ? WHERE subject_id = ? AND predicate = ? AND object <> ? AND status <> 'rejected'`)
        .run(now, f.subjectId, f.predicate, f.object);
    }
  }

  // Recompute salience for everything this document touched.
  const recompute = db.prepare(`UPDATE entities SET
      mentions = (SELECT COALESCE(SUM(count), 0) FROM doc_entities WHERE entity_id = entities.id),
      salience = ROUND(
        (SELECT COALESCE(SUM(count), 0) FROM doc_entities WHERE entity_id = entities.id) * 0.12
        + (SELECT COUNT(*) FROM edges WHERE src = entities.id OR dst = entities.id) * 0.35
        + (SELECT COUNT(*) FROM doc_entities WHERE entity_id = entities.id) * 0.8, 4),
      updated_at = ?
    WHERE id = ?`);
  for (const id of entityIds.values()) recompute.run(now, id);

  db.prepare("UPDATE docs SET status = 'ready', summary = COALESCE(summary, ?) WHERE id = ?")
    .run(summarize(src.text, 3), docId);

  return { entities: entityIds.size, edges: edgeCount, facts: factCount };
}

/** Predicates that hold one value per subject; only these can truly contradict. */
const FUNCTIONAL = new Set(['born_in', 'died_in', 'founded', 'located_in', 'capital_of', 'spouse', 'succeeded']);

function hasConflict(db, fact, docId) {
  if (!FUNCTIONAL.has(fact.predicate)) return false;
  const other = db.prepare(`SELECT id FROM facts WHERE subject_id = ? AND predicate = ? AND object <> ? AND status <> 'rejected' LIMIT 1`)
    .get(fact.subjectId, fact.predicate, fact.object);
  return Boolean(other);
}

/**
 * Drop claims that cannot be true of their subject (a concept born somewhere,
 * a person created by an organisation) and reciprocal "created" pairs where the
 * non-agent direction survives. Keeps the memory from accumulating contradictions
 * it can never resolve.
 */
function pruneFacts(db) {
  const rows = db.prepare(`SELECT f.id, f.subject_id, f.object_id, f.predicate, s.type AS subject_type, o.type AS object_type
    FROM facts f JOIN entities s ON s.id = f.subject_id LEFT JOIN entities o ON o.id = f.object_id`).all();
  const byPair = new Map();
  for (const r of rows) if (r.object_id) byPair.set(`${r.subject_id}:${r.object_id}:${r.predicate}`, r);
  const del = db.prepare('DELETE FROM facts WHERE id = ?');
  for (const r of rows) {
    if (r.subject_type && plausibleClaim(r.subject_id, r.predicate, r.object_id)) continue;
    del.run(r.id);
  }
}

/** Re-derive confidence/status for every fact (used after manual memory edits). */
export function recomputeFacts() {
  const db = getDb();
  pruneFacts(db);
  const rows = db.prepare('SELECT id, subject_id, predicate, object, sources, status FROM facts').all();
  const upd = db.prepare('UPDATE facts SET confidence = ?, status = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  for (const r of rows) {
    if (r.status === 'rejected') continue;
    const sources = JSON.parse(r.sources || '[]');
    const domains = sources.map((s) => s.domain);
    const trust = Math.max(0.4, ...sources.map((s) => s.trust || 0.4));
    const conflict = hasConflict(db, { subjectId: r.subject_id, predicate: r.predicate, object: r.object }, null);
    const confidence = confidenceFor({ supports: Math.max(1, sources.length), domains, trust, hasConflict: conflict });
    upd.run(confidence, statusFor({ supports: sources.length, domains, confidence, hasConflict: conflict }), now, r.id);
  }
}
