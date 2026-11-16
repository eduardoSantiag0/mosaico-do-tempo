// Este arquivo é o "Renderer": a parte que sabe desenhar coisas na tela
// usando a GPU, através da biblioteca `wgpu` (que fala WebGPU, e também
// sabe usar WebGL2 como alternativa em navegadores mais antigos).
//
// Ele também faz o papel do "Compositor" descrito no enunciado original:
// decide a ordem de desenho e junta isso com os parâmetros dos efeitos
// visuais (`effects.rs`).
//
// A peça central deste arquivo é o "acumulador de rastro": em vez de
// guardar dezenas de fotos separadas do movimento recente e desenhar
// cada uma por cima da outra (o que fica parecendo uma pilha de fotos
// semitransparentes, e não um rastro orgânico), mantemos UMA textura na
// GPU que vai sendo atualizada a cada quadro:
//
//   1. O conteúdo antigo dessa textura é "desbotado" (multiplicado por
//      um fator de decaimento, calculado a partir do tempo real entre
//      quadros — não depende do FPS).
//   2. A silhueta da pessoa capturada agora é somada por cima.
//
// O resultado se parece com um rastro que persiste e desbota
// continuamente, em vez de fotografias empilhadas. Como só existe UMA
// textura (não uma por registro), isso também é bem mais barato para a
// GPU do que desenhar dezenas de quads.
//
// Essa mesma textura é reaproveitada para o "campo de deslocamento
// temporal" (a ideia de que o passado deforma sutilmente o presente):
// o canal alfa dela diz "o quanto de presença recente existiu aqui", e
// usamos esse valor para deformar levemente a amostragem do reflexo
// atual nesses pontos.
//
// Um aviso sobre o estilo deste código: trabalhar com GPU em qualquer
// linguagem é naturalmente um pouco verboso — é preciso descrever cada
// detalhe (formato da textura, como misturar as cores, etc.) porque a
// GPU não adivinha nada. Tentamos comentar o "porquê" de cada parte para
// compensar isso.

use crate::effects::{trail_decay_factor, EffectConfig};
use crate::Engine;
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

// Tamanho (em bytes) de um pixel RGBA (4 canais de 1 byte cada).
const BYTES_PER_PIXEL: u32 = 4;

// Cor de fundo usada para limpar a tela antes de desenhar qualquer
// coisa. Um tom escuro, parecido com o fundo do restante da interface.
const CLEAR_COLOR: wgpu::Color = wgpu::Color {
    r: 0.02,
    g: 0.02,
    b: 0.04,
    a: 1.0,
};

/// Os "modos de desenho" que o shader entende — precisa corresponder
/// exatamente aos números comentados no topo de `shaders/composite.wgsl`.
const DRAW_MODE_ECHO: f32 = 0.0;
const DRAW_MODE_LIVE: f32 = 1.0;
const DRAW_MODE_PLAIN: f32 = 2.0;
const DRAW_MODE_TRAIL: f32 = 3.0;
/// Modo de diagnóstico: ignora a textura e desenha magenta sólido. Serve
/// só para provar, visualmente, que um eco/rastro chegou até o
/// renderizador — nunca é usado na experiência "de verdade".
const DRAW_MODE_DEBUG_MAGENTA: f32 = 4.0;

/// Os valores que mandamos para a GPU antes de cada "quad" (retângulo)
/// ser desenhado. Isso precisa corresponder EXATAMENTE à struct
/// `DrawUniforms` definida em `shaders/composite.wgsl` — mesma ordem de
/// campos, mesmo tipo (`f32` em ambos os lados).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
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
    /// Modo de diagnóstico (ver seção "modo debug" no topo do arquivo):
    /// quando > 0.5, o reflexo atual (draw_mode == LIVE) usa uma
    /// distorção bem mais forte e sempre ligada, em vez da distorção
    /// sutil e ligada à presença real no acumulador de rastro. Serve
    /// para provar que o mecanismo de distorção funciona, independente
    /// de qualquer movimento real ter sido capturado.
    debug_force_distortion: f32,
}

