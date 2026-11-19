import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.LOOM_DB || resolve(ROOT, 'data/loom.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS docs (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  url           TEXT,
  kind          TEXT NOT NULL DEFAULT 'note',
  domain        TEXT,
  summary       TEXT,
  content       TEXT NOT NULL,
  word_count    INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL,
  published_at  TEXT,
  retrieved_at  TEXT NOT NULL,
  trust         REAL NOT NULL DEFAULT 0.6,
  status        TEXT NOT NULL DEFAULT 'ready'
);
CREATE UNIQUE INDEX IF NOT EXISTS docs_hash ON docs(content_hash);

CREATE TABLE IF NOT EXISTS chunks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id    TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  text      TEXT NOT NULL,
  heading   TEXT,
  tokens    INTEGER NOT NULL DEFAULT 0,
  vec       BLOB,
  UNIQUE(doc_id, idx)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  text, heading, content='chunks', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text, heading) VALUES('delete', old.id, old.text, old.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text, heading) VALUES('delete', old.id, old.text, old.heading);
  INSERT INTO chunk_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;

CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'concept',
  description TEXT,
  salience    REAL NOT NULL DEFAULT 0,
  mentions    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_entities (
  doc_id    TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (doc_id, entity_id)
);
CREATE INDEX IF NOT EXISTS doc_entities_entity ON doc_entities(entity_id);

CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  src         INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst         INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  rel         TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1,
  doc_ids     TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(src, dst, rel)
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS facts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id    INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate     TEXT NOT NULL,
  object        TEXT NOT NULL,
  object_id     INTEGER,
  doc_id        TEXT REFERENCES docs(id) ON DELETE CASCADE,
  snippet       TEXT,
  confidence    REAL NOT NULL DEFAULT 0.5,
  supports      INTEGER NOT NULL DEFAULT 1,
  sources       TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  UNIQUE(subject_id, predicate, object)
);
CREATE INDEX IF NOT EXISTS facts_subject ON facts(subject_id);
CREATE INDEX IF NOT EXISTS facts_status ON facts(status);

CREATE TABLE IF NOT EXISTS memory_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id INTEGER REFERENCES facts(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  detail  TEXT,
  at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'queued',
  steps      TEXT NOT NULL DEFAULT '[]',
  result     TEXT,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts     TEXT NOT NULL,
  level  TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db;
export function getDb() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  return db;
}

export function initDb() {
  return getDb();
}

export function closeDb() {
  if (db) { db.close(); db = undefined; }
}

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  getDb().prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export { ROOT };
