const COLORS = Object.freeze({
  teal: "#3FE0C5",
  steel: "#8A9BA3",
  amber: "#F2A93B",
});

export class WaveRenderer {
  constructor(canvas, { state = "noise", compact = false, paused = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext?.("2d") || null;
    this.state = state;
    this.compact = compact;
    this.paused = paused;
    this.phase = 0;
    this.raf = 0;
    this.lastFrame = 0;
    this.reduceMotion = matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    this.onVisibility = () => this.setPaused(document.hidden || this.paused);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.draw(performance.now())) : null;
    this.resizeObserver?.observe(canvas);
    this.start();
  }

  setState(state) {
    this.state = state;
    if (this.reduceMotion || this.paused) this.draw(performance.now());
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.draw(performance.now());
    } else {
      this.start();
    }
  }

  start() {
    if (!this.ctx) return;
    if (this.reduceMotion || this.paused || document.hidden) {
      this.draw(performance.now());
      return;
    }
    if (!this.raf) this.raf = requestAnimationFrame((time) => this.loop(time));
  }

  loop(time) {
    this.raf = 0;
    if (!this.paused && !document.hidden) {
      if (time - this.lastFrame >= 33) {
        this.lastFrame = time;
        this.phase += 0.08;
        this.draw(time);
      }
      this.raf = requestAnimationFrame((next) => this.loop(next));
    }
  }

  size() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || (this.compact ? 54 : 280)));
    const height = Math.max(1, Math.round(rect.height || (this.compact ? 24 : 72)));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
      this.canvas.width = width * ratio;
      this.canvas.height = height * ratio;
    }
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  }

  draw() {
    if (!this.ctx) return;
    const { width, height } = this.size();
    const ctx = this.ctx;
    const mid = height / 2;
    const cursor = this.compact ? width * 0.46 : width * 0.58;
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.5;

    if (!this.compact) {
      ctx.save();
      ctx.strokeStyle = "rgba(63,224,197,0.18)";
      ctx.shadowColor = "rgba(63,224,197,0.5)";
      ctx.shadowBlur = this.state === "locked" ? 6 : 0;
      ctx.beginPath();
      ctx.moveTo(cursor, 4);
      ctx.lineTo(cursor, height - 4);
      ctx.stroke();
      ctx.restore();
    }

    if (this.state === "flat") {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(138,155,163,0.7)";
      ctx.beginPath();
      ctx.moveTo(2, mid);
      ctx.lineTo(width - 2, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const points = Math.min(60, Math.max(24, Math.round(width / 5)));
    const broken = this.state === "broken";
    const locked = this.state === "locked";
    const analyzing = this.state === "analyzing";
    for (let section = 0; section < (broken ? 4 : 1); section += 1) {
      const startRatio = broken ? section / 4 + 0.025 : 0;
      const endRatio = broken ? (section + 0.72) / 4 : 1;
      ctx.beginPath();
      for (let index = 0; index <= points; index += 1) {
        const ratio = startRatio + (endRatio - startRatio) * (index / points);
        const x = ratio * width;
        const after = x >= cursor;
        let amplitude = this.compact ? 7 : 19;
        if (locked && after) amplitude *= Math.max(0, 1 - (x - cursor) / (width - cursor || 1));
        if (analyzing) amplitude *= Math.max(0.12, 1 - ratio * 0.86);
        if (broken) amplitude = (this.compact ? 5 : 10) * (0.55 + 0.45 * Math.sin(index * 1.9 + this.phase));
        const harmonic = Math.sin(index * 1.38 + this.phase) + 0.42 * Math.sin(index * 2.71 - this.phase * 0.7);
        const jitter = Math.sin(index * 5.13 + this.phase * 1.8) * 0.28;
        const y = locked && after && ratio > 0.84 ? mid : mid + (harmonic + jitter) * amplitude * 0.42;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = broken ? "rgba(242,169,59,0.75)" : locked ? COLORS.teal : "rgba(138,155,163,0.72)";
      ctx.shadowColor = locked ? "rgba(63,224,197,0.5)" : "transparent";
      ctx.shadowBlur = locked ? 6 : 0;
      ctx.stroke();
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.resizeObserver?.disconnect();
  }
}
