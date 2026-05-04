#!/usr/bin/env bash
# Build script: compile iNAV's blackbox-tools parser + our WASM facade
# into a single .wasm + .js loader pair, suitable for the
# `?url`/`Module()` pattern used by Vite + a Web Worker.
#
# Outputs to ./pkg/.

set -euo pipefail

EMSDK="/j/Dropbox/claude-battlestation/emsdk"
EMCC_PY="$EMSDK/upstream/emscripten/emcc.py"
PYTHON="$EMSDK/python/3.13.3_64bit/python.exe"
# Put the bundled Python at the head of PATH so subprocesses spawned by
# emcc (cache-builder, linker, etc.) use it instead of system python 3.9.
export PATH="$EMSDK/python/3.13.3_64bit:$PATH"
export EMSDK_PYTHON="$PYTHON"

INAV_SRC="/j/Dropbox/claude-battlestation/inav-blackbox-tools/src"
HERE="$(dirname "$0")"

mkdir -p "$HERE/pkg"

# Parser core sources from iNAV blackbox-tools (per their Makefile's
# COMMON_SRC, minus the CLI/render/encoder bits we don't need).
SRCS=(
  "$HERE/src/bb_wasm.c"
  "$INAV_SRC/parser.c"
  "$INAV_SRC/decoders.c"
  "$INAV_SRC/stream.c"
  "$INAV_SRC/tools.c"
  "$INAV_SRC/platform.c"
  "$INAV_SRC/units.c"
  "$INAV_SRC/blackbox_fielddefs.c"
)

# All the C-side names JS will need to call. The leading underscore is
# Emscripten's convention for C symbols.
EXPORTS='[
  "_bb_open",
  "_bb_close",
  "_bb_main_field_count",
  "_bb_slow_field_count",
  "_bb_gps_field_count",
  "_bb_main_field_name",
  "_bb_slow_field_name",
  "_bb_gps_field_name",
  "_bb_main_field_signed_ptr",
  "_bb_slow_field_signed_ptr",
  "_bb_gps_field_signed_ptr",
  "_bb_main_frame_count",
  "_bb_slow_frame_count",
  "_bb_gps_frame_count",
  "_bb_main_frames_ptr",
  "_bb_slow_frames_ptr",
  "_bb_gps_frames_ptr",
  "_bb_firmware_revision",
  "_bb_diag_main_seen",
  "_bb_diag_main_invalid",
  "_bb_diag_slow_seen",
  "_bb_diag_gps_seen",
  "_bb_diag_total_corrupt",
  "_malloc",
  "_free"
]'

# Runtime helpers we'll touch from JS — UTF8 string decode, heap views,
# and FS bindings (we use FS to stage the input bytes via MEMFS).
RT_EXPORTS='[
  "UTF8ToString",
  "HEAP8",
  "HEAPU8",
  "HEAP32",
  "HEAPU32",
  "HEAPF64",
  "FS"
]'

"$PYTHON" "$EMCC_PY" \
  "${SRCS[@]}" \
  -I "$INAV_SRC" \
  -O3 -flto \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT='web,worker' \
  -sFILESYSTEM=1 \
  -sFORCE_FILESYSTEM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16MB \
  -sMAXIMUM_MEMORY=2GB \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sEXPORTED_RUNTIME_METHODS="$RT_EXPORTS" \
  -sNO_EXIT_RUNTIME=1 \
  -sASSERTIONS=0 \
  -sSTACK_SIZE=1MB \
  -DPLATFORM_WASM=1 \
  -o "$HERE/pkg/blackbox.mjs"

ls -la "$HERE/pkg/"
echo "--- WASM size ---"
stat -c '%s bytes' "$HERE/pkg/blackbox.wasm" 2>/dev/null || ls -la "$HERE/pkg/"*.wasm
