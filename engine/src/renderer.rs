// Este arquivo é o "Renderer": a parte que sabe desenhar coisas na tela
// usando a GPU, através da biblioteca `wgpu` (que fala WebGPU, e também
// sabe usar WebGL2 como alternativa em navegadores mais antigos).
//
// Ele também faz o papel do "Compositor" descrito no enunciado: decide a
// ordem de desenho (vestígios mais antigos primeiro, reflexo atual por
// cima) e junta isso com os parâmetros dos efeitos visuais
// (`effects.rs`). Separamos essa responsabilidade num struct próprio só
// se, no futuro, a lógica de "o que desenhar" crescer e ficar complicada
// o suficiente pra valer a pena separar de "como desenhar".
//
// Um aviso sobre o estilo deste código: trabalhar com GPU em qualquer
// linguagem é naturalmente um pouco verboso — é preciso descrever cada
// detalhe (formato da textura, como misturar as cores, etc.) porque a
// GPU não adivinha nada. Tentamos comentar o "porquê" de cada parte para
// compensar isso.

use crate::effects::EffectConfig;
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
    /// 1.0 para o reflexo atual (sem distorção/dissolução), 0.0 para um eco.
    is_live: f32,
    underwater_intensity: f32,
    underwater_frequency: f32,
    underwater_speed: f32,
    underwater_amplitude: f32,
    dissolve_fragmentation: f32,
    /// Sem uso — só está aqui para o tamanho da struct ficar "redondo"
    /// (múltiplo de 16 bytes), que é uma regra de alinhamento da GPU
    /// para esse tipo de dado (`var<uniform>`).
    padding: f32,
}

/// Uma textura simples (imagem na memória da GPU) que reutilizamos quadro
/// a quadro, só trocando o conteúdo (em vez de criar uma textura nova
/// toda hora, o que seria mais lento).
struct ReusableTexture {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

impl ReusableTexture {
    fn new(device: &wgpu::Device, width: u32, height: u32, label: &str) -> Self {
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
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        ReusableTexture {
            texture,
            view,
            width,
            height,
        }
    }

    /// Se o tamanho pedido for diferente do atual, recria a textura.
    /// Chamado, por exemplo, quando o visitante gira o celular e a
    /// proporção da imagem capturada muda.
    fn ensure_size(&mut self, device: &wgpu::Device, width: u32, height: u32, label: &str) {
        if width != self.width || height != self.height {
            *self = ReusableTexture::new(device, width, height, label);
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
    /// mais claras). Fica disponível para os ecos, caso configurado
    /// (ver RF08), mas nunca é usada para o reflexo atual.
    pipeline_additive: wgpu::RenderPipeline,

    live_texture: ReusableTexture,
    echo_texture: ReusableTexture,

    effects: EffectConfig,
    /// Se verdadeiro, os ecos usam a mistura aditiva em vez da normal.
    additive_echoes: bool,
}

#[wasm_bindgen]
impl Renderer {
    /// Cria o Renderer. É uma função assíncrona porque pedir acesso à
    /// GPU (adaptador e dispositivo) é uma operação assíncrona no
    /// WebGPU/WebGL. Do lado do JavaScript, isso aparece como uma
    /// Promise: `const renderer = await Renderer.create(canvas, w, h)`.
    pub async fn create(canvas: web_sys::HtmlCanvasElement, width: u32, height: u32) -> Result<Renderer, JsValue> {
        // Pedimos ao navegador tanto WebGPU quanto WebGL2: o wgpu escolhe
        // automaticamente o que estiver disponível (RF: "WebGPU como
        // backend preferencial, WebGL2 quando compatível").
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

        let live_texture = ReusableTexture::new(&device, width.max(1), height.max(1), "live_texture");
        let echo_texture = ReusableTexture::new(&device, 1, 1, "echo_texture");

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
            effects: EffectConfig::default_config(),
            additive_echoes: false,
        })
    }

    /// Deve ser chamado sempre que o tamanho da tela mudar (incluindo
    /// quando o celular gira — RF: "mudança de orientação").
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

