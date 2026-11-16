// Efeito "Underwater Distortion" (RF06): faz a imagem ondular, como se
// estivéssemos vendo um reflexo através da água em movimento.
//
// A ideia é simples: em vez de pegar a cor do pixel exatamente na posição
// `uv`, pegamos a cor de uma posição um pouco deslocada, e esse
// deslocamento varia com ondas de seno/cosseno ao longo do tempo. Isso dá
// a sensação de ondulação, sem precisar mover os pixels "de verdade".
fn apply_underwater_distortion(
    uv: vec2<f32>,
    time_seconds: f32,
    intensity: f32,
    frequency: f32,
    speed: f32,
    amplitude: f32,
    age_ratio: f32,
) -> vec2<f32> {
    // Uma onda na direção X, que depende da posição Y e do tempo.
    let wave_x = sin(uv.y * frequency + time_seconds * speed) * amplitude * intensity;

    // Uma onda na direção Y, um pouco diferente da primeira, pra não
    // parecer repetitiva.
    let wave_y = cos(uv.x * frequency * 1.3 + time_seconds * speed * 0.8) * amplitude * intensity * 0.6;

    // Memórias mais antigas (age_ratio mais perto de 1.0) ondulam mais.
    let age_boost = 1.0 + age_ratio;

    return uv + vec2<f32>(wave_x, wave_y) * age_boost;
}
