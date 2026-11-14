// The Cut walkthrough's machine work, run against the pretend Cubiko: jogging, setting zero,
// probing, stopping, the practice run in the air, and carrying on after the USB cable comes out.

import { describe, expect, it } from 'vitest';
import { loadGcode } from '../gcode/analyze';
import { buildResume, resumeLineFor } from '../gcode/resume';
import { CubikoEmulator } from '../grbl/cubikoEmulator';
import { CUBIKO } from '../grbl/profile';
import { GrblSession, type SessionEvent } from '../grbl/session';
import { airRunLift, airRunLines, outlineLines } from './jobs';
import { sampleGcode } from './sample';

const flush = () => new Promise((r) => setImmediate(r));

function setup() {
  const emu = new CubikoEmulator();
  const session = new GrblSession(emu, CUBIKO);
  const events: SessionEvent[] = [];
  session.on((e) => { if (e.type !== 'line' && e.type !== 'status') events.push(e); });
  return { emu, session, events };
}

/** Run the pretend machine while a session call (which may use real timers) finishes. */
async function drive<T>(emu: CubikoEmulator, work: Promise<T>, stepMs = 50): Promise<T> {
  let done = false;
  void work.finally(() => { done = true; });
  while (!done) { emu.tick(stepMs); await flush(); }
  return work;
}

/** Run the pretend machine until `done()`. */
async function until(emu: CubikoEmulator, done: () => boolean, maxMs = 3_600_000, stepMs = 200) {
  for (let t = 0; t < maxMs && !done(); t += stepMs) { emu.tick(stepMs); await flush(); }
  expect(done()).toBe(true);
}

const finished = (events: SessionEvent[]) => events.some((e) => e.type === 'job-done' || e.type === 'job-stopped');
const near = (a: number[], b: number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 3));

async function jogTo(emu: CubikoEmulator, session: GrblSession, d: { x?: number; y?: number; z?: number }) {
  await session.status();
  const moved = await drive(emu, session.jogBy(d));
  await drive(emu, session.waitFor((s) => s.state === 'Idle', 5000, 1));
  return moved;
}

describe('jogging', () => {
  it('moves by the distance asked', async () => {
    const { emu, session } = setup();
    expect(await jogTo(emu, session, { x: 30, y: 20, z: -5 })).toBe(true);
    near(emu.machinePosition, [30, 20, -5]);
  });

  it('never leaves the work area, because the machine itself would not stop it', async () => {
    const { emu, session } = setup();
    await jogTo(emu, session, { x: 500, y: 500, z: -500 });
    near(emu.machinePosition, [151.5, 112.5, -38.5]);
    // Already at the far end: nothing to do, and nothing is sent.
    const sent = emu.received.length;
    expect(await jogTo(emu, session, { x: 10 })).toBe(false);
    expect(emu.received.length).toBe(sent);
    await jogTo(emu, session, { x: -500, y: -500, z: 500 });
    near(emu.machinePosition, [0, 0, 0]);
  });

  it('adds up quick presses from where the last one will end', async () => {
    const { emu, session } = setup();
    await session.status();
    await session.jogBy({ x: 10 });
    await session.status();
    await session.jogBy({ x: 10 });
    await drive(emu, session.waitFor((s) => s.state === 'Idle', 5000, 1));
    near(emu.machinePosition, [20, 0, 0]);
  });

  it('stops at once when cancelled', async () => {
    const { emu, session } = setup();
    await session.status();
    await session.jogBy({ x: 100 }, 600);
    emu.tick(1000);
    await session.jogCancel();
    emu.tick(5000);
    expect((await session.status())?.state).toBe('Idle');
    near(emu.machinePosition, [10, 0, 0]);
  });
});

