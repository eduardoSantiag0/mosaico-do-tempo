//! Temporal memory: three independent circular-buffer layers that hold
//! reduced-resolution snapshots of the visitor's silhouette over time.
//! Expiration and fade are driven entirely by timestamps (ms), so playback
//! is correct regardless of the capture frame rate.

use std::collections::VecDeque;

#[derive(Clone)]
pub struct MemoryRecord {
    pub timestamp_ms: f64,
    pub width: u32,
    pub height: u32,
    /// RGBA pixels, already reduced in resolution by the caller.
    pub pixels: Vec<u8>,
    /// Caller-supplied visual weight for this capture (e.g. motion amount), 0..1.
    pub intensity: f32,
}

impl MemoryRecord {
    fn byte_len(&self) -> usize {
        self.pixels.len()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerConfig {
    pub capacity: usize,
    pub capture_interval_ms: f64,
    pub max_age_ms: f64,
    /// Peak opacity multiplier applied to this layer's records.
    pub base_weight: f32,
    /// Exponent of the (1 - age/max_age) fade curve; >1 holds longer then drops fast.
    pub fade_power: f32,
    /// Max lateral drift (in normalized units) applied as records age.
    pub drift_amount: f32,
}

impl LayerConfig {
    pub fn short_default() -> Self {
        LayerConfig {
            capacity: 48,
            capture_interval_ms: 80.0,
            max_age_ms: 5_000.0,
            base_weight: 0.9,
            fade_power: 1.0,
            drift_amount: 0.0,
        }
    }

    pub fn intermediate_default() -> Self {
        LayerConfig {
            capacity: 50,
            capture_interval_ms: 600.0,
            max_age_ms: 30_000.0,
            base_weight: 0.55,
            fade_power: 1.4,
            drift_amount: 0.03,
        }
    }

    pub fn long_default() -> Self {
        LayerConfig {
            capacity: 30,
            capture_interval_ms: 4_000.0,
            max_age_ms: 120_000.0,
            base_weight: 0.3,
            fade_power: 2.4,
            drift_amount: 0.06,
        }
    }
}

pub struct MemoryLayer {
    pub config: LayerConfig,
    records: VecDeque<MemoryRecord>,
    last_capture_ms: Option<f64>,
}

impl MemoryLayer {
    pub fn new(config: LayerConfig) -> Self {
        MemoryLayer {
            config,
            records: VecDeque::with_capacity(config.capacity),
            last_capture_ms: None,
        }
    }

    pub fn reconfigure(&mut self, config: LayerConfig) {
        self.config = config;
        while self.records.len() > self.config.capacity {
            self.records.pop_front();
        }
    }

    pub fn clear(&mut self) {
        self.records.clear();
        self.last_capture_ms = None;
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn total_bytes(&self) -> usize {
        self.records.iter().map(MemoryRecord::byte_len).sum()
    }

    /// Attempts to insert a capture, respecting this layer's own sampling
    /// rate. Returns true if the record was accepted.
    pub fn maybe_insert(&mut self, record: MemoryRecord) -> bool {
        if let Some(last) = self.last_capture_ms {
            if record.timestamp_ms - last < self.config.capture_interval_ms {
                return false;
            }
        }
        if self.config.capacity == 0 {
            return false;
        }
        if self.records.len() >= self.config.capacity {
            self.records.pop_front();
        }
        self.last_capture_ms = Some(record.timestamp_ms);
        self.records.push_back(record);
        true
    }

    /// Drops records older than this layer's max age, given the current time.
    pub fn expire(&mut self, now_ms: f64) {
        while let Some(front) = self.records.front() {
            if now_ms - front.timestamp_ms > self.config.max_age_ms {
                self.records.pop_front();
            } else {
                break;
            }
        }
    }

    /// Oldest-first iterator over records that are currently visible
    /// (non-negative age, within max_age), paired with their computed fade.
    pub fn active(&self, now_ms: f64) -> impl Iterator<Item = (&MemoryRecord, RecordFade)> {
        let cfg = self.config;
        self.records.iter().filter_map(move |r| {
            let age_ms = now_ms - r.timestamp_ms;
            if age_ms < 0.0 || age_ms > cfg.max_age_ms {
                return None;
            }
            Some((r, compute_fade(r, &cfg, age_ms)))
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RecordFade {
    pub age_ms: f64,
    pub opacity: f32,
    pub offset_x: f32,
    pub offset_y: f32,
}

fn compute_fade(record: &MemoryRecord, cfg: &LayerConfig, age_ms: f64) -> RecordFade {
    let age_ratio = (age_ms / cfg.max_age_ms).clamp(0.0, 1.0) as f32;
    let remaining = (1.0 - age_ratio).max(0.0);
    let opacity = remaining.powf(cfg.fade_power) * cfg.base_weight * record.intensity.clamp(0.0, 1.0);

    let drift = cfg.drift_amount * age_ratio;
    let seed = record.timestamp_ms * 0.0017;
    let offset_x = (seed.sin() as f32) * drift;
    let offset_y = (seed.cos() as f32) * drift * 0.6;

    RecordFade {
        age_ms,
        opacity,
        offset_x,
        offset_y,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerKind {
    Short,
    Intermediate,
    Long,
}

/// A fully resolved record ready for compositing/rendering.
pub struct RenderRecord {
    pub layer: LayerKind,
    pub timestamp_ms: f64,
    pub age_ms: f64,
    pub width: u32,
    pub height: u32,
    pub opacity: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    pub pixels: Vec<u8>,
}

pub struct TemporalMemory {
    pub short: MemoryLayer,
    pub intermediate: MemoryLayer,
    pub long: MemoryLayer,
}

impl TemporalMemory {
    pub fn new() -> Self {
        TemporalMemory {
            short: MemoryLayer::new(LayerConfig::short_default()),
            intermediate: MemoryLayer::new(LayerConfig::intermediate_default()),
            long: MemoryLayer::new(LayerConfig::long_default()),
        }
    }

    pub fn layer_mut(&mut self, kind: LayerKind) -> &mut MemoryLayer {
        match kind {
            LayerKind::Short => &mut self.short,
            LayerKind::Intermediate => &mut self.intermediate,
            LayerKind::Long => &mut self.long,
        }
    }

    pub fn layer(&self, kind: LayerKind) -> &MemoryLayer {
        match kind {
            LayerKind::Short => &self.short,
            LayerKind::Intermediate => &self.intermediate,
            LayerKind::Long => &self.long,
        }
    }

    /// Feeds one capture into every layer; each layer independently decides
    /// (via its own sampling interval) whether to actually keep it.
    pub fn insert(&mut self, record: MemoryRecord) {
        self.short.maybe_insert(record.clone());
        self.intermediate.maybe_insert(record.clone());
        self.long.maybe_insert(record);
    }

    pub fn expire_all(&mut self, now_ms: f64) {
        self.short.expire(now_ms);
        self.intermediate.expire(now_ms);
        self.long.expire(now_ms);
    }

    pub fn total_bytes(&self) -> usize {
        self.short.total_bytes() + self.intermediate.total_bytes() + self.long.total_bytes()
    }

    pub fn clear(&mut self) {
        self.short.clear();
        self.intermediate.clear();
        self.long.clear();
    }

    /// Oldest-first across all layers, so the current reflex is painted last.
    pub fn collect_active(&self, now_ms: f64) -> Vec<RenderRecord> {
        let mut out = Vec::new();
        for (kind, layer) in [
            (LayerKind::Long, &self.long),
            (LayerKind::Intermediate, &self.intermediate),
            (LayerKind::Short, &self.short),
        ] {
            for (record, fade) in layer.active(now_ms) {
                out.push(RenderRecord {
                    layer: kind,
                    timestamp_ms: record.timestamp_ms,
                    age_ms: fade.age_ms,
                    width: record.width,
                    height: record.height,
                    opacity: fade.opacity,
                    offset_x: fade.offset_x,
                    offset_y: fade.offset_y,
                    pixels: record.pixels.clone(),
                });
            }
        }
        out.sort_by(|a, b| b.age_ms.partial_cmp(&a.age_ms).unwrap());
        out
    }
}

impl Default for TemporalMemory {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(ts: f64) -> MemoryRecord {
        MemoryRecord {
            timestamp_ms: ts,
            width: 4,
            height: 4,
            pixels: vec![255; 4 * 4 * 4],
            intensity: 1.0,
        }
    }

    #[test]
    fn insert_respects_capture_interval() {
        let mut layer = MemoryLayer::new(LayerConfig {
            capacity: 10,
            capture_interval_ms: 100.0,
            max_age_ms: 5_000.0,
            base_weight: 1.0,
            fade_power: 1.0,
            drift_amount: 0.0,
        });

        assert!(layer.maybe_insert(record(0.0)));
        assert!(!layer.maybe_insert(record(50.0)), "too soon, should be rejected");
        assert!(layer.maybe_insert(record(120.0)));
        assert_eq!(layer.len(), 2);
    }

    #[test]
    fn expiration_drops_old_records_by_timestamp() {
        let mut layer = MemoryLayer::new(LayerConfig {
            capacity: 10,
            capture_interval_ms: 0.0,
            max_age_ms: 1_000.0,
            base_weight: 1.0,
            fade_power: 1.0,
            drift_amount: 0.0,
        });

        layer.maybe_insert(record(0.0));
        layer.maybe_insert(record(500.0));
        layer.maybe_insert(record(1_200.0));

        // At 1600ms, ts=0 (age 1600) and ts=500 (age 1100) both exceed the
        // 1000ms max age; only ts=1200 (age 400) is still within it.
        layer.expire(1_600.0);
        assert_eq!(layer.len(), 1, "both records past max_age should be dropped");

        layer.expire(3_000.0);
        assert_eq!(layer.len(), 0, "all records should now have expired");
    }

    #[test]
    fn capacity_limit_evicts_oldest_first() {
        let mut layer = MemoryLayer::new(LayerConfig {
            capacity: 3,
            capture_interval_ms: 0.0,
            max_age_ms: 100_000.0,
            base_weight: 1.0,
            fade_power: 1.0,
            drift_amount: 0.0,
        });

        for i in 0..5 {
            layer.maybe_insert(record(i as f64 * 10.0));
        }

        assert_eq!(layer.len(), 3);
        let timestamps: Vec<f64> = layer.active(40.0).map(|(r, _)| r.timestamp_ms).collect();
        assert_eq!(timestamps, vec![20.0, 30.0, 40.0]);
    }

    #[test]
    fn expiration_is_independent_of_sampling_rate() {
        // Simulate a variable-FPS capture loop: whatever the frame rate,
        // visibility is decided purely by (now - timestamp).
        let mut layer = MemoryLayer::new(LayerConfig {
            capacity: 100,
            capture_interval_ms: 0.0,
            max_age_ms: 1_000.0,
            base_weight: 1.0,
            fade_power: 1.0,
            drift_amount: 0.0,
        });

        let irregular_frame_times = [0.0, 16.0, 48.0, 49.0, 300.0, 301.0, 980.0, 1_500.0];
        for t in irregular_frame_times {
            layer.maybe_insert(record(t));
        }

        let visible_at_1000: Vec<f64> = layer.active(1_000.0).map(|(r, _)| r.timestamp_ms).collect();
        assert!(visible_at_1000.contains(&980.0));

        // ts=0 sits exactly at max_age when now=1000; push one ms further
        // so its age unambiguously exceeds the limit.
        let visible_at_1001: Vec<f64> = layer.active(1_001.0).map(|(r, _)| r.timestamp_ms).collect();
        assert!(!visible_at_1001.contains(&0.0));
    }

    #[test]
    fn fade_reaches_zero_opacity_at_max_age() {
        let mut layer = MemoryLayer::new(LayerConfig {
            capacity: 10,
            capture_interval_ms: 0.0,
            max_age_ms: 1_000.0,
            base_weight: 0.8,
            fade_power: 1.0,
            drift_amount: 0.0,
        });
        layer.maybe_insert(record(0.0));

        let (_, fade_start) = layer.active(0.0).next().unwrap();
        let (_, fade_end) = layer.active(999.999).next().unwrap();

        assert!((fade_start.opacity - 0.8).abs() < 1e-5);
        assert!(fade_end.opacity < 0.01);
    }

    #[test]
    fn total_bytes_tracks_capacity_bound() {
        let mut layer = MemoryLayer::new(LayerConfig {
            capacity: 2,
            capture_interval_ms: 0.0,
            max_age_ms: 100_000.0,
            base_weight: 1.0,
            fade_power: 1.0,
            drift_amount: 0.0,
        });
        let per_record = record(0.0).pixels.len();

        for i in 0..10 {
            layer.maybe_insert(record(i as f64));
        }

        assert_eq!(layer.total_bytes(), per_record * 2, "bytes must stay bounded by capacity");
    }

    #[test]
    fn session_reset_clears_every_layer() {
        let mut memory = TemporalMemory::new();
        memory.short.config.capture_interval_ms = 0.0;
        memory.intermediate.config.capture_interval_ms = 0.0;
        memory.long.config.capture_interval_ms = 0.0;

        memory.insert(record(0.0));
        assert!(memory.total_bytes() > 0);

        memory.clear();
        assert_eq!(memory.total_bytes(), 0);
    }

    #[test]
    fn collect_active_orders_oldest_first() {
        let mut memory = TemporalMemory::new();
        memory.short.config.capture_interval_ms = 0.0;
        memory.short.config.max_age_ms = 10_000.0;

        memory.short.maybe_insert(record(0.0));
        memory.short.maybe_insert(record(1_000.0));
        memory.short.maybe_insert(record(2_000.0));

        let active = memory.collect_active(2_000.0);
        let ages: Vec<f64> = active.iter().map(|r| r.age_ms).collect();
        assert!(ages.windows(2).all(|w| w[0] >= w[1]), "expected descending age (oldest first): {:?}", ages);
    }
}
