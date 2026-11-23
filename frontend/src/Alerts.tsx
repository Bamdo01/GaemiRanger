import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { post, put, usePoll, useServer, useStream } from './api';

// 알림함과 알림 기준. 서버가 1분마다 보고(급등락·거래량·뉴스·공시·오늘 손익·규칙), 텔레그램으로도 보낸다.
// AI 요약은 사건이 있을 때만 붙는다 (시간당 상한).

export type AlertItem = { id: string; at: string; kind: string; code: string; name: string; title: string; detail: string; link: string; ai: string; mute?: boolean };
type Settings = { enabled: boolean; movePct: number; moveMin: number; volX: number; news: boolean; disclosure: boolean; dayPct: number; aiPerHour: number; telegram: boolean; quietNight: boolean };
type Status = { lastRun: number; lastError: string; news: string; dart: string; telegram: boolean; ai: boolean; aiUsed: number; watching: number };
type View = { items: AlertItem[]; settings: Settings; status: Status };

const KIND: Record<string, string> = { move: '급등락', volume: '거래량', news: '뉴스', disclosure: '공시', day: '오늘 손익', rule: '규칙', test: '시험' };

function useAlerts(limit: number) {
  const { live } = useServer();
  const { alert } = useStream();
  return usePoll<View>(live ? `/api/alerts?limit=${limit}&v=${alert}` : null, 60_000);
}

function when(at: string): string {
  const d = at.slice(0, 10);
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return d === today ? at.slice(11, 16) : `${at.slice(5, 7)}/${at.slice(8, 10)} ${at.slice(11, 16)}`;
}

