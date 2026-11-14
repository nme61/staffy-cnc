// A picture for every step. Simple line drawings in the app's own colours. Original artwork, GPL.

import type { Bounds } from '../gcode/analyze';
import type { Travel } from '../gcode/fit';

const frame = 'w-full max-w-sm mx-auto';
const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** The bed from above, to scale, with the job's footprint. `zero` places it for real; without it, it's a ghost at the front-left. */
export function BedPicture({ travel, bounds, zero, bit }: { travel: Travel; bounds: Bounds | null; zero?: readonly number[] | null; bit?: readonly number[] | null }) {
  const W = travel.x[1] - travel.x[0], H = travel.y[1] - travel.y[0];
  const pad = 14;
  const y = (v: number) => pad + H - (v - travel.y[0]);
  const x = (v: number) => pad + (v - travel.x[0]);
  const z = zero ?? (bounds ? [10 - bounds.min[0], 10 - bounds.min[1]] : [10, 10]);
  const outside = !!bounds && !!zero && (z[0] + bounds.min[0] < travel.x[0] - 0.01 || z[0] + bounds.max[0] > travel.x[1] + 0.01 || z[1] + bounds.min[1] < travel.y[0] - 0.01 || z[1] + bounds.max[1] > travel.y[1] + 0.01);
  return (
    <svg viewBox={`0 0 ${W + pad * 2} ${H + pad * 2 + 14}`} className={`${frame} text-muted`} role="img" aria-label="The machine bed from above">
      <rect x={pad} y={pad} width={W} height={H} rx="4" className="fill-card stroke-line" strokeWidth="1.5" />
      {bounds && (
        <rect
          x={x(z[0] + bounds.min[0])} y={y(z[1] + bounds.max[1])}
          width={Math.max(bounds.max[0] - bounds.min[0], 1)} height={Math.max(bounds.max[1] - bounds.min[1], 1)}
          className={outside ? 'fill-stop/20 stroke-stop' : 'fill-next-soft stroke-next'} strokeWidth="1.5" strokeDasharray={zero ? undefined : '4 3'}
        />
      )}
      {zero && <path d={`M${x(z[0]) - 5} ${y(z[1])}h10M${x(z[0])} ${y(z[1]) - 5}v10`} className="stroke-next" strokeWidth="2" />}
      {bit && <circle cx={x(bit[0])} cy={y(bit[1])} r="3.5" className="fill-stop stroke-white" strokeWidth="1.5" />}
      <text x={pad + W / 2} y={H + pad * 2 + 8} textAnchor="middle" fontSize="9" fill="currentColor">front of the machine</text>
    </svg>
  );
}

/** The bit travelling to the front-left corner and up. */
export function HomePicture() {
  return (
    <svg viewBox="0 0 200 130" className={`${frame} text-ink`} role="img" aria-label="The machine moves to its front-left corner">
      <rect x="20" y="15" width="160" height="95" rx="6" className="fill-card stroke-line" strokeWidth="1.5" />
      <circle cx="130" cy="45" r="6" className="fill-line" />
      <path d="M124 51 L46 92" {...line} strokeDasharray="5 5" className="stroke-next" />
      <path d="M46 92 l12 -1 M46 92 l6 -10" {...line} className="stroke-next" />
      <circle cx="40" cy="95" r="7" className="fill-next" />
      <text x="100" y="124" textAnchor="middle" fontSize="9" className="fill-muted">front of the machine</text>
    </svg>
  );
}

/** A bit held in the collet. */
export function BitPicture() {
  return (
    <svg viewBox="0 0 200 150" className={`${frame} text-ink`} role="img" aria-label="A bit tightened in the spindle">
      <rect x="70" y="8" width="60" height="50" rx="6" className="fill-line/60 stroke-ink" strokeWidth="2" />
      <path d="M78 58 h44 l-8 22 h-28 z" className="fill-card stroke-ink" strokeWidth="2" strokeLinejoin="round" />
      <rect x="94" y="80" width="12" height="40" className="fill-next-soft stroke-next" strokeWidth="2" />
      <path d="M94 120 l6 14 l6 -14" className="fill-next-soft stroke-next" strokeWidth="2" strokeLinejoin="round" />
      <path d="M150 70 h-22 M128 70 l7 -5 M128 70 l7 5" {...line} className="stroke-check" />
      <text x="154" y="73" fontSize="10" className="fill-muted">tight</text>
    </svg>
  );
}