    /// Ajusta os parâmetros artísticos dos efeitos (RF06/RF07). Pensado
    /// para ser chamado pelo painel de desenvolvimento (Etapa 5).
    #[wasm_bindgen(js_name = configureEffects)]
    pub fn configure_effects(
        &mut self,
        underwater_intensity: f32,
        underwater_frequency: f32,
        underwater_speed: f32,
        underwater_amplitude: f32,
        dissolve_fragmentation: f32,
    ) {
        self.effects = EffectConfig {
            underwater_intensity,
            underwater_frequency,
            underwater_speed,
            underwater_amplitude,
            dissolve_fragmentation,
        };
    }

    /// Liga/desliga a mistura aditiva para os ecos (parte do RF08: o
    /// compositor deve permitir diferentes modos de mistura).
    #[wasm_bindgen(js_name = setAdditiveEchoes)]
    pub fn set_additive_echoes(&mut self, enabled: bool) {
        self.additive_echoes = enabled;
    }

    /// Desenha um quadro completo: primeiro os ecos (do mais antigo para
    /// o mais novo, já nessa ordem dentro de `engine`), depois o reflexo
    /// atual por cima. Deve ser chamado uma vez por frame, depois de o
    /// JavaScript já ter chamado `engine.update(now_ms)`.
    pub fn render(
        &mut self,
        engine: &Engine,
        now_ms: f64,
        live_width: u32,
        live_height: u32,
        live_rgba: &[u8],
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
        let mut is_first_draw = true;

        let active_count = engine.active_count();
        for index in 0..active_count {
            let record = match engine.active_record(index) {
                Some(record) => record,
                None => continue,
            };

            self.echo_texture
                .ensure_size(&self.device, record.width, record.height, "echo_texture");
            self.echo_texture.write_pixels(&self.queue, &record.pixels);

            let uniforms = DrawUniforms {
                offset_x: record.offset_x,
                offset_y: record.offset_y,
                opacity: record.opacity,
                age_ratio: record.age_ratio,
                time_seconds,
                is_live: 0.0,
                underwater_intensity: self.effects.underwater_intensity,
                underwater_frequency: self.effects.underwater_frequency,
                underwater_speed: self.effects.underwater_speed,
                underwater_amplitude: self.effects.underwater_amplitude,
                dissolve_fragmentation: self.effects.dissolve_fragmentation,
                padding: 0.0,
            };

            self.draw_quad(&target_view, &self.echo_texture.view, uniforms, self.additive_echoes, is_first_draw);
            is_first_draw = false;
        }

        self.live_texture
            .ensure_size(&self.device, live_width, live_height, "live_texture");
        self.live_texture.write_pixels(&self.queue, live_rgba);

        let live_uniforms = DrawUniforms {
            offset_x: 0.0,
            offset_y: 0.0,
            opacity: 1.0,
            age_ratio: 0.0,
            time_seconds,
            is_live: 1.0,
            underwater_intensity: 0.0,
            underwater_frequency: 0.0,
            underwater_speed: 0.0,
            underwater_amplitude: 0.0,
            dissolve_fragmentation: 0.0,
            padding: 0.0,
        };
        self.draw_quad(&target_view, &self.live_texture.view, live_uniforms, false, is_first_draw);

        frame.present();
        Ok(())
    }
}

impl Renderer {
    /// Desenha um único "quad" (retângulo cobrindo a tela) com a textura
    /// e os parâmetros dados. Cada chamada cria seu próprio buffer de
    /// uniforms e seu próprio bind group — não é o jeito mais rápido
    /// possível de usar a GPU, mas é simples de entender e, para a
    /// quantidade de ecos que guardamos (no máximo algumas centenas), é
    /// rápido o suficiente.
    fn draw_quad(
        &self,
        target_view: &wgpu::TextureView,
        texture_view: &wgpu::TextureView,
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

/// Junta os quatro arquivos .wgsl num texto só, porque o WGSL não tem um
/// jeito de "importar" um arquivo de dentro do outro. A ordem importa:
/// `composite.wgsl` usa funções definidas nos outros três, então eles
/// precisam vir antes.
fn build_shader_source() -> String {
    let echo = include_str!("shaders/echo.wgsl");
    let underwater = include_str!("shaders/underwater.wgsl");
    let dissolve = include_str!("shaders/dissolve.wgsl");
    let composite = include_str!("shaders/composite.wgsl");
    format!("{echo}\n{underwater}\n{dissolve}\n{composite}")
}
