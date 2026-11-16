// "Campo de deslocamento temporal": em vez de deixar a tela inteira
// ondulando de um jeito uniforme (o que lembraria um filtro de água
// genérico), essa função empurra os pixels um pouquinho, de um jeito
// irregular/orgânico, com uma força (`strength`) que varia de lugar
// para lugar — em geral, mais forte onde a memória temporal esteve
// presente recentemente, e mais fraca (ou zero) em outros lugares.
//
// Quem chama essa função decide o que é `strength`: para um "eco"
// (memória intermediária/prolongada), é a idade do próprio registro.
// Para o reflexo atual, é o quanto de "presença recente" existe naquele
// ponto da tela (lido do acumulador de rastro — veja renderer.rs).

// Gera um campo de deslocamento 2D a partir da posição `p` e do tempo
// `t`. Somamos quatro ondas com frequências e direções desencontradas
// de propósito (3.1/1.7, 1.3/2.9, etc. — números "quebrados", não
// múltiplos um do outro), para que o resultado pareça orgânico e
// irregular, em vez de um padrão repetitivo e óbvio.
fn organic_field(p: vec2<f32>, t: f32) -> vec2<f32> {
    let a = sin(p.x * 3.1 + p.y * 1.7 + t * 0.9);
    let b = cos(p.x * 1.3 - p.y * 2.9 + t * 0.6 + 1.7);
    let c = sin((p.x + p.y) * 2.3 - t * 1.1 + 4.2);
    let d = cos((p.x - p.y) * 1.9 + t * 0.4 + 0.3);
    return vec2<f32>(a + c, b + d) * 0.25;
}

fn apply_organic_displacement(
    uv: vec2<f32>,
    time_seconds: f32,
    intensity: f32,
    frequency: f32,
    speed: f32,
    amplitude: f32,
    strength: f32,
) -> vec2<f32> {
    let field = organic_field(uv * frequency, time_seconds * speed);
    return uv + field * amplitude * intensity * strength;
}
