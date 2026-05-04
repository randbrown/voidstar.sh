// Generic UI builder. Walks an fx's `params` schema and emits sliders /
// toggles / dropdowns into a container, returning an object that exposes:
//   - values():       current resolved param values (used to build field.params)
//   - setValue(id,v): programmatic update (used by Strudel hook + preset apply)
//   - applyPreset(p): write a {paramId: value} map into the controls
//   - reset():        snap every control back to its `default`
//   - destroy():      tear down listeners + clear the container
//
// The same builder also wires the audio panel's preset row + audio sliders.

/** @typedef {import('./types.js').ParamSpec} ParamSpec */

function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

function fmt(spec, raw) {
  if (spec.type === 'range') {
    const v = parseFloat(raw);
    // Heuristic formatting — small steps get more digits.
    if (spec.step >= 1)   return v.toFixed(0);
    if (spec.step >= 0.1) return v.toFixed(1);
    if (spec.step >= 0.01) return v.toFixed(2);
    return v.toFixed(3);
  }
  if (spec.type === 'toggle') return raw ? 'on' : 'off';
  return String(raw);
}

// Compact aliases so the pill column stays narrow even on params with many
// modulators. The full source path lives in the pill's title attribute for
// users who want to see the unabbreviated channel id.
const SOURCE_ALIASES = {
  'audio.bass':       'bass',
  'audio.mids':       'mids',
  'audio.highs':      'highs',
  'audio.total':      'total',
  'audio.rms':        'rms',
  'audio.beatPulse':  'beat',
  'audio.midsPulse':  'snare',
  'audio.highsPulse': 'hat',
  'pose.head.x':      'head.x',
  'pose.head.y':      'head.y',
  'pose.shoulderSpan':'span',
  'pose.shoulderRoll':'roll',
  'pose.headPitch':   'pitch',
  'pose.wristSpread': 'wrists',
  'pose.wristMidY':   'wristY',
  'pose.confidence':  'conf',
};
function shortSource(src) {
  return SOURCE_ALIASES[src] || src.replace(/^audio\./, '').replace(/^pose\./, '');
}

function sourceKind(src) {
  if (src.startsWith('audio.')) return 'audio';
  if (src.startsWith('pose.'))  return 'pose';
  return '';
}

/**
 * Build a control panel for one fx's params. Listens for `input` and
 * fires `onChange(id, value)` so callers can persist + propagate.
 *
 * Optional modulation hooks:
 *   - `getChannels()` — returns the live channel snapshot. Enables a
 *     small meter on each modulator pill (refreshed on rAF).
 *   - `getModWeight(paramId, modIdx)` — initial weight for the slider.
 *   - `onModWeightChange(paramId, modIdx, value)` — fired on slider input.
 */
