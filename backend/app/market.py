"""시세·잔고 캐시와 주기 갱신.

화면은 한투를 직접 부르지 않고 이 캐시를 읽는다. 서버가 초당 호출 한도 안에서 돌아가며 채운다.
(시장 50종목 + 지수 + 잔고를 화면마다 한투에 부르면 모의투자 호출 한도를 바로 넘는다)
"""

import asyncio
import contextvars
import time
from datetime import date, datetime, timedelta, timezone

from . import config, ledger
from .kis import URGENT, KISError, kis
from .universe import NAMES, SECTORS, UNIVERSE

KST = timezone(timedelta(hours=9))  # 한국은 서머타임이 없어 고정 +9
QUOTE = "/uapi/domestic-stock/v1/quotations/inquire-price"
INDEX = "/uapi/domestic-stock/v1/quotations/inquire-index-price"
DAILY = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"
BOOK = "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn"
BALANCE = "/uapi/domestic-stock/v1/trading/inquire-balance"
PSBL = "/uapi/domestic-stock/v1/trading/inquire-psbl-order"

quotes: dict[str, dict] = {}
indices: dict[str, dict] = {}
balance: dict = {}
_candles: dict[tuple[str, str], tuple[float, list]] = {}


def _i(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def market_open(now: datetime | None = None) -> bool:
    n = now or datetime.now(KST)
    if n.weekday() >= 5:
        return False
    m = n.hour * 60 + n.minute
    return 9 * 60 <= m < 15 * 60 + 30


# ---------- 한 건씩 받아 오기 ----------
async def fetch_quote(code: str) -> dict:
    d = (await kis.get(QUOTE, "FHKST01010100", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code}))["output"]
    price = _i(d.get("stck_prpr"))
    prev = _i(d.get("stck_sdpr")) or price - _i(d.get("prdy_vrss"))
    q = {
        "code": code,
        "name": NAMES.get(code) or d.get("hts_kor_isnm") or code,
        "sector": SECTORS.get(code) or d.get("bstp_kor_isnm") or "기타",
        "price": price,
        "prev": prev,
        "open": _i(d.get("stck_oprc")),
        "high": _i(d.get("stck_hgpr")),
        "low": _i(d.get("stck_lwpr")),
        "vol": _i(d.get("acml_vol")),
        "val": _i(d.get("acml_tr_pbmn")),
        "cap": _f(d.get("hts_avls")) / 10000,  # 억원 → 조원
        "per": _f(d.get("per")),
        "pbr": _f(d.get("pbr")),
        "w52h": _i(d.get("w52_hgpr")),
        "w52l": _i(d.get("w52_lwpr")),
        "upper": _i(d.get("stck_mxpr")),
        "lower": _i(d.get("stck_llam")),
        "at": time.time(),
    }
    quotes[code] = q
    return q


async def fetch_index(iid: str, code: str, name: str) -> None:
    d = (await kis.get(INDEX, "FHPUP02100000", {"FID_COND_MRKT_DIV_CODE": "U", "FID_INPUT_ISCD": code}))["output"]
    v = _f(d.get("bstp_nmix_prpr"))
    indices[iid] = {"id": iid, "name": name, "value": v, "prev": round(v - _f(d.get("bstp_nmix_prdy_vrss")), 2), "at": time.time()}


async def fetch_balance() -> dict:
    rows, fk, nk, cont = [], "", "", ""
    out2: dict = {}
    for _ in range(5):  # 연속조회 (보유 종목이 많을 때)
        d = await kis.get(
            BALANCE,
            config.tr("VTTC8434R"),
            {
                "CANO": config.KIS_CANO,
                "ACNT_PRDT_CD": config.KIS_ACNT_PRDT_CD,
                "AFHR_FLPR_YN": "N",
                "OFL_YN": "",
                "INQR_DVSN": "02",
                "UNPR_DVSN": "01",
                "FUND_STTL_ICLD_YN": "N",
                "FNCG_AMT_AUTO_RDPT_YN": "N",
                "PRCS_DVSN": "00",
                "CTX_AREA_FK100": fk,
                "CTX_AREA_NK100": nk,
            },
            tr_cont=cont,
        )
        rows += d.get("output1") or []
        out2 = (d.get("output2") or [{}])[0]
        if d.get("_tr_cont") not in ("M", "F"):
            break
        fk, nk, cont = d.get("ctx_area_fk100", ""), d.get("ctx_area_nk100", ""), "N"
    holdings = []
    for r in rows:
        qty = _i(r.get("hldg_qty"))
        if qty <= 0:
            continue
        code = r.get("pdno", "")
        holdings.append(
            {
                "code": code,
                "name": r.get("prdt_name") or NAMES.get(code, code),
                "sector": SECTORS.get(code, "기타"),
                "qty": qty,
                "sellable": _i(r.get("ord_psbl_qty")),
                "avg": round(_f(r.get("pchs_avg_pric"))),
                "price": _i(r.get("prpr")),
            }
        )
    overseas, usd_cash = await _fetch_overseas_balance()
    balance.clear()
    balance.update({"holdings": holdings, "cash": _i(out2.get("prvs_rcdl_excc_amt")) or _i(out2.get("dnca_tot_amt")), "overseas": overseas, "usdCash": usd_cash, "at": time.time()})
    return balance


