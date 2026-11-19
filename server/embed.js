import { STOPWORDS, normalizeToken, words } from './text.js';

// Fixed-size hashed feature embedding: unigrams + bigrams + char 4-grams.
// Deterministic, dependency-free, and works fully offline. Cosine distance on these
// vectors captures morphological and phrase overlap, which is what the graph needs.
export const DIM = 384;

const FNV_OFFSET = 0x811c9dc5;
function hash32(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function feature(buf, feature, weight) {
  const h = hash32(feature);
  const idx = h % DIM;
  const sign = (h >>> 31) & 1 ? -1 : 1;
  buf[idx] += sign * weight;
}

export function embed(text) {
  const v = new Float32Array(DIM);
  const raw = words(text);
  const toks = [];
  for (const w of raw) {
    const t = normalizeToken(w);
    if (t.length > 1 && !STOPWORDS.has(t)) toks.push(t);
  }
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  for (const [t, n] of tf) {
    feature(v, `w:${t}`, 1 + Math.log(n));
    if (t.length >= 4) {
      const padded = `#${t}#`;
      for (let i = 0; i + 4 <= padded.length; i++) feature(v, `c:${padded.slice(i, i + 4)}`, 0.35);
    }
  }
  for (let i = 0; i + 1 < toks.length; i++) feature(v, `b:${toks[i]}_${toks[i + 1]}`, 0.7);
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function pack(vec) {
  return new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
}

export function unpack(buf) {
  if (!buf) return null;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

// Reciprocal rank fusion — robust way to blend lexical and vector rankings
// whose scores are not on the same scale.
export function rrf(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}
