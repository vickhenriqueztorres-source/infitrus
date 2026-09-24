/**
 * signal-deduplicator.js - Deduplicação Infalível de Sinais
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Garantir que para um dado candle fechado, a estratégia seja avaliada
 *   e emita sinal NO MÁXIMO UMA VEZ.
 * - Chave canônica do PRD: `${symbol}:${timeframeSeconds}:${candleTimestamp}:${strategyVersion}`
 * - Armazenamento de camada dupla:
 *     1. Map em memória síncrono para verificação instantânea O(1) sem bloquear o loop.
 *     2. Persistência assíncrona em IndexedDB com chave primária para tolerar reloads e reinicializações.
 */

export const DEFAULT_STRATEGY_VERSION = "v2.0";

export class SignalDeduplicator {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.dbName="oracle_quant_dedup"]
   * @param {string} [options.storeName="emitted_signals"]
   * @param {number} [options.maxMemorySize=1000]
   */
  constructor({ dbName = "oracle_quant_dedup", storeName = "emitted_signals", maxMemorySize = 1000 } = {}) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.maxMemorySize = maxMemorySize;
    /** @type {Map<string, Object>} */
    this.sinaisEmitidos = new Map();
    this._db = null;
    this._initPromise = null;

    if (typeof indexedDB !== "undefined") {
      this._initPromise = this._initIndexedDB().catch((err) => {
        // Fallback defensivo: se IndexedDB falhar (modo privado/sandbox), Map em memória continua funcionando
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[SignalDeduplicator] IndexedDB indisponível, operando via memória:", err?.message || err);
        }
      });
    }
  }

  /**
   * Constrói a chave canônica do PRD:
   * `${symbol}:${timeframeSeconds}:${candleTimestamp}:${strategyVersion}`
   *
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} candleTimestamp
   * @param {string} [strategyVersion=DEFAULT_STRATEGY_VERSION]
   * @returns {string}
   */
  buildKey(symbol, timeframeSeconds, candleTimestamp, strategyVersion = DEFAULT_STRATEGY_VERSION) {
    const sym = String(symbol || "").trim().toUpperCase();
    const tf = Number(timeframeSeconds);
    const ts = Number(candleTimestamp);
    const ver = String(strategyVersion || DEFAULT_STRATEGY_VERSION).trim();
    return `${sym}:${tf}:${ts}:${ver}`;
  }

  /**
   * Verifica de forma síncrona O(1) se a chave já existe.
   *
   * @param {string} chave
   * @returns {boolean}
   */
  has(chave) {
    if (!chave) return false;
    return this.sinaisEmitidos.has(chave);
  }

  /**
   * Retorna os dados do sinal deduplicado se existir.
   *
   * @param {string} chave
   * @returns {Object|null}
   */
  get(chave) {
    return this.sinaisEmitidos.get(chave) || null;
  }

  /**
   * Registra a emissão do sinal na memória e persiste no IndexedDB.
   *
   * @param {string} chave
   * @param {Object} [payload={}]
   */
  record(chave, payload = {}) {
    if (!chave) return;
    const record = {
      chave,
      ...payload,
      recordedAt: Date.now(),
    };

    this.sinaisEmitidos.set(chave, record);

    // Limpeza de memória FIFO se exceder o limite
    if (this.sinaisEmitidos.size > this.maxMemorySize) {
      const oldestKey = this.sinaisEmitidos.keys().next().value;
      this.sinaisEmitidos.delete(oldestKey);
    }

    // Persistência assíncrona no IndexedDB
    this._persistToIndexedDB(record).catch(() => {});
  }

  /**
   * Inicializa a conexão com o IndexedDB e carrega chaves existentes para a memória.
   */
  async _initIndexedDB() {
    if (typeof indexedDB === "undefined") return null;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "chave" });
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        try {
          const tx = this._db.transaction(this.storeName, "readonly");
          const store = tx.objectStore(this.storeName);
          const getAllReq = store.getAll();

          getAllReq.onsuccess = () => {
            if (Array.isArray(getAllReq.result)) {
              for (const item of getAllReq.result) {
                if (item && item.chave) {
                  this.sinaisEmitidos.set(item.chave, item);
                }
              }
            }
            resolve(this._db);
          };

          getAllReq.onerror = () => resolve(this._db);
        } catch (_) {
          resolve(this._db);
        }
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  /**
   * Persiste um registro individual no IndexedDB.
   */
  async _persistToIndexedDB(record) {
    if (!this._db) {
      if (this._initPromise) {
        try { await this._initPromise; } catch (_) { return; }
      } else {
        return;
      }
    }
    if (!this._db) return;

    return new Promise((resolve, reject) => {
      try {
        const tx = this._db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Limpa a memória e o IndexedDB (útil para testes).
   */
  async clear() {
    this.sinaisEmitidos.clear();
    if (this._db) {
      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(this.storeName, "readwrite");
          const store = tx.objectStore(this.storeName);
          const req = store.clear();
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }
  }
}

export const signalDeduplicator = new SignalDeduplicator();