/// Monta os valores comuns a quase todo desenho, puxando os parâmetros
/// de distorção/dissolução direto da configuração atual dos efeitos.
/// Só o que muda de um desenho para o outro (modo, opacidade, idade,
/// deslocamento) precisa ser passado explicitamente.
fn make_uniforms(effects: &EffectConfig, draw_mode: f32, opacity: f32, age_ratio: f32, offset_x: f32, offset_y: f32, time_seconds: f32) -> DrawUniforms {
    DrawUniforms {
        offset_x,
        offset_y,
        opacity,
        age_ratio,
        time_seconds,
        draw_mode,
        displacement_intensity: effects.displacement_intensity,
        displacement_frequency: effects.displacement_frequency,
        displacement_speed: effects.displacement_speed,
        displacement_amplitude: effects.displacement_amplitude,
        dissolve_fragmentation: effects.dissolve_fragmentation,
        debug_force_distortion: 0.0,
    }
}

/// Uma textura simples (imagem na memória da GPU) que reutilizamos quadro
/// a quadro, só trocando o conteúdo (em vez de criar uma textura nova
/// toda hora, o que seria mais lento).
struct ReusableTexture {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    /// Guardamos quais usos extras (alem dos básicos) essa textura
    /// precisa, para recriá-la do jeito certo quando o tamanho mudar
    /// (veja `ensure_size`). O acumulador de rastro, por exemplo,
    /// precisa de `RENDER_ATTACHMENT` porque desenhamos NELE, não só
    /// a partir dele.
    extra_usage: wgpu::TextureUsages,
}

impl ReusableTexture {
    fn new(device: &wgpu::Device, width: u32, height: u32, label: &str, extra_usage: wgpu::TextureUsages) -> Self {
        let width = width.max(1);
        let height = height.max(1);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | extra_usage,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        ReusableTexture {
            texture,
            view,
            width,
            height,
            extra_usage,
        }
    }

    /// Se o tamanho pedido for diferente do atual, recria a textura.
    /// Chamado, por exemplo, quando o visitante gira o celular e a
    /// proporção da imagem capturada muda.
    fn ensure_size(&mut self, device: &wgpu::Device, width: u32, height: u32, label: &str) {
        if width != self.width || height != self.height {
            *self = ReusableTexture::new(device, width, height, label, self.extra_usage);
        }
    }

    fn write_pixels(&self, queue: &wgpu::Queue, pixels: &[u8]) {
        queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            pixels,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(self.width * BYTES_PER_PIXEL),
                rows_per_image: Some(self.height),
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
    }
}

/// A classe principal que o JavaScript usa para desenhar cada quadro.
#[wasm_bindgen]
pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface_format: wgpu::TextureFormat,
    surface_alpha_mode: wgpu::CompositeAlphaMode,
    surface_width: u32,
    surface_height: u32,

    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    /// Pipeline "normal": mistura por transparência (alpha blending).
    /// É o modo padrão, usado pelo reflexo atual e, geralmente, pelos ecos.
    pipeline_alpha: wgpu::RenderPipeline,
    /// Pipeline alternativa: mistura aditiva (as cores se somam, ficando
    /// mais claras). Fica disponível para os ecos, caso configurado.
    pipeline_additive: wgpu::RenderPipeline,

    live_texture: ReusableTexture,
    echo_texture: ReusableTexture,
    /// A captura mais recente (já com a máscara de segmentação aplicada)
    /// a ser somada ao acumulador de rastro neste quadro.
    trail_capture_texture: ReusableTexture,
    /// O acumulador de rastro em si. Como não é possível ler e escrever
    /// na mesma textura ao mesmo tempo, usamos duas ("ping-pong"):
    /// `trail_front` é a versão já pronta deste quadro (lida pelo
    /// reflexo atual e desenhada na tela); `trail_back` é onde
    /// construímos a próxima versão. A cada quadro, elas trocam de
    /// papel (veja `std::mem::swap` em `render`).
    trail_front: ReusableTexture,
    trail_back: ReusableTexture,
    /// Quando este Renderer desenhou o último quadro. Usado para medir
    /// quanto tempo realmente passou (em segundos) desde então, para
    /// que o desbotamento do rastro dependa do tempo, não do FPS.
    last_render_ms: Option<f64>,

    effects: EffectConfig,
    /// Se verdadeiro, os ecos usam a mistura aditiva em vez da normal.
    additive_echoes: bool,

    /// Nome do backend gráfico realmente em uso ("webgpu", "gl", etc.),
    /// lido do adaptador no momento em que ele foi obtido com sucesso —
    /// nunca "anunciado" sem ter sido de fato inicializado.
    backend_name: String,
    /// Flags do modo de diagnóstico (ver `?debug=true` no app web).
    debug_force_magenta: bool,
    debug_force_distortion: bool,
}

