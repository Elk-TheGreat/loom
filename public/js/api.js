const JSON_HEADERS = { 'content-type': 'application/json' };

async function request(path, options = {}) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const get = (path) => request(path);
const post = (path, body) => request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const del = (path) => request(path, { method: 'DELETE' });

export const api = {
  health: () => get('/api/health'),
  stats: () => get('/api/stats'),
  insights: () => get('/api/insights'),
  graph: (params = {}) => get(`/api/graph?${new URLSearchParams(params)}`),
  entity: (id) => get(`/api/entity/${id}`),
  search: (q, opts = {}) => get(`/api/search?${new URLSearchParams({ q, ...opts })}`),
  docs: (q = '') => get(`/api/docs?${new URLSearchParams({ q })}`),
  doc: (id) => get(`/api/docs/${id}`),
  removeDoc: (id) => del(`/api/docs/${id}`),
  memory: (params = {}) => get(`/api/memory?${new URLSearchParams(params)}`),
  ask: (question) => post('/api/ask', { question }),
  wikiSearch: (q) => post('/api/wiki/search', { q }),
  reinforce: (id) => post('/api/memory/reinforce', { id }),
  setFactStatus: (id, status) => post('/api/memory/status', { id, status }),
  ingest: (payload) => post('/api/ingest', payload),
};

/**
 * Ingest and follow the job's server-sent events.
 * onStep receives each progress step; resolves with the final job payload.
 */
export function ingestStream(payload, onStep) {
  return new Promise((resolve, reject) => {
    api.ingest(payload).then(({ jobId }) => {
      const es = new EventSource(`/api/jobs/${jobId}/events`);
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        es.close();
        fn(value);
      };
      es.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.message) onStep?.(msg);
        if (msg.status === 'error') finish(reject, new Error(msg.error || 'Ingestion failed'));
        else if (msg.status === 'done') finish(resolve, { jobId, ...msg });
      };
      es.onerror = () => {
        // A dropped stream is not fatal on its own; poll once before giving up.
        setTimeout(async () => {
          if (settled) return;
          try {
            const job = await get(`/api/jobs/${jobId}`);
            if (job.status === 'done') finish(resolve, { jobId, ...job, result: job.result });
            else if (job.status === 'error') finish(reject, new Error(job.error || 'Ingestion failed'));
          } catch (err) { finish(reject, err); }
        }, 800);
      };
    }).catch(reject);
  });
}

/* ----------------------------------------------------------- formatting */

export function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

export function shortNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (v >= 1e4) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

export const TYPE_LABEL = {
  person: 'Person', organization: 'Organization', place: 'Place',
  work: 'Work', event: 'Event', concept: 'Concept',
};
