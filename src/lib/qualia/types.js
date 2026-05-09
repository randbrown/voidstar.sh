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
 * Polymorphic Person — either a `human` (MediaPipe PoseLandmarker output) or
 * a `dog` (MediaPipe ObjectDetector bbox with a synthesized skeleton). Shared
 * core: `kind`, `head`, `neck`, `hips`, `confidence`. Human-only joints
 * (shoulders/elbows/wrists/knees/ankles) and dog-only fields (paws/tail/snout
 * /bbox/heading) are present only on their respective kinds — fx that read
 * them should null-check or filter by `kind` first.
 *
 * @typedef {Object} Person
 * @property {'human'|'dog'} kind
 * @property {Landmark} head        Humans: MediaPipe LM 0 (nose). Dogs: head end of bbox along heading.
 * @property {Landmark} neck        Humans: midpoint of shoulders. Dogs: 20% along long axis from head.
 * @property {{l:Landmark,r:Landmark}} hips    Both kinds. Humans: LMs 23/24. Dogs: 80% along long axis ±40% perp.
 * @property {{l:Landmark,r:Landmark}} [shoulders]  Humans only.
 * @property {{l:Landmark,r:Landmark}} [elbows]     Humans only.
 * @property {{l:Landmark,r:Landmark}} [wrists]     Humans only.
 * @property {{l:Landmark,r:Landmark}} [knees]      Humans only.
 * @property {{l:Landmark,r:Landmark}} [ankles]     Humans only.
 * @property {Landmark} [snout]                     Dogs only — small offset past head.
 * @property {Landmark} [tail]                      Dogs only — extends past hips opposite heading.
 * @property {{fl:Landmark,fr:Landmark,bl:Landmark,br:Landmark}} [paws]  Dogs only — front/back × left/right.
 * @property {{x:number,y:number,w:number,h:number}} [bbox]    Dogs only — normalized [0,1] image-space bbox.
 * @property {{x:number,y:number}} [heading]                   Dogs only — unit vector along bbox long axis (head end).
 * @property {Landmark[]|null} raw  Humans: original 33-element MediaPipe array. Dogs: null.
 * @property {number} confidence    Humans: mean visibility across named joints. Dogs: bbox detection score.
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
 * @typedef {Object} AutoPhaseSpec
 * @property {Array<Object<string, number|string|boolean>>} steps
 *           Ordered list of partial param dicts. The topbar `phase` button
 *           applies one step per AUTO_PHASE_SECONDS interval via
 *           core.setParam, so only the keys present in each step are
 *           overwritten — everything else the user dialed in stays. (The
 *           topbar `cycle` button, by contrast, swaps between qfx and is
 *           handled at the page level — it doesn't read this field.)
 */

/**
 * @typedef {Object} QFXModule
 * @property {string} id
 * @property {string} name
 * @property {'canvas2d'|'webgl2'|'three'} contextType
 * @property {ParamSpec[]} params
 * @property {Object<string, Object<string, number|string|boolean>>} [presets]
 * @property {AutoPhaseSpec} [autoPhase]
 *           Declares the topbar `phase` button's behaviour while this quale
 *           is active. Omit if the quale has nothing to phase through — the
 *           button reads "phase n/a" and is disabled.
 * @property {number} [maxDpr]
 *           Optional cap on devicePixelRatio for this quale, applied on top
 *           of the global DPR cap (default 1.5). Heavy fragment shaders
 *           (e.g. raymarchers) can declare 1.0 to halve fragment work on
 *           high-DPI screens. Lower wins.
 * @property {(canvas:HTMLCanvasElement, opts:{ gl?:WebGL2RenderingContext, ctx?:CanvasRenderingContext2D, renderer?:any }) => Promise<QFXInstance>|QFXInstance} create
 */

export {};
