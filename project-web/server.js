/**
 * server.js
 * Server Express untuk prototipe UI:
 *  - menyajikan file statis di folder /public
 *  - menyediakan API dummy di /api/* (nanti diganti backend model asli, mis. FastAPI/Flask)
 *
 * Semua "skor" di sini hanyalah simulasi berbasis kecocokan kata + sedikit acak,
 * BUKAN embedding / model sungguhan. Tujuannya hanya agar UI terlihat realistis.
 */
const express = require('express');
const path = require('path');

const products = require('./data/products.json');
const reviews = require('./data/reviews.json');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
 * Utilitas umum
 * ========================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Delay acak 150–400 ms supaya loading state di UI terlihat
const randomDelay = () => 150 + Math.floor(Math.random() * 251);
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// "Acak" tapi konsisten untuk input yang sama (hash FNV-1a -> 0..1)
function seededRandom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Normalisasi teks: huruf kecil, buang tanda baca, rapikan spasi
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stopword sederhana (Indonesia + sedikit Inggris) untuk pencarian
const SEARCH_STOPWORDS = new Set([
  'yang', 'untuk', 'dan', 'di', 'ke', 'dari', 'dengan', 'ini', 'itu', 'atau', 'juga',
  'saya', 'aku', 'buat', 'bagi', 'pada', 'agar', 'supaya', 'bisa', 'ada', 'lebih',
  'sangat', 'yg', 'utk', 'tidak', 'tanpa', 'cocok', 'produk', 'the', 'a', 'an', 'for',
  'and', 'of', 'to', 'with', 'my', 'is', 'dalam', 'jadi', 'tapi', 'karena', 'akan',
]);

function tokenize(text, stopwords = SEARCH_STOPWORDS) {
  return normalize(text)
    .split(' ')
    .filter((t) => t.length > 1 && !stopwords.has(t));
}

// Pecah teks jadi kalimat beserta offset karakter aslinya.
// Titik dianggap akhir kalimat hanya jika diikuti spasi/akhir teks (supaya "0.5%" aman).
function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isEnd = /[.!?]/.test(ch) && (i === text.length - 1 || /\s/.test(text[i + 1]));
    if (isEnd || i === text.length - 1) {
      const raw = text.slice(start, i + 1);
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (trimmed) out.push({ text: trimmed, start: start + lead, end: start + lead + trimmed.length });
      start = i + 1;
    }
  }
  return out;
}

// Pembungkus endpoint: delay acak + latency_ms + penanganan error seragam
function endpoint(handler) {
  return async (req, res) => {
    const t0 = Date.now();
    try {
      await sleep(randomDelay());
      const body = await handler(req);
      res.json({ ...body, latency_ms: Date.now() - t0 });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      res.status(status).json({
        error: err.message || 'Terjadi kesalahan pada server.',
        latency_ms: Date.now() - t0,
      });
    }
  };
}

/* =========================================================
 * Data produk
 * ========================================================= */

const CATEGORY_IDS = new Set(['cleanser', 'toner', 'serum', 'moisturizer', 'sunscreen', 'exfoliator']);

const reviewCount = (id) => (reviews[id] || []).length;
const toPublicProduct = (p) => ({ ...p, review_count: reviewCount(p.id) });

function parseCategory(category) {
  const c = String(category || '').trim().toLowerCase();
  if (!c || c === 'semua' || c === 'all') return '';
  if (!CATEGORY_IDS.has(c)) throw new HttpError(400, `Kategori "${category}" tidak dikenal.`);
  return c;
}

/* =========================================================
 * Simulasi "semantic" search: kamus konsep/sinonim.
 * Kueri & produk dipetakan ke konsep; skor = cakupan konsep kueri.
 * (Nanti diganti custom embedding + cosine similarity.)
 * ========================================================= */

