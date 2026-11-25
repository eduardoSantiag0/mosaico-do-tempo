/* tslint:disable */
/* eslint-disable */

/**
 * Esta é a classe que o JavaScript realmente vai usar
 * (`new Engine()`, `engine.insertFrame(...)`, etc).
 */
export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    activeAgeMs(index: number): number;
    /**
     * De 0.0 (registro recém-nascido) a 1.0 (no limite de idade da sua
     * camada, quase desaparecendo). Usado para dar um ar mais
     * "fantasmagórico" aos vestígios conforme eles envelhecem.
     */
    activeAgeRatio(index: number): number;
    /**
     * Quantos registros estão ativos agora (depois da última chamada a
     * `update`). O `renderer.rs` usa isso para saber quantas vezes deve
     * desenhar um "eco" na tela.
     */
    activeCount(): number;
    activeHeight(index: number): number;
    /**
     * A partir daqui, são só "getters": funções que leem um campo do
     * registro ativo número `index` (depois de já ter chamado `update`).
     * Se o índice não existir, devolvem um valor neutro em vez de travar.
     */
    activeLayer(index: number): string;
    activeOffsetX(index: number): number;
    activeOffsetY(index: number): number;
    activeOpacity(index: number): number;
    /**
     * Devolve uma cópia dos pixels (RGBA) do registro ativo número `index`.
     */
    activePixels(index: number): Uint8Array;
    activeWidth(index: number): number;
    /**
     * Muda a configuração de uma das duas camadas discretas
     * ("intermediate" ou "long"). As durações são em milissegundos.
     * `reappearance_strength`/`reappearance_frequency` controlam o
     * efeito de "reaparecimentos ocasionais" (ver `memory.rs`); passe
     * `0.0` para `reappearance_strength` para um fade liso, sem pulsar.
     */
    configureLayer(layer: string, capacity: number, capture_interval_ms: number, max_age_ms: number, base_weight: number, fade_power: number, drift_amount: number, reappearance_strength: number, reappearance_frequency: number): void;
    /**
     * Recebe quadros RGBA consecutivos de um clipe, todos com as mesmas dimensões.
     */
    insertClip(timestamp_ms: number, width: number, height: number, intensity: number, frame_interval_ms: number, rgba: Uint8Array | number[]): void;
    /**
     * Recebe uma captura de imagem (já em resolução reduzida, no formato
     * RGBA) e entrega para a memória guardar. Cada camada decide, por
     * conta própria, se vai realmente guardar essa captura ou não.
     */
    insertFrame(timestamp_ms: number, width: number, height: number, intensity: number, rgba: Uint8Array | number[]): void;
    constructor();
    /**
     * Apaga tudo o que está guardado. Deve ser chamado quando a
     * experiência termina (ver RF10).
     */
    reset(): void;
    /**
     * Quantos bytes de memória estão sendo usados, no total, pelas duas
     * camadas discretas (o acumulador de rastro recente, na GPU, não
     * entra nessa conta). Útil para diagnóstico/depuração.
     */
    totalBytes(): number;
    /**
     * Deve ser chamado uma vez por frame de renderização. Primeiro remove
     * os registros que já expiraram, depois recalcula a lista de
     * registros ativos (do mais antigo para o mais novo) e guarda no
     * cache interno. Retorna quantos registros estão ativos agora.
     */
    update(now_ms: number): number;
}

/**
 * A classe principal que o JavaScript usa para desenhar cada quadro.
 */
export class Renderer {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Nome do backend gráfico realmente em uso ("webgpu", "gl", etc.).
     * Usado pelo modo de diagnóstico para confirmar o que está de fato
     * rodando, em vez de supor.
     */
    backendName(): string;
    /**
     * Ajusta os parâmetros artísticos dos efeitos: o campo de
     * deslocamento temporal, a dissolução dos ecos, e o ritmo com que
     * o acumulador de rastro desbota.
     */
    configureEffects(displacement_intensity: number, displacement_frequency: number, displacement_speed: number, displacement_amplitude: number, dissolve_fragmentation: number, echo_displacement_floor: number, trail_decay_per_second: number, trail_capture_opacity: number, trail_deep_decay_per_second: number, trail_deep_capture_opacity: number, trail_deep_floor_absolute: number, trail_deep_floor_ratio: number, trail_oscillation_period_seconds: number, trail_displacement_frequency: number, trail_displacement_speed: number, trail_displacement_amplitude: number): void;
    /**
     * Cria o Renderer. É uma função assíncrona porque pedir acesso à
     * GPU (adaptador e dispositivo) é uma operação assíncrona no
     * WebGPU/WebGL. Do lado do JavaScript, isso aparece como uma
     * Promise: `const renderer = await Renderer.create(canvas, w, h)`.
     */
    static create(canvas: HTMLCanvasElement, width: number, height: number): Promise<Renderer>;
    /**
     * Quantos `queue.submit()` o último quadro desenhado fez. Útil para
     * medir, num aparelho real, se a quantidade de ecos ativos está
     * sobrecarregando a GPU — em vez de só estimar (ver README,
     * "Correções de acumulação e robustez").
     */
    lastFrameSubmitCount(): number;
    /**
     * Desenha um quadro completo. Ordem (de baixo para cima):
     *
     * 1. Atualiza o acumulador de rastro (desbota o antigo, soma a
     *    captura nova).
     * 2. Reflexo atual — a base, deformada localmente pelo campo de
     *    deslocamento temporal onde o acumulador indica presença recente.
     * 3. Ecos da memória prolongada, depois intermediária.
     * 4. O próprio acumulador de rastro, por cima de tudo.
     *
     * Deve ser chamado uma vez por quadro, depois de o JavaScript já
     * ter chamado `engine.update(now_ms)`.
     */
    render(engine: Engine, now_ms: number, live_width: number, live_height: number, live_rgba: Uint8Array | number[], trail_capture_width: number, trail_capture_height: number, trail_capture_rgba: Uint8Array | number[], trail_capture_timestamp_ms: number): void;
    /**
     * Esvazia o acumulador de rastro (memória curta). Deve ser chamado
     * quando a experiência de um visitante termina (RF10), para que a
     * sessão seguinte não comece com vestígios da anterior. O
     * acumulador já desbota muito rápido por conta própria (meia-vida
     * de menos de 1 segundo com os valores padrão), mas limpar
     * explicitamente é mais correto do que confiar só nisso.
     */
    reset(): void;
    /**
     * Deve ser chamado sempre que o tamanho da tela mudar (incluindo
     * quando o celular gira).
     */
    resize(width: number, height: number): void;
    /**
     * Liga/desliga a mistura aditiva para os ecos.
     */
    setAdditiveEchoes(enabled: boolean): void;
    /**
     * Liga/desliga os dois modos de diagnóstico forçado (ver
     * `?debug=true` no app web): `force_magenta` faz os ecos e o
     * rastro aparecerem em magenta sólido (prova que chegam até o
     * renderizador); `force_distortion` faz o reflexo atual sofrer uma
     * distorção forte e constante, independente de qualquer movimento
     * real (prova que o mecanismo de distorção funciona).
     */
    setDebugFlags(force_magenta: boolean, force_distortion: boolean): void;
}

