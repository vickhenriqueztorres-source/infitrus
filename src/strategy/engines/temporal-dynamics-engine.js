/**
 * temporal-dynamics-engine.js - Motor 4: Modelo de Dinâmica Temporal de Trajetória
 * Oracle Quant Signals
 *
 * Princípio do PRD:
 * "Não olha somente o estado atual. Analisa X_{t-3}, X_{t-2}, X_{t-1}, X_t para descobrir
 * como o estado está evoluindo. Mede trajetória, e não somente uma fotografia."
 */

import { clamp } from "../detectors/detector-types.js";

export class TemporalDynamicsEngine {
  constructor(config = {}) {
    this.id = "temporal_dynamics";
    this.name = "Dinâmica Temporal";
    this.trajectoryHistory = []; // Buffer com os últimos 4 snapshots
    this.maxWindow = config.maxWindow || 4;
  }

  /**
   * Adiciona o snapshot da vela e avalia a trajetória dos últimos 4 períodos.
   *
   * @param {Object} params
   * @param {Object} params.rawFeatures
   * @param {Array} params.candles
   * @returns {Object}
   */
  evaluate({ rawFeatures = {}, candles = [] }) {
    const n = candles.length;
    if (n < 6) {
      return {
        engineId: this.id,
        name: this.name,
        probUp: 0.50,
        probDown: 0.50,
        confidence: 0.30,
        trajectorySlope: 0,
      };
    }

    // Snapshot das grandezas dinâmicas fundamentais
    const snap = {
      timestamp: candles[n - 1].timestamp,
      r1: rawFeatures.r1 || 0,
      pressure: rawFeatures.pressure || 0,
      bodyRatio: rawFeatures.bodyRatio || 0.5,
      pos20: rawFeatures.pos20 || 0.5,
      accel: rawFeatures.priceAcceleration || 0,
    };

    // Mantém janela deslizante de 4 períodos
    this.trajectoryHistory.push(snap);
    if (this.trajectoryHistory.length > this.maxWindow) {
      this.trajectoryHistory.shift();
    }

    const hist = this.trajectoryHistory;
    const count = hist.length;

    if (count < 2) {
      return {
        engineId: this.id,
        name: this.name,
        probUp: 0.50,
        probDown: 0.50,
        confidence: 0.35,
        trajectorySlope: 0,
      };
    }

    // Calcula derivada de pressão e derivada de momentum ao longo de X_{t-3} .. X_t
    let dPressureSum = 0;
    let dMomSum = 0;
    for (let i = 1; i < count; i++) {
      dPressureSum += hist[i].pressure - hist[i - 1].pressure;
      dMomSum += hist[i].r1 - hist[i - 1].r1;
    }

    const avgDPressure = dPressureSum / (count - 1);
    const avgDMom = dMomSum / (count - 1);

    // Trajetória composta:
    // Exemplo do PRD:
    // Trajetória A: Pressão e momentum subindo de forma contínua -> Trajetória favorável de alta
    // Trajetória B: Pressão ainda positiva, mas caindo consistentemente -> Trajetória de deterioração
    const latest = hist[count - 1];
    const trajectoryScore = latest.pressure + avgDPressure * 1.5 + (avgDMom * 100);

    // Mapeia trajectoryScore para probabilidade via sigmóide moderada
    const z = clamp(trajectoryScore * 1.8, -3, 3);
    const rawProbUp = 1 / (1 + Math.exp(-z));

    const probUp = Number(clamp(rawProbUp, 0.25, 0.75).toFixed(4));
    const probDown = Number((1.0 - probUp).toFixed(4));
    const confidence = clamp(0.50 + Math.min(0.40, count * 0.1), 0.40, 0.90);

    return {
      engineId: this.id,
      name: this.name,
      probUp,
      probDown,
      confidence: Number(confidence.toFixed(3)),
      trajectorySlope: Number(avgDPressure.toFixed(4)),
      trajectoryScore: Number(trajectoryScore.toFixed(4)),
    };
  }
}
