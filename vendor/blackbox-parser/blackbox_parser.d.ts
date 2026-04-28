/* tslint:disable */
/* eslint-disable */

/**
 * JS-facing handle to a parsed blackbox log. The bulk frame data lives in
 * owned Rust `Vec<f64>` buffers; the getter methods produce
 * `Float64Array`s on demand by copying the buffer into JS heap memory.
 * Call `.free()` from JS once the data has been read so we drop the
 * Rust-side allocations.
 */
export class FlightLog {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly boardInfo: string;
    readonly craftName: string;
    readonly firmware: string;
    readonly gpsCols: number;
    readonly gpsFieldNames: string[];
    readonly gpsFieldSigned: Uint8Array;
    readonly gpsFieldUnits: string[];
    readonly gpsFrames: Float64Array;
    readonly gpsTimes: Float64Array;
    readonly hasGps: boolean;
    readonly mainCols: number;
    readonly mainFieldNames: string[];
    readonly mainFieldSigned: Uint8Array;
    readonly mainFieldUnits: string[];
    readonly mainFrames: Float64Array;
    readonly mainTimes: Float64Array;
    readonly slowCols: number;
    readonly slowFieldNames: string[];
    readonly slowFieldSigned: Uint8Array;
    readonly slowFieldUnits: string[];
    readonly slowFrames: Float64Array;
    readonly slowTimes: Float64Array;
}

/**
 * Parse a blackbox log buffer.
 *
 * `bytes` is the raw contents of a `.bbl` / `.bfl` / `.txt` file.
 * `main_stride` downsamples main frames at decode time — pass `1` to
 * emit every frame, higher values to thin the data set proportionally.
 * (GPS and slow frames are always emitted at full rate; they're already
 * 1–2 orders of magnitude rarer than main frames.)
 *
 * Returns the first log inside the buffer; multi-log files (rare —
 * disarm + re-arm with the same SD card) drop subsequent logs for now.
 */
export function parseBlackbox(bytes: Uint8Array, main_stride: number): FlightLog;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_flightlog_free: (a: number, b: number) => void;
    readonly flightlog_boardInfo: (a: number, b: number) => void;
    readonly flightlog_craftName: (a: number, b: number) => void;
    readonly flightlog_firmware: (a: number, b: number) => void;
    readonly flightlog_gpsCols: (a: number) => number;
    readonly flightlog_gpsFieldNames: (a: number, b: number) => void;
    readonly flightlog_gpsFieldSigned: (a: number, b: number) => void;
    readonly flightlog_gpsFieldUnits: (a: number, b: number) => void;
    readonly flightlog_gpsFrames: (a: number) => number;
    readonly flightlog_gpsTimes: (a: number) => number;
    readonly flightlog_hasGps: (a: number) => number;
    readonly flightlog_mainCols: (a: number) => number;
    readonly flightlog_mainFieldNames: (a: number, b: number) => void;
    readonly flightlog_mainFieldSigned: (a: number, b: number) => void;
    readonly flightlog_mainFieldUnits: (a: number, b: number) => void;
    readonly flightlog_mainFrames: (a: number) => number;
    readonly flightlog_mainTimes: (a: number) => number;
    readonly flightlog_slowCols: (a: number) => number;
    readonly flightlog_slowFieldNames: (a: number, b: number) => void;
    readonly flightlog_slowFieldSigned: (a: number, b: number) => void;
    readonly flightlog_slowFieldUnits: (a: number, b: number) => void;
    readonly flightlog_slowFrames: (a: number) => number;
    readonly flightlog_slowTimes: (a: number) => number;
    readonly parseBlackbox: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
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
