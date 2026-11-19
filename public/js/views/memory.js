import { api, relTime, TYPE_LABEL } from '../api.js';
import { el, typeDot, statusPill, confidenceBar, toast, emptyState, ICON, svg, spinner } from '../ui.js';

const FILTERS = [
  ['all', 'All'],
  ['verified', 'Verified'],
  ['contested', 'Contested'],
  ['single-source', 'Single source'],
];

export async function renderMemory(root) {
  const page = el('div', { class: 'page' });
  root.append(page);

  const head = el('div', { class: 'page-head' },
    el('div', {},
      el('div', { class: 'eyebrow', text: 'Long-term memory' }),
      el('h1', { text: 'What Loom believes' }),
      el('p', { text: 'Claims distilled from your sources, with corroboration, confidence decay, and contradiction handling. Nothing here is a fact until independent domains agree.' })),
    el('div', { style: 'display:flex;gap:8px' },
      el('a', { class: 'btn small', href: '/api/memory/export', download: 'loom-memory.md' }, svg(ICON.arrow), 'Export Markdown')),
  );
  page.append(head);

  const filters = el('div', { class: 'mem-toolbar' });
  const list = el('div', { class: 'mem-list' });
  page.append(filters, list);

  let status = 'all';
  let current = [];

  for (const [key, label] of FILTERS) {
    const b = el('button', { class: `chip ${key === status ? 'active' : ''}`, type: 'button', text: label });
    b.dataset.key = key;
    b.addEventListener('click', () => {
      status = key;
      [...filters.children].forEach((c) => c.classList.toggle('active', c.dataset.key === key));
      load();
    });
    filters.append(b);
  }
  filters.append(el('span', { class: 'mono faint', style: 'font-size:10px;margin-left:auto;letter-spacing:.08em', id: 'mem-count' }));

  async function load() {
    list.replaceChildren(el('div', { style: 'padding:26px 0;display:flex;gap:10px;align-items:center' }, spinner(), el('span', { class: 'muted', text: 'Recalling…' })));
    try {
      const { facts } = await api.memory({ limit: 200 });
      current = facts;
      paint();
    } catch (err) {
      list.replaceChildren(emptyState('Memory unavailable', err.message));
    }
  }

  function paint() {
    const rows = current.filter((f) => status === 'all' || f.status === status);
    document.getElementById('mem-count').textContent = `${rows.length} claims · sorted by recall weight`;
    if (!rows.length) {
      list.replaceChildren(emptyState(
        current.length ? 'No claims with that status' : 'No claims yet',
        current.length ? 'Switch the filter to see the rest.' : 'Ingest a few sources that describe relationships — founders, locations, works — and they will surface here.',
      ));
      return;
    }
    list.replaceChildren(...rows.map(row));
  }

  function row(f) {
    const obj = f.object_name || f.object || '—';
    const node = el('div', { class: 'mem-row' },
      el('div', { class: 'mem-claim' },
        el('b', { text: f.subject_name }),
        el('span', { class: 'pred', text: f.label }),
        el('span', { class: 'obj', text: obj }),
        el('div', { class: 'meta' },
          statusPill(f.status),
          el('span', { text: `${f.domains.length} domain${f.domains.length === 1 ? '' : 's'}` }),
          el('span', { text: `seen ${relTime(f.last_seen)}` }),
          el('span', { text: `recall ${Math.round((f.recall ?? 0) * 100)}%` }))),
      confidenceBar(f.confidence),
      el('div', { class: 'mem-actions' },
        el('button', {
          class: 'icon-btn', type: 'button', title: 'Reinforce this claim', onclick: async () => {
            try {
              const r = await api.reinforce(f.id);
              f.confidence = r.confidence;
              toast(`Reinforced — now ${Math.round(r.confidence * 100)}%`, 'success');
              paint();
            } catch (err) { toast(err.message, 'error'); }
          },
        }, svg(ICON.check)),
        el('button', {
          class: 'icon-btn', type: 'button', title: 'Reject this claim', onclick: async () => {
            try {
              await api.setFactStatus(f.id, 'rejected');
              toast('Claim rejected');
              load();
            } catch (err) { toast(err.message, 'error'); }
          },
        }, svg(ICON.x)),
        el('button', {
          class: 'icon-btn', type: 'button', title: 'Inspect subject in graph', onclick: () => { location.hash = `#/graph/${f.subject_id}`; },
        }, svg(ICON.chevron)),
      ),
    );
    return node;
  }

  await load();
  return () => {};
}
