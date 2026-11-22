import { useEffect, useRef, useState } from 'react';
import { useStream } from './api';
import { arrow, fmt, signed, tone } from './lib';
import type { Portfolio, Row } from './portfolio';

// 실시간 시세가 내 자산(수기 포함)에 주는 영향 (2026-11-22 사용자: 실시간 정보가 수기 자산에 어떤 영향을 미치는지 알려 줘야)
// - 반짝임: 방금 가격이 바뀐 종목
// - 지금 움직임: 최근 1분 동안 총자산이 얼마 움직였고, 어떤 종목·계좌 때문인지

const WINDOW = 60_000;
type Sample = { t: number; px: Map<string, number> };

/** 방금 가격이 바뀐 종목 → 'up' | 'dn' (0.9초 동안) */
export function useFlash(rows: Row[]): Record<string, 'up' | 'dn'> {
  const prev = useRef(new Map<string, number>());
  const [flash, setFlash] = useState<Record<string, 'up' | 'dn'>>({});
  useEffect(() => {
    const now: Record<string, 'up' | 'dn'> = {};
    rows.forEach((r) => {
      const p = prev.current.get(r.code);
      if (p !== undefined && p !== r.s.price) now[r.code] = r.s.price > p ? 'up' : 'dn';
      prev.current.set(r.code, r.s.price);
    });
    if (!Object.keys(now).length) return;
    setFlash((f) => ({ ...f, ...now }));
    const id = setTimeout(() => setFlash((f) => Object.fromEntries(Object.entries(f).filter(([k]) => !(k in now)))), 900);
    return () => clearTimeout(id);
  }, [rows]);
  return flash;
}

function useHistory(rows: Row[]) {
  const hist = useRef<Sample[]>([]);
  const t = Date.now();
  const last = hist.current[hist.current.length - 1];
  const px = new Map(rows.map((r) => [r.code, r.s.price]));
  if (!last || [...px].some(([k, v]) => last.px.get(k) !== v) || t - last.t > 5000) hist.current.push({ t, px });
  hist.current = hist.current.filter((s) => t - s.t <= WINDOW + 5000);
  const base = hist.current.find((s) => t - s.t <= WINDOW) ?? hist.current[0];
  return { base, span: t - base.t };
}

export function MovesCard({ port }: { port: Portfolio }) {
  const { base, span } = useHistory(port.rows);
  const items = port.rows
    .map((r) => {
      const p0 = base.px.get(r.code) ?? r.s.price;
      const d = r.s.price - p0;
      return { r, delta: d * r.qty, perAcct: r.accounts.map((a) => ({ name: a.name, delta: d * a.qty })) };
    })
    .filter((x) => Math.abs(x.delta) >= 1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const total = items.reduce((a, x) => a + x.delta, 0);
  const accts = new Map<string, number>();
  items.forEach((x) => x.perAcct.forEach((a) => accts.set(a.name, (accts.get(a.name) ?? 0) + a.delta)));
  const secs = Math.max(1, Math.round(span / 1000));
  return (
    <section className="card moves" aria-labelledby="h-moves" aria-live="polite">
      <div className="card-head">
        <h2 id="h-moves">지금 움직임</h2>
        <span className="sub">{secs >= 60 ? '최근 1분' : `최근 ${secs}초`} · 실시간 시세 기준</span>
      </div>
      <p className={`mv-total ${tone(total)}`}>
        {arrow(total)} {signed(total)}원
      </p>
      {items.length === 0 ? (
        <p className="sub">이 사이 움직인 종목이 없습니다. 장이 닫혀 있으면 코인만 움직입니다.</p>
      ) : (
        <>
          <ul className="mv-list">
            {items.slice(0, 5).map((x) => (
              <li key={x.r.code}>
                <span>{x.r.s.name}</span>
                <b className={tone(x.delta)}>
                  {arrow(x.delta)} {signed(x.delta)}원
                </b>
              </li>
            ))}
          </ul>
          {accts.size > 1 && (
            <p className="sub mv-accts">
              계좌별:{' '}
              {[...accts].map(([n, d], i) => (
                <span key={n}>
                  {i > 0 && ' · '}
                  {n} <span className={tone(d)}>{signed(d)}원</span>
                </span>
              ))}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** "실시간 · 0.4초 전" / 끊김 표시 */
export function LiveBadge() {
  const st = useStream();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!st.connected)
    return (
      <span className="live-badge off" title="실시간 연결이 끊겨 10초마다 받고 있습니다">
        실시간 끊김 · 10초마다 받는 중
      </span>
    );
  const ago = st.at ? (Date.now() - st.at) / 1000 : null;
  const agoText = ago === null ? '아직 받은 값 없음' : ago < 60 ? `${ago.toFixed(ago < 10 ? 1 : 0)}초 전` : `${Math.floor(ago / 60)}분 전`;
  const title = `한투 ${st.kis === 'on' ? '연결' : st.kis} · 업비트 ${st.upbit === 'on' ? '연결' : st.upbit === 'off' ? '가진 코인 없음' : st.upbit}`;
  return (
    <span className="live-badge" title={title}>
      <i aria-hidden="true" /> 실시간 · {agoText}
      {st.overflow > 0 && <em> · 실시간 자리 부족 {fmt(st.overflow)}종목 (조회로 받는 중)</em>}
    </span>
  );
}
