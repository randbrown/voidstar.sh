// Arcade — interactive retro-game simulations driven by pose, audio, and the
// entangled crowd. One quale, many cabinets (selected by the `game` param):
//
//   accretion_run  pseudo-3D racer diving toward a black hole (lean to steer)
//   nullmuncher    maze muncher eating null-pointers (lean to turn)
//   void_invaders  fixed shooter; the crowd is the cannon (hands up to fire)
//   voidris        falling blocks (lean to move, raise to rotate)
//
// Every game reads ONE normalized intent (see ./arcade/input.js), so it plays
// identically whether driven by the entangled CROWD (field.crowd — the whole
// audience as one joystick), the PERFORMER's body (field.pose), or a CPU
// attract loop when nobody's present. Audio is wired the declarative way:
// `enemyIntensity` carries bass / beat / crowd.energy modulators, so the world
// gets harder as the music and the room get louder — visible + tunable in the
// param panel.
//
// Rendering: each game draws into a small fixed-resolution "cabinet"
// framebuffer that the engine upscales crisp to the live canvas once per frame
// (see ./arcade/engine.js). That keeps fill cost constant regardless of display
// size — the single biggest perf win here, and authentically retro.
//
// Tier-B (per-phone virtual NES controller + per-player avatars) is a planned
// follow-up; it slots into input.js as a new 'players' surface without games
// changing. See plans/arcade-quale-plan.md.

import { scaleAudio } from '../field.js';
import { createEngine } from './arcade/engine.js';
import { createInput } from './arcade/input.js';
import accretionRun from './arcade/accretion-run.js';
import nullmuncher from './arcade/nullmuncher.js';
import voidInvaders from './arcade/void-invaders.js';
import voidris from './arcade/voidris.js';

