"""시장 히트맵의 보기와 미국 종목 화면 (2026-11-24, 트레이딩뷰 목록을 참고해 지수별로).

- 코스피 50 은 market.py 의 UNIVERSE·quotes 를 그대로 쓴다
- 코스피 200·코스닥 150·S&P 500·나스닥 100·다우 30 은 members.py 의 구성종목
  - 국내 가격: 한투 멀티 시세 (30종목씩)
  - 미국 가격: 한투 해외 시가총액 순위를 쪽마다 넘겨 한꺼번에 (나스닥·뉴욕 각 최대 8쪽). 순위에 없는 종목만 종목별로
- 거래대금 30 은 한투 순위 API (코스피·코스닥 합쳐 ETF 빼고)
- 화면이 보고 있는 보기만 갱신한다 (안 보는 보기로 한투 호출을 쓰지 않게)
- 국내 업종은 종목별 조회로 조금씩 받아 data/sectors.json 에 둔다 (한 번에 많이 부르면 잔고·주문 조회가 밀린다)
- 미국 종목은 시세만. 주문은 아직 국내만
"""

import asyncio
import json
import re
import time

from . import config, market, members, prices
from .guard import is_etf
from .kis import KISError, kis
from .universe import NAMES, SECTORS, UNIVERSE

VIEWS = {
    "kospi50": "코스피 상위 50",
    "kospi200": "코스피 200",
    "kosdaq150": "코스닥 150",
    "value30": "거래대금 상위 30",
    "sp500": "S&P 500",
    "ndx": "나스닥 100",
    "dji": "다우존스 30",
}
US_VIEWS = ("sp500", "ndx", "dji")
KR_INDEX = ("kospi200", "kosdaq150")
lists: dict[str, dict] = {}  # 보기 → {"at": 받은 시각, "stocks": [...]}
_lock = asyncio.Lock()
SEC_FILE = config.DATA / "sectors.json"
_sec: dict[str, str] = {}
_us_names: dict[str, str] = {}  # 티커 → 한글 이름 (순위에서 본 것)
_us_px: dict[str, dict] = {}  # 티커 → 순위에서 받은 시세 {"price","prev","cap","name","excd","at"}
_us_px_at = [0.0]
_us_cache: dict[tuple, tuple[float, object]] = {}
EXCHANGES = ("NAS", "NYS", "AMS")
EX_NAME = {"NAS": "나스닥", "NYS": "뉴욕", "AMS": "아멕스"}
SECTOR_FILL_PER_ROUND = 12  # 국내 업종을 한 번 갱신할 때 새로 묻는 종목 수


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _sectors() -> dict[str, str]:
    if not _sec and SEC_FILE.exists():
        try:
            _sec.update(json.loads(SEC_FILE.read_text("utf-8")))
        except (OSError, ValueError):
            pass
    return _sec


def _save_sectors() -> None:
    try:
        SEC_FILE.write_text(json.dumps(_sec, ensure_ascii=False), "utf-8")
    except OSError:
        pass


def sector_of(code: str) -> str:
    return SECTORS.get(code) or _sectors().get(code) or (market.quotes.get(code) or {}).get("sector") or "기타"


async def _fill_kr_sectors(codes: list[str]) -> None:
    for code in codes:
        try:
            q = await market.fetch_quote(code)
        except KISError:
            continue
        _sec[code] = q.get("sector") or "기타"
    _save_sectors()


def _queue_kr_sectors(codes: list[str]) -> None:
    need = [c for c in codes if c not in SECTORS and c not in _sectors() and (market.quotes.get(c) or {}).get("sector") in (None, "", "기타")]
    if need:
        market._later("sec:kr", _fill_kr_sectors(need[:SECTOR_FILL_PER_ROUND]))


# ---------- 국내 ----------
async def _value30() -> list[dict]:
    """거래대금: 한 번에 30개라 ETF 를 빼면 모자라서 코스피·코스닥을 따로 받아 합친다"""
    rows: list[dict] = []
    for mk in ("0001", "1001"):
        part = await kis.get(
            "/uapi/domestic-stock/v1/quotations/volume-rank",
            "FHPST01710000",
            {"FID_COND_MRKT_DIV_CODE": "J", "FID_COND_SCR_DIV_CODE": "20171", "FID_INPUT_ISCD": mk, "FID_DIV_CLS_CODE": "1", "FID_BLNG_CLS_CODE": "3", "FID_TRGT_CLS_CODE": "111111111", "FID_TRGT_EXLS_CLS_CODE": "0000000000", "FID_INPUT_PRICE_1": "", "FID_INPUT_PRICE_2": "", "FID_VOL_CNT": "", "FID_INPUT_DATE_1": ""},
        )
        rows += part.get("output") or []
    rows.sort(key=lambda r: -_f(r.get("acml_tr_pbmn")))
    out = []
    for r in rows:
        if len(out) >= 30:
            break
        code = r.get("mksc_shrn_iscd", "")
        price = _f(r.get("stck_prpr"))
        if not code or not price or is_etf(r.get("hts_kor_isnm") or ""):
            continue  # 레버리지·인버스 ETF 는 히트맵에서 뺀다 (종목만)
        prev = price - _f(r.get("prdy_vrss"))
        out.append({"code": code, "name": NAMES.get(code) or r.get("hts_kor_isnm") or code, "sector": sector_of(code), "price": price, "prev": prev or price, "cap": _f(r.get("lstn_stcn")) * (prev or price) / 1e12, "vol": int(_f(r.get("acml_vol"))), "val": int(_f(r.get("acml_tr_pbmn"))) or None, "at": time.time()})
    _queue_kr_sectors([s["code"] for s in out])
    return out


