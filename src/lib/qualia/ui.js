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

/**
 * Build a control panel for one fx's params. Listens for `input` and
 * fires `onChange(id, value)` so callers can persist + propagate.
 */
export function buildParamPanel({ container, params, onChange }) {
  container.innerHTML = '';
  const state = {};
  const refs  = {};

  for (const spec of params) {
    state[spec.id] = spec.default;

    const row = el('div', { class: 'qp-row' });
    const valSpan = el('span', { class: 'qp-val' });
    valSpan.textContent = fmt(spec, spec.default);
    const label = el('label', {}, [document.createTextNode(spec.label), valSpan]);

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

  function destroy() {
    container.innerHTML = '';
  }

  return {
    values: () => ({ ...state }),
    setValue,
    applyValues,
    reset,
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
  wire('ema',      'ema',      parseFloat, v => `${Math.round((v - 0.04) / (0.40 - 0.04) * 100)}%`);

  function setTunables(t) {
    if (refs.gain     && t.gain     != null) { refs.gain.input.value     = t.gain;     refs.gain.valSpan.textContent     = refs.gain.fmt(t.gain); }
    if (refs.thresh   && t.thresh   != null) { refs.thresh.input.value   = t.thresh;   refs.thresh.valSpan.textContent   = refs.thresh.fmt(t.thresh); }
    if (refs.cooldown && t.cooldown != null) { refs.cooldown.input.value = t.cooldown; refs.cooldown.valSpan.textContent = refs.cooldown.fmt(t.cooldown); }
    if (refs.ema      && t.ema      != null) { refs.ema.input.value      = t.ema;      refs.ema.valSpan.textContent      = refs.ema.fmt(t.ema); }
  }

  function setActivePreset(name) {
    if (!presetRow) return;
    presetRow.querySelectorAll('.qp-preset').forEach(b =>
      b.classList.toggle('active', b.dataset.preset === name));
  }

  return { setTunables, setActivePreset };
}
