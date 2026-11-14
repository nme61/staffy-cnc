// Everything the Cut walkthrough remembers: the file, which step we're on, where zero is,
// and the job that's running. Lives above the screen so it survives moving between steps
// and a USB cable coming out.

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadGcode, type Analysis } from '../gcode/analyze';
import { checkPlacement, checkSize, type FitProblem } from '../gcode/fit';
import { buildResume, resumeLineFor } from '../gcode/resume';
import { machinePos, type JobStopReason } from '../grbl/session';
import type { Machine, Notice } from '../machine/useMachine';
import { airRunLift, airRunLines, outlineLines } from './jobs';

export type CutStep = 'file' | 'connect' | 'home' | 'bit' | 'clamp' | 'zero' | 'check' | 'safety' | 'run' | 'done' | 'stopped';
/** The eight numbered steps. `run`, `done` and `stopped` come after. */
export const WALK: CutStep[] = ['file', 'connect', 'home', 'bit', 'clamp', 'zero', 'check', 'safety'];

export interface Job { name: string; a: Analysis; id: string }
export interface Run { id: number; mode: 'cut' | 'air' | 'outline'; lead: number; from: number; total: number; done: number; finishing: boolean }
export interface Stopped { at: number; reason: JobStopReason; message: string }
export interface Zero { xy: boolean; z: boolean; wco: number[] | null }

const SAVED = 'staffy.cut.resume';
const PLATE = 'staffy.cut.plate';
/** A sheet of paper is about this thick, so the bit is this far above the material when it drags. */
const PAPER_MM = 0.1;

function hash(lines: string[]): string {
  let h = 2166136261;
  for (const l of lines) { for (let i = 0; i < l.length; i++) h = Math.imul(h ^ l.charCodeAt(i), 16777619); h = Math.imul(h ^ 10, 16777619); }
  return `${lines.length}-${(h >>> 0).toString(16)}`;
}
const store = {
  get<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null; } catch { return null; } },
  set(key: string, v: unknown) { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ } },
};

