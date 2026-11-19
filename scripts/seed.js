/**
 * Seed a small, interconnected corpus so a fresh install has something to show.
 * Usage: npm run seed            (adds anything missing)
 *        rm -f data/loom.db* && npm run seed   (fresh start)
 */
import { ingest } from '../server/ingest.js';
import { getDb, initDb } from '../server/db.js';

const ARTICLES = [
  'Knowledge graph',
  'Semantic Web',
  'Wikidata',
  'Tim Berners-Lee',
  'Google Knowledge Graph',
  'Resource Description Framework',
  'Graph database',
  'SPARQL',
];

const NOTES = [
  {
    title: 'Why I keep a second brain',
    text: `My notes kept dying in folders. I would write something useful, forget where it went, and rewrite it six months later. The problem was never capture; it was recall. A folder asks me to remember the shape of my own past.

A knowledge graph changes the question. Instead of "which folder did I put this in", I ask "what is near this idea". Associations are how memory actually works: a person, a project, a place, a paper, all pointing at each other. Retrieval becomes a walk, not a search.

Three rules I follow now. First, every note must name at least two things it is about, otherwise it is a diary entry and can stay out of the graph. Second, anything I read that I might quote later gets its source recorded, because an uncited claim decays into a rumour. Third, I trust the graph's confidence, not my enthusiasm: a claim seen in one blog post is not the same as a claim seen in three independent sources.

Loom is the tool I built for this. It ingests what I read, extracts the entities and relations, keeps a memory of claims with confidence and contradiction, and lets me ask questions across everything at once. It runs locally, on SQLite, with no cloud account. The local model is optional; without it, retrieval still works and answers are extractive rather than written.`,
  },
  {
    title: 'Reading: the Semantic Web standard',
    url: 'https://www.w3.org/standards/semanticweb/',
    text: `Tim Berners-Lee invented the Semantic Web at the World Wide Web Consortium. The Semantic Web adds machine-readable meaning to pages. RDF is the data model underneath it. I keep coming back to this page because it is short and authoritative, and because the ambitions it describes are still unfinished.`,
  },
  {
    title: 'Reading notes: the semantic web, twenty years on',
    text: `Re-reading the 2001 Scientific American piece on the Semantic Web. The promise was that machines would understand the meaning of pages, not just their text. The mechanism was metadata: RDF triples, ontologies, URIs that name things rather than locations.

What actually shipped is more modest and more useful. Schema.org markup, Wikidata's enormous open graph, JSON-LD embedded in ordinary pages, and knowledge panels assembled from them. The open web did not become one ontology, but it did become partially machine-readable in the places that mattered: products, places, people, organisations.

The lesson for a personal system is that perfect ontologies are a trap. My own graph starts with six loose types and a handful of predicates, and it is already useful. When the LLM is available it proposes better relations; when it is not, verb cues and co-occurrence carry the day. Structure can stay cheap and incremental.

The other lesson: provenance is the hard part, not extraction. Anyone can pull entity names out of a paragraph. Knowing whether two sources agree, and which one to believe, is what makes a memory worth keeping.`,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wikipedia rate-limits bursts; back off and try again rather than losing a source. */
async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      if (!/429|rate|timeout|fetch failed/i.test(err.message)) break;
      await sleep(6000 * (i + 1));
    }
  }
  throw last;
}

async function main() {
  initDb();
  const db = getDb();
  const seen = new Set(db.prepare('SELECT title FROM docs').all().map((r) => r.title.toLowerCase()));

  for (const title of ARTICLES) {
    if (seen.has(title.toLowerCase())) { console.log(`skip  ${title}`); continue; }
    process.stdout.write(`wiki  ${title} … `);
    try {
      const r = await withRetry(() => ingest({ kind: 'wikipedia', title, useLLM: false }));
      console.log(`${r.chunks} passages, ${r.entities} entities, ${r.edges} relations, ${r.facts} claims`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
    await sleep(2500);
  }

  for (const note of NOTES) {
    if (seen.has(note.title.toLowerCase())) { console.log(`skip  ${note.title}`); continue; }
    process.stdout.write(`note  ${note.title} … `);
    try {
      const r = await ingest({ kind: 'text', title: note.title, text: note.text, url: note.url, useLLM: false });
      console.log(`${r.chunks} passages, ${r.entities} entities, ${r.edges} relations, ${r.facts} claims`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM docs) docs,
      (SELECT COUNT(*) FROM entities) entities,
      (SELECT COUNT(*) FROM edges) edges,
      (SELECT COUNT(*) FROM facts WHERE status <> 'rejected') facts`).get();
  console.log('\ncorpus:', counts);
}

main().catch((err) => { console.error(err); process.exit(1); });