const FACTORIES = {
  accretion_run: accretionRun,
  nullmuncher,
  void_invaders: voidInvaders,
  voidris,
};

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'arcade',
  name: 'Arcade',
  contextType: 'canvas2d',

  params: [
    { id: 'game', label: 'game', type: 'select',
      options: ['accretion_run', 'nullmuncher', 'void_invaders', 'voidris'], default: 'accretion_run' },
    // Who drives. 'auto' = the crowd when anyone's entangled, else the
    // performer's camera, else a CPU attract loop. This is the param to expose
    // to phones (whitelist) so the room can pick collective control.
    // 'expert' = pure autopilot, no pose at all — flawless playback. 'auto' is
    // mostly-autopilot with a small pose nudge (so occasional errors are
    // possible); 'crowd'/'performer' hand more control to the room / the body.
    { id: 'controlMode', label: 'control', type: 'select',
      options: ['auto', 'expert', 'crowd', 'performer'], default: 'auto' },
    // Autopilot — how much the sim plays ITSELF while you perform (so your job
    // is to nudge with pose cues, not steer). 0 = you fully control it; 1 = it
    // drives itself and pose only nudges. An entangled crowd always overrides
    // this (they get tight control), so this knob is really "how hands-off am I
    // when it's just me." Default 0.7 = mostly self-driving.
    { id: 'autopilot', label: 'autopilot', type: 'range', min: 0, max: 1, step: 0.05, default: 0.7 },
    // World intensity — enemy speed / spawn / difficulty. Audio + crowd push it
    // (declarative, so the relationship shows in the panel and respects the
    // reactivity master). Drag a modulator pill to 0 to tame it.
    { id: 'enemyIntensity', label: 'intensity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.bass',      mode: 'mul', amount: 0.50 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.40 },
        { source: 'crowd.energy',    mode: 'mul', amount: 0.50 },
      ] },
    // Cabinet pixel chunkiness — higher = bigger pixels (lower virtual res).
    { id: 'pixelScale', label: 'pixels', type: 'range', min: 1, max: 3, step: 0.25, default: 1.6 },
    { id: 'crt', label: 'crt', type: 'toggle', default: true },
    { id: 'hud', label: 'hud', type: 'toggle', default: true },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { game: 'accretion_run' },
      { game: 'nullmuncher' },
      { game: 'void_invaders' },
      { game: 'voidris' },
    ],
  },

  presets: {
    default:       { game: 'accretion_run', controlMode: 'auto' },
    accretion_run: { game: 'accretion_run' },
    nullmuncher:   { game: 'nullmuncher' },
    void_invaders: { game: 'void_invaders' },
    voidris:       { game: 'voidris' },
    crowd:         { game: 'accretion_run', controlMode: 'crowd' },
    chunky:        { pixelScale: 2.5 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    const eng = createEngine(ctx);
    const input = createInput();
    eng.resize(W, H);
    eng.setVirtualHeight(Math.round(300 / 1.6));

    /** @type {Object<string, any>} */
    const games = {};
    let activeId = null, activeGame = null;
    let fpsEMA = 60;
    const scratch = { params: null, intent: null, fps: 60, time: 0, bass: 0, mids: 0, highs: 0, beat: false, source: 'cpu' };

    function ensureGame(id) {
      if (!FACTORIES[id]) id = 'accretion_run';
      if (!games[id]) games[id] = FACTORIES[id](eng);
      if (id !== activeId) {
        activeId = id;
        activeGame = games[id];
        activeGame.reset();
      }
    }
    ensureGame('accretion_run');

    function update(field) {
      const params = field.params;
      const dt = Math.min(0.05, field.dt || 0.016);
      // Virtual resolution from the pixel-chunkiness knob (higher → chunkier).
      eng.setVirtualHeight(Math.round(300 / Math.max(1, params.pixelScale || 1.6)));
      ensureGame(params.game);
      const intent = input.read(field, params);
      const audio = scaleAudio(field.audio, params.reactivity);
      activeGame.update(dt, intent, audio, params);
      scratch.params = params;
      scratch.intent = intent;
      // Diagnostics for the shared HUD strip.
      fpsEMA += (1 / dt - fpsEMA) * 0.08;
      scratch.fps = fpsEMA;
      scratch.time = field.time || 0;
      scratch.bass = audio.bands.bass; scratch.mids = audio.bands.mids; scratch.highs = audio.bands.highs;
      scratch.beat = !!audio.beat.active;
      scratch.source = intent.source;
    }

    // Shared bottom HUD strip — qualia-lab diagnostics in the Outrun dashboard
    // style: fps + session-τ on the left, the live audio bands as a gauge in the
    // centre, and the control source on the right. Drawn for every game (the
    // game owns the top strip with its own stats).
    function drawDiag() {
      const vw = eng.vw, vh = eng.vh, C = eng.C, y = vh - 7;
      eng.hud(3, y, 'FPS', Math.round(scratch.fps), C.amber, 'left');
      const t = scratch.time | 0;
      eng.hud(vw * 0.25, y, 'T', ((t / 60) | 0) + ':' + String(t % 60).padStart(2, '0'), C.cyan, 'left');
      const bw = vw * 0.05, bx = vw * 0.46;
      if (scratch.beat) eng.rect(bx - 4, y, 2, 5, C.white, 1);
      eng.hudBar(bx, y, bw, 5, scratch.bass, C.red, 6);
      eng.hudBar(bx + bw + 2, y, bw, 5, scratch.mids, C.green, 6);
      eng.hudBar(bx + (bw + 2) * 2, y, bw, 5, scratch.highs, C.cyan, 6);
      const src = scratch.source === 'crowd' ? 'CROWD' : scratch.source === 'performer' ? 'YOU'
                : scratch.source === 'expert' ? 'EXPERT' : 'CPU';
      const sc = scratch.source === 'crowd' ? C.magenta : scratch.source === 'performer' ? C.gold
               : scratch.source === 'expert' ? C.green : C.dim;
      eng.textOutline(src, vw - 3, y, sc, 1, 'right');
    }

    function render() {
      if (!activeGame || !scratch.params) {
        ctx.fillStyle = '#05050d';
        ctx.fillRect(0, 0, W, H);
        return;
      }
      activeGame.render(scratch.params, scratch.intent);
      if (scratch.params.hud) drawDiag();
      eng.present({ crt: scratch.params.crt });
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; eng.resize(w, h); },
      update,
      render,
      dispose() {
        for (const id in games) { try { games[id].dispose && games[id].dispose(); } catch {} }
      },
      // test-only: forward the active game's headless probe (if it has one).
      __test: () => (activeGame && activeGame.__test ? activeGame.__test() : null),
    };
  },
};
