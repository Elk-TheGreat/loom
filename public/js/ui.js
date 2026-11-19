import { TYPE_LABEL } from './api.js';

/** Tiny DOM builder. Strings become text nodes, never HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden') node[k] = Boolean(v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const svg = (pathData, { size = 16, viewBox = '0 0 16 16' } = {}) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.innerHTML = `<path d="${pathData}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return s;
};

export const ICON = {
  close: 'M3 3l10 10M13 3L3 13',
  arrow: 'M3 8h10M9 4l4 4-4 4',
  plus: 'M8 3v10M3 8h10',
  check: 'M3 8.5l3.2 3.2L13 5',
  x: 'M4 4l8 8M12 4l-8 8',
  spark: 'M8 2l1.6 4.4L14 8l-4.4 1.6L8 14 6.4 9.6 2 8l4.4-1.6L8 2z',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 014 4l-1 1M9 11.5l-1 1a2.8 2.8 0 01-4-4l1-1',
  book: 'M3 3h4.5a2.5 2.5 0 012.5 2.5V13a2 2 0 00-2-2H3zM13 3H9.5A2.5 2.5 0 007 5.5V13a2 2 0 012-2h4z',
  trash: 'M3 5h10M6.5 5V3.5h3V5M5 5l.6 8h4.8L11 5',
  refresh: 'M13 8a5 5 0 11-1.6-3.7M13 3v2.5h-2.5',
  zoomIn: 'M8 4v8M4 8h8',
  zoomOut: 'M4 8h8',
  target: 'M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  chevron: 'M6 4l4 4-4 4',
};

export function typeDot(type) {
  return el('i', { class: `type-dot t-${type || 'concept'}`, title: TYPE_LABEL[type] || 'Concept' });
}

export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${kind}` }, el('div', { html: '' }), el('span', { text: message }));
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(4px)';
    setTimeout(() => node.remove(), 220);
  }, 4200);
}

export function spinner() {
  return el('span', { class: 'spinner' });
}

export function emptyState(title, body, action) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-mark', text: '∵' }),
    el('h3', { text: title }),
    el('p', { text: body }),
    action || null,
  );
}

export function statusPill(status) {
  return el('span', { class: `status ${status}` }, status.replace('-', ' '));
}

export function confidenceBar(value) {
  const pct = Math.round((value || 0) * 100);
  const cls = pct >= 65 ? '' : pct >= 40 ? 'mid' : 'low';
  return el('div', { class: 'conf-wrap' },
    el('div', { class: `conf-bar ${cls}` }, el('i', { style: `width:${pct}%` })),
    el('span', { class: 'conf-num', text: `${pct}%` }),
  );
}

/** Debounce helper for search inputs. */
export function debounce(fn, ms = 220) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