/** Where to put the bit: over the job's zero point. */
export function CornerPicture({ bounds }: { bounds: Bounds }) {
  const w = Math.max(bounds.max[0] - bounds.min[0], 1), h = Math.max(bounds.max[1] - bounds.min[1], 1);
  const s = Math.min(130 / w, 80 / h);
  const left = 100 - (w * s) / 2, top = 70 - (h * s) / 2;
  const zx = left + (0 - bounds.min[0]) * s, zy = top + h * s + bounds.min[1] * s;
  const cx = Math.min(190, Math.max(10, zx)), cy = Math.min(125, Math.max(10, zy));
  return (
    <svg viewBox="0 0 200 135" className={`${frame} text-ink`} role="img" aria-label="Where the bit should be">
      <rect x={left - 12} y={top - 12} width={w * s + 24} height={h * s + 24} rx="4" fill="#c9a67c" opacity="0.45" />
      <rect x={left} y={top} width={w * s} height={h * s} className="fill-next-soft stroke-next" strokeWidth="1.5" strokeDasharray="4 3" />
      <circle cx={cx} cy={cy} r="11" className="fill-none stroke-stop" strokeWidth="2" />
      <path d={`M${cx - 16} ${cy}h32M${cx} ${cy - 16}v32`} className="stroke-stop" strokeWidth="2" />
      <circle cx={cx} cy={cy} r="3" className="fill-stop" />
    </svg>
  );
}

/** The bit just pinching a sheet of paper. */
export function PaperPicture() {
  return (
    <svg viewBox="0 0 200 130" className={`${frame} text-ink`} role="img" aria-label="A bit touching a sheet of paper on the material">
      <rect x="20" y="92" width="160" height="28" rx="3" fill="#c9a67c" opacity="0.6" />
      <path d="M40 90 h120" stroke="currentColor" strokeWidth="3" className="text-card" />
      <path d="M40 90 h120" {...line} strokeWidth="1.5" />
      <rect x="94" y="20" width="12" height="54" className="fill-next-soft stroke-next" strokeWidth="2" />
      <path d="M94 74 l6 14 l6 -14" className="fill-next-soft stroke-next" strokeWidth="2" strokeLinejoin="round" />
      <path d="M150 84 h22 M172 84 l-7 -5 M172 84 l-7 5" {...line} className="stroke-check" />
      <text x="128" y="76" fontSize="10" className="fill-muted">slide the paper</text>
    </svg>
  );
}

/** The probe plate under the bit, with its clip on the bit. */
export function ProbePicture() {
  return (
    <svg viewBox="0 0 200 130" className={`${frame} text-ink`} role="img" aria-label="A probe plate under the bit with a clip on the bit">
      <rect x="20" y="100" width="160" height="22" rx="3" fill="#c9a67c" opacity="0.6" />
      <rect x="72" y="84" width="56" height="16" rx="2" className="fill-line stroke-ink" strokeWidth="2" />
      <rect x="94" y="14" width="12" height="46" className="fill-next-soft stroke-next" strokeWidth="2" />
      <path d="M94 60 l6 14 l6 -14" className="fill-next-soft stroke-next" strokeWidth="2" strokeLinejoin="round" />
      <path d="M106 34 h14 v-6 h14 v12 h-14 v-6" className="fill-stop/30 stroke-stop" strokeWidth="2" strokeLinejoin="round" />
      <path d="M134 34 q30 0 30 30 q0 28 -36 28" {...line} className="stroke-stop" strokeWidth="1.5" />
      <path d="M100 76 v6" {...line} strokeDasharray="2 3" className="stroke-check" />
    </svg>
  );
}

/** Small icons for the safety list. */
export function SafetyIcon({ kind }: { kind: 'glasses' | 'hands' | 'loose' | 'switch' }) {
  const d = {
    glasses: 'M3 11h3a3 3 0 0 1 6 0a3 3 0 0 1 6 0h3 M6 11a3 3 0 1 0 6 0 M12 11a3 3 0 1 0 6 0',
    hands: 'M8 13V6a1.5 1.5 0 0 1 3 0v5V4.5a1.5 1.5 0 0 1 3 0V11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.600-1.500z',
    loose: 'M12 3a4 4 0 0 1 4 4c0 3-4 5-4 5s-4-2-4-5a4 4 0 0 1 4-4z M6 21c0-4 3-6 6-6s6 2 6 6',
    switch: 'M12 3v8 M7 6a7 7 0 1 0 10 0',
  }[kind];
  return (
    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-next-soft text-next">
      <svg width="26" height="26" viewBox="0 0 24 24" {...line}><path d={d} /></svg>
    </span>
  );
}
