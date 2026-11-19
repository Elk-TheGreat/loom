// Adapter for a local LLM server (Ollama by default; any OpenAI-compatible
// endpoint also works). Purely optional: Loom is fully functional without it.

const DEFAULT_URL = process.env.LOOM_LLM_URL || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.LOOM_LLM_MODEL || '';

let cache = { at: 0, status: null };
const TTL = 15_000;

async function ping(url) {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } catch { return null; }
}

export async function llmStatus(force = false) {
  if (!force && cache.status && Date.now() - cache.at < TTL) return cache.status;
  const models = await ping(DEFAULT_URL);
  const status = {
    available: Boolean(models?.length),
    url: DEFAULT_URL,
    models: models || [],
    model: DEFAULT_MODEL || models?.[0] || null,
    provider: 'ollama',
  };
  cache = { at: Date.now(), status };
  return status;
}

export async function llmGenerate(prompt, { system, temperature = 0.2, maxTokens = 700 } = {}) {
  const status = await llmStatus();
  if (!status.available) return null;
  try {
    const res = await fetch(`${status.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: status.model,
        prompt,
        system,
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.response || '').trim() || null;
  } catch { return null; }
}

/**
 * Ask the local model to refine a deterministic extraction. Returns null when no
 * model is available so callers can fall back to the parser output.
 */
export async function refineExtraction({ title, text, entities }) {
  const status = await llmStatus();
  if (!status.available) return null;
  const sample = text.slice(0, 6000);
  const prompt = `Document title: ${title}

Text:
${sample}

Candidate entities found by a rule-based parser: ${entities.slice(0, 25).map((e) => e.name).join(', ')}

Return ONLY compact JSON of the form
{"entities":[{"name":"...","type":"person|organization|place|work|event|concept"}],
 "relations":[{"from":"...","relation":"...","to":"..."}]}
Keep only entities that are central to this text (max 15). Relation must be a short snake_case verb phrase (e.g. founded, part_of, influenced). Names must appear verbatim in the text.`;

  const raw = await llmGenerate(prompt, { system: 'You extract structured knowledge. Reply with JSON only.', maxTokens: 900 });
  if (!raw) return null;
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed.entities)) return null;
    return {
      entities: parsed.entities
        .filter((e) => e && typeof e.name === 'string' && e.name.trim())
        .slice(0, 20)
        .map((e) => ({ name: e.name.trim(), type: normalizeType(e.type) })),
      relations: Array.isArray(parsed.relations) ? parsed.relations
        .filter((r) => r && r.from && r.to && r.relation)
        .slice(0, 40)
        .map((r) => ({ from: String(r.from).trim(), to: String(r.to).trim(), rel: String(r.relation).trim().toLowerCase().replace(/\s+/g, '_') }))
        : [],
    };
  } catch { return null; }
}

function normalizeType(t) {
  const s = String(t || '').toLowerCase();
  return ['person', 'organization', 'place', 'work', 'event', 'concept'].includes(s) ? s : 'concept';
}
