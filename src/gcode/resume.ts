// Carry on from a line. A job can't just be restarted in the middle: the machine has forgotten
// where the bit should be, how fast to cut and whether the spindle is on. So Staffy replays the
// file up to that line (without moving), then writes a short lead-in that puts everything back.

import { newModal, stepLine, words, type Analysis } from './analyze';

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** A machine in the planner still holds this many moves it has accepted but not made. */
export const BACK_UP_LINES = 40;

/** Words that mean the line's X/Y/Z numbers are already spoken for. */
const EXPLICIT = new Set([0, 1, 2, 3, 4, 10, 28, 30, 38.2, 38.3, 38.4, 38.5, 80, 92]);

/** Where to restart after a stop at `stoppedAt` lines done: a little earlier, so nothing is missed. */
export function resumeLineFor(stoppedAt: number): number {
  return Math.max(0, stoppedAt - BACK_UP_LINES);
}

/**
 * Lines to send to carry on from `from` (an index into `a.lines`).
 * `lead` is how many of them are Staffy's lead-in, so progress can be mapped back to the file.
 */
export function buildResume(a: Analysis, from: number, opts: { plungeFeed?: number; spinUpSeconds?: number } = {}): { lines: string[]; lead: number } {
  if (from <= 0) return { lines: a.lines, lead: 0 };
  const m = newModal();
  for (let i = 0; i < from; i++) stepLine(m, a.lines[i]);
  // If the file hasn't said where the bit is by this line, there is nothing to put back.
  if (!m.known[0] || !m.known[1]) return { lines: a.lines, lead: 0 };

  const u = m.inches ? 25.4 : 1;
  const safeZ = a.bounds ? a.bounds.max[2] : 0;
  const lead: string[] = ['G21', 'G90', `G${m.wcs}`, `G${m.plane}`, 'G94'];
  lead.push(`G0Z${n(safeZ)}`);
  lead.push(`G0X${n(m.pos[0])}Y${n(m.pos[1])}`);
  if (m.spindle !== 5) lead.push(`M${m.spindle}S${n(m.speed)}`, `G4P${opts.spinUpSeconds ?? 3}`);
  if (m.mist) lead.push('M7');
  if (m.flood) lead.push('M8');
  if (m.known[2] && m.pos[2] < safeZ) {
    const feedMm = m.feed * u;
    const plunge = Math.min(feedMm > 0 ? feedMm : Infinity, opts.plungeFeed ?? 150);
    lead.push(`G1Z${n(m.pos[2])}F${n(plunge)}`);
  }
  // Now hand back the file's own way of working.
  if (m.inches) lead.push('G20');
  if (m.feed > 0) lead.push(`F${n(m.feed)}`);
  if (m.inverseTime) lead.push('G93');
  if (!m.absolute) lead.push('G91');

  // The next move may rely on a G0/G1/G2/G3 from an earlier line. Say it out loud.
  const rest = a.lines.slice(from);
  for (let i = 0; i < rest.length; i++) {
    const w = words(rest[i]);
    if (w.v.X === undefined && w.v.Y === undefined && w.v.Z === undefined) continue;
    if (!w.g.some((g) => EXPLICIT.has(g)) && m.motion <= 3) rest[i] = `G${m.motion}${rest[i]}`;
    break;
  }
  return { lines: [...lead, ...rest], lead: lead.length };
}