export function useCutFlow(machine: Machine) {
  const [job, setJob] = useState<Job | null>(null);
  const [step, setStep] = useState<CutStep>('file');
  const [zero, setZero] = useState<Zero>({ xy: false, z: false, wco: null });
  const [run, setRun] = useState<Run | null>(null);
  const [stopped, setStopped] = useState<Stopped | null>(null);
  /** A line to carry on from: after a stop, or remembered from last time for this same file. */
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [checks, setChecks] = useState({ outline: false, air: false });
  const [problems, setProblems] = useState<FitProblem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Notice | null>(null);
  const [plate, setPlateState] = useState<number | null>(() => store.get<number>(PLATE));

  const runRef = useRef<Run | null>(null);
  const jobRef = useRef<Job | null>(null);
  const zeroRef = useRef(zero);
  runRef.current = run;
  jobRef.current = job;
  zeroRef.current = zero;

  const connected = machine.link.kind === 'connected';
  const { session, travel } = machine;

  // ---------- the file ----------
  const open = useCallback((name: string, text: string) => {
    const a = loadGcode(text);
    const j: Job = { name, a, id: hash(a.lines) };
    setJob(j);
    setRun(null);
    setStopped(null);
    setChecks({ outline: false, air: false });
    setProblems([]);
    setMessage(null);
    const saved = store.get<{ id: string; at: number }>(SAVED);
    setResumeAt(saved && saved.id === j.id ? saved.at : null);
    setStep('file');
  }, []);

  const sizeProblems = job?.a.bounds ? checkSize(job.a.bounds, travel) : [];
  const canCut = !!job && !job.a.issues.some((i) => i.level === 'stop') && sizeProblems.length === 0;

  // ---------- which step to show ----------
  const zeroOk = zero.xy && zero.z;
  const order = (s: CutStep) => { const i = WALK.indexOf(s); return i < 0 ? WALK.length : i; };
  let shown: CutStep = step;
  if (run) shown = 'run';
  else if (!job || !canCut) shown = 'file';
  else if (order(step) > order('connect') && !connected) shown = 'connect';
  else if (order(step) > order('home') && !machine.homed) shown = 'home';
  else if (order(step) > order('zero') && !zeroOk) shown = 'zero';

  const next = useCallback(() => setStep((s) => WALK[Math.min(WALK.indexOf(s) + 1, WALK.length - 1)] ?? s), []);
  const back = useCallback(() => { setMessage(null); setStep(() => WALK[Math.max(WALK.indexOf(shown) - 1, 0)]); }, [shown]);
  // Connecting and homing move on by themselves once they're done.
  useEffect(() => { if (step === 'connect' && connected) setStep('home'); }, [step, connected]);
  useEffect(() => { if (step === 'home' && machine.homed) setStep('bit'); }, [step, machine.homed]);

  // ---------- zero ----------
  // After homing again (a restart, or the cable came out), make sure the machine still has the zero we set.
  useEffect(() => {
    if (!machine.homed) return;
    const z = zeroRef.current;
    if (!z.wco || !(z.xy || z.z)) return;
    let live = true;
    void session.current?.workOffset(true).then((now) => {
      if (!live || !now) return;
      const same = z.wco!.slice(0, 3).every((v, k) => Math.abs(v - now[k]) < 0.01);
      if (!same) setZero({ xy: false, z: false, wco: null });
    });
    return () => { live = false; };
  }, [machine.homed, session]);

  const fits = useCallback((wco: number[], axes: boolean[]) => {
    const b = jobRef.current?.a.bounds;
    const p = b ? checkPlacement(b, wco, travel, axes) : [];
    setProblems(p);
    return p.length === 0;
  }, [travel]);

  const jog = useCallback(async (d: { x?: number; y?: number; z?: number }) => {
    const moved = await session.current?.jogBy(d);
    setMessage(moved ? null : { tone: 'info', text: 'That’s as far as the machine can go that way.' });
  }, [session]);

  const setCorner = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    setBusy('Remembering the corner…');
    const wco = await s.setWorkPosition({ x: 0, y: 0 });
    setBusy(null);
    if (!wco) { setMessage({ tone: 'check', text: 'The machine didn’t take that. Wait until it says Ready, then try again.' }); return; }
    setMessage(null);
    setZero({ xy: fits(wco, [true, true, false]), z: false, wco });
  }, [session, fits]);

  const finishHeight = useCallback(async (above: number) => {
    const s = session.current;
    if (!s) return false;
    const wco = await s.setWorkPosition({ z: above });
    if (!wco) { setMessage({ tone: 'check', text: 'The machine didn’t take that. Wait until it says Ready, then try again.' }); return false; }
    // Lift the bit clear. Jogging needs an up-to-date "ready" from the machine first.
    await s.waitFor((st) => st.state === 'Idle', 2000, 50);
    await s.jogBy({ z: 5 });
    const ok = fits(wco, [true, true, true]);
    setZero((z) => ({ ...z, z: ok, wco }));
    return ok;
  }, [session, fits]);

  const setHeightByPaper = useCallback(async () => {
    setBusy('Remembering the height…');
    setMessage(null);
    await finishHeight(PAPER_MM);
    setBusy(null);
  }, [finishHeight]);

  const setPlate = useCallback((mm: number | null) => { setPlateState(mm); store.set(PLATE, mm); }, []);

  const setHeightByProbe = useCallback(async () => {
    const s = session.current;
    const here = machinePos(s?.lastStatus ?? null, s?.wco ?? null);
    if (!s || !here || plate === null) return false;
    setBusy('Lowering the bit onto the plate…');
    setMessage(null);
    const r = await s.probeZ(Math.max(0, here[2] - (travel.z[0] + 0.5)));
    let ok = false;
    if (r.ok) ok = await finishHeight(plate);
    else setMessage({
      tone: 'check',
      text: r.reason === 'already-touching'
        ? 'The probe is already touching. Lift the bit off the plate, then try again.'
        : r.reason === 'no-contact'
          ? 'The bit went down but never felt the plate. Check the plate is under the bit and the clip is on, then try again.'
          : 'Probing didn’t work. You can use a piece of paper instead.',
    });
    setBusy(null);
    return ok;
  }, [session, plate, travel, finishHeight]);

  const clearZero = useCallback(() => { setZero({ xy: false, z: false, wco: null }); setProblems([]); setMessage(null); setStep('zero'); }, []);

  // ---------- running ----------
  /** Read where zero is right now and check the job still fits. Nothing moves unless this passes. */
  const ready = useCallback(async () => {
    const s = session.current;
    if (!s || !jobRef.current) return null;
    if (!(await s.normalise())) { setMessage({ tone: 'check', text: 'The machine isn’t ready. Wait until it says Ready, then try again.' }); return null; }
    const wco = await s.workOffset(true);
    if (!wco || !fits(wco, [true, true, true])) {
      setZero({ xy: false, z: false, wco: null });
      setMessage({ tone: 'check', text: 'The job doesn’t fit where zero is now. Let’s set it again.' });
      setStep('zero');
      return null;
    }
    return { s, wco, a: jobRef.current.a };
  }, [session, fits]);

  // The ref is set straight away: a short job can finish before the screen has drawn again.
  const runId = useRef(0);
  const begin = useCallback((job: Omit<Run, 'id' | 'done' | 'finishing'>) => {
    const r: Run = { ...job, id: ++runId.current, done: 0, finishing: false };
    runRef.current = r;
    setMessage(null);
    setStopped(null);
    setRun(r);
  }, []);

  const start = useCallback(async (from = 0) => {
    const g = await ready();
    if (!g) return;
    const r = buildResume(g.a, from);
    if (from === 0) { store.set(SAVED, null); setResumeAt(null); }
    begin({ mode: 'cut', lead: r.lead, from: r.lead ? from : 0, total: r.lines.length });
    g.s.startJob(r.lines);
  }, [ready, begin]);

  const trace = useCallback(async () => {
    const g = await ready();
    if (!g || !g.a.bounds) return;
    const lines = outlineLines(g.a.bounds, travel);
    begin({ mode: 'outline', lead: 0, from: 0, total: lines.length });
    g.s.startJob(lines);
  }, [ready, begin, travel]);

  const airLift = job?.a.bounds && zero.wco && zeroOk ? airRunLift(job.a.bounds, zero.wco[2], travel) : null;

  const airRun = useCallback(async () => {
    const g = await ready();
    if (!g || !g.a.bounds) return;
    const lift = airRunLift(g.a.bounds, g.wco[2], travel);
    if (lift === null) return;
    // A tool-length offset lifts every move, and the machine forgets it on any reset: zero itself is never touched.
    if (!(await g.s.command(`G43.1Z${lift.toFixed(3)}`)).ok) {
      setMessage({ tone: 'check', text: 'This machine can’t do a practice run in the air. Trace the outline instead.' });
      return;
    }
    const lines = airRunLines(g.a.lines);
    begin({ mode: 'air', lead: 0, from: 0, total: lines.length });
    g.s.startJob(lines);
  }, [ready, begin, travel]);

  const pause = useCallback(() => void session.current?.pause(), [session]);
  const carryOn = useCallback(() => void session.current?.resume(), [session]);
  /** A job ended early. `atLine` counts lines of what was sent, lead-in included. */
  const halted = useCallback((r: Run, reason: JobStopReason, text: string, atLine: number) => {
    if (runRef.current?.id !== r.id) return;
    runRef.current = null;
    setRun(null);
    if (r.mode !== 'cut') {
      setMessage(reason === 'user' ? null : { tone: 'stop', text });
      setStep('check');
      return;
    }
    const at = r.from + Math.max(0, atLine - r.lead);
    const j = jobRef.current;
    const again = reason === 'error' ? null : resumeLineFor(at);
    setStopped({ at, reason, message: reason === 'user' ? 'You stopped the job.' : text });
    setResumeAt(again);
    if (j) store.set(SAVED, again ? { id: j.id, at: again } : null);
    setStep('stopped');
  }, []);
  /** Lines the machine has actually worked through, as best we can tell. Kept for the moment a job stops. */
  const madeRef = useRef(0);

  const stop = useCallback(() => {
    const r = runRef.current;
    if (r?.finishing) halted(r, 'user', '', madeRef.current);
    void session.current?.stop();
  }, [session, halted]);

  // The most free planner slots ever seen is the planner's size: it's empty when that many are free again.
  const plannerSize = useRef(0);
  const freeNow = machine.status?.buffer?.[0] ?? 0;
  if (freeNow > plannerSize.current) plannerSize.current = freeNow;

  // What the machine tells us while a job runs.
  useEffect(() => {
    const s = session.current;
    if (!s) return;
    const off = s.on((e) => {
      const r = runRef.current;
      if (!r) return;
      if (e.type === 'job-progress') setRun((x) => x && { ...x, done: e.completed });
      // Every line has been accepted, but the machine is still working through the last of them.
      if (e.type === 'job-done') {
        setRun((x) => x && { ...x, done: x.total, finishing: true });
        // The job is finished when the last accepted move has actually been made. Only a report asked for
        // now can say so: an older "ready" may have been sent before the machine started moving.
        const mine = () => runRef.current?.id === r.id;
        void s.waitFor((st) => !mine() || (st.state === 'Idle' && (!st.buffer || st.buffer[0] >= plannerSize.current)), 48 * 3600_000, 200).then(() => {
          if (!mine()) return;
          runRef.current = null;
          setRun(null);
          if (r.mode === 'cut') { store.set(SAVED, null); setResumeAt(null); setStep('done'); return; }
          if (r.mode === 'air') void s.normalise();
          setChecks((c) => ({ ...c, [r.mode]: true }));
          setStep('check');
        });
      }
      if (e.type === 'job-stopped') halted(r, e.reason, e.message, e.atLine ?? 0);
      // Once every line is accepted the sender has nothing left to stop, so a restart or alarm in the
      // last stretch has to be caught here, or it would look like the job finished.
      if (r.finishing && e.type === 'reset' && !e.expected) halted(r, 'machine-reset', 'The machine restarted itself, so the job stopped. This usually means a limit switch was hit.', madeRef.current);
      if (r.finishing && e.type === 'alarm') halted(r, 'alarm', e.text, madeRef.current);
    });
    return () => { off(); };
  }, [session, machine.link.kind, halted]);

  // The cable came out during the last stretch of a job.
  useEffect(() => {
    const r = runRef.current;
    if (r?.finishing && !connected) halted(r, 'disconnected', 'The USB cable came out, so the job stopped.', madeRef.current);
  }, [connected, halted]);

  // Keep the screen awake and warn before closing the page while the machine is moving.
  useEffect(() => {
    if (!run) return;
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    const take = () => { void nav.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => { /* not allowed: carry on */ }); };
    const onVisible = () => { if (document.visibilityState === 'visible') take(); };
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    take();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('beforeunload', onLeave);
      void lock?.release();
    };
  }, [run !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- progress ----------
  // Accepted lines run ahead of the bit by whatever is still queued in the machine.
  const free = machine.status?.buffer?.[0] ?? 0;
  let progress = { fileLine: 0, fraction: 0, secondsLeft: 0, segments: 0 };
  if (run && job) {
    const made = Math.max(0, run.done - Math.max(0, plannerSize.current - free));
    madeRef.current = made;
    if (run.mode === 'outline') progress = { fileLine: 0, fraction: run.total ? made / run.total : 0, secondsLeft: 0, segments: 0 };
    else {
      const fileLine = Math.min(job.a.lines.length, run.from + Math.max(0, made - run.lead));
      const t = fileLine > 0 ? job.a.lineTimeEnd[fileLine - 1] : 0;
      const t0 = run.from > 0 ? job.a.lineTimeEnd[run.from - 1] : 0;
      const span = job.a.seconds - t0;
      progress = {
        fileLine,
        fraction: span > 0 ? Math.min(1, Math.max(0, (t - t0) / span)) : 0,
        secondsLeft: Math.max(0, job.a.seconds - t),
        segments: fileLine > 0 ? job.a.lineSegEnd[fileLine - 1] : 0,
      };
    }
  }

  /** Where the bit is over the job, in the file's own coordinates. */
  const mpos = machinePos(machine.status, session.current?.wco ?? null);
  const wco = session.current?.wco ?? zero.wco;
  const bit: [number, number, number] | null = mpos && wco ? [mpos[0] - wco[0], mpos[1] - wco[1], mpos[2] - wco[2]] : null;

  return {
    job, open, sizeProblems, canCut,
    step: shown, go: setStep, next, back,
    zero, zeroOk, problems, jog, setCorner, setHeightByPaper, setHeightByProbe, clearZero, plate, setPlate,
    checks, trace, airRun, airLift,
    run, progress, bit, start, pause, carryOn, stop,
    stopped, resumeAt, setResumeAt,
    busy, message, setMessage,
  };
}

export type CutFlow = ReturnType<typeof useCutFlow>;
