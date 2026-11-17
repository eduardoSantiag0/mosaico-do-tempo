// Este arquivo implementa a "memória temporal" do Mosaico do Tempo:
// as camadas INTERMEDIÁRIA e PROLONGADA (os "ecos" e "vestígios"
// discretos). A memória CURTA (o rastro de movimento mais recente) não
// vive aqui — ela é um acumulador contínuo na GPU, feito em
// `renderer.rs`, porque um rastro de movimento fica mais orgânico sendo
// "desenhado e desbotando" continuamente do que sendo um monte de fotos
// separadas se sobrepondo (veja o comentário no topo de `renderer.rs`).
//
// A ideia aqui é simples: cada vez que a câmera captura uma imagem
// reduzida da pessoa (já só com a silhueta, graças à segmentação),
// guardamos essa imagem com um "timestamp" (o momento em que foi
// capturada, em milissegundos). Com o tempo, decidimos se cada imagem
// ainda deve aparecer na tela (ela "existe" por um tempo e depois
// expira) e o quão visível ela deve estar (vai ficando mais
// transparente/fraca, e também pode "pulsar" — ver `reappearance_*`
// abaixo).
//
// Para não gastar memória demais, guardamos no máximo N imagens por
// camada (um "buffer circular": quando enche, a mais antiga é
// descartada para abrir espaço para a mais nova).

#[derive(Clone)]
pub struct MemoryRecord {
    /// O instante (em milissegundos) em que esta imagem foi capturada.
    pub timestamp_ms: f64,
    pub width: u32,
    pub height: u32,
    /// Os pixels da imagem, no formato RGBA (4 bytes por pixel), já em
    /// resolução reduzida. Nunca guardamos o frame da câmera em tamanho
    /// completo aqui.
    pub pixels: Vec<u8>,
    /// Um valor de 0.0 a 1.0 que diz "o quão importante/visível" essa
    /// captura deveria ser desde o início (pode vir sempre 1.0 por enquanto).
    pub intensity: f32,
}

/// Configuração de uma camada de memória. Todos esses valores podem ser
/// ajustados depois (por isso ficam numa struct separada, e não "fixos"
/// no código).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerConfig {
    /// Quantas imagens, no máximo, essa camada guarda ao mesmo tempo.
    pub capacity: usize,
    /// Tempo mínimo (em ms) entre duas capturas aceitas por esta camada.
    /// Isso controla a "taxa de amostragem" — não precisamos guardar todo
    /// frame da câmera, só uma amostra de tempos em tempos.
    pub capture_interval_ms: f64,
    /// Depois de quanto tempo (em ms) uma imagem desta camada deve
    /// desaparecer completamente.
    pub max_age_ms: f64,
    /// Opacidade máxima que um registro desta camada pode ter (0.0 a 1.0).
    pub base_weight: f32,
    /// Controla a "curva" do desaparecimento. Com valor 1.0 o fade é linear.
    /// Valores maiores fazem a imagem continuar bem visível por mais tempo
    /// e só desaparecer rápido perto do fim da vida.
    pub fade_power: f32,
    /// O quanto a imagem pode "derivar" (se deslocar) lateralmente conforme
    /// envelhece. 0.0 significa "não se move".
    pub drift_amount: f32,
    /// Em vez de desbotar de um jeito sempre suave e previsível, a
    /// camada PROLONGADA deve dar a impressão de "reaparecimentos
    /// ocasionais e discretos" (ver seção 4.3 do briefing artístico).
    /// Fazemos isso multiplicando a opacidade por uma onda que sobe e
    /// desce ao longo da vida do registro. `reappearance_strength` (0.0
    /// a 1.0) controla o quanto essa onda chega a escurecer o registro
    /// nos "vales"; 0.0 desliga completamente o efeito (fade liso, como
    /// antes). `reappearance_frequency` controla quantas vezes essa onda
    /// sobe e desce durante a vida do registro.
    pub reappearance_strength: f32,
    pub reappearance_frequency: f32,
}

