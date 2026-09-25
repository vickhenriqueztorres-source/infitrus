/**
 * syntax-check.test.js
 * Garante que todos os arquivos JavaScript em src/ e tests/ possuem sintaxe válida
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

function walk(dir) {
  let files = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) {
      files = files.concat(walk(full));
    } else if (full.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

test("Sintaxe válida em todos os arquivos de código-fonte (src/**/*.js)", () => {
  const allSrcJs = walk("src");
  assert.ok(allSrcJs.length > 50, "Deve haver arquivos em src/");

  for (const file of allSrcJs) {
    try {
      execSync(`node --check "${file}"`);
    } catch (err) {
      assert.fail(`Erro de sintaxe encontrado no arquivo: ${file}`);
    }
  }
});