async def _kr_index(view: str) -> list[dict]:
    mem = members.get(view)
    if not mem:
        return []
    codes = [m["code"] for m in mem]
    # 시세 캐시(quotes)를 30종목씩 채운다. 초당 건수 초과로 한 묶음이 실패하면 1초 쉬고 한 번 더 (2026-11-24 확인)
    for k in range(0, len(codes), 30):
        part = codes[k : k + 30]
        try:
            await market.fetch_multi(part)
        except KISError:
            await asyncio.sleep(1.1)
            try:
                await market.fetch_multi(part)
            except KISError:
                pass
    out = []
    for m in mem:
        q = market.quotes.get(m["code"])
        if not q or not q.get("price"):
            continue
        # 업종은 한투 마스터의 지수업종 (한 보기 안에서 같은 기준으로 묶이게)
        out.append({"code": m["code"], "name": NAMES.get(m["code"]) or m["name"], "sector": m.get("sector") or sector_of(m["code"]), "price": q["price"], "prev": q.get("prev") or q["price"], "cap": m.get("cap") or q.get("cap") or 0, "vol": q.get("vol"), "val": q.get("val"), "at": q.get("at", time.time())})
    return out


# ---------- 미국 ----------
async def _us_rank_pages(want: set[str]) -> None:
    """한투 해외 시가총액 순위를 쪽마다 (KEYB 에 받은 개수, tr_cont N. 2026-11-24 확인). 원하는 종목을 다 찾으면 멈춘다"""
    fx = prices.fx.get("usd") or 0
    found: set[str] = set()
    for ex in ("NAS", "NYS"):
        got = 0
        for page in range(8):
            args = ("/uapi/overseas-stock/v1/ranking/market-cap", "HHDFS76350100", {"EXCD": ex, "VOL_RANG": "0", "KEYB": str(got) if got else "", "AUTH": "", "CURR_GB": "0"})
            try:
                d = await kis.get(*args, tr_cont="N" if got else "")
            except KISError:
                await asyncio.sleep(1.1)  # 초당 건수 초과면 한 번 더
                d = await kis.get(*args, tr_cont="N" if got else "")
            fx = fx or _f((d.get("output1") or {}).get("t_rate"))
            rows = d.get("output2") or []
            now = time.time()
            for r in rows:
                sym, last, rate = r.get("symb", ""), _f(r.get("last")), _f(r.get("rate"))
                if not sym or not last:
                    continue
                _us_names[sym] = r.get("name") or sym
                prices._excd.setdefault(sym, r.get("excd") or ex)
                _us_px[sym] = {"price": last, "prev": last / (1 + rate / 100) if rate > -100 else last, "cap": _f(r.get("tomv")) * fx / 1e12, "name": r.get("name") or sym, "excd": r.get("excd") or ex, "vol": int(_f(r.get("tvol"))), "at": now}
                found.add(sym)
            got += len(rows)
            if len(rows) < 100 or want <= found:
                break
        if want <= found:
            break
    _us_px_at[0] = time.time()


async def _us_missing(syms: list[str]) -> None:
    """순위에 없던 종목 (작은 종목·아멕스 등)은 종목별 상세로 조금씩"""
    for s in syms[:10]:
        try:
            d = await us_detail(s)
        except KISError:
            continue
        fx = d.get("fx") or prices.fx.get("usd") or 0
        _us_px[s] = {"price": d["price"], "prev": d["prev"], "cap": d.get("capUsd", 0) * fx / 1e12, "name": d["name"], "excd": d["excd"], "vol": 0, "at": time.time()}