export function buildParamPanel({
  container, params, onChange, getChannels, getModWeight, onModWeightChange,
}) {
  container.innerHTML = '';
  const state = {};
  const refs  = {};
  /** Per-frame meter targets: { source, fillEl } pairs. */
  const meterTargets = [];
  /** Mod weight slider inputs keyed by `${paramId}.${modIdx}` for setters. */
  const weightInputs = {};
  let rafId = 0;

  for (const spec of params) {
    state[spec.id] = spec.default;

    const row = el('div', { class: 'qp-row' });
    // Build a small "reactive" indicator dot for any param that declares
    // modulators. Inlined in JS rather than via CSS::before because the
    // Astro CSS scoping in this page doesn't reach JS-created elements
    // (every scoped selector requires `[data-astro-cid-…]` which our
    // dynamically-created label never has).
    let modDot = null;
    if (spec.type === 'range' && Array.isArray(spec.modulators) && spec.modulators.length > 0) {
      const kinds = new Set(spec.modulators.map(m => sourceKind(m.source)));
      const kind = kinds.size > 1 ? 'both' : (kinds.has('pose') ? 'pose' : 'audio');
      row.setAttribute('data-mod-kind', kind);
      modDot = el('span', { class: 'qp-mod-dot', 'aria-hidden': 'true' });
      Object.assign(modDot.style, {
        display: 'inline-block',
        width: '6px', height: '6px', borderRadius: '50%',
        marginRight: '0.4rem',
        verticalAlign: 'middle',
        flex: '0 0 auto',
      });
      if (kind === 'audio') {
        modDot.style.background = 'var(--cyan)';
        modDot.style.boxShadow = '0 0 4px rgba(34,211,238,0.55)';
      } else if (kind === 'pose') {
        modDot.style.background = 'var(--pink)';
        modDot.style.boxShadow = '0 0 4px rgba(244,114,182,0.55)';
      } else {
        modDot.style.background = 'linear-gradient(135deg,var(--cyan),var(--pink))';
        modDot.style.boxShadow = '0 0 4px rgba(160,162,220,0.55)';
      }
    }
    const valSpan = el('span', { class: 'qp-val' });
    valSpan.textContent = fmt(spec, spec.default);
    const labelKids = modDot
      ? [modDot, document.createTextNode(spec.label), valSpan]
      : [document.createTextNode(spec.label), valSpan];
    const label = el('label', {}, labelKids);

    let control;
    if (spec.type === 'range') {
      control = el('input', {
        type: 'range',
        min: String(spec.min),
        max: String(spec.max),
        step: String(spec.step),
        value: String(spec.default),
      });
      control.addEventListener('input', () => {
        const v = parseFloat(control.value);
        state[spec.id] = v;
        valSpan.textContent = fmt(spec, v);
        onChange?.(spec.id, v);
      });
    } else if (spec.type === 'toggle') {
      control = el('button', { class: `qp-toggle ${spec.default ? 'active' : ''}`, type: 'button' });
      control.textContent = spec.default ? 'on' : 'off';
      control.addEventListener('click', () => {
        const v = !state[spec.id];
        state[spec.id] = v;
        control.classList.toggle('active', v);
        control.textContent = v ? 'on' : 'off';
        valSpan.textContent = fmt(spec, v);
        onChange?.(spec.id, v);
      });
    } else if (spec.type === 'select') {
      control = el('select', { class: 'qp-select' });
      for (const opt of spec.options) {
        const o = el('option', { value: opt }); o.textContent = opt;
        if (opt === spec.default) o.selected = true;
        control.append(o);
      }
      control.addEventListener('change', () => {
        const v = control.value;
        state[spec.id] = v;
        valSpan.textContent = fmt(spec, v);
        onChange?.(spec.id, v);
      });
    } else {
      continue;
    }

    refs[spec.id] = { spec, control, valSpan };
    row.append(label, control);
    container.append(row);

    // Modulation badges — one pill per modulator, with a live meter that
    // tracks the channel value plus a weight slider so the user can dial
    // each modulator's contribution from 0 (mute) up through the spec
    // default (1) and beyond (boost up to 2).
    if (spec.type === 'range' && Array.isArray(spec.modulators) && spec.modulators.length > 0) {
      const modRow = el('div', { class: 'qp-mods' });
      for (let mi = 0; mi < spec.modulators.length; mi++) {
        const mod = spec.modulators[mi];
        const kind = sourceKind(mod.source);
        const pill = el('div', { class: `qp-mod-pill ${kind}`, title: mod.source });
        // Row 1: name + activity meter.
        const head = el('div', { class: 'qp-mod-head' });
        const lbl = el('span', { class: 'qp-mod-name' });
        lbl.textContent = shortSource(mod.source);
        const meter = el('span', { class: 'qp-mod-meter' });
        const fill = el('span');
        meter.append(fill);
        head.append(lbl, meter);
        pill.append(head);
        // Row 2: full-width weight slider.
        const initial = getModWeight ? getModWeight(spec.id, mi) : 1;
        const weight = el('input', {
          type: 'range', class: 'qp-mod-weight',
          min: '0', max: '2', step: '0.05', value: String(initial),
          title: `weight: spec ${mod.amount ?? 1}× — drag to attenuate (0) or boost (2)`,
        });
        const paramId = spec.id;
        const modIdx = mi;
        weight.addEventListener('input', () => {
          const v = parseFloat(weight.value);
          onModWeightChange?.(paramId, modIdx, v);
        });
        weightInputs[`${paramId}.${modIdx}`] = weight;
        pill.append(weight);
        modRow.append(pill);
        meterTargets.push({ source: mod.source, fill });
      }
      container.append(modRow);
    }
  }

  // Drive meters from the live channel snapshot. One rAF per panel; cancelled
  // on destroy(). Cheap — just sets `width` on N small spans where N is
  // typically 0–8 across all params.
  if (getChannels && meterTargets.length > 0) {
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const ch = getChannels();
      if (!ch) return;
      for (const t of meterTargets) {
        const v = ch[t.source];
        if (v == null) continue;
        const mag = v < 0 ? -v : v;
        // Light gamma so small signals are visible without saturating fast.
        const w = Math.min(1, Math.pow(mag, 0.6)) * 100;
        t.fill.style.width = `${w}%`;
      }
    };
    rafId = requestAnimationFrame(tick);
  }

  function setValue(id, v) {
    const r = refs[id];
    if (!r) return;
    state[id] = v;
    if (r.spec.type === 'range') {
      r.control.value = String(v);
    } else if (r.spec.type === 'toggle') {
      r.control.classList.toggle('active', !!v);
      r.control.textContent = v ? 'on' : 'off';
    } else if (r.spec.type === 'select') {
      r.control.value = String(v);
    }
    r.valSpan.textContent = fmt(r.spec, v);
  }

  function applyValues(values) {
    if (!values) return;
    for (const id of Object.keys(values)) setValue(id, values[id]);
  }

  function reset() {
    for (const spec of params) setValue(spec.id, spec.default);
  }

  /** Snap each mod weight slider to a value (default 1.0 = spec amount). */
  function resetModWeights(value = 1.0) {
    for (const key in weightInputs) weightInputs[key].value = String(value);
  }

  /** Programmatic update of a single mod weight slider. */
  function setModWeight(paramId, modIdx, value) {
    const w = weightInputs[`${paramId}.${modIdx}`];
    if (w) w.value = String(value);
  }

  function destroy() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    container.innerHTML = '';
  }

  return {
    values: () => ({ ...state }),
    setValue,
    applyValues,
    reset,
    resetModWeights,
    setModWeight,
    destroy,
  };
}

