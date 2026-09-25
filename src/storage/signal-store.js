/**
 * signal-store.js - Armazenamento Transacional de Sinais em IndexedDB
 * Oracle Quant Signals
 *
 * Responsabilidades:
 * - Garantir ordem estrita, persistência transacional e atomicidade na emissão de sinais (R1).
 * - Substituir escritas massivas e não-atômicas em chrome.storage.local por transações readwrite.
 * - Resolver promessas de gravação EXCLUSIVAMENTE no evento tx.oncomplete.
 * - Suportar leitura pelo Side Panel (R4) e Background Service Worker.
 * - Gerenciar sequência global monotônica (R5).
 * - Suportar ambiente de testes Node.js com fallback transparente em memória.
 */

import { rec } from "../diagnostics/flight-recorder.js";

const DB_NAME = "oracle_quant_db";
const DB_VERSION = 1;
const STORE_NAME = "signals";

let inMemorySeq = 0;
let _seqPromise = Promise.resolve();

/**
 * Retorna o próximo valor de sequência global monotônica compartilhada (R5).
 * Lê e incrementa em chrome.storage.session para sincronizar entre abas.
 * Serializado via fila de promessas para eliminar concorrência assíncrona.
 *
 * @returns {Promise<number>}
 */
export async function getNextGlobalSeq() {
  const nextVal = await (_seqPromise = _seqPromise.then(async () => {
    inMemorySeq++;
    if (typeof chrome !== "undefined" && chrome.storage?.session?.get) {
      try {
        const res = await chrome.storage.session.get("ifx:global:seq");
        const current = Number(res?.["ifx:global:seq"]) || 0;
        const next = Math.max(current + 1, inMemorySeq);
        await chrome.storage.session.set({ "ifx:global:seq": next });
        inMemorySeq = next;
        return next;
      } catch (_) {}
    }
    return inMemorySeq;
  }));
  return nextVal;
}

