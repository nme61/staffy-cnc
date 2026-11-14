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
  | { type: 'reset'; duringJob: boolean; version: string }
  | { type: 'alarm'; code: number; text: string }
  | { type: 'job-progress'; completed: number; total: number }
  | { type: 'job-done' }
  | { type: 'job-stopped'; reason: JobStopReason; atLine: number | null; message: string };

type Listener = (e: SessionEvent) => void;

interface Pending { cmd: string; lines: GrblLine[]; resolve: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> }
export interface CommandResult { ok: boolean; lines: GrblLine[]; error?: number; timedOut?: boolean }

export class GrblSession {
  private split = new LineSplitter();
  private listeners = new Set<Listener>();
  private pending: Pending | null = null;
  private queue: (() => void)[] = [];
  private streamer: Streamer | null = null;
  private statusWaiters: ((s: Status) => void)[] = [];
  private bufferBytes: number;
  lastStatus: Status | null = null;
  /** `ok` lines that answered nothing. Kept for diagnostics. */
  strayOk = 0;

  constructor(private readonly transport: Transport, readonly profile: MachineProfile) {
    this.bufferBytes = profile.rxBufferBytes;
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
        this.emit({ type: 'reset', duringJob, version: line.version });
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
    p.resolve({ ok: last.kind === 'ok', lines: p.lines, error: last.kind === 'error' ? last.code : undefined });
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
  realtime(ch: '?' | '!' | '~' | '\x18') { return this.transport.write(ch); }

  status(timeoutMs = 1000): Promise<Status | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.statusWaiters = this.statusWaiters.filter((f) => f !== done); resolve(null); }, timeoutMs);
      const done = (s: Status) => { clearTimeout(t); resolve(s); };
      this.statusWaiters.push(done);
      this.realtime('?');
    });
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

  /** Stop now: hold (decelerate safely), then reset to clear the buffer. */
  async stop() {
    const running = this.streamer !== null;
    await this.realtime('!');
    await new Promise((r) => setTimeout(r, 250));
    if (running) this.endJob('user', 'Stopped.');
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
