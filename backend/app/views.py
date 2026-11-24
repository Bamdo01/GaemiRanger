"""시장 히트맵의 다른 보기와 미국 종목 화면 (2026-11-24).

- 코스피 50 은 market.py 의 UNIVERSE·quotes 를 그대로 쓴다
- 코스닥 시총 30, 거래대금 30 은 한투 순위 API, 미국 상위 50 은 한투 해외 시가총액 순위 (나스닥+뉴욕, ETF 빼고)
- 순위는 화면이 최근 10분 안에 본 보기만 갱신한다 (안 보는 보기로 한투 호출을 쓰지 않게)
- 업종은 순위 API 에 없어서 종목별 조회로 한 번 받아 data/sectors.json 에 둔다
- 미국 종목은 시세만. 주문은 아직 국내만
"""

import asyncio
import json
import re
import time

from . import config, market, prices
from .kis import KISError, kis
from .universe import NAMES, SECTORS, UNIVERSE
from .guard import is_etf

VIEWS = {"kospi50": "코스피 상위 50", "kosdaq30": "코스닥 상위 30", "value30": "거래대금 상위 30", "us50": "미국 상위 50"}
lists: dict[str, dict] = {}  # 보기 → {"at": 받은 시각, "stocks": [...]}
_asked: dict[str, float] = {}  # 보기 → 화면이 마지막으로 물은 시각
_lock = asyncio.Lock()
SEC_FILE = config.DATA / "sectors.json"
_sec: dict[str, str] = {}
_us_names: dict[str, str] = {}  # 티커 → 한글 이름 (순위에서 본 것)
_us_cache: dict[tuple, tuple[float, object]] = {}
EXCHANGES = ("NAS", "NYS", "AMS")
EX_NAME = {"NAS": "나스닥", "NYS": "뉴욕", "AMS": "아멕스"}


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


# ---------- 순위 받기 ----------
async def _kr_rank(view: str) -> list[dict]:
    if view == "kosdaq30":
        d = await kis.get(
            "/uapi/domestic-stock/v1/ranking/market-cap",
            "FHPST01740000",
            {"fid_input_price_2": "", "fid_cond_mrkt_div_code": "J", "fid_cond_scr_div_code": "20174", "fid_div_cls_code": "1", "fid_input_iscd": "1001", "fid_trgt_cls_code": "0", "fid_trgt_exls_cls_code": "0", "fid_input_price_1": "", "fid_vol_cnt": ""},
        )
    else:  # 거래대금: 한 번에 30개라 ETF 를 빼면 모자라서 코스피·코스닥을 따로 받아 합친다
        d = {"output": []}
        for mk in ("0001", "1001"):
            part = await kis.get(
                "/uapi/domestic-stock/v1/quotations/volume-rank",
                "FHPST01710000",
                {"FID_COND_MRKT_DIV_CODE": "J", "FID_COND_SCR_DIV_CODE": "20171", "FID_INPUT_ISCD": mk, "FID_DIV_CLS_CODE": "1", "FID_BLNG_CLS_CODE": "3", "FID_TRGT_CLS_CODE": "111111111", "FID_TRGT_EXLS_CLS_CODE": "0000000000", "FID_INPUT_PRICE_1": "", "FID_INPUT_PRICE_2": "", "FID_VOL_CNT": "", "FID_INPUT_DATE_1": ""},
            )
            d["output"] += part.get("output") or []
        d["output"].sort(key=lambda r: -_f(r.get("acml_tr_pbmn")))
    out = []
    for r in d.get("output") or []:
        if len(out) >= 30:
            break
        code = r.get("mksc_shrn_iscd", "")
        price = _f(r.get("stck_prpr"))
        if not code or not price:
            continue
        if view == "value30" and is_etf(r.get("hts_kor_isnm") or ""):
            continue  # 레버리지·인버스 ETF 는 히트맵에서 뺀다 (종목만)
        prev = price - _f(r.get("prdy_vrss"))
        cap = _f(r.get("stck_avls")) / 10000 if r.get("stck_avls") else _f(r.get("lstn_stcn")) * price / 1e12
        out.append({"code": code, "name": NAMES.get(code) or r.get("hts_kor_isnm") or code, "sector": sector_of(code), "price": price, "prev": prev or price, "cap": cap, "vol": int(_f(r.get("acml_vol"))), "val": int(_f(r.get("acml_tr_pbmn"))) or None, "at": time.time()})
        if sector_of(code) == "기타" and code not in _sectors():
            market._later(f"sec:{code}", _fill_kr_sector(code))
    return out


async def _fill_kr_sector(code: str) -> None:
    q = await market.fetch_quote(code)
    if q.get("sector") and q["sector"] != "기타":
        _sec[code] = q["sector"]
        _save_sectors()


_ETF = re.compile(r"\b(ETF|TRUST|FUND|INDEX|ISHARES|SPDR|PROSHARES|DIREXION)\b")