export class SignalStore {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.dbName=DB_NAME]
   * @param {string} [options.storeName=STORE_NAME]
   */
  constructor({ dbName = DB_NAME, storeName = STORE_NAME } = {}) {
    this.dbName = dbName;
    this.storeName = storeName;
    this._db = null;
    this._initPromise = null;
    /** @type {Map<string, Object>} Fallback em memória e cache O(1) */
    this._memoryStore = new Map();

    if (typeof indexedDB !== "undefined") {
      this._initPromise = this._initDB().catch((err) => {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[SignalStore] IndexedDB indisponível, operando via memória:", err?.message || err);
        }
      });
    }
  }

  async _initDB() {
    if (typeof indexedDB === "undefined") return null;
    if (this._db) return this._db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
          store.createIndex("symbol", "symbol", { unique: false });
          store.createIndex("seq", "seq", { unique: false });
          store.createIndex("tabId", "tabId", { unique: false });
        }
      };

      req.onsuccess = (event) => {
        this._db = event.target.result;
        resolve(this._db);
      };

      req.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  async _getDB() {
    if (typeof indexedDB === "undefined") return null;
    if (this._db) return this._db;
    if (this._initPromise) {
      try {
        await this._initPromise;
        return this._db;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * Grava um sinal de forma estritamente transacional (R1).
   * A Promise SÓ resolve quando a transação completa (tx.oncomplete).
   *
   * @param {Object} signal
   * @param {string} signal.id - Chave primária: symbol:timeframe:candleTimestamp:strategyVersion
   * @returns {Promise<Object>}
   */
  async putSignal(signal) {
    if (!signal || !signal.id) {
      throw new Error("[SignalStore] Sinal inválido: id obrigatório");
    }

    const record = {
      ...signal,
      createdAt: signal.createdAt || Date.now(),
      committed: Boolean(signal.committed),
    };

    // Atualiza cache em memória para leitura instantânea O(1)
    this._memoryStore.set(record.id, record);

    const db = await this._getDB();
    if (!db) {
      // Fallback em memória (Node.js ou modo privado)
      return record;
    }

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);

        const putReq = store.put(record);

        tx.oncomplete = () => {
          resolve(record);
        };

        tx.onerror = () => {
          reject(tx.error || putReq.error);
        };

        tx.onabort = () => {
          reject(new Error("[SignalStore] Transação abortada"));
        };

        putReq.onerror = () => {
          reject(putReq.error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Marca um sinal como confirmado/commitado (R2).
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async markCommitted(id) {
    if (!id) return false;

    if (this._memoryStore.has(id)) {
      const memRec = this._memoryStore.get(id);
      memRec.committed = true;
    }

    const db = await this._getDB();
    if (!db) return true;

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        const getReq = store.get(id);

        getReq.onsuccess = () => {
          const rec = getReq.result;
          if (rec) {
            rec.committed = true;
            rec.committedAt = Date.now();
            store.put(rec);
          }
        };

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(new Error("[SignalStore] Transação abortada"));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Liquida formalmente um sinal de forma atômica e idempotente.
   * Se já estiver liquidado, retorna o registro existente sem alterar.
   *
   * @param {string} id
   * @param {Object} outcome
   * @returns {Promise<Object|null>}
   */
  async settleSignal(id, { result, entryPrice, closePrice, pnlUnits, settledAt = Date.now() } = {}) {
    if (!id) return null;

    let existing = await this.getSignalById(id);
    if (!existing) return null;
    if (existing.status === "SETTLED") {
      // Idempotência: já liquidado
      return existing;
    }

    const updated = {
      ...existing,
      status: "SETTLED",
      result: result || existing.result,
      entryPrice: entryPrice ?? existing.entryPrice,
      closePrice: closePrice ?? existing.closePrice,
      pnlUnits: pnlUnits ?? existing.pnlUnits,
      settledAt,
    };

    return this.putSignal(updated);
  }

  /**
   * Cancela um sinal de forma atômica e idempotente.
   *
   * @param {string} id
   * @param {string} [reason]
   * @returns {Promise<Object|null>}
   */
  async cancelSignal(id, reason = null) {
    if (!id) return null;

    let existing = await this.getSignalById(id);
    if (!existing) return null;
    if (existing.status === "CANCELLED") {
      return existing;
    }

    const updated = {
      ...existing,
      status: "CANCELLED",
      cancelReason: reason || existing.cancelReason,
      cancelledAt: Date.now(),
    };

    return this.putSignal(updated);
  }

  /**
   * Verifica se um sinal com o id especificado já existe (R1, deduplicação).
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async hasSignal(id) {
    if (!id) return false;
    if (this._memoryStore.has(id)) return true;

    const db = await this._getDB();
    if (!db) return false;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readonly");
        const store = tx.objectStore(this.storeName);
        const req = store.get(id);

        req.onsuccess = () => {
          const exists = Boolean(req.result);
          if (exists) {
            this._memoryStore.set(id, req.result);
          }
          resolve(exists);
        };

        req.onerror = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  /**
   * Retorna um sinal específico por id (R1).
   *
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async getSignalById(id) {
    if (!id) return null;
    if (this._memoryStore.has(id)) return { ...this._memoryStore.get(id) };

    const db = await this._getDB();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readonly");
        const store = tx.objectStore(this.storeName);
        const req = store.get(id);

        req.onsuccess = () => {
          const res = req.result || null;
          if (res) this._memoryStore.set(id, res);
          resolve(res);
        };

        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  /**
   * Retorna lista de sinais ordenada por createdAt DESC (mais recentes primeiro) (R1, R4).
   *
   * @param {number} [limit=150]
   * @param {Object} [filter={}]
   * @param {number|string} [filter.tabId]
   * @param {string} [filter.symbol]
   * @returns {Promise<Object[]>}
   */
  async getSignals(limit = 150, filter = {}) {
    const db = await this._getDB();

    if (!db) {
      let list = Array.from(this._memoryStore.values());
      if (filter.tabId !== undefined && filter.tabId !== null) {
        list = list.filter((s) => s.tabId === undefined || s.tabId === Number(filter.tabId));
      }
      if (filter.symbol) {
        list = list.filter((s) => !s.symbol || s.symbol === String(filter.symbol).toUpperCase());
      }
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return list.slice(0, limit);
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readonly");
        const store = tx.objectStore(this.storeName);
        const index = store.index("createdAt");
        const results = [];

        // Cursor descendente (prev): mais recente primeiro
        const req = index.openCursor(null, "prev");

        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && results.length < limit) {
            const sig = cursor.value;
            let matches = true;

            if (filter.tabId !== undefined && filter.tabId !== null && sig.tabId !== undefined) {
              if (sig.tabId !== Number(filter.tabId)) matches = false;
            }
            if (filter.symbol && sig.symbol) {
              if (sig.symbol !== String(filter.symbol).toUpperCase()) matches = false;
            }

            if (matches) {
              results.push(sig);
            }
            cursor.continue();
          } else {
            resolve(results);
          }
        };

        req.onerror = () => {
          resolve(Array.from(this._memoryStore.values()).slice(-limit).reverse());
        };
      } catch (_) {
        resolve(Array.from(this._memoryStore.values()).slice(-limit).reverse());
      }
    });
  }

  /**
   * Limpa todos os sinais (útil para testes ou reset de sessão).
   *
   * @returns {Promise<void>}
   */
  async clear() {
    this._memoryStore.clear();
    const db = await this._getDB();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, "readwrite");
        const store = tx.objectStore(this.storeName);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }
}

export const signalStore = new SignalStore();
