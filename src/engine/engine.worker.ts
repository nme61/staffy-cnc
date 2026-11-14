/// <reference lib="webworker" />
// 3D engine worker. OpenCASCADE (via replicad) is loaded only here, only when 3D is needed,
// so the main app stays light on cheap Chromebooks.
import opencascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import {
  drawCircle,
  drawRoundedRectangle,
  FaceFinder,
  setOC,
  type Shape3D,
  type Wire,
} from 'replicad';

export type EngineRequest = { type: 'run-test' };
export type EngineMessage =
  | { type: 'progress'; step: string; ms: number }
  | { type: 'slice'; z: number; svgPaths: string[]; viewBox: string; faces: number; loops: number }
  | { type: 'done'; timings: Record<string, number>; stepBytes: number; wasmUrl: string; wasmTransferred: number; wasmUnpacked: number }
  | { type: 'error'; message: string };

const post = (m: EngineMessage) => (self as unknown as Worker).postMessage(m);

async function time<T>(label: string, timings: Record<string, number>, fn: () => T | Promise<T>): Promise<T> {
  const t = performance.now();
  const out = await fn();
  timings[label] = Math.round(performance.now() - t);
  post({ type: 'progress', step: label, ms: timings[label] });
  return out;
}

/** A test part a hobbyist might cut: 60×40×12 mm block, rounded corners,
 *  a 6 mm deep pocket, two through-holes, and a filleted top edge. */
function buildTestPart(): Shape3D {
  let part = drawRoundedRectangle(60, 40, 5).sketchOnPlane('XY').extrude(12) as Shape3D;
  part = part.fillet(1.5, (e) => e.inPlane('XY', 12));
  const pocket = drawRoundedRectangle(30, 20, 3).sketchOnPlane('XY', 6).extrude(10) as Shape3D;
  part = part.cut(pocket);
  for (const x of [-22, 22]) {
    const hole = drawCircle(2.5).translate(x, 0).sketchOnPlane('XY', -1).extrude(20) as Shape3D;
    part = part.cut(hole);
  }
  return part;
}

/** Turn a closed wire into a polyline (what the CAM side will work with), ~0.25 mm per step. */
function wireToPolyline(wire: Wire): [number, number][] {
  const n = Math.max(24, Math.ceil(wire.length / 0.25));
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const v = wire.pointAt(i / n);
    pts.push([v.x, v.y]);
  }
  return pts;
}

/** Cut the part with a thin slab at height z and return every outline found there (outside edges and holes). */
function sliceAt(part: Shape3D, z: number) {
  const slab = drawRoundedRectangle(500, 500).sketchOnPlane('XY', z).extrude(0.01) as Shape3D;
  const piece = part.intersect(slab);
  const faces = new FaceFinder().inPlane('XY', z).find(piece);
  // replicad frees OpenCASCADE objects eagerly, so work on clones and sample each wire straight away.
  const loops = faces.flatMap((f) => [
    wireToPolyline(f.clone().outerWire()),
    ...f.clone().innerWires().map(wireToPolyline),
  ]);
  const svgPaths = loops.map((pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(3)} ${(-y).toFixed(3)}`).join(' L') + ' Z');
  const xs = loops.flat().map((p) => p[0]);
  const ys = loops.flat().map((p) => -p[1]);
  const viewBox = xs.length
    ? `${Math.min(...xs) - 4} ${Math.min(...ys) - 4} ${Math.max(...xs) - Math.min(...xs) + 8} ${Math.max(...ys) - Math.min(...ys) + 8}`
    : '-35 -25 70 50';
  return { svgPaths, viewBox, faces: faces.length, loops: loops.length };
}

self.onmessage = async (ev: MessageEvent<EngineRequest>) => {
  if (ev.data.type !== 'run-test') return;
  const timings: Record<string, number> = {};
  try {
    const oc = await time('Download + start engine', timings, () =>
      (opencascade as unknown as (o: object) => Promise<unknown>)({ locateFile: () => wasmUrl }),
    );
    setOC(oc as Parameters<typeof setOC>[0]);
    const part = await time('Build test part', timings, buildTestPart);
    for (const z of [3, 9]) {
      const s = await time(`Slice at Z=${z} mm`, timings, () => sliceAt(part, z));
      post({ type: 'slice', z, ...s });
    }
    const step = await time('Export STEP', timings, () => part.blobSTEP());
    const wasm = performance.getEntriesByType('resource').find((e) => e.name.includes('.wasm')) as PerformanceResourceTiming | undefined;
    post({ type: 'done', timings, stepBytes: step.size, wasmUrl,
      wasmTransferred: wasm?.transferSize ?? -1, wasmUnpacked: wasm?.decodedBodySize ?? -1 });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
