import type { Palette } from './lib';

/** +1% 이상 오르면 영웅 개미, -1% 이하로 내리면 눈물 개미 */
export const ANT_T = 1;

type AntColor = { body: string; line: string; cape: string; eye: string; tear: string; lw: number };
const COLORS: Record<Palette, AntColor> = {
  cream: { body: '#3a2616', line: '#3a2616', cape: '#e8433a', eye: '#ffffff', tear: '#3fa9f5', lw: 2.6 },
  white: { body: '#26201c', line: '#26201c', cape: '#e8433a', eye: '#ffffff', tear: '#3b9eff', lw: 2.4 },
  // 밤하늘에서는 몸이 바탕에 묻히지 않게 밝은 테두리를 쓴다
  night: { body: '#140b07', line: '#eef1f8', cape: '#ffc93c', eye: '#ffffff', tear: '#7fd0ff', lw: 2.6 },
};

export function HeroAnt({ palette }: { palette: Palette }) {
  const a = COLORS[palette];
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <g stroke={a.line} strokeWidth={a.lw} strokeLinecap="round" strokeLinejoin="round">
        <path className="cape" d="M35 44 Q50 37 65 44 L82 95 Q50 87 18 95 Z" fill={a.cape} />
        <path d="M36 72 L22 80 M64 72 L78 80 M43 86 L38 98 M57 86 L62 98 M41 50 L28 36 M59 52 L70 61 L63 66" fill="none" />
        <ellipse cx="50" cy="75" rx="15" ry="14" fill={a.body} />
        <ellipse cx="50" cy="54" rx="10" ry="9" fill={a.body} />
        <circle cx="27" cy="33" r="5" fill={a.body} />
        <path d="M44 18 Q38 5 30 7 M56 18 Q62 5 70 7" fill="none" />
        <circle cx="30" cy="7" r="3" fill={a.body} />
        <circle cx="70" cy="7" r="3" fill={a.body} />
        <circle cx="50" cy="31" r="15" fill={a.body} />
        <path d="M35 27 Q50 21 65 27 L65 34 Q50 30 35 34 Z" fill={a.cape} />
      </g>
      <circle cx="44" cy="30" r="3" fill={a.eye} />
      <circle cx="56" cy="30" r="3" fill={a.eye} />
      <path d="M44 38 Q50 43.5 56 38" fill="none" stroke={a.eye} strokeWidth="2.6" strokeLinecap="round" />
      <path d="M50 48.5 l2.3 4.6 5.1.7 -3.7 3.6.9 5.1 -4.6-2.4 -4.6 2.4.9-5.1 -3.7-3.6 5.1-.7z" fill="#ffd23f" />
    </svg>
  );
}

export function SadAnt({ palette }: { palette: Palette }) {
  const a = COLORS[palette];
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <g stroke={a.line} strokeWidth={a.lw} strokeLinecap="round" strokeLinejoin="round">
        <path d="M36 76 L24 86 M64 76 L76 86 M43 89 L40 98 M57 89 L60 98 M41 56 L33 68 M59 56 L67 68" fill="none" />
        <ellipse cx="50" cy="78" rx="15" ry="13" fill={a.body} />
        <ellipse cx="50" cy="58" rx="10" ry="9" fill={a.body} />
        <path d="M44 21 Q33 14 29 27 M56 21 Q67 14 71 27" fill="none" />
        <circle cx="29" cy="28" r="3" fill={a.body} />
        <circle cx="71" cy="28" r="3" fill={a.body} />
        <circle cx="50" cy="36" r="15" fill={a.body} />
      </g>
      <circle cx="43.5" cy="34" r="5.2" fill={a.eye} />
      <circle cx="56.5" cy="34" r="5.2" fill={a.eye} />
      <circle cx="43.5" cy="36.2" r="2.5" fill={a.body} />
      <circle cx="56.5" cy="36.2" r="2.5" fill={a.body} />
      <path d="M37 26 L45 28.5 M63 26 L55 28.5" stroke={a.eye} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M44.5 45.5 Q50 40.5 55.5 45.5" fill="none" stroke={a.eye} strokeWidth="2.6" strokeLinecap="round" />
      <path className="tear" d="M39.5 40 q-3.4 5.6 0 7.6 q3.4-2 0-7.6z" fill={a.tear} />
      <path className="tear t2" d="M60.5 40 q-3.4 5.6 0 7.6 q3.4-2 0-7.6z" fill={a.tear} />
    </svg>
  );
}