#[wasm_bindgen]
impl Renderer {
    /// Cria o Renderer. É uma função assíncrona porque pedir acesso à
    /// GPU (adaptador e dispositivo) é uma operação assíncrona no
    /// WebGPU/WebGL. Do lado do JavaScript, isso aparece como uma
    /// Promise: `const renderer = await Renderer.create(canvas, w, h)`.
    pub async fn create(canvas: web_sys::HtmlCanvasElement, width: u32, height: u32) -> Result<Renderer, JsValue> {
        // Pedimos ao navegador tanto WebGPU quanto WebGL2: o wgpu escolhe
        // automaticamente o que estiver disponível ("WebGPU como backend
        // preferencial, WebGL2 quando compatível").
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU | wgpu::Backends::GL,
            ..Default::default()
        });

        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|err| JsValue::from_str(&format!("falha ao criar a surface: {err}")))?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .ok_or_else(|| JsValue::from_str("nenhum adaptador de GPU compatível foi encontrado"))?;

        // Só registramos o nome do backend AQUI, depois de já termos um
        // adaptador de verdade em mãos — nunca "anunciamos" um backend
        // que não foi de fato inicializado com sucesso.
        let backend_name = adapter.get_info().backend.to_str().to_string();

        // Usamos os limites "downlevel_webgl2", que é o conjunto de
        // limites mais restrito — assim, o mesmo código funciona tanto
        // em WebGPU quanto em WebGL2, sem precisar de dois caminhos
        // diferentes.
        let required_limits = wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits());

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("mosaico-device"),
                    required_features: wgpu::Features::empty(),
                    required_limits,
                },
                None,
            )
            .await
            .map_err(|err| JsValue::from_str(&format!("falha ao obter o device: {err}")))?;

        let capabilities = surface.get_capabilities(&adapter);
        // Preferimos um formato "não-sRGB" para manter as contas de cor
        // simples: os bytes que mandamos (vindos do Canvas 2D do
        // JavaScript) são usados exatamente como estão, sem nenhuma
        // conversão de gama extra escondida.
        let surface_format = capabilities
            .formats
            .iter()
            .copied()
            .find(|format| !format.is_srgb())
            .unwrap_or(capabilities.formats[0]);

        let surface_alpha_mode = capabilities.alpha_modes[0];
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: surface_alpha_mode,
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        let shader_source = build_shader_source();
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("composite_shader"),
            source: wgpu::ShaderSource::Wgsl(shader_source.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("quad_bind_group_layout"),
            entries: &[
                // binding 0: os parâmetros do desenho atual (DrawUniforms).
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // binding 1: a imagem que vamos desenhar.
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // binding 2: como "ler" a imagem (com suavização linear).
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // binding 3: o acumulador de rastro, usado pelo reflexo
                // atual para saber onde deformar a imagem (o "campo de
                // deslocamento temporal"). Nos outros modos de desenho,
                // esse binding existe mas não é lido pelo shader.
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("quad_pipeline_layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline_alpha = create_pipeline(&device, &pipeline_layout, &shader, surface_format, wgpu::BlendState::ALPHA_BLENDING);
        let pipeline_additive = create_pipeline(&device, &pipeline_layout, &shader, surface_format, ADDITIVE_BLEND);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("quad_sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let no_extra_usage = wgpu::TextureUsages::empty();
        let live_texture = ReusableTexture::new(&device, width.max(1), height.max(1), "live_texture", no_extra_usage);
        let echo_texture = ReusableTexture::new(&device, 1, 1, "echo_texture", no_extra_usage);
        let trail_capture_texture = ReusableTexture::new(&device, 1, 1, "trail_capture_texture", no_extra_usage);
        let trail_front = ReusableTexture::new(&device, 1, 1, "trail_front", wgpu::TextureUsages::RENDER_ATTACHMENT);
        let trail_back = ReusableTexture::new(&device, 1, 1, "trail_back", wgpu::TextureUsages::RENDER_ATTACHMENT);

        Ok(Renderer {
            surface,
            device,
            queue,
            surface_format,
            surface_alpha_mode,
            surface_width: width.max(1),
            surface_height: height.max(1),
            bind_group_layout,
            sampler,
            pipeline_alpha,
            pipeline_additive,
            live_texture,
            echo_texture,
            trail_capture_texture,
            trail_front,
            trail_back,
            last_render_ms: None,
            effects: EffectConfig::default_config(),
            additive_echoes: false,
            backend_name,
            debug_force_magenta: false,
            debug_force_distortion: false,
        })
    }

    /// Nome do backend gráfico realmente em uso ("webgpu", "gl", etc.).
    /// Usado pelo modo de diagnóstico para confirmar o que está de fato
    /// rodando, em vez de supor.
    #[wasm_bindgen(js_name = backendName)]
    pub fn backend_name(&self) -> String {
        self.backend_name.clone()
    }

    /// Liga/desliga os dois modos de diagnóstico forçado (ver
    /// `?debug=true` no app web): `force_magenta` faz os ecos e o
    /// rastro aparecerem em magenta sólido (prova que chegam até o
    /// renderizador); `force_distortion` faz o reflexo atual sofrer uma
    /// distorção forte e constante, independente de qualquer movimento
    /// real (prova que o mecanismo de distorção funciona).
    #[wasm_bindgen(js_name = setDebugFlags)]
    pub fn set_debug_flags(&mut self, force_magenta: bool, force_distortion: bool) {
        self.debug_force_magenta = force_magenta;
        self.debug_force_distortion = force_distortion;
    }

    /// Deve ser chamado sempre que o tamanho da tela mudar (incluindo
    /// quando o celular gira).
    pub fn resize(&mut self, width: u32, height: u32) {
        self.surface_width = width.max(1);
        self.surface_height = height.max(1);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: self.surface_format,
            width: self.surface_width,
            height: self.surface_height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: self.surface_alpha_mode,
            view_formats: vec![],
        };
        self.surface.configure(&self.device, &config);
    }

    /// Ajusta os parâmetros artísticos dos efeitos: o campo de
    /// deslocamento temporal, a dissolução dos ecos, e o ritmo com que
    /// o acumulador de rastro desbota.
    #[wasm_bindgen(js_name = configureEffects)]
    pub fn configure_effects(
        &mut self,
        displacement_intensity: f32,
        displacement_frequency: f32,
        displacement_speed: f32,
        displacement_amplitude: f32,
        dissolve_fragmentation: f32,
        trail_decay_per_second: f32,
        trail_capture_opacity: f32,
    ) {
        self.effects = EffectConfig {
            displacement_intensity,
            displacement_frequency,
            displacement_speed,
            displacement_amplitude,
            dissolve_fragmentation,
            trail_decay_per_second,
            trail_capture_opacity,
        };
    }

    /// Liga/desliga a mistura aditiva para os ecos.
    #[wasm_bindgen(js_name = setAdditiveEchoes)]
    pub fn set_additive_echoes(&mut self, enabled: bool) {
        self.additive_echoes = enabled;
    }

    /// Desenha um quadro completo. Ordem (de baixo para cima):
    ///
    /// 1. Atualiza o acumulador de rastro (desbota o antigo, soma a
    ///    captura nova).
    /// 2. Reflexo atual — a base, deformada localmente pelo campo de
    ///    deslocamento temporal onde o acumulador indica presença recente.
    /// 3. Ecos da memória prolongada, depois intermediária.
    /// 4. O próprio acumulador de rastro, por cima de tudo.
    ///
    /// Deve ser chamado uma vez por quadro, depois de o JavaScript já
    /// ter chamado `engine.update(now_ms)`.
    pub fn render(
        &mut self,
        engine: &Engine,
        now_ms: f64,
        live_width: u32,
        live_height: u32,
        live_rgba: &[u8],
        trail_capture_width: u32,
        trail_capture_height: u32,
        trail_capture_rgba: &[u8],
    ) -> Result<(), JsValue> {
        let frame = match self.surface.get_current_texture() {
            Ok(frame) => frame,
            Err(_) => {
                // A superfície pode ficar temporariamente inválida (por
                // exemplo, bem no meio de uma mudança de orientação).
                // Em vez de travar o app, só reconfiguramos e pulamos
                // este quadro — o próximo `render()` tenta de novo.
                self.resize(self.surface_width, self.surface_height);
                return Ok(());
            }
        };
        let target_view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());

        let time_seconds = (now_ms / 1000.0) as f32;

        // Quanto tempo (em segundos) passou desde o último quadro
        // desenhado. Na primeira vez, `is_first_render` fica marcado, e
        // pulamos a parte de "desbotar o acumulador antigo" (ele ainda
        // não tem conteúdo válido).
        let is_first_render = self.last_render_ms.is_none();
        let dt_seconds = match self.last_render_ms {
            Some(last) => ((now_ms - last) / 1000.0).max(0.0) as f32,
            None => 0.0,
        };
        self.last_render_ms = Some(now_ms);

        self.update_trail_accumulator(trail_capture_width, trail_capture_height, trail_capture_rgba, dt_seconds, is_first_render);

        // O reflexo atual é a BASE: desenhamos ele primeiro (limpando a
        // tela), e os ecos (vestígios do passado) são desenhados DEPOIS,
        // por cima, com transparência.
        self.live_texture.ensure_size(&self.device, live_width, live_height, "live_texture");
        self.live_texture.write_pixels(&self.queue, live_rgba);

        let mut live_uniforms = make_uniforms(&self.effects, DRAW_MODE_LIVE, 1.0, 0.0, 0.0, 0.0, time_seconds);
        live_uniforms.debug_force_distortion = if self.debug_force_distortion { 1.0 } else { 0.0 };
        self.draw_quad(&target_view, &self.live_texture.view, &self.trail_front.view, live_uniforms, false, true);

        let active_count = engine.active_count();
        for index in 0..active_count {
            let record = match engine.active_record(index) {
                Some(record) => record,
                None => continue,
            };

            self.echo_texture.ensure_size(&self.device, record.width, record.height, "echo_texture");
            self.echo_texture.write_pixels(&self.queue, &record.pixels);

            let uniforms = if self.debug_force_magenta {
                // Modo de diagnóstico: ignora o fade normal e força
                // opacidade máxima, para que a silhueta magenta seja
                // sempre bem visível, independente da idade do registro.
                make_uniforms(&self.effects, DRAW_MODE_DEBUG_MAGENTA, 1.0, record.age_ratio, record.offset_x, record.offset_y, time_seconds)
            } else {
                make_uniforms(
                    &self.effects,
                    DRAW_MODE_ECHO,
                    record.opacity,
                    record.age_ratio,
                    record.offset_x,
                    record.offset_y,
                    time_seconds,
                )
            };

            self.draw_quad(&target_view, &self.echo_texture.view, &self.trail_front.view, uniforms, self.additive_echoes, false);
        }

        // O rastro de movimento recente vai por cima de tudo — é a
        // presença "mais viva" entre as memórias.
        let trail_draw_mode = if self.debug_force_magenta { DRAW_MODE_DEBUG_MAGENTA } else { DRAW_MODE_TRAIL };
        let trail_uniforms = make_uniforms(&self.effects, trail_draw_mode, 1.0, 0.0, 0.0, 0.0, time_seconds);
        self.draw_quad(&target_view, &self.trail_front.view, &self.trail_front.view, trail_uniforms, false, false);

        frame.present();
        Ok(())
    }
}

