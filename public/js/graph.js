const TYPE_COLOR = {
  person: '#e9b44c',
  organization: '#7aa7e0',
  place: '#5ec8a8',
  work: '#a99be0',
  event: '#e0704f',
  concept: '#9aa0aa',
};

const REL_STRONG = new Set(['founded', 'created', 'led', 'worked_for', 'studied_at', 'born_in']);

/**
 * A small force-directed canvas graph. No dependencies: repulsion + spring
 * layout with a light collision pass, cooled over ~400 ticks.
 */
export class GraphView {
  constructor(canvas, { onSelect, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.nodes = [];
    this.links = [];
    this.hiddenTypes = new Set();
    this.camera = { x: 0, y: 0, k: 1 };
    this.alpha = 1;
    this.dragging = null;
    this.panning = null;
    this.selected = null;
    this.hovered = null;
    this.moved = false;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.frame = null;
    this._bind();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
  }

  /* -------------------------------------------------------------- data */

  setData({ nodes, links }, { reset = true } = {}) {
    const index = new Map();
    this.nodes = nodes.map((n) => {
      const prev = this.nodeById?.get(n.id);
      const node = {
        ...n,
        x: prev?.x ?? (Math.random() - 0.5) * 300,
        y: prev?.y ?? (Math.random() - 0.5) * 300,
        vx: 0, vy: 0,
        r: this._radius(n),
      };
      index.set(n.id, node);
      return node;
    });
    this.nodeById = index;
    this.links = links
      .map((l) => ({ ...l, s: index.get(l.source ?? l.src), t: index.get(l.target ?? l.dst) }))
      .filter((l) => l.s && l.t);
    if (reset) {
      this.alpha = 1;
      this._fitLater = true;
    }
    this._kick();
    return this;
  }

  _radius(n) {
    const base = 3.4 + Math.min(9, Math.sqrt(n.degree || 1) * 1.7);
    return base + Math.min(4, (n.salience || 0) * 4);
  }

  setHiddenTypes(set) {
    this.hiddenTypes = set;
    this._kick();
  }

  select(id) {
    this.selected = id;
    this._kick();
  }

  focusOn(id) {
    const n = this.nodeById?.get(id);
    if (!n) return;
    this.selected = id;
    this.camera.x = this.width / 2 - n.x * this.camera.k;
    this.camera.y = this.height / 2 - n.y * this.camera.k;
    this.alpha = Math.max(this.alpha, 0.25);
    this._kick();
  }

  zoomBy(factor) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const k2 = Math.max(0.25, Math.min(3.5, this.camera.k * factor));
    this.camera.x = cx - ((cx - this.camera.x) / this.camera.k) * k2;
    this.camera.y = cy - ((cy - this.camera.y) / this.camera.k) * k2;
    this.camera.k = k2;
    this._kick();
  }

  fit() {
    const vis = this._visible();
    if (!vis.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of vis) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = 90;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const k = Math.max(0.25, Math.min(1.6, Math.min((this.width - pad * 2) / w, (this.height - pad * 2) / h)));
    this.camera.k = k;
    this.camera.x = this.width / 2 - ((minX + maxX) / 2) * k;
    this.camera.y = this.height / 2 - ((minY + maxY) / 2) * k;
    this._kick();
  }

  /* -------------------------------------------------------------- loop */

  _kick() {
    if (this.frame) return;
    const tick = () => {
      this.frame = null;
      this._step();
      this._draw();
      if (this.alpha > 0.004 || this.needsDraw) {
        this.needsDraw = false;
        this.alpha *= 0.985;
        this.frame = requestAnimationFrame(tick);
      }
    };
    this.frame = requestAnimationFrame(tick);
  }

  _visible() {
    return this.nodes.filter((n) => !this.hiddenTypes.has(n.type));
  }

