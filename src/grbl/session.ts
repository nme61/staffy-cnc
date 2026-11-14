// One connection to one machine. Turns a byte stream into events the UI can use,
// runs commands one at a time, and streams jobs safely.

import { ALARM_TEXT, ERROR_TEXT, LineSplitter, parseLine, type GrblLine, type Status } from './parse';
import type { MachineProfile } from './profile';
import { Streamer } from './streamer';

export interface Transport {
  write(data: string): Promise<void> | void;
  onData(cb: (chunk: string) => void): void;
  close?(): Promise<void> | void;
}

export type JobStopReason = 'user' | 'machine-reset' | 'alarm' | 'error' | 'disconnected';

export type SessionEvent =
  | { type: 'line'; line: GrblLine; raw: string }
  | { type: 'status'; status: Status }
  /** `expected` is true when Staffy asked for the reset itself (Stop). */
  | { type: 'reset'; duringJob: boolean; version: string; expected: boolean }
  | { type: 'alarm'; code: number; text: string }
  | { type: 'job-progress'; completed: number; total: number }
  | { type: 'job-done' }
  | { type: 'job-stopped'; reason: JobStopReason; atLine: number | null; message: string };

type Listener = (e: SessionEvent) => void;

interface Pending { cmd: string; lines: GrblLine[]; resolve: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> }
export interface CommandResult { ok: boolean; lines: GrblLine[]; error?: number; alarm?: number; timedOut?: boolean }

export type ProbeResult =
  | { ok: true; machineZ: number }
  | { ok: false; reason: 'no-contact' | 'already-touching' | 'failed' };

