// A pretend Cubiko that behaves like the real one, quirks included (measured 2026-11-14):
// silent on connect, 254-byte serial buffer, 35-block planner, 4 axes, reboots when a limit
// switch is pressed, dumps its settings on every reset, and sends stray `ok`s after a limit reboot.
// Time only moves when tick() is called, so tests are exact. startRealtime() drives it in the browser.

import type { Transport } from './session';

const SETTINGS: [number, string, string][] = [
  [0, '10', 'step pulse,usec'], [1, '255', 'step idle delay,msec'], [2, '0', 'stepport invert mask'],
  [3, '0', 'dirport invert mask'], [4, '0', 'stepenable invert,bool'], [5, '1', 'lims pin invert,bool'],
  [6, '1', 'probe pin invert,bool'], [10, '3', 'status report mask'], [11, '0.010', 'junction deviation'],
  [12, '0.002', 'arc tolerance,mm'], [13, '0', 'report inches,bool'], [20, '0', 'soft limits,bool'],
  [21, '1', 'hard limits,bool'], [22, '1', 'home cycle,bool'], [23, '3', 'homing dir invert mask'],
  [24, '50.000', 'homing feed,mm/min'], [25, '200.000', 'homing seek,mm/min'], [26, '250', 'homing debounce,msec'],
  [27, '1.000', 'homing pull-off,mm'], [30, '10000', 'maximum spindle speed,rpm'], [31, '0', 'minimum spindle speed,rpm'],
  [32, '0', 'laser mode enable,bool'], [40, '0', 'parking enable,bool'], [41, '0', 'use corexy,bool'],
  [42, '0', 'turn off z home,bool'], [43, '148.000', 'probe x in left home'], [44, '109.000', 'probe y in_back home'],
  [45, '2.000', 'probe x in right home'], [46, '1.000', 'probe y in front home'],
  [100, '800.000', 'X axis pulse:step/mm'], [101, '800.000', 'Y axis pulse:step/mm'], [102, '800.000', 'Z axis pulse:step/mm'],
  [103, '177.777', 'A axis pulse:step/mm'], [110, '2000.000', 'X axis max rata:mm/min'], [111, '2000.000', 'Y axis max rata:mm/min'],
  [112, '2000.000', 'Z axis max rata:mm/min'], [113, '2000.000', 'A axis max rata:mm/min'],
  [120, '50.000', 'X axis acceleration:mm/s^2'], [121, '50.000', 'Y axis acceleration:mm/s^2'],
  [122, '50.000', 'Z axis acceleration:mm/s^2'], [123, '50.000', 'A axis acceleration:mm/s^2'],
  [130, '152.000', 'X aixs max travel:mm'], [131, '113.000', 'Y aixs max travel:mm'], [132, '39.000', 'Z aixs max travel:mm'],
  [133, '9999.000', 'A aixs max travel:mm'],
];

const RX_SIZE = 254;
const PLANNER_BLOCKS = 35;

interface Block {
  target: number[]; durationMs: number; elapsed: number; start: number[];
  jog?: boolean;
  /** G38.2 (must touch) or G38.3 (may miss). */
  probe?: 2 | 3;
}

const WORD = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/g;
const G_OK = new Set([0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 28.1, 30, 30.1, 38.2, 38.3, 40, 43.1, 49, 53, 54, 55, 56, 57, 58, 59, 61, 80, 90, 91, 91.1, 92, 92.1, 93, 94]);
const M_OK = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 30]);
const fix = (v: number[]) => v.map((x) => x.toFixed(3)).join(',');

