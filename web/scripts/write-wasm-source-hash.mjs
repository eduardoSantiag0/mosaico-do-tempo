// Roda depois de `wasm-pack build` (veja o script `wasm:build` em
// package.json): calcula o hash do código-fonte do engine neste exato
// momento, e salva junto com o `.wasm` gerado. É esse arquivo que
// `check-wasm-freshness.mjs` usa depois para confirmar que o `.wasm`
// publicado realmente corresponde ao código Rust atual.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeEngineSourceHash } from "./hash-engine-source.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const engineDir = join(scriptsDir, "..", "..", "engine");
const outputPath = join(scriptsDir, "..", "src", "wasm", "source-hash.txt");

const hash = computeEngineSourceHash(engineDir);
writeFileSync(outputPath, `${hash}\n`);

console.log(`[mosaico] hash do código-fonte do engine salvo em ${outputPath}: ${hash}`);
