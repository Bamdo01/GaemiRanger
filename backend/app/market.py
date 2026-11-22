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
            "VTTC8434R",
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
    balance.clear()
    balance.update({"holdings": holdings, "cash": _i(out2.get("prvs_rcdl_excc_amt")) or _i(out2.get("dnca_tot_amt")), "at": time.time()})
    return balance


async def fetch_buyable(code: str, price: int, market: bool) -> int:
    """주문가능현금 (원)"""
    d = await kis.get(
        PSBL,
        "VTTC8908R",
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


# ---------- 주기 갱신 ----------
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
        # 보유 종목은 매번, 나머지는 돌아가며 몇 개씩
        batch = held + [order[(i + k) % len(order)] for k in range(6)]
        i = (i + 6) % len(order)
        for code in dict.fromkeys(batch):
            await safe(fetch_quote(code))
        await asyncio.sleep(1 if is_open else 5 if len(quotes) < len(order) else 30)
