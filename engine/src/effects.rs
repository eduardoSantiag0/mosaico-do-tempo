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
    /// A força MÍNIMA do campo de deslocamento aplicado a um eco, mesmo
    /// recém-nascido (idade 0). Sem isso, um eco começa com deslocamento
    /// zero (força = idade) e só vai ganhando essa "ondulação líquida"
    /// conforme envelhece — então, por um tempo, ele fica quase idêntico
    /// ao reflexo vivo. Com um piso aqui, todo eco já nasce com uma
    /// textura meio líquida, e ainda fica mais forte conforme envelhece
    /// (a força real usada é `mix(echo_displacement_floor, 1.0, idade)`).
    /// 0.0 = comportamento antigo (só a idade controla a força).
    pub echo_displacement_floor: f32,
    /// O quanto o acumulador de rastro RECENTE (a camada "rápida", que
    /// reage a movimento novo) "esquece" por segundo. Valores maiores
    /// fazem esse rastro desbotar mais rápido. É uma taxa contínua
    /// (estilo "meia-vida"), não uma duração fixa.
    pub trail_decay_per_second: f32,
    /// Opacidade com que cada captura nova é somada ao acumulador de
    /// rastro recente, antes de começar a desbotar.
    pub trail_capture_opacity: f32,

    // --- Rastro PROFUNDO ("mar de Solaris") ---
    //
    // Além do rastro recente acima, existe uma segunda camada,
    // profunda, que guarda a mesma captura mas desbota MUITO mais
    // lentamente e nunca chega a realmente zerar: ela oscila entre um
    // piso mínimo de visibilidade e totalmente visível, "aparecendo e
    // desaparecendo" em vez de só desbotar — a ideia de que o passado
    // nunca se apaga de verdade, só se afasta e volta. Ver
    // `renderer.rs::update_trail_accumulator` e o modo de desenho 3 em
    // `composite.wgsl`.
    /// Taxa de esquecimento da camada PROFUNDA — bem menor que
    /// `trail_decay_per_second`, de propósito (meia-vida de minutos,
    /// não de segundos).
    pub trail_deep_decay_per_second: f32,
    /// Opacidade com que cada captura nova é somada à camada profunda.
    /// Menor que `trail_capture_opacity`: a camada profunda é sempre
    /// mais "surda"/discreta que a presença viva ou o rastro recente —
    /// ela é memória, não presença.
    pub trail_deep_capture_opacity: f32,
    /// Fração MÍNIMA da camada profunda que a oscilação (ver
    /// `trail_oscillation_period_seconds`) nunca cruza — por isso ela
    /// nunca desaparece de verdade, só fica mais fraca. É relativa ao
    /// próprio valor já desbotado da camada, não um valor somado à
    /// tela inteira — então um lugar que nunca teve presença continua
    /// em zero (não cria uma névoa uniforme sobre tudo).
    pub trail_deep_floor_ratio: f32,
    /// Período (em segundos) de um ciclo completo de "esmaecer e
    /// voltar" da camada profunda. A fase desse ciclo varia de lugar
    /// para lugar na tela (ver `solaris_swell` em `displacement.wgsl`),
    /// para não parecer um flash sincronizado cobrindo a tela toda.
    pub trail_oscillation_period_seconds: f32,

    // --- Distorção "mar de Solaris", só para o rastro (modo 3) ---
    //
    // O reflexo vivo e os ecos continuam usando `displacement_frequency`/
    // `displacement_speed`/`displacement_amplitude` acima (campo
    // "orgânico" sutil, pensado para não comprometer legibilidade). O
    // rastro usa um campo PRÓPRIO, dedicado — mais lento, mais pesado,
    // com ondulações bem maiores, porque não precisa ficar legível como
    // uma pessoa — ele é o "mar" por trás de tudo.
    /// Frequência espacial do campo do rastro — bem menor que a do
    /// reflexo/ecos, de propósito: ondulações grandes e vastas, não um
    /// padrão fino repetido.
    pub trail_displacement_frequency: f32,
    /// Velocidade do campo do rastro — bem mais lenta que a do
    /// reflexo/ecos: o mar "rasteja", não treme.
    pub trail_displacement_speed: f32,
    /// Amplitude do campo do rastro — maior que a do reflexo/ecos, para
    /// compensar a baixa frequência/velocidade (senão o efeito fica
    /// "murcho" demais para se notar).
    pub trail_displacement_amplitude: f32,
}

impl EffectConfig {
    pub fn default_config() -> Self {
        EffectConfig {
            displacement_intensity: 0.4,
            displacement_frequency: 2.0,
            displacement_speed: 0.45,
            displacement_amplitude: 0.018,
            dissolve_fragmentation: 0.55,
            echo_displacement_floor: 0.45,
            // Meia-vida ~1,7s (era 1,5/s, meia-vida ~0,46s) — rastro
            // visível por mais tempo depois que o movimento para.
            trail_decay_per_second: 0.4,
            trail_capture_opacity: 0.4,

            // Meia-vida ≈ 115s (ln(2)/0.006) — longa o suficiente para
            // um visitante de alguns minutos ainda reconhecer posições
            // antigas, sem saturar a tela num dia inteiro de uso.
            trail_deep_decay_per_second: 0.006,
            trail_deep_capture_opacity: 0.18,
            trail_deep_floor_ratio: 0.35,
            trail_oscillation_period_seconds: 30.0,

            trail_displacement_frequency: 0.7,
            trail_displacement_speed: 0.12,
            trail_displacement_amplitude: 0.045,
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
