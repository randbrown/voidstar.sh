// JSDoc typedefs only — no runtime exports. Imported via `import('./types.js')`
// inside JSDoc `@type` annotations so editors (VSCode, etc.) get IntelliSense
// without us having to set up a TS toolchain.

/**
 * @typedef {Object} AudioBands
 * @property {number} bass    Smoothed [0,1] bass band (≈20–250 Hz).
 * @property {number} mids    Smoothed [0,1] mids band (≈250–4000 Hz).
 * @property {number} highs   Smoothed [0,1] highs band (≈4000–12000 Hz).
 * @property {number} total   Smoothed mean of the three bands.
 */

/**
 * @typedef {Object} AudioTransient
 * @property {boolean} active  Fired this frame.
 * @property {number}  pulse   Decaying [0,1] envelope; 1 on hit, fades exponentially.
 */

/**
 * @typedef {Object} AudioFrame
 * @property {AudioBands}      bands
 * @property {AudioTransient}  beat       Bass-driven beat detection (kick).
 * @property {AudioTransient}  mids       Mids-driven transient (snare / clap).
 * @property {AudioTransient}  highs      Highs-driven transient (hat / cymbal).
 * @property {number}          rms        Time-domain RMS [0,1].
 * @property {Uint8Array|null} spectrum   Frequency bins (analyser.getByteFrequencyData).
 * @property {Uint8Array|null} waveform   Time-domain bins (analyser.getByteTimeDomainData).
 */

/**
 * Normalized landmark in [0,1] field coordinates with a visibility/confidence flag.
 * @typedef {Object} Landmark
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} visibility   [0,1]
 */

/**
 * @typedef {Object} Person
 * @property {Landmark} head        MediaPipe LM 0 (nose).
 * @property {Landmark} neck        Synthesised: midpoint of shoulders.
 * @property {{l:Landmark,r:Landmark}} shoulders
 * @property {{l:Landmark,r:Landmark}} elbows
 * @property {{l:Landmark,r:Landmark}} wrists
 * @property {{l:Landmark,r:Landmark}} hips
 * @property {{l:Landmark,r:Landmark}} knees
 * @property {{l:Landmark,r:Landmark}} ankles
 * @property {Landmark[]} raw       Original 33-element MediaPipe array (for fx that want it).
 * @property {number} confidence    Mean visibility across the named joints.
 */

/**
 * @typedef {Object} PoseFrame
 * @property {Person[]} people
 * @property {number}   timestamp   performance.now() at detection.
 */

/**
 * @typedef {Object} QualiaField
 * @property {number} dt        Seconds since last frame, clamped.
 * @property {number} time      Seconds since core start.
 * @property {AudioFrame} audio
 * @property {PoseFrame}  pose
 * @property {Object<string,number|string|boolean>} params
 *           Per-frame *resolved* param values — base UI values with the
 *           active fx's modulators (audio + pose channels) applied. Read
 *           these directly; declarative modulation is already baked in.
 * @property {Object<string,number>} [channels]
 *           Snapshot of all named modulation channels for this frame
 *           (e.g. `audio.bass`, `pose.shoulderSpan`). Useful for fx /
 *           overlays that want to read a channel without going through
 *           a param. Populated by core.js, not user-mutable.
 */

/**
 * Declarative modulation entry on a numeric param. The engine resolves
 * `params.<id>` each frame as `base ⊕ source*amount` per modulator (in
 * declaration order). See modulation.js for the channel registry.
 *
 * @typedef {Object} ModulatorSpec
 * @property {string} source    Channel id, e.g. 'audio.bass', 'pose.head.x'.
 * @property {'add'|'mul'|'replace'} [mode]  Default 'mul'.
 * @property {number} [amount]  Strength multiplier on the channel value (default 1).
 *                              For 'mul', amount=0 is identity; for 'add', amount=0 is identity.
 *                              Audio modulators are additionally scaled by the fx's
 *                              `reactivity` param when present.
 */

/**
 * @typedef {Object} ParamRange
 * @property {string} id
 * @property {string} label
 * @property {'range'} type
 * @property {number} min
 * @property {number} max
 * @property {number} step
 * @property {number} default
 * @property {ModulatorSpec[]} [modulators]
 */
/**
 * @typedef {Object} ParamToggle
 * @property {string} id
 * @property {string} label
 * @property {'toggle'} type
 * @property {boolean} default
 */
/**
 * @typedef {Object} ParamSelect
 * @property {string} id
 * @property {string} label
 * @property {'select'} type
 * @property {string[]} options
 * @property {string} default
 */
/** @typedef {ParamRange | ParamToggle | ParamSelect} ParamSpec */

/**
 * @typedef {Object} QFXInstance
 * @property {(w:number, h:number, dpr:number) => void} resize
 * @property {(field:QualiaField) => void}              update
 * @property {() => void}                               render
 * @property {() => void}                               dispose
 */

/**
 * @typedef {Object} AutoCycleSpec
 * @property {Array<Object<string, number|string|boolean>>} steps
 *           Ordered list of partial param dicts. The topbar auto button
 *           applies one step per AUTO_CYCLE_SECONDS interval via
 *           core.setParam, so only the keys present in each step are
 *           overwritten — everything else the user dialed in stays.
 */

/**
 * @typedef {Object} QFXModule
 * @property {string} id
 * @property {string} name
 * @property {'canvas2d'|'webgl2'} contextType
 * @property {ParamSpec[]} params
 * @property {Object<string, Object<string, number|string|boolean>>} [presets]
 * @property {AutoCycleSpec} [autoCycle]
 *           Declares the topbar auto button's behaviour while this quale is
 *           active. Omit if the quale has nothing to cycle — the button
 *           reads "auto n/a" and is disabled.
 * @property {(canvas:HTMLCanvasElement, opts:{ gl?:WebGL2RenderingContext, ctx?:CanvasRenderingContext2D }) => Promise<QFXInstance>|QFXInstance} create
 */

export {};