async def _us_rank() -> list[dict]:
    fx = prices.fx.get("usd") or 0
    rows: list[dict] = []
    for ex in ("NAS", "NYS"):
        d = await kis.get("/uapi/overseas-stock/v1/ranking/market-cap", "HHDFS76350100", {"EXCD": ex, "VOL_RANG": "0", "KEYB": "", "AUTH": "", "CURR_GB": "0"})
        fx = fx or _f((d.get("output1") or {}).get("t_rate"))
        rows += d.get("output2") or []
    rows.sort(key=lambda r: -_f(r.get("tomv")))
    out, seen = [], set()
    for r in rows:
        sym, en = r.get("symb", ""), (r.get("ename") or "").upper()
        if not sym or _ETF.search(en) or "ETF" in (r.get("name") or ""):
            continue
        firm = re.sub(r"\s+(CLASS|CL)\s+[A-Z]\b.*|\s+(COM|ORD|SHS)\b.*", "", en)  # 같은 회사 다른 주식 (GOOG/GOOGL, BRK/A/B)
        if firm in seen:
            continue
        seen.add(firm)
        last, rate = _f(r.get("last")), _f(r.get("rate"))
        if not last:
            continue
        _us_names[sym] = r.get("name") or sym
        prices._excd.setdefault(sym, r.get("excd") or "NAS")
        out.append({"code": sym, "name": r.get("name") or sym, "sector": _sectors().get(f"us:{sym}") or "미국", "price": last, "prev": last / (1 + rate / 100) if rate > -100 else last, "cap": _f(r.get("tomv")) * fx / 1e12, "vol": int(_f(r.get("tvol"))), "cur": "USD", "excd": r.get("excd"), "at": time.time()})
        if f"us:{sym}" not in _sectors():
            market._later(f"sec:us:{sym}", _fill_us_sector(sym))
        if len(out) >= 50:
            break
    return out


async def _fill_us_sector(sym: str) -> None:
    d = await us_detail(sym)
    if d.get("sector"):
        _sec[f"us:{sym}"] = d["sector"]
        _save_sectors()


def _kospi50() -> list[dict]:
    return [market.quotes[c] for c, _, _ in UNIVERSE if c in market.quotes]


def _stale(view: str) -> bool:
    hit = lists.get(view)
    if not hit:
        return True
    moving = market.us_session()["code"] != "closed" if view == "us50" else market.kr_active()
    return time.time() - hit["at"] > (60 if moving else 1800)


async def refresh(view: str) -> None:
    async with _lock:
        if not _stale(view):
            return
        stocks = await (_us_rank() if view == "us50" else _kr_rank(view))
        if stocks:
            lists[view] = {"at": time.time(), "stocks": stocks}


async def get_view(view: str) -> dict:
    """화면이 고른 보기의 종목. 처음이면 받아 올 때까지 기다리고, 그 뒤는 낡았으면 뒤에서 새로"""
    if view not in VIEWS:
        view = "kospi50"
    if view == "kospi50":
        stocks = _kospi50()
    else:
        _asked[view] = time.time()
        if view not in lists:
            try:
                await refresh(view)
            except KISError:
                pass
        elif _stale(view):
            market._later(f"view:{view}", refresh(view))
        stocks = (lists.get(view) or {}).get("stocks", [])
        # 국내 보기는 시세 캐시에 더 새 값이 있으면 그것으로 (보유 종목은 실시간으로 받고 있다)
        if view != "us50":
            stocks = [{**s, **{k: market.quotes[s["code"]][k] for k in ("price", "prev") if s["code"] in market.quotes and market.quotes[s["code"]].get("at", 0) > s["at"]}, "sector": sector_of(s["code"])} for s in stocks]
        else:
            stocks = [{**s, "sector": _sectors().get(f"us:{s['code']}") or "미국"} for s in stocks]
    return {"view": view, "views": VIEWS, "stocks": stocks, "at": max([s.get("at", 0) for s in stocks], default=None)}


def kr_name(code: str) -> str:
    """국내 종목 이름: 단건 시세 응답에는 이름이 없어서 순위·잔고에서 본 이름으로"""
    for v in ("kosdaq30", "value30"):
        for s in (lists.get(v) or {}).get("stocks", []):
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
    for v in ("us50", "kosdaq30", "value30"):
        if v not in lists and config.kis_configured():
            market._later(f"view:{v}", refresh(v))
    pool: dict[str, dict] = {}
    for c, n, _ in UNIVERSE:
        pool[c] = {"code": c, "name": n, "market": "코스피"}
    for v in ("kosdaq30", "value30"):
        for s in (lists.get(v) or {}).get("stocks", []):
            pool.setdefault(s["code"], {"code": s["code"], "name": s["name"], "market": "국내"})
    for h in market.balance.get("holdings", []):
        pool.setdefault(h["code"], {"code": h["code"], "name": h.get("name", h["code"]), "market": "국내"})
    for sym, n in _us_names.items():
        pool.setdefault(sym, {"code": sym, "name": n, "market": "미국"})
    for o in market.balance.get("overseas", []):
        pool.setdefault(o["symbol"], {"code": o["symbol"], "name": o.get("name") or o["symbol"], "market": "미국"})
    hits = [p for p in pool.values() if q in p["name"] or p["code"].upper().startswith(qu)]
    hits.sort(key=lambda p: (p["code"].upper() != qu, not p["name"].startswith(q), len(p["name"])))
    out = hits[:10]
    # 목록에 없어도 코드·티커를 그대로 열 수 있게
    if config.is_kr_code(qu) and qu not in pool:
        out.insert(0, {"code": qu, "name": qu, "market": "국내"})
    elif is_us_symbol(qu) and qu not in pool and not config.is_kr_code(qu):
        out.append({"code": qu, "name": f"{qu} (티커로 열기)", "market": "미국"})
    return out
