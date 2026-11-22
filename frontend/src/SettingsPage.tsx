import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { post, put, refreshAll, usePoll, useServer } from './api';
import { fmt } from './lib';

// 설정: 비상 정지(C3), 주문 한도(C1), 로그인(C6), 연결 상태, 화면·모드(C5)
// 한도를 바꾸거나 비상 정지를 풀 때, 모든 기기 로그아웃은 비밀번호를 다시 받는다. 비상 정지 켜기는 바로
type S = {
  orderLimit: number;
  dailyMaxOrders: number;
  dailyMaxAmount: number;
  allowMarket: boolean;
  emergency: boolean;
  mode: string;
  kisConfigured: boolean;
  telegram: boolean;
  rulesHalted: boolean;
  realtime: { kis: string; upbit: string; slots: number; overflow: string[] };
  sessionHours: number;
};
type Log = { items: { at: string; type: string; text: string; by: string; result: string }[] };

export default function SettingsPage() {
  const { live, refresh } = useServer();
  const srv = usePoll<S>(live ? '/api/settings' : null, 10_000, true);
  const logins = usePoll<Log>(live ? '/api/log?days=30' : null, 60_000);
  const [msg, setMsg] = useState('');
  const s = srv.data;

  if (!live)
    return (
      <div className="soon">
        <h1>설정</h1>
        <p>설정은 서버에 저장됩니다. 서버에 연결해 로그인하면 바꿀 수 있습니다.</p>
      </div>
    );
  if (!s) return <div className="orders"><p className="sub">{srv.error ? `불러오지 못했습니다: ${srv.error}` : '불러오는 중…'}</p></div>;
  const done = async (m: string) => {
    setMsg(m);
    refreshAll();
    await refresh();
  };

  return (
    <div className="orders settings">
      {msg && (
        <p className={msg.startsWith('안 됨') ? 'o-warn' : 'o-ok'} role="status">
          {msg}
        </p>
      )}
      <Emergency s={s} onDone={done} />
      <div className="set-grid">
        <Limits s={s} onDone={done} />
        <section className="card">
          <div className="card-head">
            <h2>연결 상태</h2>
          </div>
          <dl className="kv set-kv">
            <Row k="거래 모드" v={s.mode === 'mock' ? '모의투자 (실전 전환은 점검표를 거친 뒤에 엶)' : s.mode} />
            <Row k="한투 연결" v={s.kisConfigured ? '키 설정됨' : '키 없음 (backend/.env)'} ok={s.kisConfigured} />
            <Row k="실시간 (한투)" v={s.realtime.kis === 'on' ? `연결 · ${s.realtime.slots}/41자리` : s.realtime.kis} ok={s.realtime.kis === 'on'} />
            <Row k="실시간 (업비트)" v={s.realtime.upbit === 'on' ? '연결' : s.realtime.upbit === 'off' ? '가진 코인 없음' : s.realtime.upbit} ok={s.realtime.upbit !== 'off' ? s.realtime.upbit === 'on' : undefined} />
            {s.realtime.overflow.length > 0 && <Row k="실시간 자리 부족" v={`${s.realtime.overflow.length}종목은 조회로 받는 중`} ok={false} />}
            <Row k="규칙" v={s.rulesHalted ? '모두 정지 중' : '감시 중'} ok={!s.rulesHalted} link={{ to: '/rules', label: '규칙 화면' }} />
            <Row k="텔레그램 알림" v={s.telegram ? '연결됨' : '꺼짐 (쓰지 않기로 함)'} />
            <Row k="화면 색" v="밤하늘 (고정)" />
          </dl>
        </section>
        <Login s={s} logins={(logins.data?.items ?? []).filter((x) => x.type === 'login').slice(0, 8)} onDone={done} />
      </div>
    </div>
  );
}

function Row({ k, v, ok, link }: { k: string; v: string; ok?: boolean; link?: { to: string; label: string } }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className={ok === undefined ? undefined : ok ? 'up' : 'dn'}>
        {v}
        {link && (
          <>
            {' '}
            <Link to={link.to} className="link">
              {link.label}
            </Link>
          </>
        )}
      </dd>
    </div>
  );
}

