// A small, safe first job: a 50 mm coaster outline with a ring in the middle, 1 mm deep.
// Zero is the front-left corner, on top of the material.

export const SAMPLE_NAME = 'Sample coaster';

export function sampleGcode(): string {
  const out: string[] = [
    '(Staffy CNC sample: 50 mm coaster, 1 mm deep, 3 mm bit)',
    'G21 G90',
    'G0 Z5',
    'M3 S10000',
    'G4 P2',
  ];
  for (const depth of [0.5, 1]) {
    // ring, 30 mm across
    out.push('G0 X40 Y25', `G1 Z-${depth} F100`, 'G2 X40 Y25 I-15 J0 F300', 'G0 Z5');
    // outline with rounded corners
    out.push(
      'G0 X5 Y0', `G1 Z-${depth} F100`,
      'G1 X45 Y0 F300', 'G3 X50 Y5 I0 J5',
      'G1 X50 Y45', 'G3 X45 Y50 I-5 J0',
      'G1 X5 Y50', 'G3 X0 Y45 I0 J-5',
      'G1 X0 Y5', 'G3 X5 Y0 I5 J0',
      'G0 Z5',
    );
  }
  out.push('M5', 'G0 X0 Y0');
  return out.join('\n');
}
