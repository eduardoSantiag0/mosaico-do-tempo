// A Vercel não tem Rust instalado, então ela NÃO recompila o motor — só
// usa o `.wasm` que já está comitado em `web/src/wasm/`. Isso cria um
// jeito fácil de publicar um motor desatualizado por acidente: editar
// `engine/src/*.rs` ou os shaders `.wgsl`, esquecer de rodar
// `npm run wasm:build`, e comitar/publicar assim mesmo — o código Rust
// muda, mas o `.wasm` publicado continua sendo o de antes.
//
// Este script compara a DATA do último commit que tocou `engine/` com a
// data do último commit que tocou o `.wasm` compilado. Se o motor foi
// modificado DEPOIS do `.wasm`, o build falha — em vez de publicar
// silenciosamente um efeito "corrigido" que, na verdade, nunca chegou
// ao navegador.
//
// Limitação conhecida: se o ambiente de build fizer um "shallow clone"
// (histórico do git incompleto), esta verificação pode não conseguir
// comparar corretamente e deixar passar um caso que deveria falhar — ela
// nunca bloqueia um build válido por engano, mas em alguns ambientes
// pode não pegar todo caso de motor desatualizado.

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..", "..");

function lastCommitTimestamp(relativePath) {
  try {
    const output = execSync(`git log -1 --format=%ct -- "${relativePath}"`, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return output ? parseInt(output, 10) : 0;
  } catch {
    // Sem git (ou sem histórico) — não há como verificar; não bloqueia o build.
    return 0;
  }
}

const engineTimestamp = Math.max(
  lastCommitTimestamp("engine/src"),
  lastCommitTimestamp("engine/Cargo.toml"),
  lastCommitTimestamp("engine/Cargo.lock"),
);
const wasmTimestamp = lastCommitTimestamp("web/src/wasm/mosaico_engine_bg.wasm");

if (engineTimestamp > wasmTimestamp) {
  console.error("");
  console.error("[mosaico] ERRO: engine/ foi modificado DEPOIS do último commit do WebAssembly compilado (web/src/wasm/).");
  console.error("[mosaico] Rode `npm run wasm:build` dentro de web/, confira o resultado e comite-o antes de publicar.");
  console.error("");
  process.exit(1);
}

console.log("[mosaico] OK: o WebAssembly publicado corresponde às mudanças mais recentes em engine/.");