function Emergency({ s, onDone }: { s: S; onDone: (m: string) => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async (on: boolean) => {
    setBusy(true);
    setErr('');
    try {
      await post('/api/settings/emergency', { on, password: pw });
      setPw('');
      onDone(on ? '비상 정지를 켰습니다. 새 주문·정정이 막히고 규칙이 멈췄습니다.' : '비상 정지를 풀었습니다. 규칙은 규칙 화면에서 따로 다시 시작하세요.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`card emergency${s.emergency ? ' on' : ''}`} aria-labelledby="h-em">
      <div>
        <h2 id="h-em">비상 정지</h2>
        <p className="sub">
          {s.emergency
            ? '켜져 있습니다. 새 주문과 정정이 모두 막히고 규칙도 멈춰 있습니다. 취소는 됩니다.'
            : '누르면 바로 새 주문·정정을 모두 막고 규칙을 멈춥니다. 이미 낸 미체결은 주문 화면에서 취소하세요.'}
        </p>
      </div>
      {s.emergency ? (
        <form
          className="em-form"
          onSubmit={(e) => {
            e.preventDefault();
            go(false);
          }}
        >
          <input className="in" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비밀번호" aria-label="비밀번호 (풀 때만)" />
          <button type="submit" className="btn" disabled={busy || !pw}>
            풀기
          </button>
        </form>
      ) : (
        <div className="em-form">
          <button type="button" className="btn em-btn" disabled={busy} onClick={() => window.confirm('비상 정지를 켤까요? 새 주문·정정이 모두 막히고 규칙이 멈춥니다.') && go(true)}>
            비상 정지
          </button>
          <Link to="/order" className="btn sm">
            미체결 보기
          </Link>
        </div>
      )}
      {err && <p className="o-warn">{err}</p>}
    </section>
  );
}

function Limits({ s, onDone }: { s: S; onDone: (m: string) => void }) {
  const [f, setF] = useState({ orderLimit: String(s.orderLimit), dailyMaxOrders: String(s.dailyMaxOrders), dailyMaxAmount: String(s.dailyMaxAmount), allowMarket: s.allowMarket });
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setF({ orderLimit: String(s.orderLimit), dailyMaxOrders: String(s.dailyMaxOrders), dailyMaxAmount: String(s.dailyMaxAmount), allowMarket: s.allowMarket }), [s.orderLimit, s.dailyMaxOrders, s.dailyMaxAmount, s.allowMarket]);
  const n = (v: string) => Number(v.replace(/\D/g, '')) || 0;
  const changed = n(f.orderLimit) !== s.orderLimit || n(f.dailyMaxOrders) !== s.dailyMaxOrders || n(f.dailyMaxAmount) !== s.dailyMaxAmount || f.allowMarket !== s.allowMarket;
  const num = (k: 'orderLimit' | 'dailyMaxOrders' | 'dailyMaxAmount', label: string, unit: string) => (
    <label className="dr-field">
      <span>{label}</span>
      <span className="set-num">
        <input className="in num" inputMode="numeric" value={fmt(n(f[k]))} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        {unit}
      </span>
    </label>
  );
  return (
    <section className="card">
      <div className="card-head">
        <h2>주문 한도</h2>
        <span className="sub">서버가 모든 주문(규칙 포함)에 강제</span>
      </div>
      <form
        className="dr-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            await put('/api/settings', { password: pw, orderLimit: n(f.orderLimit), dailyMaxOrders: n(f.dailyMaxOrders), dailyMaxAmount: n(f.dailyMaxAmount), allowMarket: f.allowMarket });
            setPw('');
            onDone('한도를 저장했습니다');
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        {num('orderLimit', '1회 주문 금액', '원')}
        {num('dailyMaxOrders', '하루 주문 횟수', '번')}
        {num('dailyMaxAmount', '하루 주문 총액', '원')}
        <label className="set-check">
          <input type="checkbox" checked={f.allowMarket} onChange={(e) => setF({ ...f, allowMarket: e.target.checked })} />
          시장가 주문 허용 <span className="sub">(끄면 손절·익절 규칙의 시장가 매도도 막힘)</span>
        </label>
        {changed && (
          <label className="dr-field">
            <span>바꾸려면 비밀번호</span>
            <input className="in" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
        )}
        {err && <p className="o-warn">{err}</p>}
        <button type="submit" className="btn pri" disabled={busy || !changed || !pw}>
          저장
        </button>
      </form>
    </section>
  );
}

function Login({ s, logins, onDone }: { s: S; logins: { at: string; text: string; by: string; result: string }[]; onDone: (m: string) => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <section className="card">
      <div className="card-head">
        <h2>로그인</h2>
        <span className="sub">한 번 로그인하면 {s.sessionHours}시간 유지</span>
      </div>
      <ul className="login-list">
        {logins.length === 0 ? (
          <li className="sub">최근 로그인 기록이 없습니다</li>
        ) : (
          logins.map((x, i) => (
            <li key={i}>
              <span className="num">{x.at.slice(5, 16).replace('T', ' ')}</span>
              <span className={x.result === '실패' ? 'dn' : 'up'}>{x.text}</span>
              <span className="sub">{x.by}</span>
            </li>
          ))
        )}
      </ul>
      <Link to="/log?type=login&days=30" className="link">
        로그인 기록 모두 보기
      </Link>
      <form
        className="em-form set-logout"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr('');
          if (!window.confirm('이 기기를 포함해 모든 기기에서 로그아웃할까요? 다시 로그인해야 합니다.')) return;
          try {
            await post('/api/settings/logout-all', { password: pw });
            onDone('모든 기기에서 로그아웃했습니다');
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          }
        }}
      >
        <input className="in" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="비밀번호" aria-label="비밀번호" />
        <button type="submit" className="btn" disabled={!pw}>
          모든 기기 로그아웃
        </button>
      </form>
      {err && <p className="o-warn">{err}</p>}
      <p className="sub">비밀번호를 바꾸려면 backend/.env 의 APP_PASSWORD 를 고치고 서버를 다시 켜세요 (모든 로그인이 풀림).</p>
    </section>
  );
}
