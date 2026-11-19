# Loom — a personal knowledge OS

Loom ingests documents, extracts the people, organizations, places, works and
concepts they talk about, links them into a knowledge graph, and answers
questions from that corpus with citations. Every claim it stores is scored by
how much independent, trustworthy evidence stands behind it, so you can see
what is verified, what rests on a single source, and what contradicts
something else.

It runs as one Node process with **no npm dependencies**: storage is SQLite
(built into Node), embeddings are computed locally, and the UI is plain ES
modules on a canvas.

## Quick start

Requires Node 22.5+ (uses the built-in `node:sqlite`).

```bash
npm start          # http://127.0.0.1:4321
```

First run: open **Sources**, paste a link, a Wikipedia title, or a note, and
press *Index*. Or seed a starter corpus:

```bash
npm run seed       # 8 Wikipedia articles + 3 personal notes
```

Then explore **Graph** (force layout, filter by type, click a node for its
neighbourhood and claims), **Library** (documents, passages, extracted claims),
**Memory** (every claim with its evidence and controls to confirm or reject),
**Ask** (retrieval-grounded answers with `[n]` citations) and ⌘K for search
across passages, entities and documents.

## What the pipeline does

1. **Resolve** — fetch a URL or Wikipedia page (15s timeout, 200k character
   cap, HTML→text with title extraction), or take a note.
2. **Chunk** — paragraph-aware passages (~900 chars, 120 overlap) indexed in
   SQLite FTS5 with BM25.
3. **Embed** — deterministic 384-dimension hashed feature vectors, stored as
   BLOBs. No model download, no network, identical on every run.
4. **Extract** — a regex/heuristic parser finds entity spans, types them from
   local cues (roles, suffixes, known organizations), and reads relations from
   sentence skeletons: active and passive voice, appositions, list
   conjunctions and "is a" definitions. A local LLM can refine this if one is
   reachable.
5. **Verify** — a claim is stored per (subject, predicate, object) with its
   supporting documents. Confidence grows with independent sources and domain
   trust, decays with age (180-day half-life), and drops when a functional
   predicate (born in, founded, located in…) has a conflicting object.
6. **Retrieve** — hybrid search fuses BM25 and vector ranks with reciprocal
   rank fusion; `ask` answers extractively from the best sentences, or through
   a local model when one is configured.

## Claim statuses

| Status | Meaning |
| --- | --- |
| `verified` | two or more independent domains, high confidence |
| `supported` | corroborated or from a trusted source, not yet independent |
| `single-source` | one document only |
| `contested` | a functional predicate with a conflicting object in another source |
| `rejected` | you rejected it (kept out of answers and the graph score) |

## API

All endpoints return JSON. Ingestion is asynchronous: `POST /api/ingest`
returns `202 {jobId}`, and progress streams as SSE from
`/api/jobs/:id/events` (or poll `/api/jobs/:id`).

```
GET  /api/health            GET  /api/stats        GET  /api/insights
GET  /api/graph?limit&focus GET  /api/search?q=    GET  /api/docs
GET  /api/docs/:id          GET  /api/memory?status&limit
GET  /api/entity/:id        GET  /api/export       GET  /api/memory/export
POST /api/ask               POST /api/wiki/search  POST /api/ingest
POST /api/memory/reinforce  POST /api/memory/status
DELETE /api/docs/:id
```

`GET /api/memory/export` returns the whole memory as Markdown, one claim per
line with its sources — the escape hatch from the app.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4321` | HTTP port |
| `HOST` | `127.0.0.1` | bind address |
| `LOOM_DB` | `data/loom.db` | SQLite file |
| `LOOM_LLM_URL` | `http://127.0.0.1:11434` | Ollama-compatible endpoint |
| `LOOM_LLM_MODEL` | `llama3.1` | model for extraction and answers |

The LLM is optional. With nothing listening, extraction uses the local parser
and `ask` answers extractively; `/api/health` reports which mode is live.

## Tests

```bash
npm test           # node --test
```

24 tests cover text and chunking, embeddings, extraction direction and typing,
confidence scoring, the ingest/search/graph/memory/ask pipeline on a throwaway
database, and an HTTP smoke test of the API including malformed input and
deletion.

## Layout

```
server/    db, text, embed, extract, llm, sources, verify, ingest, query, node
public/    index.html, css/app.css, js/{app,api,ui,graph}.js, js/views/*
scripts/   seed.js
test/      engine.test.js, api.test.js
data/      loom.db (gitignored)
```

## Known limits

- Entity typing and relation reading are heuristics. Expect some noisy claims
  in long encyclopedic pages (reversed passives and list fragments are the
  usual offenders); that is why claims carry evidence and can be rejected.
- Contradiction detection covers only functional predicates.
- Note URLs count as a distinct source domain, so a note citing the page it
  summarises can corroborate it; that is deliberate, not a trust bypass — the
  note's own text still has to make the same claim.
- Single-user, no authentication, no TLS. Bind to `127.0.0.1` unless you put
  it behind your own auth proxy.
