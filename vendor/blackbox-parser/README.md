# @narenana/blackbox-parser

Browser-native parser for **Betaflight**, **iNAV**, and **Cleanflight** blackbox binary logs (`.bbl`, `.bfl`, `.txt`). Compiled to WASM from Rust; consumed as an npm package.

Built to power [narenana.com](https://www.narenana.com)'s pilot tools — currently the EdgeTX log viewer's blackbox visualization, eventually a dedicated tuning analyzer at `/tune/`.

## Why a separate library

Two narenana tools need to parse blackbox logs (the EdgeTX viewer for 3D visualization, and the planned tuning analyzer for PID / FFT / step-response analysis). Rather than copy-paste the parser into both, it lives here as a versioned dependency. Both consumers `npm install @narenana/blackbox-parser` and call `parseBlackbox(bytes)`.

The actual format-decoding work isn't ours — we wrap the excellent [`blackbox-log` Rust crate](https://github.com/blackbox-log/blackbox-log) (MIT/Apache-2.0). This package adds a thin `wasm-bindgen` facade so the crate's API is reachable from a regular browser-side JS bundle.

## Install

```sh
npm install @narenana/blackbox-parser
```

## Usage

```ts
import init, { parseBlackbox } from '@narenana/blackbox-parser'

// One-time WASM init (resolves to the parser's exports).
await init()

// Read user file → bytes → parser
const file = inputElement.files[0]
const bytes = new Uint8Array(await file.arrayBuffer())
const log = parseBlackbox(bytes)

console.log(log.firmware)        // "Betaflight 4.4.3"
console.log(log.craftName)       // "5InchFreestyle"
console.log(log.mainFields)      // [{ name: 'gyroADC[0]', unit: '...', signed: true }, ...]
console.log(log.mainFrames[0])   // [12.3, -4.5, 0.7, ...] field values for first frame
console.log(log.mainTimes[0])    // microseconds since log start
```

If the FC had GPS, `log.gpsFields` and `log.gpsFrames` are populated. Otherwise they're `null` — most Betaflight quad logs.

## API

### `parseBlackbox(bytes: Uint8Array): FlightLog`

Eager parse of the entire byte buffer. Returns the first log inside (multi-log files are rare; subsequent logs are dropped in v0.1).

```ts
interface FlightLog {
  firmware: string
  craftName: string
  boardInfo: string
  mainFields: FieldDef[]
  slowFields: FieldDef[]
  gpsFields: FieldDef[] | null
  mainFrames: number[][]      // [frameIdx][fieldIdx]
  mainTimes: number[]         // microseconds, length === mainFrames.length
  slowFrames: number[][]
  gpsFrames: number[][] | null
}

interface FieldDef {
  name: string                // e.g. "gyroADC[0]", "motor[3]", "gpsCartesianCoords[0]"
  unit: string                // unit hint from the upstream crate
  signed: boolean
}
```

Field values are flattened to `f64`. Categorical types (flight mode, state flags, failsafe phase) come out as `NaN` — they're better reached via slow frames or by parsing the raw header strings.

## Build from source

You need Rust 1.87+ and `wasm-pack`.

```sh
# build the npm package into ./pkg
wasm-pack build --target web --release

# local dev: link into a consumer (e.g. edgetx-viewer)
cd pkg && npm link
cd ../../edgetx-viewer && npm link @narenana/blackbox-parser
```

The wasm-pack output ships a `.wasm` binary, an ES module loader, and TypeScript definitions. Consumers don't need to know any of that.

## Versioning

We follow semver against the JS API. Breaking changes to the `FlightLog` shape (renamed / removed fields, restructured arrays) bump the major version. Adding optional fields, supporting new firmware variants, or fixing parser bugs are minor / patch.

The underlying `blackbox-log` crate is pinned to a minor range in `Cargo.toml` so its breaking changes don't leak through unexpectedly.

## Limitations (v0.1)

- **Eager parse only.** Whole log loaded into memory. Fine for typical 5-minute, 4 kHz logs (~30 MB peak); will struggle on multi-minute 8 kHz logs on phones. v0.2 will add a streaming iterator.
- **First log only** in multi-log files.
- **No event surfacing.** Arming, mode-change, and error markers aren't returned. Visualization tools that need them can layer on top once we add them.
- **Slow frames aren't aligned** to main timestamps. Consumers that want aligned-by-time slow data need to interpolate.

## License

MIT OR Apache-2.0 (matches the `blackbox-log` crate). Pick whichever fits your project.