export class CubikoEmulator implements Transport {
  private cb: ((s: string) => void) | null = null;
  private rx = '';
  private planner: Block[] = [];
  private pos = [0, 0, 0, 0];
  private feed = 0;
  private modalMotion = 0;
  private absolute = true;
  private inches = false;
  /** G54 offset (kept across resets, like the real EEPROM), G92 offset and tool length offset. */
  private wcs = [0, 0, 0];
  private g92 = [0, 0, 0];
  private tlo = 0;
  private spindleOn = false;
  private speed = 0;
  private state: 'Idle' | 'Run' | 'Hold' | 'Alarm' | 'Home' | 'Jog' = 'Idle';
  private holding = false;
  private pins = '';
  private reports = 0;
  private wcoDue = false;
  private homingLeft = 0;
  private dwellLeft = 0;
  /** A line that must wait for all earlier moves to finish, like GRBL's buffer sync. */
  private waiting: string | null = null;
  private busy: 'home' | 'probe' | 'dwell' | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Test hooks */
  overflowed = false;
  linesExecuted = 0;
  received: string[] = [];
  /** Lowest and highest machine Z the bit has reached. */
  lowestZ = 0;
  /** True while the spindle has ever been running during a move. */
  cutWithSpindle = false;
  /** startRealtime() runs this many times faster than a real machine. */
  timeScale = 1;

  /** Pretend probe: someone is holding the clip against the plate. */
  probeTouching = false;
  /** Pretend probe: machine Z where the bit meets the plate. Null means no plate under the bit. */
  probeContactZ: number | null = null;

  onData(cb: (s: string) => void) { this.cb = cb; }

  private emit(s: string) {
    const cb = this.cb;
    // Deliver asynchronously, like a real serial port, so senders can't recurse into us.
    if (cb) queueMicrotask(() => cb(s));
  }

  get machinePosition() { return [...this.pos]; }
  /** Nothing moving, nothing waiting to move. */
  get idle() { return this.state === 'Idle' && !this.planner.length && !this.busy && this.waiting === null && !this.rx.includes('\n'); }
  get workOffset() { return [this.wcs[0] + this.g92[0], this.wcs[1] + this.g92[1], this.wcs[2] + this.g92[2] + this.tlo]; }

  write(data: string) {
    for (const ch of data) {
      if (ch === '?') { this.emit(this.statusLine()); continue; }
      if (ch === '!') {
        if (this.state === 'Jog') this.cancelJog();
        else if (this.state === 'Run' || (this.planner.length && this.state !== 'Home')) { this.holding = true; this.state = 'Hold'; }
        continue;
      }
      if (ch === '~') { if (this.holding) { this.holding = false; this.state = this.planner.length ? 'Run' : 'Idle'; } continue; }
      if (ch === '\x85') { this.cancelJog(); continue; }
      if (ch === '\x18') { this.reboot(this.state === 'Run' || this.state === 'Jog' || this.state === 'Home' ? 'alarm3' : 'normal'); continue; }
      if (this.rx.length >= RX_SIZE) { this.overflowed = true; continue; } // a real board would corrupt data here
      this.rx += ch;
    }
    this.parseFromRx();
  }

  private cancelJog() {
    if (this.state !== 'Jog') return;
    this.planner = [];
    this.state = 'Idle';
  }

  /** Lines leave the serial buffer only when the planner has room, just like GRBL. */
  private parseFromRx() {
    for (;;) {
      if (this.busy) return;
      if (this.waiting !== null) {
        if (this.planner.length) return;
        const held = this.waiting;
        this.waiting = null;
        this.execute(held, true);
        continue;
      }
      const i = this.rx.indexOf('\n');
      if (i < 0 || this.planner.length >= PLANNER_BLOCKS) return;
      const line = this.rx.slice(0, i).trim();
      this.rx = this.rx.slice(i + 1);
      this.received.push(line);
      this.execute(line, false);
    }
  }

  private last() { return this.planner.length ? this.planner[this.planner.length - 1].target : this.pos; }

  private probeTriggered() {
    return this.probeTouching || (this.probeContactZ !== null && this.pos[2] <= this.probeContactZ + 1e-6);
  }

