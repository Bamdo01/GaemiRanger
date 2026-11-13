import { Link, Navigate, NavLink, Route, Routes, useParams } from 'react-router-dom';
import MarketPage from './MarketPage';
import { STOCK_BY_CODE } from './data';
import { useAnts, usePalette } from './hooks';
import { PALETTES } from './lib';

const MENU: [string, string][] = [
  ['market', '시장'],
  ['stock', '종목'],
  ['order', '주문'],
  ['account', '계좌'],
  ['rules', '규칙'],
  ['log', '기록'],
  ['settings', '설정'],
];

export default function App() {
  const [palette, setPalette] = usePalette();
  const [ants, setAnts] = useAnts();
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
        <span className="badge">모의</span>
        <div className="seg" role="group" aria-label="색 팔레트">
          {PALETTES.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={palette === id} onClick={() => setPalette(id)}>
              <i className={`dot dot-${id}`} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/market" replace />} />
          <Route path="/market" element={<MarketPage palette={palette} ants={ants} setAnts={setAnts} />} />
          <Route path="/stock/:code" element={<StockSoon />} />
          <Route path="/:menu" element={<MenuSoon />} />
        </Routes>
      </main>
    </div>
  );
}

function StockSoon() {
  const { code = '' } = useParams();
  const s = STOCK_BY_CODE.get(code);
  return (
    <div className="soon">
      <h1>{s ? `${s.name} (${code})` : code}</h1>
      <p>종목 페이지는 다음 차례로 정의하고 만듭니다.</p>
      <Link to="/market" className="btn">
        시장으로
      </Link>
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
