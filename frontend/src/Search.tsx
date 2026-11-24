import { useEffect, useState } from 'react';
import { api, useServer } from './api';
import type { Stock } from './data';

type Hit = { code: string; name: string; market: string };

/** 종목 검색: 국내와 미국을 함께 (서버). 서버가 없으면 예시 50종목에서. 티커(AAPL)·코드(005930)는 목록에 없어도 연다 */
export default function SearchBox({ stocks, onGo }: { stocks: Stock[]; onGo: (code: string) => void }) {
  const { live } = useServer();
  const [q, setQ] = useState('');
  const [srv, setSrv] = useState<Hit[]>([]);
  const t = q.trim();
  useEffect(() => {
    if (!live || !t) {
      setSrv([]);
      return;
    }
    let off = false;
    const id = setTimeout(async () => {
      try {
        const r = await api<{ hits: Hit[] }>(`/api/search?q=${encodeURIComponent(t)}`);
        if (!off) setSrv(r.hits);
      } catch {
        /* 검색 실패는 조용히: 목록만 비운다 */
      }
    }, 150);
    return () => {
      off = true;
      clearTimeout(id);
    };
  }, [t, live]);
  const hits: Hit[] = live ? srv : t ? stocks.filter((x) => x.name.includes(t) || x.code.startsWith(t)).slice(0, 8).map((s) => ({ code: s.code, name: s.name, market: '코스피' })) : [];
  const go = (c: string) => {
    onGo(c);
    setQ('');
  };
  return (
    <div className="st-search">
      <label htmlFor="st-q" className="sr">
        종목 검색
      </label>
      <input
        id="st-q"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) go(hits[0].code);
        }}
        placeholder="종목명, 코드, 미국 티커"
        autoComplete="off"
      />
      {t && hits.length > 0 && (
        <ul className="st-hits" role="listbox" aria-label="검색 결과">
          {hits.map((h) => (
            <li key={h.code}>
              <button type="button" onClick={() => go(h.code)}>
                <span>{h.name}</span>
                <small className="num">
                  {h.market} · {h.code}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
