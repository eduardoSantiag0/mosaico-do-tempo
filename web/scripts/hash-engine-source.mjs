// Calcula um hash (sha256) do conteúdo de todos os arquivos que afetam
// o WebAssembly compilado: o código Rust, os shaders WGSL, e os
// arquivos que travam as versões das dependências. Comparar esse hash
// (em vez de datas de commit do git) é mais confiável: ele muda se, e
// somente se, algum byte relevante mudou de verdade — não depende de
// quantos commits o ambiente de build conseguiu "ver" (um clone
// incompleto do git, por exemplo, não afeta este cálculo).

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function collectFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target") continue; // pasta de build do cargo, nunca faz parte do código-fonte
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else {
      out.push(full);
    }
  }
}

export function computeEngineSourceHash(engineDir) {
  const files = [];
  collectFiles(join(engineDir, "src"), files);
  for (const extra of ["Cargo.toml", "Cargo.lock", "build.rs"]) {
    const path = join(engineDir, extra);
    if (statSync(path, { throwIfNoEntry: false })) {
      files.push(path);
    }
  }

  // Ordena por caminho para o hash dar sempre o mesmo resultado,
  // independentemente da ordem em que o sistema de arquivos lista os
  // arquivos.
  files.sort();

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(engineDir, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}
