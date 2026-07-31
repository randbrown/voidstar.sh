// Loader for the NAM WaveNet WASM kernel (public/wasm/nam-wavenet.wasm).
//
// Worklets can't fetch, so the kernel is fetched here on the main thread and the
// raw BYTES go over the port. A compiled WebAssembly.Module looks like it should
// work — it's structured-cloneable — but an AudioWorkletGlobalScope is a
// separate agent cluster, and Chrome silently drops the message instead of
// throwing: postMessage "succeeds", the worklet never hears about it, and the
// amp sits inert. The worklet compiles the bytes synchronously instead (the
// main thread's 4 KB sync-compile limit doesn't apply off-thread, and the
// kernel is ~10 KB).
//
// The module is still compiled once here so the ABI can be checked before any
// audio is routed through it. Fetched once per page and cached; a failure clears
// the cache so a later capture can retry (a flaky first fetch shouldn't disable
// the amp for the rest of a set).

const WASM_URL = '/wasm/nam-wavenet.wasm';

// Must match nam_abi() in wasm/nam-wavenet.c. The service worker serves the
// kernel stale-while-revalidate, so a cached build can meet newer JS; the check
// turns that into a clean refusal instead of a silently wrong amp.
export const NAM_ABI = 1;

let pending = null;

export function namWasmSupported() {
  return typeof WebAssembly !== 'undefined' && typeof WebAssembly.compile === 'function';
}

export function loadNamWasm() {
  if (pending) return pending;
  if (!namWasmSupported()) return Promise.reject(new Error('WebAssembly unavailable'));
  pending = (async () => {
    // Plain fetch + compile rather than compileStreaming: the response has to be
    // served as application/wasm for streaming, and a stale/misconfigured edge
    // would fail the whole load over a MIME header.
    const res = await fetch(WASM_URL, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`${res.status} fetching ${WASM_URL}`);
    const bytes = await res.arrayBuffer();
    // Compile + instantiate once here purely to read the ABI — cheap, and it
    // catches a stale kernel before any audio is routed through it.
    const probe = new WebAssembly.Instance(await WebAssembly.compile(bytes), {});
    const abi = typeof probe.exports.nam_abi === 'function' ? probe.exports.nam_abi() : 0;
    if (abi !== NAM_ABI) throw new Error(`kernel ABI ${abi}, expected ${NAM_ABI} — stale /wasm/nam-wavenet.wasm`);
    return bytes;
  })().catch((err) => { pending = null; throw err; });
  return pending;
}
