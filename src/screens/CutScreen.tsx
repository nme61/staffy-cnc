// The Cut walkthrough: eight steps, one obvious button on each, a picture on each,
// then the job itself with Pause and an always-there Stop.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BedPicture, BitPicture, CornerPicture, HomePicture, PaperPicture, ProbePicture, SafetyIcon } from '../cut/pictures';
import { Preview } from '../cut/Preview';
import { SAMPLE_NAME, sampleGcode } from '../cut/sample';
import { WALK, type CutFlow } from '../cut/useCutFlow';
import { describeSize, describeTime } from '../gcode/analyze';
import { inTauri } from '../grbl/tauriSerial';
import { canConnect, describeState, type Machine } from '../machine/useMachine';
import { Button, Card, Choice, Details, Note } from '../ui/kit';
import { StaffySays, type Mood } from '../ui/Staffy';

const TITLES = ['Choose the file', 'Connect', 'Find home', 'Fit the bit', 'Clamp the material', 'Set the start point', 'Check it', 'Stay safe'];

/** One step: where we are, what Staffy says, a picture or controls, then Back on the left and Next on the right. */
function Shell({ flow, mood, say, children, next, back = true, extra }: {
  flow: CutFlow; mood?: Mood; say: ReactNode; children?: ReactNode; next?: ReactNode; back?: boolean; extra?: ReactNode;
}) {
  const at = WALK.indexOf(flow.step);
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      {at >= 0 && (
        <div className="flex items-center gap-3 text-muted" data-testid="cut-step">
          <span className="font-semibold text-ink">Step {at + 1} of {WALK.length}</span>
          <span>{TITLES[at]}</span>
          <span className="ml-auto flex gap-1.5" aria-hidden>
            {WALK.map((s, i) => <span key={s} className={`h-2 w-2 rounded-full ${i < at ? 'bg-done' : i === at ? 'bg-next' : 'bg-line'}`} />)}
          </span>
        </div>
      )}
      <StaffySays mood={mood}>{say}</StaffySays>
      {flow.message && <Note tone={flow.message.tone}>{flow.message.text}</Note>}
      {children}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        {back && at > 0 && <Button onClick={flow.back}>Back</Button>}
        {extra}
        <span className="ml-auto">{next}</span>
      </div>
    </div>
  );
}

const Say = ({ title, children }: { title: string; children?: ReactNode }) => (
  <>
    <p className="text-xl font-semibold">{title}</p>
    {children && <div className="text-muted">{children}</div>}
  </>
);

// ---------- step 1: the file ----------
function FileStep({ flow }: { flow: CutFlow }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const read = async (f: File | undefined) => { if (f) flow.open(f.name, await f.text()); };
  const picker = (
    <input
      ref={input} type="file" accept=".nc,.gcode,.gc,.ngc,.tap,.txt,.cnc" className="hidden" data-testid="file-input"
      onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ''; }}
    />
  );
  const { job } = flow;

  if (!job) {
    return (
      <Shell
        flow={flow}
        say={<Say title="What are we cutting?">Choose a G-code file from your computer. Their names usually end in <b>.nc</b> or <b>.gcode</b>.</Say>}
        next={<Button kind="next" big onClick={() => input.current?.click()}>Choose a file</Button>}
        extra={<Button big onClick={() => flow.open(SAMPLE_NAME, sampleGcode())}>Try the sample coaster</Button>}
      >
        {picker}
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files[0]); }}
          className={`grid h-32 place-items-center rounded-[var(--radius-card)] border-2 border-dashed text-muted ${over ? 'border-next bg-next-soft' : 'border-line'}`}
        >
          You can also drag a file onto here
        </div>
      </Shell>
    );
  }

  const a = job.a;
  const stops = [...a.issues.filter((i) => i.level === 'stop').map((i) => i.text), ...flow.sizeProblems.map((p) => p.text)];
  return (
    <Shell
      flow={flow}
      mood={stops.length ? 'worried' : 'happy'}
      say={stops.length
        ? <Say title="This file can’t be cut as it is.">Nothing has moved. Here’s what needs fixing.</Say>
        : <Say title="Here’s your job, seen from above.">The solid lines are cuts. The blue cross is where the job starts from.</Say>}
      next={<Button kind="next" big disabled={!flow.canCut} onClick={flow.next}>That’s the one</Button>}
      extra={<Button onClick={() => input.current?.click()}>Choose a different file</Button>}
    >
      {picker}
      <Card>
        <p className="mb-3 truncate text-lg font-semibold" data-testid="job-name">{job.name}</p>
        <Preview a={a} />
        {a.bounds && <p className="mt-3 text-muted" data-testid="job-size">{describeSize(a.bounds)} · takes {describeTime(a.seconds)}</p>}
      </Card>
      {stops.map((t) => <Note key={t} tone="stop">{t}</Note>)}
      {a.issues.filter((i) => i.level === 'check').map((i) => <Note key={i.text} tone="check">{i.text}</Note>)}
      {flow.resumeAt !== null && !stops.length && (
        <Note tone="info">Last time, this job stopped part-way. At the end of these steps you can carry on from there or start again.</Note>
      )}
      <Details>
        <div className="space-y-1 text-muted">
          <p>{a.lines.length} lines · {a.segCut.length} moves</p>
          {a.issues.filter((i) => i.level === 'info').map((i) => <p key={i.text}>{i.text}</p>)}
        </div>
      </Details>
    </Shell>
  );
}

