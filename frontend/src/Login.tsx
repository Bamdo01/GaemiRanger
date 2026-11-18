import { useState } from 'react';
import { post, useServer } from './api';

export default function Login() {
  const { status, refresh } = useServer();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            await post('/api/login', { password: pw });
            setPw('');
            await refresh();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="brand">개미레인저</span>
        <h1>로그인</h1>
        {!status.loginReady && <p className="o-warn">서버에 비밀번호가 아직 설정되지 않았습니다. backend/.env 의 APP_PASSWORD= 뒤에 비밀번호를 쓰고 서버를 다시 켜 주세요.</p>}
        <label htmlFor="pw">비밀번호</label>
        <input id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && (
          <p className="o-warn" role="alert">
            {err}
          </p>
        )}
        <button type="submit" className="btn pri" disabled={busy || !pw}>
          {busy ? '확인 중…' : '들어가기'}
        </button>
      </form>
    </div>
  );
}