OVRS_PRESENT = "/uapi/overseas-stock/v1/trading/inquire-present-balance"
EXCD = {"NASD": "NAS", "NAS": "NAS", "NYSE": "NYS", "NYS": "NYS", "AMEX": "AMS", "AMS": "AMS"}


def _pick(r: dict, *keys: str) -> str:
    """공식 문서의 항목 이름 후보 중 값이 있는 것 (2026-11-23: 해외 보유가 없어 실제 이름은 아직 못 봄)"""
    for k in keys:
        if r.get(k) not in (None, "", "0", "0.00000", "0.00000000"):
            return r[k]
    return ""


async def _fetch_overseas_balance() -> tuple[list[dict], float]:
    """한투 해외(미국) 잔고와 달러 예수금. 체결기준현재잔고 CTRP6504R (모의 VTRP6504R) — 2026-11-23 실전에서 호출 확인"""
    try:
        d = await kis.get(
            OVRS_PRESENT,
            config.tr("VTRP6504R"),
            {"CANO": config.KIS_CANO, "ACNT_PRDT_CD": config.KIS_ACNT_PRDT_CD, "WCRC_FRCR_DVSN_CD": "02", "NATN_CD": "840", "TR_MKET_CD": "00", "INQR_DVSN_CD": "00"},
        )
    except KISError:
        return balance.get("overseas", []), balance.get("usdCash", 0.0)
    out = []
    for r in d.get("output1") or []:
        qty = _f(_pick(r, "cblc_qty13", "ccld_qty_smtl1", "ovrs_cblc_qty", "hldg_qty"))
        sym = _pick(r, "pdno", "ovrs_pdno").strip()
        if qty <= 0 or not sym:
            continue
        ex = EXCD.get(_pick(r, "ovrs_excg_cd", "tr_mket_cd").strip(), "")
        out.append(
            {
                "symbol": sym,
                "name": _pick(r, "prdt_name", "ovrs_item_name") or sym,
                "qty": qty,
                "avg": _f(_pick(r, "avg_unpr3", "pchs_avg_pric", "frcr_pchs_amt1")),  # 달러
                "price": _f(_pick(r, "ovrs_now_pric1", "now_pric2", "ovrs_now_pric")),  # 달러
                "excd": ex,
                "sellable": _f(_pick(r, "ord_psbl_qty1", "ord_psbl_qty")),
            }
        )
    usd = 0.0
    for r in d.get("output2") or []:
        if (r.get("crcy_cd") or "").upper() == "USD":
            usd = _f(_pick(r, "frcr_dncl_amt_2", "frcr_dncl_amt", "frcr_drwg_psbl_amt_1"))
    return out, usd


async def fetch_buyable(code: str, price: int, market: bool) -> int:
    """주문가능현금 (원)"""
    d = await kis.get(
        PSBL,
        config.tr("VTTC8908R"),
        {
            "CANO": config.KIS_CANO,
            "ACNT_PRDT_CD": config.KIS_ACNT_PRDT_CD,
            "PDNO": code,
            "ORD_UNPR": "0" if market else str(price),
            "ORD_DVSN": "01" if market else "00",
            "CMA_EVLU_AMT_ICLD_YN": "N",
            "OVRS_ICLD_YN": "N",
        },
    )
    return _i(d["output"].get("ord_psbl_cash"))


async def fetch_book(code: str) -> dict:
    d = (await kis.get(BOOK, "FHKST01010200", {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code}))["output1"]
    asks = [{"p": _i(d.get(f"askp{i}")), "q": _i(d.get(f"askp_rsqn{i}"))} for i in range(10, 0, -1)]
    bids = [{"p": _i(d.get(f"bidp{i}")), "q": _i(d.get(f"bidp_rsqn{i}"))} for i in range(1, 11)]
    return {"asks": [a for a in asks if a["p"]], "bids": [b for b in bids if b["p"]], "at": time.time()}


