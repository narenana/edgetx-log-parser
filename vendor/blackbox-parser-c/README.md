# C-side blackbox parser (fallback)

Vendored copy of [`iNavFlight/blackbox-tools`](https://github.com/iNavFlight/blackbox-tools)'s parser core (`parser.c`, `decoders.c`, `stream.c`, `tools.c`, `platform.c`, `units.c`, `blackbox_fielddefs.c`) plus a thin C facade (`src/bb_wasm.c`) that exposes a JS-friendly API. Built with Emscripten 5.0.7 to `blackbox.mjs` + `blackbox.wasm` (~62 KB total).

## Why we have this in addition to `vendor/blackbox-parser/`

The Rust crate at `vendor/blackbox-parser/` (powered by [`blackbox-log/blackbox-log`](https://github.com/blackbox-log/blackbox-log)) is fast and compact, but its iNAV-fixed-wing test coverage is narrow. In an A/B run across 56 real-world iNAV logs, the Rust parser refused one outright with `MalformedFrameDef(Intra)` (a MATEKF405SE on iNAV 8.0.0) — a file the C parser opens cleanly. Rather than fork around the Rust crate, the viewer now uses the Rust parser by default and **lazily loads this C parser only when the Rust path fails**.

Both parsers are kept in tree so we can switch defaults later or remove one once the picture is clearer.

## Rebuilding

```sh
# from blackbox-c-wasm/ (sibling repo, where we keep the build harness)
./build.sh
cp pkg/blackbox.{mjs,wasm} ../edgetx-viewer/vendor/blackbox-parser-c/
```

The build script lives at `build.sh` here too — copy it back to the sibling working copy, run, copy artifacts back. Requires Emscripten ≥ 5.0 on PATH.

## License

The vendored C source files are GPL-3.0-licensed (from `iNavFlight/blackbox-tools`). The viewer-side JS that uses them, and the project as a whole when shipping these artifacts, must therefore also be GPL-3.0. See `LICENSE-iNAV-blackbox-tools` for the upstream notice and the repo-root `LICENSE` for the project license.
