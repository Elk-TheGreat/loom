import { STOPWORDS, normalizeToken, splitSentences, words } from './text.js';

const CONNECTORS = new Set(['of', 'the', 'de', 'van', 'von', 'der', 'la', 'le', 'du', 'and', 'for', '&', 'al', 'bin', 'ibn']);
const DEMONYMS = new Set(`american british french german english italian european chinese japanese indian russian spanish dutch greek roman latin african asian canadian australian irish scottish welsh swiss swedish norwegian danish polish portuguese brazilian mexican korean egyptian turkish persian arab jewish christian muslim catholic`.split(/\s+/));
const TEMPORAL = new Set(`january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/));
const SENTENCE_STARTERS = new Set(`the this that these those it he she they we i you his her its their our a an in on at by for from with as after before during when while if but and or however although though because since there here what who which how why yes no one two three four five six seven eight nine ten first second third later meanwhile instead still yet thus therefore modern recent early today many most some various several another each both such other new other's`.split(/\s+/));
const PERSON_CUE = /\b(born|died|coined|studied|graduated|argued|authored|wrote|professor|philosopher|scientist|physicist|mathematician|chemist|biologist|poet|novelist|painter|composer|engineer|economist|historian|president|politician|king|queen|emperor|activist|journalist|architect|he|she|his|her)\b/i;

const ORG = /(university|institute|institut|college|school|laborator|company|corporation|corp|inc\b|llc|ltd|foundation|agency|council|association|committee|society|museum|bank|group|club|team|organization|organisation|ministry|department|bureau|court|parliament|congress|academy|project|initiative|consortium|network|alliance|federation|union|party|church|army|navy|airlines)/i;
const PLACE = /\b(city|town|village|country|state|province|county|region|district|island|river|lake|mountain|valley|desert|sea|ocean|bay|peninsula|continent|republic|kingdom|empire|capital|territory|area|province|prefecture|gulf|strait|park|forest|volcano|glacier)\b/i;
const EVENT = /\b(war|battle|treaty|revolution|conference|summit|election|crisis|pandemic|expedition|festival|olympics|movement|rebellion|siege|act of|accord|agreement|protest|strike)\b/i;
const WORK = /\b(novel|book|film|movie|album|song|painting|symphony|poem|essay|play|opera|series|game|software|paper|publication|magazine|journal|newspaper|report|speech|saga|trilogy|documentary|podcast|website|algorithm|language|protocol|framework|standard)\b/i;

const REL_PATTERNS = [
  { rel: 'founded', re: /\[E(\d+)\]\s+(?:co-?)?founded\s+(?:the\s+)?\[E(\d+)\]/i },
  { rel: 'founded', re: /\[E(\d+)\]\s+(?:was|were)\s+(?:co-?)?founded\s+by\s+\[E(\d+)\]/i, flip: true },
  { rel: 'born_in', re: /\[E(\d+)\]\s+(?:was|were|is)?\s*born\s+(?:in|at|near)\s+\[E(\d+)\]/i },
  { rel: 'located_in', re: /\[E(\d+)\]\s+(?:is|was|are|were)?\s*(?:located|situated|based|found|established|headquartered)\s+(?:in|at|on|near)\s+\[E(\d+)\]/i },
  { rel: 'part_of', re: /\[E(\d+)\]\s+(?:is|was|are|were)\s+(?:a\s+|an\s+|the\s+)?(?:part|component|piece|member|branch|division|subsidiary|section|subset|element)\s+of\s+(?:the\s+)?\[E(\d+)\]/i },
  { rel: 'studied_at', re: /\[E(\d+)\]\s+(?:studied|graduated|teaches|taught|lectured)\s+(?:at|from|in)\s+\[E(\d+)\]/i },
  { rel: 'worked_for', re: /\[E(\d+)\]\s+(?:worked|works|served|serves|joined)\s+(?:at|for|as)\s+\[E(\d+)\]/i },
  { rel: 'led', re: /\[E(\d+)\]\s+(?:leads|led|directs|directed|heads|headed|runs|ran|manages|managed|founded\s+and\s+led)\s+(?:the\s+)?\[E(\d+)\]/i },
  { rel: 'created', re: /\[E(\d+)\]\s+(?:developed|develops|created|creates|invented|designs|designed|built|builds|produced|directed|wrote|writes|composed|painted|authored|published|introduced|proposed|formulated|discovered|coined|launched|released|announced|pioneered|patented|established|formed|started|began|drafted)\s+(?:the\s+|a\s+|an\s+)?\[E(\d+)\]/i },
  { rel: 'created', re: /\[E(\d+)\]\s+(?:was|were)\s+(?:developed|created|invented|designed|built|produced|directed|written|composed|painted|authored|published|introduced|proposed|formulated|discovered)\s+by\s+\[E(\d+)\]/i, flip: true },
  { rel: 'influenced', re: /\[E(\d+)\]\s+(?:influenced|inspired|shaped|informed)\s+\[E(\d+)\]/i },
  { rel: 'influenced', re: /\[E(\d+)\]\s+(?:was|were)\s+(?:influenced|inspired|shaped)\s+by\s+\[E(\d+)\]/i, flip: true },
  { rel: 'based_on', re: /\[E(\d+)\]\s+(?:is|was|are|were)?\s*(?:based on|derived from|adapted from|built on|extends|expands)\s+\[E(\d+)\]/i },
  { rel: 'succeeded', re: /\[E(\d+)\]\s+(?:succeeded|replaced|superseded)\s+\[E(\d+)\]/i },
  { rel: 'spouse', re: /\[E(\d+)\]\s+(?:married|divorced)\s+\[E(\d+)\]/i },
  { rel: 'capital_of', re: /\[E(\d+)\]\s+(?:is|was)\s+the\s+capital\s+of\s+\[E(\d+)\]/i },
  { rel: 'uses', re: /\[E(\d+)\]\s+(?:uses|use|utilizes|relies on|depends on|employs|adopts)\s+\[E(\d+)\]/i },
  { rel: 'caused', re: /\[E(\d+)\]\s+(?:caused|led to|triggered|resulted in|sparked)\s+(?:the\s+)?\[E(\d+)\]/i },
  { rel: 'opposed', re: /\[E(\d+)\]\s+(?:opposed|criticized|criticised|attacked|challenged)\s+\[E(\d+)\]/i },
  { rel: 'member_of', re: /\[E(\d+)\]\s+(?:joined|belongs to|is a member of)\s+(?:the\s+)?\[E(\d+)\]/i },
  { rel: 'owns', re: /\[E(\d+)\]\s+(?:owns|acquired|bought)\s+(?:the\s+)?\[E(\d+)\]/i },
];

const DEF_RE = /^(?:(?:a|an|the)\s+)?\[E\d+\]\s+(?:is|was|are|were)\s+(?:an?|the)\s+(.{3,90})$/i;

// Verb cues found *between* two entity mentions, which covers the long sentences
// that the tight [E1] verb [E2] patterns miss.
const GAP_CUES = [
  { rel: 'part_of', re: /\b(?:part of|member of|component of|branch of|division of|subsidiary of|subset of)\b/i },
  { rel: 'located_in', re: /\b(?:located in|based in|headquartered in|situated in|founded in|established in)\b/i },
  { rel: 'worked_for', re: /\b(?:works? (?:at|for)|worked (?:at|for)|employed by|joined|serves? as)\b/i },
  { rel: 'studied_at', re: /\b(?:studied (?:at|from)|graduated from|attended)\b/i },
  { rel: 'led', re: /\b(?:leads?|led|directs?|directed|heads?|headed|runs?|ran|manages?|managed|president of|ceo of)\b/i },
  { rel: 'influenced', re: /\b(?:influenced|inspired|shaped|informed|built upon)\b/i },
  { rel: 'based_on', re: /\b(?:based on|derived from|adapted from|extends|builds on)\b/i },
  { rel: 'uses', re: /\b(?:uses?|utilizes?|relies on|depends on|employs|adopts|integrated)\b/i },
  { rel: 'owns', re: /\b(?:owns?|acquired|bought|purchased)\b/i },
  { rel: 'member_of', re: /\b(?:member of|belongs to)\b/i },
  { rel: 'born_in', re: /\bborn (?:in|at|near)\b/i },
  { rel: 'spouse', re: /\bmarried\b/i },
  { rel: 'succeeded', re: /\b(?:succeeded|replaced|superseded)\b/i },
  { rel: 'caused', re: /\b(?:caused|led to|triggered|resulted in|sparked)\b/i },
  { rel: 'opposed', re: /\b(?:opposed|criticized|criticised|challenged)\b/i },
  { rel: 'created', re: /\b(?:founded|co-?founded|created|developed|invented|designed|built|introduced|launched|released|published|wrote|composed|established|formed|started|produced|coined|proposed|pioneered|announced|patented|released)\b/i },
];
const PASSIVE_RE = /\b(?:was|were|is|are|has been|have been)\s+(\w+ed|built|made|written|run|led|known)\s+by\b/i;

const PREPOSITIONS = new Set(['in','on','at','by','for','from','with','of','to','and','or','but','as','during','after','before','since','including','according','however','although','while','when','where','which','that','this','these','those','its','their','his','her','between','through','under','over','into','onto','than','then','there','here','also','both','such','many','most','some','all','any','each','other','another','more','less','very','only','just','not','no','yes','it','they','we','you','he','she']);
const NOISE_WORDS = new Set(['history','introduction','overview','background','contents','references','summary','conclusion','examples','example','see','further','reading','external','links','notes','sources','bibliography','gallery','early','modern','recent','today','meanwhile','however','although','instead','notably','generally','usually','specifically','addition','contrast','general','main','other','various','similar','different','following','above','below','left','right','first','second','third','last','next']);

function keyOf(name) {
  return name
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[“”"()[\]{}]/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
}

function isAcronym(s) {
  return /^[A-Z0-9&.\-]{2,8}$/.test(s) && /[A-Z]/.test(s) && !/^[A-Z][a-z]/.test(s);
}

// Group capitalised token runs (allowing lowercase connectors) into candidate spans.
function candidateSpans(sentence, titlePhrase = '') {
  const toks = [...sentence.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu)].map((m) => ({
    text: m[0], start: m.index, end: m.index + m[0].length,
  }));
  const spans = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    const cap = /^\p{Lu}/u.test(t.text) || isAcronym(t.text);
    if (!cap) { i++; continue; }
    let j = i;
    let last = i;
    while (j + 1 < toks.length) {
      const next = toks[j + 1];
      const gap = sentence.slice(toks[j].end, next.start);
      if (gap.trim() !== '' && !/^[\s-]+$/.test(gap)) break;
      const ncap = /^\p{Lu}/u.test(next.text) || isAcronym(next.text);
      const nconn = CONNECTORS.has(next.text.toLowerCase());
      if (ncap) { j++; last = j; continue; }
      if (nconn && j + 2 < toks.length && (/^\p{Lu}/u.test(toks[j + 2].text) || isAcronym(toks[j + 2].text))) {
        j += 2; last = j; continue;
      }
      break;
    }
    const text = sentence.slice(t.start, toks[last].end).replace(/[.,;:]+$/, '');
    spans.push({ text, start: t.start, end: toks[last].end });
    i = last + 1;
  }

  // The document's own subject appears mid-sentence in lowercase far more often
  // than not ("A knowledge graph is ..."), so match the title phrase by case too.
  if (titlePhrase) {
    const esc = titlePhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of sentence.matchAll(re)) {
      spans.push({ text: m[0], start: m.index, end: m.index + m[0].length, canonical: true });
    }
  }

  // Drop overlaps, preferring the canonical title match and the longer span.
  spans.sort((a, b) => Number(b.canonical) - Number(a.canonical) || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const sp of spans) {
    if (kept.some((k) => sp.start < k.end && k.start < sp.end)) continue;
    kept.push(sp);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function cleanName(raw) {
  let s = raw.replace(/^[\s"'“”(\[]+/, '').replace(/[\s"'“”),;:.]+$/, '');
  s = s.replace(/^The\s+(?=\p{Lu})/u, '');
  s = s.replace(/’s$|'s$/, '');
  return s.trim();
}

const PERSON_ROLE = /\b(philosopher|scientist|physicist|mathematician|chemist|biologist|economist|historian|professor|poet|novelist|writer|author|painter|composer|architect|engineer|politician|president|prime minister|king|queen|emperor|activist|journalist|entrepreneur|inventor)\b/i;
const PERSON_VERB = /^(?:was\s+|is\s+)?(?:born|died|studied|graduated|coined|argued|wrote|taught|served|received|won|became|emigrated|lectured)\b/i;
const ORG_CUE = /\b(company|firm|startup|corporation|acquired|launched|released|unveiled|announced|introduced|headquartered|subsidiary|ceo)\b/i;

export function inferType(name, context = '') {
  if (ORG.test(name)) return 'organization';
  if (PLACE.test(name)) return 'place';
  if (WORK.test(name)) return 'work';
  if (EVENT.test(name)) return 'event';
  const multi = /^\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,3}$/u.test(name);
  if (multi) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const after = new RegExp(`(?:^|\\W)${esc}\\s+(?:was\\s+|is\\s+|were\\s+)?([a-z]+)`, 'i').exec(context);
    const verb = after ? `${after[1]} ` : '';
    if (PERSON_VERB.test(verb) || (PERSON_ROLE.test(context) && /\b(he|she|his|her|who)\b/i.test(context))) return 'person';
  }
  if (ORG.test(context) && /\b(founded|company|firm|research|institute|laboratory)\b/i.test(context)) return 'organization';
  if (ORG_CUE.test(context) && (multi || /^[\p{Lu}][\p{L}\d.&-]+$/u.test(name))) return 'organization';
  return 'concept';
}

/**
 * Extract entities, relations and fact candidates from a document.
 * @param {string} text
 * @param {{title?: string}} [opts]
 */
export function extract(text, opts = {}) {
  const title = typeof opts === 'string' ? opts : (opts.title || '');
  const titlePhrase = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const titleTokens = words(titlePhrase);
  const sentences = splitSentences(text);

  // Pass 1: collect spans and count capitalisation away from sentence start.
  const stats = new Map(); // key -> {name, count, midCount, subjectCount, sentences, variants}
  sentences.forEach((s, si) => {
    const spans = candidateSpans(s, titlePhrase);
    const multi = spans.length > 1;
    for (const span of spans) {
      const name = cleanName(span.text);
      if (!name) continue;
      const key = keyOf(name);
      if (!key || key.length < 2) continue;
      const rec = stats.get(key) || { name, count: 0, midCount: 0, subjectCount: 0, verbCue: 0, sentences: new Set(), variants: new Map() };
      rec.count++;
      if (span.start > 1) rec.midCount++;
      if (span.start <= 1 && multi) rec.subjectCount++;
      if (span.start <= 1 && /^\s+(?:\p{L}+ed|\p{L}+d|founded|led|built|wrote|made|runs|owns|acquired|launched|released|sued|won|lost)\b/iu.test(s.slice(span.end))) rec.verbCue++;
      rec.sentences.add(si);
      const vcount = rec.variants.get(name) || 0;
      rec.variants.set(name, vcount + 1);
      if (!stats.has(key)) stats.set(key, rec);
    }
  });

  const accepted = new Map(); // key -> {name, count, sentences, type, description}
  for (const [key, rec] of stats) {
    const name = [...rec.variants.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const parts = name.split(/\s+/);
    if (DEMONYMS.has(key) || TEMPORAL.has(key)) continue;
    if (parts.length > 5) continue;
    if (PREPOSITIONS.has(parts[0].toLowerCase())) continue;
    if (/\s(?:and|or|&)\s/i.test(name)) continue;
    if (parts.length === 1 && NOISE_WORDS.has(key)) continue;
    if (parts.length === 1) {
      const low = key;
      if (STOPWORDS.has(low) || SENTENCE_STARTERS.has(low)) continue;
      if (low.length < 3) continue;
      const acronym = isAcronym(name);
      const isSubject = rec.subjectCount > 0 || rec.verbCue > 0;
      if (!acronym && rec.midCount === 0 && !isSubject && !titleTokens.includes(low)) continue;
    } else {
      // multiword: reject pure sentence-starter phrases like "However The"
      if (parts.every((p) => SENTENCE_STARTERS.has(p.toLowerCase()))) continue;
      if (name.length > 70) continue;
    }
    // A mention that happens once and carries no type signal is usually a
    // section heading or a stray capital, not a thing worth remembering.
    const typed = ORG.test(name) || PLACE.test(name) || WORK.test(name) || EVENT.test(name);
    if (rec.count < 2 && !typed && !isAcronym(name) && !titleTokens.some((t) => key.includes(t))) continue;
    accepted.set(key, {
      key, name, count: rec.count,
      sentenceCount: rec.sentences.size,
      sentences: rec.sentences,
      type: 'concept',
    });
  }

  // Pass 2: type inference + descriptions from the first defining sentence.
  const keyBySentence = new Map();
  sentences.forEach((s, si) => {
    const spans = candidateSpans(s, titlePhrase).map((sp) => {
      const name = cleanName(sp.text);
      const key = keyOf(name);
      return accepted.has(key) ? { ...sp, key, name: accepted.get(key).name } : null;
    }).filter(Boolean)
      .sort((a, b) => a.start - b.start);

    const uniq = [];
    for (const sp of spans) if (!uniq.some((u) => u.key === sp.key)) uniq.push(sp);
    if (uniq.length) keyBySentence.set(si, uniq);

    for (const sp of uniq) {
      const ent = accepted.get(sp.key);
      const others = uniq.filter((u) => u.key !== sp.key).map((u) => u.name).join(' ');
      const guess = inferType(ent.name, `${s} ${others}`);
      const rank = { person: 4, organization: 3, place: 3, work: 3, event: 3, concept: 1 };
      if ((rank[guess] || 0) > (rank[ent.type] || 0)) ent.type = guess;
    }
  });

  // Descriptions: "X is a ..." for each entity, first clean hit wins.
  for (const [si, spans] of [...keyBySentence].sort((a, b) => a[0] - b[0])) {
    const sentence = sentences[si];
    const skeleton = buildSkeleton(sentence, spans);
    const m = DEF_RE.exec(skeleton);
    if (!m) continue;
    const target = spans.length ? accepted.get(spans[0].key) : null;
    if (!target || target.description) continue;
    const raw = m[1].replace(/\[E(\d+)\]/g, (_, n) => spans[Number(n) - 1]?.name || '');
    const desc = raw.replace(/\s+/g, ' ').trim().replace(/[,;.]$/, '');
    if (words(desc).length >= 2 && !/^(part|member|one of the parts|a part|an element) of\b/i.test(desc)) {
      target.description = desc.charAt(0).toUpperCase() + desc.slice(1);
    }
  }

  // Pass 3: relations from sentence skeletons.
  const edges = [];
  const facts = [];
  const edgeSeen = new Map();

  for (const [si, spans] of keyBySentence) {
    const sentence = sentences[si];
    const skeleton = buildSkeleton(sentence, spans);
    const addEdge = (a, b, rel, weight = 1) => {
      if (!a || !b || a === b) return;
      const k = `${a}|${b}|${rel}`;
      const prev = edgeSeen.get(k);
      if (prev) { prev.weight += weight; return; }
      const e = { srcKey: a, dstKey: b, rel, weight, sentence: sentence.slice(0, 240) };
      edgeSeen.set(k, e);
      edges.push(e);
    };

    for (const p of REL_PATTERNS) {
      const re = new RegExp(p.re.source, 'gi');
      let m;
      while ((m = re.exec(skeleton))) {
        const a = spans[Number(m[1]) - 1];
        const b = spans[Number(m[2]) - 1];
        if (!a || !b) continue;
        addEdge(p.flip ? b.key : a.key, p.flip ? a.key : b.key, p.rel, 1);
      }
    }

    // Gap pass: verb cues anywhere between two nearby mentions.
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < Math.min(i + 3, spans.length); j++) {
        const a = spans[i];
        const b = spans[j];
        if (!a || !b || a.key === b.key) continue;
        const gap = sentence.slice(a.end, b.start);
        if (!gap || gap.length > 180) continue;
        let matched = false;
        const passive = PASSIVE_RE.exec(gap);
        if (passive) {
          addEdge(b.key, a.key, 'created', 0.9);
          matched = true;
        }
        for (const cue of GAP_CUES) {
          if (!cue.re.test(gap)) continue;
          addEdge(a.key, b.key, cue.rel, 0.8);
          matched = true;
        }
        if (matched) break;
      }
    }

    // Definitional "is a" relations where the object is unambiguous
    const isA = /\[E(\d+)\]\s+(?:is|was|are|were)\s+(?:an?|the)\s+\[E(\d+)\]/i.exec(skeleton);
    if (isA) {
      const a = spans[Number(isA[1]) - 1];
      const b = spans[Number(isA[2]) - 1];
      if (a && b) addEdge(a.key, b.key, 'is_a', 2);
    }

    const def = DEF_RE.exec(skeleton);
    if (def) {
      const sp = spans[0];
      const raw = def[1].replace(/\[E(\d+)\]/g, (_, n) => spans[Number(n) - 1]?.name || '').trim();
      const relational = /^(?:part|member|component|piece|branch|division|section|element|subset)\s+of\b/i.test(raw)
        || spans.length > 2;
      if (sp && !relational) {
        facts.push({ subjectKey: sp.key, predicate: 'is_a', object: raw.slice(0, 90), objectKey: null, snippet: sentence.slice(0, 260) });
      }
    }
    const born = /\[E(\d+)\]\s+(?:was|were)\s+born\s+(?:in|on)\s+(\d{4})/i.exec(skeleton);
    if (born) {
      const sp = spans[Number(born[1]) - 1];
      if (sp) facts.push({ subjectKey: sp.key, predicate: 'born', object: born[2], objectKey: null, snippet: sentence.slice(0, 260) });
    }
  }

  // Co-occurrence backbone keeps the graph connected where verbs are sparse.
  const relatedCount = new Map();
  for (const e of edges) {
    if (e.rel !== 'related_to') continue;
    relatedCount.set(e.srcKey, (relatedCount.get(e.srcKey) || 0) + 1);
    relatedCount.set(e.dstKey, (relatedCount.get(e.dstKey) || 0) + 1);
  }
  for (const [si, spans] of keyBySentence) {
    const top = spans.slice(0, 5);
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        if ((relatedCount.get(top[i].key) || 0) >= 4 || (relatedCount.get(top[j].key) || 0) >= 4) continue;
        const k = `${top[i].key}|${top[j].key}|related_to`;
        if (edgeSeen.has(k)) continue;
        relatedCount.set(top[i].key, (relatedCount.get(top[i].key) || 0) + 1);
        relatedCount.set(top[j].key, (relatedCount.get(top[j].key) || 0) + 1);
        const e = { srcKey: top[i].key, dstKey: top[j].key, rel: 'related_to', weight: 0.35, sentence: sentences[si].slice(0, 200) };
        edgeSeen.set(k, e);
        edges.push(e);
      }
    }
  }

  const entities = [...accepted.values()].sort((a, b) => b.count - a.count).map((e) => ({
    key: e.key,
    name: e.name,
    type: e.type,
    description: e.description || null,
    mentions: e.count,
    docMentions: e.count,
    sentenceCount: e.sentenceCount,
  }));

  return { entities, edges, facts };
}

function buildSkeleton(sentence, spans) {
  let out = '';
  let pos = 0;
  spans.forEach((sp, i) => {
    if (sp.start < pos) return;
    out += sentence.slice(pos, sp.start);
    out += `[E${i + 1}]`;
    pos = sp.end;
  });
  out += sentence.slice(pos);
  return out;
}

export { keyOf };
