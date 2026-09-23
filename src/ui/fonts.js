let fontPromise;

async function loadFont(family, file, weight) {
  const response = await fetch(chrome.runtime.getURL(`assets/fonts/${file}`));
  if (!response.ok) throw new Error(`No se pudo cargar ${file}`);
  const buffer = await response.arrayBuffer();
  const face = new FontFace(family, buffer, { weight: String(weight), style: "normal", display: "swap" });
  await face.load();
  document.fonts.add(face);
}

export function loadPanelFonts({ debug = false } = {}) {
  if (fontPromise) return fontPromise;
  fontPromise = Promise.all([
    loadFont("Space Grotesk", "space-grotesk-latin-500-normal.woff2", 500),
    loadFont("Space Grotesk", "space-grotesk-latin-700-normal.woff2", 700),
    loadFont("JetBrains Mono", "jetbrains-mono-latin-400-normal.woff2", 400),
    loadFont("JetBrains Mono", "jetbrains-mono-latin-500-normal.woff2", 500),
    loadFont("JetBrains Mono", "jetbrains-mono-latin-700-normal.woff2", 700),
  ]).catch((error) => {
    if (debug) console.warn("[inflitrus] fuentes de respaldo activas", error);
  });
  return fontPromise;
}
