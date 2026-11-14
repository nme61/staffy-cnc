import type { EngineMessage } from './engine.worker';

const $ = (id: string) => document.getElementById(id)!;
const rows: string[] = [];
const t0 = performance.now();
const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });

function row(label: string, value: string) {
  rows.push(`<tr><td>${label}</td><td>${value}</td></tr>`);
  $('times').innerHTML = rows.join('');
}

worker.onmessage = (ev: MessageEvent<EngineMessage>) => {
  const m = ev.data;
  if (m.type === 'progress') { row(m.step, `${m.ms} ms`); $('status').textContent = `${m.step} done…`; }
  if (m.type === 'slice') {
    const fig = document.createElement('figure');
    fig.innerHTML = `<svg viewBox="${m.viewBox}"><path d="${m.svgPaths.join(' ')}"/></svg>
      <figcaption>Z = ${m.z} mm · ${m.faces} region(s), ${m.loops} outline(s)</figcaption>`;
    $('slices').appendChild(fig);
  }
  if (m.type === 'done') {
    row('Engine download (transferred / unpacked)', m.wasmTransferred === 0 ? `from cache / ${(m.wasmUnpacked / 1e6).toFixed(1)} MB`
      : `${(m.wasmTransferred / 1e6).toFixed(1)} MB / ${(m.wasmUnpacked / 1e6).toFixed(1)} MB`);
    row('STEP file size', `${(m.stepBytes / 1024).toFixed(1)} KB`);
    row('Total, page open → done', `${Math.round(performance.now() - t0)} ms`);
    $('status').textContent = 'Passed. The engine works in this browser.';
    (window as unknown as { engineResult: unknown }).engineResult = { ...m, total: Math.round(performance.now() - t0) };
  }
  if (m.type === 'error') { $('status').textContent = 'Failed: ' + m.message; (window as unknown as { engineResult: unknown }).engineResult = m; }
};
worker.postMessage({ type: 'run-test' });
