import { useCallback, useEffect, useRef, useState } from 'react';
import type { Travel } from '../gcode/fit';
import { CubikoEmulator } from '../grbl/cubikoEmulator';
import type { Status } from '../grbl/parse';
import { CUBIKO } from '../grbl/profile';
import { GrblSession } from '../grbl/session';
import { inTauri, TauriSerialTransport } from '../grbl/tauriSerial';
import { WebSerialTransport, webSerialSupported } from '../grbl/webSerial';

/** Can this copy of Staffy talk to a real machine? Yes in the Windows app, and in Chrome or Edge. */
export const canConnect = () => inTauri() || webSerialSupported();

export type Link =
  | { kind: 'none' }
  | { kind: 'connecting' }
  | { kind: 'connected'; pretend: boolean }
  | { kind: 'failed'; message: string };

export interface Notice { tone: 'info' | 'ok' | 'check' | 'stop'; text: string }

/** Plain-English words for what the machine is doing. */
export function describeState(s: Status | null): { title: string; tone: Notice['tone'] } {
  switch (s?.state) {
    case 'Idle': return { title: 'Ready', tone: 'ok' };
    case 'Run': return { title: 'Cutting', tone: 'info' };
    case 'Jog': return { title: 'Moving', tone: 'info' };
    case 'Hold': return { title: 'Paused', tone: 'check' };
    case 'Home': return { title: 'Finding its home corner…', tone: 'info' };
    case 'Alarm': return { title: 'Needs homing', tone: 'check' };
    case 'Door': return { title: 'Door open', tone: 'check' };
    case 'Sleep': return { title: 'Asleep', tone: 'check' };
    default: return { title: 'Not sure yet', tone: 'info' };
  }
}

/** Alarms after which the machine still knows where it is (a probe that missed or was already touching). */
const HARMLESS_ALARMS = new Set([4, 5]);

export function useMachine() {
  const [link, setLink] = useState<Link>({ kind: 'none' });
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** True once the machine has homed on this connection and hasn't lost its position since. */
  const [homed, setHomed] = useState(false);
  const [homing, setHoming] = useState(false);
  const [travel, setTravel] = useState<Travel>(CUBIKO.travel);
  const session = useRef<GrblSession | null>(null);
  const emulator = useRef<CubikoEmulator | null>(null);
  const transport = useRef<WebSerialTransport | TauriSerialTransport | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkAfterReset = useRef(false);

  const attach = useCallback((s: GrblSession, pretend: boolean) => {
    session.current = s;
    s.on((e) => {
      if (e.type === 'status') {
        setStatus(e.status);
        // After a Stop the machine normally comes back ready. If it comes back locked, it lost its place.
        if (checkAfterReset.current) { checkAfterReset.current = false; if (e.status.state === 'Alarm') setHomed(false); }
      }
      if (e.type === 'reset') {
        if (e.expected) { checkAfterReset.current = true; return; }
        setHomed(false);
        setNotice(e.duringJob
          ? { tone: 'stop', text: 'The machine restarted itself and the job stopped. This usually means a limit switch was hit. Check nothing is in the way, then home the machine.' }
          : { tone: 'check', text: 'The machine restarted. That’s normal after a limit switch is pressed. It needs to find its home corner again.' });
      }
      if (e.type === 'alarm' && !HARMLESS_ALARMS.has(e.code)) { setHomed(false); setNotice({ tone: 'check', text: e.text }); }
    });
    poll.current = setInterval(() => void s.realtime('?'), 250);
    setLink({ kind: 'connected', pretend });
  }, []);

  /** Trust the machine's own travel settings over the profile. Only asked while it is not busy. */
  const learn = useCallback(async (s: GrblSession, first: Status | null) => {
    if (first?.state !== 'Idle' && first?.state !== 'Alarm') return;
    const settings = await s.readSettings();
    const [x, y, z] = [130, 131, 132].map((id) => Number(settings.get(id)));
    if (x > 0 && y > 0 && z > 0) {
      const t: Travel = { x: [0, x], y: [0, y], z: [-z, 0] };
      s.travel = t;
      setTravel(t);
    }
    if (settings.get(13) === '1') setNotice({ tone: 'check', text: 'This machine is set to report in inches. Staffy needs millimetres. Ask for help changing setting $13 to 0.' });
  }, []);

  const connect = useCallback(async (pretend: boolean) => {
    setNotice(null);
    setHomed(false);
    setLink({ kind: 'connecting' });
    try {
      if (pretend) {
        const emu = new CubikoEmulator();
        emu.probeContactZ = -15; // the top of a pretend probe plate
        emu.startRealtime();
        emulator.current = emu;
        const s = new GrblSession(emu, CUBIKO);
        attach(s, true);
        await learn(s, await s.hello());
        return;
      }
      const t = inTauri() ? await TauriSerialTransport.pick(CUBIKO) : await WebSerialTransport.pick(CUBIKO);
      transport.current = t;
      const s = new GrblSession(t, CUBIKO);
      t.onDisconnect = () => {
        s.disconnected();
        if (poll.current) clearInterval(poll.current);
        session.current = null;
        setHomed(false);
        setStatus(null);
        setLink({ kind: 'failed', message: 'The USB cable came out. Plug it back in and connect again.' });
      };
      attach(s, false);
      const hello = await s.hello();
      if (!hello) setNotice({ tone: 'check', text: 'Connected, but the machine isn’t answering. Is it switched on?' });
      await learn(s, hello);
    } catch (e) {
      const err = e as Error;
      setLink(err.name === 'NotFoundError'
        ? { kind: 'none' }
        : err.name === 'NoMachineError' ? { kind: 'failed', message: err.message }
        : { kind: 'failed', message: `Couldn’t open the machine. Close other CNC programs (Candle, UGS, LightBurn) and try again. (${err.message})` });
    }
  }, [attach, learn]);

  const disconnect = useCallback(async () => {
    if (poll.current) clearInterval(poll.current);
    emulator.current?.close();
    await transport.current?.close();
    session.current = emulator.current = transport.current = null;
    setStatus(null);
    setNotice(null);
    setHomed(false);
    setLink({ kind: 'none' });
  }, []);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  const home = useCallback(async () => {
    const s = session.current;
    if (!s) return false;
    setNotice(null);
    setHoming(true);
    const r = await s.command('$H', 90_000);
    const ok = r.ok && (await s.normalise());
    setHoming(false);
    setHomed(ok);
    if (!ok) setNotice({ tone: 'check', text: 'Homing didn’t finish. Check nothing is blocking the machine, then try again.' });
    return ok;
  }, []);

  const unlock = useCallback(async () => { await session.current?.command('$X'); setNotice(null); }, []);
  const stop = useCallback(() => session.current?.stop(), []);

  return { link, status, notice, setNotice, homed, homing, travel, connect, disconnect, home, unlock, stop, session, emulator };
}

export type Machine = ReturnType<typeof useMachine>;
