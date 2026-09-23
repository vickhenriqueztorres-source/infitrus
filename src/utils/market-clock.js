export class MarketClock {
  constructor({ maxOffsetMs = 3000, alpha = 0.3, now = () => Date.now() } = {}) {
    this.maxOffsetMs = maxOffsetMs;
    this.alpha = alpha;
    this._now = now;
    this.offsetMs = 0;
    this.samples = 0;
  }

  observeCandleOpen(candleOpenSec, receivedAtMs) {
    if (!Number.isFinite(candleOpenSec) || !Number.isFinite(receivedAtMs)) return this.offsetMs;
    const sample = candleOpenSec * 1000 - receivedAtMs;
    if (Math.abs(sample) > this.maxOffsetMs) return this.offsetMs;
    this.offsetMs = this.samples === 0 ? sample : this.offsetMs + this.alpha * (sample - this.offsetMs);
    this.offsetMs = Math.max(-this.maxOffsetMs, Math.min(this.maxOffsetMs, this.offsetMs));
    this.samples += 1;
    return this.offsetMs;
  }

  nowMs() { return this._now() + this.offsetMs; }
  nowSec() { return this.nowMs() / 1000; }
  formingCandleTs(tf) { return Math.floor(this.nowSec() / tf) * tf; }
  secondInCandle(tf) { return Math.floor(this.nowSec()) - this.formingCandleTs(tf); }
  remainingInCandle(tf) { return tf - this.secondInCandle(tf); }
}

export const marketClock = new MarketClock();
