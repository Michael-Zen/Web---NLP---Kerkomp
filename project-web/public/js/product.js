/**
 * product.js
 * Logika halaman Detail Produk + Tanya Produk (QA berbasis ulasan):
 * memuat produk, mengirim pertanyaan, menampilkan jawaban + bukti,
 * state no-answer, dan riwayat pertanyaan sesi ini.
 */
import { api } from './api.js';
import {
  APP_NAME, RETRIEVER_LABELS, initLayout, icon, escapeHtml, debounce, formatRupiah,
  formatScore, highlightSpan, productThumb, categoryTag, scoreBar, stateBlock,
} from './components.js';

const EXAMPLE_QUESTIONS = [
  'Does it feel greasy?',
  'Is it good for sensitive skin?',
  'How does it smell?',
  'Does it leave a white cast?',
];

const MAX_LEN = 300;

// Kata umum bahasa Indonesia — untuk memberi petunjuk bahwa model memakai bahasa Inggris
const ID_HINT_WORDS = ['apakah', 'apa', 'tidak', 'kulit', 'bagaimana', 'untuk', 'yang', 'bikin', 'lengket', 'berminyak', 'cocok', 'bau', 'wangi'];

const productId = new URLSearchParams(location.search).get('id');

const state = {
  product: null,
  retriever: 'domain',
  k: 3,
  loading: false,
  history: [], // disimpan di memori saja (hilang saat halaman ditutup)
};

let requestSeq = 0;

const els = {
  back: document.getElementById('back-link'),
  info: document.getElementById('product-info'),
  note: document.getElementById('qa-note'),
  form: document.getElementById('qa-form'),
  input: document.getElementById('qa-input'),
  count: document.getElementById('qa-count'),
  langHint: document.getElementById('lang-hint'),
  submit: document.getElementById('qa-submit'),
  chips: document.getElementById('question-chips'),
  advancedSummary: document.getElementById('advanced-summary'),
  result: document.getElementById('qa-result'),
  historyTitle: document.getElementById('history-title'),
  historyClear: document.getElementById('history-clear'),
  history: document.getElementById('history'),
};

/* ---------- Inisialisasi ---------- */
function init() {
  initLayout('search', 'Tanya Produk');

  els.back.innerHTML = `${icon('arrowLeft', { size: 18 })}<span>Kembali ke hasil pencarian</span>`;
  els.note.innerHTML = `${icon('info', { size: 16 })}<span>Pertanyaan dalam bahasa Inggris. Jawaban diambil dari ulasan konsumen, bukan saran medis.</span>`;
  els.historyTitle.innerHTML = `${icon('history', { size: 18 })}<span>Riwayat pertanyaan</span>`;
  els.historyClear.innerHTML = icon('trash', { size: 16 });
  setSubmitLabel(false);
  updateAdvancedSummary();

  els.chips.innerHTML = EXAMPLE_QUESTIONS.map((q) =>
    `<button type="button" class="chip chip--example" data-question="${escapeHtml(q)}">${escapeHtml(q)}</button>`
  ).join('');

  bindEvents();
  renderHistory();
  renderIdle();
  loadProduct();
}

/* ---------- Produk ---------- */
async function loadProduct() {
  if (!productId) {
    renderProductError('ID produk tidak ada di URL. Buka produk dari halaman pencarian.');
    return;
  }
  try {
    const { product } = await api.getProduct(productId);
    state.product = product;
    renderProduct(product);
    updateSubmitState();
  } catch (err) {
    renderProductError(err.message);
  }
}

function renderProduct(p) {
  document.title = `${p.name} · ${APP_NAME}`;
  els.info.setAttribute('aria-busy', 'false');
  els.info.innerHTML = `
    ${productThumb(p, { size: 'lg' })}
    <div class="product-info__body">
      <div class="product-info__meta">
        ${categoryTag(p.category)}
        <a class="fab fab--tertiary fab--sm" href="index.html?cat=${encodeURIComponent(p.category)}"
           aria-label="Lihat produk lain di kategori ${escapeHtml(p.category)}" title="Produk lain di kategori ini">
          ${icon('tag', { size: 16 })}
        </a>
      </div>
      <h1 class="product-info__name">${escapeHtml(p.name)}</h1>
      <p class="product-info__brand">${escapeHtml(p.brand)}</p>
      <p class="product-info__price">${formatRupiah(p.price)}</p>
      <p class="product-info__desc">${escapeHtml(p.description)}</p>
      <dl class="facts">
        <div><dt>Ukuran</dt><dd>${escapeHtml(p.size || '—')}</dd></div>
        <div><dt>Jenis kulit</dt><dd>${escapeHtml((p.skin_types || []).slice(0, 2).join(', ') || '—')}</dd></div>
        <div><dt>Ulasan tersedia</dt><dd>${p.review_count} ulasan</dd></div>
      </dl>
    </div>`;
}

function renderProductError(message) {
  els.info.setAttribute('aria-busy', 'false');
  els.info.innerHTML = stateBlock({
    iconName: 'alert',
    tone: 'danger',
    compact: true,
    title: 'Produk tidak dapat dimuat',
    text: message,
  });
  els.input.disabled = true;
  els.chips.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  updateSubmitState();
}

