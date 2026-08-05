// syzygy — "matching sound" alignment: find the offset by correlating the
// replacement recording against the video's own audio track.
//
// Two stages, both on onset envelopes (correlate.js):
//   coarse — full streams (capped) decoded at 2 kHz, envelope 50 Hz →
//            offset to ~±20 ms over the entire search range.
//   refine — a ≤90 s window around the match decoded at 8 kHz, envelope
//            250 Hz, ±2.5 s search → few-ms precision. Seek slop on exotic
//            VBR files is absorbed by the ±2.5 s window; a refine that
//            disagrees wildly with the coarse pass is discarded.

import { decodeAudioRaw } from './engine.js';
import { correlatePcm, confidenceLabel, MIN_COARSE_Z, MIN_PEAK_RATIO } from './correlate.js';

/** Only the first N seconds of each stream are analyzed (decode cost cap). */
export const ANALYZE_CAP_S = 1800;

const COARSE_RATE = 2000;
const COARSE_ENV = 50;
const REFINE_RATE = 8000;
const REFINE_ENV = 250;
const REFINE_WINDOW_S = 90;
const REFINE_SEARCH_S = 2.5;

/**
 * @param {import('@ffmpeg/ffmpeg').FFmpeg} ff
 * @param {string} videoPath  staged video input
 * @param {string} audioPath  staged replacement-audio input
 * @param {{videoDur:number, audioDur:number, onStatus?:(msg:string)=>void}} o
 * @returns {Promise<{offset:number, z:number, quality:string, refined:boolean, cappedS:?number}>}
 */
export async function estimateOffsetBySound(ff, videoPath, audioPath, { videoDur, audioDur, onStatus }) {
  const vDur = Math.min(videoDur, ANALYZE_CAP_S);
  const aDur = Math.min(audioDur, ANALYZE_CAP_S);
  const capped = videoDur > ANALYZE_CAP_S || audioDur > ANALYZE_CAP_S;

  onStatus?.('decoding the video’s own audio…');
  const vPcm = await decodeAudioRaw(ff, videoPath, { rate: COARSE_RATE, t: vDur });
  onStatus?.('decoding the replacement audio…');
  const aPcm = await decodeAudioRaw(ff, audioPath, { rate: COARSE_RATE, t: aDur });

  onStatus?.('correlating transients…');
  const coarse = correlatePcm(vPcm, aPcm, COARSE_RATE, { envRate: COARSE_ENV });
  if (!(coarse.z >= MIN_COARSE_Z && coarse.ratio >= MIN_PEAK_RATIO)) {
    throw new Error(`no confident match between the two soundtracks (${coarse.z.toFixed(1)}σ, peak ratio ${coarse.ratio.toFixed(2)}) — try manual alignment`);
  }

  // refine on a window centered in the overlap
  let offset = coarse.lagSec;
  let z = coarse.z;
  let ratio = coarse.ratio;
  let refined = false;
  const ovStart = Math.max(0, offset);
  const ovEnd = Math.min(vDur, offset + aDur);
  const ovDur = ovEnd - ovStart;
  if (ovDur > 3) {
    const w = Math.min(REFINE_WINDOW_S, ovDur);
    const vs = Math.min(Math.max((ovStart + ovEnd) / 2 - w / 2, ovStart), ovEnd - w);
    const as = vs - offset;
    onStatus?.('refining the match…');
    try {
      const vSeg = await decodeAudioRaw(ff, videoPath, { rate: REFINE_RATE, ss: vs, t: w });
      const aSeg = await decodeAudioRaw(ff, audioPath, { rate: REFINE_RATE, ss: as, t: w });
      const fine = correlatePcm(vSeg, aSeg, REFINE_RATE, {
        envRate: REFINE_ENV, minLagSec: -REFINE_SEARCH_S, maxLagSec: REFINE_SEARCH_S,
      });
      if (fine.z >= 4 && Math.abs(fine.lagSec) <= REFINE_SEARCH_S - 0.1) {
        offset += fine.lagSec;
        z = Math.max(z, fine.z);
        ratio = Math.max(ratio, fine.ratio);
        refined = true;
      }
    } catch { /* refine is best-effort; the coarse match stands */ }
  }

  return {
    offset: Math.round(offset * 1000) / 1000,
    z: Math.round(z * 10) / 10,
    quality: confidenceLabel(z, ratio),
    refined,
    cappedS: capped ? ANALYZE_CAP_S : null,
  };
}
