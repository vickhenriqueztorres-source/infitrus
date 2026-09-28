export default {
  async fetch(request, env, ctx) {
    const headers = {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Cache-Control": "public, max-age=60, s-maxage=60",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    const config = {
      version: "1.0.0",
      updatedAt: new Date().toISOString(),

      system: {
        killSwitch: false,
        killSwitchReason: "Mercado em alta volatilidade devido a notícias. Sinais em pausa preventiva.",
        announcement: "🚀 Motor Quant 2.0 ativo com assertividade otimizada!"
      },

      parameters: {
        minEdge: 0.025,
        minPayout: 0.78,
        minQuality: 0.60
      },

      market: {
        allowedPairs: [
          "EURUSD_OTC",
          "GBPUSD_OTC",
          "USDJPY_OTC",
          "AUDUSD_OTC"
        ],
        blockedPairs: []
      },

      strategies: {
        families: {
          MOMENTUM: { enabled: true, weight: 1.2 },
          REVERSAL: { enabled: true, weight: 0.9 },
          MICROSTRUCTURE: { enabled: true, weight: 1.4 },
          VOLATILITY: { enabled: false, weight: 0.0 },
          ANALOGY: { enabled: true, weight: 1.0 }
        },
        subStrategies: {
          IMPULSE_CONTINUATION: { status: "ACTIVE", weight: 1.3 },
          WICK_REJECTION: { status: "SHADOW", weight: 0.5 },
          SQUEEZE_BREAKOUT: { status: "MUTED", weight: 0.0 }
        }
      }
    };

    return new Response(JSON.stringify(config, null, 2), {
      status: 200,
      headers
    });
  }
};
