// Ponto de entrada do motor em Rust. Este arquivo só expõe uma "Engine"
// para o JavaScript conseguir usar, chamando as funções do módulo `memory`
// (que é onde a lógica de verdade está, veja `memory.rs`).
//
// Por que existe esse "cache" de índices (active_cache)? Porque passar
// listas complexas de Rust para JavaScript é mais caro/complicado. Em vez
// disso, a cada frame o JavaScript chama `update(now)` uma vez, e depois
// pode perguntar "qual é a opacidade do registro número 0?", "qual é a
// largura do registro número 1?", etc., um de cada vez. É um padrão simples
// e evita ter que converter estruturas complicadas entre as duas linguagens.

mod effects;
mod memory;

// O Renderer usa a GPU através do navegador (via WebGPU/WebGL2), então só
// faz sentido existir quando o código é compilado para WebAssembly. Ao
// rodar `cargo test` normalmente (programa nativo do Windows/Linux/Mac,
// usado para testar `memory.rs`), esse módulo nem é compilado.
#[cfg(target_arch = "wasm32")]
mod renderer;

use memory::{LayerConfig, LayerKind, MemoryRecord, RenderRecord, TemporalMemory};
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
pub use renderer::Renderer;

/// Confirma, do lado do JavaScript, que o WebAssembly carregou
/// corretamente — e também DE QUAL COMMIT ele foi compilado
/// (`MOSAICO_BUILD_ID`, definido em `build.rs`). Isso é importante para
/// descobrir rapidamente se o navegador está rodando um `.wasm` velho
/// (de antes da última mudança no motor), em vez de ficar sem saber se
/// um efeito "não funciona" ou só "ainda não foi publicado".
#[wasm_bindgen]
pub fn engine_version() -> String {
    format!("{}+{}", env!("CARGO_PKG_VERSION"), env!("MOSAICO_BUILD_ID"))
}

/// Converte o nome da camada (texto, vindo do JavaScript) para o tipo
/// `LayerKind` que usamos internamente em Rust. Note que não existe mais
/// uma camada "short" aqui: o rastro de movimento recente agora é um
/// acumulador contínuo na GPU (veja `renderer.rs`), não um conjunto de
/// registros discretos como intermediate/long.
fn layer_kind_from_str(name: &str) -> Result<LayerKind, JsValue> {
    if name == "intermediate" {
        return Ok(LayerKind::Intermediate);
    }
    if name == "long" {
        return Ok(LayerKind::Long);
    }
    let message = format!("camada de memória desconhecida: {}", name);
    Err(JsValue::from_str(&message))
}

