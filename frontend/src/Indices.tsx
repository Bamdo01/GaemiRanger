import type { Index } from './data';
import { fmt2, signPct, tone, type MarketStatus } from './lib';

// 토스처럼 맨 위 한 줄: 국내·미국 장 상태와 주요 지수. 휴대폰에서는 옆으로 밀어 본다 (2026-11-24)
export default function MarketBar({ status, indices }: { status: MarketStatus; indices: Index[] }) {
  return (
    <div className="mbar" role="group" aria-label="장 상태와 지수">
      <Sess k="국내" s={status.kr} />
      <Sess k="미국" s={status.us} />
      {indices.map((i) => {
        const p = i.prev ? ((i.value - i.prev) / i.prev) * 100 : 0;
        return (
          <div key={i.id} className="mbar-i">
            <span className="mbar-k">{i.name}</span>
            <b className="num">{fmt2(i.value)}</b>
            <span className={`num ${tone(p)}`}>{signPct(p)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Sess({ k, s }: { k: string; s: MarketStatus['kr'] }) {
  const on = s.code !== 'closed';
  return (
    <div className={`mbar-s ${on ? 'on' : ''}`} title={on ? `${k} ${s.label} · 가격이 움직이는 중` : `${k} ${s.label}`}>
      <span className="mbar-dot" aria-hidden="true" />
      <span className="mbar-k">{k}</span>
      <b>{s.label}</b>
    </div>
  );
}