/* ---------- Form ---------- */
function setSubmitLabel(loading) {
  els.submit.innerHTML = loading
    ? `${icon('clock', { size: 18 })}<span>Mencari jawaban…</span>`
    : `${icon('send', { size: 18 })}<span>Tanya</span>`;
}

function updateSubmitState() {
  const len = els.input.value.trim().length;
  els.submit.disabled = !state.product || state.loading || len < 3;
}

function updateAdvancedSummary() {
  els.advancedSummary.innerHTML = `
    ${icon('sliders', { size: 18 })}
    <span>Pengaturan lanjutan</span>
    <span class="advanced__summary-meta">· ${RETRIEVER_LABELS[state.retriever]} · K = ${state.k}</span>
    ${icon('chevronDown', { size: 18, className: 'chev' })}`;
}

// Debounce: hitung karakter & cek petunjuk bahasa setelah pengguna berhenti mengetik
const debouncedInputCheck = debounce(() => {
  const value = els.input.value;
  els.count.textContent = `${value.length}/${MAX_LEN}`;
  const words = value.toLowerCase().split(/[^a-z]+/);
  const looksIndonesian = words.some((w) => ID_HINT_WORDS.includes(w));
  els.langHint.hidden = !looksIndonesian;
  if (looksIndonesian) {
    els.langHint.innerHTML = `${icon('alert', { size: 14 })}<span>Sepertinya bukan bahasa Inggris. Model QA memakai ulasan berbahasa Inggris.</span>`;
  }
}, 250);

function bindEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    ask();
  });

  els.input.addEventListener('input', () => {
    updateSubmitState();
    debouncedInputCheck();
  });

  // Enter = kirim, Shift+Enter = baris baru
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask();
    }
  });

  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-question]');
    if (!chip) return;
    setQuestion(chip.dataset.question);
    ask();
  });

  els.form.addEventListener('change', (e) => {
    if (e.target.name === 'retriever') state.retriever = e.target.value;
    if (e.target.name === 'k') state.k = Number(e.target.value);
    updateAdvancedSummary();
  });

  els.result.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn && btn.dataset.action === 'retry') ask();
  });

  // Tombol pensil di riwayat -> isi ulang pertanyaan untuk diedit
  els.history.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (!btn) return;
    const item = state.history[Number(btn.dataset.edit)];
    if (!item) return;
    setQuestion(item.question);
    els.input.focus();
    els.input.setSelectionRange(els.input.value.length, els.input.value.length);
    els.input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  els.historyClear.addEventListener('click', () => {
    state.history = [];
    renderHistory();
  });
}

function setQuestion(text) {
  els.input.value = text;
  updateSubmitState();
  debouncedInputCheck();
}

/* ---------- QA ---------- */
async function ask() {
  const question = els.input.value.trim();
  if (!state.product || question.length < 3) {
    els.input.focus();
    return;
  }

  const seq = ++requestSeq;
  state.loading = true;
  setSubmitLabel(true);
  updateSubmitState();
  renderLoading();

  const params = { productId: state.product.id, question, retriever: state.retriever, k: state.k };

  try {
    const data = await api.ask(params);
    if (seq !== requestSeq) return;
    renderAnswer(data, params);
    addHistory(question, data, params);
  } catch (err) {
    if (seq !== requestSeq) return;
    renderError(err);
  } finally {
    if (seq === requestSeq) {
      state.loading = false;
      setSubmitLabel(false);
      updateSubmitState();
      els.result.setAttribute('aria-busy', 'false');
    }
  }
}

function confidenceBadge(conf) {
  const level = conf >= 0.75 ? 'high' : conf >= 0.5 ? 'medium' : 'low';
  return `<span class="badge badge--${level}">Confidence ${formatScore(conf)}</span>`;
}

function renderIdle() {
  els.result.innerHTML = '';
}

function renderLoading() {
  els.result.setAttribute('aria-busy', 'true');
  els.result.innerHTML = `
    <div class="answer-card" aria-hidden="true">
      <span class="skeleton skeleton--line skeleton--w40"></span>
      <span class="skeleton skeleton--title"></span>
      <span class="skeleton skeleton--line skeleton--w60"></span>
    </div>
    <h3 class="evidence-title">${icon('quote', { size: 16 })}<span>Mengambil ulasan yang relevan…</span></h3>
    <div class="evidence-list">
      ${Array.from({ length: Math.min(state.k, 3) }, () => `
        <div class="evidence-card" aria-hidden="true">
          <span class="skeleton skeleton--line skeleton--w40"></span>
          <span class="skeleton skeleton--block"></span>
          <span class="skeleton skeleton--bar"></span>
        </div>`).join('')}
    </div>`;
}

