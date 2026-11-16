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

/// Calcula quanto do acumulador de rastro "sobrevive" de um quadro para
/// o outro: 1.0 = nada se perde, 0.0 = desbota por completo.
///
/// Fica aqui (em vez de dentro de `renderer.rs`) só para poder ser
/// testado com `cargo test` normal — `renderer.rs` só compila para
/// WebAssembly, então não dá para testar a lógica de lá diretamente
/// fora do navegador. Essa função é exatamente a mesma conta que o
/// `Renderer` usa de verdade; só vive aqui separada para ficar testável.
///
/// Usa uma curva exponencial (`exp(-taxa * tempo)`) de propósito: assim,
/// o resultado depende só do tempo real passado (`dt_seconds`), nunca da
/// quantidade de quadros por segundo — dois celulares com FPS diferentes
/// devem ver o rastro desbotar no mesmo ritmo real.
pub fn trail_decay_factor(decay_per_second: f32, dt_seconds: f32) -> f32 {
    (-decay_per_second * dt_seconds).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decay_factor_is_one_when_no_time_passed() {
        assert!((trail_decay_factor(1.5, 0.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn decay_factor_shrinks_as_time_passes() {
        let after_a_bit = trail_decay_factor(1.5, 0.5);
        let after_longer = trail_decay_factor(1.5, 2.0);

        assert!(after_a_bit < 1.0, "devia ter desbotado um pouco");
        assert!(after_longer < after_a_bit, "quanto mais tempo passa, mais desbota");
        assert!(after_longer > 0.0, "nunca deve ficar negativo");
    }

    #[test]
    fn decay_factor_is_independent_of_frame_rate() {
        // Dois jeitos de "chegar" em 1 segundo: um quadro de 1s inteiro,
        // ou dez quadros de 0.1s cada (como se fosse ~10 FPS). O
        // resultado final (depois de aplicar os dez decaimentos em
        // sequência) deve ser igual, porque a curva é exponencial.
        let one_big_step = trail_decay_factor(2.0, 1.0);

        let mut accumulated = 1.0;
        for _ in 0..10 {
            accumulated *= trail_decay_factor(2.0, 0.1);
        }

        assert!(
            (one_big_step - accumulated).abs() < 1e-4,
            "esperava o mesmo resultado final independente do tamanho dos passos: {one_big_step} vs {accumulated}"
        );
    }
}