/** 내 자산 화면의 알림함 */
export function AlertsCard() {
  const v = useAlerts(15);
  const [open, setOpen] = useState<string>('');
  const items = v.data?.items ?? [];
  const st = v.data?.status;
  return (
    <section className="card alerts" aria-labelledby="h-alerts">
      <div className="card-head">
        <h2 id="h-alerts">알림</h2>
        <span className="sub">{st ? (st.lastRun ? `1분마다 확인 · ${st.watching}종목` : '시작하는 중') : ''}</span>
        <span className="grow" />
        <Link to="/settings#alerts" className="link">
          기준
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="sub">{v.error ? `불러오지 못했습니다: ${v.error}` : '아직 알림이 없습니다. 보유 종목이 크게 움직이거나 새 뉴스·공시가 나오면 여기와 텔레그램으로 옵니다.'}</p>
      ) : (
        <ul className="al-list" aria-live="polite">
          {items.map((a) => (
            <li key={a.id} className={`al al-${a.kind}${a.mute ? ' al-mute' : ''}`}>
              <button type="button" className="al-row" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? '' : a.id)}>
                <span className="al-time num">{when(a.at)}</span>
                <span className="al-kind">{KIND[a.kind] ?? a.kind}</span>
                <span className="al-title">{a.title}</span>
                {a.ai && <span className="al-ai" title="AI 요약 있음">AI</span>}
              </button>
              {open === a.id && (
                <div className="al-more">
                  {a.detail && <p className="sub">{a.detail}</p>}
                  {a.link && (
                    <a href={a.link} target="_blank" rel="noreferrer noopener" className="link">
                      원문 보기
                    </a>
                  )}
                  {a.ai ? (
                    <div className="al-aitext">
                      <b>AI 요약 (참고용)</b>
                      {a.ai
                        .split('\n')
                        .map((l) => l.replace(/^[-•]\s*/, '').trim())
                        .filter(Boolean)
                        .map((l, i) => (
                          <p key={i}>{l}</p>
                        ))}
                    </div>
                  ) : (
                    a.kind !== 'test' && <p className="sub">AI 요약 없음 (시간당 상한을 넘었거나 텔레그램으로만 보낸 알림)</p>
                  )}
                  {a.code && /^[0-9][0-9A-Z]{5}$/.test(a.code) && (
                    <Link to={`/stock/${a.code}`} className="link">
                      {a.name || a.code} 화면
                    </Link>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 설정 화면의 알림 기준 */
export function AlertSettings() {
  const v = useAlerts(1);
  const s = v.data?.settings;
  const st = v.data?.status;
  const [f, setF] = useState<Settings | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s && !f) setF(s);
  }, [s, f]);
  if (!f || !st) return null;
  const changed = s && JSON.stringify(s) !== JSON.stringify(f);
  const num = (k: 'movePct' | 'moveMin' | 'volX' | 'dayPct' | 'aiPerHour', label: string, unit: string, step = 0.5) => (
    <label className="dr-field">
      <span>{label}</span>
      <span className="set-num">
        <input className="in num" type="number" inputMode="decimal" step={step} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />
        {unit}
      </span>
    </label>
  );
  const chk = (k: 'enabled' | 'news' | 'disclosure' | 'telegram' | 'quietNight', label: string, note = '') => (
    <label className="set-check">
      <input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />
      {label} {note && <span className="sub">{note}</span>}
    </label>
  );
  return (
    <section className="card" id="alerts" aria-labelledby="h-alset">
      <div className="card-head">
        <h2 id="h-alset">알림 기준</h2>
        <span className="sub">서버가 1분마다 확인</span>
      </div>
      <form
        className="dr-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMsg('');
          try {
            const r = await put<View>('/api/alerts/settings', f);
            setF(r.settings);
            setMsg('저장했습니다');
          } catch (e2) {
            setMsg(`안 됨: ${e2 instanceof Error ? e2.message : String(e2)}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        {chk('enabled', '알림 켜기')}
        {num('movePct', '급등락 기준', '%')}
        {num('moveMin', '몇 분 사이', '분', 1)}
        {num('volX', '거래량 급증 (오늘 평균의)', '배')}
        {num('dayPct', '내 자산 오늘 손익 (몇 %마다)', '%')}
        {chk('news', '보유 종목 새 뉴스', '(종목마다 텔레그램은 30분에 한 번)')}
        {chk('disclosure', '보유 종목 새 공시', st.dart && !st.dart.startsWith('정상') ? `(${st.dart})` : '')}
        {chk('telegram', '텔레그램으로 받기', st.telegram ? '' : '(봇 미연결)')}
        {chk('quietNight', '밤 11시~아침 7시는 소리 없이')}
        {num('aiPerHour', 'AI 요약 시간당 최대 (0 이면 끔)', '번', 1)}
        {msg && <p className={msg.startsWith('안 됨') ? 'o-warn' : 'o-ok'}>{msg}</p>}
        <div className="em-form">
          <button type="submit" className="btn pri" disabled={busy || !changed}>
            저장
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              setMsg('');
              try {
                const r = await post<{ telegram: boolean }>('/api/alerts/test', {});
                setMsg(r.telegram ? '시험 알림을 보냈습니다. 텔레그램과 내 자산 화면의 알림을 확인하세요.' : '시험 알림을 알림함에 넣었습니다 (텔레그램은 꺼져 있음).');
              } catch (e2) {
                setMsg(`안 됨: ${e2 instanceof Error ? e2.message : String(e2)}`);
              }
            }}
          >
            시험 알림 보내기
          </button>
        </div>
      </form>
      <dl className="kv set-kv">
        <div>
          <dt>마지막 확인</dt>
          <dd>{st.lastRun ? new Date(st.lastRun * 1000).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' }) : '아직'}{st.lastError && <span className="dn"> · {st.lastError}</span>}</dd>
        </div>
        <div>
          <dt>뉴스</dt>
          <dd>{st.news || '아직'}</dd>
        </div>
        <div>
          <dt>공시</dt>
          <dd>{st.dart || '아직'}</dd>
        </div>
        <div>
          <dt>AI 요약</dt>
          <dd>{st.ai ? `이번 시간 ${st.aiUsed}/${f.aiPerHour}번` : '꺼짐'}</dd>
        </div>
      </dl>
    </section>
  );
}
