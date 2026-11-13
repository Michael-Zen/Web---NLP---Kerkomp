/**
 * search.js
 * Logika halaman Beranda + Semantic Search:
 * state pencarian, panel kontrol, mode bandingkan, dan semua state UI
 * (kosong, loading, tidak ada hasil, error).
 */
import { api } from './api.js';
import {
  initLayout, setActiveNav, icon, escapeHtml, debounce,
  productCard, skeletonCards, stateBlock, CATEGORIES,
} from './components.js';

const EXAMPLE_QUERIES = [
  'sabun cuci muka untuk kulit berminyak',
  'sunscreen yang tidak lengket',
  'serum untuk bekas jerawat',
  'pelembap ringan untuk cuaca panas',
];

const MODE_LABEL = { semantic: 'Semantic', bm25: 'Keyword (BM25)' };
const MIN_AUTO_SEARCH_CHARS = 3;

// State halaman (sumber kebenaran tunggal)
const state = {
  query: '',
  mode: 'semantic',
  topK: 10,
  category: 'Semua',
  compare: false,
};

// Penanda request terbaru, supaya respons lama yang datang terlambat diabaikan
let requestSeq = 0;

const els = {
  form: document.getElementById('search-form'),
  input: document.getElementById('search-input'),
  clearBtn: document.getElementById('search-clear'),
  exampleBtn: document.getElementById('btn-example'),
  exampleChips: document.getElementById('example-chips'),
  modeGroup: document.getElementById('mode-group'),
  topK: document.getElementById('topk-select'),
  compareBtn: document.getElementById('compare-toggle'),
  categoryChips: document.getElementById('category-chips'),
  resetCategoryBtn: document.getElementById('btn-reset-category'),
  info: document.getElementById('results-info'),
  results: document.getElementById('results'),
};

/* ---------- Inisialisasi ---------- */
function init() {
  initLayout(location.hash === '#cari' ? 'search' : 'home', 'Semantic Search');

  // Ikon pada tombol statis
  els.clearBtn.innerHTML = icon('x', { size: 18 });
  els.exampleBtn.innerHTML = icon('wand', { size: 20 });
  els.resetCategoryBtn.innerHTML = icon('shapes', { size: 18 });
  els.compareBtn.innerHTML = `${icon('columns', { size: 16 })}<span>Bandingkan</span>`;

  readStateFromUrl();
  renderExampleChips();
  renderCategoryChips();
  syncControls();
  bindEvents();

  if (state.query) {
    els.input.value = state.query;
    toggleClearButton();
    runSearch();
  } else {
    renderEmpty();
  }

  if (location.hash === '#cari') els.input.focus();
}

/* ---------- URL <-> state (supaya tombol "kembali" dari halaman produk tetap rapi) ---------- */
function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  state.query = (p.get('q') || '').trim();
  if (p.get('mode') === 'bm25') state.mode = 'bm25';
  const k = Number(p.get('k'));
  if ([5, 10, 20].includes(k)) state.topK = k;
  const cat = p.get('cat');
  if (cat && CATEGORIES.includes(cat)) state.category = cat;
  state.compare = p.get('compare') === '1';
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.query) p.set('q', state.query);
  if (state.mode !== 'semantic') p.set('mode', state.mode);
  if (state.topK !== 10) p.set('k', String(state.topK));
  if (state.category !== 'Semua') p.set('cat', state.category);
  if (state.compare) p.set('compare', '1');
  const qs = p.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

/* ---------- Render kontrol ---------- */
function renderExampleChips() {
  const chips = EXAMPLE_QUERIES.map((q) =>
    `<button type="button" class="chip chip--example" data-query="${escapeHtml(q)}">${escapeHtml(q)}</button>`
  ).join('');
  els.exampleChips.insertAdjacentHTML('beforeend', chips);
}

