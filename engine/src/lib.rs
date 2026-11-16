mod memory;

use memory::{LayerConfig, LayerKind, MemoryRecord, RenderRecord, TemporalMemory};
use wasm_bindgen::prelude::*;

/// Confirms the WASM module loaded and can be called from JS.
#[wasm_bindgen]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn layer_kind_from_str(name: &str) -> Result<LayerKind, JsValue> {
    match name {
        "short" => Ok(LayerKind::Short),
        "intermediate" => Ok(LayerKind::Intermediate),
        "long" => Ok(LayerKind::Long),
        other => Err(JsValue::from_str(&format!("camada de memória desconhecida: {other}"))),
    }
}

/// JS-facing wrapper around [`TemporalMemory`]. Keeps a small cache of the
/// last `collect_active` result so JS can read each field with a cheap
/// index-based getter instead of paying a (de)serialization cost per frame.
#[wasm_bindgen]
pub struct Engine {
    memory: TemporalMemory,
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

    /// Overrides one layer's configuration. Durations are in milliseconds.
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
    ) -> Result<(), JsValue> {
        let kind = layer_kind_from_str(layer)?;
        self.memory.layer_mut(kind).reconfigure(LayerConfig {
            capacity,
            capture_interval_ms,
            max_age_ms,
            base_weight,
            fade_power,
            drift_amount,
        });
        Ok(())
    }

    /// Feeds one reduced-resolution RGBA capture into the memory. Each
    /// layer decides independently (by its own sampling interval) whether
    /// to actually retain it.
    #[wasm_bindgen(js_name = insertFrame)]
    pub fn insert_frame(&mut self, timestamp_ms: f64, width: u32, height: u32, intensity: f32, rgba: &[u8]) {
        self.memory.insert(MemoryRecord {
            timestamp_ms,
            width,
            height,
            pixels: rgba.to_vec(),
            intensity,
        });
    }

    /// Drops expired records and recomputes the oldest-first active list
    /// for `now_ms`. Returns how many records are now active. Call once per
    /// render frame, then read fields with the `active*` getters below.
    pub fn update(&mut self, now_ms: f64) -> usize {
        self.memory.expire_all(now_ms);
        self.active_cache = self.memory.collect_active(now_ms);
        self.active_cache.len()
    }

    #[wasm_bindgen(js_name = activeLayer)]
    pub fn active_layer(&self, index: usize) -> String {
        match self.active_cache.get(index).map(|r| r.layer) {
            Some(LayerKind::Short) => "short",
            Some(LayerKind::Intermediate) => "intermediate",
            Some(LayerKind::Long) => "long",
            None => "",
        }
        .to_string()
    }

    #[wasm_bindgen(js_name = activeAgeMs)]
    pub fn active_age_ms(&self, index: usize) -> f64 {
        self.active_cache.get(index).map(|r| r.age_ms).unwrap_or(0.0)
    }

    #[wasm_bindgen(js_name = activeOpacity)]
    pub fn active_opacity(&self, index: usize) -> f32 {
        self.active_cache.get(index).map(|r| r.opacity).unwrap_or(0.0)
    }

    #[wasm_bindgen(js_name = activeOffsetX)]
    pub fn active_offset_x(&self, index: usize) -> f32 {
        self.active_cache.get(index).map(|r| r.offset_x).unwrap_or(0.0)
    }

    #[wasm_bindgen(js_name = activeOffsetY)]
    pub fn active_offset_y(&self, index: usize) -> f32 {
        self.active_cache.get(index).map(|r| r.offset_y).unwrap_or(0.0)
    }

    #[wasm_bindgen(js_name = activeWidth)]
    pub fn active_width(&self, index: usize) -> u32 {
        self.active_cache.get(index).map(|r| r.width).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = activeHeight)]
    pub fn active_height(&self, index: usize) -> u32 {
        self.active_cache.get(index).map(|r| r.height).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = activePixels)]
    pub fn active_pixels(&self, index: usize) -> Vec<u8> {
        self.active_cache.get(index).map(|r| r.pixels.clone()).unwrap_or_default()
    }

    #[wasm_bindgen(js_name = totalBytes)]
    pub fn total_bytes(&self) -> usize {
        self.memory.total_bytes()
    }

    /// Discards every stored record. Call on session end (RF10).
    pub fn reset(&mut self) {
        self.memory.clear();
        self.active_cache.clear();
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
        assert_eq!(engine_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn engine_insert_and_update_cycle() {
        let mut engine = Engine::new();
        engine
            .configure_layer("short", 10, 0.0, 5_000.0, 1.0, 1.0, 0.0)
            .unwrap();
        // insert_frame feeds every layer; disable the other two so this
        // test can reason about the short layer in isolation.
        engine
            .configure_layer("intermediate", 0, 0.0, 0.0, 0.0, 1.0, 0.0)
            .unwrap();
        engine.configure_layer("long", 0, 0.0, 0.0, 0.0, 1.0, 0.0).unwrap();

        let pixels = vec![200u8; 2 * 2 * 4];
        engine.insert_frame(0.0, 2, 2, 1.0, &pixels);
        engine.insert_frame(1_000.0, 2, 2, 1.0, &pixels);

        let count = engine.update(1_000.0);
        assert_eq!(count, 2);
        assert_eq!(engine.active_pixels(0).len(), pixels.len());

        engine.reset();
        assert_eq!(engine.total_bytes(), 0);
    }
}

// `configure_layer`'s error path constructs a `JsValue`, which relies on JS
// externs that only exist when actually running under wasm32 — exercising
// it from a native `cargo test` process aborts the process. The success
// path above is safe natively because it never touches `JsValue::from_str`.
// `layer_kind_from_str`'s matching logic is otherwise covered indirectly by
// every test that configures a named layer.
