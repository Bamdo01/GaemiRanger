import { useEffect, useState } from 'react';
import { post, useServer } from './api';

type Wait = { wait: string; seconds: number };
type WaitState = { state: 'wait' | 'ok' | 'denied' | 'expired' | 'gone'; left?: number };

// 로그인: 비밀번호 → (텔레그램이 설정돼 있으면) 텔레그램 승인 대기. 텔레그램을 못 쓰면 비밀번호 + 복구 코드
export default function Login() {
  const { status, refresh } = useServer();
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState<{ secret: string; left: number } | null>(null);

  // 승인을 2초마다 확인
  useEffect(() => {
    if (!wait) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const r = await post<WaitState>('/api/login/wait', { wait: wait.secret });
        if (!alive) return;
        if (r.state === 'wait') setWait((w) => (w ? { ...w, left: r.left ?? w.left } : w));
        else {
          setWait(null);
          if (r.state === 'ok') {
            setPw('');
            await refresh();
          } else setErr(r.state === 'denied' ? '텔레그램에서 거절했습니다.' : '승인 시간이 지났습니다. 다시 로그인해 주세요.');
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    }, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [wait?.secret, refresh]);

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      if (useCode) {
        await post('/api/login/recovery', { password: pw, code });
        setPw('');
        setCode('');
        await refresh();
      } else {
        const r = await post<{ ok?: boolean } & Partial<Wait>>('/api/login', { password: pw });
        if (r.wait) setWait({ secret: r.wait, left: r.seconds ?? 120 });
        else {
          setPw('');
          await refresh();
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (wait)
    return (
      <div className="login">
        <div className="login-card" role="status" aria-live="polite">
          <span className="brand">개미레인저</span>
          <h1>텔레그램 승인 대기</h1>
          <p>텔레그램으로 로그인 요청을 보냈습니다. 봇 메시지에서 [승인]을 누르면 들어가집니다.</p>
          <p className="sub">남은 시간 {Math.floor(wait.left / 60)}:{String(wait.left % 60).padStart(2, '0')}</p>
          <button type="button" className="btn" onClick={() => setWait(null)}>
            취소
          </button>
        </div>
      </div>
    );

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="brand">개미레인저</span>
        <h1>{useCode ? '복구 코드로 로그인' : '로그인'}</h1>
        {!status.loginReady && <p className="o-warn">서버에 비밀번호가 아직 설정되지 않았습니다. backend/.env 의 APP_PASSWORD= 뒤에 비밀번호를 쓰고 서버를 다시 켜 주세요.</p>}
        <label htmlFor="pw">비밀번호</label>
        <input id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {useCode && (
          <>
            <label htmlFor="code">복구 코드 (한 번 쓰면 다시 못 씀)</label>
            <input id="code" autoComplete="one-time-code" placeholder="abcd-efgh" value={code} onChange={(e) => setCode(e.target.value)} />
          </>
        )}
        {err && (
          <p className="o-warn" role="alert">
            {err}
          </p>
        )}
        <button type="submit" className="btn pri" disabled={busy || !pw || (useCode && !code)}>
          {busy ? '확인 중…' : '들어가기'}
        </button>
        {status.telegram && !useCode && <p className="sub">비밀번호가 맞으면 텔레그램으로 승인 요청이 갑니다.</p>}
        {status.telegram && status.recovery && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setUseCode(!useCode);
              setErr('');
            }}
          >
            {useCode ? '텔레그램 승인으로 돌아가기' : '텔레그램을 쓸 수 없나요? 복구 코드로 들어가기'}
          </button>
        )}
      </form>
    </div>
  );
}
