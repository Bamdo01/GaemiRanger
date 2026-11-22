import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { post, useMode, useServer, useStream } from './api';
import AssetsPage from './AssetsPage';
import Login from './Login';
import MarketPage from './MarketPage';
import OrderPage from './OrderPage';
import RulesPage from './RulesPage';
import LogPage from './LogPage';
import SettingsPage from './SettingsPage';
import StockPage, { StockHome } from './StockPage';
import { usePalette } from './hooks';

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
  const palette = usePalette();
  const { status, live, checked, refresh } = useServer();
  const mode = useMode();
  const [more, setMore] = useState(false);
  const loc = useLocation();
  useEffect(() => setMore(false), [loc.pathname]);
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
        <span className={`badge ${live ? 'live' : ''}${live && mode.real ? ' real' : ''}`} title={status.kis?.lastError ?? undefined}>
          {live ? `${mode.name} · 한투 연결` : '예시 데이터'}
        </span>
        {status.server && (
          <button
            type="button"
            className="btn sm top-logout"
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
      {status.kis?.limits?.emergency && (
        <p className="emergency-banner" role="alert">
          비상 정지 중: 새 주문·정정이 막혀 있고 규칙이 멈춰 있습니다.{' '}
          <Link to="/settings" className="btn sm">
            설정에서 풀기
          </Link>
        </p>
      )}
      <PendingBanner />
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/market" replace />} />
          <Route path="/market" element={<MarketPage palette={palette} />} />
          <Route path="/assets" element={<AssetsPage palette={palette} />} />
          <Route path="/account" element={<Navigate to="/assets" replace />} />
          <Route path="/stock" element={<StockHome />} />
          <Route path="/stock/:code" element={<StockPage />} />
          <Route path="/order" element={<OrderPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/log" element={<LogPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/:menu" element={<MenuSoon />} />
        </Routes>
      </main>
      {/* 휴대폰: 아래 탭 (자주 쓰는 4개 + 더보기). 위쪽 메뉴는 숨긴다 */}
      <nav className="tabbar" aria-label="주 메뉴 (휴대폰)">
        {TABS.map(([id, label, icon]) => (
          <NavLink key={id} to={`/${id}`}>
            <span aria-hidden="true">{icon}</span>
            {label}
          </NavLink>
        ))}
        <button type="button" className={MORE.some(([id]) => loc.pathname.startsWith(`/${id}`)) ? 'active' : undefined} aria-expanded={more} onClick={() => setMore(!more)}>
          <span aria-hidden="true">☰</span>
          더보기
        </button>
      </nav>
      {more && (
        <div className="sheet-back" onClick={() => setMore(false)}>
          <div className="sheet" role="dialog" aria-label="더보기" onClick={(e) => e.stopPropagation()}>
            {MORE.map(([id, label]) => (
              <NavLink key={id} to={`/${id}`} className="sheet-item">
                {label}
              </NavLink>
            ))}
            {status.server && (
              <button
                type="button"
                className="sheet-item"
                onClick={async () => {
                  await post('/api/logout', {}).catch(() => undefined);
                  await refresh();
                }}
              >
                로그아웃
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const TABS: [string, string, string][] = [
  ['market', '시장', '▦'],
  ['stock', '종목', '◔'],
  ['assets', '내 자산', '◈'],
  ['rules', '규칙', '⚑'],
];
const MORE: [string, string][] = [
  ['order', '주문'],
  ['log', '기록'],
  ['settings', '설정'],
];


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

/** 규칙이 발동해 확인을 기다리면 어느 화면에서든 위에 알린다 (5분 안에 눌러야 나가므로) */
function PendingBanner() {
  const { rulesPending } = useStream();
  const loc = useLocation();
  if (!rulesPending || loc.pathname === '/rules') return null;
  return (
    <p className="pending-banner" role="alert">
      규칙이 발동해 확인을 기다리는 주문이 {rulesPending}건 있습니다. 5분 안에 확인하지 않으면 취소됩니다.{' '}
      <Link to="/rules" className="btn sm pri">
        확인하러 가기
      </Link>
    </p>
  );
}
