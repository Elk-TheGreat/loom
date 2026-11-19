import { api, relTime, shortNum, TYPE_LABEL } from '../api.js';
import { el, typeDot, statusPill, toast, emptyState, debounce, ICON, svg } from '../ui.js';

const KIND_LABEL = { wikipedia: 'Wikipedia', web: 'Web', note: 'Note' };

export async function renderLibrary(root, { params = {} } = {}) {
  const page = el('div', { class: 'page' });
  root.append(page);
  page.append(el('div', { class: 'eyebrow', text: 'Corpus' }),
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { text: 'Library' }),
        el('p', { text: 'Everything Loom has read. Each source is chunked, embedded, and mined for entities and claims.' })),
      el('a', { class: 'btn primary', href: '#/sources' }, svg(ICON.plus), 'Add source')));

  const statRow = el('div', { class: 'stat-row' });
  page.append(statRow);

  const search = el('input', { class: 'input', type: 'search', placeholder: 'Filter documents…' });
  const chips = el('div', { style: 'display:flex;gap:6px' });
  const toolbar = el('div', { class: 'toolbar' }, search, chips);
  page.append(toolbar);

  const grid = el('div', { class: 'doc-grid' });
  page.append(grid);

  const scrim = el('div', { class: 'doc-drawer-scrim' });
  const drawer = el('div', { class: 'drawer', role: 'dialog', 'aria-label': 'Document' });
  document.body.append(scrim, drawer);
  scrim.addEventListener('click', () => closeDrawer());

  let all = [];
  let kind = null;

  try {
    const [s, { docs }] = await Promise.all([api.stats(), api.docs()]);
    all = docs;
    paintStats(s);
    paintChips(docs);
    paintDocs(docs);
    if (params.docId) openDoc(params.docId);
  } catch (err) {
    toast(`Library failed to load: ${err.message}`, 'error');
  }

  function paintStats(s) {
    const c = s.counts;
    statRow.replaceChildren(
      stat('documents', c.docs),
      stat('passages', shortNum(c.chunks)),
      stat('entities', shortNum(c.entities), 'accent'),
      stat('verified claims', c.verified, 'teal'),
    );
  }

  function stat(label, value, cls = '') {
    return el('div', { class: `stat ${cls}` }, el('div', { class: 'sv', text: shortNum(value) }), el('div', { class: 'sl', text: label }));
  }

  function paintChips(docs) {
    const kinds = new Map();
    for (const d of docs) kinds.set(d.kind, (kinds.get(d.kind) || 0) + 1);
    const mk = (label, key, count) => {
      const b = el('button', { class: `chip ${kind === key ? 'active' : ''}`, type: 'button' },
        el('span', { text: label }), el('span', { class: 'count', text: String(count) }));
      b.addEventListener('click', () => { kind = kind === key ? null : key; paintChips(all); paintDocs(all); });
      return b;
    };
    chips.replaceChildren(mk('All', null, docs.length), ...[...kinds].map(([k, n]) => mk(KIND_LABEL[k] || k, k, n)));
  }

  function paintDocs(docs) {
    const q = search.value.trim().toLowerCase();
    const shown = docs.filter((d) => (!kind || d.kind === kind) && (!q || d.title.toLowerCase().includes(q) || (d.summary || '').toLowerCase().includes(q)));
    grid.replaceChildren(...shown.map(docCard));
    if (!shown.length) {
      grid.append(emptyState(
        docs.length ? 'Nothing matches' : 'The library is empty',
        docs.length ? 'Try a different filter or search term.' : 'Add a note, a link, or a Wikipedia article and Loom will start weaving.',
        docs.length ? null : el('a', { class: 'btn primary', href: '#/sources', text: 'Add your first source' }),
      ));
    }
  }

  function docCard(d) {
    const card = el('article', { class: 'card doc-card', tabindex: '0', role: 'button' },
      el('div', { class: 'doc-top' },
        el('span', { class: `doc-kind ${d.kind}`, text: KIND_LABEL[d.kind] || d.kind }),
        el('span', { text: d.domain || 'local' }),
        el('span', { class: 'spacer', style: 'margin-left:auto' , text: relTime(d.retrieved_at) })),
      el('h3', { class: 'doc-title', text: d.title }),
      d.summary ? el('p', { class: 'doc-summary', text: d.summary }) : null,
      el('div', { class: 'doc-foot' },
        el('span', { text: `${shortNum(d.word_count)} words` }),
        el('span', { text: `${d.entities} entities` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'trust-meter', title: `Source trust ${Math.round((d.trust || 0) * 100)}%` },
          el('span', { class: 'trust-bar' }, el('i', { style: `width:${Math.round((d.trust || 0) * 100)}%` })),
          el('span', { text: `${Math.round((d.trust || 0) * 100)}` }))),
    );
    card.addEventListener('click', () => openDoc(d.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDoc(d.id); });
    return card;
  }

  search.addEventListener('input', debounce(() => paintDocs(all), 150));

  async function openDoc(id) {
    drawer.classList.add('open');
    scrim.classList.add('open');
    drawer.replaceChildren(el('div', { class: 'drawer-body' }, el('div', { class: 'skeleton', style: 'height:22px;width:60%' })));
    try {
      const d = await api.doc(id);
      drawer.replaceChildren(renderDoc(d));
    } catch (err) {
      toast(`Could not open document: ${err.message}`, 'error');
      closeDrawer();
    }
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    if (location.hash.startsWith('#/library/')) location.hash = '#/library';
  }

  function renderDoc(d) {
    const head = el('div', { class: 'drawer-head' },
      el('button', { class: 'icon-btn insp-close', type: 'button', title: 'Close', onclick: closeDrawer }, svg(ICON.close)),
      el('div', { class: 'eyebrow', text: `${KIND_LABEL[d.kind] || d.kind} · ${d.domain || 'local'}` }),
      el('h2', { style: 'font-family:var(--serif);font-size:26px;font-weight:400;margin:0 0 8px;line-height:1.25', text: d.title }),
      el('div', { class: 'mono faint', style: 'font-size:10px;display:flex;gap:14px;flex-wrap:wrap;letter-spacing:.06em;text-transform:uppercase' },
        el('span', { text: `${shortNum(d.word_count)} words` }),
        el('span', { text: `${d.chunks.length} passages` }),
        el('span', { text: `${d.entities.length} entities` }),
        el('span', { text: `trust ${Math.round((d.trust || 0) * 100)}%` }),
        el('span', { text: relTime(d.retrieved_at) })),
    );

    const body = el('div', { class: 'drawer-body' });

    if (d.url) {
      body.append(el('a', { class: 'btn small', href: d.url, target: '_blank', rel: 'noopener', style: 'margin-bottom:18px' }, svg(ICON.link), 'Open original'));
    }

    if (d.entities.length) {
      body.append(el('h3', { text: 'Entities mentioned' }));
      const wrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px' },
        d.entities.slice(0, 28).map((e) => {
          const b = el('button', { class: 'chip', type: 'button', title: TYPE_LABEL[e.type] || e.type, onclick: () => { location.hash = `#/graph/${e.id}`; } },
            typeDot(e.type), el('span', { text: e.name }), el('span', { class: 'count', text: String(e.count) }));
          return b;
        }));
      body.append(wrap);
    }

    if (d.facts?.length) {
      body.append(el('h3', { text: 'Claims extracted' }));
      body.append(el('div', {}, d.facts.slice(0, 20).map((f) => el('div', { class: 'fact-line' },
        el('span', { class: 'fp', text: f.predicate.replace(/_/g, ' ').toUpperCase() }),
        el('span', { class: 'fo', text: f.object }),
        statusPill(f.status)))));
    }

    body.append(el('h3', { text: 'Passages' }));
    body.append(el('div', {}, d.chunks.map((c) => el('div', { class: 'chunk-card' },
      c.heading ? el('div', { class: 'mono faint', style: 'font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px', text: c.heading }) : null,
      el('div', { class: 'doc-text', style: 'font-size:13px', text: c.text })))));

    const foot = el('div', { class: 'drawer-head', style: 'border-top:1px solid var(--line);border-bottom:0;display:flex;justify-content:flex-end;gap:8px;padding:12px 26px' },
      el('button', {
        class: 'btn small', type: 'button',
        onclick: async () => {
          if (!confirm(`Delete “${d.title}” and its passages? Claims lose this source and may be removed.`)) return;
          try {
            await api.removeDoc(d.id);
            toast('Document deleted', 'success');
            closeDrawer();
            location.reload();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, svg(ICON.trash), 'Delete source'));

    return el('div', { style: 'display:flex;flex-direction:column;height:100%' }, head, body, foot);
  }

  return () => {
    scrim.remove();
    drawer.remove();
  };
}