_bg: set[str] = set()  # 뒤에서 받고 있는 것 (같은 것을 두 번 받지 않게)


def _later(key: str, coro) -> None:
    """화면을 기다리게 하지 않고 뒤에서 받는다 (백그라운드 순서)"""
    if key in _bg:
        coro.close()
        return
    _bg.add(key)

    async def run() -> None:
        try:
            await coro
        except Exception:  # noqa: BLE001 - 실패는 kis.last_error 에 남고 다음 요청 때 다시
            pass
        finally:
            _bg.discard(key)

    ctx = contextvars.copy_context()
    ctx.run(URGENT.set, False)
    asyncio.get_running_loop().create_task(run(), context=ctx)


async def quote_fast(code: str) -> dict:
    """받아 둔 시세가 있으면 바로 돌려주고, 5초 넘게 묵었으면 뒤에서 새로 받는다"""
    q = quotes.get(code)
    if q is None:
        return await fetch_quote(code)
    if time.time() - q["at"] > 5:
        _later(f"q:{code}", fetch_quote(code))
    return q


_SPANS = {"D": [(140, 0), (280, 141), (400, 281)], "W": [(700, 0)], "M": [(3000, 0)]}


async def _candle_span(code: str, period: str, back_from: int, back_to: int) -> dict[str, dict]:
    today = date.today()
    d = await kis.get(
        DAILY,
        "FHKST03010100",
        {
            "FID_COND_MRKT_DIV_CODE": "J",
            "FID_INPUT_ISCD": code,
            "FID_INPUT_DATE_1": (today - timedelta(days=back_from)).strftime("%Y%m%d"),
            "FID_INPUT_DATE_2": (today - timedelta(days=back_to)).strftime("%Y%m%d"),
            "FID_PERIOD_DIV_CODE": period,
            "FID_ORG_ADJ_PRC": "0",
        },
    )
    out: dict[str, dict] = {}
    for r in d.get("output2") or []:
        t = r.get("stck_bsop_date")
        if not t or not _i(r.get("stck_clpr")):
            continue
        out[t] = {"t": f"{t[:4]}-{t[4:6]}-{t[6:]}", "o": _i(r.get("stck_oprc")), "h": _i(r.get("stck_hgpr")), "l": _i(r.get("stck_lwpr")), "c": _i(r.get("stck_clpr")), "v": _i(r.get("acml_vol"))}
    return out


async def _candle_rest(code: str, period: str, first: dict[str, dict]) -> None:
    out = dict(first)
    for back_from, back_to in _SPANS[period][1:]:
        out.update(await _candle_span(code, period, back_from, back_to))
    _candles[(code, period)] = (time.time(), [out[k] for k in sorted(out)])


async def fetch_candles(code: str, period: str) -> list:
    """일(D)·주(W)·월(M)봉. 한 번에 100개라 일봉은 기간을 나눠 받는다. 10분 캐시.
    처음에는 가장 최근 기간만 받아 바로 돌려주고, 지난 기간은 뒤에서 채운다 (화면은 1분마다 다시 물음)"""
    key = (code, period)
    hit = _candles.get(key)
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    if hit and len(hit[1]) > 150:
        # 다 받아 둔 묵은 캐시가 있으면 바로 돌려주고 뒤에서 새로 받는다 (지난 봉은 안 바뀌고 오늘 봉만 바뀜)
        _later(f"c:{code}:{period}:refresh", _candle_refresh(code, period))
        return hit[1]
    back_from, back_to = _SPANS[period][0]
    out = await _candle_span(code, period, back_from, back_to)
    if hit:  # 묵은 캐시가 있으면 지난 기간은 그것으로 채워 둔다
        out = {**{c["t"].replace("-", ""): c for c in hit[1]}, **out}
    rows = [out[k] for k in sorted(out)]
    if len(_SPANS[period]) > 1:
        _candles[key] = (time.time() - 600, rows)  # 아직 덜 찼으니 다음 요청 때 캐시로 끝내지 않게
        _later(f"c:{code}:{period}", _candle_rest(code, period, out))
    else:
        _candles[key] = (time.time(), rows)
    return rows


async def _candle_refresh(code: str, period: str) -> None:
    hit = _candles.get((code, period))
    back_from, back_to = _SPANS[period][0]
    out = await _candle_span(code, period, back_from, back_to)
    old = {c["t"].replace("-", ""): c for c in (hit[1] if hit else [])}
    merged = {**old, **out}
    _candles[(code, period)] = (time.time(), [merged[k] for k in sorted(merged)])


