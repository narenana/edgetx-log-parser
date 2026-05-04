# Local patches over upstream `iNavFlight/blackbox-tools`

The C source in `src/` is a vendored snapshot of `iNavFlight/blackbox-tools`
HEAD as of 2026-05-04, **plus** two small local patches to make the parser
more resilient to wire-corrupt iNAV logs. Both patches are purely defensive —
they don't change behaviour on well-formed logs (verified across a 54-log
fleet of SpeedyBee F405 Wing iNAV 8.0.1 files; identical output before
and after the patches).

## Patch 1 — `stream.c`: invalid VB encoding signals stream error

`streamReadUnsignedVB` originally returned `0` silently when 5 consecutive
bytes all had the continuation bit set (an over-long encoding that no
correct iNAV/Betaflight writer can produce: the 5-byte cap always has the
last byte's continuation bit clear). The silent-zero behaviour let
parseFrame happily continue consuming bytes off the wire to satisfy the
schema's remaining fields, often swallowing the next frame's marker byte
as ordinary field data.

Patch: when 5 cont-bytes are detected, also set `stream->eof = true`
before returning. Downstream `streamReadByte` / `streamReadChar` were
also amended to honour the `eof` flag, so subsequent reads abort the
in-progress frame rather than continuing to consume bytes from a stream
the parser already knows is corrupt.

## Patch 2 — `parser.c`: invalidating the stream resets validator state

`flightLogInvalidateStream` previously only zeroed the `mainHistory`
pointers but kept `lastMainFrameIteration` and `lastMainFrameTime` from
before the corruption. After a long run of corrupt frames, the cached
"last iter" was stale and far behind any subsequent clean I-frame's
counter, so `flightLogValidateMainFrameValues` failed the iteration-jump
check (default 5,000 loops) on every recovery attempt — making
recovery effectively impossible.

Patch: also reset `lastMainFrameIteration` and `lastMainFrameTime` to
their "uninitialised" sentinels in `flightLogInvalidateStream`. With
this, the next clean I-frame is accepted unconditionally (the validator
short-circuits on `lastMainFrameIteration == -1`), which is the correct
behaviour at a recovery point.

## When these help

A real iNAV 9.0.1 log we got from a CoreWingF405WingV2 board exhibited
both bug classes — uninitialised `mspOverrideFlags` in early slow
frames produced 5 consecutive `0xD3` bytes (= the over-long VB pattern
patch 1 catches), and the resulting stream-desync run was wider than
the validator's 5,000-iteration window (= what patch 2 unblocks). The
patches don't fully fix that file (the wire corruption extends beyond
what we can paper over without further work), but they do let the
parser recover ~2× more frames before giving up, with no regressions
on the rest of the fleet.

## When these don't help

If the wire-side corruption is more pervasive than a single 5-cont-VB
sequence — multiple fields with bad encoding, or unrelated byte-flips
within an I-frame body — the parser still desyncs and rejects most of
the file. That's an upstream iNAV writer issue (track via the file's
firmware revision and FC target) and not fixable from the parser side.

## Workflow for further patches

The build still pulls source from `../../inav-blackbox-tools/src/` (the
git clone of `iNavFlight/blackbox-tools` HEAD). Edit there, run
`./build.sh`, then re-sync the modified `.c`/`.h` files into this
`src/` directory and rebuild artifacts (`blackbox.{mjs,wasm}`) before
committing. Document any new patches in this file.