impl LayerConfig {
    // Estes dois "_default()" só valem até `web/src/main.ts` chamar
    // `engine.configureLayer(...)` com os valores de verdade, vindos de
    // `config/effects.json` (isso acontece logo na inicialização, antes
    // de qualquer quadro ser desenhado). Ainda assim, mantemos esses
    // números iguais aos de `config/effects.json` de propósito — assim,
    // quem só ler este arquivo não é enganado sobre a configuração real.
    //
    // Importante: `capacity * capture_interval_ms` deveria ficar perto
    // de `max_age_ms`. Se a capacidade for pequena demais para o
    // intervalo de captura, um registro é expulso do buffer circular
    // (por falta de espaço) bem antes de a curva de fade (`compute_fade`)
    // ter feito ele desbotar de verdade — ele "sai de cena" de repente,
    // em vez de desaparecer suavemente. Isso já aconteceu aqui: ao
    // reduzir só a capacidade (para desenhar menos ecos por quadro, veja
    // `renderer.rs`), sem reduzir também o intervalo de captura, cada
    // registro passou a ser expulso ainda bem visível.
    pub fn intermediate_default() -> Self {
        LayerConfig {
            capacity: 14,
            capture_interval_ms: 1_857.0, // 14 * 1857 ≈ 26_000 = max_age_ms
            max_age_ms: 26_000.0,
            base_weight: 0.42,
            fade_power: 1.4,
            drift_amount: 0.025,
            reappearance_strength: 0.0,
            reappearance_frequency: 0.0,
        }
    }

    pub fn long_default() -> Self {
        LayerConfig {
            capacity: 8,
            capture_interval_ms: 13_750.0, // 8 * 13750 = 110_000 = max_age_ms
            max_age_ms: 110_000.0,
            base_weight: 0.2,
            fade_power: 2.0,
            drift_amount: 0.05,
            // Em média, um "pico" de reaparecimento a cada ~16s de vida.
            reappearance_strength: 0.65,
            reappearance_frequency: std::f32::consts::TAU / 16_000.0,
        }
    }
}

/// Dados calculados sobre o quanto um registro deve "mostrar" neste
/// instante: sua opacidade (fade) e um pequeno deslocamento de posição.
#[derive(Clone, Copy, Debug)]
pub struct RecordFade {
    pub age_ms: f64,
    pub opacity: f32,
    pub offset_x: f32,
    pub offset_y: f32,
}

