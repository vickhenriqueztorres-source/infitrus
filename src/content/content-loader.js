/**
 * content-loader.js - Ponto de Injeção e Inicialização de Módulos
 * Oracle Quant Signals
 *
 * Como o Chrome MV3 executa content_scripts declarados no manifest como classic scripts,
 * este loader carrega dinamicamente os módulos ES no ISOLATED world (analyzer, bridge, panel)
 * garantindo compatibilidade total de imports/exports e execução no document_start.
 */

(async () => {
  try {
    const analyzerUrl = chrome.runtime.getURL("src/content/analyzer.js");
    await import(analyzerUrl);
    if (typeof window !== "undefined") {
      window.__oracleLoaded = true;
    }
  } catch (err) {
    if (typeof window !== "undefined") {
      window.__oracleLoaderError = err;
    }
    console.error("[OracleQuant ❌ ERRO] Falha ao carregar módulos da extensão:", err);
  }
})();
