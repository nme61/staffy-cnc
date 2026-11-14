// The small set of building blocks every Staffy screen is made from.
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Kind = 'next' | 'plain' | 'stop';

/** Every screen has exactly one `next` button: the obvious thing to do. */
export function Button({ kind = 'plain', big, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind; big?: boolean }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition active:scale-[.98] disabled:opacity-40';
  const size = big ? 'min-h-14 px-7 text-lg' : 'min-h-12 px-5';
  const look = {
    next: 'bg-next text-white shadow-sm hover:brightness-110',
    plain: 'bg-line/60 text-ink hover:bg-line',
    stop: 'bg-stop text-white hover:brightness-110',
  }[kind];
  return <button className={`${base} ${size} ${look} ${className}`} {...rest} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[var(--radius-card)] border border-line bg-card p-6 ${className}`}>{children}</div>;
}

/** A large, picture-first choice tile. */
export function Choice({ icon, title, text, onClick, highlight }: { icon: ReactNode; title: string; text: string; onClick: () => void; highlight?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full flex-col items-start gap-3 rounded-[var(--radius-card)] border bg-card p-6 text-left transition hover:-translate-y-0.5 hover:shadow-md ${highlight ? 'border-next ring-4 ring-next-soft' : 'border-line'}`}
    >
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-next-soft text-next">{icon}</span>
      <span className="text-xl font-semibold">{title}</span>
      <span className="text-muted">{text}</span>
    </button>
  );
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'check' | 'stop'; children: ReactNode }) {
  const look = {
    info: 'bg-next-soft',
    ok: 'bg-done/15',
    check: 'bg-check/15',
    stop: 'bg-stop/15',
  }[tone];
  return <div className={`rounded-xl px-4 py-3 ${look}`}>{children}</div>;
}

/** "Show details": the power-user layer. Hidden by default, never required. */
export function Details({ children, label = 'Show details' }: { children: ReactNode; label?: string }) {
  return (
    <details className="group mt-4">
      <summary className="cursor-pointer select-none text-muted marker:content-none">
        <span className="group-open:hidden">▸ {label}</span>
        <span className="hidden group-open:inline">▾ Hide details</span>
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export const STEPS = ['Start', 'Design', 'Make', 'Cut'] as const;
export type Step = (typeof STEPS)[number];

/** The journey bar at the top: always shows where you are and what comes next. */
export function StepBar({ current, onPick, done = [] }: { current: Step; onPick: (s: Step) => void; done?: Step[] }) {
  const at = STEPS.indexOf(current);
  return (
    <nav aria-label="Steps" className="flex items-center gap-1 sm:gap-2">
      {STEPS.map((s, i) => {
        // Only tick steps that were really finished; skipping ahead (e.g. straight to Cut) isn't "done".
        const state = i === at ? 'now' : done.includes(s) ? 'done' : 'later';
        return (
          <div key={s} className="flex items-center gap-1 sm:gap-2">
            {i > 0 && <span className={`h-0.5 w-3 sm:w-8 ${i <= at ? 'bg-next' : 'bg-line'}`} />}
            <button
              onClick={() => onPick(s)}
              aria-current={state === 'now' ? 'step' : undefined}
              className={`flex items-center gap-2 rounded-full px-2 py-1.5 sm:px-3 ${state === 'now' ? 'bg-next text-white' : state === 'done' ? 'text-done' : 'text-muted'}`}
            >
              <span className={`grid h-6 w-6 place-items-center rounded-full text-sm font-bold ${state === 'now' ? 'bg-white/25' : state === 'done' ? 'bg-done/15' : 'bg-line/60'}`}>
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span className="hidden font-semibold sm:inline">{s}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