  private execute(line: string, synced: boolean) {
    if (this.state === 'Alarm' && !line.startsWith('$')) { this.emit('error:9\r\n'); return; }
    if (line === '$$') { this.emit(SETTINGS.map(([k, v, c]) => `$${k}=${v} (${c})`).join('\r\n') + '\r\nok\r\n'); return; }
    if (line === '$I') { this.emit('[VER:V43.1.20250416:]\r\n[OPT:VMZ0L,35,254]\r\nok\r\n'); return; }
    if (line === '$X') { if (this.state === 'Alarm') this.state = 'Idle'; this.emit('[MSG:Caution: Unlocked]\r\nok\r\n'); return; }
    if (line === '$#') {
      const z = '0.000,0.000,0.000,0.000';
      this.emit(`[G54:${fix([...this.wcs, 0])}]\r\n[G55:${z}]\r\n[G56:${z}]\r\n[G57:${z}]\r\n[G58:${z}]\r\n[G59:${z}]\r\n[G28:${z}]\r\n[G30:${z}]\r\n`
        + `[G92:${fix([...this.g92, 0])}]\r\n[TLO:${this.tlo.toFixed(3)}]\r\n[PRB:${z}:0]\r\nok\r\n`);
      return;
    }
    if (line.startsWith('$J=')) { this.jog(line.slice(3)); return; }

    const needsSync = line === '$H' || /G0*4(?![\d.])|G38/.test(line);
    if (needsSync && !synced && this.planner.length) { this.waiting = line; return; }
    if (line === '$H') { this.state = 'Home'; this.busy = 'home'; this.homingLeft = 2500; return; }
    if (line.startsWith('$')) { this.emit('ok\r\n'); return; }

    this.linesExecuted++;
    const gs: number[] = [];
    const ms: number[] = [];
    const v: Record<string, number | undefined> = {};
    for (const w of line.matchAll(WORD)) {
      const n = Number(w[2]);
      if (w[1] === 'G') gs.push(n); else if (w[1] === 'M') ms.push(n); else v[w[1]] = n;
    }
    if (gs.some((g) => !G_OK.has(g)) || ms.some((m) => !M_OK.has(m))) { this.emit('error:20\r\n'); return; }

    let nonModal: number | null = null;
    let g53 = false;
    let probe: 2 | 3 | null = null;
    for (const g of gs) {
      if (g <= 3) this.modalMotion = g;
      else if (g === 38.2) probe = 2;
      else if (g === 38.3) probe = 3;
      else if (g === 20) this.inches = true;
      else if (g === 21) this.inches = false;
      else if (g === 90) this.absolute = true;
      else if (g === 91) this.absolute = false;
      else if (g === 53) g53 = true;
      else if (g === 49) { this.tlo = 0; this.wcoDue = true; }
      else if (g === 4 || g === 10 || g === 28 || g === 30 || g === 92 || g === 92.1 || g === 43.1) nonModal = g;
    }
    const u = this.inches ? 25.4 : 1;
    if (v.F !== undefined) this.feed = v.F * u;
    if (v.S !== undefined) this.speed = v.S;
    for (const m of ms) { if (m === 3 || m === 4) this.spindleOn = true; else if (m === 5 || m === 2 || m === 30) this.spindleOn = false; }

    const ax = [v.X, v.Y, v.Z];
    const last = this.last();
    const offset = (k: number) => this.wcs[k] + this.g92[k] + (k === 2 ? this.tlo : 0);

    if (nonModal === 4) { this.busy = 'dwell'; this.dwellLeft = (v.P ?? 0) * 1000; return; }
    if (nonModal === 43.1) { this.tlo = (v.Z ?? 0) * u; this.wcoDue = true; this.emit('ok\r\n'); return; }
    if (nonModal === 10) {
      if (v.L !== 2 && v.L !== 20) { this.emit('error:20\r\n'); return; }
      if ((v.P ?? 0) <= 1) {
        ax.forEach((val, k) => {
          if (val === undefined) return;
          this.wcs[k] = v.L === 2 ? val * u : last[k] - this.g92[k] - (k === 2 ? this.tlo : 0) - val * u;
        });
        this.wcoDue = true;
      }
      this.emit('ok\r\n');
      return;
    }
    if (nonModal === 92) {
      ax.forEach((val, k) => { if (val !== undefined) this.g92[k] = last[k] - this.wcs[k] - (k === 2 ? this.tlo : 0) - val * u; });
      this.wcoDue = true;
      this.emit('ok\r\n');
      return;
    }
    if (nonModal === 92.1) { this.g92 = [0, 0, 0]; this.wcoDue = true; this.emit('ok\r\n'); return; }
    if (nonModal === 28 || nonModal === 30) { this.emit('ok\r\n'); return; }

    if (ax.some((a) => a !== undefined)) {
      const target = [...last];
      ax.forEach((val, k) => {
        if (val === undefined) return;
        target[k] = g53 ? val * u : this.absolute ? val * u + offset(k) : last[k] + val * u;
      });
      const dist = Math.hypot(target[0] - last[0], target[1] - last[1], target[2] - last[2]);
      if (probe) {
        if (this.feed <= 0) { this.emit('error:22\r\n'); return; }
        if (this.probeTriggered()) { this.state = 'Alarm'; this.emit(`ALARM:4\r\n[PRB:${fix(this.pos)}:0]\r\nok\r\n`); return; }
        this.planner.push({ start: [...last], target, durationMs: (dist / this.feed) * 60000, elapsed: 0, probe });
        this.busy = 'probe';
        this.state = 'Run';
        return; // the ok comes when the probe move ends
      }
      if (this.modalMotion !== 0 && this.feed <= 0) { this.emit('error:22\r\n'); return; }
      // Arcs are flown as a straight line to their end point: enough to test the sender.
      const speed = this.modalMotion === 0 ? 2000 : this.feed;
      this.planner.push({ start: [...last], target, durationMs: (dist / speed) * 60000, elapsed: 0 });
      if (!this.holding) this.state = 'Run';
    }
    this.emit('ok\r\n');
  }

