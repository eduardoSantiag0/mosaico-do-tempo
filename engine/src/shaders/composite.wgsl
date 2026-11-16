// Este é o shader "principal": ele desenha um retângulo (um "quad") que
// cobre a tela inteira, com uma imagem (textura) dentro, e usa as funções
// de echo.wgsl, underwater.wgsl e dissolve.wgsl para dar o efeito certo.
//
// Importante: o WGSL não tem um jeito de "importar" outro arquivo .wgsl.
// Por isso, o código Rust (veja renderer.rs) junta os quatro arquivos
// .wgsl em um texto só antes de mandar para a GPU. Então, quando você lê
// este arquivo, pode assumir que as funções `apply_echo_offset`,
// `apply_underwater_distortion` e `dissolve_mask` já existem (elas vêm
// dos outros três arquivos, coladas antes deste texto).

// Estes são os valores que o Rust manda pra GPU antes de cada desenho.
// Precisam estar na mesma ordem e com os mesmos tipos que a struct
// `DrawUniforms` em renderer.rs.
struct DrawUniforms {
    offset_x: f32,
    offset_y: f32,
    opacity: f32,
    age_ratio: f32,
    time_seconds: f32,
    is_live: f32,
    underwater_intensity: f32,
    underwater_frequency: f32,
    underwater_speed: f32,
    underwater_amplitude: f32,
    dissolve_fragmentation: f32,
    padding: f32,
};

@group(0) @binding(0) var<uniform> draw: DrawUniforms;
@group(0) @binding(1) var quad_texture: texture_2d<f32>;
@group(0) @binding(2) var quad_sampler: sampler;

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

    // O reflexo atual (is_live) nunca se move; só os ecos do passado
    // recebem o pequeno deslocamento (RF05).
    if (draw.is_live < 0.5) {
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

    // Só os ecos (memórias do passado) recebem distorção e dissolução.
    // O reflexo atual fica sempre nítido, para manter a baixa latência e
    // a clareza do "espelho".
    var alpha = draw.opacity;
    if (draw.is_live < 0.5) {
        uv = apply_underwater_distortion(
            uv,
            draw.time_seconds,
            draw.underwater_intensity,
            draw.underwater_frequency,
            draw.underwater_speed,
            draw.underwater_amplitude,
            draw.age_ratio,
        );
        alpha = alpha * dissolve_mask(in.uv, draw.age_ratio, draw.dissolve_fragmentation);
    }

    let color = textureSample(quad_texture, quad_sampler, uv);

    // Os ecos vão perdendo a cor conforme envelhecem, até ficarem em
    // tons de cinza — um jeito simples de dar um ar mais
    // "fantasmagórico" aos vestígios, em vez de parecerem só uma cópia
    // atrasada e colorida do reflexo atual.
    //
    // Importante: usamos `age_ratio * 2.0` (e não `age_ratio` puro) para
    // que o eco já fique bem cinza na METADE da sua vida, enquanto ainda
    // está bem visível. Se usássemos `age_ratio` direto, ele só ficaria
    // visivelmente cinza perto do fim da vida — exatamente quando a
    // opacidade (que também depende de `age_ratio`) já caiu perto de
    // zero, e o efeito nunca chegaria a ser notado.
    var rgb = color.rgb;
    if (draw.is_live < 0.5) {
        let gray_mix = clamp(draw.age_ratio * 2.0, 0.0, 1.0);
        let luminance = dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
        let gray = vec3<f32>(luminance, luminance, luminance);
        rgb = mix(rgb, gray, gray_mix);
    }

    return vec4<f32>(rgb, color.a * alpha);
}
