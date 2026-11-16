// A configuração "oficial" dos efeitos mora em `config/effects.json`, na
// raiz do projeto (como sugerido no enunciado). Mas o app web só
// consegue carregar, em tempo de execução (via `fetch`), arquivos que
// estão dentro de `web/public/`. Este script copia o arquivo de um lugar
// para o outro antes de rodar o app, para não precisarmos manter duas
// cópias manuais da mesma configuração.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const source = join(scriptsDir, "..", "..", "config", "effects.json");
const destinationDir = join(scriptsDir, "..", "public", "config");
const destination = join(destinationDir, "effects.json");

mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);

console.log(`[mosaico] configuração copiada de ${source} para ${destination}`);