describe('setting zero', () => {
  it('makes the corner under the bit X0 Y0 and reads back where that is', async () => {
    const { emu, session } = setup();
    await jogTo(emu, session, { x: 40, y: 25 });
    const wco = await drive(emu, session.setWorkPosition({ x: 0, y: 0 }));
    near(wco!, [40, 25, 0]);
    near(emu.workOffset, [40, 25, 0]);
  });

  it('finds the top of the material with the touch probe', async () => {
    const { emu, session } = setup();
    emu.probeContactZ = -22;
    await jogTo(emu, session, { z: -10 });
    const r = await drive(emu, session.probeZ(20));
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.machineZ).toBeCloseTo(-22, 3);
    // The plate is 15 mm thick, so the bit is 15 mm above the material.
    const wco = await drive(emu, session.setWorkPosition({ z: 15 }));
    expect(wco![2]).toBeCloseTo(-37, 3);
    // Probing uses relative moves; the machine must be back to absolute ones afterwards.
    await drive(emu, session.command('G0Z20'));
    await until(emu, () => emu.machinePosition[2] > -17.01, 60_000, 50);
    expect(emu.machinePosition[2]).toBeCloseTo(-17, 3);
  });

  it('copes when the probe never touches', async () => {
    const { emu, session, events } = setup();
    await jogTo(emu, session, { z: -10 });
    const r = await drive(emu, session.probeZ(5));
    expect(r).toEqual({ ok: false, reason: 'no-contact' });
    expect(events.some((e) => e.type === 'alarm' && e.code === 5)).toBe(true);
    // Unlocked, in step, and still knows where it is.
    expect((await session.status())?.state).toBe('Idle');
    expect(emu.machinePosition[2]).toBeCloseTo(-15, 3);
    expect((await session.command('G0X1')).ok).toBe(true);
    expect((await session.command('$I')).lines.some((l) => l.kind === 'feedback' && l.tag === 'VER')).toBe(true);
  });

  it('refuses to probe when the probe is already touching', async () => {
    const { emu, session } = setup();
    emu.probeTouching = true;
    expect((await session.status())?.pins).toBe('P');
    expect(await drive(emu, session.probeZ(5))).toEqual({ ok: false, reason: 'already-touching' });
    expect(emu.machinePosition[2]).toBe(0);
  });
});

/** A job long enough that the machine can't swallow it whole: 300 passes of a zig-zag, 2 mm deep. */
function zigzag() {
  const out = ['G21 G90', 'G0 Z5', 'M3 S10000', 'G0 X0 Y0', 'G1 Z-2 F100', 'G1 F600'];
  for (let i = 1; i <= 300; i++) out.push(i % 2 ? `X40 Y${i / 10}` : `X0 Y${i / 10}`);
  out.push('G0 Z5', 'M5', 'G0 X0 Y0');
  return loadGcode(out.join('\n'));
}

describe('running a job', () => {
  const coaster = loadGcode(sampleGcode());
  const long = zigzag();

  it('cuts the sample from start to finish', async () => {
    const { emu, session, events } = setup();
    await jogTo(emu, session, { x: 20, y: 20, z: -20 });
    await drive(emu, session.setWorkPosition({ x: 0, y: 0, z: 0 }));
    expect(await drive(emu, session.normalise())).toBe(true);
    session.startJob(coaster.lines);
    await until(emu, () => finished(events));
    expect(events.some((e) => e.type === 'job-done')).toBe(true);
    await until(emu, () => emu.idle);
    near(emu.machinePosition, [20, 20, -15]);
    expect(emu.lowestZ).toBeCloseTo(-21, 3);
    expect(emu.cutWithSpindle).toBe(true);
    expect(emu.overflowed).toBe(false);
  });

  it('stops without losing its place, and says the reset was its own', async () => {
    const { emu, session, events } = setup();
    session.startJob(long.lines);
    await until(emu, () => session.jobFraction > 0.3);
    await drive(emu, session.stop());
    await flush();
    expect(events.find((e) => e.type === 'job-stopped')).toMatchObject({ reason: 'user' });
    expect(events.find((e) => e.type === 'reset')).toMatchObject({ expected: true, duringJob: false });
    expect((await session.status())?.state).toBe('Idle');
    const where = emu.machinePosition;
    emu.tick(10_000);
    expect(emu.machinePosition).toEqual(where);
    expect(emu.linesExecuted).toBeLessThan(long.lines.length);
  });

  it('halts the machine when it rejects a line, instead of letting it run on', async () => {
    const { emu, session, events } = setup();
    const lines = ['G1F300', ...Array.from({ length: 30 }, (_, i) => `G1X${i + 1}`), 'G81X5', ...Array.from({ length: 30 }, (_, i) => `G1Y${i + 1}`)];
    session.startJob(lines);
    await until(emu, () => finished(events));
    expect(events.find((e) => e.type === 'job-stopped')).toMatchObject({ reason: 'error', atLine: 31 });
    await drive(emu, session.waitFor(() => events.some((e) => e.type === 'reset'), 5000, 1));
    expect(events.find((e) => e.type === 'reset')).toMatchObject({ expected: true });
    const where = emu.machinePosition;
    emu.tick(60_000);
    expect(emu.machinePosition).toEqual(where);
    expect(where[1]).toBe(0); // it never reached the moves after the bad line
  });

  it('carries on after the USB cable comes out, and ends in the right place', async () => {
    const { emu, session, events } = setup();
    session.startJob(long.lines);
    await until(emu, () => session.jobFraction > 0.6);
    session.disconnected();
    const stopped = events.find((e) => e.type === 'job-stopped');
    expect(stopped).toMatchObject({ reason: 'disconnected' });
    // The machine finishes what it already had, then sits there.
    await until(emu, () => emu.idle);

    // Plug back in: a new connection to the same machine.
    const again = new GrblSession(emu, CUBIKO);
    const events2: SessionEvent[] = [];
    again.on((e) => { if (e.type !== 'line' && e.type !== 'status') events2.push(e); });
    const from = resumeLineFor(stopped?.type === 'job-stopped' ? stopped.atLine! : 0);
    expect(from).toBeGreaterThan(0);
    const r = buildResume(long, from);
    again.startJob(r.lines);
    await until(emu, () => finished(events2));
    expect(events2.some((e) => e.type === 'job-done')).toBe(true);
    await until(emu, () => emu.idle);
    near(emu.machinePosition, [0, 0, 5]);
    expect(emu.lowestZ).toBeCloseTo(-2, 3);
    expect(emu.cutWithSpindle).toBe(true);
    expect(emu.overflowed).toBe(false);
  });
});

