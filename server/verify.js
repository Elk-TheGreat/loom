// Claim verification. A claim gets stronger when independent sources agree on it,
// stronger still when those sources are trustworthy, and weaker when sources conflict.

export const PREDICATE_LABELS = {
  is_a: 'is a',
  related_to: 'is related to',
  founded: 'founded',
  born_in: 'born in',
  born: 'born',
  located_in: 'located in',
  part_of: 'part of',
  studied_at: 'studied at',
  worked_for: 'worked for',
  led: 'led',
  created: 'created',
  influenced: 'influenced',
  based_on: 'based on',
  succeeded: 'succeeded',
  spouse: 'married',
  capital_of: 'capital of',
  uses: 'uses',
  caused: 'caused',
  opposed: 'opposed',
  member_of: 'member of',
  owns: 'owns',
};

export function labelFor(predicate) {
  return PREDICATE_LABELS[predicate] || predicate.replace(/_/g, ' ');
}

export function confidenceFor({ supports = 1, domains = [], trust = 0.5, hasConflict = false }) {
  const distinct = new Set(domains.filter(Boolean));
  let c = 0.28 + 0.16 * Math.min(supports, 4) + 0.28 * Math.min(trust, 1) + 0.09 * Math.min(distinct.size - 1, 3);
  if (hasConflict) c -= 0.3;
  return Math.max(0.05, Math.min(0.97, c));
}

export function statusFor({ supports, domains, confidence, hasConflict }) {
  if (hasConflict) return 'contested';
  const distinct = new Set(domains.filter(Boolean));
  if (distinct.size >= 2 && confidence >= 0.68) return 'verified';
  if (supports >= 2 || confidence >= 0.6) return 'supported';
  return 'single-source';
}

export const STATUS_ORDER = { verified: 4, supported: 3, 'single-source': 2, contested: 1, rejected: 0 };

export function freshness(iso, halfLifeDays = 180) {
  if (!iso) return 0;
  const age = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (!Number.isFinite(age)) return 0;
  return Math.exp(-Math.max(0, age) / halfLifeDays);
}

// Memory decay: an unreinforced claim slowly loses its pull on retrieval,
// but never drops below a floor so nothing is silently forgotten.
export function recallWeight({ confidence, last_seen, status }) {
  if (status === 'rejected') return 0;
  const f = freshness(last_seen, 90);
  const base = confidence * (0.55 + 0.45 * f);
  return status === 'contested' ? base * 0.6 : base;
}