// ---------- step 2: connect ----------
function ConnectStep({ flow, machine }: { flow: CutFlow; machine: Machine }) {
  const { link, connect } = machine;
  const busy = link.kind === 'connecting';
  return (
    <Shell
      flow={flow}
      mood={link.kind === 'failed' ? 'worried' : 'happy'}
      say={<Say title="Let’s connect your Cubiko.">Plug in the USB cable and switch the machine on. Then press the blue button{inTauri() ? '.' : <> and choose <b>USB-SERIAL CH340</b>.</>}</Say>}
      next={<Button kind="next" big disabled={!canConnect() || busy} onClick={() => void connect(false)}>{busy ? 'Connecting…' : 'Connect my machine'}</Button>}
      extra={<Button big onClick={() => void connect(true)}>Practise with a pretend machine</Button>}
    >
      {link.kind === 'failed' && <Note tone="stop">{link.message}</Note>}
      {!canConnect() && <Note tone="check">This browser can’t talk to USB machines. Please use Google Chrome or Microsoft Edge.</Note>}
    </Shell>
  );
}

// ---------- step 3: home ----------
function HomeStep({ flow, machine }: { flow: CutFlow; machine: Machine }) {
  const { status, homing } = machine;
  const elsewhere = !homing && (status?.state === 'Run' || status?.state === 'Hold' || status?.state === 'Jog');
  const pressed = status?.state === 'Alarm' && /[XYZ]/.test(status.pins);
  return (
    <Shell
      flow={flow}
      say={homing
        ? <Say title="Finding the home corner…">This takes about half a minute. Keep your hands clear.</Say>
        : <Say title="First, the machine finds its home corner.">It lifts the bit all the way up, then moves to the front-left corner. Take your hands away and make sure nothing is in its path.</Say>}
      next={<Button kind="next" big disabled={homing || elsewhere || !status} onClick={() => void machine.home()}>{homing ? 'Homing…' : 'Find home'}</Button>}
    >
      <HomePicture />
      {machine.notice && <Note tone={machine.notice.tone}>{machine.notice.text}</Note>}
      {pressed && <Note tone="check">A limit switch is being pressed right now. Make sure nothing is pushing against the machine, then press Find home.</Note>}
      {elsewhere && <Note tone="check">The machine is busy with something started from its own controller. Wait for it to finish.</Note>}
    </Shell>
  );
}

// ---------- step 4: the bit ----------
function BitStep({ flow }: { flow: CutFlow }) {
  return (
    <Shell
      flow={flow}
      say={<Say title="Fit the bit for this job.">Push the bit well into the collet and tighten the nut firmly with the spanners. A loose bit can slip and cut too deep.</Say>}
      next={<Button kind="next" big onClick={flow.next}>The bit is in and tight</Button>}
    >
      <BitPicture />
    </Shell>
  );
}

