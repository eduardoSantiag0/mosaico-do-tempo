// Este script roda ANTES do resto do crate ser compilado. Sua única
// função é descobrir qual commit do git estamos compilando, e deixar
// isso disponível para o código Rust ler via `env!("MOSAICO_BUILD_ID")`.
//
// Por quê: já tivemos problemas de "o navegador está rodando um
// WebAssembly antigo, de antes da última mudança". Com isso, o modo de
// diagnóstico (`?debug=true`) consegue mostrar exatamente qual commit
// gerou o `.wasm` que está rodando — se não bater com o commit mais
// recente do repositório, sabemos que o problema é de build/deploy, não
// do código em si.

use std::process::Command;

fn main() {
    let git_hash = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|hash| hash.trim().to_string())
        .unwrap_or_else(|| "desconhecido".to_string());

    println!("cargo:rustc-env=MOSAICO_BUILD_ID={git_hash}");

    // Se o HEAD do git mudar (novo commit), recompila para pegar o hash novo.
    println!("cargo:rerun-if-changed=../.git/HEAD");
}
