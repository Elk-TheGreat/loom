import { api, relTime, TYPE_LABEL, shortNum } from '../api.js';
import { el, typeDot, statusPill, confidenceBar, ICON, svg, toast, spinner } from '../ui.js';
import { GraphView } from '../graph.js';

const TYPE_ORDER = ['person', 'organization', 'place', 'work', 'event', 'concept'];

export async function renderGraph(root, { params = {} } = {}) {
  const shell = el('div', { class: 'graph-shell' });
  const canvas = el('canvas', { id: 'graph-canvas' });
  const tooltip = el('div', { class: 'graph-tooltip' },
    el('div', { class: 'tt-name' }), el('small', { class: 'tt-type' }));

  const title = el('h1', { class: 'graph-title', text: 'Knowledge graph' });
  const sub = el('p', { class: 'graph-sub', text: 'Loading the weave…' });
  const head = el('div', { class: 'graph-overlay graph-head' }, title, sub);

  const legend = el('div', { class: 'graph-overlay graph-filters' },
    el('div', { class: 'gf-title', text: 'Entities' }));
  const insightsHost = el('div', { class: 'graph-overlay graph-insights' });
  const zoomHost = el('div', { class: 'graph-overlay graph-zoom' },
    el('button', { class: 'zoom-btn', type: 'button', title: 'Zoom in', onclick: () => view.zoomBy(1.25) }, svg(ICON.zoomIn)),
    el('button', { class: 'zoom-btn', type: 'button', title: 'Zoom out', onclick: () => view.zoomBy(0.8) }, svg(ICON.zoomOut)),
    el('button', { class: 'zoom-btn', type: 'button', title: 'Fit to view', onclick: () => view.fit() }, svg(ICON.target)),
  );

  const inspector = el('aside', { class: 'inspector', 'aria-label': 'Entity details' });
  shell.append(canvas, head, legend, insightsHost, zoomHost, inspector, tooltip);
  root.append(shell);

  const view = new GraphView(canvas, {
    onSelect: (id) => { if (id) openEntity(id); else closeInspector(); },
  });
  view.tooltip = tooltip;

  let data = null;
  const hidden = new Set();
  let currentId = null;

  try {
    const [g, stats, ins] = await Promise.all([api.graph({ limit: 160 }), api.stats(), api.insights()]);
    data = g;
    view.setData(g);
    const total = stats.counts.entities;
    sub.textContent = `${g.nodes.length} of ${total} entities · ${g.links.length} relations · ${shortNum(stats.counts.words)} words indexed`;
    buildLegend(g.nodes);
    buildInsights(ins, g.nodes);
    if (params.focus) openEntity(Number(params.focus));
  } catch (err) {
    toast(`Could not load the graph: ${err.message}`, 'error');
    sub.textContent = 'The graph could not be loaded.';
  }

  function buildLegend(nodes) {
    const byType = new Map();
    for (const n of nodes) byType.set(n.type, (byType.get(n.type) || 0) + 1);
    for (const type of TYPE_ORDER) {
      const count = byType.get(type) || 0;
      if (!count) continue;
      const btn = el('button', { class: 'legend-item', type: 'button' },
        typeDot(type), el('span', { text: TYPE_LABEL[type] }), el('span', { class: 'lg-count', text: String(count) }));
      btn.addEventListener('click', () => {
        if (hidden.has(type)) { hidden.delete(type); btn.classList.remove('off'); }
        else { hidden.add(type); btn.classList.add('off'); }
        view.setHiddenTypes(hidden);
      });
      legend.append(btn);
    }
  }

  function buildInsights(ins, nodes) {
    const nameOf = (id) => nodes.find((n) => n.id === id)?.name;
    const items = [];
    if (ins.contested?.length) {
      items.push(['Contested', `${ins.contested[0].subject_name}: ${ins.contested[0].object} is disputed`]);
    }
    const thin = ins.thin?.[0];
    if (thin) items.push(['Thin', `${thin.name} is told by a single source`]);
    const bridge = ins.bridges?.[0];
    if (bridge) items.push(['Bridge', `${bridge.name} appears across ${bridge.domains} domains`]);
    const orphan = ins.orphans?.find((o) => nameOf(o.id));
    if (orphan) items.push(['Floating', `${orphan.name} has no relations yet`]);

    for (const [kind, text] of items.slice(0, 3)) {
      insightsHost.append(el('button', { class: 'insight', type: 'button' },
        el('span', { class: 'ig-k', text: kind }), el('span', { text })));
    }
  }

  function closeInspector() {
    inspector.classList.remove('open');
    currentId = null;
  }

  async function openEntity(id) {
    currentId = id;
    view.select(id);
    inspector.classList.add('open');
    inspector.replaceChildren(el('div', { class: 'insp-body' }, el('div', { style: 'padding:20px;display:flex;gap:10px;align-items:center' }, spinner(), el('span', { class: 'muted', text: 'Reading entity…' }))));
    try {
      const e = await api.entity(id);
      if (currentId !== id) return;
      inspector.replaceChildren(renderInspector(e));
    } catch (err) {
      toast(`Entity failed to load: ${err.message}`, 'error');
      closeInspector();
    }
  }

  function renderInspector(e) {
    const head = el('div', { class: 'insp-head' },
      el('button', { class: 'icon-btn insp-close', type: 'button', title: 'Close', onclick: closeInspector }, svg(ICON.close)),
      el('div', { class: 'insp-type' }, typeDot(e.type), TYPE_LABEL[e.type] || 'Concept'),
      el('h2', { class: 'insp-name', text: e.name }),
      e.description ? el('p', { class: 'insp-desc', text: e.description }) : null,
      el('div', { class: 'mono faint', style: 'font-size:10px;margin-top:10px;display:flex;gap:14px;text-transform:uppercase;letter-spacing:.08em' },
        el('span', { text: `${e.mentions} mentions` }),
        el('span', { text: `${e.docs?.length || 0} sources` }),
        el('span', { text: `salience ${(e.salience ?? 0).toFixed(2)}` })),
    );

    const body = el('div', { class: 'insp-body' });

    if (e.neighbors?.length) {
      const rows = e.neighbors.slice(0, 18).map((n) => el('button', {
        class: 'rel-row', type: 'button',
        onclick: () => { view.focusOn(n.id); openEntity(n.id); },
      },
        el('span', { class: 'rel-dir', text: n.direction === 'out' ? '→' : '←' }),
        el('span', { class: 'rel-verb', text: n.label }),
        typeDot(n.type),
        el('span', { text: n.name }),
      ));
      body.append(section(`Relations · ${e.neighbors.length}`, rows));
    }

    if (e.facts?.length) {
      body.append(section('Claims', e.facts.map((f) => el('div', { class: 'fact-line' },
        el('span', { class: 'fp', text: f.label }),
        el('span', { class: 'fo', text: f.object_name || f.object }),
        statusPill(f.status),
      ))));
    }

    if (e.docs?.length) {
      body.append(section('Sources', e.docs.map((d) => el('button', {
        class: 'doc-mini', type: 'button',
        onclick: () => { location.hash = `#/library/${d.id}`; },
      },
        el('div', {},
          el('div', { class: 'dm-title', text: d.title }),
          el('div', { class: 'dm-meta', text: `${d.domain || d.kind} · ${d.count} mentions` })),
      ))));
    }

    if (e.related?.length) {
      body.append(section('Often appears with', e.related.map((r) => el('button', {
        class: 'rel-row', type: 'button', onclick: () => openEntity(r.id),
      }, el('span', { class: 'rel-verb', text: `${r.shared}×` }), typeDot(r.type), el('span', { text: r.name })))));
    }

    if (e.events?.length) {
      body.append(section('Memory events', el('div', { class: 'timeline' },
        e.events.slice(0, 8).map((ev) => el('div', { class: `tl-item ${ev.kind}` },
          el('div', { text: ev.detail }),
          el('div', { class: 'tl-time', text: relTime(ev.at) }))))));
    }

    if (!body.children.length) body.append(el('p', { class: 'muted', style: 'font-size:13px', text: 'This entity is not connected to anything yet. Add more sources that mention it.' }));

    const wrap = el('div', { style: 'display:flex;flex-direction:column;height:100%' }, head, body);
    return wrap;
  }

  return () => view.destroy();
}

function section(title, children) {
  const list = Array.isArray(children) ? children : [children];
  return el('div', { class: 'insp-section' },
    el('h4', {}, el('span', { text: title })),
    ...list);
}