// ---------- step 5: clamp ----------
function ClampStep({ flow, machine }: { flow: CutFlow; machine: Machine }) {
  const b = flow.job!.a.bounds;
  return (
    <Shell
      flow={flow}
      say={<Say title="Clamp your material to the bed.">It must lie flat and not move when you push it. {b && <>The job needs a space of {describeSize(b).split(',')[0]}. </>}Keep the clamps away from where the bit will cut.</Say>}
      next={<Button kind="next" big onClick={flow.next}>It’s clamped down</Button>}
    >
      <BedPicture travel={machine.travel} bounds={b} />
      <p className="text-center text-muted">The blue box is the size of your job on the bed. You’ll choose exactly where it goes next.</p>
    </Shell>
  );
}

// ---------- step 6: zero ----------
const SIZES = [{ mm: 10, label: 'Big steps', sub: '10 mm' }, { mm: 1, label: 'Small steps', sub: '1 mm' }, { mm: 0.1, label: 'Tiny steps', sub: '0.1 mm' }];

function JogPad({ flow, machine, sideways = true, start = 1 }: { flow: CutFlow; machine: Machine; sideways?: boolean; start?: number }) {
  const [size, setSize] = useState(start);
  const st = machine.status?.state;
  const off = (st !== 'Idle' && st !== 'Jog') || !!flow.busy;
  const mm = SIZES[size].mm;
  const Arrow = ({ label, d, className = '' }: { label: string; d: { x?: number; y?: number; z?: number }; className?: string }) => (
    <button
      disabled={off} onClick={() => void flow.jog(d)} aria-label={`Move ${label}`}
      className={`grid min-h-16 place-items-center rounded-2xl bg-line/60 px-2 text-center font-semibold transition hover:bg-line active:scale-95 disabled:opacity-40 ${className}`}
    >{label}</button>
  );
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-center gap-8">
        {sideways && (
          <div className="grid w-60 grid-cols-3 gap-2" data-testid="jog-xy">
            <Arrow label="↑ Back" d={{ y: mm }} className="col-start-2" />
            <Arrow label="← Left" d={{ x: -mm }} className="col-start-1 row-start-2" />
            <Arrow label="Right →" d={{ x: mm }} className="col-start-3 row-start-2" />
            <Arrow label="↓ Front" d={{ y: -mm }} className="col-start-2 row-start-3" />
          </div>
        )}
        <div className="grid w-28 gap-2" data-testid="jog-z">
          <Arrow label="⤒ Up" d={{ z: mm }} />
          <Arrow label="⤓ Down" d={{ z: -mm }} />
        </div>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Step size">
        {SIZES.map((s, i) => (
          <button
            key={s.mm} role="radio" aria-checked={i === size} onClick={() => setSize(i)}
            className={`rounded-xl border px-2 py-2 text-center ${i === size ? 'border-next bg-next-soft font-semibold' : 'border-line'}`}
          >
            <div>{s.label}</div><div className="text-sm text-muted">{s.sub}</div>
          </button>
        ))}
      </div>
    </Card>
  );
}

function Problems({ flow }: { flow: CutFlow }) {
  return <>{flow.problems.map((p) => <Note key={p.text} tone="stop">{p.text}</Note>)}</>;
}

