import { describe, expect, it } from 'vitest';
import { sampleGcode } from '../cut/sample';
import { describeSize, describeTime, loadGcode } from './analyze';
import { checkPlacement, checkSize, type Travel } from './fit';
import { buildResume, resumeLineFor } from './resume';

const CUBIKO_TRAVEL: Travel = { x: [0, 152], y: [0, 113], z: [-39, 0] };
const close = (a: number[] | readonly number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 3));

describe('reading a G-code file', () => {
  it('measures the sample coaster', () => {
    const a = loadGcode(sampleGcode());
    close(a.bounds!.min, [0, 0, -1]);
    close(a.bounds!.max, [50, 50, 5]);
    expect(a.issues).toEqual([]);
    expect(a.spindle).toBe(true);
    expect(describeSize(a.bounds!)).toBe('50 × 50 mm, 1 mm deep');
    expect(a.seconds).toBeGreaterThan(60);
    // Progress tables line up with the lines.
    expect(a.lineSegEnd[a.lines.length - 1]).toBe(a.segCut.length);
    expect(a.lineTimeEnd[a.lines.length - 1]).toBeCloseTo(a.seconds, 1);
  });

  it('turns inches into mm', () => {
    const a = loadGcode('G20 G90\nM3 S1000\nG0 X0 Y0 Z0.1\nG1 X2 Y1 Z-0.05 F10');
    close(a.bounds!.max, [50.8, 25.4, 2.54]);
    close(a.bounds!.min, [0, 0, -1.27]);
  });

  it('follows a full circle, not just its end point', () => {
    const a = loadGcode('M3S1\nG0X10Y0Z0\nG2X10Y0I-10J0F500');
    close(a.bounds!.min, [-10, -10, 0]);
    close(a.bounds!.max, [10, 10, 0]);
    expect(a.segCut.length).toBeGreaterThan(20);
  });

  it('works out an arc given by its radius, both ways round', () => {
    // Quarter circle from (10,0) to (0,10) about the origin, anticlockwise.
    const ccw = loadGcode('M3S1\nG0X10Y0Z0\nG3X0Y10R10F500');
    close(ccw.bounds!.max, [10, 10, 0]);
    close(ccw.bounds!.min, [0, 0, 0]);
    // Clockwise with the same radius bulges the other way, around (10,10).
    const cw = loadGcode('M3S1\nG0X10Y0Z0\nG2X0Y10R10F500');
    close(cw.bounds!.min, [0, 0, 0]);
    expect(cw.bounds!.max[0]).toBeCloseTo(10, 3);
    const mid = cw.seg.slice(6 * Math.floor(cw.segCut.length / 2), 6 * Math.floor(cw.segCut.length / 2) + 2);
    expect(Math.hypot(mid[0] - 10, mid[1] - 10)).toBeCloseTo(10, 2);
  });

  it('follows relative moves', () => {
    const a = loadGcode('M3S1\nG90G0X10Y10Z0\nG91\nG1X5F100\nG1Y-20\nG90');
    close(a.bounds!.min, [10, -10, 0]);
    close(a.bounds!.max, [15, 10, 0]);
  });

  it('estimates time from distance and speed', () => {
    const a = loadGcode('M3S1\nG0X0Y0Z0\nG1X60F600');
    expect(a.seconds).toBeCloseTo(6 * 1.15, 2);
    expect(describeTime(30)).toBe('less than a minute');
    expect(describeTime(240)).toBe('about 4 minutes');
    expect(describeTime(3900)).toBe('about 1 hour 5 min');
  });

  it('does not draw a jump from nowhere before the file says where the bit is', () => {
    const a = loadGcode('M3S1\nG0Z5\nG0X20Y20\nG1Z-1F100\nG1X30');
    close(a.bounds!.min, [20, 20, -1]);
  });

  it('catches files the machine would reject, before cutting', () => {
    const noFeed = loadGcode('M3S1\nG0X0Y0\nG1X10');
    expect(noFeed.issues.some((i) => i.level === 'stop' && /how fast/.test(i.text))).toBe(true);
    const canned = loadGcode('M3S1\nG0X0Y0\nG81X1Y1Z-1R1F100');
    expect(canned.issues.some((i) => i.level === 'stop' && /G81, line 3/.test(i.text))).toBe(true);
    const long = loadGcode(`M3S1\nG0X0Y0\nG1F100${'X1.123456'.repeat(10)}`);
    expect(long.issues.some((i) => i.level === 'stop' && /too long/.test(i.text))).toBe(true);
    expect(loadGcode('hello world').issues[0].level).toBe('stop');
  });

  it('skips one tool change but refuses several', () => {
    const one = loadGcode('T1M6\nM3S1\nG0X0Y0\nG1X5F100');
    expect(one.lines[0]).toBe('T1');
    expect(one.issues.every((i) => i.level === 'info')).toBe(true);
    const two = loadGcode('T1M6\nM3S1\nG0X0Y0\nG1X5F100\nT2M06\nG1X9');
    expect(two.issues.some((i) => i.level === 'stop' && /2 bit changes/.test(i.text))).toBe(true);
  });

  it('warns when the spindle is never switched on, and never sends $ lines', () => {
    const a = loadGcode('$H\n$32=1\nG0X0Y0\nG1X5F100');
    expect(a.lines).toEqual(['G0X0Y0', 'G1X5F100']);
    expect(a.sourceLine).toEqual([3, 4]);
    expect(a.issues.some((i) => i.level === 'check' && /spindle/.test(i.text))).toBe(true);
  });
});

