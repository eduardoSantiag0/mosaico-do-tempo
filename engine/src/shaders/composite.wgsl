// Este é o shader "principal": ele desenha um retângulo (um "quad") que
// cobre a tela inteira, com uma imagem (textura) dentro. O que exatamente
// ele faz com essa imagem depende de `draw.draw_mode` — veja a lista
// abaixo. É assim que um shader só consegue desenhar coisas tão
// diferentes quanto o reflexo atual, um eco do passado, ou o acumulador
// de rastro: cada "modo" liga/desliga pedaços da conta.
//
// Importante: o WGSL não tem um jeito de "importar" outro arquivo .wgsl.
// Por isso, o código Rust (veja renderer.rs) junta os arquivos .wgsl em
// um texto só antes de mandar para a GPU. Então, quando você lê este
// arquivo, pode assumir que as funções `apply_echo_offset`,
// `apply_organic_displacement` e `dissolve_mask` já existem (elas vêm
// dos outros arquivos, colados antes deste texto).

// Os modos de desenho (`draw.draw_mode`):
// 0 = eco (memória intermediária ou prolongada): distorção orgânica
//     ligada à idade do registro, dissolução fragmentada, e vai ficando
//     em tons de cinza conforme envelhece.
// 1 = reflexo atual: sem dissolução nem cinza, mas sofre um pequeno
//     deslocamento local onde o acumulador de rastro (memória curta)
//     indica presença recente — isso é o "campo de deslocamento
//     temporal" (o passado deformando sutilmente o presente).
// 2 = "liso": usado só internamente, para atualizar o acumulador de
//     rastro (copiar o conteúdo antigo já desbotado, e depois somar a
//     captura nova por cima). Não tem distorção, dissolução nem cinza.
// 3 = rastro (o acumulador em si, desenhado na tela por cima de tudo):
//     sem dissolução por máscara nem conversão para cinza. Tem DUAS
//     camadas: a recente (textura principal, binding 1), que é a
//     presença mais "viva", e a profunda (binding 3, reaproveitando o
//     binding da textura de deslocamento — só o modo 1 usa esse
//     binding com esse propósito), que nunca desaparece de verdade —
//     só oscila entre um piso mínimo e totalmente visível ("mar de
//     Solaris"). A distorção aqui é dedicada (`apply_solaris_displacement`,
//     `displacement.wgsl`), bem mais pesada e lenta que a do reflexo/ecos.
// 4 = modo de diagnóstico ("eco forçado"): ignora a cor da textura e
//     desenha magenta sólido, só para provar visualmente que o eco/
//     rastro chegou até aqui. Nunca usado na experiência final.
// 5 = decaimento da camada PROFUNDA do rastro: igual ao modo 2 ("liso"),
//     mas com um piso — a opacidade de um ponto que já recebeu alguma
//     presença nunca cai abaixo de `trail_deep_floor_absolute`. É isso
//     que faz essa camada nunca desaparecer de verdade (um decaimento
//     puramente exponencial, por mais lento que seja, sempre tende a
//     zero). Usado só no passo de decaimento da camada profunda.
struct DrawUniforms {
    offset_x: f32,
    offset_y: f32,
    opacity: f32,
    age_ratio: f32,
    time_seconds: f32,
    draw_mode: f32,
    displacement_intensity: f32,
    displacement_frequency: f32,
    displacement_speed: f32,
    displacement_amplitude: f32,
    dissolve_fragmentation: f32,
    // Só usado no modo 0 (eco): a força mínima do campo de
    // deslocamento, mesmo para um eco recém-nascido (idade 0). Sem
    // isso, um eco nasce sem nenhuma distorção (força = idade) e só
    // ganha essa "textura líquida" conforme envelhece.
    echo_displacement_floor: f32,
    // Só usadas no modo 3 (rastro) — ver `apply_solaris_displacement` em
    // `displacement.wgsl`.
    trail_displacement_frequency: f32,
    trail_displacement_speed: f32,
    trail_displacement_amplitude: f32,
    // Período (segundos) da oscilação "aparece e desaparece" da camada
    // profunda do rastro, e a fração mínima dela que nunca é cruzada.
    // Ver `solaris_swell` em `displacement.wgsl`.
    trail_oscillation_period_seconds: f32,
    trail_deep_floor_ratio: f32,
    // Só usado no modo 5 — ver comentário do modo 5 acima.
    trail_deep_floor_absolute: f32,
    // Modo de diagnóstico ("distorção forçada"): só tem efeito no modo 1
    // (reflexo atual). Quando > 0.5, força uma distorção forte e
    // constante, em vez da distorção sutil ligada à presença real no
    // acumulador de rastro — prova que o mecanismo funciona, por si só.
    debug_force_distortion: f32,
};

