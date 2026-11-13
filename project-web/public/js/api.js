/**
 * api.js
 * SEMUA pemanggilan data ke backend dikumpulkan di sini.
 * UI tidak boleh memanggil fetch() langsung — cukup pakai objek `api`.
 *
 * Saat backend Python (FastAPI/Flask) siap, cukup ubah API_BASE_URL,
 * mis. 'http://localhost:8000', selama bentuk request/response tetap sama.
 */

// Kosong = server Express yang sama (API dummy di server.js)
export const API_BASE_URL = '';

const DEFAULT_TIMEOUT_MS = 15000;

// Error terstruktur supaya UI bisa menampilkan pesan yang jelas
export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// Pembungkus fetch: JSON, timeout, dan normalisasi error
async function request(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(API_BASE_URL + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* respons bukan JSON */
    }

    if (!res.ok) {
      throw new ApiError((data && data.error) || `Permintaan gagal (HTTP ${res.status}).`, res.status, data);
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') throw new ApiError('Server terlalu lama merespons. Coba lagi.');
    throw new ApiError('Tidak dapat terhubung ke server. Pastikan server sudah berjalan.');
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  /** Daftar produk, opsional difilter kategori. -> { total, products, latency_ms } */
  getProducts(category = '') {
    const qs = category ? `?category=${encodeURIComponent(category)}` : '';
    return request(`/api/products${qs}`);
  },

  /** Detail satu produk. -> { product, latency_ms } */
  getProduct(id) {
    return request(`/api/products/${encodeURIComponent(id)}`);
  },

  /**
   * Semantic / keyword search.
   * @param {{query:string, mode:'semantic'|'bm25', topK:number, category:string}} params
   * -> { results:[{id,name,brand,category,price,image,score,matched_chunk}], total, latency_ms }
   */
  search({ query, mode = 'semantic', topK = 10, category = '' }) {
    return request('/api/search', { method: 'POST', body: { query, mode, topK, category } });
  },

  /**
   * Question answering berbasis ulasan.
   * @param {{productId:string, question:string, retriever:'bm25'|'pretrained'|'domain', k:1|3|5}} params
   * -> { answerable, answer, confidence, evidence:[{review_id,text,answer_start,answer_end,score}], latency_ms }
   */
  ask({ productId, question, retriever = 'domain', k = 3 }) {
    return request('/api/ask', { method: 'POST', body: { productId, question, retriever, k } });
  },
};