const CONCEPTS = {
  cleanser: ['sabun cuci muka', 'sabun muka', 'cuci muka', 'pembersih wajah', 'pembersih', 'facial wash', 'face wash', 'cleanser', 'foam', 'busa', 'sabun'],
  toner: ['toner', 'penyegar'],
  serum: ['serum', 'essence', 'ampoule'],
  moisturizer: ['pelembap', 'pelembab', 'moisturizer', 'moisturiser', 'krim', 'cream'],
  sunscreen: ['sunscreen', 'tabir surya', 'sunblock', 'spf', 'sun'],
  exfoliator: ['eksfoliasi', 'eksfoliator', 'exfoliator', 'exfoliant', 'peeling', 'scrub', 'pengelupasan', 'aha', 'bha'],
  oily: ['berminyak', 'minyak', 'oily', 'sebum', 'kilap', 'mengkilap'],
  dry: ['kulit kering', 'kering', 'dry', 'bersisik', 'dehidrasi'],
  sensitive: ['sensitif', 'sensitive', 'kemerahan', 'iritasi', 'menenangkan', 'calming', 'soothing', 'redness'],
  acne: ['berjerawat', 'jerawat', 'acne', 'breakout', 'blemish', 'beruntusan'],
  acne_scar: ['bekas jerawat', 'noda hitam', 'flek', 'hiperpigmentasi', 'pigmentasi', 'dark spot', 'noda'],
  bright: ['mencerahkan', 'cerah', 'glow', 'glowing', 'kusam', 'brightening'],
  light: ['tidak lengket', 'lengket', 'ringan', 'lightweight', 'cepat meresap', 'tidak berat', 'airy', 'gel'],
  hot: ['cuaca panas', 'panas', 'tropis', 'gerah', 'humid'],
  hydra: ['hidrasi', 'melembapkan', 'hydrating', 'terhidrasi', 'hyaluronic', 'lembap'],
  pores: ['pori pori', 'pori', 'pores', 'komedo', 'blackhead'],
  whitecast: ['whitecast', 'white cast', 'abu abu', 'keputihan'],
  aging: ['garis halus', 'kerutan', 'anti aging', 'penuaan', 'retinol', 'retinal', 'elastis'],
  barrier: ['skin barrier', 'barrier', 'ceramide', 'lapisan pelindung'],
  gentle: ['tanpa pewangi', 'fragrance free', 'lembut', 'gentle'],
};

// Deteksi konsep + token yang sudah "tertutup" frasa konsep
function detectConcepts(normText) {
  const padded = ` ${normText} `;
  const concepts = new Set();
  const covered = new Set();
  for (const [id, phrases] of Object.entries(CONCEPTS)) {
    for (const ph of phrases) {
      if (padded.includes(` ${ph} `)) {
        concepts.add(id);
        ph.split(' ').forEach((t) => covered.add(t));
      }
    }
  }
  return { concepts, covered };
}

// Indeks produk dibuat sekali saat server start
const productIndex = products.map((p) => {
  const fullText = [p.name, p.brand, p.category, p.description, (p.tags || []).join('. ')].join('. ');
  const norm = normalize(fullText);
  const { concepts } = detectConcepts(norm);
  const category = String(p.category || '').toLowerCase();
  concepts.add(category);
  const tokens = tokenize(fullText);
  const tf = {};
  tokens.forEach((t) => { tf[t] = (tf[t] || 0) + 1; });
  return {
    product: p,
    id: p.id,
    category,
    padded: ` ${norm} `,
    concepts,
    tf,
    len: tokens.length,
    chunks: splitSentences(p.description || '').map((s) => s.text), // "chunking" per kalimat
  };
});

if (!products.length) {
  console.warn('[peringatan] data/products.json masih kosong. Isi dengan dataset kamu (lihat README).');
}

// Statistik korpus untuk BM25 (aman saat data masih kosong)
const N_DOCS = productIndex.length;
const AVG_DL = N_DOCS ? productIndex.reduce((s, d) => s + d.len, 0) / N_DOCS || 1 : 1;
const DF = {};
productIndex.forEach((d) => Object.keys(d.tf).forEach((t) => { DF[t] = (DF[t] || 0) + 1; }));