describe('checking before cutting', () => {
  const coaster = loadGcode(sampleGcode());

  it('traces the outline with the bit right at the top', async () => {
    const { emu, session, events } = setup();
    await jogTo(emu, session, { x: 20, y: 30, z: -25 });
    await drive(emu, session.setWorkPosition({ x: 0, y: 0, z: 0 }));
    await drive(emu, session.normalise());
    session.startJob(outlineLines(coaster.bounds!, session.travel));
    await until(emu, () => finished(events));
    await until(emu, () => emu.idle);
    near(emu.machinePosition, [20, 30, -1]);
    expect(emu.cutWithSpindle).toBe(false);
  });

  it('runs the whole job in the air: lifted clear, spindle off, zero untouched afterwards', async () => {
    const { emu, session, events } = setup();
    await jogTo(emu, session, { x: 20, y: 30, z: -25 });
    const zero = await drive(emu, session.setWorkPosition({ x: 0, y: 0, z: 0 }));
    const lift = airRunLift(coaster.bounds!, zero![2], session.travel)!;
    expect(lift).toBe(4); // 1 mm deep + 3 mm clear
    await drive(emu, session.normalise());
    expect((await drive(emu, session.command(`G43.1Z${lift}`))).ok).toBe(true);
    emu.lowestZ = 0;
    const lines = airRunLines(coaster.lines);
    expect(lines).toHaveLength(coaster.lines.length);
    session.startJob(lines);
    await until(emu, () => finished(events));
    expect(events.some((e) => e.type === 'job-done')).toBe(true);
    await until(emu, () => emu.idle);
    // The deepest move stayed 3 mm above the material.
    expect(emu.lowestZ).toBeCloseTo(-25 + 3, 3);
    expect(emu.cutWithSpindle).toBe(false);
    await drive(emu, session.normalise());
    near((await drive(emu, session.workOffset(true)))!, [20, 30, -25]);
  });

  it('won’t offer an air run when there is no room above', () => {
    expect(airRunLift(coaster.bounds!, -5.2, CUBIKO.travel)).toBeNull();
    expect(airRunLift(coaster.bounds!, -8, CUBIKO.travel)).toBe(3);
  });

  it('takes spindle, coolant and offset words out of an air run', () => {
    expect(airRunLines(['M3S10000', 'G0X1M8', 'M30', 'G49G0Z5', 'G43.1Z2', 'M03', 'G1X2F100'])).toEqual(
      ['S10000', 'G0X1', 'M30', 'G0Z5', 'M5', 'M5', 'G1X2F100']);
  });
});
