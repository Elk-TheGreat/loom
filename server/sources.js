// Wikipedia and web ingestion. Wikipedia uses the public action API (no key),
// and requests a descriptive User-Agent as the Wikimedia policy asks.

import { htmlToText, titleFromHtml, hostOf, splitSentences } from './text.js';

const UA = 'Loom/1.0 (personal knowledge OS; local single-user instance)';

async function getJson(url, timeout = 15_000) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Upstream returned ${res.status} for ${new URL(url).host}`);
  return res.json();
}

export async function wikiSearch(q, limit = 8) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query', list: 'search', srsearch: q, srlimit: String(limit),
    format: 'json', origin: '*', srprop: 'snippet|wordcount|timestamp',
  });
  const data = await getJson(url);
  return (data.query?.search || []).map((r) => ({
    title: r.title,
    snippet: r.snippet.replace(/<[^>]+>/g, ''),
    words: r.wordcount,
    updated: r.timestamp,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
  }));
}

export async function wikiPage(title) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query', prop: 'extracts|pageprops|info|categories', explaintext: '1',
    redirects: '1', titles: title, format: 'json', inprop: 'url', cllimit: '20',
  });
  const data = await getJson(url);
  const page = Object.values(data.query?.pages || {})[0];
  if (!page || page.missing !== undefined) throw new Error(`Wikipedia has no article named "${title}"`);
  const text = page.extract || '';
  if (text.length < 200) throw new Error(`Wikipedia article "${page.title}" is too short to index`);
  return {
    title: page.title,
    url: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    text,
    domain: 'en.wikipedia.org',
    kind: 'wikipedia',
    trust: 0.85,
    categories: (page.categories || []).map((c) => c.title.replace(/^Category:/, '')),
    retrievedAt: new Date().toISOString(),
  };
}

export function trustForDomain(domain) {
  if (!domain) return 0.5;
  if (/(^|\.)(gov|mil)$/.test(domain)) return 0.9;
  if (/(^|\.)edu$/.test(domain)) return 0.85;
  if (domain === 'en.wikipedia.org' || domain === 'wikipedia.org') return 0.85;
  if (/(^|\.)(nature\.com|science\.org|arxiv\.org|acm\.org|ieee\.org|nih\.gov|who\.int|europa\.eu)$/.test(domain)) return 0.9;
  if (/(^|\.)(nytimes\.com|bbc\.co\.uk|bbc\.com|reuters\.com|apnews\.com|theguardian\.com|economist\.com|ft\.com)$/.test(domain)) return 0.8;
  if (/(^|\.)(medium\.com|substack\.com|reddit\.com|quora\.com|x\.com|twitter\.com|facebook\.com|tiktok\.com|youtube\.com)$/.test(domain)) return 0.35;
  return 0.55;
}

export async function fetchPage(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('That does not look like a valid URL'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http and https URLs can be indexed');
  if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[::1\])/.test(url.hostname)) {
    throw new Error('Refusing to fetch private network addresses');
  }

  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The site returned HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/html|text\/plain|xml/.test(type)) throw new Error(`Unsupported content type: ${type.split(';')[0]}`);

  const reader = res.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    while (size < 4_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const html = Buffer.concat(chunks).toString('utf8');
  return parseHtml(html, res.url || url.toString());
}

// Kept separate from the network call so it can be unit tested.
export function parseHtml(html, finalUrl) {
  const title = titleFromHtml(html) || new URL(finalUrl).pathname.replace(/\/$/, '').split('/').pop() || finalUrl;
  // Prefer the semantic main region when the page has one.
  const main = /<article\b[\s\S]*?<\/article>/i.exec(html)?.[0]
    || /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0]
    || html;
  let text = htmlToText(main);
  if (text.length < 400) text = htmlToText(html);
  if (text.length < 200) throw new Error('Could not find readable text on that page');
  const first = splitSentences(text).slice(0, 3).join(' ');
  return {
    title: title.replace(/\s*[|·—–-]\s*[^|·—–-]{0,40}$/, '').trim().slice(0, 160) || 'Untitled page',
    text: text.slice(0, 200_000),
    url: finalUrl,
    domain: hostOf(finalUrl),
    kind: 'web',
    summary: first.slice(0, 400),
    trust: trustForDomain(hostOf(finalUrl)),
    retrievedAt: new Date().toISOString(),
  };
}