  private jog(body: string) {
    if (this.state !== 'Idle' && this.state !== 'Jog') { this.emit('error:8\r\n'); return; }
    const v: Record<string, number | undefined> = {};
    const gs: number[] = [];
    for (const w of body.matchAll(WORD)) { if (w[1] === 'G') gs.push(Number(w[2])); else v[w[1]] = Number(w[2]); }
    if (gs.some((g) => ![20, 21, 53, 90, 91].includes(g))) { this.emit('error:16\r\n'); return; }
    if (v.F === undefined || v.F <= 0) { this.emit('error:22\r\n'); return; }
    const u = gs.includes(20) ? 25.4 : 1;
    const last = this.last();
    const target = [...last];
    [v.X, v.Y, v.Z].forEach((val, k) => {
      if (val === undefined) return;
      target[k] = gs.includes(53) ? val * u
        : gs.includes(91) ? last[k] + val * u
        : val * u + this.wcs[k] + this.g92[k] + (k === 2 ? this.tlo : 0);
    });
    const dist = Math.hypot(target[0] - last[0], target[1] - last[1], target[2] - last[2]);
    this.planner.push({ start: [...last], target, durationMs: (dist / Math.min(v.F * u, 2000)) * 60000, elapsed: 0, jog: true });
    this.state = 'Jog';
    this.emit('ok\r\n');
  }

