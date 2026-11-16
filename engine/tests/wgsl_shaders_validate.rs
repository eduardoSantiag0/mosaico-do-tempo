// Este teste não roda no navegador: ele usa a biblioteca `naga` (que é a
// mesma biblioteca que o `wgpu` usa por baixo dos panos para entender
// WGSL) para checar, direto no computador, se o texto dos nossos quatro
// arquivos .wgsl formam um shader válido — sem precisar abrir um
// navegador de verdade.
//
// Isso é importante porque o Rust só compila o TEXTO do shader (veja
// `build_shader_source` em `src/renderer.rs`); ele não entende WGSL. Um
// erro de digitação no shader só apareceria em tempo de execução, dentro
// do navegador. Este teste serve para pegar esse tipo de erro mais cedo.

#[test]
fn composite_shader_is_valid_wgsl() {
    let echo = include_str!("../src/shaders/echo.wgsl");
    let displacement = include_str!("../src/shaders/displacement.wgsl");
    let dissolve = include_str!("../src/shaders/dissolve.wgsl");
    let composite = include_str!("../src/shaders/composite.wgsl");

    // Precisa ser exatamente a mesma ordem usada em `build_shader_source`
    // dentro de `src/renderer.rs`.
    let source = format!("{echo}\n{displacement}\n{dissolve}\n{composite}");

    let module = naga::front::wgsl::parse_str(&source).expect("o shader deveria ter um WGSL válido (sem erros de sintaxe)");

    let mut validator = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty());

    validator
        .validate(&module)
        .expect("o shader deveria passar a validação do naga (tipos e regras do WGSL)");
}
