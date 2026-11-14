import { useState } from 'react';
import { useCutFlow } from './cut/useCutFlow';
import { useMachine, describeState } from './machine/useMachine';
import { CutScreen } from './screens/CutScreen';
import { StartScreen } from './screens/StartScreen';
import { Button, StepBar, type Step } from './ui/kit';
import { Staffy, StaffySays } from './ui/Staffy';

function ComingSoon({ step, next, go }: { step: Step; next: Step; go: (s: Step) => void }) {
  const what = step === 'Design'
    ? 'This is where you’ll draw shapes, add holes and words, and pick a depth. It’s being built in the next milestone.'
    : 'This is where Staffy picks the bit, speeds and cut order for you, and shows a preview. It’s being built in the next milestone.';
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <StaffySays mood="thinking">
        <p className="text-xl font-semibold">{step} is on its way.</p>
        <p className="text-muted">{what}</p>
      </StaffySays>
      <Button kind="next" big onClick={() => go(next)}>Continue to {next}</Button>
    </div>
  );
}

export default function App() {
  const [step, setStep] = useState<Step>('Start');
  const machine = useMachine();
  const flow = useCutFlow(machine);
  const d = describeState(machine.status);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <button className="flex items-center gap-2" onClick={() => setStep('Start')} aria-label="Staffy CNC home">
            <Staffy size={36} />
            <span className="hidden text-lg font-bold sm:inline">Staffy CNC</span>
          </button>
          <StepBar current={step} onPick={setStep} />
          <button
            onClick={() => setStep('Cut')}
            className="flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1.5 text-sm"
            title="Machine"
          >
            <span className={`h-2.5 w-2.5 rounded-full ${machine.link.kind !== 'connected' ? 'bg-line' : d.tone === 'ok' ? 'bg-done' : d.tone === 'check' ? 'bg-check' : 'bg-next'}`} />
            <span className="hidden sm:inline">{machine.link.kind === 'connected' ? d.title : 'No machine'}</span>
          </button>
        </div>
      </header>
      <main className="flex-1 px-4 py-8">
        {step === 'Start' && <StartScreen go={setStep} />}
        {step === 'Design' && <ComingSoon step="Design" next="Make" go={setStep} />}
        {step === 'Make' && <ComingSoon step="Make" next="Cut" go={setStep} />}
        {step === 'Cut' && <CutScreen machine={machine} flow={flow} />}
      </main>
      <footer className="px-4 py-4 text-center text-sm text-muted">
        Staffy CNC · free and open source (GPL-3.0) · made by Warner Media Design
      </footer>
    </div>
  );
}
