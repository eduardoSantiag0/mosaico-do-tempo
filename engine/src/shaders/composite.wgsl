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
//     uma distorção orgânica suave, mas sem dissolução por máscara nem
//     conversão para cinza — ele é a presença mais "viva" e recente.
// 4 = modo de diagnóstico ("eco forçado"): ignora a cor da textura e
//     desenha magenta sólido, só para provar visualmente que o eco/
//     rastro chegou até aqui. Nunca usado na experiência final.
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
    // Modo de diagnóstico ("distorção forçada"): só tem efeito no modo 1
    // (reflexo atual). Quando > 0.5, força uma distorção forte e
    // constante, em vez da distorção sutil ligada à presença real no
    // acumulador de rastro — prova que o mecanismo funciona, por si só.
    debug_force_distortion: f32,
};

@group(0) @binding(0) var<uniform> draw: DrawUniforms;
@group(0) @binding(1) var quad_texture: texture_2d<f32>;
@group(0) @binding(2) var quad_sampler: sampler;
// Textura usada só pelo modo 1 (reflexo atual): o acumulador de rastro,
// para sabermos onde houve presença recente. Nos outros modos, este
// binding precisa existir (a GPU exige um recurso válido para cada
// binding declarado), mas seu conteúdo não é lido.
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

        return vec4<f32>(rgb, color.a * alpha);
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

    // Modo 3 — o próprio rastro, desenhado na tela: uma distorção
    // orgânica suave e constante (não ligada a "idade", já que o
    // rastro não é um registro discreto), mas sem dissolução por
    // máscara nem conversão para cinza — ele é a camada mais "viva".
    if (draw.draw_mode == 3.0) {
        uv = apply_organic_displacement(
            uv, draw.time_seconds, draw.displacement_intensity * 0.5,
            draw.displacement_frequency, draw.displacement_speed, draw.displacement_amplitude,
            1.0,
        );
        let color = textureSample(quad_texture, quad_sampler, uv);
        return vec4<f32>(color.rgb, color.a * alpha);
    }

    // Modo 4 — diagnóstico ("eco forçado"): ignora a cor de verdade e
    // desenha magenta sólido onde a textura tiver alfa > 0 (ou seja,
    // onde a pessoa foi segmentada). Serve só para provar que o
    // registro chegou até o renderizador.
    if (draw.draw_mode == 4.0) {
        let source_alpha = textureSample(quad_texture, quad_sampler, uv).a;
        return vec4<f32>(1.0, 0.0, 1.0, source_alpha * alpha);
    }

    // Modo 2 — "liso" (atualização interna do acumulador de rastro):
    // só repassa a cor, sem nenhuma transformação.
    let color = textureSample(quad_texture, quad_sampler, uv);
    return vec4<f32>(color.rgb, color.a * alpha);
}
