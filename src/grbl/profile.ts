// What Staffy knows about a machine. Values for the Cubiko were measured on a real machine
// on 2026-11-14 (docs/hardware/CUBIKO-PROFILE.md); the app re-reads them on connect and
// trusts the machine over this file.

export interface MachineProfile {
  id: string;
  name: string;
  baudRate: number;
  usb: { vendorId: number; productId: number }[];
  /** Usable serial buffer in bytes. Re-measured from `Bf:` on connect. */
  rxBufferBytes: number;
  /** Work area in mm, machine coordinates after homing. */
  travel: { x: [number, number]; y: [number, number]; z: [number, number] };
  homeCorner: 'front-left' | 'front-right' | 'back-left' | 'back-right';
  /** S value that means full spindle speed / laser power ($30). */
  maxSpindleS: number;
  axes: number;
  quirks: {
    /** Opening the port does not reset the board, so there's no welcome message. */
    silentOnConnect: boolean;
    /** Pressing a limit switch reboots the controller instead of sending ALARM:1. */
    rebootsOnLimit: boolean;
    /** The controller prints every setting after each reset. */
    dumpsSettingsOnReset: boolean;
    /** The controller sends `ok` lines that answer nothing (seen with [MSG:Check Limits]). */
    strayOk: boolean;
  };
}

export const CUBIKO: MachineProfile = {
  id: 'genmitsu-cubiko',
  name: 'Genmitsu Cubiko',
  baudRate: 115200,
  usb: [{ vendorId: 0x1a86, productId: 0x7523 }],
  rxBufferBytes: 254,
  travel: { x: [0, 152], y: [0, 113], z: [-39, 0] },
  homeCorner: 'front-left',
  maxSpindleS: 10000,
  axes: 4,
  quirks: { silentOnConnect: true, rebootsOnLimit: true, dumpsSettingsOnReset: true, strayOk: true },
};

/** Safe fallback for any other GRBL 1.1 machine until its real values are read. */
export const GENERIC_GRBL: MachineProfile = {
  id: 'generic-grbl-1.1',
  name: 'GRBL machine',
  baudRate: 115200,
  usb: [],
  rxBufferBytes: 127,
  travel: { x: [0, 100], y: [0, 100], z: [-30, 0] },
  homeCorner: 'back-right',
  maxSpindleS: 1000,
  axes: 3,
  quirks: { silentOnConnect: false, rebootsOnLimit: false, dumpsSettingsOnReset: false, strayOk: false },
};