/// Calcula a opacidade e o deslocamento de um registro, dado a idade dele
/// (quanto tempo já passou desde que foi capturado).
fn compute_fade(record: &MemoryRecord, config: &LayerConfig, age_ms: f64) -> RecordFade {
    // "age_ratio" vai de 0.0 (acabou de nascer) até 1.0 (está no limite de
    // idade e vai desaparecer).
    let mut age_ratio = age_ms / config.max_age_ms;
    if age_ratio < 0.0 {
        age_ratio = 0.0;
    }
    if age_ratio > 1.0 {
        age_ratio = 1.0;
    }
    let age_ratio = age_ratio as f32;

    // Quanto "tempo de vida" ainda resta, de 1.0 (recém-nascido) a 0.0 (expirando).
    let remaining = 1.0 - age_ratio;

    // powf eleva "remaining" à potência "fade_power": isso só muda o
    // formato da curva de desaparecimento (mais lenta ou mais rápida).
    let fade_curve = remaining.powf(config.fade_power);

    let mut intensity = record.intensity;
    if intensity < 0.0 {
        intensity = 0.0;
    }
    if intensity > 1.0 {
        intensity = 1.0;
    }

    let mut opacity = fade_curve * config.base_weight * intensity;

    // "Reaparecimentos": multiplica a opacidade por uma onda que sobe e
    // desce. Elevamos a onda ao cubo para que os picos sejam mais curtos
    // e discretos (em vez de uma oscilação lenta e suave o tempo todo).
    if config.reappearance_strength > 0.0 {
        let wave = 0.5 + 0.5 * (age_ms as f32 * config.reappearance_frequency).sin();
        let pulse = wave * wave * wave;
        let pulse_factor = (1.0 - config.reappearance_strength) + config.reappearance_strength * pulse;
        opacity *= pulse_factor;
    }

    // O deslocamento usa seno/cosseno só para dar uma variação suave e
    // "orgânica" — não é um movimento aleatório de verdade, é sempre o
    // mesmo para o mesmo timestamp, o que é bom: o efeito fica estável
    // quadro a quadro em vez de "tremer".
    let drift = config.drift_amount * age_ratio;
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

/// Uma camada de memória: guarda uma lista de registros (no máximo
/// `config.capacity` deles) e sabe como inserir, expirar e listar os
/// registros que ainda estão "vivos".
pub struct MemoryLayer {
    pub config: LayerConfig,
    records: Vec<MemoryRecord>,
    /// Timestamp da última captura aceita. Usamos isso para saber se já
    /// passou tempo suficiente para aceitar uma nova (ver `capture_interval_ms`).
    last_capture_ms: Option<f64>,
}

impl MemoryLayer {
    pub fn new(config: LayerConfig) -> Self {
        MemoryLayer {
            config,
            records: Vec::new(),
            last_capture_ms: None,
        }
    }

    /// Troca a configuração desta camada. Se a nova capacidade for menor
    /// que a quantidade de registros que já temos, descartamos os mais
    /// antigos até caber.
    pub fn reconfigure(&mut self, config: LayerConfig) {
        self.config = config;
        while self.records.len() > self.config.capacity {
            // o índice 0 é sempre o registro mais antigo, porque sempre
            // inserimos no final da lista (veja `maybe_insert`).
            self.records.remove(0);
        }
    }

    pub fn clear(&mut self) {
        self.records.clear();
        self.last_capture_ms = None;
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Soma o tamanho (em bytes) de todas as imagens guardadas nesta
    /// camada. Serve para sabermos quanta memória está sendo usada.
    pub fn total_bytes(&self) -> usize {
        let mut total = 0;
        for record in &self.records {
            total += record.pixels.len();
        }
        total
    }

    /// Tenta guardar uma nova captura nesta camada. Pode ser rejeitada se
    /// ainda não passou tempo suficiente desde a última captura aceita
    /// (cada camada tem seu próprio ritmo, veja `capture_interval_ms`).
    /// Retorna `true` se o registro foi mesmo guardado.
    pub fn maybe_insert(&mut self, record: MemoryRecord) -> bool {
        if let Some(last) = self.last_capture_ms {
            let time_since_last = record.timestamp_ms - last;
            if time_since_last < self.config.capture_interval_ms {
                return false;
            }
        }

        if self.config.capacity == 0 {
            return false;
        }

        // Se já estamos no limite, removemos o mais antigo (índice 0)
        // para abrir espaço — isso é o "buffer circular".
        if self.records.len() >= self.config.capacity {
            self.records.remove(0);
        }

        self.last_capture_ms = Some(record.timestamp_ms);
        self.records.push(record);
        true
    }

    /// Remove os registros cuja idade já passou de `max_age_ms`, usando o
    /// instante atual `now_ms`. Note que isso depende só do tempo (dos
    /// timestamps), nunca da quantidade de frames por segundo.
    pub fn expire(&mut self, now_ms: f64) {
        let mut kept = Vec::new();
        for record in self.records.drain(..) {
            let age_ms = now_ms - record.timestamp_ms;
            if age_ms <= self.config.max_age_ms {
                kept.push(record);
            }
        }
        self.records = kept;
    }

    /// Retorna, do mais antigo para o mais novo, todos os registros que
    /// ainda estão visíveis agora (`now_ms`), junto com sua opacidade e
    /// deslocamento já calculados.
    pub fn active(&self, now_ms: f64) -> Vec<(MemoryRecord, RecordFade)> {
        let mut result = Vec::new();
        for record in &self.records {
            let age_ms = now_ms - record.timestamp_ms;
            if age_ms < 0.0 || age_ms > self.config.max_age_ms {
                // Ainda não existia, ou já devia ter expirado.
                continue;
            }
            let fade = compute_fade(record, &self.config, age_ms);
            result.push((record.clone(), fade));
        }
        result
    }
}

/// Identifica cada uma das duas camadas de memória discretas. O rastro
/// de movimento recente (a antiga camada "curta") agora é o acumulador
/// contínuo de `renderer.rs`, então não aparece aqui.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerKind {
    Intermediate,
    Long,
}

/// Um registro já "pronto para desenhar": junta a imagem com tudo que o
/// compositor/renderizador precisa saber sobre ela (de qual camada veio,
/// opacidade, deslocamento, etc).
pub struct RenderRecord {
    pub layer: LayerKind,
    pub timestamp_ms: f64,
    pub age_ms: f64,
    /// A idade do registro, de 0.0 (recém-nascido) a 1.0 (no limite de
    /// idade, quase desaparecendo). Usado pelos shaders (renderer.rs)
    /// para decidir o quanto distorcer/fragmentar a imagem.
    pub age_ratio: f32,
    pub width: u32,
    pub height: u32,
    pub opacity: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    pub pixels: Vec<u8>,
}

/// Junta as duas camadas discretas (intermediária, prolongada) num só lugar.
pub struct TemporalMemory {
    pub intermediate: MemoryLayer,
    pub long: MemoryLayer,
}

impl TemporalMemory {
    pub fn new() -> Self {
        TemporalMemory {
            intermediate: MemoryLayer::new(LayerConfig::intermediate_default()),
            long: MemoryLayer::new(LayerConfig::long_default()),
        }
    }

    pub fn layer_mut(&mut self, kind: LayerKind) -> &mut MemoryLayer {
        match kind {
            LayerKind::Intermediate => &mut self.intermediate,
            LayerKind::Long => &mut self.long,
        }
    }

    /// Entrega a mesma captura para as duas camadas. Cada uma decide por
    /// conta própria (usando `maybe_insert`) se vai realmente guardar ou
    /// não, de acordo com seu próprio ritmo de captura.
    pub fn insert(&mut self, record: MemoryRecord) {
        self.intermediate.maybe_insert(record.clone());
        self.long.maybe_insert(record);
    }

    pub fn expire_all(&mut self, now_ms: f64) {
        self.intermediate.expire(now_ms);
        self.long.expire(now_ms);
    }

    pub fn total_bytes(&self) -> usize {
        self.intermediate.total_bytes() + self.long.total_bytes()
    }

    pub fn clear(&mut self) {
        self.intermediate.clear();
        self.long.clear();
    }

    /// Junta os registros visíveis das duas camadas numa única lista,
    /// ordenada do mais antigo para o mais novo.
    pub fn collect_active(&self, now_ms: f64) -> Vec<RenderRecord> {
        let mut all = Vec::new();

        let layers = [(LayerKind::Long, &self.long), (LayerKind::Intermediate, &self.intermediate)];

        for (kind, layer) in layers {
            let max_age_ms = layer.config.max_age_ms;
            for (record, fade) in layer.active(now_ms) {
                let mut age_ratio = fade.age_ms / max_age_ms;
                if age_ratio < 0.0 {
                    age_ratio = 0.0;
                }
                if age_ratio > 1.0 {
                    age_ratio = 1.0;
                }

                all.push(RenderRecord {
                    layer: kind,
                    timestamp_ms: record.timestamp_ms,
                    age_ms: fade.age_ms,
                    age_ratio: age_ratio as f32,
                    width: record.width,
                    height: record.height,
                    opacity: fade.opacity,
                    offset_x: fade.offset_x,
                    offset_y: fade.offset_y,
                    pixels: record.pixels,
                });
            }
        }

        // Mais antigo (idade maior) primeiro, mais novo (idade menor) por último.
        all.sort_by(|a, b| b.age_ms.partial_cmp(&a.age_ms).unwrap());
        all
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

    // Função auxiliar só para os testes: cria um registro de 4x4 pixels
    // bem simples, com o timestamp que a gente quiser.
    fn record(timestamp_ms: f64) -> MemoryRecord {
        MemoryRecord {
            timestamp_ms,
            width: 4,
            height: 4,
            pixels: vec![255; 4 * 4 * 4],
            intensity: 1.0,
        }
    }

    fn plain_config(capacity: usize, capture_interval_ms: f64, max_age_ms: f64, base_weight: f32, fade_power: f32) -> LayerConfig {
        LayerConfig {
            capacity,
            capture_interval_ms,
            max_age_ms,
            base_weight,
            fade_power,
            drift_amount: 0.0,
            reappearance_strength: 0.0,
            reappearance_frequency: 0.0,
        }
    }

    #[test]
    fn insert_respects_capture_interval() {
        let mut layer = MemoryLayer::new(plain_config(10, 100.0, 5_000.0, 1.0, 1.0));

        assert!(layer.maybe_insert(record(0.0)));
        assert!(!layer.maybe_insert(record(50.0)), "ainda não passou tempo suficiente");
        assert!(layer.maybe_insert(record(120.0)));
        assert_eq!(layer.len(), 2);
    }

    #[test]
    fn expiration_drops_old_records_by_timestamp() {
        let mut layer = MemoryLayer::new(plain_config(10, 0.0, 1_000.0, 1.0, 1.0));

        layer.maybe_insert(record(0.0));
        layer.maybe_insert(record(500.0));
        layer.maybe_insert(record(1_200.0));

        // Em now = 1600: o registro de t=0 tem idade 1600 (expirou) e o de
        // t=500 tem idade 1100 (também expirou, pois max_age é 1000).
        // Só o de t=1200 (idade 400) continua vivo.
        layer.expire(1_600.0);
        assert_eq!(layer.len(), 1);

        layer.expire(3_000.0);
        assert_eq!(layer.len(), 0, "a essa altura, tudo já devia ter expirado");
    }

    #[test]
    fn capacity_limit_evicts_oldest_first() {
        let mut layer = MemoryLayer::new(plain_config(3, 0.0, 100_000.0, 1.0, 1.0));

        for i in 0..5 {
            layer.maybe_insert(record(i as f64 * 10.0));
        }

        assert_eq!(layer.len(), 3, "a capacidade é 3, então só os 3 últimos devem sobrar");

        let mut timestamps = Vec::new();
        for (r, _fade) in layer.active(40.0) {
            timestamps.push(r.timestamp_ms);
        }
        assert_eq!(timestamps, vec![20.0, 30.0, 40.0]);
    }

    #[test]
    fn expiration_is_independent_of_sampling_rate() {
        // Mesmo com um ritmo de captura bem irregular (como aconteceria
        // numa câmera de verdade, com FPS variável), a visibilidade de
        // cada registro depende só de "quanto tempo passou", não de
        // "quantos frames passaram".
        let mut layer = MemoryLayer::new(plain_config(100, 0.0, 1_000.0, 1.0, 1.0));

        let irregular_frame_times = [0.0, 16.0, 48.0, 49.0, 300.0, 301.0, 980.0, 1_500.0];
        for t in irregular_frame_times {
            layer.maybe_insert(record(t));
        }

        let mut visible_at_1000 = Vec::new();
        for (r, _fade) in layer.active(1_000.0) {
            visible_at_1000.push(r.timestamp_ms);
        }
        assert!(visible_at_1000.contains(&980.0));

        // Em now=1000, o registro t=0 tem idade exatamente 1000 (igual ao
        // limite), então ainda conta como visível. Em now=1001, sua idade
        // passa de 1000 e ele já deve ter desaparecido.
        let mut visible_at_1001 = Vec::new();
        for (r, _fade) in layer.active(1_001.0) {
            visible_at_1001.push(r.timestamp_ms);
        }
        assert!(!visible_at_1001.contains(&0.0));
    }

    #[test]
    fn fade_reaches_zero_opacity_at_max_age() {
        let mut layer = MemoryLayer::new(plain_config(10, 0.0, 1_000.0, 0.8, 1.0));
        layer.maybe_insert(record(0.0));

        let active_now = layer.active(0.0);
        let (_, fade_start) = &active_now[0];

        let active_almost_expired = layer.active(999.999);
        let (_, fade_end) = &active_almost_expired[0];

        assert!((fade_start.opacity - 0.8).abs() < 1e-5);
        assert!(fade_end.opacity < 0.01);
    }

    #[test]
    fn total_bytes_tracks_capacity_bound() {
        let mut layer = MemoryLayer::new(plain_config(2, 0.0, 100_000.0, 1.0, 1.0));
        let bytes_per_record = record(0.0).pixels.len();

        for i in 0..10 {
            layer.maybe_insert(record(i as f64));
        }

        assert_eq!(
            layer.total_bytes(),
            bytes_per_record * 2,
            "o total de bytes nunca deve passar de capacidade * tamanho de um registro"
        );
    }

    #[test]
    fn session_reset_clears_every_layer() {
        let mut memory = TemporalMemory::new();
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
        memory.intermediate.config.capture_interval_ms = 0.0;
        memory.intermediate.config.max_age_ms = 10_000.0;

        memory.intermediate.maybe_insert(record(0.0));
        memory.intermediate.maybe_insert(record(1_000.0));
        memory.intermediate.maybe_insert(record(2_000.0));

        let active = memory.collect_active(2_000.0);

        let mut ages = Vec::new();
        for r in &active {
            ages.push(r.age_ms);
        }

        // A lista deve vir em ordem decrescente de idade: o mais antigo
        // (idade maior) primeiro.
        for i in 0..ages.len() - 1 {
            assert!(ages[i] >= ages[i + 1], "esperava idades em ordem decrescente: {:?}", ages);
        }
    }

    #[test]
    fn reappearance_pulse_creates_brighter_and_dimmer_moments() {
        // Com reappearance_strength > 0, a opacidade não deve cair de
        // forma puramente monotônica — deve haver momentos em que ela
        // sobe de novo (um "pico"), em vez de só diminuir sem parar.
        let config = LayerConfig {
            capacity: 10,
            capture_interval_ms: 0.0,
            max_age_ms: 100_000.0,
            base_weight: 1.0,
            fade_power: 1.0,
            drift_amount: 0.0,
            reappearance_strength: 0.8,
            reappearance_frequency: std::f32::consts::TAU / 10_000.0, // um ciclo a cada 10s
        };
        let mut layer = MemoryLayer::new(config);
        layer.maybe_insert(record(0.0));

        // Amostra a opacidade em vários instantes dentro de um único
        // ciclo da onda de reaparecimento.
        let mut opacities = Vec::new();
        for step in 0..20 {
            let now_ms = step as f64 * 500.0; // 0, 500, 1000, ..., 9500
            let active = layer.active(now_ms);
            opacities.push(active[0].1.opacity);
        }

        let max_opacity = opacities.iter().cloned().fold(f32::MIN, f32::max);
        let min_opacity = opacities.iter().cloned().fold(f32::MAX, f32::min);

        assert!(
            max_opacity - min_opacity > 0.3,
            "esperava uma variação grande entre pico e vale da onda de reaparecimento, mas foi {}",
            max_opacity - min_opacity
        );

        // Em algum ponto depois do primeiro instante, a opacidade deve
        // voltar a SUBIR em relação ao quadro anterior (prova de que não
        // é um fade puramente decrescente).
        let mut saw_an_increase = false;
        for i in 1..opacities.len() {
            if opacities[i] > opacities[i - 1] + 1e-4 {
                saw_an_increase = true;
                break;
            }
        }
        assert!(saw_an_increase, "esperava que a opacidade subisse em algum momento (um 'pico'), não só caísse");
    }
}
