// Efeito de "Dissolução temporal" (RF07): em vez dos vestígios antigos
// desaparecerem de um jeito liso e uniforme, queremos que pareçam se
// "fragmentar" — como se partes da imagem fossem desaparecendo aos
// poucos, em pedacinhos, até sobrar nada.

// Gera um valor "pseudo-aleatório" (sempre o mesmo para a mesma posição
// `uv`, mas parecendo bagunçado) entre 0.0 e 1.0. Isso é uma técnica bem
// comum em shaders: não existe uma função de aleatoriedade de verdade,
// então usamos contas com seno pra fingir uma.
fn pseudo_random(uv: vec2<f32>) -> f32 {
    return fract(sin(dot(uv * 437.585, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// Decide se um pixel deve estar visível (1.0) ou ter desaparecido (0.0),
// dependendo da idade do registro (`age_ratio`, de 0.0 a 1.0) e de quão
// "fragmentado" queremos o efeito (`fragmentation`).
fn dissolve_mask(uv: vec2<f32>, age_ratio: f32, fragmentation: f32) -> f32 {
    let noise = pseudo_random(uv);

    // Conforme a idade aumenta, o "limite" (threshold) sobe, e mais
    // pixels passam a ficar abaixo dele e desaparecer.
    let threshold = age_ratio * fragmentation;

    if (noise < threshold) {
        return 0.0;
    }
    return 1.0;
}
