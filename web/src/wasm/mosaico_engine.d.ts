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
     * Muda a configuração de uma das três camadas ("short", "intermediate"
     * ou "long"). As durações são em milissegundos.
     */
    configureLayer(layer: string, capacity: number, capture_interval_ms: number, max_age_ms: number, base_weight: number, fade_power: number, drift_amount: number): void;
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
     * Quantos bytes de memória estão sendo usados, no total, pelas três
     * camadas. Útil para diagnóstico/depuração.
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
     * Ajusta os parâmetros artísticos dos efeitos (RF06/RF07). Pensado
     * para ser chamado pelo painel de desenvolvimento (Etapa 5).
     */
    configureEffects(underwater_intensity: number, underwater_frequency: number, underwater_speed: number, underwater_amplitude: number, dissolve_fragmentation: number): void;
    /**
     * Cria o Renderer. É uma função assíncrona porque pedir acesso à
     * GPU (adaptador e dispositivo) é uma operação assíncrona no
     * WebGPU/WebGL. Do lado do JavaScript, isso aparece como uma
     * Promise: `const renderer = await Renderer.create(canvas, w, h)`.
     */
    static create(canvas: HTMLCanvasElement, width: number, height: number): Promise<Renderer>;
    /**
     * Desenha um quadro completo: primeiro o reflexo atual (que serve de
     * base, preenchendo a tela inteira), depois os ecos (do mais antigo
     * para o mais novo, já nessa ordem dentro de `engine`) por cima, com
     * transparência. Deve ser chamado uma vez por frame, depois de o
     * JavaScript já ter chamado `engine.update(now_ms)`.
     */
    render(engine: Engine, now_ms: number, live_width: number, live_height: number, live_rgba: Uint8Array | number[]): void;
    /**
     * Deve ser chamado sempre que o tamanho da tela mudar (incluindo
     * quando o celular gira — RF: "mudança de orientação").
     */
    resize(width: number, height: number): void;
    /**
     * Liga/desliga a mistura aditiva para os ecos (parte do RF08: o
     * compositor deve permitir diferentes modos de mistura).
     */
    setAdditiveEchoes(enabled: boolean): void;
}

/**
 * Só serve para confirmar, do lado do JavaScript, que o WebAssembly
 * carregou corretamente.
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
    readonly engine_configureLayer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly engine_insertFrame: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly engine_new: () => number;
    readonly engine_reset: (a: number) => void;
    readonly engine_totalBytes: (a: number) => number;
    readonly engine_update: (a: number, b: number) => number;
    readonly engine_version: () => [number, number];
    readonly renderer_configureEffects: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly renderer_create: (a: any, b: number, c: number) => any;
    readonly renderer_render: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly renderer_resize: (a: number, b: number, c: number) => void;
    readonly renderer_setAdditiveEchoes: (a: number, b: number) => void;
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
    readonly wasm_bindgen_9e9d2b03fac4fd08___convert__closures_____invoke___js_sys_b2e07bec349c6cad___Function_fn_wasm_bindgen_9e9d2b03fac4fd08___JsValue_____wasm_bindgen_9e9d2b03fac4fd08___sys__Undefined___js_sys_b2e07bec349c6cad___Function_fn_wasm_bindgen_9e9d2b03fac4fd08___JsValue_____wasm_bindgen_9e9d2b03fac4fd08___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_9e9d2b03fac4fd08___convert__closures_____invoke___wasm_bindgen_9e9d2b03fac4fd08___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_9e9d2b03fac4fd08___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_9e9d2b03fac4fd08___convert__closures_____invoke___wasm_bindgen_9e9d2b03fac4fd08___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_9e9d2b03fac4fd08___convert__closures_____invoke___wasm_bindgen_9e9d2b03fac4fd08___JsValue______true__25: (a: number, b: number, c: any) => void;
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
