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
