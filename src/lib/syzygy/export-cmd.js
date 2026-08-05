// syzygy — export the current plan as a native ffmpeg shell script.
//
// The browser does the alignment thinking (offsets, trims, gaps, codec
// matching); a desktop does the heavy lifting. planToScript() takes a Plan
// built by plan.js — with the REAL filenames substituted for staged wasm
// paths — and renders it as a runnable bash script: write-steps become
// heredocs, exec-steps become ffmpeg invocations, and the internal output
// name is swapped for the final one. Pure module, node-tested.

/** Quote a single shell argument (conservative: quote anything non-plain). */
export function shellQuote(arg) {
  return /^[\w./:%+=@,-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {import('./plan.js').Plan} plan  built with real filenames as paths
 * @param {{outName:string, header?:string[]}} o
 * @returns {string} bash script
 */
export function planToScript(plan, { outName, header = [] }) {
  const lines = [
    '#!/usr/bin/env bash',
    '# syzygy — native ffmpeg script for the configured alignment',
    `# strategy: ${plan.strategy}${plan.concatDirect ? ' (direct concat)' : ''}`,
    ...plan.notes.map((n) => `# ${n}`),
    ...header.map((n) => `# ${n}`),
    'set -euo pipefail',
    '',
  ];
  const intermediates = new Set();
  for (const step of plan.steps) {
    lines.push(`# ${step.label}`);
    if (step.kind === 'write') {
      lines.push(`cat > ${shellQuote(step.path)} <<'SYZYGY_EOF'`);
      lines.push(step.text.replace(/\n$/, ''));
      lines.push('SYZYGY_EOF');
      intermediates.add(step.path);
    } else {
      const args = step.args.map((a) => (a === plan.output ? outName : a));
      lines.push(`ffmpeg ${args.map(shellQuote).join(' ')}`);
      const out = step.args[step.args.length - 1];
      if (out && !out.startsWith('-') && out !== plan.output) intermediates.add(out);
    }
    lines.push('');
  }
  if (intermediates.size) {
    lines.push('# clean up intermediates');
    lines.push(`rm -f ${[...intermediates].map(shellQuote).join(' ')}`);
    lines.push('');
  }
  lines.push(`echo "done: ${outName.replace(/"/g, '\\"')}"`);
  return lines.join('\n') + '\n';
}
