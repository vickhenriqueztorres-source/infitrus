/**
 * microstructure-family.js - Família 3: Microestrutura / Fluxo de Ticks (5 Subestratégias Autônomas)
 * Oracle Quant Signals
 *
 * Subestratégias:
 * 3A. Persistent Tick Pressure: Pressão direcional acumulada estável.
 * 3B. Pressure Acceleration: Derivada de 1ª e 2ª ordem da pressão intraminuto.
 * 3C. Pressure Reversal: Inversão súbita da agressão antes da virada do minuto.
 * 3D. High/Low Acceptance: Tempo e absorção nos extremos da vela em score contínuo.
 * 3E. End-of-Minute Flow: Especializada exclusivamente no fluxo dos últimos 15s/10s/5s.
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups } from "../pool/opportunity-pool.js";

export class MicrostructureFamily {
  constructor(config = {}) {
    this.familyId = "MICROSTRUCTURE";
    this.familyName = "Microestrutura / Fluxo";
    this.correlationGroup = CorrelationGroups.MICROSTRUCTURE;
    this.minTicks = config.minTicks || 6;
  }

  /**
   * Avalia exclusivamente as métricas intraminuto e gera candidatos das 5 subestratégias.
   *
   * @param {Object} params
   * @param {Object} [params.microMetrics=null]
   * @param {number} [params.payout=0.80]
   * @param {number} [params.timestamp=Date.now()]
   * @returns {Array<Object>} Lista de OpportunityObjects qualificados
   */
  evaluate({ microMetrics = null, payout = 0.80, timestamp = Date.now() }) {
    const tickCount = microMetrics?.tickCount || 0;
    if (!microMetrics || tickCount < this.minTicks) return [];

    const breakeven = 1 / (1 + payout);
    const opportunities = [];

    const {
      pressure = 0,
      pressureVelocity = 0,
      pressureAcceleration = 0,
      timeNearHighRatio = 0,
      timeNearLowRatio = 0,
      lastTicksDirection = 0,
      flowImbalance = 0,
      last10TickDirection = 0,
    } = microMetrics;

    const sampleConfidence = clamp(0.50 + Math.min(0.45, tickCount / 35), 0.50, 0.95);

    // =========================================================================
    // 3A — PERSISTENT TICK PRESSURE (Pressão Sustentada de Fluxo)
    // =========================================================================
    {
      let pDir = null;
      let pScore = 0;

      if (pressure >= 0.24 && flowImbalance >= 0) {
        pDir = "CALL";
        pScore = 0.35 + clamp(pressure * 0.70, 0.15, 0.50) + clamp(flowImbalance * 0.30, 0, 0.15);
      } else if (pressure <= -0.24 && flowImbalance <= 0) {
        pDir = "PUT";
        pScore = 0.35 + clamp(-pressure * 0.70, 0.15, 0.50) + clamp(-flowImbalance * 0.30, 0, 0.15);
      }

      if (pDir && pScore >= 0.52) {
        const rawProb = Number(clamp(0.50 + pScore * 0.20, 0.50, 0.71).toFixed(4));
        const uncert = Number(clamp(0.04 - pScore * 0.012, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PERSISTENT_TICK_PRESSURE",
            correlationGroup: this.correlationGroup,
            direction: pDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(sampleConfidence.toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: 1.0,
            evidence: { pressure, flowImbalance, tickCount },
            reasons: [
              `Pressão persistente de ticks (${(pressure * 100).toFixed(0)}%)`,
              `Desequilíbrio de agressão favorável (${(flowImbalance * 100).toFixed(0)}%)`,
            ],
            timestamp,
            fingerprint: `TICKPRESS_${pDir}_${timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 3B — PRESSURE ACCELERATION (Derivada de 1ª e 2ª Ordem)
    // =========================================================================
    {
      let accelDir = null;
      let accelScore = 0;

      // Detecta fluxo crescendo de forma acelerada
      const dynamicForceBull = pressureVelocity * 1.6 + pressureAcceleration * 1.0;
      const dynamicForceBear = -pressureVelocity * 1.6 - pressureAcceleration * 1.0;

      if (dynamicForceBull >= 0.18) {
        accelDir = "CALL";
        accelScore = 0.35 + clamp(dynamicForceBull * 1.5, 0.15, 0.55);
      } else if (dynamicForceBear >= 0.18) {
        accelDir = "PUT";
        accelScore = 0.35 + clamp(dynamicForceBear * 1.5, 0.15, 0.55);
      }

      if (accelDir && accelScore >= 0.52) {
        const rawProb = Number(clamp(0.50 + accelScore * 0.21, 0.50, 0.72).toFixed(4));
        const uncert = Number(clamp(0.045 - accelScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PRESSURE_ACCELERATION",
            correlationGroup: this.correlationGroup,
            direction: accelDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(sampleConfidence * 0.95, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: 1.05,
            evidence: { pressureVelocity, pressureAcceleration },
            reasons: [
              `Aceleração da pressão de agressão (${(pressureAcceleration * 100).toFixed(0)}%)`,
              `Curvatura favorável nos snapshots de ticks`,
            ],
            timestamp,
            fingerprint: `PRESSACC_${accelDir}_${timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 3C — PRESSURE REVERSAL (Inversão Súbita da Agressão Intraminuto)
    // =========================================================================
    {
      let revDir = null;
      let revScore = 0;

      // Inversão: velocidade de pressão fortemente contrária à pressão acumulada prévia
      if (pressure > 0.10 && pressureVelocity < -0.15) {
        revDir = "PUT";
        revScore = 0.35 + clamp(-pressureVelocity * 2.0, 0.15, 0.55);
      } else if (pressure < -0.10 && pressureVelocity > 0.15) {
        revDir = "CALL";
        revScore = 0.35 + clamp(pressureVelocity * 2.0, 0.15, 0.55);
      }

      if (revDir && revScore >= 0.50) {
        const rawProb = Number(clamp(0.50 + revScore * 0.20, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.045 - revScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PRESSURE_REVERSAL",
            correlationGroup: this.correlationGroup,
            direction: revDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(sampleConfidence * 0.92, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: 1.0,
            evidence: { pressure, pressureVelocity },
            reasons: [
              `Inversão rápida de fluxo (pressão virando para ${revDir})`,
              `Divergência entre pressão prévia e agressão final`,
            ],
            timestamp,
            fingerprint: `PRESSREV_${revDir}_${timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 3D — HIGH/LOW ACCEPTANCE (Permanência Contínua nos Extremos)
    // =========================================================================
    {
      let accDir = null;
      let accScore = 0;

      // Score contínuo baseado em tempo de permanência nos extremos
      if (timeNearHighRatio >= 0.35 && timeNearHighRatio > timeNearLowRatio * 1.5) {
        accDir = "CALL";
        accScore = 0.30 + clamp(timeNearHighRatio * 0.80, 0.20, 0.60);
      } else if (timeNearLowRatio >= 0.35 && timeNearLowRatio > timeNearHighRatio * 1.5) {
        accDir = "PUT";
        accScore = 0.30 + clamp(timeNearLowRatio * 0.80, 0.20, 0.60);
      }

      if (accDir && accScore >= 0.50) {
        const rawProb = Number(clamp(0.50 + accScore * 0.20, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.04 - accScore * 0.012, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "HIGH_LOW_ACCEPTANCE",
            correlationGroup: this.correlationGroup,
            direction: accDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(sampleConfidence.toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: 1.0,
            evidence: { timeNearHighRatio, timeNearLowRatio },
            reasons: [
              `Aceitação de preço no extremo (${((accDir === "CALL" ? timeNearHighRatio : timeNearLowRatio) * 100).toFixed(0)}% do tempo)`,
            ],
            timestamp,
            fingerprint: `EXTRACC_${accDir}_${timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 3E — END-OF-MINUTE FLOW (Últimos 15s / 10s / 5s)
    // =========================================================================
    {
      let eomDir = null;
      let eomScore = 0;

      // Exige cobertura temporal mínima de ticks e desbalanceamento contínuo real
      // Impede que poucos ticks quase neutros disparem por confusão de escala discreta
      const minEomTicks = Math.max(10, this.minTicks);
      if (tickCount >= minEomTicks && Math.abs(pressure) >= 0.18 && Math.abs(flowImbalance) >= 0.15) {
        const directionalMagnitude = clamp(Math.abs(pressure) * 0.50 + Math.abs(flowImbalance) * 0.50, 0, 1);

        if (lastTicksDirection > 0 && pressure > 0 && flowImbalance > 0) {
          eomDir = "CALL";
          eomScore = 0.35 + directionalMagnitude * 0.35;
        } else if (lastTicksDirection < 0 && pressure < 0 && flowImbalance < 0) {
          eomDir = "PUT";
          eomScore = 0.35 + directionalMagnitude * 0.35;
        }
      }

      if (eomDir && eomScore >= 0.50) {
        const rawProb = Number(clamp(0.50 + eomScore * 0.21, 0.50, 0.71).toFixed(4));
        const uncert = Number(clamp(0.045 - eomScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "END_OF_MINUTE_FLOW",
            correlationGroup: this.correlationGroup,
            direction: eomDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(sampleConfidence * 0.90, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: 1.0,
            evidence: { lastTicksDirection, flowImbalance, pressure, tickCount },
            reasons: [
              `Vetor direcional contínuo de encerramento da M1 (${eomDir})`,
              `Pressão sustentada (${(pressure * 100).toFixed(0)}%) e desbalanceamento (${(flowImbalance * 100).toFixed(0)}%)`,
            ],
            timestamp,
            fingerprint: `EOMFLOW_${eomDir}_${timestamp}`,
          });
        }
      }
    }

    return opportunities;
  }
}