async def _us_index(view: str) -> list[dict]:
    mem = members.get(view)
    if not mem:
        return []
    want = {m["code"] for m in mem}
    moving = market.us_session()["code"] != "closed"
    if time.time() - _us_px_at[0] > (60 if moving else 1800) or not want <= set(_us_px):
        await _us_rank_pages(want)
    missing = [s for s in want if s not in _us_px]
    if missing:
        market._later(f"usmiss:{view}", _us_missing(missing))
    out = []
    for m in mem:
        p = _us_px.get(m["code"])
        if not p:
            continue
        sector = m.get("sector") or members.us_sector(m["code"]) or _sectors().get(f"us:{m['code']}") or "기타"
        out.append({"code": m["code"], "name": p["name"] or m["name"], "sector": sector, "price": p["price"], "prev": p["prev"], "cap": p["cap"], "vol": p.get("vol"), "cur": "USD", "excd": p["excd"], "at": p["at"]})
    return out


# ---------- 보기 ----------
def _kospi50() -> list[dict]:
    return [market.quotes[c] for c, _, _ in UNIVERSE if c in market.quotes]


def _stale(view: str) -> bool:
    hit = lists.get(view)
    if not hit:
        return True
    moving = market.us_session()["code"] != "closed" if view in US_VIEWS else market.kr_active()
    return time.time() - hit["at"] > (60 if moving else 1800)


async def refresh(view: str) -> None:
    await members.refresh()  # 하루 한 번 (오늘 받았으면 바로 끝)
    async with _lock:
        if not _stale(view):
            return
        if view == "value30":
            stocks = await _value30()
        elif view in KR_INDEX:
            stocks = await _kr_index(view)
        else:
            stocks = await _us_index(view)
        if stocks:
            lists[view] = {"at": time.time(), "stocks": stocks}


async def get_view(view: str) -> dict:
    """화면이 고른 보기의 종목. 처음이면 받아 올 때까지 기다리고, 그 뒤는 낡았으면 뒤에서 새로"""
    if view not in VIEWS:
        view = "kospi50"
    if view == "kospi50":
        stocks = _kospi50()
    else:
        if view not in lists:
            try:
                await refresh(view)
            except KISError:
                pass
        elif _stale(view):
            market._later(f"view:{view}", refresh(view))
        stocks = (lists.get(view) or {}).get("stocks", [])
        if view not in US_VIEWS:
            # 시세 캐시에 더 새 값이 있으면 그것으로 (보유 종목은 실시간으로 받고 있다)
            stocks = [{**s, **{k: market.quotes[s["code"]][k] for k in ("price", "prev") if s["code"] in market.quotes and market.quotes[s["code"]].get("at", 0) > s["at"]}, "sector": s["sector"] if view in KR_INDEX else sector_of(s["code"])} for s in stocks]
    total = len(members.get(view)) if view in KR_INDEX or view in US_VIEWS else len(stocks)
    return {"view": view, "views": VIEWS, "stocks": stocks, "total": total, "at": max([s.get("at", 0) for s in stocks], default=None)}


def kr_name(code: str) -> str:
    """국내 종목 이름: 단건 시세 응답에는 이름이 없어서 순위·잔고에서 본 이름으로"""
    for s in (lists.get("value30") or {}).get("stocks", []) + members.get("kospi200") + members.get("kosdaq150"):
        if s["code"] == code:
            return s["name"]
    for h in market.balance.get("holdings", []):
        if h.get("code") == code and h.get("name"):
            return h["name"]
    return ""


# ---------- 미국 종목 ----------
def is_us_symbol(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Z][A-Z0-9.\-/]{0,9}", s or ""))


async def _cached(key: tuple, ttl: float, make):
    hit = _us_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    v = await make()
    _us_cache[key] = (time.time(), v)
    return v


async def us_detail(sym: str) -> dict:
    sym = sym.upper()
    moving = market.us_session()["code"] != "closed"

    async def make():
        tries = [prices._excd[sym]] if prices._excd.get(sym) else list(EXCHANGES)
        for ex in tries:
            try:
                o = (await kis.get("/uapi/overseas-price/v1/quotations/price-detail", "HHDFS76200200", {"AUTH": "", "EXCD": ex, "SYMB": sym})).get("output") or {}
            except KISError:
                continue
            last = _f(o.get("last"))
            if last <= 0:
                continue
            prices._excd[sym] = ex
            name = _us_names.get(sym) or _held_name(sym) or await _us_name(sym, ex)
            return {
                "code": sym,
                "name": name,
                "excd": ex,
                "exName": EX_NAME.get(ex, ex),
                "sector": (o.get("e_icod") or "").strip(),
                "price": last,
                "prev": _f(o.get("base")) or last,
                "open": _f(o.get("open")),
                "high": _f(o.get("high")),
                "low": _f(o.get("low")),
                "w52h": _f(o.get("h52p")),
                "w52l": _f(o.get("l52p")),
                "per": _f(o.get("perx")),
                "pbr": _f(o.get("pbrx")),
                "eps": _f(o.get("epsx")),
                "capUsd": _f(o.get("tomv")),
                "fx": _f(o.get("t_rate")) or prices.fx.get("usd") or 0,
                "priceKrw": _f(o.get("t_xprc")),
                "tradable": "가능" in (o.get("e_ordyn") or ""),
                "cur": "USD",
                "at": time.time(),
            }
        return {}

    d = await _cached(("d", sym), 5 if moving else 60, make)
    if not d:
        raise KISError(f"{sym}: 나스닥·뉴욕·아멕스에서 찾지 못했습니다", "NOTFOUND")
    return d