function evidenceCard(ev, index, { answerable }) {
  const isPrimary = answerable && index === 0;
  const text = answerable ? highlightSpan(ev.text, ev.answer_start, ev.answer_end) : escapeHtml(ev.text);
  return `
    <li class="evidence-card${isPrimary ? ' is-primary' : ''}">
      <div class="evidence-card__head">
        ${isPrimary ? '<span class="badge badge--evidence">Bukti utama</span>' : `<span class="badge badge--muted">#${index + 1}</span>`}
        <span class="review-id">${escapeHtml(ev.review_id)}</span>
        ${ev.rating ? `<span class="stars" aria-label="Rating ${ev.rating} dari 5">★ ${ev.rating}/5</span>` : ''}
      </div>
      <p class="evidence-card__text" lang="en">${text}</p>
      ${scoreBar(ev.score, 'qa', 'Skor relevansi')}
    </li>`;
}

function renderAnswer(data, params) {
  const meta = `
    <div class="answer-card__meta">
      ${data.answerable ? confidenceBadge(data.confidence) : '<span class="badge badge--low">Tidak terjawab</span>'}
      <span class="meta-chip">${icon('clock', { size: 14 })}${data.latency_ms} ms</span>
    </div>`;
  const settings = `Retriever: ${RETRIEVER_LABELS[params.retriever]} · K = ${params.k}`;
  const evidence = data.evidence || [];

  if (data.answerable) {
    const top = evidence[0];
    els.result.innerHTML = `
      <article class="answer-card" aria-label="Jawaban">
        <div class="answer-card__head">
          <span class="eyebrow answer-card__label">${icon('sparkles', { size: 14 })}Jawaban</span>
          ${meta}
        </div>
        <p class="answer-card__text" lang="en">“${escapeHtml(data.answer)}”</p>
        <p class="answer-card__foot">${settings}${top ? ` · diekstrak dari ulasan ${escapeHtml(top.review_id)}` : ''}</p>
      </article>
      <h3 class="evidence-title">${icon('quote', { size: 16 })}<span>Bukti ulasan (${evidence.length})</span></h3>
      <ol class="evidence-list">${evidence.map((ev, i) => evidenceCard(ev, i, { answerable: true })).join('')}</ol>`;
    return;
  }

  // State no-answer: kartu netral + ulasan paling mendekati (redup)
  els.result.innerHTML = `
    <article class="answer-card answer-card--empty" aria-label="Jawaban tidak ditemukan">
      <div class="answer-card__head">
        <span class="eyebrow" style="color:var(--color-text-secondary-strong)">Hasil</span>
        ${meta}
      </div>
      <div class="no-answer">
        <span class="no-answer__icon">${icon('info', { size: 22 })}</span>
        <div>
          <p class="no-answer__title">Informasi tidak ditemukan dalam ulasan yang tersedia.</p>
          <p class="no-answer__text">Coba ubah kata dalam pertanyaan, naikkan nilai K, atau ganti retriever di pengaturan lanjutan.</p>
        </div>
      </div>
      <p class="answer-card__foot">${settings}</p>
    </article>
    ${evidence.length ? `
      <h3 class="evidence-title">${icon('quote', { size: 16 })}<span>Ulasan yang paling mendekati</span></h3>
      <ol class="evidence-list is-dim">${evidence.map((ev, i) => evidenceCard(ev, i, { answerable: false })).join('')}</ol>` : ''}`;
}

function renderError(err) {
  els.result.innerHTML = `
    <div class="qa-error" role="alert">
      ${icon('alert', { size: 18 })}
      <div>
        <p>Gagal mengambil jawaban. ${escapeHtml(err.message || '')}</p>
        <button type="button" class="btn btn--inverted btn--sm" data-action="retry" style="margin-top:8px">
          ${icon('refresh', { size: 14 })}<span>Coba lagi</span>
        </button>
      </div>
    </div>`;
}

/* ---------- Riwayat ---------- */
function addHistory(question, data, params) {
  state.history.unshift({
    question,
    answerable: data.answerable,
    answer: data.answer,
    retriever: params.retriever,
    k: params.k,
    time: new Date(),
  });
  state.history = state.history.slice(0, 20);
  renderHistory();
}

function renderHistory() {
  els.historyClear.disabled = state.history.length === 0;
  if (!state.history.length) {
    els.history.innerHTML = '<p class="history-empty">Belum ada pertanyaan di sesi ini.</p>';
    return;
  }
  const fmt = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });
  els.history.innerHTML = `<ul class="history-list">
    ${state.history.map((h, i) => `
      <li class="history-item">
        <div class="history-item__body">
          <p class="history-q" lang="en">${escapeHtml(h.question)}</p>
          <p class="history-a ${h.answerable ? 'history-a--ok' : ''}">
            ${h.answerable ? `“${escapeHtml(h.answer)}”` : 'Informasi tidak ditemukan'}
            · ${RETRIEVER_LABELS[h.retriever]} · K=${h.k} · ${fmt.format(h.time)}
          </p>
        </div>
        <button type="button" class="icon-btn-square" data-edit="${i}"
                aria-label="Edit pertanyaan: ${escapeHtml(h.question)}" title="Edit pertanyaan">
          ${icon('pencil', { size: 16 })}
        </button>
      </li>`).join('')}
  </ul>`;
}

init();