function semanticSearch(query, candidates) {
  const qNorm = normalize(query);
  const { concepts: qConcepts, covered } = detectConcepts(qNorm);
  const leftover = [...new Set(tokenize(query).filter((t) => !covered.has(t)))];
  const qCats = [...qConcepts].filter((c) => CATEGORY_IDS.has(c));
  const out = [];

  for (const doc of candidates) {
    let total = 0;
    let hit = 0;
    const terms = [];

    for (const c of qConcepts) {
      const w = CATEGORY_IDS.has(c) ? 2 : 1; // konsep kategori lebih berbobot
      total += w;
      if (doc.concepts.has(c)) {
        hit += w;
        CONCEPTS[c].forEach((ph) => { if (doc.padded.includes(` ${ph} `)) terms.push(ph); });
      }
    }
    for (const t of leftover) {
      total += 0.5;
      if (doc.tf[t]) { hit += 0.5; terms.push(t); }
    }
    if (!total || !hit) continue;

    let coverage = hit / total;
    if (qCats.length && !qCats.includes(doc.category)) coverage *= 0.5; // beda kategori -> turun
    const noise = seededRandom(`${qNorm}|${doc.id}`);
    const score = clamp(0.28 + 0.64 * coverage + noise * 0.06, 0, 0.98);
    if (score >= 0.34) out.push({ doc, score, terms });
  }
  return out;
}

function bm25Search(query, candidates) {
  const qTokens = [...new Set(tokenize(query))];
  const k1 = 1.5;
  const b = 0.75;
  const out = [];

  for (const doc of candidates) {
    let raw = 0;
    const terms = [];
    for (const t of qTokens) {
      const tf = doc.tf[t];
      if (!tf) continue;
      const df = DF[t] || 0;
      const idf = Math.log(1 + (N_DOCS - df + 0.5) / (df + 0.5));
      raw += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.len) / AVG_DL)));
      terms.push(t);
    }
    if (raw <= 0) continue;
    // Skor BM25 tidak terbatas; dinormalisasi ke 0..1 hanya untuk tampilan progress bar
    out.push({ doc, score: 1 - Math.exp(-raw / 5), raw, terms });
  }
  return out;
}

// Pilih potongan teks (chunk) yang paling banyak memuat kata yang cocok
function bestChunk(doc, terms) {
  let best = doc.chunks[0] || '';
  let bestCount = -1;
  for (const chunk of doc.chunks) {
    const padded = ` ${normalize(chunk)} `;
    const count = terms.filter((t) => padded.includes(` ${t} `)).length;
    if (count > bestCount) { best = chunk; bestCount = count; }
  }
  return best;
}

/* =========================================================
 * Simulasi QA berbasis ulasan (bahasa Inggris)
 * ========================================================= */

const QA_STOPWORDS = new Set([
  'does', 'do', 'did', 'is', 'are', 'was', 'were', 'am', 'it', 'its', 'this', 'that', 'these',
  'the', 'a', 'an', 'to', 'for', 'of', 'on', 'in', 'my', 'me', 'i', 'you', 'your', 'how', 'what',
  'which', 'who', 'why', 'when', 'can', 'could', 'will', 'would', 'should', 'be', 'feel', 'feels',
  'make', 'makes', 'leave', 'leaves', 'good', 'skin', 'product', 'use', 'using', 'with', 'after',
  'any', 'much', 'really', 'very', 'there', 'have', 'has', 'at', 'or', 'and', 'if', 'so', 'too',
  'about', 'people', 'work', 'works', 'suitable', 'ok', 'okay', 'like', 'get', 'give', 'gives',
  'cause', 'causes', 'face', 'type', 'types', 'all', 'by', 'as', 'from', 'than', 'more', 'less',
]);

