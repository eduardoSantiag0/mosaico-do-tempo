// A Vercel não tem Rust instalado, então ela NÃO recompila o motor — só
// usa o `.wasm` que já está comitado em `web/src/wasm/`. Isso cria um
// jeito fácil de publicar um motor desatualizado por acidente: editar
// `engine/src/*.rs` ou os shaders `.wgsl`, esquecer de rodar
// `npm run wasm:build`, e comitar/publicar assim mesmo.
//
// Este script recalcula o hash do código-fonte do engine (o mesmo
// cálculo de `hash-engine-source.mjs`) e compara com o hash salvo em
// `web/src/wasm/source-hash.txt` no momento em que o `.wasm` foi
// compilado pela última vez (veja `write-wasm-source-hash.mjs`, que
// roda como parte de `npm run wasm:build`). Se não baterem, o `.wasm`
// comitado não corresponde ao código-fonte atual — o build falha em
// vez de publicar isso silenciosamente.
//
// Comparamos o CONTEÚDO (hash), não datas de commit do git: assim,
// funciona corretamente mesmo se o ambiente de build só tiver um clone
// parcial do histórico do repositório.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeEngineSourceHash } from "./hash-engine-source.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const engineDir = join(scriptsDir, "..", "..", "engine");
const hashFilePath = join(scriptsDir, "..", "src", "wasm", "source-hash.txt");

// Importante: esta verificação já travou TODOS os deploys por um bom
// tempo sem ninguém perceber, porque um erro INESPERADO dentro dela
// (não a comparação de hash em si, mas uma falha ao calculá-la) também
// terminava com `process.exit` diferente de 0 — e a Vercel trata isso
// como "build falhou", sem distinguir "o motor está desatualizado" de
// "o próprio script de verificação quebrou". A segunda situação é pior
// que não ter a verificação: ela bloqueia TODO deploy, mesmo quando o
// `.wasm` publicado está correto. Por isso, só o caso específico e
// controlado — os hashes realmente não baterem — deve derrubar o
// build; qualquer outro erro aqui dentro só avisa e deixa o build
// continuar.
try {
  const currentHash = computeEngineSourceHash(engineDir);

  let publishedHash = null;
  try {
    publishedHash = readFileSync(hashFilePath, "utf8").trim();
  } catch {
    // Arquivo ainda não existe — tratado como "não corresponde" abaixo.
  }

  if (publishedHash !== currentHash) {
    console.error("");
    console.error("[mosaico] ERRO: o WebAssembly publicado (web/src/wasm/) não corresponde ao código-fonte atual de engine/.");
    console.error(`[mosaico]   hash esperado (código-fonte agora): ${currentHash}`);
    console.error(`[mosaico]   hash publicado (do último build):   ${publishedHash ?? "(nenhum — arquivo source-hash.txt não encontrado)"}`);
    console.error("[mosaico] Rode `npm run wasm:build` dentro de web/, confira o resultado e comite-o (inclusive web/src/wasm/source-hash.txt) antes de publicar.");
    console.error("");
    process.exit(1);
  }

  console.log("[mosaico] OK: o WebAssembly publicado corresponde exatamente ao código-fonte atual de engine/.");
} catch (err) {
  console.warn("[mosaico] AVISO: não foi possível verificar o frescor do WebAssembly (o script quebrou, não é um mismatch de hash):", err);
  console.warn("[mosaico] Seguindo com o build mesmo assim — um script de verificação quebrado nunca deve travar o deploy inteiro.");
}
