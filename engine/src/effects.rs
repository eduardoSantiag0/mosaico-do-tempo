// Este arquivo só guarda números: os parâmetros artísticos dos efeitos
// visuais (o campo de deslocamento temporal e a dissolução). Ele não
// sabe nada sobre GPU, shaders ou wgpu — isso é de propósito! Assim,
// quem quiser só ajustar "a distorção está forte demais" não precisa
// entender como o `renderer.rs` desenha as coisas na tela.

/// Configuração dos efeitos visuais. Os valores padrão (`default_config`)
/// foram escolhidos para um efeito sutil e orgânico; o painel de
/// desenvolvimento deixa o visitante/desenvolvedor ajustar esses números
/// em tempo real.
#[derive(Clone, Copy, Debug)]
pub struct EffectConfig {
    /// O quanto o "campo de deslocamento temporal" desloca os pixels
    /// (0.0 = nenhum deslocamento). Usado tanto nos ecos (ligado à idade
    /// do registro) quanto no reflexo atual (ligado à presença recente
    /// guardada no acumulador de rastro).
    pub displacement_intensity: f32,
    /// Quantas "dobras" do campo cabem na imagem.
    pub displacement_frequency: f32,
    /// A velocidade com que o campo se move no tempo.
    pub displacement_speed: f32,
    /// O tamanho máximo do deslocamento.
    pub displacement_amplitude: f32,
    /// O quanto os vestígios antigos se "fragmentam" (em pedacinhos)
    /// conforme desaparecem. 0.0 = desaparecem de forma lisa/uniforme.
    pub dissolve_fragmentation: f32,
    /// O quanto o acumulador de rastro (memória curta) "esquece" por
    /// segundo. Valores maiores fazem o rastro desbotar mais rápido.
    /// É uma taxa contínua (estilo "meia-vida"), não uma duração fixa.
    pub trail_decay_per_second: f32,
    /// Opacidade com que cada captura nova é somada ao acumulador de
    /// rastro, antes de começar a desbotar.
    pub trail_capture_opacity: f32,
}

impl EffectConfig {
    pub fn default_config() -> Self {
        EffectConfig {
            displacement_intensity: 0.4,
            displacement_frequency: 2.0,
            displacement_speed: 0.45,
            displacement_amplitude: 0.018,
            dissolve_fragmentation: 0.55,
            trail_decay_per_second: 1.5,
            trail_capture_opacity: 0.8,
        }
    }
}

impl Default for EffectConfig {
    fn default() -> Self {
        Self::default_config()
    }
}