// Grup sinonim: dipakai retriever "pretrained" & "domain" (BM25 tidak memakai ekspansi)
const QA_SYNONYMS = [
  ['greasy', 'oily', 'grease', 'sticky', 'tacky', 'heavy', 'slick', 'shiny'],
  ['smell', 'scent', 'unscented', 'fragrance', 'odor', 'perfume', 'scented'],
  ['sensitive', 'irritation', 'irritate', 'irritated', 'redness', 'sting', 'stinging', 'gentle', 'react'],
  ['white cast', 'whitecast', 'cast', 'white', 'ashy', 'chalky'],
  ['dry', 'drying', 'dryness', 'tight', 'flaky', 'dehydrated'],
  ['acne', 'breakout', 'break out', 'pimple', 'blemish', 'purging'],
  ['texture', 'consistency', 'thick', 'thin', 'runny', 'watery', 'lightweight'],
  ['absorb', 'absorbs', 'sink'],
  ['price', 'worth', 'expensive', 'pricey', 'cheap', 'value', 'money'],
  ['makeup', 'foundation', 'pill', 'primer'],
  ['hydrate', 'hydrating', 'moisture', 'moisturizing', 'plump', 'plumping'],
  ['bright', 'brighten', 'brightened', 'glow', 'radiant', 'dull', 'dark spot'],
  ['pore', 'pores', 'blackhead', 'blackheads'],
  ['scar', 'scars', 'marks', 'acne marks'],
  ['eye', 'eyes'],
];

const RETRIEVER_BONUS = { bm25: 0, pretrained: 0.03, domain: 0.06 };

// Stemming sangat sederhana: "smells" -> "smell"
const stem = (t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);

function expandQuestion(question, retriever) {
  const tokens = normalize(question).split(' ').filter((t) => t.length > 1 && !QA_STOPWORDS.has(t));
  const groups = [];
  const seen = new Set();
  for (const raw of tokens) {
    const t = stem(raw);
    if (retriever === 'bm25') {
      if (!seen.has(t)) { seen.add(t); groups.push({ key: t, words: [t] }); }
      continue;
    }
    const g = QA_SYNONYMS.find((grp) => grp.includes(raw) || grp.includes(t));
    const key = g ? g[0] : t;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ key, words: g || [t] });
  }
  return groups;
}

const wordRegex = (w) => new RegExp(`\\b${w.replace(/ /g, '\\s+')}`, 'i');
const groupMatches = (group, text) => group.words.some((w) => wordRegex(w).test(text));

function scoreReview(review, groups) {
  if (!groups.length) return { coverage: 0, best: null };
  const matched = groups.filter((g) => groupMatches(g, review.text)).length;
  let best = null;
  let bestCov = 0;
  for (const s of splitSentences(review.text)) {
    const cov = groups.filter((g) => groupMatches(g, s.text)).length / groups.length;
    if (cov > bestCov) { bestCov = cov; best = { ...s, coverage: cov }; }
  }
  return { coverage: matched / groups.length, best };
}

/* =========================================================
 * Endpoint API
 * ========================================================= */

// GET /api/products?category=
app.get('/api/products', endpoint(async (req) => {
  const cat = parseCategory(req.query.category);
  const list = products.filter((p) => !cat || p.category.toLowerCase() === cat).map(toPublicProduct);
  return { total: list.length, products: list };
}));

// GET /api/products/:id
app.get('/api/products/:id', endpoint(async (req) => {
  const p = products.find((x) => x.id === req.params.id);
  if (!p) throw new HttpError(404, 'Produk tidak ditemukan.');
  return { product: toPublicProduct(p) };
}));

