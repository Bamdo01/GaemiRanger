import { Link, Navigate, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { post, useServer } from './api';
import AssetsPage from './AssetsPage';
import Login from './Login';
import MarketPage from './MarketPage';
import StockPage, { StockHome } from './StockPage';
import { usePalette } from './hooks';
import { PALETTES } from './lib';

const MENU: [string, string][] = [
  ['market', '시장'],
  ['stock', '종목'],
  ['order', '주문'],
  ['assets', '내 자산'],
  ['rules', '규칙'],
  ['log', '기록'],
  ['settings', '설정'],
];

export default function App() {
  const [palette, setPalette] = usePalette();
  const { status, live, checked, refresh } = useServer();
  if (!checked) return null;
  // 서버가 있는데 로그인 안 했으면 로그인 화면만 (계좌 정보 보호)
  if (status.server && !status.loggedIn) return <Login />;
  const note = !status.server ? '예시 데이터 (서버 없음)' : !status.kis?.configured ? '예시 데이터 (한투 키 미설정)' : null;
  return (
    <div className="app">
      <header className="top">
        <Link to="/market" className="brand">
          개미레인저
        </Link>
        <nav aria-label="주 메뉴" className="nav">
          {MENU.map(([id, label]) => (
            <NavLink key={id} to={`/${id}`}>
              {label}
            </NavLink>
          ))}
        </nav>
        <span className="grow" />
        <span className={`badge ${live ? 'live' : ''}`} title={status.kis?.lastError ?? undefined}>
          {live ? '모의투자 · 한투 연결' : '모의 · 예시'}
        </span>
        <div className="seg" role="group" aria-label="색 팔레트">
          {PALETTES.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={palette === id} onClick={() => setPalette(id)}>
              <i className={`dot dot-${id}`} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        {status.server && (
          <button
            type="button"
            className="btn sm"
            onClick={async () => {
              await post('/api/logout', {}).catch(() => undefined);
              await refresh();
            }}
          >
            로그아웃
          </button>
        )}
      </header>
      {note && <p className="notice">{note}</p>}
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/market" replace />} />
          <Route path="/market" element={<MarketPage palette={palette} />} />
          <Route path="/assets" element={<AssetsPage palette={palette} />} />
          <Route path="/account" element={<Navigate to="/assets" replace />} />
          <Route path="/stock" element={<StockHome />} />
          <Route path="/stock/:code" element={<StockPage />} />
          <Route path="/:menu" element={<MenuSoon />} />
        </Routes>
      </main>
    </div>
  );
}


function MenuSoon() {
  const { menu = '' } = useParams();
  const label = MENU.find(([id]) => id === menu)?.[1] ?? menu;
  return (
    <div className="soon">
      <h1>{label}</h1>
      <p>아직 정의하지 않은 페이지입니다. 시장 → 종목 순서로 하나씩 정의하고 만듭니다.</p>
      <Link to="/market" className="btn">
        시장으로
      </Link>
    </div>
  );
}
