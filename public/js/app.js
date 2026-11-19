import { api, relTime, TYPE_LABEL } from './api.js';
import { el, debounce, typeDot, toast, ICON, svg } from './ui.js';
import { renderGraph } from './views/graph.js';
import { renderLibrary } from './views/library.js';
import { renderMemory } from './views/memory.js';
import { renderAsk } from './views/ask.js';
import { renderSources } from './views/sources.js';

const root = document.getElementById('view');
let cleanup = null;

const ROUTES = {
  graph: { render: renderGraph, scroll: false },
  library: { render: renderLibrary, scroll: true },
  memory: { render: renderMemory, scroll: true },
  ask: { render: renderAsk, scroll: false },
  sources: { render: renderSources, scroll: true },
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'graph';
  const [name, ...rest] = raw.split('/');
  return { name: ROUTES[name] ? name : 'graph', rest };
}

let routeToken = 0;

async function route() {
  const token = ++routeToken;
  const { name, rest } = parseHash();
  const view = ROUTES[name];

  if (cleanup) { try { cleanup(); } catch { /* view teardown is best-effort */ } cleanup = null; }
  root.replaceChildren();
  root.classList.toggle('scroll', view.scroll);
  root.scrollTop = 0;

  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));

  const params = {};
  if (name === 'graph' && rest[0]) params.focus = rest[0];
  if (name === 'library' && rest[0]) params.docId = rest[0];

  try {
    const result = await view.render(root, { params });
    if (token === routeToken) cleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    console.error(err);
    root.append(el('div', { class: 'page' }, el('div', { class: 'empty' },
      el('h3', { text: 'Something broke' }), el('p', { text: err.message }))));
  }
}

window.addEventListener('hashchange', route);
route();

/* ------------------------------------------------------------- llm badge */

api.health().then((h) => {
  const badge = document.getElementById('llm-badge');
  const label = badge.querySelector('span');
  if (h.llm?.available) {
    badge.classList.add('on');
    label.textContent = h.llm.model ? h.llm.model.split(':')[0] : 'local model';
    badge.title = `Local model ready: ${h.llm.model || 'ollama'}`;
  } else {
    label.textContent = 'no local model';
    badge.title = 'Start Ollama to enable generative answers and LLM extraction';
    badge.style.cursor = 'help';
  }
}).catch(() => {
  const badge = document.getElementById('llm-badge');
  badge.querySelector('span').textContent = 'offline';
});

/* --------------------------------------------------------------- palette */

const palette = document.getElementById('palette');
const pInput = document.getElementById('palette-input');
const pResults = document.getElementById('palette-results');
let items = [];
let activeIndex = 0;

function openPalette() {
  palette.hidden = false;
  pInput.value = '';
  pResults.replaceChildren(el('div', { class: 'palette-empty', text: 'Search passages, entities, and documents.' }));
  pInput.focus();
}
function closePalette() {
  palette.hidden = true;
}
// A route change from anywhere (back button, pasted link) should dismiss the overlay.
window.addEventListener('hashchange', closePalette);
function goto(hash) {
  closePalette();
  location.hash = hash;
}

document.getElementById('search-trigger').addEventListener('click', openPalette);
palette.addEventListener('click', (e) => { if (e.target.hasAttribute('data-close-palette')) closePalette(); });

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.hidden ? openPalette() : closePalette(); return; }
  if (e.key === 'Escape' && !palette.hidden) { closePalette(); return; }
  if (palette.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    paintActive();
  }
  if (e.key === 'Enter' && items[activeIndex]) { e.preventDefault(); items[activeIndex].run(); }
});

const runSearch = debounce(async (q) => {
  if (!q.trim()) {
    pResults.replaceChildren(el('div', { class: 'palette-empty', text: 'Search passages, entities, and documents.' }));
    items = [];
    return;
  }
  pResults.replaceChildren(el('div', { class: 'palette-empty', text: 'Searching…' }));
  try {
    const res = await api.search(q, { limit: 6 });
    items = [];
    const frag = document.createDocumentFragment();

    if (res.entities?.length) {
      frag.append(el('div', { class: 'palette-group', text: 'Entities' }));
      for (const e of res.entities) {
        items.push({ run: () => goto(`#/graph/${e.id}`) });
        frag.append(paletteItem(items.length - 1,
          typeDot(e.type),
          el('div', { class: 'pi-main' },
            el('div', { class: 'pi-title', text: e.name }),
            el('div', { class: 'pi-sub', text: e.description || TYPE_LABEL[e.type] || e.type })),
          el('span', { class: 'pi-meta', text: `${e.mentions || 0}×` })));
      }
    }

    if (res.results?.length) {
      frag.append(el('div', { class: 'palette-group', text: 'Passages' }));
      for (const r of res.results) {
        items.push({ run: () => goto(`#/library/${r.docId}`) });
        frag.append(paletteItem(items.length - 1,
          el('span', { class: 'pi-meta', text: '¶' }),
          el('div', { class: 'pi-main' },
            el('div', { class: 'pi-title', text: r.title }),
            el('div', { class: 'pi-sub', text: r.snippet })),
          el('span', { class: 'pi-meta', text: r.domain || r.kind })));
      }
    }

    if (!items.length) {
      pResults.replaceChildren(el('div', { class: 'palette-empty', text: `Nothing indexed matches “${q}”. Add a source first.` }));
      return;
    }
    pResults.replaceChildren(frag);
    activeIndex = 0;
    paintActive();
  } catch (err) {
    pResults.replaceChildren(el('div', { class: 'palette-empty', text: err.message }));
  }
}, 200);

function paletteItem(index, ...children) {
  return el('button', { class: 'palette-item', type: 'button', dataset: { index }, onclick: () => items[index].run() }, ...children);
}

function paintActive() {
  pResults.querySelectorAll('.palette-item').forEach((node) => {
    const on = Number(node.dataset.index) === activeIndex;
    node.classList.toggle('active', on);
    if (on) node.scrollIntoView({ block: 'nearest' });
  });
}

pInput.addEventListener('input', () => runSearch(pInput.value));
