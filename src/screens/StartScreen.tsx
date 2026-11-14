import { Choice } from '../ui/kit';
import { StaffySays } from '../ui/Staffy';
import type { Step } from '../ui/kit';

const Icon = ({ d }: { d: string }) => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

export function StartScreen({ go }: { go: (s: Step) => void }) {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <StaffySays>
        <p className="text-xl font-semibold">Hi! What would you like to make today?</p>
        <p className="text-muted">Pick one. You can always come back here.</p>
      </StaffySays>
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice highlight icon={<Icon d="M12 5v14M5 12h14" />} title="Make something new" text="Draw shapes, add holes and words, and choose how deep to cut." onClick={() => go('Design')} />
        <Choice icon={<Icon d="M4 4h10l6 6v10H4zM14 4v6h6" />} title="Open a drawing" text="SVG, DXF or a picture. Staffy turns it into a cut." onClick={() => go('Design')} />
        <Choice icon={<Icon d="M5 4l14 8-14 8z" />} title="Run a ready-made file" text="Already have G-code (.nc, .gcode)? Go straight to cutting." onClick={() => go('Cut')} />
        <Choice icon={<Icon d="M12 3l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z" />} title="Try a sample" text="A coaster, a name sign or a keyring. Great for a first cut." onClick={() => go('Design')} />
      </div>
    </div>
  );
}