/**
 * Wire the audio preset/slider row. Returns an object with `applyPreset`,
 * `setTunables`, and a `bind()` to receive a tunables snapshot when something
 * outside the panel changes them (none currently, but symmetrical with the
 * fx panel).
 */
export function buildAudioPanel({ root, presets, onTunablesChange, onPreset }) {
  // Preset buttons
  const presetRow = root.querySelector('[data-qp="audio-presets"]');
  if (presetRow) {
    presetRow.innerHTML = '';
    presetRow.append(el('span', { class: 'qp-preset-label' }, [document.createTextNode('preset')]));
    for (const name of Object.keys(presets)) {
      const b = el('button', { class: 'qp-preset', type: 'button', 'data-preset': name });
      b.textContent = name;
      b.addEventListener('click', () => onPreset?.(name));
      presetRow.append(b);
    }
  }

  // Sliders
  const refs = {};
  const wire = (id, key, parse, fmtVal) => {
    const row = root.querySelector(`[data-qp="audio-${id}"]`);
    if (!row) return;
    const input = row.querySelector('input[type=range]');
    const valSpan = row.querySelector('.qp-val');
    if (!input || !valSpan) return;
    refs[key] = { input, valSpan, fmt: fmtVal };
    input.addEventListener('input', () => {
      const v = parse(input.value);
      valSpan.textContent = fmtVal(v);
      onTunablesChange?.({ [key]: v });
    });
  };
  wire('gain',     'gain',     parseFloat, v => `${v.toFixed(2)}×`);
  wire('thresh',   'thresh',   parseFloat, v => v.toFixed(2));
  wire('cooldown', 'cooldown', v => parseInt(v, 10), v => `${v|0}ms`);
  wire('ema',      'ema',      parseFloat, v => `${Math.round((v - 0.05) / (0.60 - 0.05) * 100)}%`);

  function clampToInput(input, v) {
    const min = parseFloat(input.min), max = parseFloat(input.max);
    if (Number.isFinite(min) && v < min) v = min;
    if (Number.isFinite(max) && v > max) v = max;
    return v;
  }
  function setTunables(t) {
    if (refs.gain     && t.gain     != null) { const v = clampToInput(refs.gain.input,     t.gain);     refs.gain.input.value     = v; refs.gain.valSpan.textContent     = refs.gain.fmt(v); }
    if (refs.thresh   && t.thresh   != null) { const v = clampToInput(refs.thresh.input,   t.thresh);   refs.thresh.input.value   = v; refs.thresh.valSpan.textContent   = refs.thresh.fmt(v); }
    if (refs.cooldown && t.cooldown != null) { const v = clampToInput(refs.cooldown.input, t.cooldown); refs.cooldown.input.value = v; refs.cooldown.valSpan.textContent = refs.cooldown.fmt(v); }
    if (refs.ema      && t.ema      != null) { const v = clampToInput(refs.ema.input,      t.ema);      refs.ema.input.value      = v; refs.ema.valSpan.textContent      = refs.ema.fmt(v); }
  }

  function setActivePreset(name) {
    if (!presetRow) return;
    presetRow.querySelectorAll('.qp-preset').forEach(b =>
      b.classList.toggle('active', b.dataset.preset === name));
  }

  return { setTunables, setActivePreset };
}
