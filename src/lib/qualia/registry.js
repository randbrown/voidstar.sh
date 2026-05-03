// QualiaMesh — the registry that wires fx plugins to the host. The page
// imports this, registers fx modules, then hands the registry to QualiaCore.

/** @typedef {import('./types.js').QFXModule} QFXModule */

export function createMesh() {
  /** @type {Map<string, QFXModule>} */
  const byId = new Map();
  /** @type {string[]} */
  const order = [];

  /** Register an fx module. Idempotent — re-registering replaces. */
  function register(mod) {
    if (!mod || !mod.id) throw new Error('register: missing module.id');
    if (!byId.has(mod.id)) order.push(mod.id);
    byId.set(mod.id, mod);
  }

  function get(id)  { return byId.get(id) || null; }
  function list()   { return order.map(id => byId.get(id)); }
  function ids()    { return [...order]; }
  function size()   { return order.length; }

  return { register, get, list, ids, size };
}
