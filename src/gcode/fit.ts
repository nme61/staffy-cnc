// Will the job fit? The Cubiko has soft limits switched off ($20=0), so nothing in the machine
// stops a job that is too big. Staffy checks here instead, before anything moves.

import type { Bounds } from './analyze';

export interface Travel { x: [number, number]; y: [number, number]; z: [number, number] }

export interface FitProblem {
  axis: 0 | 1 | 2;
  /** `size`: too big for the machine wherever it is put. `low`/`high`: too far towards that end from this zero. */
  kind: 'size' | 'low' | 'high';
  /** How many mm too far. */
  by: number;
  text: string;
}

const TOLERANCE = 0.01;
const up = (n: number) => (Math.ceil(n * 10 - 1e-6) / 10).toString();
const span = (t: Travel) => [t.x, t.y, t.z];

/** Before zero is known: is the job simply too big for this machine? */
export function checkSize(b: Bounds, t: Travel): FitProblem[] {
  const out: FitProblem[] = [];
  const sizeText = [
    (have: string, room: string) => `The job is ${have} mm wide, but the machine can only move ${room} mm from left to right.`,
    (have: string, room: string) => `The job is ${have} mm from front to back, but the machine can only move ${room} mm that way.`,
    (have: string, room: string) => `The job moves the bit up and down by ${have} mm, but the machine only has ${room} mm.`,
  ];
  span(t).forEach(([lo, hi], k) => {
    const have = b.max[k] - b.min[k];
    const room = hi - lo;
    if (have > room + TOLERANCE) out.push({ axis: k as 0 | 1 | 2, kind: 'size', by: have - room, text: sizeText[k](up(have), up(room)) });
  });
  return out;
}

/**
 * Once zero is set: does every move stay inside the machine?
 * `zero` is where the work zero sits in machine coordinates (GRBL's WCO).
 * `axes` picks which axes to check, because X/Y are set before Z.
 */
export function checkPlacement(b: Bounds, zero: readonly number[], t: Travel, axes: readonly boolean[] = [true, true, true]): FitProblem[] {
  const out: FitProblem[] = [];
  span(t).forEach(([lo, hi], k) => {
    if (!axes[k]) return;
    const low = lo - (zero[k] + b.min[k]);
    const high = zero[k] + b.max[k] - hi;
    const axis = k as 0 | 1 | 2;
    if (low > TOLERANCE) {
      const by = up(low);
      out.push({
        axis, kind: 'low', by: low, text: [
          `The job would go ${by} mm past the left edge of the work area. Move the material at least ${by} mm to the right, then set the corner again.`,
          `The job would go ${by} mm past the front edge of the work area. Move the material at least ${by} mm towards the back, then set the corner again.`,
          `The job cuts ${up(-b.min[2])} mm below the zero point, but from here the bit can only go ${up(Math.max(0, zero[2] - lo))} mm lower. Pull the bit a little further out of the collet, or raise the material, then set the height again.`,
        ][k],
      });
    }
    if (high > TOLERANCE) {
      const by = up(high);
      out.push({
        axis, kind: 'high', by: high, text: [
          `The job would go ${by} mm past the right edge of the work area. Move the material at least ${by} mm to the left, then set the corner again.`,
          `The job would go ${by} mm past the back edge of the work area. Move the material at least ${by} mm towards the front, then set the corner again.`,
          `The file lifts the bit ${up(b.max[2])} mm above the zero point, but there is only ${up(Math.max(0, hi - zero[2]))} mm of room above it. Push the bit a little further into the collet, or use thinner material, then set the height again.`,
        ][k],
      });
    }
  });
  return out;
}