describe('will it fit?', () => {
  const coaster = loadGcode(sampleGcode()).bounds!;

  it('accepts a job that fits', () => {
    expect(checkSize(coaster, CUBIKO_TRAVEL)).toEqual([]);
    expect(checkPlacement(coaster, [10, 10, -20], CUBIKO_TRAVEL)).toEqual([]);
  });

  it('refuses a job bigger than the machine', () => {
    const big = loadGcode('M3S1\nG0X0Y0Z0\nG1X160Y20F100').bounds!;
    const p = checkSize(big, CUBIKO_TRAVEL);
    expect(p).toHaveLength(1);
    expect(p[0].text).toContain('160 mm wide');
    expect(p[0].text).toContain('152 mm');
  });

  it('says which way to move the material and by how much', () => {
    const right = checkPlacement(coaster, [110, 10, -20], CUBIKO_TRAVEL);
    expect(right).toHaveLength(1);
    expect(right[0]).toMatchObject({ axis: 0, kind: 'high' });
    expect(right[0].text).toContain('8 mm past the right edge');
    expect(right[0].text).toContain('to the left');
    const back = checkPlacement(coaster, [10, 70, -20], CUBIKO_TRAVEL);
    expect(back[0].text).toContain('7 mm past the back edge');
  });

  it('checks the height both ways', () => {
    // Zero only 3 mm below the top, but the file lifts 5 mm.
    const high = checkPlacement(coaster, [10, 10, -3], CUBIKO_TRAVEL);
    expect(high[0]).toMatchObject({ axis: 2, kind: 'high' });
    expect(high[0].text).toContain('only 3 mm of room');
    // Zero right at the bottom of travel: no room to cut down.
    const low = checkPlacement(coaster, [10, 10, -38.5], CUBIKO_TRAVEL);
    expect(low[0]).toMatchObject({ axis: 2, kind: 'low' });
    // X and Y can be checked before the height is known.
    expect(checkPlacement(coaster, [10, 10, 0], CUBIKO_TRAVEL, [true, true, false])).toEqual([]);
  });
});

describe('carrying on from a line', () => {
  const a = loadGcode(sampleGcode());

  it('backs up a little from where it stopped', () => {
    expect(resumeLineFor(100)).toBe(60);
    expect(resumeLineFor(10)).toBe(0);
  });

  it('starts from the top when asked for line 0', () => {
    expect(buildResume(a, 0)).toEqual({ lines: a.lines, lead: 0 });
  });

  it('puts the spindle, position, depth and speed back before carrying on', () => {
    // Resume in the middle of the first outline pass: 'G1X50Y45' follows a G3 with modal feed 300.
    const from = a.lines.indexOf('G1X50Y45');
    const r = buildResume(a, from);
    const lead = r.lines.slice(0, r.lead);
    expect(lead.slice(0, 5)).toEqual(['G21', 'G90', 'G54', 'G17', 'G94']);
    expect(lead).toContain('G0Z5');
    expect(lead).toContain('G0X50Y5');
    expect(lead).toContain('M3S10000');
    expect(lead).toContain('G1Z-0.5F150');
    expect(lead[lead.length - 1]).toBe('F300');
    // Safe order: up, across, spindle, then down.
    expect(lead.indexOf('G0Z5')).toBeLessThan(lead.indexOf('G0X50Y5'));
    expect(lead.indexOf('M3S10000')).toBeLessThan(lead.indexOf('G1Z-0.5F150'));
    expect(r.lines.slice(r.lead)).toEqual(a.lines.slice(from));
  });

  it('says the motion type out loud when the next line relies on an earlier one', () => {
    const b = loadGcode('M3S500\nG0X0Y0Z2\nG1Z-1F100\nX10\nX20\nY10');
    const r = buildResume(b, 4);
    expect(r.lines[r.lead]).toBe('G1X20');
    expect(r.lines[r.lead + 1]).toBe('Y10');
  });

  it('hands an inch file back in inches', () => {
    const b = loadGcode('G20\nM3S500\nG0X0Y0Z0.2\nG1Z-0.1F10\nG1X1\nG1X2');
    const r = buildResume(b, 5);
    const lead = r.lines.slice(0, r.lead);
    expect(lead).toContain('G0X25.4Y0');
    expect(lead).toContain('G1Z-2.54F150');
    expect(lead.slice(-2)).toEqual(['G20', 'F10']);
  });
});
