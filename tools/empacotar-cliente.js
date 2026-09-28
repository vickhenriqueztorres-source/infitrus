/**
 * EMPACOTADOR SEGURO E OFUSCADOR PARA DISTRIBUIÇÃO AO CLIENTE
 *
 * 1. Copia apenas os arquivos essenciais da extensão (`manifest.json`, `src/`, `assets/`)
 *    para a pasta `dist-cliente/`.
 * 2. Minifica e ofusca 100% dos arquivos JavaScript usando Terser, removendo todos os
 *    comentários, docstrings, quebras de linha e ofuscando variáveis internas locais.
 * 3. Garante que `tools/` (chave privada do administrador), `tests/`, `.git/` e arquivos
 *    de documentação interna JAMAIS sejam incluídos.
 * 4. Gera automaticamente o arquivo compactado `inflitrus-signals-cliente.zip` pronto
 *    para entrega direta ao cliente.
 *
 * Uso:
 *   node tools/empacotar-cliente.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { minify } from 'terser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist-cliente');
const ZIP_PATH = path.join(ROOT_DIR, 'inflitrus-signals-cliente.zip');
const SHORTCUT_DIR = 'd:\\b2 - extension';
const SHORTCUT_ZIP = path.join(SHORTCUT_DIR, 'inflitrus-signals-cliente.zip');

const ALLOWED_ITEMS = [
  'manifest.json',
  'src',
  'assets'
];

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function minifyDirectoryJs(dir) {
  let count = 0;
  let originalBytes = 0;
  let minifiedBytes = 0;

  async function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.js')) {
        const sourceCode = fs.readFileSync(fullPath, 'utf8');
        originalBytes += Buffer.byteLength(sourceCode, 'utf8');
        try {
          const result = await minify(sourceCode, {
            module: true,
            compress: {
              drop_console: false, // Mantém logs operacionais controlados
              passes: 2,
            },
            mangle: {
              toplevel: false, // Preserva nomes de exports/imports de módulos ES
            },
            format: {
              comments: false, // Remove 100% dos comentários e docstrings
            },
          });
          if (result.code) {
            fs.writeFileSync(fullPath, result.code, 'utf8');
            minifiedBytes += Buffer.byteLength(result.code, 'utf8');
            count++;
          }
        } catch (err) {
          console.warn(`⚠️ Aviso ao minificar ${entry.name}: ${err.message}`);
          minifiedBytes += Buffer.byteLength(sourceCode, 'utf8');
        }
      }
    }
  }

  await walk(dir);
  return { count, originalBytes, minifiedBytes };
}

export async function buildClientPackage() {
  // 1. Limpa diretório de distribuição
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 2. Copia arquivos permitidos
  for (const item of ALLOWED_ITEMS) {
    const srcPath = path.join(ROOT_DIR, item);
    const destPath = path.join(DIST_DIR, item);
    if (fs.existsSync(srcPath)) {
      copyRecursiveSync(srcPath, destPath);
    }
  }

  // 3. Minifica e ofusca código JavaScript na distribuição
  const stats = await minifyDirectoryJs(path.join(DIST_DIR, 'src'));

  // 4. Cria arquivo ZIP para distribuição
  if (fs.existsSync(ZIP_PATH)) {
    fs.unlinkSync(ZIP_PATH);
  }

  try {
    // Usa comando nativo do PowerShell no Windows para criar zip seguro
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${DIST_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force"`, {
      stdio: 'pipe',
    });

    if (fs.existsSync(SHORTCUT_DIR)) {
      try {
        fs.copyFileSync(ZIP_PATH, SHORTCUT_ZIP);
      } catch (_) {}
    }
  } catch (err) {
    console.warn(`Aviso ao gerar ZIP automático: ${err.message}`);
  }

  return {
    distDir: DIST_DIR,
    zipPath: fs.existsSync(ZIP_PATH) ? ZIP_PATH : null,
    shortcutZip: fs.existsSync(SHORTCUT_ZIP) ? SHORTCUT_ZIP : null,
    stats,
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('empacotar-cliente.js');
if (isMain) {
  buildClientPackage().then((res) => {
    const savedPct = res.stats.originalBytes > 0
      ? (((res.stats.originalBytes - res.stats.minifiedBytes) / res.stats.originalBytes) * 100).toFixed(1)
      : '0';

    console.log('\n============================================================');
    console.log('🛡️  PACOTE SEGURO DO CLIENTE GERADO COM SUCESSO!');
    console.log('============================================================');
    console.log(`🔒 Chave Privada (tools/) e Testes (tests/): EXCLUÍDOS COM SEGURANÇA`);
    console.log(`⚡ Código JavaScript: ${res.stats.count} arquivos ofuscados e minificados (-${savedPct}% de tamanho)`);
    console.log(`📁 Pasta Descompactada: ${res.distDir}`);
    if (res.zipPath) {
      console.log(`📦 Arquivo ZIP Pronto para Envio: ${res.zipPath}`);
    }
    if (res.shortcutZip) {
      console.log(`🚀 Cópia Rápida em: ${res.shortcutZip}`);
    }
    console.log('============================================================\n');
  });
}
