// Reads a G-code file the way GRBL would, without moving anything: where the bit goes,
// how big the job is, how long it takes, and what could go wrong before it starts.
// Positions are work coordinates in mm, whatever units the file uses.

import { prepareGcode } from '../grbl/streamer';

export interface Issue { level: 'stop' | 'check' | 'info'; text: string }
export interface Bounds { min: [number, number, number]; max: [number, number, number] }

export interface Analysis {
  /** Clean lines, exactly as they will be sent. */
  lines: string[];
  /** Line number in the original file for each clean line. */
  sourceLine: number[];
  /** Straight moves, 6 numbers each: x0,y0,z0,x1,y1,z1. Arcs are cut into short straights. */
  seg: Float32Array;
  /** 1 = cutting move, 0 = rapid move, one per segment. */
  segCut: Uint8Array;
  /** How many segments are finished once line i is done. */
  lineSegEnd: Uint32Array;
  /** Seconds from the start once line i is done. */
  lineTimeEnd: Float32Array;
  bounds: Bounds | null;
  seconds: number;
  /** True if the file switches the spindle (or laser) on. */
  spindle: boolean;
  issues: Issue[];
}

export interface Modal {
  /** 0–3, 38 (probing) or 80 (none). */
  motion: number;
  absolute: boolean;
  inches: boolean;
  plane: 17 | 18 | 19;
  /** Feed in the file's own units per minute. */
  feed: number;
  inverseTime: boolean;
  spindle: 3 | 4 | 5;
  speed: number;
  mist: boolean;
  flood: boolean;
  wcs: number;
  pos: [number, number, number];
  /** Axes whose position the file has stated so far. */
  known: [boolean, boolean, boolean];
}

export const newModal = (): Modal => ({
  motion: 0, absolute: true, inches: false, plane: 17, feed: 0, inverseTime: false,
  spindle: 5, speed: 0, mist: false, flood: false, wcs: 54, pos: [0, 0, 0], known: [false, false, false],
});

const WORD = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/g;
const KNOWN_G = new Set([0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 28.1, 30, 30.1, 38.2, 38.3, 38.4, 38.5, 40, 43.1, 49,
  53, 54, 55, 56, 57, 58, 59, 61, 80, 90, 91, 91.1, 92, 92.1, 93, 94]);
const KNOWN_M = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 30]);
/** GRBL's line buffer is 80 characters. */
export const MAX_LINE = 79;
const ARC_TOLERANCE = 0.01;

export interface Words { g: number[]; m: number[]; v: Record<string, number | undefined> }

export function words(line: string): Words {
  const out: Words = { g: [], m: [], v: {} };
  for (const w of line.matchAll(WORD)) {
    const n = Number(w[2]);
    if (w[1] === 'G') out.g.push(n);
    else if (w[1] === 'M') out.m.push(n);
    else out.v[w[1]] = n;
  }
  return out;
}