function ZeroStep({ flow, machine }: { flow: CutFlow; machine: Machine }) {
  const [method, setMethod] = useState<'paper' | 'probe' | null>(null);
  const [felt, setFelt] = useState(false);
  const [plateDown, setPlateDown] = useState(false);
  const [clipOff, setClipOff] = useState(true);
  const b = flow.job!.a.bounds!;
  const touching = machine.status?.pins.includes('P') ?? false;
  useEffect(() => { if (method === 'probe' && !plateDown && touching) setFelt(true); }, [method, plateDown, touching]);
  const pretend = machine.link.kind === 'connected' && machine.link.pretend;
  const busy = !!flow.busy;

  // Already set: show where, and let them carry on or redo it.
  if (flow.zeroOk && clipOff) {
    return (
      <Shell
        flow={flow}
        say={<Say title="The start point is set.">The blue box shows where the job will be cut on the bed.</Say>}
        next={<Button kind="next" big onClick={flow.next}>Continue</Button>}
        extra={<Button onClick={() => { setMethod(null); setFelt(false); setPlateDown(false); flow.clearZero(); }}>Set it again</Button>}
      >
        <BedPicture travel={machine.travel} bounds={b} zero={flow.zero.wco} bit={machine.status?.mpos} />
      </Shell>
    );
  }
  if (flow.zeroOk && !clipOff) {
    return (
      <Shell
        flow={flow} back={false}
        say={<Say title="Got it. Now take the plate and the clip away.">The bit has lifted clear. Remove the probe plate from the material and unclip the lead from the bit before cutting.</Say>}
        next={<Button kind="next" big onClick={() => setClipOff(true)}>They’re out of the way</Button>}
      >
        <ProbePicture />
      </Shell>
    );
  }

  // a) the corner
  if (!flow.zero.xy) {
    const where = b.min[0] > -0.5 && b.min[1] > -0.5 ? 'the front-left corner of where you want the job'
      : Math.abs(b.min[0] + b.max[0]) < 1 && Math.abs(b.min[1] + b.max[1]) < 1 ? 'the middle of where you want the job'
        : 'the spot marked in the picture';
    return (
      <Shell
        flow={flow}
        say={<Say title="Show Staffy where the job starts.">Use the arrows to move the bit until it is right above <b>{where}</b>. Start with big steps, then small ones.</Say>}
        next={<Button kind="next" big disabled={busy || machine.status?.state !== 'Idle'} onClick={() => void flow.setCorner()}>{flow.busy ?? 'The bit is over the spot'}</Button>}
      >
        <CornerPicture bounds={b} />
        <Problems flow={flow} />
        <JogPad flow={flow} machine={machine} start={0} />
      </Shell>
    );
  }

  // b) the height: choose how
  if (!method) {
    return (
      <Shell
        flow={flow} back={false}
        say={<Say title="Now the height.">Staffy needs to know exactly where the top of your material is. How would you like to measure it?</Say>}
        extra={<Button onClick={flow.clearZero}>Back</Button>}
      >
        <BedPicture travel={machine.travel} bounds={b} zero={flow.zero.wco} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Choice highlight icon={<span className="text-2xl">📄</span>} title="With a piece of paper" text="Works on every machine. Takes about a minute." onClick={() => setMethod('paper')} />
          <Choice icon={<span className="text-2xl">⚡</span>} title="With the touch probe" text="The plate and clip that came with the machine. Staffy checks it works first." onClick={() => setMethod('probe')} />
        </div>
      </Shell>
    );
  }

  if (method === 'paper') {
    return (
      <Shell
        flow={flow} back={false}
        say={<Say title="Lower the bit onto a piece of paper.">Lay ordinary paper on the material under the bit. Press <b>Down</b> a little at a time while sliding the paper. Stop as soon as the paper starts to drag.</Say>}
        next={<Button kind="next" big disabled={busy || machine.status?.state !== 'Idle'} onClick={() => void flow.setHeightByPaper()}>{flow.busy ?? 'The paper drags'}</Button>}
        extra={<Button onClick={() => setMethod(null)}>Back</Button>}
      >
        <PaperPicture />
        <Problems flow={flow} />
        <JogPad flow={flow} machine={machine} sideways={false} start={1} />
      </Shell>
    );
  }

  // touch probe, part 1: prove it works before trusting it
  if (!plateDown) {
    return (
      <Shell
        flow={flow} back={false} mood={felt ? 'happy' : 'thinking'}
        say={felt
          ? <Say title="Staffy can feel the probe.">Now lay the plate flat on the material, right under the bit, and leave the clip on the bit.</Say>
          : <Say title="First, let’s check the probe works.">Clip the lead onto the bit. Then lift the plate by hand and touch it against the bit for a second.</Say>}
        next={<Button kind="next" big disabled={!felt || touching} onClick={() => setPlateDown(true)}>The plate is under the bit</Button>}
        extra={<><Button onClick={() => setMethod(null)}>Back</Button>{!felt && <Button onClick={() => setMethod('paper')}>Use paper instead</Button>}</>}
      >
        <ProbePicture />
        {!felt && <Note tone="info">Waiting to feel the plate touch the bit…</Note>}
        {felt && touching && <Note tone="check">The plate is touching the bit now. Put it down on the material so there’s a gap.</Note>}
        {pretend && !felt && (
          <Button onClick={() => { const e = machine.emulator.current; if (!e) return; e.probeTouching = true; setTimeout(() => { e.probeTouching = false; }, 800); }}>
            Pretend: touch the plate to the bit
          </Button>
        )}
      </Shell>
    );
  }

  // touch probe, part 2
  const probing = busy;
  return (
    <Shell
      flow={flow} back={false}
      say={probing
        ? <Say title="Lowering the bit onto the plate…">It goes down slowly, touches, lifts and touches once more. Keep your hands clear.</Say>
        : <Say title="How thick is your probe plate?">Look for a number printed on it, or measure it. Staffy remembers it for next time.</Say>}
      next={<Button kind="next" big disabled={probing || flow.plate === null || machine.status?.state !== 'Idle'} onClick={() => { setClipOff(false); void flow.setHeightByProbe().then((ok) => { if (!ok) setClipOff(true); }); }}>{probing ? 'Probing…' : 'Lower the bit onto the plate'}</Button>}
      extra={!probing && <Button onClick={() => setPlateDown(false)}>Back</Button>}
    >
      <ProbePicture />
      <Problems flow={flow} />
      <Card>
        <label className="flex flex-wrap items-center gap-3">
          <span className="font-semibold">Plate thickness</span>
          <input
            type="number" inputMode="decimal" min="0.1" max="50" step="0.01" disabled={probing} data-testid="plate-mm"
            defaultValue={flow.plate ?? ''} onChange={(e) => { const v = Number(e.target.value); flow.setPlate(v > 0 && v <= 50 ? v : null); }}
            className="w-28 rounded-xl border border-line bg-bg px-3 py-2 text-lg tabular-nums"
          />
          <span className="text-muted">mm</span>
        </label>
      </Card>
    </Shell>
  );
}

