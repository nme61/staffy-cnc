// Staffy, the friendly Staffordshire bull terrier who guides you. Original artwork, GPL like the rest.
export type Mood = 'happy' | 'thinking' | 'worried';

export function Staffy({ size = 64, mood = 'happy' }: { size?: number; mood?: Mood }) {
  const mouth = {
    happy: 'M40 66 Q50 76 60 66',
    thinking: 'M42 68 L58 68',
    worried: 'M41 71 Q50 64 59 71',
  }[mood];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Staffy">
      {/* ears */}
      <path d="M18 30 Q14 8 34 18 Q30 30 26 38 Z" fill="#6f533f" />
      <path d="M82 30 Q86 8 66 18 Q70 30 74 38 Z" fill="#6f533f" />
      {/* wide staffy head */}
      <ellipse cx="50" cy="52" rx="36" ry="32" fill="#8a6a52" />
      {/* white blaze and muzzle */}
      <path d="M44 22 Q50 18 56 22 L58 50 Q50 54 42 50 Z" fill="#f4ede6" />
      <ellipse cx="50" cy="64" rx="22" ry="16" fill="#f4ede6" />
      {/* eyes */}
      <circle cx="35" cy="46" r="5" fill="#1d1d1f" />
      <circle cx="65" cy="46" r="5" fill="#1d1d1f" />
      <circle cx="36.5" cy="44.5" r="1.6" fill="#fff" />
      <circle cx="66.5" cy="44.5" r="1.6" fill="#fff" />
      {mood === 'worried' && <path d="M28 38 L40 41 M72 38 L60 41" stroke="#1d1d1f" strokeWidth="2.5" strokeLinecap="round" />}
      {/* nose */}
      <ellipse cx="50" cy="57" rx="7" ry="5" fill="#2b2b2b" />
      {/* mouth */}
      <path d={mouth} stroke="#2b2b2b" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      {mood === 'happy' && <path d="M46 70 Q50 80 54 70 Z" fill="#ff7a8a" />}
    </svg>
  );
}

/** Staffy says something. Used for guidance, never for errors without a fix. */
export function StaffySays({ children, mood = 'happy' }: { children: React.ReactNode; mood?: Mood }) {
  return (
    <div className="flex items-start gap-4">
      <div className="shrink-0"><Staffy size={72} mood={mood} /></div>
      <div className="relative rounded-2xl bg-card px-5 py-4 shadow-sm ring-1 ring-line">{children}</div>
    </div>
  );
}