MULTI = "/uapi/domestic-stock/v1/quotations/intstock-multprice"


async def fetch_multi(codes: list[str]) -> None:
    """실전 전용: 관심종목(멀티) 시세로 한 번에 30종목까지 (2026-11-23 확인, 5종목 0.4초).
    시가총액·PER 같은 값은 이 API 에 없어서, 처음 한 번은 종목별 시세로 채워 두고 여기서는 가격만 바꾼다"""
    for k in range(0, len(codes), 30):
        part = codes[k : k + 30]
        p: dict = {}
        for n, c in enumerate(part, 1):
            p[f"FID_COND_MRKT_DIV_CODE_{n}"] = "J"
            p[f"FID_INPUT_ISCD_{n}"] = c
        d = await kis.get(MULTI, "FHKST11300006", p)
        now = time.time()
        for o in d.get("output") or []:
            code = o.get("inter_shrn_iscd", "")
            price = _i(o.get("inter2_prpr"))
            if not code or not price:
                continue
            q = quotes.get(code) or {"code": code, "name": NAMES.get(code) or o.get("inter_kor_isnm") or code, "sector": SECTORS.get(code, "기타"), "cap": 0}
            if q.get("live") and now - q.get("at", 0) < 3:
                continue  # 웹소켓 값이 더 새롭다
            q.update(price=price, prev=_i(o.get("inter2_sdpr")) or _i(o.get("inter2_prdy_clpr")) or price, open=_i(o.get("inter2_oprc")), high=_i(o.get("inter2_hgpr")), low=_i(o.get("inter2_lwpr")), vol=_i(o.get("acml_vol")), val=_i(o.get("acml_tr_pbmn")), upper=_i(o.get("inter2_mxpr")), lower=_i(o.get("inter2_llam")), at=now)
            q.pop("live", None)
            quotes[code] = q


# ---------- 주기 갱신 ----------
_no_cap: set[str] = set()
_prefetched: list[bool] = []


def _prefetch_candles(codes: list[str]) -> None:
    """보유 종목 일봉을 미리 받아 둔다 (종목 화면을 열면 바로 차트). 백그라운드 순서"""
    _prefetched.append(True)
    for c in codes:
        _later(f"pre:{c}", fetch_candles(c, "D"))


async def poll_forever() -> None:
    order = [c for c, _, _ in UNIVERSE]
    i = 0
    while True:
        if not config.kis_configured():
            await asyncio.sleep(30)
            continue
        is_open = market_open()

        async def safe(coro) -> None:
            # 하나가 실패해도 나머지는 계속 (실패는 kis.last_error 에 남고 다음 차례에 다시)
            try:
                await coro
            except KISError:
                pass
            except Exception as e:  # noqa: BLE001 - 갱신이 죽지 않게
                kis.last_error = f"{datetime.now():%H:%M:%S} {e.__class__.__name__}: {e}"

        await safe(fetch_index("kospi", "0001", "코스피"))
        await safe(fetch_index("kosdaq", "1001", "코스닥"))
        await safe(fetch_balance())
        # 한투 보유 + 수기 계좌의 국내 종목은 매번 받는다
        held = [h["code"] for h in balance.get("holdings", [])] + ledger.kr_codes()
        if config.REAL:
            # 실전: 시가총액 등이 아직 없는 종목만 종목별로 받고(처음 한 번), 가격은 멀티 시세로 한꺼번에
            await safe(fetch_multi(list(dict.fromkeys(order + held))))  # 가격 먼저 (50종목 2번 호출)
            need = [c for c in dict.fromkeys(order + held) if not quotes.get(c, {}).get("cap") and c not in _no_cap]
            for code in need[:25]:
                await safe(fetch_quote(code))
                if not quotes.get(code, {}).get("cap"):
                    _no_cap.add(code)  # ETF 처럼 시가총액이 0 인 종목은 다시 묻지 않는다
            if not _prefetched:
                _prefetch_candles(held)
            await asyncio.sleep(2 if is_open or need else 30)
            continue
        # 보유 종목은 매번, 나머지는 돌아가며 몇 개씩
        # 실시간(웹소켓)으로 막 받은 종목은 조회하지 않는다 → 남는 한도를 시장 순회에 쓴다
        held = [c for c in held if not (quotes.get(c, {}).get("live") and time.time() - quotes[c]["at"] < 5)]
        batch = held + [order[(i + k) % len(order)] for k in range(6)]
        i = (i + 6) % len(order)
        for code in dict.fromkeys(batch):
            await safe(fetch_quote(code))
        await asyncio.sleep(1 if is_open else 5 if len(quotes) < len(order) else 30)
