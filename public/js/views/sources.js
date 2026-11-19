import { api, ingestStream, relTime, shortNum } from '../api.js';
import { el, toast, spinner, debounce, ICON, svg, emptyState } from '../ui.js';

export async function renderSources(root) {
  const page = el('div', { class: 'page page-wide' });
  root.append(page);

  page.append(el('div', { class: 'page-head' },
    el('div', {},
      el('div', { class: 'eyebrow', text: 'Ingestion' }),
      el('h1', { text: 'Add to the weave' }),
      el('p', { text: 'Paste a note, point at a page, or pull an article from Wikipedia. Loom chunks it, embeds it, extracts entities and relations, and reconciles the claims with what it already knows.' }))));

  const grid = el('div', { class: 'source-grid' });
  page.append(grid);

  /* ------------------------------------------------------------ composer */

  const tabs = ['Note', 'Link', 'Wikipedia'];
  let tab = 'Note';
  const segmented = el('div', { class: 'segmented' },
    tabs.map((t) => el('button', { type: 'button', text: t, class: t === tab ? 'active' : '', onclick: () => setTab(t) })));

  const pane = el('div');
  const panel = el('section', { class: 'panel' },
    el('div', { class: 'panel-head' }, svg(ICON.plus), el('h2', { text: 'New source' })),
    el('div', { class: 'panel-body' }, segmented, pane));
  grid.append(panel);

  const streamHost = el('div', { class: 'job-stream' });
  const recentHost = el('div', {});
  const side = el('div', { style: 'display:flex;flex-direction:column;gap:18px' },
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', { text: 'Pipeline' }), el('span', { class: 'mono faint', style: 'font-size:9.5px;margin-left:auto', text: 'live' })),
      el('div', { class: 'panel-body' }, streamHost)),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', { text: 'Recently ingested' })),
      el('div', { class: 'panel-body', style: 'padding-top:6px' }, recentHost)),
  );
  grid.append(side);

  streamHost.append(el('div', { class: 'job-step', style: 'color:var(--faint)' }, el('span', { class: 'tick', text: '·' }), el('span', { text: 'Idle. Steps appear here as a source is processed.' })));

  /* ---------------------------------------------------------------- note */

  const noteTitle = el('input', { class: 'input', placeholder: 'Title' });
  const noteText = el('textarea', { class: 'textarea', placeholder: 'Paste text, meeting notes, a book excerpt…' });
  const noteUseLLM = checkbox('Use local model to refine extraction', true);
  const noteBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => submit({ kind: 'text', title: noteTitle.value.trim() || 'Untitled note', text: noteText.value }) }, 'Index note');

  /* ---------------------------------------------------------------- link */

  const linkUrl = el('input', { class: 'input', placeholder: 'https://example.com/article', type: 'url' });
  const linkTitle = el('input', { class: 'input', placeholder: 'Title (optional — taken from the page)' });
  const linkBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => submit({ kind: 'url', url: linkUrl.value.trim(), title: linkTitle.value.trim() || undefined }) }, 'Fetch and index');

  /* ----------------------------------------------------------- wikipedia */

  const wikiQ = el('input', { class: 'input', placeholder: 'Search Wikipedia…' });
  const wikiResults = el('div', { class: 'wiki-results' });
  wikiResults.append(el('div', { class: 'job-step', style: 'color:var(--faint)' }, el('span', { text: 'Type a topic to search the live Wikipedia index.' })));

  const runWikiSearch = debounce(async () => {
    const q = wikiQ.value.trim();
    if (q.length < 2) return;
    wikiResults.replaceChildren(el('div', { class: 'job-step' }, spinner(), el('span', { text: 'Searching Wikipedia…' })));
    try {
      const { results } = await api.wikiSearch(q);
      if (!results.length) {
        wikiResults.replaceChildren(el('div', { class: 'job-step' }, el('span', { text: 'No articles found.' })));
        return;
      }
      wikiResults.replaceChildren(...results.map((r) => el('div', { class: 'wiki-row' },
        el('div', { style: 'min-width:0' },
          el('div', { class: 'wr-title', text: r.title }),
          el('div', { class: 'wr-snip', text: r.snippet || '' })),
        el('button', {
          class: 'btn small wr-add', type: 'button', text: 'Index',
          onclick: (e) => { e.currentTarget.disabled = true; submit({ kind: 'wikipedia', title: r.title }); },
        }))));
    } catch (err) {
      wikiResults.replaceChildren(el('div', { class: 'job-step error' }, el('span', { text: err.message })));
    }
  }, 380);
  wikiQ.addEventListener('input', runWikiSearch);

  function setTab(next) {
    tab = next;
    [...segmented.children].forEach((b) => b.classList.toggle('active', b.textContent === next));
    if (next === 'Note') {
      pane.replaceChildren(el('div', { style: 'display:flex;flex-direction:column;gap:14px' },
        field('Title', noteTitle), field('Content', noteText), noteUseLLM, el('div', { style: 'display:flex;justify-content:flex-end' }, noteBtn)));
    } else if (next === 'Link') {
      pane.replaceChildren(el('div', { style: 'display:flex;flex-direction:column;gap:14px' },
        field('URL', linkUrl), field('Title', linkTitle),
        el('p', { class: 'mono faint', style: 'font-size:9.5px;line-height:1.6;letter-spacing:.04em', text: 'HTML is reduced to readable text. Paywalls and script-only pages will come back thin.' }),
        el('div', { style: 'display:flex;justify-content:flex-end' }, linkBtn)));
    } else {
      pane.replaceChildren(el('div', { style: 'display:flex;flex-direction:column;gap:14px' },
        field('Article', wikiQ), wikiResults));
    }
  }

  function field(label, control) {
    return el('div', { class: 'field' }, el('label', { text: label }), control);
  }

  function checkbox(label, checked) {
    const box = el('input', { type: 'checkbox', checked });
    return el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);cursor:pointer' }, box, el('span', { text: label }));
  }

  /* ------------------------------------------------------------- submit */

  let busy = false;
  async function submit(payload) {
    if (busy) return;
    if (payload.kind === 'text' && !payload.text.trim()) return toast('There is nothing to index yet');
    if (payload.kind === 'url' && !payload.url) return toast('A URL is required');
    busy = true;
    streamHost.replaceChildren();
    const label = payload.title || payload.url || 'Source';
    addStep('resolve', `Queued: ${label}`);
    const started = Date.now();
    try {
      const res = await ingestStream(payload, (step) => addStep(step.level || 'info', step.message));
      const r = res.result || {};
      addStep('success', `Indexed “${r.title || label}” — ${r.chunks ?? 0} passages, ${r.entities ?? 0} entities, ${r.edges ?? 0} relations, ${r.facts ?? 0} claims${r.duplicate ? ' (already known)' : ''}`);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      addStep('success', `Done in ${secs}s`);
      toast(r.duplicate ? 'Already in your library' : 'Source indexed', 'success');
      if (payload.kind === 'text') { noteText.value = ''; noteTitle.value = ''; }
      if (payload.kind === 'url') { linkUrl.value = ''; linkTitle.value = ''; }
      loadRecent();
    } catch (err) {
      addStep('error', err.message);
      toast(err.message, 'error');
    } finally {
      busy = false;
    }
  }

  function addStep(level, text) {
    const tick = level === 'error' ? '!' : level === 'success' ? '✓' : '·';
    streamHost.append(el('div', { class: `job-step ${level}` },
      el('span', { class: 'tick', text: tick }),
      el('span', { text }),
      el('span', { class: 'job-time', text: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })));
    streamHost.scrollTop = streamHost.scrollHeight;
  }

  async function loadRecent() {
    try {
      const { docs } = await api.docs();
      recentHost.replaceChildren(...docs.slice(0, 7).map((d) => el('button', {
        class: 'doc-mini', type: 'button', onclick: () => { location.hash = `#/library/${d.id}`; },
      },
        el('div', { style: 'min-width:0' },
          el('div', { class: 'dm-title', text: d.title }),
          el('div', { class: 'dm-meta', text: `${d.domain || d.kind} · ${shortNum(d.word_count)} words · ${relTime(d.retrieved_at)}` })))));
      if (!docs.length) recentHost.append(el('p', { class: 'muted', style: 'font-size:12.5px;margin:0', text: 'Nothing yet.' }));
    } catch { /* the panel is decorative on failure */ }
  }

  setTab('Note');
  loadRecent();
  return () => {};
}
