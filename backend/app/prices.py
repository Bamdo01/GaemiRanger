"""수기 자산의 시세를 자동으로: 해외주식·환율은 한투, 코인은 업비트 공개 시세.

- 2026-11-22 확인: 한투 모의에서 해외주식 현재체결가(HHDFS00000300)와 환율(FHKST03030100, FX@KRW)이 된다
- 업비트 공개 시세(https://api.upbit.com/v1/ticker)는 키 없이 받는다. 원화 마켓(KRW-코인)만 쓴다
- 자동 시세가 없을 때만 사람이 넣은 현재가·환율을 쓴다 (ledger.py)
"""

import asyncio
import time
from datetime import date, timedelta

import httpx

from .kis import KISError, kis

OVERSEAS = "/uapi/overseas-price/v1/quotations/price"
DAILY_FX = "/uapi/overseas-price/v1/quotations/inquire-daily-chartprice"
UPBIT = "https://api.upbit.com/v1"
EXCHANGES = ("NAS", "NYS", "AMS")  # 나스닥, 뉴욕, 아멕스 순서로 찾아본다

fx: dict = {}  # {"usd": 1346.0, "prev": 1334.1, "at": ...}
overseas: dict[str, dict] = {}  # 티커 → {"price", "prev", "excd", "at"} (달러)
coins: dict[str, dict] = {}  # 코인 → {"price", "prev", "at"} (원)
gold: dict[str, dict] = {}  # 금시장 코드 → {"price", "prev", "at"} (g당 원)
_excd: dict[str, str] = {}  # 티커 → 찾은 거래소 ("" 이면 못 찾음)
_upbit_markets: tuple[float, set[str]] = (0, set())
wake = asyncio.Event()  # 새 기록이 들어오면 바로 한 번 돈다
_http: httpx.AsyncClient | None = None


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=10)
    return _http


async def fetch_fx() -> None:
    today = date.today()
    d = await kis.get(
        DAILY_FX,
        "FHKST03030100",
        {"FID_COND_MRKT_DIV_CODE": "X", "FID_INPUT_ISCD": "FX@KRW", "FID_INPUT_DATE_1": (today - timedelta(days=10)).strftime("%Y%m%d"), "FID_INPUT_DATE_2": today.strftime("%Y%m%d"), "FID_PERIOD_DIV_CODE": "D"},
    )
    o = d.get("output1") or {}
    v = _f(o.get("ovrs_nmix_prpr"))
    if v > 0:
        fx.update(usd=v, prev=_f(o.get("ovrs_nmix_prdy_clpr")) or v, at=time.time())


async def fetch_overseas(sym: str) -> None:
    tries = [_excd[sym]] if _excd.get(sym) else EXCHANGES
    for ex in tries:
        try:
            o = (await kis.get(OVERSEAS, "HHDFS00000300", {"AUTH": "", "EXCD": ex, "SYMB": sym})).get("output") or {}
        except KISError:
            continue
        last = _f(o.get("last"))
        if last > 0:
            _excd[sym] = ex
            overseas[sym] = {"price": last, "prev": _f(o.get("base")) or last, "excd": ex, "at": time.time()}
            return
    if not _excd.get(sym):
        _excd[sym] = ""  # 세 거래소 다 없음 → 다음부터는 사람이 넣은 현재가


async def fetch_coins(syms: list[str]) -> None:
    global _upbit_markets
    if time.time() - _upbit_markets[0] > 86400:
        r = await http().get(f"{UPBIT}/market/all")
        _upbit_markets = (time.time(), {m["market"] for m in r.json() if m["market"].startswith("KRW-")})
    markets = [f"KRW-{s}" for s in syms if f"KRW-{s}" in _upbit_markets[1]]
    if not markets:
        return
    r = await http().get(f"{UPBIT}/ticker", params={"markets": ",".join(markets)})
    for t in r.json():
        coins[t["market"][4:]] = {"price": _f(t["trade_price"]), "prev": _f(t["prev_closing_price"]), "at": time.time()}


async def fetch_gold(code: str) -> None:
    """KRX 금현물 g당 시세 (한투 국내주식 현재가 API, 공식 문서에 없는 사용이라 실패하면 사람이 넣은 값)"""
    o = (await kis.get("/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code})).get("output") or {}
    p = _f(o.get("stck_prpr"))
    if p > 0:
        gold[code] = {"price": p, "prev": _f(o.get("stck_sdpr")) or p, "at": time.time()}


def _symbols() -> tuple[list[str], list[str], bool]:
    from . import ledger  # ledger 가 prices 를 부르므로 여기서 늦게

    from . import market

    # 수기 계좌 + 한투 연동 계좌의 해외 종목
    kis_us = [o["symbol"] for o in market.balance.get("overseas", [])]
    for o in market.balance.get("overseas", []):
        if o.get("excd"):
            _excd.setdefault(o["symbol"], o["excd"])
    us = list(dict.fromkeys(ledger.symbols("us") + kis_us))
    return us, ledger.symbols("coin"), ledger.uses_usd() or bool(kis_us) or bool(market.balance.get("usdCash"))


def _gold_symbols() -> list[str]:
    from . import ledger

    return ledger.symbols("gold")


def market_open() -> bool:
    from .market import market_open as mo

    return mo()


async def poll_forever() -> None:
    from . import config

    last_fx = last_os = last_gold = 0.0
    while True:
        us, cs, need_fx = _symbols()
        try:
            stale = [c for c in cs if not (coins.get(c, {}).get("live") and time.time() - coins[c]["at"] < 30)]
            if stale:
                await fetch_coins(stale)
        except (httpx.HTTPError, ValueError, KeyError):
            pass
        now = time.time()
        if config.kis_configured():
            try:
                if need_fx and now - last_fx > 60:
                    await fetch_fx()
                    last_fx = now
                golds = _gold_symbols()
                if golds and now - last_gold > (15 if market_open() else 600):
                    for g in golds:
                        await fetch_gold(g)
                    last_gold = now
                if us and (now - last_os > 60 or any(s not in overseas and s not in _excd for s in us)):
                    for s in us:
                        o = overseas.get(s, {})
                        if o.get("live") and now - o["at"] < 60:
                            continue  # 실시간으로 받고 있음
                        await fetch_overseas(s)
                    last_os = now
            except KISError:
                pass
        wake.clear()
        try:
            await asyncio.wait_for(wake.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass


async def close() -> None:
    if _http is not None:
        await _http.aclose()