@group(0) @binding(0) var<uniform> draw: DrawUniforms;
@group(0) @binding(1) var quad_texture: texture_2d<f32>;
@group(0) @binding(2) var quad_sampler: sampler;
// Binding de uso duplo, dependendo do modo: no modo 1 (reflexo atual) é
// o acumulador de rastro recente, para sabermos onde houve presença
// recente; no modo 3 (rastro) é a camada PROFUNDA do rastro (ver acima).
// Nos outros modos, este binding precisa existir (a GPU exige um recurso
// válido para cada binding declarado), mas seu conteúdo não é lido.
@group(0) @binding(3) var displacement_texture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Desenha um quadrado cobrindo a tela inteira usando dois triângulos (6
// vértices), sem precisar de um buffer de vértices — as posições e as
// coordenadas de textura (uv) ficam escritas direto aqui, numa pequena
// tabela, e escolhemos qual usar pelo índice do vértice.
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0),
    );
    var uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),
    );

    var position = positions[vertex_index];

    // Só os ecos (modo 0) se deslocam lateralmente conforme envelhecem
    // (RF05 do enunciado original). O reflexo atual, o rastro e os
    // passes internos do acumulador nunca se movem assim.
    if (draw.draw_mode == 0.0) {
        position = apply_echo_offset(position, vec2<f32>(draw.offset_x, draw.offset_y) * 2.0);
    }

    var out: VertexOutput;
    out.clip_position = vec4<f32>(position, 0.0, 1.0);
    out.uv = uvs[vertex_index];
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var uv = in.uv;
    var alpha = draw.opacity;

    // Modo 0 — eco (memória intermediária/prolongada).
    if (draw.draw_mode == 0.0) {
        // A força do deslocamento nunca é menor que `echo_displacement_floor`
        // — assim, até um eco recém-nascido já tem uma leve "ondulação
        // líquida", em vez de nascer idêntico ao reflexo vivo e só
        // ganhar textura conforme envelhece.
        let liquid_strength = mix(draw.echo_displacement_floor, 1.0, draw.age_ratio);
        uv = apply_organic_displacement(
            uv, draw.time_seconds, draw.displacement_intensity,
            draw.displacement_frequency, draw.displacement_speed, draw.displacement_amplitude,
            liquid_strength,
        );
        alpha = alpha * dissolve_mask(in.uv, draw.age_ratio, draw.dissolve_fragmentation);

        let color = textureSample(quad_texture, quad_sampler, uv);

        // Vai perdendo a cor conforme envelhece, até ficar em tons de
        // cinza — um jeito simples de dar um ar mais "fantasmagórico"
        // aos vestígios, em vez de parecerem só uma cópia atrasada e
        // colorida do reflexo atual. Usamos `age_ratio * 2.0` para que
        // isso já fique bem visível na metade da vida do registro,
        // enquanto ele ainda está razoavelmente opaco.
        let gray_mix = clamp(draw.age_ratio * 2.0, 0.0, 1.0);
        let luminance = dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114));
        let gray = vec3<f32>(luminance, luminance, luminance);
        let rgb = mix(color.rgb, gray, gray_mix);

        return vec4<f32>(0.0, 1.0, 1.0, color.a * alpha);
    }

    // Modo 1 — reflexo atual: o campo de deslocamento temporal. Onde o
    // acumulador de rastro guarda presença recente (seu canal alfa),
    // deformamos sutilmente a amostragem do reflexo. É assim que "o
    // passado deforma o presente" sem precisar desenhar nada visível
    // por cima do reflexo nesse ponto.
    if (draw.draw_mode == 1.0) {
        var presence = textureSample(displacement_texture, quad_sampler, uv).a;
        var amplitude = draw.displacement_amplitude;

        if (draw.debug_force_distortion > 0.5) {
            // Diagnóstico: ignora a presença real do acumulador e força
            // uma distorção sempre ligada e bem mais forte, só para
            // comprovar que o mecanismo de distorção funciona.
            presence = 1.0;
            amplitude = amplitude * 6.0;
        }

        uv = apply_organic_displacement(
            uv, draw.time_seconds, draw.displacement_intensity,
            draw.displacement_frequency, draw.displacement_speed, amplitude,
            presence,
        );
        let color = textureSample(quad_texture, quad_sampler, uv);
        return vec4<f32>(color.rgb, color.a * alpha);
    }

    // Modo 3 — o rastro, desenhado na tela por cima de tudo. Combina
    // duas camadas: a recente (reage a movimento novo, desbota rápido)
    // e a profunda ("mar de Solaris" — nunca desaparece de verdade, só
    // oscila). As duas passam pela mesma distorção pesada e lenta,
    // dedicada ao rastro (não a sutil do reflexo/ecos).
    if (draw.draw_mode == 3.0) {
        uv = apply_solaris_displacement(
            uv, draw.time_seconds,
            draw.trail_displacement_frequency, draw.trail_displacement_speed, draw.trail_displacement_amplitude,
            draw.displacement_intensity,
        );

        let fast_color = textureSample(quad_texture, quad_sampler, uv);

        // A camada profunda oscila entre `trail_deep_floor_ratio` (nunca
        // menos que isso) e totalmente visível — com fase que varia por
        // posição na tela (`solaris_swell`), para não parecer um flash
        // sincronizado.
        let deep_sample = textureSample(displacement_texture, quad_sampler, uv);
        let swell = solaris_swell(in.uv, draw.time_seconds, draw.trail_oscillation_period_seconds);
        let deep_strength = draw.trail_deep_floor_ratio + (1.0 - draw.trail_deep_floor_ratio) * swell;
        let deep_alpha = deep_sample.a * deep_strength;

        // Onde o rastro recente tem conteúdo, ele domina a cor (é a
        // presença mais "viva"); fora dali, só a cor da camada profunda
        // aparece. Os alfas se somam (limitados a 1.0) — são duas
        // presenças parcialmente translúcidas, não uma substituindo a
        // outra.
        let combined_rgb = mix(deep_sample.rgb, fast_color.rgb, fast_color.a);
        let combined_alpha = clamp(fast_color.a + deep_alpha, 0.0, 1.0);

        return vec4<f32>(combined_rgb, combined_alpha * alpha);
    }

    // Modo 4 — diagnóstico ("eco forçado"): ignora a cor de verdade e
    // desenha magenta sólido onde a textura tiver alfa > 0 (ou seja,
    // onde a pessoa foi segmentada). Serve só para provar que o
    // registro chegou até o renderizador.
    if (draw.draw_mode == 4.0) {
        let source_alpha = textureSample(quad_texture, quad_sampler, uv).a;
        return vec4<f32>(1.0, 0.0, 1.0, source_alpha * alpha);
    }

    // Modo 5 — decaimento da camada profunda do rastro, com piso. `alpha`
    // aqui é o fator de decaimento (ver `draw.opacity` no topo da função),
    // já aplicado pela GPU através do blend normal (ALPHA_BLENDING) —
    // então `color.a * alpha` já É o valor decaído deste quadro. Um
    // ponto que nunca recebeu presença tem `color.a` exatamente 0.0 (a
    // textura começa limpa e transparente, e só muda onde algo foi
    // desenhado) — por isso o piso só "pega" em quem já foi tocado.
    if (draw.draw_mode == 5.0) {
        let color = textureSample(quad_texture, quad_sampler, uv);
        var decayed_alpha = color.a * alpha;
        if (color.a > 0.0) {
            decayed_alpha = max(decayed_alpha, draw.trail_deep_floor_absolute);
        }
        return vec4<f32>(color.rgb, decayed_alpha);
    }

    // Modo 2 — "liso" (atualização interna do acumulador de rastro):
    // só repassa a cor, sem nenhuma transformação.
    let color = textureSample(quad_texture, quad_sampler, uv);
    return vec4<f32>(color.rgb, color.a * alpha);
}
