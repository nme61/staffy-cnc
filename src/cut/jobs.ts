// The small jobs Staffy writes itself: tracing the outline, and the practice run in the air.

import type { Bounds } from '../gcode/analyze';
import type { Travel } from '../gcode/fit';

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Trace the job's outer rectangle with the bit parked right at the top, well clear of everything. */
export function outlineLines(b: Bounds, t: Travel, feed = 1200): string[] {
  const [x0, y0] = b.min, [x1, y1] = b.max;
  return [
    `G53G0Z${n(t.z[1] - 1)}`,
    `G0X${n(x0)}Y${n(y0)}`,
    `G1X${n(x1)}Y${n(y0)}F${n(feed)}`,
    `G1X${n(x1)}Y${n(y1)}`,
    `G1X${n(x0)}Y${n(y1)}`,
    `G1X${n(x0)}Y${n(y0)}`,
  ];
}

/**
 * How far to lift the whole job for a practice run in the air, so its deepest cut stays above the
 * material. Null if there isn't enough room above for that.
 * `zeroZ` is the work zero's height in machine coordinates.
 */
export function airRunLift(b: Bounds, zeroZ: number, t: Travel, clearance = 3): number | null {
  const need = Math.max(0, -b.min[2]);
  const room = t.z[1] - (zeroZ + b.max[2]);
  if (room < need + 0.5) return null;
  return Math.min(need + clearance, room);
}

/**
 * The job with the spindle and coolant left off, and with anything that would cancel the lift
 * taken out. It keeps the same number of lines, so progress still matches the file.
 */
export function airRunLines(lines: string[]): string[] {
  return lines.map((l) => {
    if (/G43\.1/.test(l)) return 'M5';
    return l.replace(/G49(?![\d.])/g, '').replace(/M0*[3478](?!\d)/g, '') || 'M5';
  });
}