impl Renderer {
    /// Atualiza o acumulador de rastro (ping-pong entre `trail_front` e
    /// `trail_back`): desbota o conteúdo antigo e soma a captura nova.
    /// Ao final, `trail_front` é a versão pronta para este quadro.
    fn update_trail_accumulator(&mut self, capture_width: u32, capture_height: u32, capture_rgba: &[u8], dt_seconds: f32, is_first_render: bool) {
        self.trail_back.ensure_size(&self.device, capture_width, capture_height, "trail_back");
        self.trail_capture_texture
            .ensure_size(&self.device, capture_width, capture_height, "trail_capture_texture");
        self.trail_capture_texture.write_pixels(&self.queue, capture_rgba);

        // `decay_factor` é o quanto do rastro antigo sobrevive neste
        // quadro. Usamos uma curva exponencial (`exp(-taxa * dt)`): ela
        // dá sempre o mesmo resultado visual independentemente do FPS,
        // porque depende do tempo real passado (`dt_seconds`), não da
        // quantidade de quadros.
        let decay_factor = trail_decay_factor(self.effects.trail_decay_per_second, dt_seconds);

        if !is_first_render {
            // Passo 1: copia o rastro antigo para o novo buffer, já
            // desbotado pelo fator de decaimento.
            let decay_uniforms = make_uniforms(&self.effects, DRAW_MODE_PLAIN, decay_factor, 0.0, 0.0, 0.0, 0.0);
            self.draw_quad(&self.trail_back.view, &self.trail_front.view, &self.trail_front.view, decay_uniforms, false, true);
        }

        // Passo 2: soma a captura nova por cima (sem limpar — por isso
        // `clear_before_drawing` é `true` só quando pulamos o passo 1).
        let capture_uniforms = make_uniforms(&self.effects, DRAW_MODE_PLAIN, self.effects.trail_capture_opacity, 0.0, 0.0, 0.0, 0.0);
        self.draw_quad(
            &self.trail_back.view,
            &self.trail_capture_texture.view,
            &self.trail_front.view,
            capture_uniforms,
            false,
            is_first_render,
        );

        std::mem::swap(&mut self.trail_front, &mut self.trail_back);
    }