// ---------- step 7: check ----------
function CheckStep({ flow }: { flow: CutFlow }) {
  const { checks, job } = flow;
  const traced = checks.outline;
  return (
    <Shell
      flow={flow}
      say={traced
        ? <Say title="Did it stay over your material?">If the bit passed over a clamp or went off the edge, go back and move the start point. If it looked right, carry on.</Say>
        : <Say title="Let’s check before any cutting.">Staffy will lift the bit right to the top and trace around the edge of the job. Watch that it stays over your material and misses the clamps.</Say>}
      next={traced
        ? <Button kind="next" big onClick={flow.next}>It looked right</Button>
        : <Button kind="next" big onClick={() => void flow.trace()}>Trace the outline</Button>}
      extra={traced ? <Button onClick={() => void flow.trace()}>Trace it again</Button> : <Button onClick={flow.next}>Skip</Button>}
    >
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">{checks.air ? '✓ ' : ''}Practice run in the air</p>
            <p className="text-muted">
              {flow.airLift === null
                ? 'There isn’t enough room above the material for this job.'
                : `Optional. The whole job, ${Math.round(flow.airLift * 10) / 10} mm above the material with the spindle off. Takes ${describeTime(job!.a.seconds)}.`}
            </p>
          </div>
          <Button disabled={flow.airLift === null} onClick={() => void flow.airRun()}>Run it in the air</Button>
        </div>
      </Card>
    </Shell>
  );
}

// ---------- step 8: safety ----------
function SafetyStep({ flow }: { flow: CutFlow }) {
  const a = flow.job!.a;
  const resume = flow.resumeAt;
  const items: [Parameters<typeof SafetyIcon>[0]['kind'], string, string][] = [
    ['glasses', 'Safety glasses on', 'Chips and broken bits fly.'],
    ['loose', 'Hair, sleeves and cords tied back', 'Nothing loose near the spinning bit.'],
    ['hands', 'Hands away while it moves', 'Never reach in. Press Stop first.'],
    ['switch', 'Know where the power switch is', 'If anything looks dangerous, switch the machine off there.'],
  ];
  return (
    <Shell
      flow={flow}
      say={<Say title="Ready to cut.">The spindle will start and the machine will move by itself. Stay with it until it finishes: {describeTime(a.seconds)}.</Say>}
      next={resume !== null
        ? <Button kind="next" big onClick={() => void flow.start(resume)}>Carry on from where it stopped</Button>
        : <Button kind="next" big onClick={() => void flow.start(0)}>Start cutting</Button>}
      extra={resume !== null && <Button onClick={() => void flow.start(0)}>Start from the beginning</Button>}
    >
      <Card className="space-y-4">
        {items.map(([kind, title, text]) => (
          <div key={kind} className="flex items-center gap-4">
            <SafetyIcon kind={kind} />
            <div><p className="font-semibold">{title}</p><p className="text-muted">{text}</p></div>
          </div>
        ))}
      </Card>
    </Shell>
  );
}

