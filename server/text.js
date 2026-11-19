import { createHash } from 'node:crypto';

export const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also may many much often one two first new used using use within without among across however thus therefore although though upon whose being made make makes became become becomes known called such including include includes based like unlike due toward towards per via several various around still yet even ever never always usually generally typically particularly especially notably largely mainly partly widely`.split(/\s+/));

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

export function words(text) {
  return text.match(WORD_RE) || [];
}

export function normalizeToken(w) {
  return w.toLowerCase().replace(/[’']s$/, '').replace(/[’']/g, '');
}

export function tokenize(text) {
  return words(text).map(normalizeToken).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export function termFreq(text) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

export function splitSentences(text) {
  const out = [];
  const cleaned = text.replace(/\s+/g, ' ').trim();
  // Split on sentence enders followed by a capital/quote/digit, avoiding common abbreviations.
  const re = /[.!?]+["')\]]*\s+(?=[A-Z0-9"'(\[])|\n+/g;
  let start = 0;
  let m;
  while ((m = re.exec(cleaned))) {
    const end = m.index + m[0].length;
    const s = cleaned.slice(start, end).trim();
    if (s) out.push(s);
    start = end;
  }
  const tail = cleaned.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter((s) => words(s).length > 2);
}

export function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

export function chunkText(text, { target = 900, overlap = 120, max = 1400 } = {}) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  let heading = null;

  const flush = () => {
    const body = buf.trim();
    if (!body) return;
    if (body.length <= max) {
      chunks.push({ text: body, heading });
    } else {
      for (const part of hardSplit(body, target, overlap)) chunks.push({ text: part, heading });
    }
    buf = '';
  };

  for (const para of paragraphs) {
    const h = /^#{1,6}\s+(.+)$/.exec(para);
    if (h) { flush(); heading = h[1].trim(); buf = `${h[1]}. `; continue; }
    if (buf.length + para.length + 2 > target && buf.length > 200) flush();
    buf += (buf ? '\n\n' : '') + para;
    if (buf.length > max) flush();
  }
  flush();
  return chunks;
}

function hardSplit(text, target, overlap) {
  const sents = splitSentences(text);
  const out = [];
  let buf = [];
  let len = 0;
  for (const s of sents) {
    buf.push(s); len += s.length + 1;
    if (len >= target) {
      out.push(buf.join(' '));
      // keep the tail sentences as overlap context
      const keep = [];
      let klen = 0;
      for (let i = buf.length - 1; i >= 0 && klen < overlap; i--) { keep.unshift(buf[i]); klen += buf[i].length + 1; }
      buf = keep.length < buf.length ? keep : [];
      len = klen;
    }
  }
  if (len > 40) out.push(buf.join(' '));
  return out;
}

export function summarize(text, maxSentences = 3) {
  const sents = splitSentences(text).slice(0, 60);
  if (!sents.length) return '';
  const df = new Map();
  const tfs = sents.map((s) => {
    const tf = termFreq(s);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });
  const scored = sents.map((s, i) => {
    const tf = tfs[i];
    let score = 0;
    for (const [t, n] of tf) {
      const idf = Math.log(1 + sents.length / (df.get(t) || 1));
      score += (1 + Math.log(n)) * idf;
    }
    score /= Math.sqrt(words(s).length || 1);
    score *= i === 0 ? 1.35 : 1;          // lead bias
    score *= 1 - Math.min(i, 12) * 0.02;  // mild position decay
    return { s, i, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, maxSentences)
    .sort((a, b) => a.i - b.i).map((x) => x.s).join(' ');
}

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', deg: '°', times: '×' };
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e] !== undefined ? named[e] : m;
  });
}

export function htmlToText(html) {
  const drop = /<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let s = html.replace(drop, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n');
  s = s.replace(/<h([1-6])[^>]*>/gi, (m, n) => `\n\n${'#'.repeat(Number(n))} `);
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function titleFromHtml(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html);
  if (og) return decodeEntities(og[1]).trim();
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t ? decodeEntities(t[1]).replace(/\s+/g, ' ').trim() : null;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

export function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

export function titleCase(s) {
  return s.replace(/\b[\p{L}]/gu, (c) => c.toUpperCase());
}
