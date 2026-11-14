// Character-counting streamer: keeps the controller's serial buffer as full as possible
// without ever overflowing it. Pure logic, no I/O, so it is easy to test.
//
// Rules learned from the real Cubiko:
//  - Its buffer is 254 bytes, not GRBL's usual 127. The size is passed in, never hard-coded.
//  - It sends `ok` lines that answer nothing. An `ok` only counts when a line is waiting for one;
//    the session also wipes the streamer when the controller reboots, so stray `ok`s
//    that follow a reboot can never be mistaken for progress.

export interface InFlight { index: number; bytes: number }

/** Strip comments and spaces, upper-case, drop empty lines. Returns [cleanLine, originalIndex]. */
export function prepareGcode(source: string): { lines: string[]; sourceLine: number[] } {
  const lines: string[] = [];
  const sourceLine: number[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const clean = raw
      .replace(/\(.*?\)/g, '')
      .replace(/;.*$/, '')
      .replace(/\s+/g, '')
      .replace(/%/g, '')
      // One character must be one byte, or the buffer count goes wrong. G-code is plain ASCII.
      .replace(/[^\x21-\x7e]/g, '')
      .toUpperCase();
    if (clean) { lines.push(clean); sourceLine.push(i + 1); }
  });
  return { lines, sourceLine };
}

export class Streamer {
  private nextIndex = 0;
  private inFlight: InFlight[] = [];
  private used = 0;
  private acked = 0;
  stray = 0;

  constructor(private readonly lines: string[], private readonly bufferBytes: number) {
    const tooLong = lines.findIndex((l) => l.length + 1 > bufferBytes);
    if (tooLong >= 0) throw new Error(`Line ${tooLong + 1} is longer than the machine's buffer (${bufferBytes} bytes).`);
  }

  /** Lines that fit in the buffer right now. They are marked as sent. */
  fill(): { index: number; text: string }[] {
    const out: { index: number; text: string }[] = [];
    while (this.nextIndex < this.lines.length) {
      const text = this.lines[this.nextIndex];
      const bytes = text.length + 1; // + '\n'
      if (this.used + bytes > this.bufferBytes) break;
      this.inFlight.push({ index: this.nextIndex, bytes });
      this.used += bytes;
      out.push({ index: this.nextIndex, text });
      this.nextIndex++;
    }
    return out;
  }

  /** The controller acknowledged the oldest line. Returns its index, or null for a stray `ok`. */
  ack(): number | null {
    const f = this.inFlight.shift();
    if (!f) { this.stray++; return null; }
    this.used -= f.bytes;
    this.acked++;
    return f.index;
  }

  get bytesInFlight() { return this.used; }
  get linesInFlight() { return this.inFlight.length; }
  get completed() { return this.acked; }
  get total() { return this.lines.length; }
  get done() { return this.acked === this.lines.length; }
  get fraction() { return this.lines.length ? this.acked / this.lines.length : 1; }
}