// ---------- the job itself ----------
function RunView({ flow, machine }: { flow: CutFlow; machine: Machine }) {
  const run = flow.run!;
  const a = flow.job!.a;
  const paused = machine.status?.state === 'Hold';
  const pct = Math.round(flow.progress.fraction * 100);
  const title = run.mode === 'cut' ? (paused ? 'Paused' : run.finishing && flow.progress.fraction > 0.97 ? 'Finishing…' : 'Cutting')
    : run.mode === 'air' ? 'Practice run in the air' : 'Tracing the outline';
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Card>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-3xl font-bold" data-testid="run-title">{title}</p>
          {run.mode !== 'outline' && <p className="text-muted">{flow.progress.secondsLeft < 5 ? 'nearly there' : `${describeTime(flow.progress.secondsLeft)} left`}</p>}
        </div>
        <div className="mt-4 h-4 overflow-hidden rounded-full bg-line/60" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-next transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-muted" data-testid="run-percent">{pct}% done</p>
        <div className="mt-4">
          <Preview a={a} doneSegments={run.mode === 'outline' ? 0 : flow.progress.segments} bit={flow.bit} />
        </div>
      </Card>
      <div className="flex flex-wrap items-center gap-3">
        <Button kind="stop" big onClick={flow.stop} data-testid="stop">Stop</Button>
        <span className="ml-auto">
          {paused
            ? <Button kind="next" big onClick={flow.carryOn}>Carry on</Button>
            : <Button big onClick={flow.pause}>Pause</Button>}
        </span>
      </div>
      <p className="text-sm text-muted">Stop is a software stop: it tells the machine to halt. If anything looks dangerous, use the power switch on the machine.</p>
      <Details>
        <p className="font-mono text-sm text-muted">line {flow.progress.fileLine} of {a.lines.length} · sent {run.done}/{run.total}</p>
      </Details>
    </div>
  );
}

function DoneView({ flow }: { flow: CutFlow }) {
  return (
    <Shell
      flow={flow} back={false}
      say={<Say title="All done!">Wait until the spindle has stopped turning. Then unclamp your piece and clear away the dust.</Say>}
      next={<Button kind="next" big onClick={() => flow.go('clamp')}>Cut another one</Button>}
      extra={<Button onClick={() => flow.go('file')}>Back to the file</Button>}
    >
      <Card><Preview a={flow.job!.a} doneSegments={flow.job!.a.segCut.length} /></Card>
    </Shell>
  );
}

function StoppedView({ flow }: { flow: CutFlow }) {
  const a = flow.job!.a;
  const s = flow.stopped;
  const resume = flow.resumeAt;
  const pct = s && a.seconds > 0 && s.at > 0 ? Math.round((a.lineTimeEnd[Math.min(s.at, a.lines.length) - 1] / a.seconds) * 100) : 0;
  return (
    <Shell
      flow={flow} back={false} mood={s?.reason === 'user' ? 'thinking' : 'worried'}
      say={<Say title="The job has stopped.">{s?.message} It got about {pct}% of the way.{resume !== null && ' Staffy can go back a few moves and carry on, so nothing is missed. The spindle will start again by itself.'}</Say>}
      next={resume !== null
        ? <Button kind="next" big onClick={() => void flow.start(resume)}>Carry on from where it stopped</Button>
        : <Button kind="next" big onClick={() => flow.go('file')}>Back to the file</Button>}
      extra={<><Button onClick={() => void flow.start(0)}>Start again from the beginning</Button>{resume !== null && <Button onClick={() => flow.go('file')}>Back to the file</Button>}</>}
    >
      <Card><Preview a={a} doneSegments={s && s.at > 0 ? a.lineSegEnd[Math.min(s.at, a.lines.length) - 1] : 0} bit={flow.bit} /></Card>
      <Details>
        <label className="flex flex-wrap items-center gap-3 text-muted">
          <span>Carry on from line</span>
          <input
            type="number" min="1" max={a.lines.length} data-testid="resume-line"
            value={resume !== null ? resume + 1 : ''} placeholder="–"
            onChange={(e) => { const v = Math.floor(Number(e.target.value)); flow.setResumeAt(v >= 1 && v <= a.lines.length ? v - 1 : null); }}
            className="w-28 rounded-xl border border-line bg-bg px-3 py-2 tabular-nums text-ink"
          />
          <span>of {a.lines.length} (stopped at {s?.at ?? 0})</span>
        </label>
      </Details>
    </Shell>
  );
}