/** Machine position from a status report, whichever way the controller reports it. */
export function machinePos(s: Status | null, wco: number[] | null): number[] | null {
  if (!s) return null;
  if (s.mpos) return s.mpos;
  if (s.wpos && wco) return s.wpos.map((v, k) => v + (wco[k] ?? 0));
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (v: number) => (Math.round(v * 1000) / 1000).toString();
/** Keep jogs this far from the far ends of travel: there are no switches there to stop a crash. */
const JOG_MARGIN = 0.5;

export class GrblSession {
  private split = new LineSplitter();
  private listeners = new Set<Listener>();
  private pending: Pending | null = null;
  private queue: (() => void)[] = [];
  private streamer: Streamer | null = null;
  private statusWaiters: ((s: Status) => void)[] = [];
  private bufferBytes: number;
  private expectReset = false;
  private jogTarget: number[] | null = null;
  lastStatus: Status | null = null;
  /** Where work zero sits in machine coordinates. Null until the machine has reported it. */
  wco: number[] | null = null;
  /** Work area in machine coordinates. Starts from the profile; replaced by the machine's own $130-$132. */
  travel: MachineProfile['travel'];
  /** `ok` lines that answered nothing. Kept for diagnostics. */
  strayOk = 0;

  constructor(private readonly transport: Transport, readonly profile: MachineProfile) {
    this.bufferBytes = profile.rxBufferBytes;
    this.travel = profile.travel;
    transport.onData((chunk) => this.split.push(chunk).forEach((l) => this.handle(l)));
  }

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(e: SessionEvent) { this.listeners.forEach((fn) => fn(e)); }

  get jobRunning() { return this.streamer !== null; }
  get jobFraction() { return this.streamer?.fraction ?? 0; }
  get serialBufferBytes() { return this.bufferBytes; }

  // ---------- incoming ----------
  private handle(raw: string) {
    const line = parseLine(raw);
    this.emit({ type: 'line', line, raw });

    switch (line.kind) {
      case 'status': {
        this.lastStatus = line.status;
        if (line.status.wco) this.wco = line.status.wco;
        // Learn the real buffer size from the machine while it's idle and empty.
        if (line.status.buffer && line.status.state === 'Idle' && !this.streamer && line.status.buffer[1] > 0) {
          this.bufferBytes = line.status.buffer[1];
        }
        const w = this.statusWaiters; this.statusWaiters = [];
        w.forEach((fn) => fn(line.status));
        this.emit({ type: 'status', status: line.status });
        return;
      }
      case 'welcome': {
        // The controller rebooted. On the Cubiko this happens when a limit switch is pressed.
        const duringJob = this.streamer !== null;
        if (duringJob) this.endJob('machine-reset', 'The machine restarted itself, so the job stopped. This usually means a limit switch was hit.');
        this.failPending('The machine restarted.');
        const expected = this.expectReset;
        this.expectReset = false;
        // A reset forgets G92 and tool-length offsets, so the work offset must be read again.
        this.wco = null;
        this.jogTarget = null;
        this.emit({ type: 'reset', duringJob, version: line.version, expected });
        return;
      }
      case 'alarm': {
        const text = ALARM_TEXT[line.code] ?? `Alarm ${line.code}.`;
        if (this.streamer) this.endJob('alarm', text);
        this.finishPending(line);
        this.emit({ type: 'alarm', code: line.code, text });
        return;
      }
      case 'ok':
      case 'error': {
        if (this.streamer) {
          const index = this.streamer.ack();
          if (index === null) { this.strayOk++; return; }
          if (line.kind === 'error') {
            this.endJob('error', ERROR_TEXT[line.code] ?? `The machine rejected line ${index + 1} (error ${line.code}).`, index);
            // GRBL carries on with whatever is already in its buffer. Don't let it: stop the bit and the spindle.
            void this.halt();
            return;
          }
          this.emit({ type: 'job-progress', completed: this.streamer.completed, total: this.streamer.total });
          if (this.streamer.done) { this.streamer = null; this.emit({ type: 'job-done' }); this.next(); return; }
          this.pump();
          return;
        }
        if (this.pending) { this.finishPending(line); return; }
        this.strayOk++;
        return;
      }
      default:
        // Settings dumps after a reboot arrive unasked; only keep them when a command asked.
        if (this.pending) this.pending.lines.push(line);
    }
  }

  private finishPending(last: GrblLine) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.lines.push(last);
    p.resolve({ ok: last.kind === 'ok', lines: p.lines, error: last.kind === 'error' ? last.code : undefined, alarm: last.kind === 'alarm' ? last.code : undefined });
    this.next();
  }

  private failPending(_why: string) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve({ ok: false, lines: p.lines });
    this.next();
  }

  private next() {
    if (this.pending || this.streamer) return;
    const run = this.queue.shift();
    if (run) run();
  }

  // ---------- outgoing ----------
  /** Real-time commands go straight out, even mid-job. */
  realtime(ch: '?' | '!' | '~' | '\x18' | '\x85') { return this.transport.write(ch); }

  status(timeoutMs = 1000): Promise<Status | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.statusWaiters = this.statusWaiters.filter((f) => f !== done); resolve(null); }, timeoutMs);
      const done = (s: Status) => { clearTimeout(t); resolve(s); };
      this.statusWaiters.push(done);
      this.realtime('?');
    });
  }

  /** Ask for status until `want` is true. Returns null if it never is. */
  async waitFor(want: (s: Status) => boolean, timeoutMs: number, everyMs = 100): Promise<Status | null> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.status(Math.max(everyMs, 200));
      if (s && want(s)) return s;
      if (Date.now() >= end) return null;
      await sleep(everyMs);
    }
  }

  /** Send one line and wait for its ok/error. Queued behind other commands and any running job. */
  command(cmd: string, timeoutMs = 5000): Promise<CommandResult> {
    return new Promise((resolve) => {
      const run = () => {
        this.pending = {
          cmd, lines: [], resolve,
          timer: setTimeout(() => {
            if (this.pending?.cmd !== cmd) return;
            const p = this.pending; this.pending = null;
            resolve({ ok: false, lines: p.lines, timedOut: true });
            this.next();
          }, timeoutMs),
        };
        this.transport.write(cmd + '\n');
      };
      if (this.pending || this.streamer) this.queue.push(run); else run();
    });
  }

  async readSettings(): Promise<Map<number, string>> {
    const r = await this.command('$$');
    const out = new Map<number, string>();
    for (const l of r.lines) if (l.kind === 'setting') out.set(l.id, l.value);
    return out;
  }

  /** Ask, don't reset: the Cubiko may be running a job from its own controller. */
  async hello(): Promise<Status | null> {
    return (await this.status(1500)) ?? (await this.status(1500));
  }

  startJob(lines: string[]) {
    if (this.streamer) throw new Error('A job is already running.');
    if (this.pending) throw new Error('Wait for the current command to finish.');
    this.streamer = new Streamer(lines, this.bufferBytes);
    this.pump();
  }

  private pump() {
    if (!this.streamer) return;
    const batch = this.streamer.fill();
    if (batch.length) this.transport.write(batch.map((b) => b.text + '\n').join(''));
  }

  pause() { return this.realtime('!'); }
  resume() { return this.realtime('~'); }

  /**
   * Put the machine's way of working back to what Staffy's size check assumes: millimetres,
   * absolute positions, the first work zero, and no tool-length offset left over from an air run.
   */
  async normalise(): Promise<boolean> {
    if ((await this.command('G54G17G21G90G94G49')).ok) return true;
    return (await this.command('G54G17G21G90G94')).ok;
  }

  /** Where work zero is, in machine coordinates. `fresh` waits for a new report from the machine. */
  async workOffset(fresh = false, timeoutMs = 4000): Promise<number[] | null> {
    if (fresh) this.wco = null;
    if (this.wco) return this.wco;
    // GRBL only adds WCO to every tenth report or so, and straight after it changes.
    await this.waitFor(() => this.wco !== null, timeoutMs, 40);
    return this.wco;
  }

  /** Make the bit's current position read as these work coordinates (G10 L20: stored in the machine). */
  async setWorkPosition(at: { x?: number; y?: number; z?: number }): Promise<number[] | null> {
    let cmd = 'G10L20P1';
    if (at.x !== undefined) cmd += `X${num(at.x)}`;
    if (at.y !== undefined) cmd += `Y${num(at.y)}`;
    if (at.z !== undefined) cmd += `Z${num(at.z)}`;
    if (!(await this.command(cmd)).ok) return null;
    return this.workOffset(true);
  }

  /**
   * Jog by a distance, in mm. Soft limits are off on the Cubiko, so the target is clamped here.
   * Returns false if there was no room to move at all.
   */
  async jogBy(d: { x?: number; y?: number; z?: number }, feed = 1000): Promise<boolean> {
    const st = this.lastStatus;
    const here = machinePos(st, this.wco);
    if (!st || !here || (st.state !== 'Idle' && st.state !== 'Jog')) return false;
    const base = st.state === 'Jog' && this.jogTarget ? this.jogTarget : here.slice(0, 3);
    const t = this.travel;
    const lim: [number, number][] = [[t.x[0], t.x[1] - JOG_MARGIN], [t.y[0], t.y[1] - JOG_MARGIN], [t.z[0] + JOG_MARGIN, t.z[1]]];
    const want = [d.x ?? 0, d.y ?? 0, d.z ?? 0];
    const target = base.map((v, k) => (want[k] ? Math.min(lim[k][1], Math.max(lim[k][0], v + want[k])) : v));
    let cmd = '$J=G53G21G90';
    let moved = false;
    'XYZ'.split('').forEach((a, k) => {
      if (Math.abs(target[k] - base[k]) < 0.0005) return;
      cmd += `${a}${num(target[k])}`;
      moved = true;
    });
    if (!moved) return false;
    this.jogTarget = target;
    return (await this.command(`${cmd}F${num(feed)}`)).ok;
  }

  jogCancel() { this.jogTarget = null; return this.realtime('\x85'); }

  /**
   * Lower the bit until the touch probe closes, in two passes: quick to find it, slow to measure it.
   * Leaves the bit touching the plate. Never goes lower than `maxDown` mm from where it starts.
   */
  async probeZ(maxDown: number, fast = 100, slow = 25): Promise<ProbeResult> {
    const touch = async (down: number, feed: number): Promise<ProbeResult> => {
      const r = await this.command(`G91G38.2Z-${num(down)}F${num(feed)}`, (down / feed) * 60_000 + 10_000);
      if (r.ok) {
        const prb = r.lines.find((l) => l.kind === 'feedback' && l.tag === 'PRB');
        const z = prb && prb.kind === 'feedback' ? Number(prb.body.split(':')[0].split(',')[2]) : NaN;
        return Number.isFinite(z) ? { ok: true, machineZ: z } : { ok: false, reason: 'failed' };
      }
      return { ok: false, reason: r.alarm === 5 ? 'no-contact' : r.alarm === 4 ? 'already-touching' : 'failed' };
    };
    let result = await touch(maxDown, fast);
    if (result.ok) {
      await this.command('G91G0Z1');
      result = await touch(2, slow);
    }
    if (!result.ok) {
      // A missed probe is an alarm, but the machine still knows where it is. Let its last replies arrive, then unlock.
      await sleep(150);
      const st = await this.status();
      if (st?.state === 'Alarm') await this.command('$X');
    }
    await this.command('G90');
    return result;
  }

  /** Stop now: stop sending, slow down safely, then reset to empty the machine's buffer and stop the spindle. */
  async stop() {
    if (this.streamer) this.endJob('user', 'Stopped.');
    await this.halt();
  }

  private async halt() {
    // A hold is ignored while homing; only a reset stops that.
    if (this.lastStatus?.state !== 'Home') {
      await this.realtime('!');
      // Resetting while the bit is still slowing down loses the position, so wait for the hold to finish.
      await this.waitFor((s) => (s.state === 'Hold' && s.subState === 0) || s.state === 'Idle' || s.state === 'Alarm', 3000, 50);
    }
    this.expectReset = true;
    await this.realtime('\x18');
  }

  /** The transport went away (USB unplugged). */
  disconnected() {
    if (this.streamer) this.endJob('disconnected', 'The USB cable came out, so the job stopped.');
    this.failPending('Disconnected');
  }

  private endJob(reason: JobStopReason, message: string, atLine: number | null = null) {
    const s = this.streamer;
    this.streamer = null;
    this.emit({ type: 'job-stopped', reason, message, atLine: atLine ?? (s ? s.completed : null) });
    this.next();
  }
}