function renderCategoryChips() {
  els.categoryChips.innerHTML = ['Semua', ...CATEGORIES].map((c) =>
    `<button type="button" class="chip" data-category="${c}" aria-pressed="${c === state.category}">${c}</button>`
  ).join('');
}

function syncControls() {
  els.modeGroup.querySelector(`input[value="${state.mode}"]`).checked = true;
  els.modeGroup.disabled = state.compare; // saat bandingkan, kedua mode dijalankan
  els.topK.value = String(state.topK);
  els.compareBtn.setAttribute('aria-pressed', String(state.compare));
  els.categoryChips.querySelectorAll('.chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.category === state.category));
  });
  els.resetCategoryBtn.disabled = state.category === 'Semua';
}

function toggleClearButton() {
  els.clearBtn.hidden = !els.input.value;
}

/* ---------- Event ---------- */
const debouncedSearch = debounce(() => {
  const q = els.input.value.trim();
  if (!q || q.length >= MIN_AUTO_SEARCH_CHARS) runSearch();
}, 450);

function bindEvents() {
  // Enter / tombol Cari -> langsung cari (batalkan debounce)
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    debouncedSearch.cancel();
    runSearch();
  });

  // Ketik -> debounce
  els.input.addEventListener('input', () => {
    toggleClearButton();
    debouncedSearch();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.input.value) {
      e.preventDefault();
      clearQuery();
    }
  });

  els.clearBtn.addEventListener('click', clearQuery);

  // Chip contoh kueri -> isi search bar + cari
  els.exampleChips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-query]');
    if (chip) fillAndSearch(chip.dataset.query);
  });

  // FAB tongkat ajaib -> contoh kueri acak (berbeda dari kueri sekarang)
  els.exampleBtn.addEventListener('click', () => {
    const options = EXAMPLE_QUERIES.filter((q) => q !== els.input.value.trim());
    fillAndSearch(options[Math.floor(Math.random() * options.length)]);
  });

  els.modeGroup.addEventListener('change', (e) => {
    state.mode = e.target.value;
    rerunIfQuery();
  });

  els.topK.addEventListener('change', () => {
    state.topK = Number(els.topK.value);
    rerunIfQuery();
  });

  els.compareBtn.addEventListener('click', () => {
    state.compare = !state.compare;
    syncControls();
    rerunIfQuery();
  });

  els.categoryChips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    setCategory(chip.dataset.category);
  });

  els.resetCategoryBtn.addEventListener('click', () => setCategory('Semua'));

  // Tombol aksi di dalam state block (coba lagi, hapus filter, dll.)
  els.results.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'retry') runSearch();
    if (action === 'reset-category') setCategory('Semua');
    if (action === 'use-semantic') { state.mode = 'semantic'; syncControls(); runSearch(); }
    if (action === 'example') fillAndSearch(EXAMPLE_QUERIES[0]);
    if (action === 'focus') els.input.focus();
  });

  // Ikon "Search" di navigasi pill -> fokus ke search bar
  window.addEventListener('hashchange', () => {
    if (location.hash === '#cari') {
      setActiveNav('search');
      els.input.focus();
    } else {
      setActiveNav('home');
    }
  });
}

function fillAndSearch(query) {
  els.input.value = query;
  toggleClearButton();
  debouncedSearch.cancel();
  runSearch();
}

function clearQuery() {
  els.input.value = '';
  toggleClearButton();
  debouncedSearch.cancel();
  runSearch(); // kueri kosong -> state kosong
  els.input.focus();
}

function setCategory(category) {
  state.category = category;
  syncControls();
  if (state.query) runSearch();
  else { syncUrl(); renderEmpty(); }
}

function rerunIfQuery() {
  if (els.input.value.trim()) runSearch();
  else syncUrl();
}

