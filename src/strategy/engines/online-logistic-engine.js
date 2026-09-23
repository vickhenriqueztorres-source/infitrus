/**
 * online-logistic-engine.js - Motor 3: Regressão Logística Online com Decaimento e Regularização L2
 * Oracle Quant Signals
 *
 * Princípio do PRD:
 * "Recebe todas as variáveis contínuas. P(UP) = 1 / (1 + e^-z) com z = β0 + β1*X1 + ...
 * Os coeficientes são atualizados continuamente via SGD online com regularização L2.
 * Dados recentes recebem mais peso. Produz probabilidade praticamente em toda vela."
 */

import { clamp } from "../detectors/detector-types.js";

export class OnlineLogisticEngine {
  constructor(config = {}) {
    this.id = "online_logistic";
    this.name = "Logística Online";
    this.learningRate = config.learningRate || 0.04;
    this.l2Penalty = config.l2Penalty || 0.005;

    this.intercept = 0.0;
    this.weights = [];
    this.steps = 0;
  }

  /**
   * Atualização online dos pesos quando o resultado da vela anterior é revelado.
   *
   * @param {number[]} prevVector
   * @param {number} actualOutcome - 1 se fechou em alta, 0 se baixa
   */
  update(prevVector = [], actualOutcome = 0) {
    if (!Array.isArray(prevVector) || prevVector.length === 0) return;

    if (this.weights.length !== prevVector.length) {
      this.weights = new Array(prevVector.length).fill(0.0);
    }

    this.steps++;

    // Predição anterior
    let z = this.intercept;
    for (let i = 0; i < prevVector.length; i++) {
      z += this.weights[i] * prevVector[i];
    }
    const pred = 1 / (1 + Math.exp(-Math.max(-8, Math.min(8, z))));
    const error = pred - actualOutcome; // Gradiente da entropia cruzada binária

    // Taxa de aprendizado adaptativa com decaimento suave
    const lr = this.learningRate / (1 + 0.001 * this.steps);

    // Passo SGD com Regularização L2 (Ridge)
    this.intercept -= lr * error;
    for (let i = 0; i < this.weights.length; i++) {
      const grad = error * prevVector[i] + this.l2Penalty * this.weights[i];
      this.weights[i] -= lr * grad;
    }
  }

  /**
   * Avalia o vetor contínuo atual Xt e estima a probabilidade de alta.
   *
   * @param {Object} params
   * @param {number[]} params.currentVector
   * @returns {Object}
   */
  evaluate({ currentVector = [] }) {
    if (!Array.isArray(currentVector) || currentVector.length === 0) {
      return {
        engineId: this.id,
        name: this.name,
        probUp: 0.50,
        probDown: 0.50,
        confidence: 0.30,
        zValue: 0,
      };
    }

    if (this.weights.length !== currentVector.length) {
      // Inicialização neutra na primeira execução
      this.weights = new Array(currentVector.length).fill(0.0);
    }

    let z = this.intercept;
    for (let i = 0; i < currentVector.length; i++) {
      z += this.weights[i] * currentVector[i];
    }

    // Clampa z para evitar overflow numérico
    const clampedZ = Math.max(-6, Math.min(6, z));
    const rawProbUp = 1 / (1 + Math.exp(-clampedZ));

    const probUp = Number(clamp(rawProbUp, 0.25, 0.75).toFixed(4));
    const probDown = Number((1.0 - probUp).toFixed(4));
    const confidence = clamp(0.50 + Math.min(0.40, this.steps / 80), 0.40, 0.90);

    return {
      engineId: this.id,
      name: this.name,
      probUp,
      probDown,
      confidence: Number(confidence.toFixed(3)),
      zValue: Number(clampedZ.toFixed(3)),
    };
  }
}
