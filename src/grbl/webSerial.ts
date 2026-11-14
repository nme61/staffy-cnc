// Web Serial transport (Chrome, Edge, ChromeOS). The Windows app will add a Tauri transport
// with the same Transport shape.

import type { MachineProfile } from './profile';
import type { Transport } from './session';

// Minimal typings so we don't depend on a DOM lib that may not ship Web Serial types.
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
interface SerialLike {
  requestPort(o?: { filters?: { usbVendorId: number; usbProductId?: number }[] }): Promise<SerialPortLike>;
  addEventListener(type: 'disconnect', fn: (e: Event) => void): void;
}

export const webSerialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export class WebSerialTransport implements Transport {
  private cb: ((s: string) => void) | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  onDisconnect: (() => void) | null = null;
  info: { usbVendorId?: number; usbProductId?: number } = {};

  private constructor(private port: SerialPortLike) {}

  /** Shows Chrome's device picker. Known machines (by USB id) are listed, but any port can be chosen. */
  static async pick(profile: MachineProfile): Promise<WebSerialTransport> {
    const serial = (navigator as unknown as { serial: SerialLike }).serial;
    const port = await serial.requestPort();
    await port.open({ baudRate: profile.baudRate });
    const t = new WebSerialTransport(port);
    t.info = port.getInfo();
    serial.addEventListener('disconnect', () => t.onDisconnect?.());
    t.writer = port.writable!.getWriter();
    t.reader = (port.readable as ReadableStream<Uint8Array>)
      .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
      .getReader();
    void t.readLoop();
    return t;
  }

  private async readLoop() {
    try {
      for (;;) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        if (value) this.cb?.(value);
      }
    } catch {
      this.onDisconnect?.();
    }
  }

  onData(cb: (s: string) => void) { this.cb = cb; }
  /** One character is one byte. GRBL's jog-cancel is the single byte 0x85, which UTF-8 would turn into two. */
  async write(data: string) { await this.writer?.write(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)); }
  async close() {
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    try { await this.port.close(); } catch { /* already closed */ }
  }
}
