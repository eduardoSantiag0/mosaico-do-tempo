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

// --- "Mar de Solaris": distorção dedicada ao RASTRO (modo de desenho 3) ---
//
// O reflexo vivo e os ecos usam `organic_field`/`apply_organic_displacement`
// acima — um campo sutil, pensado para não comprometer a legibilidade de
// uma pessoa. O rastro não precisa dessa restrição: ele é a camada mais
// "de fundo" de todas, então pode ser pesado, lento e um pouco
// não-euclidiano, como o mar do planeta em Solaris (Tarkovsky) — memórias
// ganhando peso e forma física antes de se dissolverem de novo.

// Igual ao `organic_field`, mas com um quinto termo DOMINANTE: um produto
// (não uma soma) de seno por cosseno, de frequência bem mais baixa. Um
// produto de ondas não se comporta como a soma de ondas de água real — é
// isso que dá a leitura "não segue a física comum", em vez de só "água
// lenta". Os quatro termos finos (iguais aos do `organic_field`, com peso
// bem menor) cavalgam por cima dessa onda grande.
fn solaris_field(p: vec2<f32>, t: f32) -> vec2<f32> {
    let a = sin(p.x * 3.1 + p.y * 1.7 + t * 0.9);
    let b = cos(p.x * 1.3 - p.y * 2.9 + t * 0.6 + 1.7);
    let c = sin((p.x + p.y) * 2.3 - t * 1.1 + 4.2);
    let d = cos((p.x - p.y) * 1.9 + t * 0.4 + 0.3);
    let fine = vec2<f32>(a + c, b + d) * 0.15;

    let heavy_x = sin(p.x * 0.35 + p.y * 0.22 + t * 0.07) * cos(p.x * 0.28 - p.y * 0.4 + t * 0.05);
    let heavy_y = cos(p.x * 0.31 - p.y * 0.26 + t * 0.06) * sin(p.x * 0.24 + p.y * 0.33 + t * 0.045);
    let heavy = vec2<f32>(heavy_x, heavy_y) * 0.55;

    return fine + heavy;
}

// Uma "bolha" que deriva muito lentamente pela tela (uma volta completa a
// cada `ORBIT_PERIOD_SECONDS`) e, de vez em quando, empurra os pixels
// próximos para fora dela — como se uma memória estivesse ganhando forma
// física por um instante antes de se desfazer de novo. `orbit_phase` e
// `pulse_phase` existem só para que duas bolhas (ver `solaris_bubbles`)
// nunca orbitem ou pulsem exatamente juntas.
const ORBIT_PERIOD_SECONDS: f32 = 180.0;
const ORBIT_RADIUS: f32 = 0.3;
const PULSE_PERIOD_SECONDS: f32 = 50.0;
// Fração de cada ciclo em que a bolha fica "ativa" (empurrando). O resto
// do tempo ela fica parada/invisível — não é um pulso constante.
const PULSE_ACTIVE_FRACTION: f32 = 0.18;
const BUBBLE_INFLUENCE_RADIUS: f32 = 0.35;
const BUBBLE_PUSH_AMOUNT: f32 = 0.07;
const TAU: f32 = 6.28318530718;

fn solaris_bubble(uv: vec2<f32>, t: f32, orbit_phase: f32, pulse_phase: f32) -> vec2<f32> {
    let orbit_angle = (t / ORBIT_PERIOD_SECONDS) * TAU + orbit_phase;
    let center = vec2<f32>(0.5, 0.5) + vec2<f32>(cos(orbit_angle), sin(orbit_angle)) * ORBIT_RADIUS;

    // Dentro de cada ciclo de `PULSE_PERIOD_SECONDS`, só a primeira
    // fração (`PULSE_ACTIVE_FRACTION`) tem empurrão — e mesmo essa fração
    // sobe e desce suavemente (não é um degrau ligado/desligado).
    let cycle_position = fract(t / PULSE_PERIOD_SECONDS + pulse_phase);
    var pulse = 0.0;
    if (cycle_position < PULSE_ACTIVE_FRACTION) {
        pulse = sin((cycle_position / PULSE_ACTIVE_FRACTION) * 3.14159265);
    }

    let to_pixel = uv - center;
    let distance_to_center = length(to_pixel);
    let influence = clamp(1.0 - distance_to_center / BUBBLE_INFLUENCE_RADIUS, 0.0, 1.0);
    let direction = to_pixel / max(distance_to_center, 0.0001);

    return direction * influence * pulse * BUBBLE_PUSH_AMOUNT;
}

// Duas bolhas, com órbitas e ritmos de pulso desencontrados de propósito
// (ver os comentários de `orbit_phase`/`pulse_phase` acima) — assim elas
// nunca "respiram" ao mesmo tempo.
fn solaris_bubbles(uv: vec2<f32>, t: f32) -> vec2<f32> {
    let bubble_a = solaris_bubble(uv, t, 0.0, 0.0);
    let bubble_b = solaris_bubble(uv, t, 3.14159265, 0.37);
    return bubble_a + bubble_b;
}

fn apply_solaris_displacement(
    uv: vec2<f32>,
    time_seconds: f32,
    frequency: f32,
    speed: f32,
    amplitude: f32,
    intensity: f32,
) -> vec2<f32> {
    let field = solaris_field(uv * frequency, time_seconds * speed);
    let bubbles = solaris_bubbles(uv, time_seconds);
    return uv + (field * amplitude + bubbles) * intensity;
}

// Faz a camada PROFUNDA do rastro oscilar entre quase apagada e bem
// visível, lentamente — mas com uma fase que varia de lugar para lugar na
// tela (um "hash" simples da posição), para que regiões diferentes não
// pulsem juntas. Um "respirar" sincronizado em toda a tela pareceria um
// flash de câmera, não um mar.
fn solaris_swell(uv: vec2<f32>, t: f32, period_seconds: f32) -> f32 {
    let spatial_hash = fract(sin(dot(uv, vec2<f32>(12.9898, 78.233))) * 43758.5453);
    let phase = spatial_hash * TAU;
    return 0.5 + 0.5 * sin((t / period_seconds) * TAU + phase);
}
