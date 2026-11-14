// Turns raw lines from a GRBL controller into typed messages.
// Written against the real Cubiko (see docs/hardware/CUBIKO-PROFILE.md): settings lines carry
// comments, positions can have 4 axes, and a reboot can arrive at any time.

export type MachineState =
  | 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep' | 'Unknown';

export interface Status {
  state: MachineState;
  /** Sub-state, e.g. Hold:0 → 0. */
  subState: number | null;
  /** Machine position. Length = number of axes the controller reports (Cubiko: 4). */
  mpos: number[] | null;
  /** Work position, when the controller reports it instead of mpos. */
  wpos: number[] | null;
  /** Work coordinate offset, only sent every few reports. */
  wco: number[] | null;
  /** [free planner blocks, free serial bytes] */
  buffer: [number, number] | null;
  feed: number | null;
  spindle: number | null;
  /** Active input pins, e.g. "XZ" or "P". Empty string when none. */
  pins: string;
  /** [feed %, rapid %, spindle %], only sent every few reports. */
  overrides: [number, number, number] | null;
  lineNumber: number | null;
}

export type GrblLine =
  | { kind: 'ok' }
  | { kind: 'error'; code: number }
  | { kind: 'alarm'; code: number }
  | { kind: 'status'; status: Status }
  | { kind: 'welcome'; version: string; text: string }
  | { kind: 'setting'; id: number; value: string; comment: string | null }
  | { kind: 'msg'; text: string }
  | { kind: 'feedback'; tag: string; body: string }
  | { kind: 'other'; text: string };

const STATES: MachineState[] = ['Idle', 'Run', 'Hold', 'Jog', 'Alarm', 'Door', 'Check', 'Home', 'Sleep'];

const nums = (s: string) => s.split(',').map(Number);

export function parseStatus(raw: string): Status | null {
  const m = /^<(.*)>$/.exec(raw.trim());
  if (!m) return null;
  const [head, ...fields] = m[1].split('|');
  const [stateName, sub] = head.split(':');
  const st: Status = {
    state: (STATES as string[]).includes(stateName) ? (stateName as MachineState) : 'Unknown',
    subState: sub !== undefined ? Number(sub) : null,
    mpos: null, wpos: null, wco: null, buffer: null, feed: null, spindle: null,
    pins: '', overrides: null, lineNumber: null,
  };
  for (const f of fields) {
    const i = f.indexOf(':');
    if (i < 0) continue;
    const key = f.slice(0, i);
    const val = f.slice(i + 1);
    switch (key) {
      case 'MPos': st.mpos = nums(val); break;
      case 'WPos': st.wpos = nums(val); break;
      case 'WCO': st.wco = nums(val); break;
      case 'Bf': { const [a, b] = nums(val); st.buffer = [a, b]; break; }
      case 'FS': { const [a, b] = nums(val); st.feed = a; st.spindle = b ?? null; break; }
      case 'F': st.feed = Number(val); break;
      case 'Pn': st.pins = val; break;
      case 'Ov': { const [a, b, c] = nums(val); st.overrides = [a, b, c]; break; }
      case 'Ln': st.lineNumber = Number(val); break;
    }
  }
  return st;
}

export function parseLine(input: string): GrblLine {
  const line = input.replace(/\r/g, '').trim();
  if (line === 'ok') return { kind: 'ok' };
  let m: RegExpExecArray | null;
  if ((m = /^error:(\d+)/i.exec(line))) return { kind: 'error', code: Number(m[1]) };
  if ((m = /^ALARM:(\d+)/i.exec(line))) return { kind: 'alarm', code: Number(m[1]) };
  if (line.startsWith('<')) {
    const status = parseStatus(line);
    if (status) return { kind: 'status', status };
  }
  if ((m = /^Grbl\s+(\S+)/i.exec(line))) return { kind: 'welcome', version: m[1], text: line };
  // "$0=10 (step pulse,usec)" — the Cubiko adds a comment after the value.
  if ((m = /^\$(\d+)=(\S+)(?:\s+\((.*)\))?/.exec(line))) {
    return { kind: 'setting', id: Number(m[1]), value: m[2], comment: m[3] ?? null };
  }
  if ((m = /^\[MSG:(.*)\]$/.exec(line))) return { kind: 'msg', text: m[1] };
  if ((m = /^\[([A-Z0-9]+):(.*)\]$/.exec(line))) return { kind: 'feedback', tag: m[1], body: m[2] };
  return { kind: 'other', text: line };
}

/** Splits a byte stream into lines. Feed it chunks; it returns complete lines. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (line) out.push(line);
    }
    return out;
  }
  reset() { this.buf = ''; }
}

/** Plain-English meaning of GRBL alarm codes, for the "what happened" screen. */
export const ALARM_TEXT: Record<number, string> = {
  1: 'A limit switch was hit while moving. The machine stopped to protect itself.',
  2: 'The job would go outside the machine’s work area.',
  3: 'The machine was reset while it was moving, so its position may be off.',
  4: 'The probe was already touching before probing started.',
  5: 'The probe didn’t touch anything within the search distance.',
  6: 'Homing was interrupted.',
  7: 'The safety door opened during homing.',
  8: 'Homing couldn’t move off the switch. Check the switch.',
  9: 'Homing couldn’t find a switch. Check the switch wiring.',
  10: 'Homing failed on a second switch.',
};

/** Plain-English meaning of the GRBL error codes beginners actually hit. */
export const ERROR_TEXT: Record<number, string> = {
  1: 'A line in the file isn’t valid G-code.',
  2: 'A number in the file is missing or wrong.',
  3: 'The machine didn’t understand a setting command.',
  9: 'The machine is locked (alarm). Home or unlock it first.',
  15: 'A move would go past the machine’s travel limits.',
  20: 'The file uses a command this machine doesn’t support.',
  22: 'The file doesn’t set a feed speed before cutting.',
  24: 'Two commands on one line conflict.',
  33: 'An arc in the file can’t be drawn as written.',
};
