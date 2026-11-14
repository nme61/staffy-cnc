import { useCallback, useEffect, useRef, useState } from 'react';
import { CubikoEmulator } from '../grbl/cubikoEmulator';
import type { Status } from '../grbl/parse';
import { CUBIKO } from '../grbl/profile';
import { GrblSession } from '../grbl/session';
import { WebSerialTransport } from '../grbl/webSerial';

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

export function useMachine() {
  const [link, setLink] = useState<Link>({ kind: 'none' });
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const session = useRef<GrblSession | null>(null);
  const emulator = useRef<CubikoEmulator | null>(null);
  const transport = useRef<WebSerialTransport | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const attach = useCallback((s: GrblSession, pretend: boolean) => {
    session.current = s;
    s.on((e) => {
      if (e.type === 'status') setStatus(e.status);
      if (e.type === 'reset') setNotice(e.duringJob
        ? { tone: 'stop', text: 'The machine restarted itself and the job stopped. This usually means a limit switch was hit. Check nothing is in the way, then home the machine.' }
        : { tone: 'check', text: 'The machine restarted. That’s normal after a limit switch is pressed. Home it before cutting.' });
      if (e.type === 'alarm') setNotice({ tone: 'check', text: e.text });
      if (e.type === 'job-stopped' && e.reason !== 'machine-reset') setNotice({ tone: e.reason === 'user' ? 'info' : 'stop', text: e.message });
      if (e.type === 'job-done') setNotice({ tone: 'ok', text: 'Job finished.' });
    });
    poll.current = setInterval(() => void s.realtime('?'), 250);
    setLink({ kind: 'connected', pretend });
  }, []);

  const connect = useCallback(async (pretend: boolean) => {
    setNotice(null);
    setLink({ kind: 'connecting' });
    try {
      if (pretend) {
        const emu = new CubikoEmulator();
        emu.startRealtime();
        emulator.current = emu;
        const s = new GrblSession(emu, CUBIKO);
        attach(s, true);
        await s.hello();
        return;
      }
      const t = await WebSerialTransport.pick(CUBIKO);
      transport.current = t;
      const s = new GrblSession(t, CUBIKO);
      t.onDisconnect = () => {
        s.disconnected();
        if (poll.current) clearInterval(poll.current);
        setLink({ kind: 'failed', message: 'The USB cable came out. Plug it back in and connect again.' });
      };
      attach(s, false);
      const hello = await s.hello();
      if (!hello) setNotice({ tone: 'check', text: 'Connected, but the machine isn’t answering. Is it switched on?' });
    } catch (e) {
      const err = e as Error;
      setLink(err.name === 'NotFoundError'
        ? { kind: 'none' }
        : { kind: 'failed', message: `Couldn’t open the machine. Close other CNC programs (Candle, UGS, LightBurn) and try again. (${err.message})` });
    }
  }, [attach]);

  const disconnect = useCallback(async () => {
    if (poll.current) clearInterval(poll.current);
    emulator.current?.close();
    await transport.current?.close();
    session.current = emulator.current = transport.current = null;
    setStatus(null);
    setNotice(null);
    setLink({ kind: 'none' });
  }, []);

  useEffect(() => () => { void disconnect(); }, [disconnect]);

  const home = useCallback(async () => {
    setNotice({ tone: 'info', text: 'Homing. Keep hands clear; it moves to the front-left corner.' });
    const r = await session.current?.command('$H', 60_000);
    setNotice(r?.ok ? { tone: 'ok', text: 'Home found. Ready to go.' } : { tone: 'check', text: 'Homing didn’t finish. Check the switches, then try again.' });
  }, []);

  const unlock = useCallback(async () => { await session.current?.command('$X'); setNotice(null); }, []);
  const stop = useCallback(() => session.current?.stop(), []);

  return { link, status, notice, connect, disconnect, home, unlock, stop, session, emulator };
}