/* ---------- Pencarian ---------- */
async function runSearch() {
  const query = els.input.value.trim();
  state.query = query;
  syncUrl();

  if (!query) {
    renderEmpty();
    return;
  }

  const seq = ++requestSeq;
  renderLoading();

  const params = {
    query,
    topK: state.topK,
    category: state.category === 'Semua' ? '' : state.category,
  };

  try {
    if (state.compare) {
      const [semantic, bm25] = await Promise.all([
        api.search({ ...params, mode: 'semantic' }),
        api.search({ ...params, mode: 'bm25' }),
      ]);
      if (seq !== requestSeq) return;
      renderCompare(query, semantic, bm25);
    } else {
      const data = await api.search({ ...params, mode: state.mode });
      if (seq !== requestSeq) return;
      renderResults(query, data);
    }
  } catch (err) {
    if (seq !== requestSeq) return;
    renderError(err);
  } finally {
    if (seq === requestSeq) els.results.setAttribute('aria-busy', 'false');
  }
}

/* ---------- Render state ---------- */
function setInfo(html) {
  els.info.hidden = !html;
  els.info.innerHTML = html || '';
}

const sep = '<span class="sep" aria-hidden="true">·</span>';

function categoryInfo() {
  return state.category !== 'Semua' ? `${sep}<span>kategori ${escapeHtml(state.category)}</span>` : '';
}

// State kosong (sebelum mencari) + katalog sebagai inspirasi
async function renderEmpty() {
  const seq = ++requestSeq;
  setInfo('');
  els.results.setAttribute('aria-busy', 'false');

  const label = state.category === 'Semua' ? 'Semua produk' : state.category;
  els.results.innerHTML = `
    ${stateBlock({
      iconName: 'sparkles',
      title: 'Mulai dengan menuliskan kebutuhan kulitmu',
      text: 'Sebutkan jenis produk, jenis kulit, atau keluhanmu dalam bahasa sehari-hari. Contoh: "pelembap ringan untuk cuaca panas".',
      actions: [
        { label: 'Coba contoh kueri', action: 'example', variant: 'inverted', icon: 'wand' },
        { label: 'Ketik kueri', action: 'focus', variant: 'secondary', icon: 'pencil' },
      ],
    })}
    <section class="catalog" aria-labelledby="catalog-title">
      <div class="catalog__head">
        <div>
          <span class="eyebrow">Jelajahi katalog</span>
          <h3 class="section-title" id="catalog-title">${escapeHtml(label)}</h3>
        </div>
        <span class="meta-chip" id="catalog-meta"></span>
      </div>
      <div class="results-grid" id="catalog-grid">${skeletonCards(3)}</div>
    </section>`;

  try {
    const data = await api.getProducts(state.category === 'Semua' ? '' : state.category);
    if (seq !== requestSeq) return;
    const grid = document.getElementById('catalog-grid');
    document.getElementById('catalog-meta').textContent = `${data.total} produk · ${data.latency_ms} ms`;
    grid.innerHTML = data.products.length
      ? data.products.slice(0, 6).map((p) => productCard(p)).join('')
      : '<p class="state__text">Belum ada produk di katalog. Isi file data/products.json dengan dataset kamu.</p>';
  } catch {
    if (seq !== requestSeq) return;
    const grid = document.getElementById('catalog-grid');
    if (grid) grid.outerHTML = '<p class="state__text">Katalog belum bisa dimuat.</p>';
  }
}

function renderLoading() {
  els.results.setAttribute('aria-busy', 'true');
  setInfo(`<span>Mencari produk yang paling relevan…</span>`);
  const n = Math.min(state.topK, 6);
  if (state.compare) {
    const col = (mode) => `
      <section class="compare-col compare-col--${mode}">
        <div class="compare-col__head"><span class="compare-col__title"><span class="compare-col__dot"></span>${MODE_LABEL[mode]}</span></div>
        <div class="compare-list">${skeletonCards(2)}</div>
      </section>`;
    els.results.innerHTML = `<div class="compare-grid">${col('semantic')}${col('bm25')}</div>`;
  } else {
    els.results.innerHTML = `<div class="results-grid">${skeletonCards(n)}</div>`;
  }
}

