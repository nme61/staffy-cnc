// The job seen from above. Cuts are solid, quick moves between cuts are faint dashes,
// the finished part turns green, and a dot shows where the bit is.

import { useEffect, useRef, useState } from 'react';
import type { Analysis } from '../gcode/analyze';

interface View { scale: number; ox: number; oy: number; w: number; h: number }

function viewFor(a: Analysis, w: number, h: number): View | null {
  if (!a.bounds || w < 10 || h < 10) return null;
  // Always keep the zero point in the picture, so it's clear where the job sits around it.
  const x0 = Math.min(a.bounds.min[0], 0), x1 = Math.max(a.bounds.max[0], 0);
  const y0 = Math.min(a.bounds.min[1], 0), y1 = Math.max(a.bounds.max[1], 0);
  const pad = 18;
  const scale = Math.min((w - pad * 2) / Math.max(x1 - x0, 1), (h - pad * 2) / Math.max(y1 - y0, 1));
  return { scale, w, h, ox: (w - (x1 - x0) * scale) / 2 - x0 * scale, oy: (h + (y1 - y0) * scale) / 2 + y0 * scale };
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

function strokeSegments(ctx: CanvasRenderingContext2D, a: Analysis, v: View, from: number, to: number, cut: 0 | 1) {
  ctx.beginPath();
  for (let i = from; i < to; i++) {
    if (a.segCut[i] !== cut) continue;
    const k = i * 6;
    ctx.moveTo(v.ox + a.seg[k] * v.scale, v.oy - a.seg[k + 1] * v.scale);
    ctx.lineTo(v.ox + a.seg[k + 3] * v.scale, v.oy - a.seg[k + 4] * v.scale);
  }
  ctx.stroke();
}

function prepare(canvas: HTMLCanvasElement, v: View) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(v.w * dpr);
  canvas.height = Math.round(v.h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return ctx;
}

export function Preview({ a, doneSegments = 0, bit, height = 280 }: { a: Analysis; doneSegments?: number; bit?: readonly number[] | null; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(0);
  const [view, setView] = useState<View | null>(null);
  const [theme, setTheme] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setView(viewFor(a, el.clientWidth, el.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => setTheme((t) => t + 1);
    dark.addEventListener('change', onTheme);
    return () => { ro.disconnect(); dark.removeEventListener('change', onTheme); };
  }, [a]);

  // The whole job, drawn once.
  useEffect(() => {
    if (!view || !base.current || !over.current) return;
    const ctx = prepare(base.current, view);
    ctx.strokeStyle = css('--color-line');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    strokeSegments(ctx, a, view, 0, a.segCut.length, 0);
    ctx.setLineDash([]);
    ctx.strokeStyle = css('--color-ink');
    ctx.lineWidth = 1.6;
    strokeSegments(ctx, a, view, 0, a.segCut.length, 1);
    // zero point
    ctx.strokeStyle = css('--color-next');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(view.ox - 9, view.oy); ctx.lineTo(view.ox + 9, view.oy);
    ctx.moveTo(view.ox, view.oy - 9); ctx.lineTo(view.ox, view.oy + 9);
    ctx.stroke();
    prepare(over.current, view);
    drawn.current = 0;
  }, [a, view, theme]);

  // The finished part, added to as the job goes.
  useEffect(() => {
    if (!view || !over.current) return;
    let ctx = over.current.getContext('2d')!;
    if (doneSegments < drawn.current) { ctx = prepare(over.current, view); drawn.current = 0; }
    ctx.strokeStyle = css('--color-done');
    ctx.lineWidth = 2.6;
    strokeSegments(ctx, a, view, drawn.current, doneSegments, 1);
    drawn.current = doneSegments;
  }, [a, view, theme, doneSegments]);

  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-xl bg-bg" style={{ height }} role="img" aria-label="Picture of the job from above">
      <canvas ref={base} className="absolute inset-0 h-full w-full" />
      <canvas ref={over} className="absolute inset-0 h-full w-full" />
      {view && bit && (
        <span
          className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-stop shadow"
          style={{ left: view.ox + bit[0] * view.scale, top: view.oy - bit[1] * view.scale }}
        />
      )}
      {!view && <p className="grid h-full place-items-center text-muted">Nothing to show yet</p>}
    </div>
  );
}
