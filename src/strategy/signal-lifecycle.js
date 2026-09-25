import { LIFECYCLE } from "./lifecycle-config.js";

export const Phase = Object.freeze({
  SCANNING: "SCANNING",
  DECIDING: "DECIDING",
  PRE_SIGNAL: "PRE_SIGNAL",
  NO_ENTRY: "NO_ENTRY",
  ENTRY_NOW: "ENTRY_NOW",
  IN_TRADE: "IN_TRADE",
  SETTLED: "SETTLED",
  CANCELLED: "CANCELLED",
});

const LOCKED_PHASES = new Set([Phase.PRE_SIGNAL, Phase.ENTRY_NOW, Phase.IN_TRADE]);

export class SignalLifecycle {
  constructor(cfg = LIFECYCLE) {
    this.cfg = cfg;
    this.byKey = new Map();
    this.listeners = new Set();
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event, lc) {
    const copy = { ...lc };
    for (const fn of this.listeners) {
      try { fn(event, copy); } catch (_) { /* listener errors must not break the lifecycle */ }
    }
  }

  _key(pair, tf, targetTs) { return `${pair}:${tf}:${targetTs}`; }

  _set(lc, phase, extra = {}) {
    Object.assign(lc, extra, { phase });
    this._emit(phase, lc);
  }

  emitSignal(pair, tf, targetTs, decision, nowSec = Date.now() / 1000) {
    const key = this._key(pair, tf, targetTs);
    let lc = this.byKey.get(key);
    const formingTs = targetTs - tf;
    const direction = decision.action === "BUY" ? "CALL" : decision.action === "SELL" ? "PUT" : decision.action;

    if (!lc) {
      lc = {
        id: key,
        pair,
        tf,
        formingTs,
        targetTs,
        phase: Phase.ENTRY_NOW,
        direction,
        snapshot: decision,
        lockedAt: nowSec,
        entryPrice: null,
        closePrice: null,
        result: null,
        reason: null,
      };
      this.byKey.set(key, lc);
      this._emit(Phase.ENTRY_NOW, lc);
    } else {
      // Imutabilidade estrita: se já possui direção travada, NUNCA sobrescreve
      if (!lc.direction) {
        lc.phase = Phase.ENTRY_NOW;
        lc.direction = direction;
        lc.snapshot = decision;
        lc.lockedAt = nowSec;
        this._emit(Phase.ENTRY_NOW, lc);
      }
    }
    return lc;
  }

  step({ pair, tf, nowSec, dataOk, decide }) {
    this.advanceTime(pair, tf, nowSec);

    const formingTs = Math.floor(nowSec / tf) * tf;
    const s = Math.floor(nowSec) - formingTs;
    const targetTs = formingTs + tf;
    const key = this._key(pair, tf, targetTs);

    let lc = this.byKey.get(key);
    if (!lc) {
      lc = { id: key, pair, tf, formingTs, targetTs, phase: Phase.SCANNING, direction: null,
             snapshot: null, lockedAt: null, entryPrice: null, closePrice: null, result: null, reason: null };
      this.byKey.set(key, lc);
    }

    if (lc.phase === Phase.PRE_SIGNAL && !dataOk) {
      this._set(lc, Phase.CANCELLED, { reason: "DATA_UNSTABLE" });
    }

    if (lc.phase === Phase.SCANNING && s >= this.cfg.DECISION_START_SEC) {
      if (s > this.cfg.DECISION_END_SEC) {
        this._set(lc, Phase.NO_ENTRY);
      } else {
        lc.phase = Phase.DECIDING;
      }
    }

    if (lc.phase === Phase.DECIDING) {
      if (s > this.cfg.DECISION_END_SEC) {
        this._set(lc, Phase.NO_ENTRY);
      } else if (dataOk && typeof decide === "function") {
        const d = decide();
        if (d && (d.action === "CALL" || d.action === "PUT")) {
          this._set(lc, Phase.PRE_SIGNAL, { direction: d.action, snapshot: d, lockedAt: nowSec });
        }
      }
    }

    this.prune(nowSec);
    return this.snapshot(pair, tf, nowSec);
  }

  advanceTime(pair, tf, nowSec) {
    for (const lc of this.byKey.values()) {
      if (lc.pair !== pair || lc.tf !== tf) continue;
      if (lc.phase === Phase.PRE_SIGNAL && nowSec >= lc.targetTs) {
        this._set(lc, Phase.ENTRY_NOW);
      }
      if (lc.phase === Phase.ENTRY_NOW && nowSec >= lc.targetTs + this.cfg.ENTRY_WINDOW_SEC) {
        this._set(lc, Phase.IN_TRADE);
      }
    }
  }

