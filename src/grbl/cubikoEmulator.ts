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

interface Block { target: number[]; durationMs: number; elapsed: number; start: number[] }

export class CubikoEmulator implements Transport {
  private cb: ((s: string) => void) | null = null;
  private rx = '';
  private planner: Block[] = [];
  private pos = [0, 0, 0, 0];
  private feed = 0;
  private modalMotion: 'G0' | 'G1' = 'G0';
  private state: 'Idle' | 'Run' | 'Hold' | 'Alarm' | 'Home' = 'Idle';
  private holding = false;
  private pins = '';
  private reports = 0;
  private homingLeft = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Test hooks */
  overflowed = false;
  linesExecuted = 0;
  received: string[] = [];

  onData(cb: (s: string) => void) { this.cb = cb; }

  private emit(s: string) {
    const cb = this.cb;
    // Deliver asynchronously, like a real serial port, so senders can't recurse into us.
    if (cb) queueMicrotask(() => cb(s));
  }

  write(data: string) {
    for (const ch of data) {
      if (ch === '?') { this.emit(this.statusLine()); continue; }
      if (ch === '!') { if (this.state === 'Run' || this.planner.length) { this.holding = true; this.state = 'Hold'; } continue; }
      if (ch === '~') { if (this.holding) { this.holding = false; this.state = this.planner.length ? 'Run' : 'Idle'; } continue; }
      if (ch === '\x18') { this.reboot(this.state === 'Run' ? 'alarm3' : 'normal'); continue; }
      if (this.rx.length >= RX_SIZE) { this.overflowed = true; continue; } // a real board would corrupt data here
      this.rx += ch;
    }
    this.parseFromRx();
  }

  /** Lines leave the serial buffer only when the planner has room, just like GRBL. */
  private parseFromRx() {
    let i: number;
    while ((i = this.rx.indexOf('\n')) >= 0) {
      if (this.planner.length >= PLANNER_BLOCKS) return;
      const line = this.rx.slice(0, i).trim();
      this.rx = this.rx.slice(i + 1);
      this.received.push(line);
      this.execute(line);
    }
  }

  private execute(line: string) {
    if (this.state === 'Alarm' && line !== '$X' && line !== '$H' && !line.startsWith('$')) { this.emit('error:9\r\n'); return; }
    if (line === '$$') { this.emit(SETTINGS.map(([k, v, c]) => `$${k}=${v} (${c})`).join('\r\n') + '\r\nok\r\n'); return; }
    if (line === '$I') { this.emit('[VER:V43.1.20250416:]\r\n[OPT:VMZ0L,35,254]\r\nok\r\n'); return; }
    if (line === '$X') { this.state = 'Idle'; this.emit('[MSG:Caution: Unlocked]\r\nok\r\n'); return; }
    if (line === '$H') { this.state = 'Home'; this.homingLeft = 2500; return; }
    if (line.startsWith('$')) { this.emit('ok\r\n'); return; }
    this.linesExecuted++;
    const g = /G0*([01])(?!\d)/.exec(line);
    if (g) this.modalMotion = g[1] === '0' ? 'G0' : 'G1';
    const f = /F([\d.]+)/.exec(line);
    if (f) this.feed = Number(f[1]);
    const axes = ['X', 'Y', 'Z'].map((a) => new RegExp(a + '(-?[\\d.]+)').exec(line));
    if (axes.some(Boolean)) {
      const last = this.planner.length ? this.planner[this.planner.length - 1].target : this.pos;
      const target = [...last];
      axes.forEach((m, k) => { if (m) target[k] = Number(m[1]); });
      const dist = Math.hypot(target[0] - last[0], target[1] - last[1], target[2] - last[2]);
      const speed = this.modalMotion === 'G0' ? 2000 : Math.max(this.feed, 1);
      this.planner.push({ start: [...last], target, durationMs: (dist / speed) * 60000, elapsed: 0 });
      if (!this.holding) this.state = 'Run';
    }
    this.emit('ok\r\n');
  }

  tick(ms: number) {
    if (this.state === 'Home') {
      this.homingLeft -= ms;
      if (this.homingLeft <= 0) { this.pos = [0, 0, 0, 0]; this.state = 'Idle'; this.emit('ok\r\n'); }
      return;
    }
    if (this.holding) return;
    let left = ms;
    while (left > 0 && this.planner.length) {
      const b = this.planner[0];
      const need = b.durationMs - b.elapsed;
      const step = Math.min(need, left);
      b.elapsed += step;
      left -= step;
      const t = b.durationMs ? b.elapsed / b.durationMs : 1;
      this.pos = b.start.map((s, k) => s + (b.target[k] - s) * t);
      if (b.elapsed >= b.durationMs) { this.pos = [...b.target]; this.planner.shift(); this.parseFromRx(); }
    }
    if (!this.planner.length && this.state === 'Run') this.state = 'Idle';
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
    this.state = kind === 'normal' ? 'Idle' : 'Alarm';
    let out = "\r\nGrbl 1.1f ['$' for help]\r\n1010 cnc controller\r\nVersion:V43.1\r\n";
    out += SETTINGS.map(([k, v, c]) => `$${k}=${v} (${c})`).join('\r\n') + '\r\n';
    if (kind === 'limit') out += "[MSG:Check Limits]\r\n[MSG:'$H'|'$X' to unlock]\r\n[MSG:Check Limits]\r\nok\r\n[MSG:Check Limits]\r\nok\r\n";
    if (kind === 'alarm3') out += "[MSG:'$H'|'$X' to unlock]\r\n";
    this.emit(out);
  }

  private statusLine() {
    this.reports++;
    const p = this.pos.map((v) => v.toFixed(3)).join(',');
    const free = RX_SIZE - this.rx.length;
    let s = `<${this.state === 'Hold' ? 'Hold:0' : this.state}|MPos:${p}|Bf:${PLANNER_BLOCKS - this.planner.length},${free}|FS:${this.state === 'Run' ? this.feed : 0},0`;
    if (this.pins) s += `|Pn:${this.pins}`;
    if (this.reports % 10 === 0) s += '|WCO:0.000,0.000,0.000,0.000';
    if (this.reports % 10 === 1) s += '|Ov:100,100,100';
    return s + '>\r\n';
  }

  startRealtime(stepMs = 20) {
    if (!this.timer) this.timer = setInterval(() => this.tick(stepMs), stepMs);
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