/// Esta é a classe que o JavaScript realmente vai usar
/// (`new Engine()`, `engine.insertFrame(...)`, etc).
#[wasm_bindgen]
pub struct Engine {
    memory: TemporalMemory,
    /// Guarda o resultado da última chamada a `update()`, para que os
    /// métodos `active_*` abaixo possam ler os valores por índice.
    active_cache: Vec<RenderRecord>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine {
            memory: TemporalMemory::new(),
            active_cache: Vec::new(),
        }
    }

    /// Muda a configuração de uma das duas camadas discretas
    /// ("intermediate" ou "long"). As durações são em milissegundos.
    /// `reappearance_strength`/`reappearance_frequency` controlam o
    /// efeito de "reaparecimentos ocasionais" (ver `memory.rs`); passe
    /// `0.0` para `reappearance_strength` para um fade liso, sem pulsar.
    #[wasm_bindgen(js_name = configureLayer)]
    pub fn configure_layer(
        &mut self,
        layer: &str,
        capacity: usize,
        capture_interval_ms: f64,
        max_age_ms: f64,
        base_weight: f32,
        fade_power: f32,
        drift_amount: f32,
        reappearance_strength: f32,
        reappearance_frequency: f32,
    ) -> Result<(), JsValue> {
        let kind = layer_kind_from_str(layer)?;
        let new_config = LayerConfig {
            capacity,
            capture_interval_ms,
            max_age_ms,
            base_weight,
            fade_power,
            drift_amount,
            reappearance_strength,
            reappearance_frequency,
        };
        self.memory.layer_mut(kind).reconfigure(new_config);
        Ok(())
    }

    /// Recebe uma captura de imagem (já em resolução reduzida, no formato
    /// RGBA) e entrega para a memória guardar. Cada camada decide, por
    /// conta própria, se vai realmente guardar essa captura ou não.
    #[wasm_bindgen(js_name = insertFrame)]
    pub fn insert_frame(&mut self, timestamp_ms: f64, width: u32, height: u32, intensity: f32, rgba: &[u8]) {
        self.insert_clip(timestamp_ms, width, height, intensity, 1.0, rgba);
    }

    /// Recebe quadros RGBA consecutivos de um clipe, todos com as mesmas dimensões.
    #[wasm_bindgen(js_name = insertClip)]
    pub fn insert_clip(&mut self, timestamp_ms: f64, width: u32, height: u32, intensity: f32, frame_interval_ms: f64, rgba: &[u8]) {
        let Some(frame_bytes) = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
        else {
            return;
        };
        if frame_bytes == 0 || rgba.is_empty() || rgba.len() % frame_bytes != 0 ||
            !timestamp_ms.is_finite() || !frame_interval_ms.is_finite() || frame_interval_ms <= 0.0 {
            return;
        }

        let record = MemoryRecord {
            timestamp_ms,
            width,
            height,
            pixels: rgba.into(),
            frame_interval_ms,
            intensity,
        };
        self.memory.insert(record);
    }

    /// Deve ser chamado uma vez por frame de renderização. Primeiro remove
    /// os registros que já expiraram, depois recalcula a lista de
    /// registros ativos (do mais antigo para o mais novo) e guarda no
    /// cache interno. Retorna quantos registros estão ativos agora.
    pub fn update(&mut self, now_ms: f64) -> usize {
        self.memory.expire_all(now_ms);
        self.active_cache = self.memory.collect_active(now_ms);
        self.active_cache.len()
    }

    /// A partir daqui, são só "getters": funções que leem um campo do
    /// registro ativo número `index` (depois de já ter chamado `update`).
    /// Se o índice não existir, devolvem um valor neutro em vez de travar.
    #[wasm_bindgen(js_name = activeLayer)]
    pub fn active_layer(&self, index: usize) -> String {
        let found = self.active_cache.get(index);
        let name = match found {
            Some(render_record) => match render_record.layer {
                LayerKind::Intermediate => "intermediate",
                LayerKind::Long => "long",
            },
            None => "",
        };
        name.to_string()
    }

    #[wasm_bindgen(js_name = activeAgeMs)]
    pub fn active_age_ms(&self, index: usize) -> f64 {
        match self.active_cache.get(index) {
            Some(r) => r.age_ms,
            None => 0.0,
        }
    }

    /// De 0.0 (registro recém-nascido) a 1.0 (no limite de idade da sua
    /// camada, quase desaparecendo). Usado para dar um ar mais
    /// "fantasmagórico" aos vestígios conforme eles envelhecem.
    #[wasm_bindgen(js_name = activeAgeRatio)]
    pub fn active_age_ratio(&self, index: usize) -> f32 {
        match self.active_cache.get(index) {
            Some(r) => r.age_ratio,
            None => 0.0,
        }
    }

    #[wasm_bindgen(js_name = activeOpacity)]
    pub fn active_opacity(&self, index: usize) -> f32 {
        match self.active_cache.get(index) {
            Some(r) => r.opacity,
            None => 0.0,
        }
    }

    #[wasm_bindgen(js_name = activeOffsetX)]
    pub fn active_offset_x(&self, index: usize) -> f32 {
        match self.active_cache.get(index) {
            Some(r) => r.offset_x,
            None => 0.0,
        }
    }

    #[wasm_bindgen(js_name = activeOffsetY)]
    pub fn active_offset_y(&self, index: usize) -> f32 {
        match self.active_cache.get(index) {
            Some(r) => r.offset_y,
            None => 0.0,
        }
    }

    #[wasm_bindgen(js_name = activeWidth)]
    pub fn active_width(&self, index: usize) -> u32 {
        match self.active_cache.get(index) {
            Some(r) => r.width,
            None => 0,
        }
    }

    #[wasm_bindgen(js_name = activeHeight)]
    pub fn active_height(&self, index: usize) -> u32 {
        match self.active_cache.get(index) {
            Some(r) => r.height,
            None => 0,
        }
    }

    /// Devolve uma cópia dos pixels (RGBA) do registro ativo número `index`.
    #[wasm_bindgen(js_name = activePixels)]
    pub fn active_pixels(&self, index: usize) -> Vec<u8> {
        match self.active_cache.get(index) {
            Some(r) => r.pixels.clone(),
            None => Vec::new(),
        }
    }

    /// Quantos bytes de memória estão sendo usados, no total, pelas duas
    /// camadas discretas (o acumulador de rastro recente, na GPU, não
    /// entra nessa conta). Útil para diagnóstico/depuração.
    #[wasm_bindgen(js_name = totalBytes)]
    pub fn total_bytes(&self) -> usize {
        self.memory.total_bytes()
    }

    /// Quantos registros estão ativos agora (depois da última chamada a
    /// `update`). O `renderer.rs` usa isso para saber quantas vezes deve
    /// desenhar um "eco" na tela.
    #[wasm_bindgen(js_name = activeCount)]
    pub fn active_count(&self) -> usize {
        self.active_cache.len()
    }

    /// Apaga tudo o que está guardado. Deve ser chamado quando a
    /// experiência termina (ver RF10).
    pub fn reset(&mut self) {
        self.memory.clear();
        self.active_cache.clear();
    }

    /// Esta função NÃO é exposta para o JavaScript (não tem
    /// `#[wasm_bindgen]`). Ela é usada só por outro código Rust do mesmo
    /// crate — no caso, o `renderer.rs` — para ler um registro ativo
    /// inteiro de uma vez, em vez de chamar vários getters separados como
    /// `active_width`, `active_opacity`, etc. Isso evita cópias
    /// desnecessárias quando quem está chamando já é Rust.
    pub(crate) fn active_record(&self, index: usize) -> Option<&RenderRecord> {
        self.active_cache.get(index)
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_reported() {
        let version = engine_version();
        assert!(version.starts_with(env!("CARGO_PKG_VERSION")));
        assert!(version.contains('+'), "esperava um build id depois de um '+', veio: {version}");
    }

    #[test]
    fn engine_insert_and_update_cycle() {
        let mut engine = Engine::new();
        engine
            .configure_layer("intermediate", 10, 0.0, 5_000.0, 1.0, 1.0, 0.0, 0.0, 0.0)
            .unwrap();

        // `insert_frame` entrega a captura para as duas camadas. Para
        // este teste só nos interessa a "intermediate", então desligamos
        // a "long" (capacidade 0 = nunca aceita nada).
        engine.configure_layer("long", 0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0).unwrap();

        let pixels = vec![200u8; 2 * 2 * 4];
        engine.insert_frame(0.0, 2, 2, 1.0, &pixels);
        engine.insert_frame(1_000.0, 2, 2, 1.0, &pixels);

        let count = engine.update(1_000.0);
        assert_eq!(count, 2);
        assert_eq!(engine.active_pixels(0).len(), pixels.len());

        engine.reset();
        assert_eq!(engine.total_bytes(), 0);
    }

    #[test]
    fn slow_clips_expire_and_their_still_frames_remain() {
        let mut engine = Engine::new();
        engine.insert_clip(0.0, 1, 1, 1.0, 100.0, &[10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255]);

        let pixels_for = |engine: &Engine, layer| {
            engine.active_cache.iter().find(|record| record.layer == layer).unwrap().pixels[0]
        };
        engine.update(0.0);
        assert_eq!(pixels_for(&engine, LayerKind::Intermediate), 10);
        assert_eq!(pixels_for(&engine, LayerKind::Long), 20);

        let intermediate_opacity = |engine: &Engine| {
            engine.active_cache.iter().find(|record| record.layer == LayerKind::Intermediate).unwrap().opacity
        };
        let initial_opacity = intermediate_opacity(&engine);
        for (time, expected) in [(100.0, 10), (200.0, 20), (400.0, 30), (550.0, 30), (750.0, 30)] {
            engine.update(time);
            assert_eq!(pixels_for(&engine, LayerKind::Intermediate), expected);
            assert_eq!(pixels_for(&engine, LayerKind::Long), 20);
            if time < 360.0 {
                assert_eq!(intermediate_opacity(&engine), initial_opacity);
            } else {
                assert!(intermediate_opacity(&engine) < initial_opacity);
            }
        }

        assert_eq!(engine.update(300_000.0), 1);
        assert_eq!(pixels_for(&engine, LayerKind::Long), 20);
        assert!(engine.active_cache[0].opacity > 0.0);
    }
}

// Observação sobre testes: o caminho de erro de `configure_layer` (quando
// o nome da camada não existe) cria um `JsValue`. Isso só funciona de
// verdade quando o código está rodando como WebAssembly dentro do
// navegador — testar esse caminho com `cargo test` (que roda como um
// programa nativo do Windows, não como WebAssembly) faz o processo
// travar. Por isso esse caso de erro não tem um teste nativo aqui; ele é
// simples o suficiente (só compara texto) para revisar lendo o código.
