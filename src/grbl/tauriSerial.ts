// Serial transport for the Windows app (Tauri). The web view there has no Web Serial, so the
// port is opened by the Rust side (src-tauri/src/lib.rs) and bytes travel as events.
// There is no port chooser: Staffy finds the machine by its USB id.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { MachineProfile } from './profile';
import type { Transport } from './session';

interface PortInfo { name: string; vendor_id: number | null; product_id: number | null; label: string | null }

export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Thrown when no likely machine is plugged in. The message is shown to the user as it is. */
export class NoMachineError extends Error {
  constructor() {
    super('Staffy can’t see the machine. Check the USB cable is plugged in at both ends and the machine is switched on.');
    this.name = 'NoMachineError';
  }
}

export class TauriSerialTransport implements Transport {
  private cb: ((s: string) => void) | null = null;
  private unlisten: UnlistenFn[] = [];
  onDisconnect: (() => void) | null = null;

  private constructor(readonly portName: string) {}

  /** Opens the port whose USB id matches the profile, or the only USB serial port there is. */
  static async pick(profile: MachineProfile): Promise<TauriSerialTransport> {
    const ports = await invoke<PortInfo[]>('serial_list');
    const known = ports.filter((p) => profile.usb.some((u) => u.vendorId === p.vendor_id && u.productId === p.product_id));
    const usb = ports.filter((p) => p.vendor_id !== null);
    const port = known[0] ?? (usb.length === 1 ? usb[0] : undefined);
    if (!port) throw new NoMachineError();
    const t = new TauriSerialTransport(port.name);
    // Listen before opening, so nothing the machine says is missed.
    t.unlisten.push(await listen<string>('serial-data', (e) => t.cb?.(e.payload)));
    t.unlisten.push(await listen('serial-closed', () => t.onDisconnect?.()));
    try {
      await invoke('serial_open', { name: port.name, baud: profile.baudRate });
    } catch (e) {
      t.unlisten.forEach((u) => u());
      throw new Error(String(e));
    }
    return t;
  }

  onData(cb: (s: string) => void) { this.cb = cb; }
  async write(data: string) {
    try { await invoke('serial_write', { data }); } catch { this.onDisconnect?.(); }
  }
  async close() {
    this.onDisconnect = null;
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    try { await invoke('serial_close'); } catch { /* already closed */ }
  }
}