// POST /api/search  { query, mode, topK, category }
app.post('/api/search', endpoint(async (req) => {
  const { query = '', mode = 'semantic', topK = 10, category = '' } = req.body || {};
  const q = String(query).trim();

  if (!q) throw new HttpError(400, 'Kueri tidak boleh kosong.');
  if (q.length > 300) throw new HttpError(400, 'Kueri terlalu panjang (maks. 300 karakter).');
  if (q.toLowerCase() === '__error__') throw new HttpError(500, 'Simulasi error server (kueri "__error__").');
  if (!['semantic', 'bm25'].includes(mode)) throw new HttpError(400, 'Mode harus "semantic" atau "bm25".');

  const k = [5, 10, 20].includes(Number(topK)) ? Number(topK) : 10;
  const cat = parseCategory(category);
  const candidates = productIndex.filter((d) => !cat || d.category === cat);

  const scored = mode === 'semantic' ? semanticSearch(q, candidates) : bm25Search(q, candidates);
  scored.sort((a, b) => b.score - a.score);

  const results = scored.slice(0, k).map(({ doc, score, raw, terms }) => {
    const p = doc.product;
    const uniqueTerms = [...new Set(terms)];
    return {
      id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      price: p.price,
      image: p.image,
      score: round(score),
      ...(raw != null ? { raw_score: round(raw) } : {}),
      matched_chunk: bestChunk(doc, uniqueTerms),
      matched_terms: uniqueTerms, // tambahan: dipakai UI untuk highlight
    };
  });

  return { query: q, mode, topK: k, category: cat || 'semua', total: scored.length, results };
}));

// POST /api/ask  { productId, question, retriever, k }
app.post('/api/ask', endpoint(async (req) => {
  const { productId, question = '', retriever = 'domain', k = 3 } = req.body || {};
  const product = products.find((p) => p.id === productId);
  const q = String(question).trim();

  if (!product) throw new HttpError(404, 'Produk tidak ditemukan.');
  if (q.length < 3) throw new HttpError(400, 'Pertanyaan terlalu pendek.');
  if (q.length > 300) throw new HttpError(400, 'Pertanyaan terlalu panjang (maks. 300 karakter).');
  if (!['bm25', 'pretrained', 'domain'].includes(retriever)) {
    throw new HttpError(400, 'Retriever harus "bm25", "pretrained", atau "domain".');
  }
  const topK = [1, 3, 5].includes(Number(k)) ? Number(k) : 3;

  const productReviews = reviews[product.id] || [];
  const groups = expandQuestion(q, retriever);
  const bonus = RETRIEVER_BONUS[retriever];
  const salt = `${q.toLowerCase()}|${retriever}`;

  const scored = productReviews
    .map((r) => {
      const s = scoreReview(r, groups);
      const noise = seededRandom(salt + r.review_id);
      return { review: r, ...s, noise, rank: s.coverage + noise * 0.05 };
    })
    .sort((a, b) => b.rank - a.rank);

  const top = scored[0];
  // Bisa dijawab jika ada kalimat ulasan yang mencakup >= 50% kata kunci pertanyaan
  const answerable = Boolean(top && top.best && top.best.coverage >= 0.5);

  const evidence = scored.slice(0, topK).map((s) => {
    let score = s.coverage > 0
      ? 0.5 + 0.38 * s.coverage + bonus + s.noise * 0.05
      : 0.08 + s.noise * 0.22;
    if (!answerable) score = Math.min(score, 0.42);
    const span = answerable && s.best ? s.best : null;
    return {
      review_id: s.review.review_id,
      text: s.review.text,
      rating: s.review.rating,
      answer_start: span ? span.start : null,
      answer_end: span ? span.end : null,
      score: round(clamp(score, 0, 0.98)),
    };
  });

  return {
    product_id: product.id,
    question: q,
    retriever,
    k: topK,
    answerable,
    answer: answerable ? top.best.text : null,
    confidence: answerable
      ? round(clamp(0.5 + 0.33 * top.best.coverage + bonus + top.noise * 0.06, 0, 0.97))
      : round(0.08 + (top ? top.noise : 0) * 0.2),
    message: answerable ? null : 'Informasi tidak ditemukan dalam ulasan yang tersedia.',
    evidence,
  };
}));

// Endpoint /api lain yang tidak dikenal
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
});

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});