function renderResults(query, data) {
  const results = data.results || [];
  if (!results.length) {
    renderNoResults(query, data);
    return;
  }

  const extra = data.total > results.length ? ` dari ${data.total} kandidat` : '';
  setInfo(`
    <span><strong>${results.length} hasil</strong>${extra} untuk “${escapeHtml(query)}”</span>
    ${sep}<span>${data.latency_ms} ms</span>
    ${sep}<span>mode ${MODE_LABEL[state.mode]}</span>
    ${categoryInfo()}`);

  els.results.innerHTML = `<div class="results-grid">
    ${results.map((r, i) => productCard(r, { mode: state.mode, rank: i + 1, query })).join('')}
  </div>`;
}

function renderNoResults(query, data) {
  setInfo(`<span><strong>0 hasil</strong> untuk “${escapeHtml(query)}”</span>${sep}<span>${data.latency_ms} ms</span>${sep}<span>mode ${MODE_LABEL[state.mode]}</span>${categoryInfo()}`);

  const actions = [];
  if (state.category !== 'Semua') actions.push({ label: 'Hapus filter kategori', action: 'reset-category', variant: 'secondary', icon: 'shapes' });
  if (state.mode === 'bm25') actions.push({ label: 'Coba mode Semantic', action: 'use-semantic', variant: 'primary', icon: 'sparkles' });
  actions.push({ label: 'Ubah kueri', action: 'focus', variant: 'outlined', icon: 'pencil' });

  els.results.innerHTML = stateBlock({
    iconName: 'searchX',
    tone: 'muted',
    title: 'Tidak ada produk yang cocok',
    text: state.mode === 'bm25'
      ? 'Keyword search hanya menemukan produk yang memuat kata yang sama persis. Coba mode Semantic atau gunakan kata lain.'
      : 'Coba gunakan kata yang lebih umum, sebutkan jenis kulit, atau hapus filter kategori.',
    actions,
  });
}

function renderError(err) {
  setInfo('');
  els.results.innerHTML = stateBlock({
    iconName: 'alert',
    tone: 'danger',
    title: 'Pencarian gagal dimuat',
    text: err && err.message ? err.message : 'Terjadi kesalahan yang tidak diketahui.',
    actions: [{ label: 'Coba lagi', action: 'retry', variant: 'inverted', icon: 'refresh' }],
  });
}

// Mode bandingkan: dua kolom Semantic vs BM25
function renderCompare(query, semantic, bm25) {
  setInfo(`
    <span><strong>Mode bandingkan</strong> untuk “${escapeHtml(query)}”</span>
    ${sep}<span>Semantic ${semantic.latency_ms} ms</span>
    ${sep}<span>BM25 ${bm25.latency_ms} ms</span>
    ${categoryInfo()}`);

  const column = (mode, data) => {
    const results = data.results || [];
    const body = results.length
      ? `<div class="compare-list">${results.map((r, i) => productCard(r, { mode, rank: i + 1, compact: true, query })).join('')}</div>`
      : stateBlock({
          iconName: 'searchX',
          tone: 'muted',
          compact: true,
          title: 'Tidak ada hasil',
          text: mode === 'bm25' ? 'Tidak ada produk yang memuat kata kueri secara persis.' : 'Tidak ada produk yang cukup mirip secara makna.',
        });
    return `
      <section class="compare-col compare-col--${mode}" aria-label="Hasil ${MODE_LABEL[mode]}">
        <div class="compare-col__head">
          <h3 class="compare-col__title"><span class="compare-col__dot" aria-hidden="true"></span>${MODE_LABEL[mode]}</h3>
          <span class="meta-chip">${results.length} hasil · ${data.latency_ms} ms</span>
        </div>
        ${body}
      </section>`;
  };

  els.results.innerHTML = `<div class="compare-grid">${column('semantic', semantic)}${column('bm25', bm25)}</div>`;
}

init();