  onCandleOpen(pair, tf, openTs, openPrice) {
    const lc = this.byKey.get(this._key(pair, tf, openTs));
    if (!lc || !lc.direction) return;
    if (lc.entryPrice == null && Number.isFinite(openPrice)) lc.entryPrice = openPrice;
    if (lc.phase === Phase.PRE_SIGNAL) this._set(lc, Phase.ENTRY_NOW);
  }

  onCandleClose(pair, tf, closedCandle) {
    const lc = this.byKey.get(this._key(pair, tf, closedCandle.timestamp));
    if (!lc || (lc.phase !== Phase.ENTRY_NOW && lc.phase !== Phase.IN_TRADE)) return;
    const entry = lc.entryPrice ?? closedCandle.open;
    const close = closedCandle.close;
    let result = "DOJI";
    if (close > entry) result = lc.direction === "CALL" ? "WIN" : "LOSS";
    else if (close < entry) result = lc.direction === "PUT" ? "WIN" : "LOSS";
    this._set(lc, Phase.SETTLED, { entryPrice: entry, closePrice: close, result, settledAt: closedCandle.timestamp + tf });
  }

  cancelPair(pair, reason) {
    for (const lc of this.byKey.values()) {
      if (lc.pair !== pair) continue;
      if (lc.phase === Phase.PRE_SIGNAL) this._set(lc, Phase.CANCELLED, { reason });
      else if (lc.phase === Phase.ENTRY_NOW || lc.phase === Phase.IN_TRADE) {
        this._set(lc, Phase.CANCELLED, { reason: `${reason}_NO_RESULT` });
      } else if (lc.phase === Phase.SCANNING || lc.phase === Phase.DECIDING) {
        this.byKey.delete(lc.id);
      }
    }
  }

  cancelAll(reason) {
    const pairs = new Set([...this.byKey.values()].map((lc) => lc.pair));
    for (const p of pairs) this.cancelPair(p, reason);
  }

  prune(nowSec) {
    for (const [key, lc] of this.byKey) {
      const ageCandles = (nowSec - lc.targetTs) / lc.tf;
      if (ageCandles > this.cfg.PRUNE_AFTER_CANDLES) this.byKey.delete(key);
    }
  }

  snapshot(pair, tf, nowSec) {
    const formingTs = Math.floor(nowSec / tf) * tf;
    const current = this.byKey.get(this._key(pair, tf, formingTs + tf)) || null;
    const trade = this.byKey.get(this._key(pair, tf, formingTs)) || null;
    const prev = this.byKey.get(this._key(pair, tf, formingTs - tf)) || null;
    const lastResult = prev && prev.phase === Phase.SETTLED && nowSec - prev.settledAt <= this.cfg.RESULT_HOLD_SEC ? prev : null;

    const calcRemaining = (lc) => {
      if (!lc) return 0;
      if (lc.phase === Phase.PRE_SIGNAL) return Math.max(0, Math.ceil(lc.targetTs - nowSec));
      if (lc.phase === Phase.ENTRY_NOW) return Math.max(0, Math.ceil((lc.targetTs + (this.cfg?.ENTRY_WINDOW_SEC ?? 5)) - nowSec));
      if (lc.phase === Phase.IN_TRADE) return Math.max(0, Math.ceil((lc.targetTs + lc.tf) - nowSec));
      return 0;
    };

    const strip = (lc) => {
      if (!lc) return null;
      const snap = lc.snapshot || {};
      const prob = snap.probability ?? lc.probability ?? null;
      const consProb = snap.conservativeProbability ?? prob;
      const edge = snap.edge ?? 0;
      const quality = snap.quality ?? 0;
      const subStrat = snap.subStrategy ?? snap.strategyName ?? lc.subStrategy ?? null;
      const stratName = snap.strategyName ?? snap.subStrategy ?? lc.strategyName ?? subStrat;
      const reasons = snap.reasons ?? [];
      const payout = snap.payout ?? 0.80;

      return {
        id: lc.id,
        pair: lc.pair,
        symbol: lc.pair,
        tf: lc.tf,
        formingTs: lc.formingTs,
        targetTs: lc.targetTs,
        phase: lc.phase,
        direction: lc.direction,
        lockedAt: lc.lockedAt,
        entryPrice: lc.entryPrice,
        closePrice: lc.closePrice,
        result: lc.result,
        reason: lc.reason,
        probability: prob,
        conservativeProbability: consProb,
        edge,
        quality,
        subStrategy: subStrat,
        strategyName: stratName,
        reasons,
        payout,
        secondsRemaining: calcRemaining(lc),
        snapshot: lc.snapshot ? { ...lc.snapshot } : null,
      };
    };

    return {
      current: strip(current),
      trade: trade && trade.direction ? strip(trade) : null,
      lastResult: strip(lastResult),
    };
  }

  isLocked(pair, tf, targetTs) {
    const lc = this.byKey.get(this._key(pair, tf, targetTs));
    return !!lc && LOCKED_PHASES.has(lc.phase);
  }
}