export interface Sink {
  seg?(from: readonly number[], to: readonly number[], cut: boolean): void;
  note?(code: string): void;
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** Points along an arc, end point included. Null when the arc can't be worked out. */
function arcPoints(from: number[], to: number[], plane: 17 | 18 | 19, cw: boolean, w: Words, u: number): number[][] | null {
  const [a, b, c] = plane === 17 ? [0, 1, 2] : plane === 18 ? [2, 0, 1] : [1, 2, 0];
  let ca: number, cb: number;
  if (w.v.R !== undefined) {
    const r = w.v.R * u;
    const dx = to[a] - from[a], dy = to[b] - from[b];
    const d = Math.hypot(dx, dy);
    if (d === 0) return null;
    let h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
    if (cw) h = -h;
    if (r < 0) h = -h;
    ca = from[a] + dx / 2 - (h * dy) / d;
    cb = from[b] + dy / 2 + (h * dx) / d;
  } else {
    const off = [w.v.I, w.v.J, w.v.K];
    if (off[a] === undefined && off[b] === undefined) return null;
    ca = from[a] + (off[a] ?? 0) * u;
    cb = from[b] + (off[b] ?? 0) * u;
  }
  const r = Math.hypot(from[a] - ca, from[b] - cb);
  if (r < 1e-6) return null;
  const a0 = Math.atan2(from[b] - cb, from[a] - ca);
  let sweep = Math.atan2(to[b] - cb, to[a] - ca) - a0;
  if (cw) { if (sweep >= -1e-7) sweep -= 2 * Math.PI; } else if (sweep <= 1e-7) sweep += 2 * Math.PI;
  const stepAngle = Math.max(2 * Math.acos(Math.max(0, 1 - ARC_TOLERANCE / r)), Math.abs(sweep) / 720, 1e-3);
  // Always land exactly on the left-, right-, front- and back-most points, so the size check is exact.
  const quarter = Math.PI / 2;
  const dir = sweep > 0 ? 1 : -1;
  const stops = [0];
  for (let q = dir > 0 ? Math.ceil(a0 / quarter + 1e-9) : Math.floor(a0 / quarter - 1e-9); ; q += dir) {
    const t = (q * quarter - a0) / sweep;
    if (t >= 1 - 1e-9) break;
    if (t > 1e-9) stops.push(t);
  }
  stops.push(1);
  const pts: number[][] = [];
  for (let s = 1; s < stops.length; s++) {
    const t0 = stops[s - 1], t1 = stops[s];
    const n = Math.max(1, Math.ceil((Math.abs(sweep) * (t1 - t0)) / stepAngle));
    for (let i = 1; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      const p = [0, 0, 0];
      p[a] = ca + r * Math.cos(a0 + sweep * t);
      p[b] = cb + r * Math.sin(a0 + sweep * t);
      p[c] = from[c] + (to[c] - from[c]) * t;
      pts.push(p);
    }
  }
  pts[pts.length - 1] = [...to];
  return pts;
}

/** Applies one clean line to the modal state. Returns the seconds it takes. */
export function stepLine(m: Modal, line: string, sink: Sink = {}, rapid = 2000): number {
  if (line.startsWith('$')) { sink.note?.('dollar'); return 0; }
  const w = words(line);
  let nonModal: number | null = null;
  let g53 = false;
  for (const g of w.g) {
    if (!KNOWN_G.has(g)) { sink.note?.(`unsupported:G${g}`); continue; }
    if (g <= 3) m.motion = g;
    else if (g >= 38 && g < 39) m.motion = 38;
    else if (g === 80) m.motion = 80;
    else if (g === 17 || g === 18 || g === 19) m.plane = g;
    else if (g === 20) m.inches = true;
    else if (g === 21) m.inches = false;
    else if (g === 90) m.absolute = true;
    else if (g === 91) m.absolute = false;
    else if (g === 93) m.inverseTime = true;
    else if (g === 94) m.inverseTime = false;
    else if (g >= 54 && g <= 59) m.wcs = g;
    else if (g === 53) g53 = true;
    else if (g === 4 || g === 10 || g === 28 || g === 30 || g === 28.1 || g === 30.1 || g === 92 || g === 92.1) nonModal = g;
  }
  if (w.v.F !== undefined) m.feed = w.v.F;
  if (w.v.S !== undefined) m.speed = w.v.S;
  for (const code of w.m) {
    if (code === 6) { sink.note?.('toolchange'); continue; }
    if (!KNOWN_M.has(code)) { sink.note?.(`unsupported:M${code}`); continue; }
    if (code === 3 || code === 4) { m.spindle = code; sink.note?.('spindle'); }
    else if (code === 5) m.spindle = 5;
    else if (code === 7) m.mist = true;
    else if (code === 8) m.flood = true;
    else if (code === 9) m.mist = m.flood = false;
    else if (code === 0 || code === 1) sink.note?.('pause');
  }

  const u = m.inches ? 25.4 : 1;
  const ax = [w.v.X, w.v.Y, w.v.Z];
  const hasAxis = ax.some((v) => v !== undefined);
  if (nonModal === 4) return w.v.P ?? 0;
  if (nonModal === 92) {
    sink.note?.('zero');
    ax.forEach((v, k) => { if (v !== undefined) { m.pos[k] = v * u; m.known[k] = true; } });
    return 0;
  }
  if (nonModal === 92.1 || nonModal === 10) { sink.note?.('zero'); return 0; }
  if (nonModal === 28 || nonModal === 30) { sink.note?.('park'); m.known = [false, false, false]; return 0; }
  if (nonModal !== null || !hasAxis) return 0;
  if (m.motion === 80) return 0;
  if (m.motion === 38 || g53) {
    // Probing and machine-coordinate moves end somewhere this file doesn't tell us.
    sink.note?.(g53 ? 'park' : 'probe');
    ax.forEach((v, k) => { if (v !== undefined) m.known[k] = false; });
    return 0;
  }

  // A file that only uses relative moves starts wherever the bit is; call that 0,0,0.
  if (!m.absolute && m.known.includes(false)) { sink.note?.('relative'); m.known = [true, true, true]; }
  const before = [...m.known];
  const from: number[] = [...m.pos];
  const to: number[] = [...m.pos];
  ax.forEach((v, k) => {
    if (v === undefined) return;
    to[k] = m.absolute ? v * u : from[k] + v * u;
    m.known[k] = true;
  });
  // An axis the file hasn't mentioned yet starts wherever the bit happens to be, so don't draw a jump from 0.
  for (let k = 0; k < 3; k++) if (!before[k]) from[k] = to[k];
  const drawable = before[0] && before[1];

  const cut = m.motion !== 0;
  let length = 0;
  const arc = m.motion >= 2 && drawable ? arcPoints(from, to, m.plane, m.motion === 2, w, u) : null;
  if (arc) {
    let p = from;
    for (const q of arc) { length += dist(p, q); sink.seg?.(p, q, true); p = q; }
  } else {
    length = drawable ? dist(from, to) : Math.abs(to[2] - from[2]);
    if (drawable) sink.seg?.(from, to, cut);
  }
  m.pos = [to[0], to[1], to[2]];

  if (!cut) return (length / rapid) * 60;
  if (m.feed <= 0) { sink.note?.('no-feed'); return (length / 500) * 60; }
  return m.inverseTime ? 60 / m.feed : (length / (m.feed * u)) * 60;
}

const mm = (n: number) => (Math.round(n * 10) / 10).toString();

/** Clean a file's text and work out everything the Cut screen needs to know about it. */
export function loadGcode(text: string, rapid = 2000): Analysis {
  const prepared = prepareGcode(text);
  const issues: Issue[] = [];
  const toolChanges = prepared.lines.filter((l) => /M0*6(?!\d)/.test(l)).length;
  let dollars = 0;
  const lines: string[] = [];
  const sourceLine: number[] = [];
  prepared.lines.forEach((raw, i) => {
    let l = raw;
    if (l.startsWith('$')) { dollars++; return; }
    // One tool change means "fit the bit", which the walkthrough already asks for.
    if (toolChanges === 1) l = l.replace(/M0*6(?!\d)/, '');
    if (l) { lines.push(l); sourceLine.push(prepared.sourceLine[i]); }
  });

  const m = newModal();
  const seg: number[] = [];
  const segCut: number[] = [];
  const lineSegEnd = new Uint32Array(lines.length);
  const lineTimeEnd = new Float32Array(lines.length);
  const notes = new Map<string, number>();
  let lineNo = 0;
  let bounds: Bounds | null = null;
  const grow = (p: readonly number[]) => {
    if (!bounds) { bounds = { min: [p[0], p[1], p[2]], max: [p[0], p[1], p[2]] }; return; }
    for (let k = 0; k < 3; k++) { bounds.min[k] = Math.min(bounds.min[k], p[k]); bounds.max[k] = Math.max(bounds.max[k], p[k]); }
  };
  const sink: Sink = {
    seg(from, to, cut) { seg.push(from[0], from[1], from[2], to[0], to[1], to[2]); segCut.push(cut ? 1 : 0); grow(from); grow(to); },
    note(code) { if (!notes.has(code)) notes.set(code, lineNo); },
  };
  let seconds = 0;
  let tooLong = -1;
  lines.forEach((l, i) => {
    lineNo = i;
    if (l.length > MAX_LINE && tooLong < 0) tooLong = i;
    seconds += stepLine(m, l, sink, rapid);
    lineSegEnd[i] = segCut.length;
    lineTimeEnd[i] = seconds;
  });
  // The machine's gentle acceleration makes real jobs a little slower than distance ÷ speed.
  const slow = 1.15;
  for (let i = 0; i < lineTimeEnd.length; i++) lineTimeEnd[i] *= slow;
  seconds *= slow;

  const at = (code: string) => `line ${sourceLine[notes.get(code) ?? 0]}`;
  if (!segCut.length) issues.push({ level: 'stop', text: 'There are no moves in this file, so there is nothing to cut. Is it a G-code file (.nc or .gcode)?' });
  if (toolChanges > 1) issues.push({ level: 'stop', text: `This file needs ${toolChanges} bit changes part-way through. Staffy can’t do that yet. Save one file for each bit and run them one at a time.` });
  for (const code of notes.keys()) {
    if (code.startsWith('unsupported:')) issues.push({ level: 'stop', text: `This file uses a command the machine doesn’t understand (${code.slice(12)}, ${at(code)}). Save it again for a “GRBL” machine.` });
  }
  if (tooLong >= 0) issues.push({ level: 'stop', text: `Line ${sourceLine[tooLong]} is too long for the machine to read. Save the file again with fewer decimal places.` });
  if (notes.has('no-feed')) issues.push({ level: 'stop', text: `The file starts cutting without saying how fast to go (${at('no-feed')}). The machine would refuse it. Save it again with a cutting speed.` });
  if (segCut.length && !notes.has('spindle')) issues.push({ level: 'check', text: 'This file never switches the spindle on. If it’s a milling job, the bit would be dragged through the material without spinning.' });
  if (notes.has('zero')) issues.push({ level: 'check', text: 'This file moves the zero point by itself, so Staffy’s size check and picture may not match what the machine does.' });
  if (notes.has('park')) issues.push({ level: 'check', text: 'This file sends the machine to a fixed parking spot. Staffy can’t check those moves, so watch the first few seconds closely.' });
  if (notes.has('pause')) issues.push({ level: 'info', text: 'This file pauses itself part-way. When it does, press Carry on.' });
  if (toolChanges === 1) issues.push({ level: 'info', text: 'Skipped a tool-change line. Staffy asks you to fit the bit before the job starts instead.' });
  if (dollars) issues.push({ level: 'info', text: 'Skipped machine-setting lines in the file. Staffy never changes machine settings from a file.' });

  return {
    lines, sourceLine,
    seg: Float32Array.from(seg), segCut: Uint8Array.from(segCut),
    lineSegEnd, lineTimeEnd, bounds, seconds,
    spindle: notes.has('spindle'), issues,
  };
}

/** "62 × 40 mm, 3 mm deep" */
export function describeSize(b: Bounds): string {
  const depth = b.min[2] < 0 ? `, ${mm(-b.min[2])} mm deep` : '';
  return `${mm(b.max[0] - b.min[0])} × ${mm(b.max[1] - b.min[1])} mm${depth}`;
}

/** "about 4 minutes" */
export function describeTime(seconds: number): string {
  if (seconds < 50) return 'less than a minute';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `about ${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60), r = mins % 60;
  return `about ${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} min` : ''}`;
}