    /// Desenha um único "quad" (retângulo cobrindo o alvo) com a textura
    /// e os parâmetros dados. Cada chamada cria seu próprio buffer de
    /// uniforms e seu próprio bind group — não é o jeito mais rápido
    /// possível de usar a GPU, mas é simples de entender e, para a
    /// quantidade de desenhos que fazemos por quadro (a tela final mais
    /// os ecos ativos, mais duas passagens do acumulador de rastro), é
    /// rápido o suficiente.
    fn draw_quad(
        &self,
        target_view: &wgpu::TextureView,
        texture_view: &wgpu::TextureView,
        displacement_view: &wgpu::TextureView,
        uniforms: DrawUniforms,
        additive: bool,
        clear_before_drawing: bool,
    ) {
        let uniform_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("draw_uniforms"),
            contents: bytemuck::cast_slice(&[uniforms]),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("quad_bind_group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &uniform_buffer,
                        offset: 0,
                        size: None,
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(displacement_view),
                },
            ],
        });

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("quad_encoder"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("quad_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: if clear_before_drawing {
                            wgpu::LoadOp::Clear(CLEAR_COLOR)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(if additive { &self.pipeline_additive } else { &self.pipeline_alpha });
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..6, 0..1);
        }
        self.queue.submit(Some(encoder.finish()));
    }
}

/// Mistura aditiva: a cor do eco é somada à cor que já está na tela (em
/// vez de ser misturada por transparência). Deixa a imagem mais clara
/// onde há sobreposição.
const ADDITIVE_BLEND: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::SrcAlpha,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Add,
    },
};

fn create_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
    blend: wgpu::BlendState,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("quad_pipeline"),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: "vs_main",
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: "fs_main",
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(blend),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
    })
}

/// Junta os arquivos .wgsl num texto só, porque o WGSL não tem um jeito
/// de "importar" um arquivo de dentro do outro. A ordem importa:
/// `composite.wgsl` usa funções definidas nos outros, então eles
/// precisam vir antes.
fn build_shader_source() -> String {
    let echo = include_str!("shaders/echo.wgsl");
    let displacement = include_str!("shaders/displacement.wgsl");
    let dissolve = include_str!("shaders/dissolve.wgsl");
    let composite = include_str!("shaders/composite.wgsl");
    format!("{echo}\n{displacement}\n{dissolve}\n{composite}")
}