/**
 * Confirma, do lado do JavaScript, que o WebAssembly carregou
 * corretamente — e também DE QUAL COMMIT ele foi compilado
 * (`MOSAICO_BUILD_ID`, definido em `build.rs`). Isso é importante para
 * descobrir rapidamente se o navegador está rodando um `.wasm` velho
 * (de antes da última mudança no motor), em vez de ficar sem saber se
 * um efeito "não funciona" ou só "ainda não foi publicado".
 */
export function engine_version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly __wbg_renderer_free: (a: number, b: number) => void;
    readonly engine_activeAgeMs: (a: number, b: number) => number;
    readonly engine_activeAgeRatio: (a: number, b: number) => number;
    readonly engine_activeCount: (a: number) => number;
    readonly engine_activeHeight: (a: number, b: number) => number;
    readonly engine_activeLayer: (a: number, b: number) => [number, number];
    readonly engine_activeOffsetX: (a: number, b: number) => number;
    readonly engine_activeOffsetY: (a: number, b: number) => number;
    readonly engine_activeOpacity: (a: number, b: number) => number;
    readonly engine_activePixels: (a: number, b: number) => [number, number];
    readonly engine_activeWidth: (a: number, b: number) => number;
    readonly engine_configureLayer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
    readonly engine_insertClip: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly engine_insertFrame: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly engine_new: () => number;
    readonly engine_reset: (a: number) => void;
    readonly engine_totalBytes: (a: number) => number;
    readonly engine_update: (a: number, b: number) => number;
    readonly engine_version: () => [number, number];
    readonly renderer_backendName: (a: number) => [number, number];
    readonly renderer_configureEffects: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => void;
    readonly renderer_create: (a: any, b: number, c: number) => any;
    readonly renderer_lastFrameSubmitCount: (a: number) => number;
    readonly renderer_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number];
    readonly renderer_reset: (a: number) => void;
    readonly renderer_resize: (a: number, b: number, c: number) => void;
    readonly renderer_setAdditiveEchoes: (a: number, b: number) => void;
    readonly renderer_setDebugFlags: (a: number, b: number, c: number) => void;
    readonly wgpu_render_bundle_draw: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wgpu_render_bundle_draw_indexed: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wgpu_render_bundle_set_pipeline: (a: number, b: bigint) => void;
    readonly wgpu_render_bundle_draw_indirect: (a: number, b: bigint, c: bigint) => void;
    readonly wgpu_render_bundle_set_bind_group: (a: number, b: number, c: bigint, d: number, e: number) => void;
    readonly wgpu_render_bundle_set_vertex_buffer: (a: number, b: number, c: bigint, d: bigint, e: bigint) => void;
    readonly wgpu_render_bundle_set_push_constants: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wgpu_render_bundle_draw_indexed_indirect: (a: number, b: bigint, c: bigint) => void;
    readonly wgpu_render_bundle_insert_debug_marker: (a: number, b: number) => void;
    readonly wgpu_render_bundle_pop_debug_group: (a: number) => void;
    readonly wgpu_render_bundle_set_index_buffer: (a: number, b: bigint, c: number, d: bigint, e: bigint) => void;
    readonly wgpu_render_bundle_push_debug_group: (a: number, b: number) => void;
    readonly wasm_bindgen_359ff490097f3627___convert__closures_____invoke___js_sys_450af5873907ecce___Function_fn_wasm_bindgen_359ff490097f3627___JsValue_____wasm_bindgen_359ff490097f3627___sys__Undefined___js_sys_450af5873907ecce___Function_fn_wasm_bindgen_359ff490097f3627___JsValue_____wasm_bindgen_359ff490097f3627___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_359ff490097f3627___convert__closures_____invoke___wasm_bindgen_359ff490097f3627___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_359ff490097f3627___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_359ff490097f3627___convert__closures_____invoke___wasm_bindgen_359ff490097f3627___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_359ff490097f3627___convert__closures_____invoke___wasm_bindgen_359ff490097f3627___JsValue______true__30: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
