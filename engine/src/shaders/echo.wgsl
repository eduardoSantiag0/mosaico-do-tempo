// Parte do efeito "Temporal Echo" (RF05): deslocar a posição de um eco na
// tela, conforme ele envelhece. O resto do efeito (a opacidade do eco) já
// é calculado do lado do Rust, em memory.rs, então aqui só cuidamos da
// posição.

// `position` são as coordenadas do vértice (de -1.0 a 1.0, cobrindo a
// tela toda). `offset` é o deslocamento (bem pequeno) calculado para este
// registro específico.
fn apply_echo_offset(position: vec2<f32>, offset: vec2<f32>) -> vec2<f32> {
    return position + offset;
}