def _held_name(sym: str) -> str:
    for o in market.balance.get("overseas", []):
        if o.get("symbol") == sym and o.get("name"):
            return o["name"]
    return ""


async def _us_name(sym: str, ex: str) -> str:
    code = {"NAS": "512", "NYS": "513", "AMS": "529"}.get(ex, "512")
    try:
        o = (await kis.get("/uapi/overseas-price/v1/quotations/search-info", "CTPF1702R", {"PRDT_TYPE_CD": code, "PDNO": sym})).get("output") or {}
    except KISError:
        return sym
    n = (o.get("prdt_name") or o.get("ovrs_item_name") or o.get("prdt_eng_name") or sym).strip()
    _us_names[sym] = n
    return n


async def us_candles(sym: str, period: str) -> list[dict]:
    """일(D)·주(W)·월(M)봉. 한 번에 100개, 일봉은 두 번 (약 200일)"""
    sym = sym.upper()
    if not prices._excd.get(sym):
        await us_detail(sym)
    ex = prices._excd.get(sym) or "NAS"
    gubn = {"D": "0", "W": "1", "M": "2"}[period]

    async def make():
        rows: dict[str, dict] = {}
        bymd = ""
        for _ in range(2 if period == "D" else 1):
            d = await kis.get("/uapi/overseas-price/v1/quotations/dailyprice", "HHDFS76240000", {"AUTH": "", "EXCD": ex, "SYMB": sym, "GUBN": gubn, "BYMD": bymd, "MODP": "1"})
            part = [r for r in d.get("output2") or [] if r.get("xymd") and _f(r.get("clos")) > 0]
            for r in part:
                t = r["xymd"]
                rows[t] = {"t": f"{t[:4]}-{t[4:6]}-{t[6:]}", "o": _f(r.get("open")), "h": _f(r.get("high")), "l": _f(r.get("low")), "c": _f(r.get("clos")), "v": int(_f(r.get("tvol")))}
            if len(part) < 100:
                break
            bymd = min(r["xymd"] for r in part)
        return [rows[k] for k in sorted(rows)]

    moving = market.us_session()["code"] != "closed"
    return await _cached(("c", sym, period), 60 if moving else 600, make)


# ---------- 검색 (국내 + 미국) ----------
def search(q: str) -> list[dict]:
    q = (q or "").strip()
    if not q:
        return []
    qu = q.upper()
    # 아직 한 번도 안 받은 순위는 뒤에서 받아 둔다 (다음 글자부터 한글 이름으로 찾힌다)
    if not members.get("sp500"):
        market._later("members", members.refresh())
    pool: dict[str, dict] = {}
    for c, n, _ in UNIVERSE:
        pool[c] = {"code": c, "name": n, "market": "코스피"}
    for s in members.get("kospi200") + members.get("kosdaq150") + (lists.get("value30") or {}).get("stocks", []):
        pool.setdefault(s["code"], {"code": s["code"], "name": NAMES.get(s["code"]) or s["name"], "market": "국내"})
    for v in US_VIEWS:
        for s in members.get(v):
            pool.setdefault(s["code"], {"code": s["code"], "name": _us_names.get(s["code"]) or s["name"], "market": "미국"})
    for h in market.balance.get("holdings", []):
        pool.setdefault(h["code"], {"code": h["code"], "name": h.get("name", h["code"]), "market": "국내"})
    for sym, n in _us_names.items():
        pool.setdefault(sym, {"code": sym, "name": n, "market": "미국"})
    for o in market.balance.get("overseas", []):
        pool.setdefault(o["symbol"], {"code": o["symbol"], "name": o.get("name") or o["symbol"], "market": "미국"})
    hits = [p for p in pool.values() if q in p["name"] or qu in p["name"].upper() or p["code"].upper().startswith(qu)]
    hits.sort(key=lambda p: (p["code"].upper() != qu, not p["name"].startswith(q), len(p["name"])))
    out = hits[:10]
    # 목록에 없어도 코드·티커를 그대로 열 수 있게
    if config.is_kr_code(qu) and qu not in pool:
        out.insert(0, {"code": qu, "name": qu, "market": "국내"})
    elif is_us_symbol(qu) and qu not in pool and not config.is_kr_code(qu):
        out.append({"code": qu, "name": f"{qu} (티커로 열기)", "market": "미국"})
    return out