  _step() {
    const nodes = this._visible();
    if (!nodes.length) return;
    const a = Math.max(this.alpha, 0.02);
    const charge = 2600;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const m = nodes[j];
        let dx = n.x - m.x;
        let dy = n.y - m.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 90000) continue;
        const f = (charge * a) / (d2 * Math.sqrt(d2));
        const fx = dx * f;
        const fy = dy * f;
        n.vx += fx; n.vy += fy;
        m.vx -= fx; m.vy -= fy;
      }
      // gentle gravity keeps islands from drifting apart
      n.vx -= n.x * 0.0016 * a;
      n.vy -= n.y * 0.0016 * a;
    }
    for (const l of this.links) {
      if (this.hiddenTypes.has(l.s.type) || this.hiddenTypes.has(l.t.type)) continue;
      const dx = l.t.x - l.s.x;
      const dy = l.t.y - l.s.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const rest = 62 + (l.s.r + l.t.r) * 3.2;
      const f = ((dist - rest) / dist) * 0.055 * a;
      l.s.vx += dx * f; l.s.vy += dy * f;
      l.t.vx -= dx * f; l.t.vy -= dy * f;
    }
    for (const n of nodes) {
      const mass = 1 + (n.degree || 1) * 0.08;
      n.vx /= mass; n.vy /= mass;
      if (this.dragging === n) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += Math.max(-18, Math.min(18, n.vx));
      n.y += Math.max(-18, Math.min(18, n.vy));
    }
  }

  _draw() {
    const { ctx } = this;
    const { width, height, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // faint dot grid, anchored to the world so it moves with panning
    const step = 34 * this.camera.k;
    if (step > 9) {
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      const ox = this.camera.x % step;
      const oy = this.camera.y % step;
      for (let x = ox; x < width; x += step) {
        for (let y = oy; y < height; y += step) ctx.fillRect(x, y, 1, 1);
      }
    }

    ctx.save();
    ctx.translate(this.camera.x, this.camera.y);
    ctx.scale(this.camera.k, this.camera.k);

    const focusId = this.hovered ?? this.selected;
    const neighbors = new Set();
    if (focusId != null) {
      for (const l of this.links) {
        if (l.s.id === focusId) neighbors.add(l.t.id);
        if (l.t.id === focusId) neighbors.add(l.s.id);
      }
    }

    for (const l of this.links) {
      if (this.hiddenTypes.has(l.s.type) || this.hiddenTypes.has(l.t.type)) continue;
      const dim = focusId != null && l.s.id !== focusId && l.t.id !== focusId;
      const strong = REL_STRONG.has(l.rel);
      ctx.beginPath();
      const mx = (l.s.x + l.t.x) / 2;
      const my = (l.s.y + l.t.y) / 2;
      const curve = 0.12;
      ctx.moveTo(l.s.x, l.s.y);
      ctx.quadraticCurveTo(mx + (l.t.y - l.s.y) * curve, my - (l.t.x - l.s.x) * curve, l.t.x, l.t.y);
      ctx.strokeStyle = strong
        ? `rgba(233,180,76,${dim ? 0.05 : 0.34})`
        : `rgba(160,168,180,${dim ? 0.035 : 0.13})`;
      ctx.lineWidth = (strong ? 1.25 : 0.8) / Math.max(0.7, this.camera.k);
      ctx.stroke();
      if (strong && !dim && this.camera.k > 0.75) {
        const ang = Math.atan2(l.t.y - l.s.y, l.t.x - l.s.x);
        const ax = l.t.x - Math.cos(ang) * (l.t.r + 3);
        const ay = l.t.y - Math.sin(ang) * (l.t.r + 3);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(ang - 0.45) * 5, ay - Math.sin(ang - 0.45) * 5);
        ctx.lineTo(ax - Math.cos(ang + 0.45) * 5, ay - Math.sin(ang + 0.45) * 5);
        ctx.closePath();
        ctx.fillStyle = 'rgba(233,180,76,0.45)';
        ctx.fill();
      }
    }

    for (const n of this.nodes) {
      if (this.hiddenTypes.has(n.type)) continue;
      const color = TYPE_COLOR[n.type] || TYPE_COLOR.concept;
      const dim = focusId != null && n.id !== focusId && !neighbors.has(n.id);
      const isFocus = n.id === focusId;
      const r = n.r * (isFocus ? 1.18 : 1);

      if (isFocus || n.id === this.selected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = `${color}1f`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = dim ? `${color}33` : color;
      ctx.globalAlpha = dim ? 0.5 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (isFocus) {
        ctx.lineWidth = 1.4 / this.camera.k;
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.stroke();
      }
    }

    // labels: focused node, its neighbours, and the biggest hubs
    if (this.camera.k > 0.55) {
      ctx.font = `500 ${11 / this.camera.k}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of this.nodes) {
        if (this.hiddenTypes.has(n.type)) continue;
        const show = n.id === focusId || neighbors.has(n.id) || (n.degree || 0) >= 4 || n.salience > 0.62;
        if (!show) continue;
        const dim = focusId != null && n.id !== focusId && !neighbors.has(n.id);
        const label = n.name.length > 30 ? `${n.name.slice(0, 29)}…` : n.name;
        ctx.fillStyle = dim ? 'rgba(160,166,176,0.28)' : n.id === focusId ? '#fff' : 'rgba(214,216,220,0.78)';
        ctx.fillText(label, n.x, n.y + n.r + 6 / this.camera.k);
      }
    }

    ctx.restore();
  }

  /* -------------------------------------------------------------- input */

  _resize() {
    const parent = this.canvas.parentElement;
    this.width = parent.clientWidth;
    this.height = parent.clientHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    if (this._fitLater) {
      this._fitLater = false;
      this.fit();
    }
    this._kick();
  }

  _world(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this.camera.x) / this.camera.k,
      y: (e.clientY - rect.top - this.camera.y) / this.camera.k,
    };
  }

  _pick(pos) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (this.hiddenTypes.has(n.type)) continue;
      const d = Math.hypot(n.x - pos.x, n.y - pos.y);
      const hit = n.r + 6 / this.camera.k;
      if (d < hit && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const pos = this._world(e);
      const hit = this._pick(pos);
      this.moved = false;
      if (hit) {
        this.dragging = hit;
        this.alpha = Math.max(this.alpha, 0.4);
      } else {
        this.panning = { x: e.clientX, y: e.clientY, cx: this.camera.x, cy: this.camera.y };
        c.classList.add('dragging');
      }
    });

    c.addEventListener('pointermove', (e) => {
      const pos = this._world(e);
      if (this.dragging) {
        this.moved = true;
        this.dragging.x = pos.x;
        this.dragging.y = pos.y;
        this._kick();
        this._positionTooltip(e, this.dragging);
        return;
      }
      if (this.panning) {
        this.moved = true;
        this.camera.x = this.panning.cx + (e.clientX - this.panning.x);
        this.camera.y = this.panning.cy + (e.clientY - this.panning.y);
        this._kick();
        return;
      }
      const hit = this._pick(pos);
      const id = hit?.id ?? null;
      if (id !== this.hovered) {
        this.hovered = id;
        c.classList.toggle('hovering', Boolean(hit));
        this.onHover?.(hit ? hit.name : null);
        this._positionTooltip(e, hit);
        this._kick();
      } else if (hit) {
        this._positionTooltip(e, hit);
      }
    });

    const end = () => {
      if (this.dragging && !this.moved) this.onSelect?.(this.dragging.id);
      if (this.panning && !this.moved) this.onSelect?.(null);
      this.dragging = null;
      this.panning = null;
      c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const k2 = Math.max(0.25, Math.min(3.5, this.camera.k * (e.deltaY < 0 ? 1.08 : 0.925)));
      this.camera.x = px - ((px - this.camera.x) / this.camera.k) * k2;
      this.camera.y = py - ((py - this.camera.y) / this.camera.k) * k2;
      this.camera.k = k2;
      this._kick();
    }, { passive: false });

    c.addEventListener('pointerleave', () => {
      this.hovered = null;
      this._positionTooltip(null, null);
      this._kick();
    });
  }

  _positionTooltip(e, node) {
    const tip = this.tooltip;
    if (!tip) return;
    if (!node) { tip.classList.remove('show'); return; }
    const rect = this.canvas.parentElement.getBoundingClientRect();
    tip.style.left = `${e.clientX - rect.left}px`;
    tip.style.top = `${e.clientY - rect.top}px`;
    tip.querySelector('.tt-name').textContent = node.name;
    tip.querySelector('.tt-type').textContent = `${node.type} · ${node.degree || 0} links`;
    tip.classList.add('show');
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}
