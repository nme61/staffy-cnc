import { describe, expect, it } from 'vitest';
import { CubikoEmulator } from './cubikoEmulator';
import { parseLine, parseStatus } from './parse';
import { CUBIKO } from './profile';
import { GrblSession, type SessionEvent } from './session';
import { prepareGcode, Streamer } from './streamer';

const flush = () => new Promise((r) => setImmediate(r));

/** Advance the pretend machine until `done()` or the time limit. */
async function run(emu: CubikoEmulator, done: () => boolean, maxMs = 3_600_000, step = 200) {
  for (let t = 0; t < maxMs && !done(); t += step) { emu.tick(step); await flush(); }
}

describe('parse', () => {
  it('reads the real Cubiko status line with 4 axes', () => {
    const s = parseStatus('<Idle|MPos:0.000,0.000,0.000,0.000|Bf:35,254|FS:0,0|WCO:0.000,0.000,0.000,0.000>')!;
    expect(s.state).toBe('Idle');
    expect(s.mpos).toHaveLength(4);
    expect(s.buffer).toEqual([35, 254]);
    expect(s.wco).toHaveLength(4);
  });
  it('reads pins and hold sub-state', () => {
    const s = parseStatus('<Hold:0|MPos:1,2,3,0|Bf:35,254|FS:283,0|Pn:XY>')!;
    expect(s.state).toBe('Hold');
    expect(s.subState).toBe(0);
    expect(s.pins).toBe('XY');
    expect(s.feed).toBe(283);
  });
  it('reads settings that carry a comment', () => {
    expect(parseLine('$0=10 (step pulse,usec)')).toEqual({ kind: 'setting', id: 0, value: '10', comment: 'step pulse,usec' });
    expect(parseLine('$130=152.000 (X aixs max travel:mm)')).toMatchObject({ id: 130, value: '152.000' });
    expect(parseLine('$32=0')).toMatchObject({ id: 32, value: '0', comment: null });
  });
  it('spots the welcome line, messages and alarms', () => {
    expect(parseLine("Grbl 1.1f ['$' for help]")).toMatchObject({ kind: 'welcome', version: '1.1f' });
    expect(parseLine('[MSG:Check Limits]')).toEqual({ kind: 'msg', text: 'Check Limits' });
    expect(parseLine('ALARM:1')).toEqual({ kind: 'alarm', code: 1 });
    expect(parseLine('error:22')).toEqual({ kind: 'error', code: 22 });
    expect(parseLine('[OPT:VMZ0L,35,254]')).toEqual({ kind: 'feedback', tag: 'OPT', body: 'VMZ0L,35,254' });
  });
});

describe('streamer', () => {
  it('never has more bytes in flight than the buffer', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `G1X${i}.123Y${i}.456F500`);
    const s = new Streamer(lines, 254);
    let sent = s.fill().length;
    expect(s.bytesInFlight).toBeLessThanOrEqual(254);
    while (!s.done) {
      s.ack();
      sent += s.fill().length;
      expect(s.bytesInFlight).toBeLessThanOrEqual(254);
    }
    expect(sent).toBe(100);
  });
  it('ignores an ok that answers nothing', () => {
    const s = new Streamer(['G0X1'], 254);
    expect(s.ack()).toBeNull();
    expect(s.stray).toBe(1);
  });
  it('cleans G-code', () => {
    const { lines, sourceLine } = prepareGcode('(title)\ng0 x1 y2 ; move\n\n%\nG1 Z-1 F100');
    expect(lines).toEqual(['G0X1Y2', 'G1Z-1F100']);
    expect(sourceLine).toEqual([2, 5]);
  });
});

describe('session with the pretend Cubiko', () => {
  function setup() {
    const emu = new CubikoEmulator();
    const session = new GrblSession(emu, CUBIKO);
    const events: SessionEvent[] = [];
    session.on((e) => { if (e.type !== 'line') events.push(e); });
    return { emu, session, events };
  }

  it('says hello without resetting the machine (Cubiko is silent on connect)', async () => {
    const { emu, session } = setup();
    const st = await session.hello();
    expect(st?.state).toBe('Idle');
    expect(emu.received).toEqual([]); // nothing but '?', which is real-time
    expect(session.serialBufferBytes).toBe(254);
  });

  it('reads all 45 settings, comments stripped', async () => {
    const { session } = setup();
    const settings = await session.readSettings();
    expect(settings.size).toBe(45);
    expect(settings.get(30)).toBe('10000');
    expect(settings.get(130)).toBe('152.000');
  });

  it('streams a 500-line job without ever overflowing the buffer', async () => {
    const { emu, session, events } = setup();
    const lines = ['G21', 'G90', 'G1F800'];
    for (let i = 0; i < 497; i++) lines.push(`G1X${(i % 50) + 0.5}Y${((i * 7) % 40) + 0.25}`);
    session.startJob(lines);
    await run(emu, () => events.some((e) => e.type === 'job-done' || e.type === 'job-stopped'));
    expect(events.find((e) => e.type === 'job-stopped')).toBeUndefined();
    expect(events.some((e) => e.type === 'job-done')).toBe(true);
    expect(emu.overflowed).toBe(false);
    expect(emu.linesExecuted).toBe(500);
  });

  it('proves the pretend machine is strict: a sender assuming a bigger buffer overflows it', async () => {
    const emu = new CubikoEmulator();
    const session = new GrblSession(emu, { ...CUBIKO, rxBufferBytes: 1000 });
    let finished = false;
    session.on((e) => { if (e.type === 'job-done' || e.type === 'job-stopped') finished = true; });
    session.startJob(Array.from({ length: 300 }, (_, i) => `G1X${i % 50}.5Y${i % 40}.25F800`));
    await run(emu, () => finished || emu.overflowed);
    expect(emu.overflowed).toBe(true);
  });

  it('stops the job and ignores stray oks when a limit switch reboots the machine', async () => {
    const { emu, session, events } = setup();
    const lines = Array.from({ length: 200 }, (_, i) => `G1X${i % 100}Y${i % 80}F300`);
    session.startJob(lines);
    await run(emu, () => session.jobFraction > 0.2);
    emu.pressLimit('X');
    await flush(); await flush();
    const stopped = events.find((e) => e.type === 'job-stopped');
    expect(stopped).toMatchObject({ reason: 'machine-reset' });
    expect(events.find((e) => e.type === 'reset')).toMatchObject({ duringJob: true, version: '1.1f' });
    expect(session.jobRunning).toBe(false);
    expect(session.strayOk).toBeGreaterThanOrEqual(2);
    // After release it reboots again and is usable.
    emu.releaseLimit();
    await flush();
    expect((await session.status())?.state).toBe('Idle');
  });

  it('runs commands queued behind each other in order', async () => {
    const { session } = setup();
    const [a, b] = await Promise.all([session.command('$I'), session.command('G0X1')]);
    expect(a.lines.some((l) => l.kind === 'feedback' && l.tag === 'VER')).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('refuses motion while in alarm, and unlocks with $X', async () => {
    const { emu, session } = setup();
    emu.pressLimit('Y'); emu.releaseLimit(); emu.pressLimit('Z');
    await flush();
    const r = await session.command('G0X5');
    expect(r.error).toBe(9);
    expect((await session.command('$X')).ok).toBe(true);
  });
});
