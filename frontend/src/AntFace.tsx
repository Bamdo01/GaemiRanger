// 개미 얼굴 (2026-11-26): 그림 AI 없이 코드로 그린다.
// 몸 색 = 사용자가 고른 색, 머리 소품 = 역할 (전략가 베레모, 분석가 안경, 리스크 안전모, 결정자 왕관), 입 모양 = 성향
export const ANT_COLORS = ['#c0392b', '#d35400', '#b7950b', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#5d4037'];

type Props = { color?: number; role?: string; temper?: string; size?: number; title?: string; rest?: boolean };

export default function AntFace({ color = 0, role = 'analyst', temper = 'mid', size = 36, title, rest = false }: Props) {
  const c = ANT_COLORS[color % ANT_COLORS.length] ?? ANT_COLORS[0];
  return (
    <svg className="ant-face" width={size} height={size} viewBox="0 0 48 48" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} style={rest ? { filter: 'grayscale(1)', opacity: 0.55 } : undefined}>
      {/* 더듬이 */}
      <path d="M18 14 Q14 6 9 5" stroke={c} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <path d="M30 14 Q34 6 39 5" stroke={c} strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <circle cx="9" cy="5" r="2.6" fill={c} />
      <circle cx="39" cy="5" r="2.6" fill={c} />
      {/* 몸(아래)과 머리 */}
      <ellipse cx="24" cy="46" rx="13" ry="7" fill={c} opacity="0.85" />
      <circle cx="24" cy="26" r="14" fill={c} />
      <circle cx="24" cy="26" r="14" fill="url(#ant-shine)" />
      <defs>
        <radialGradient id="ant-shine" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* 눈 */}
      <ellipse cx="18.5" cy="24" rx="3.6" ry="4.2" fill="#fff" />
      <ellipse cx="29.5" cy="24" rx="3.6" ry="4.2" fill="#fff" />
      <circle cx={temper === 'cons' ? 18.5 : 19.3} cy="25" r="2" fill="#1b1b1b" />
      <circle cx={temper === 'cons' ? 29.5 : 30.3} cy="25" r="2" fill="#1b1b1b" />
      {/* 볼 */}
      <circle cx="14" cy="31" r="2.2" fill="#ff8a8a" opacity="0.45" />
      <circle cx="34" cy="31" r="2.2" fill="#ff8a8a" opacity="0.45" />
      {/* 입 (성향) */}
      {temper === 'cons' && <path d="M20 33 L28 33" stroke="#1b1b1b" strokeWidth="1.8" strokeLinecap="round" />}
      {temper === 'mid' && <path d="M19.5 32 Q24 36 28.5 32" stroke="#1b1b1b" strokeWidth="1.8" fill="none" strokeLinecap="round" />}
      {temper === 'aggr' && (
        <>
          <path d="M19 31.5 Q24 39 29 31.5 Z" fill="#1b1b1b" />
          <path d="M14.5 18.5 L21 20" stroke="#1b1b1b" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M33.5 18.5 L27 20" stroke="#1b1b1b" strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
      {/* 머리 소품 (역할) */}
      {role === 'strategist' && (
        <>
          <ellipse cx="22" cy="13.5" rx="11" ry="4.5" fill="#2c3e50" transform="rotate(-10 22 13.5)" />
          <circle cx="17" cy="10.5" r="1.6" fill="#2c3e50" />
        </>
      )}
      {role === 'analyst' && (
        <g stroke="#1b1b1b" strokeWidth="1.6" fill="none">
          <circle cx="18.5" cy="24.5" r="5.2" />
          <circle cx="29.5" cy="24.5" r="5.2" />
          <path d="M23.7 24.5 L24.3 24.5" />
        </g>
      )}
      {role === 'risk' && (
        <>
          <path d="M11 17 Q24 2 37 17 Z" fill="#f1c40f" />
          <rect x="9" y="16" width="30" height="3" rx="1.5" fill="#d4ac0d" />
        </>
      )}
      {role === 'manager' && <path d="M14 15 L16 7 L20 12 L24 5 L28 12 L32 7 L34 15 Z" fill="#f1c40f" stroke="#b7950b" strokeWidth="1" />}
    </svg>
  );
}