  tick(ms: number) {
    if (this.busy === 'home') {
      this.homingLeft -= ms;
      if (this.homingLeft <= 0) { this.pos = [0, 0, 0, 0]; this.state = 'Idle'; this.busy = null; this.emit('ok\r\n'); this.parseFromRx(); }
      return;
    }
    if (this.holding) return;
    if (this.busy === 'dwell') {
      this.dwellLeft -= ms;
      if (this.dwellLeft <= 0) { this.busy = null; this.emit('ok\r\n'); this.parseFromRx(); }
      return;
    }
    let left = ms;
    while (left > 0 && this.planner.length) {
      const b = this.planner[0];
      // A probe move ends early where the bit meets the plate.
      let endAt = b.durationMs;
      let touched = false;
      if (b.probe) {
        const z0 = b.start[2], z1 = b.target[2], c = this.probeContactZ;
        if (this.probeTouching) { endAt = b.elapsed; touched = true; }
        else if (c !== null && z0 > c && z1 <= c) { endAt = b.durationMs * ((z0 - c) / (z0 - z1)); touched = true; }
      }
      const step = Math.min(Math.max(endAt - b.elapsed, 0), left);
      b.elapsed += step;
      left -= step;
      const t = b.durationMs ? b.elapsed / b.durationMs : 1;
      this.pos = b.start.map((s, k) => s + (b.target[k] - s) * t);
      this.lowestZ = Math.min(this.lowestZ, this.pos[2]);
      if (this.spindleOn && !b.jog && !b.probe) this.cutWithSpindle = true;
      if (b.elapsed >= endAt) {
        if (!b.probe) this.pos = [...b.target];
        this.planner.shift();
        if (b.probe) {
          this.busy = null;
          if (touched) { this.state = 'Idle'; this.emit(`[PRB:${fix(this.pos)}:1]\r\nok\r\n`); }
          else if (b.probe === 2) { this.state = 'Alarm'; this.emit(`ALARM:5\r\n[PRB:${fix(this.pos)}:0]\r\nok\r\n`); }
          else { this.state = 'Idle'; this.emit(`[PRB:${fix(this.pos)}:0]\r\nok\r\n`); }
        }
        this.parseFromRx();
      }
    }
    if (!this.planner.length && (this.state === 'Run' || this.state === 'Jog')) this.state = 'Idle';
  }

  /** The real board reboots the moment a limit switch closes. */
  pressLimit(axis: 'X' | 'Y' | 'Z') {
    this.pins = axis;
    this.reboot('limit');
  }
  releaseLimit() {
    this.pins = '';
    this.reboot('normal');
  }

  private reboot(kind: 'normal' | 'limit' | 'alarm3') {
    this.rx = '';
    this.planner = [];
    this.holding = false;
    this.waiting = null;
    this.busy = null;
    // A reset forgets G92, the tool length offset and every modal setting. G54 lives in EEPROM and stays.
    this.g92 = [0, 0, 0];
    this.tlo = 0;
    this.absolute = true;
    this.inches = false;
    this.modalMotion = 0;
    this.feed = 0;
    this.spindleOn = false;
    this.wcoDue = true;
    this.state = kind === 'normal' ? 'Idle' : 'Alarm';
    let out = "\r\nGrbl 1.1f ['$' for help]\r\n1010 cnc controller\r\nVersion:V43.1\r\n";
    out += SETTINGS.map(([k, v, c]) => `$${k}=${v} (${c})`).join('\r\n') + '\r\n';
    if (kind === 'limit') out += "[MSG:Check Limits]\r\n[MSG:'$H'|'$X' to unlock]\r\n[MSG:Check Limits]\r\nok\r\n[MSG:Check Limits]\r\nok\r\n";
    if (kind === 'alarm3') out += "[MSG:'$H'|'$X' to unlock]\r\n";
    this.emit(out);
  }

  private statusLine() {
    this.reports++;
    const free = RX_SIZE - this.rx.length;
    const moving = this.state === 'Run' || this.state === 'Jog';
    let s = `<${this.state === 'Hold' ? 'Hold:0' : this.state}|MPos:${fix(this.pos)}|Bf:${PLANNER_BLOCKS - this.planner.length},${free}|FS:${moving ? Math.round(this.feed) : 0},${this.spindleOn ? this.speed : 0}`;
    const pins = (this.probeTriggered() ? 'P' : '') + this.pins;
    if (pins) s += `|Pn:${pins}`;
    if (this.reports % 10 === 0 || this.wcoDue) { s += `|WCO:${fix([...this.workOffset, 0])}`; this.wcoDue = false; }
    else if (this.reports % 10 === 1) s += '|Ov:100,100,100';
    return s + '>\r\n';
  }

  startRealtime(stepMs = 20) {
    if (!this.timer) this.timer = setInterval(() => this.tick(stepMs * this.timeScale), stepMs);
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