// ---------- the screen ----------
export function CutScreen({ machine, flow }: { machine: Machine; flow: CutFlow }) {
  const { link, status, emulator } = machine;
  const moving = !flow.run && (status?.state === 'Home' || status?.state === 'Jog' || status?.state === 'Run');
  const d = describeState(status);
  const pos = status?.mpos ?? status?.wpos;
  const [, redraw] = useState(0);
  const fast = (emulator.current?.timeScale ?? 1) > 1;

  return (
    <div className="space-y-6">
      {flow.step === 'run' ? <RunView flow={flow} machine={machine} />
        : flow.step === 'file' ? <FileStep flow={flow} />
          : flow.step === 'connect' ? <ConnectStep flow={flow} machine={machine} />
            : flow.step === 'home' ? <HomeStep flow={flow} machine={machine} />
              : flow.step === 'bit' ? <BitStep flow={flow} />
                : flow.step === 'clamp' ? <ClampStep flow={flow} machine={machine} />
                  : flow.step === 'zero' ? <ZeroStep flow={flow} machine={machine} />
                    : flow.step === 'check' ? <CheckStep flow={flow} />
                      : flow.step === 'safety' ? <SafetyStep flow={flow} />
                        : flow.step === 'done' ? <DoneView flow={flow} />
                          : <StoppedView flow={flow} />}

      {/* Stop is always in the same place whenever the machine is moving. */}
      {moving && (
        <div className="mx-auto max-w-2xl">
          <Button kind="stop" big onClick={() => void machine.stop()} data-testid="stop">Stop</Button>
        </div>
      )}

      {link.kind === 'connected' && (
        <div className="mx-auto max-w-2xl">
          <Details>
            <div className="space-y-3 text-muted">
              <p>
                <span data-testid="machine-state" className="font-semibold text-ink">{link.pretend ? 'Pretend Cubiko' : 'Genmitsu Cubiko'}: {d.title}</span>
                {pos && <span className="ml-3 font-mono text-sm tabular-nums">X {pos[0]?.toFixed(1)} · Y {pos[1]?.toFixed(1)} · Z {pos[2]?.toFixed(1)}</span>}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void machine.unlock()}>Unlock without homing ($X)</Button>
                <Button onClick={() => void machine.disconnect()}>Disconnect</Button>
              </div>
              {link.pretend && (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => emulator.current?.pressLimit('X')}>Pretend: press X limit switch</Button>
                  <Button onClick={() => emulator.current?.releaseLimit()}>Pretend: release it</Button>
                  <Button onClick={() => { const e = emulator.current; if (e) { e.timeScale = fast ? 1 : 20; redraw((n) => n + 1); } }}>Pretend: {fast ? 'normal speed' : '20× faster'}</Button>
                </div>
              )}
              <p className="font-mono text-sm">
                {status ? `${status.state}${status.pins ? ' · pins ' + status.pins : ''} · buffer ${status.buffer?.join('/') ?? '?'} · ${machine.session.current?.serialBufferBytes ?? '?'} bytes · travel ${machine.travel.x[1]}×${machine.travel.y[1]}×${-machine.travel.z[0]}` : 'No status yet'}
              </p>
            </div>
          </Details>
        </div>
      )}
    </div>
  );
}
