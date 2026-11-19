import { api, relTime } from '../api.js';
import { el, toast, spinner, ICON, svg } from '../ui.js';

const thread = [];

export async function renderAsk(root) {
  const shell = el('div', { class: 'ask-shell' });
  const scroll = el('div', { class: 'ask-scroll' });
  const list = el('div', { class: 'ask-thread' });
  scroll.append(list);

  const input = el('textarea', { rows: '1', placeholder: 'Ask your knowledge base…', 'aria-label': 'Question' });
  const sendBtn = el('button', { class: 'btn primary send', type: 'button', text: 'Ask' }, svg(ICON.arrow));

  const composer = el('div', { class: 'composer' },
    el('div', { class: 'composer-inner' }, input, sendBtn),
    el('div', { class: 'composer-note', id: 'ask-note' },
      el('span', { text: 'Retrieval: hybrid BM25 + vector' }),
      el('span', { text: 'Answers cite the passages they came from' })),
  );

  shell.append(scroll, composer);
  root.append(shell);

  paintIntro();

  async function ask(question) {
    const q = question.trim();
    if (!q) return;
    input.value = '';
    autosize();
    const previous = thread[thread.length - 1];
    if (!previous || previous.answer || previous.pending) thread.push({ question: q, answer: null, pending: true });
    else previous.question = q;
    paintIntro();
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });

    try {
      const res = await api.ask(q);
      thread[thread.length - 1] = { question: q, answer: res };
      paintIntro();
      if (res.llm && !res.llm.available && res.mode === 'extractive') {
        document.getElementById('ask-note').firstChild.textContent = 'No local model detected — answering extractively';
      }
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });
    } catch (err) {
      thread[thread.length - 1] = { question: q, answer: { error: err.message } };
      paintIntro();
      toast(err.message, 'error');
    }
  }

  function paintIntro() {
    if (thread.length) {
      list.replaceChildren(...thread.map((t) => renderQA(t)));
      return;
    }
    list.replaceChildren(el('div', { class: 'ask-intro' },
      el('div', { class: 'eyebrow', text: 'Retrieval-augmented' }),
      el('h1', { text: 'Ask Loom' }),
      el('p', { text: 'Questions are answered strictly from what you have ingested. Citations point at the passages, so you can check every sentence.' }),
      el('div', { class: 'suggestions' },
        ['Who founded the organizations in my graph?', 'How is the semantic web related to knowledge graphs?', 'What does my memory disagree about?'].map((s) =>
          el('button', { class: 'suggestion', type: 'button', text: s, onclick: () => ask(s) }))),
    ));
  }

  function renderQA(entry) {
    const { question, answer } = entry;
    const node = el('div', { class: 'qa' },
      el('div', { class: 'q-line' }, el('div', { class: 'q-avatar', text: 'You' }), el('div', { class: 'q-text', text: question })));
    if (answer && answer.error) {
      node.append(el('div', { class: 'a-card' }, el('span', { class: 'status contested', text: 'failed' }), el('span', { text: answer.error })));
      return node;
    }
    if (!answer) {
      if (entry.pending) node.append(el('div', { class: 'a-card', style: 'display:flex;gap:10px;align-items:center' }, spinner(), el('span', { class: 'muted', text: 'Searching your corpus…' })));
      return node;
    }

    const mode = answer.mode === 'llm' ? `local model · ${answer.model || 'ollama'}` : answer.mode === 'extractive' ? 'extractive · no model' : 'no match';
    const card = el('div', { class: 'a-card' },
      el('div', { class: 'a-head' },
        el('i', { class: 'type-dot t-place' }),
        el('span', { text: mode }),
        answer.tookMs ? el('span', { text: `${answer.tookMs} ms` }) : null));

    const body = el('div', { class: 'a-body' });
    appendAnswer(body, answer.answer, answer.sources || []);
    card.append(body);

    if (answer.sources?.length) {
      card.append(el('div', { class: 'a-sources' }, answer.sources.map((s, i) => {
        const row = el('button', { class: 'src-row', type: 'button' },
          el('span', { class: 'src-n', text: `[${i + 1}]` }),
          el('span', { class: 'src-title', text: s.title }),
          el('span', { class: 'src-domain', text: s.domain || 'local' }));
        row.addEventListener('click', () => { location.hash = `#/library/${s.docId}`; });
        return row;
      })));
    }

    if (answer.facts?.length) {
      card.append(el('div', { class: 'a-sources', style: 'margin-top:8px' },
        answer.facts.slice(0, 4).map((f) => el('div', { class: 'src-row', style: 'cursor:default' },
          el('span', { class: 'src-n', text: '◆' }),
          el('span', { class: 'src-title', text: `${f.subject_name} ${f.label} ${f.object_name || f.object}` }),
          el('span', { class: 'src-domain', text: `${Math.round(f.confidence * 100)}%` })))));
    }

    node.append(card);
    return node;
  }

  /** Render text with [n] citation chips, as text nodes only. */
  function appendAnswer(host, text, sources) {
    const parts = String(text || '').split(/(\[\d+\])/g);
    for (const part of parts) {
      const m = /^\[(\d+)\]$/.exec(part);
      if (m) {
        const idx = Number(m[1]) - 1;
        const chip = el('button', { class: 'cite', type: 'button', text: m[1], title: sources[idx]?.title || 'source' });
        chip.addEventListener('click', () => { if (sources[idx]) location.hash = `#/library/${sources[idx].docId}`; });
        host.append(chip);
      } else if (part) {
        host.append(document.createTextNode(part));
      }
    }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, input.scrollHeight)}px`;
  }

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
  });
  sendBtn.addEventListener('click', () => ask(input.value));
  input.focus();

  return () => {};
}
