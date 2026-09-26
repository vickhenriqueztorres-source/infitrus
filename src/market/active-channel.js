/**
 * active-channel.js - Rastreamento Estrito do Canal e Ativo do Gráfico
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Determinar o par e timeframe ativos a partir dos canais WebSocket (subscribe/unsubscribe)
 *   ou do último histórico HTTP carregado.
 * - Regra de precedência:
 *     1. Último subscribe sem unsubscribe correspondente.
 *     2. Em caso de empate (mesmo timestamp 'at'), prioriza o par do último histórico carregado.
 *     3. Sem subscribes ativos -> par/tf do último histórico carregado.
 *     4. Sem dados -> null. NUNCA "primeiro tick que chegar".
 * - Notificar assinantes via onChange(fn) quando houver transição de ativo/timeframe.
 */

export class ActiveChannel {
  constructor() {
    this._subscriptions = new Map(); // key `${pair}:${tf}` -> { pair, tf, at, seq }
    this._lastHistory = null; // { pair, tf, at }
    this._listeners = new Set();
    this._unsubListeners = new Set();
    this._current = null; // { pair, tf } | null
    this._seq = 0;
  }

  /**
   * Processa evento de canal (subscribe ou unsubscribe).
   * @param {Object} event
   * @param {string} event.action - "subscribe" | "unsubscribe"
   * @param {string} event.pair
   * @param {number} [event.tf=60]
   * @param {number} [event.at=Date.now()]
   */
  onChannel({ action, pair, tf = 60, at = Date.now() } = {}) {
    if (!pair) return;
    const normalizedPair = String(pair).trim().toUpperCase();
    const normalizedTf = Number(tf) || 60;
    const key = `${normalizedPair}:${normalizedTf}`;

    if (action === "subscribe") {
      this._subscriptions.set(key, { pair: normalizedPair, tf: normalizedTf, at, seq: ++this._seq });
    } else if (action === "unsubscribe") {
      this._subscriptions.delete(key);
      for (const [k, sub] of this._subscriptions.entries()) {
        if (sub.pair === normalizedPair) {
          this._subscriptions.delete(k);
        }
      }
      if (this._lastHistory && this._lastHistory.pair === normalizedPair) {
        this._lastHistory = null;
      }
      for (const fn of this._unsubListeners) {
        try { fn(normalizedPair, normalizedTf); } catch (_) {}
      }
    }
    this._recompute();
  }

  /**
   * Retorna todas as subscrições ativas atualmente.
   * @returns {Array<{ pair: string, tf: number, at: number }>}
   */
  getAll() {
    return Array.from(this._subscriptions.values());
  }

  /**
   * Verifica se determinado par está subscrito.
   * @param {string} pair
   * @returns {boolean}
   */
  hasPair(pair) {
    if (!pair) return false;
    const norm = String(pair).trim().toUpperCase();
    for (const sub of this._subscriptions.values()) {
      if (sub.pair === norm) return true;
    }
    return false;
  }

  /**
   * Registra callback para eventos de desinscrição de pares.
   * @param {Function} fn - (pair, tf) => void
   * @returns {Function} Função de cancelamento
   */
  onUnsubscribe(fn) {
    if (typeof fn !== "function") return () => {};
    this._unsubListeners.add(fn);
    return () => this._unsubListeners.delete(fn);
  }

  /**
   * Registra o par e timeframe do último histórico carregado.
   * @param {string} pair
   * @param {number} [tf=60]
   */
  onHistory(pair, tf = 60) {
    if (!pair) return;
    const normalizedPair = String(pair).trim().toUpperCase();
    const normalizedTf = Number(tf) || 60;
    this._lastHistory = { pair: normalizedPair, tf: normalizedTf, at: Date.now() };
    this._recompute();
  }

  /**
   * Retorna o par e timeframe atualmente ativos ou null.
   * @returns {{ pair: string, tf: number } | null}
   */
  get() {
    return this._current ? { ...this._current } : null;
  }

  /**
   * Registra callback para mudanças de ativo ativo.
   * @param {Function} fn - (next, prev) => void
   * @returns {Function} Função de cancelamento
   */
  onChange(fn) {
    if (typeof fn !== "function") return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _recompute() {
    const prev = this._current;
    let next = null;

    if (this._subscriptions.size > 0) {
      const subs = Array.from(this._subscriptions.values());
      // Ordena por 'at' decrescente (mais recente primeiro)
      subs.sort((a, b) => {
        if (b.at !== a.at) return b.at - a.at;
        // Empate de 'at': se um deles bater com o último histórico, prioriza ele
        if (this._lastHistory) {
          if (a.pair === this._lastHistory.pair && a.tf === this._lastHistory.tf) return -1;
          if (b.pair === this._lastHistory.pair && b.tf === this._lastHistory.tf) return 1;
        }
        return (b.seq || 0) - (a.seq || 0);
      });
      next = { pair: subs[0].pair, tf: subs[0].tf };
    } else if (this._lastHistory) {
      next = { pair: this._lastHistory.pair, tf: this._lastHistory.tf };
    }

    const changed =
      (prev === null && next !== null) ||
      (prev !== null && next === null) ||
      (prev && next && (prev.pair !== next.pair || prev.tf !== next.tf));

    if (changed) {
      this._current = next;
      for (const fn of this._listeners) {
        try {
          fn(next, prev);
        } catch (_) {}
      }
    }
  }
}
