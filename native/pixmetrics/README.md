# pixmetrics — native quality-gate metrics

Rust port of the pipeline's image measurements (agents/ops/subject-metrics.mjs, quality-gates.mjs, stats.mjs,
sho-palette.mjs). PixInsight writes the working view to an uncompressed Float32 XISF once per image state; this
binary reads it and computes the requested metrics in parallel.

**Why:** on M74 v11 (3000x2000) the checks were 61% of a 2 h 50 min run: one `run_quality_gates` battery took ~350 s
in PixInsight's JS engine. The same 33 metrics take ~12 s natively (most of it per-call export/spawn overhead; the
measurements themselves are 1-600 ms).

## Build

```bash
# macOS / Linux / Windows (native toolchain): https://rustup.rs
npm run build:native          # cargo build --release --manifest-path native/pixmetrics/Cargo.toml
npm run test:native

# Windows binary from macOS (needs: brew install mingw-w64; rustup target add x86_64-pc-windows-gnu)
cd native/pixmetrics && CARGO_TARGET_DIR=target-win cargo build --release --target x86_64-pc-windows-gnu
```

Pure Rust, no C dependencies (zlib via miniz_oxide, lz4_flex, ruzstd, png, jpeg-decoder), so it cross-compiles
cleanly. CI (.github/workflows/pixmetrics.yml) builds and tests macOS arm64/x64, Windows x64 and Linux x64.

The Node side (agents/ops/native-metrics.mjs) looks for the binary in `$PIXMETRICS_BIN`,
`native/pixmetrics/bin/<platform>-<arch>/`, then `native/pixmetrics/target/release/`. If none is found, if it
fails, or with `PIXINSIGHT_MCP_NATIVE=0`, every metric falls back to its PixInsight implementation (`…Pjsr`).

## CLI

```bash
pixmetrics list
pixmetrics info    --image file.xisf|.png|.jpg
pixmetrics measure --image file.xisf --request-file req.json
# req.json: {"metrics":[{"name":"palette_purity","params":{"inv":{"centre":[1524,972],"rDet":775}}}]}
```

Output: `{ok, w, h, c, readMs, totalMs, results:[{id, name, ok, value|error, ms}]}`. Each `value` has the same
keys as the JS function it replaces.

## XISF support

Monolithic XISF 1.0: attachment / inline / embedded blocks; planar or normal storage; UInt8/16/32, Float32/64
(bounds honoured); compression zlib, lz4, lz4hc, zstd, each optionally byte-shuffled (`+sh`).

## Parity with PixInsight

`node scripts/native-parity.mjs --image a.xisf --inv prep-metrics.json [--ref ref.xisf]` runs every metric both
ways on images opened in PixInsight. On M74 (2026-11-10) all metrics agree to < 1e-4 relative, most to 7-8 digits.
Two PixInsight conventions matter and were verified:
- `Image.median()` pools all channels and averages the two middle values for even counts; `MAD()` is unscaled.
- `Convolution` (Parametric, Gaussian) truncates the kernel at 1% of the peak (radius 3.035 sigma) and reflects
  at the borders (`d c b a | a b c d`).

## Batching

`nativeBatch(ctx, viewId, label, fn)` (agents/ops/native-metrics.mjs) wraps a read-only gate battery: the view is
exported and fingerprinted once, and every metric the same `label` requested last time is computed in one binary
call (one image read, metrics in parallel). Labels in use: `finish-gates`, `stage:<stage>`, `step-metrics`. The plan
self-updates each time, so no metric list has to be kept in sync with the gate code; a metric that was not
prefetched still runs on the frozen export. Tested on M74: 4 stage checkpoints 2.6 s -> 1.35 s, 15/15 prefetch
hits, results identical.
