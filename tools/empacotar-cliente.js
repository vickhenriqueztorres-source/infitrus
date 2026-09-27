/**
 * EMPACOTADOR SEGURO PARA DISTRIBUIÇÃO AO CLIENTE
 * Copia apenas os arquivos necessários da extensão (`manifest.json`, `src/`, `assets/`)
 * para a pasta `dist-cliente/`, garantindo que `tools/` (chave privada), `tests/` e `.git`
 * JAMAIS sejam enviados ao cliente.
 *
 * Uso:
 *   node tools/empacotar-cliente.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist-cliente');

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

export function buildClientPackage() {
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  for (const item of ALLOWED_ITEMS) {
    const srcPath = path.join(ROOT_DIR, item);
    const destPath = path.join(DIST_DIR, item);
    if (fs.existsSync(srcPath)) {
      copyRecursiveSync(srcPath, destPath);
    }
  }

  return DIST_DIR;
}

const isMain = process.argv[1] && process.argv[1].endsWith('empacotar-cliente.js');
if (isMain) {
  const out = buildClientPackage();
  console.log('\n============================================================');
  console.log('📦 PACOTE DO CLIENTE GERADO COM SUCESSO!');
  console.log('============================================================');
  console.log(`📁 Pasta pronta para enviar ao cliente: ${ out }`);
  console.log('🔒 Chave privada (tools/) e testes (tests/) foram EXCLUÍDOS com segurança.');
  console.log('============================================================\n');
}
