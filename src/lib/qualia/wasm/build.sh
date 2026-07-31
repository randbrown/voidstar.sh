#!/usr/bin/env bash
# Build the NAM WaveNet kernel to WASM (SIMD128) and drop it in public/wasm/.
#
# The .wasm is COMMITTED — the site auto-deploys from a push with no CI step, and
# Cloudflare Pages has no C toolchain. Re-run this and commit the result whenever
# nam-wavenet.c changes.
#
# Needs clang 16+ with the wasm32 target (Ubuntu: `apt install clang lld`).
#   ./src/lib/qualia/wasm/build.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="$root/public/wasm/nam-wavenet.wasm"
mkdir -p "$(dirname "$out")"

clang \
  --target=wasm32 \
  -O3 -flto -msimd128 -mbulk-memory \
  -nostdlib -ffreestanding \
  -Wall -Wextra \
  -Wl,--no-entry \
  -Wl,--export-dynamic \
  -Wl,--export=__heap_base \
  -Wl,--lto-O3 \
  -Wl,--initial-memory=1114112 \
  -Wl,--strip-all \
  -o "$out" \
  "$here/nam-wavenet.c"

printf 'built %s (%s bytes)\n' "${out#"$root"/}" "$(stat -c%s "$out")"
