// Este arquivo só guarda números: os parâmetros artísticos dos efeitos
// visuais (RF06 - Underwater Distortion, RF07 - Dissolução). Ele não sabe
// nada sobre GPU, shaders ou wgpu — isso é de propósito! Assim, quem quiser
// só ajustar "a distorção está forte demais" não precisa entender como o
// `renderer.rs` desenha as coisas na tela.

/// Configuração dos efeitos visuais. Os valores padrão (`default_config`)
/// foram escolhidos para um efeito suave; o painel de desenvolvimento
/// (a ser feito na Etapa 5) poderá deixar o visitante/desenvolvedor
/// ajustar esses números em tempo real.
#[derive(Clone, Copy, Debug)]
pub struct EffectConfig {
    /// O quanto a imagem ondula (0.0 = sem ondulação nenhuma).
    pub underwater_intensity: f32,
    /// Quantas "ondas" cabem na imagem.
    pub underwater_frequency: f32,
    /// A velocidade com que as ondas se movem.
    pub underwater_speed: f32,
    /// O tamanho do deslocamento causado pelas ondas.
    pub underwater_amplitude: f32,
    /// O quanto os vestígios antigos se "fragmentam" (em pedacinhos)
    /// conforme desaparecem. 0.0 = desaparecem de forma lisa/uniforme.
    pub dissolve_fragmentation: f32,
}

impl EffectConfig {
    pub fn default_config() -> Self {
        EffectConfig {
            underwater_intensity: 0.35,
            underwater_frequency: 2.2,
            underwater_speed: 0.6,
            underwater_amplitude: 0.015,
            dissolve_fragmentation: 0.6,
        }
    }
}

impl Default for EffectConfig {
    fn default() -> Self {
        Self::default_config()
    }
}
