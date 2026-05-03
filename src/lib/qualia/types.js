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
 * @property {Object<string,number|string|boolean>} params  Resolved values from the active fx's schema.
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
 * @typedef {Object} QFXModule
 * @property {string} id
 * @property {string} name
 * @property {'canvas2d'|'webgl2'} contextType
 * @property {ParamSpec[]} params
 * @property {Object<string, Object<string, number|string|boolean>>} [presets]
 * @property {(canvas:HTMLCanvasElement, opts:{ gl?:WebGL2RenderingContext, ctx?:CanvasRenderingContext2D }) => Promise<QFXInstance>|QFXInstance} create
 */

export {};
