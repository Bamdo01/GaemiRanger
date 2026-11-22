"""모의 주문. 화면에서 검사했어도 서버가 다시 검사한다 (계획서: 한도와 안전장치는 서버가 강제).
모든 시도는 성공·실패와 함께 data/orders.jsonl 에 남는다 (기록 L1)."""

import json
import time
from datetime import datetime, timedelta

from fastapi import HTTPException
from pydantic import BaseModel, Field

from . import config, market
from .kis import KISError, kis

ORDER = "/uapi/domestic-stock/v1/trading/order-cash"
LOG = config.DATA / "orders.jsonl"
DAILY_MAX_ORDERS = 30  # 하루 주문 횟수 상한 (설정 C1 전 임시값)


class OrderIn(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    side: str = Field(pattern=r"^(buy|sell)$")
    kind: str = Field(pattern=r"^(limit|market)$")
    price: int = Field(ge=0, le=100_000_000)
    qty: int = Field(ge=1, le=1_000_000)


def tick(p: int) -> int:
    for lim, t in ((2000, 1), (5000, 5), (20000, 10), (50000, 50), (200000, 100), (500000, 500)):
        if p < lim:
            return t
    return 1000


def _log(rec: dict) -> None:
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def today_log() -> list[dict]:
    if not LOG.exists():
        return []
    day = datetime.now(market.KST).strftime("%Y-%m-%d")
    out = []
    for line in LOG.read_text("utf-8").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("at", "").startswith(day):
            out.append(r)
    return out


async def place(o: OrderIn, by: str = "화면") -> dict:
    rec = {"at": datetime.now(market.KST).isoformat(timespec="seconds"), "mode": config.KIS_MODE, **o.model_dump(), "by": by}

    def refuse(msg: str, status: int = 400):
        _log({**rec, "result": "거절", "reason": msg})
        raise HTTPException(status, msg)

    if config.KIS_MODE != "mock":
        refuse("지금은 모의투자만 주문할 수 있습니다", 403)
    if not market.market_open():
        refuse("장중(09:00~15:30)에만 주문할 수 있습니다")
    if len([r for r in today_log() if r.get("result") == "접수"]) >= DAILY_MAX_ORDERS:
        refuse(f"오늘 주문 {DAILY_MAX_ORDERS}회를 넘었습니다")

    # 최신 시세로 검사
    try:
        q = await market.fetch_quote(o.code)
    except KISError as e:
        refuse(f"시세를 확인하지 못해 주문하지 않았습니다: {e}", 502)
    price = q["price"] if o.kind == "market" else o.price
    if o.kind == "limit":
        if price % tick(price):
            refuse(f"호가 단위({tick(price):,}원)에 맞지 않습니다")
        if q["upper"] and not (q["lower"] <= price <= q["upper"]):
            refuse(f"상한가 {q['upper']:,} ~ 하한가 {q['lower']:,} 사이만 됩니다")
    amount = price * o.qty
    if amount > config.ORDER_LIMIT_WON:
        refuse(f"1회 주문 한도 {config.ORDER_LIMIT_WON:,}원을 넘습니다")
    try:
        if o.side == "buy":
            cash = await market.fetch_buyable(o.code, price, o.kind == "market")
            if amount > cash:
                refuse(f"주문가능금액 {cash:,}원이 모자랍니다")
        else:
            bal = await market.fetch_balance()
            have = next((h["sellable"] for h in bal["holdings"] if h["code"] == o.code), 0)
            if o.qty > have:
                refuse(f"매도가능수량은 {have:,}주입니다")
        d = await kis.post(
            ORDER,
            "VTTC0012U" if o.side == "buy" else "VTTC0011U",
            {
                "CANO": config.KIS_CANO,
                "ACNT_PRDT_CD": config.KIS_ACNT_PRDT_CD,
                "PDNO": o.code,
                "ORD_DVSN": "01" if o.kind == "market" else "00",
                "ORD_QTY": str(o.qty),
                "ORD_UNPR": "0" if o.kind == "market" else str(price),
            },
        )
    except KISError as e:
        refuse(f"한투가 주문을 받지 않았습니다: {e}", 502)
    out = d.get("output") or {}
    res = {**rec, "result": "접수", "orderNo": out.get("ODNO", ""), "orderTime": out.get("ORD_TMD", ""), "msg": d.get("msg1", "").strip(), "amount": amount}
    _log(res)
    # 잔고는 다음 갱신 때 바뀐다. 바로 한 번 더 받아 둔다
    try:
        await market.fetch_balance()
    except KISError:
        pass
    return res


# ---------- 낸 주문 보기·정정·취소 (주문 메뉴, 2026-11-22) ----------
DAILY_CCLD = "/uapi/domestic-stock/v1/trading/inquire-daily-ccld"
RVSECNCL = "/uapi/domestic-stock/v1/trading/order-rvsecncl"
# 정정취소가능주문조회는 모의 미지원(2026-11-22 확인) → 일별주문체결조회로 미체결을 가린다


def _i(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def _norm(r: dict) -> dict:
    qty, filled = _i(r.get("ord_qty")), _i(r.get("tot_ccld_qty"))
    left = _i(r["rmn_qty"]) if "rmn_qty" in r else max(0, qty - filled)
    canceled = r.get("cncl_yn") == "Y"
    if canceled:
        left = 0
    status = "취소됨" if canceled else "체결" if qty and filled >= qty else "일부 체결" if filled else "거부" if _i(r.get("rjct_qty")) else "미체결"
    t = r.get("ord_tmd", "")
    return {
        "no": r.get("odno", ""),
        "branch": r.get("ord_gno_brno", ""),
        "orig": r.get("orgn_odno", ""),
        "date": f"{r.get('ord_dt', '')[:4]}-{r.get('ord_dt', '')[4:6]}-{r.get('ord_dt', '')[6:]}",
        "time": f"{t[:2]}:{t[2:4]}:{t[4:6]}" if len(t) >= 6 else t,
        "code": r.get("pdno", ""),
        "name": r.get("prdt_name", "") or market.NAMES.get(r.get("pdno", ""), ""),
        "side": "sell" if r.get("sll_buy_dvsn_cd") == "01" else "buy",
        "kind": "market" if r.get("ord_dvsn_cd") == "01" else "limit",
        "price": _i(r.get("ord_unpr")),
        "qty": qty,
        "filled": filled,
        "avg": _i(r.get("avg_prvs")),
        "left": left,
        "status": status,
    }


async def fetch_orders(start: str, end: str, ccld: str = "00") -> list[dict]:
    """start·end = YYYYMMDD, ccld 00 전체 / 01 체결 / 02 미체결"""
    rows, fk, nk, cont = [], "", "", ""
    for _ in range(10):
        d = await kis.get(
            DAILY_CCLD,
            "VTTC8001R",
            {
                "CANO": config.KIS_CANO,
                "ACNT_PRDT_CD": config.KIS_ACNT_PRDT_CD,
                "INQR_STRT_DT": start,
                "INQR_END_DT": end,
                "SLL_BUY_DVSN_CD": "00",
                "INQR_DVSN": "00",  # 최근 것 먼저
                "PDNO": "",
                "CCLD_DVSN": ccld,
                "ORD_GNO_BRNO": "",
                "ODNO": "",
                "INQR_DVSN_3": "00",
                "INQR_DVSN_1": "",
                "CTX_AREA_FK100": fk,
                "CTX_AREA_NK100": nk,
            },
            tr_cont=cont,
        )
        rows += d.get("output1") or []
        if d.get("_tr_cont") not in ("M", "F"):
            break
        fk, nk, cont = d.get("ctx_area_fk100", ""), d.get("ctx_area_nk100", ""), "N"
    return [_norm(r) for r in rows if r.get("odno")]


async def list_orders(scope: str, days: int) -> dict:
    today = datetime.now(market.KST)
    t = today.strftime("%Y%m%d")
    if scope == "past":
        start = (today - timedelta(days=days)).strftime("%Y%m%d")
        orders = await fetch_orders(start, t)
    else:
        orders = await fetch_orders(t, t)
    todays = orders if scope != "past" else [o for o in orders if o["date"].replace("-", "") == t]
    if scope == "open":
        orders = [o for o in orders if o["left"] > 0 and o["status"] != "취소됨"]
    return {
        "orders": orders,
        "summary": {
            "open": len([o for o in todays if o["left"] > 0 and o["status"] != "취소됨"]),
            "filled": len([o for o in todays if o["filled"] > 0]),
            "buyAmt": sum(o["filled"] * o["avg"] for o in todays if o["side"] == "buy"),
            "sellAmt": sum(o["filled"] * o["avg"] for o in todays if o["side"] == "sell"),
        },
        "marketOpen": market.market_open(),
    }


class ModifyIn(BaseModel):
    price: int = Field(ge=1, le=100_000_000)
    qty: int = Field(ge=1, le=1_000_000)


async def _find_open(no: str) -> dict:
    t = datetime.now(market.KST).strftime("%Y%m%d")
    o = next((x for x in await fetch_orders(t, t, "02") if x["no"] == no), None)
    if not o or o["left"] <= 0:
        raise HTTPException(404, "미체결 주문을 찾지 못했습니다 (이미 체결됐거나 취소됐을 수 있습니다)")
    return o


async def _rvsecncl(o: dict, cancel: bool, price: int = 0, qty: int = 0) -> dict:
    return await kis.post(
        RVSECNCL,
        "VTTC0013U",  # 모의 정정취소 (공식 저장소 기준, 장중에 아직 시험 못 함)
        {
            "CANO": config.KIS_CANO,
            "ACNT_PRDT_CD": config.KIS_ACNT_PRDT_CD,
            "KRX_FWDG_ORD_ORGNO": o["branch"],
            "ORGN_ODNO": o["no"],
            "ORD_DVSN": "00",
            "RVSE_CNCL_DVSN_CD": "02" if cancel else "01",
            "ORD_QTY": "0" if cancel else str(qty),
            "ORD_UNPR": "0" if cancel else str(price),
            "QTY_ALL_ORD_YN": "Y" if cancel else ("Y" if qty == o["left"] else "N"),
            "EXCG_ID_DVSN_CD": "KRX",
        },
    )


async def cancel(no: str) -> dict:
    rec = {"at": datetime.now(market.KST).isoformat(timespec="seconds"), "mode": config.KIS_MODE, "action": "취소", "orderNo": no, "by": "화면"}
    if not market.market_open():
        _log({**rec, "result": "거절", "reason": "장 시간 밖"})
        raise HTTPException(400, "장중(09:00~15:30)에만 취소할 수 있습니다")
    o = await _find_open(no)
    try:
        d = await _rvsecncl(o, True)
    except KISError as e:
        _log({**rec, "result": "거절", "reason": str(e)})
        raise HTTPException(502, f"한투가 취소를 받지 않았습니다: {e}") from None
    res = {**rec, "code": o["code"], "qty": o["left"], "result": "접수", "msg": d.get("msg1", "").strip()}
    _log(res)
    return res


async def cancel_all() -> dict:
    if not market.market_open():
        raise HTTPException(400, "장중(09:00~15:30)에만 취소할 수 있습니다")
    t = datetime.now(market.KST).strftime("%Y%m%d")
    done, failed = [], []
    for o in [x for x in await fetch_orders(t, t, "02") if x["left"] > 0 and x["status"] != "취소됨"]:
        try:
            await cancel(o["no"])
            done.append(o["no"])
        except HTTPException as e:
            failed.append({"no": o["no"], "reason": e.detail})
    return {"canceled": done, "failed": failed}


async def modify(no: str, m: ModifyIn) -> dict:
    rec = {"at": datetime.now(market.KST).isoformat(timespec="seconds"), "mode": config.KIS_MODE, "action": "정정", "orderNo": no, "price": m.price, "qty": m.qty, "by": "화면"}

    def refuse(msg: str, status: int = 400):
        _log({**rec, "result": "거절", "reason": msg})
        raise HTTPException(status, msg)

    if not market.market_open():
        refuse("장중(09:00~15:30)에만 정정할 수 있습니다")
    o = await _find_open(no)
    if m.qty > o["left"]:
        refuse(f"남은 수량 {o['left']:,}주보다 많이 정정할 수 없습니다")
    try:
        q = await market.fetch_quote(o["code"])
    except KISError as e:
        refuse(f"시세를 확인하지 못해 정정하지 않았습니다: {e}", 502)
    if m.price % tick(m.price):
        refuse(f"호가 단위({tick(m.price):,}원)에 맞지 않습니다")
    if q.get("upper") and not (q["lower"] <= m.price <= q["upper"]):
        refuse(f"상한가 {q['upper']:,} ~ 하한가 {q['lower']:,} 사이만 됩니다")
    amount = m.price * m.qty
    if amount > config.ORDER_LIMIT_WON:
        refuse(f"1회 주문 한도 {config.ORDER_LIMIT_WON:,}원을 넘습니다")
    try:
        if o["side"] == "buy":
            # 원래 주문에 묶인 금액은 정정하면 풀리므로 더해서 본다
            cash = await market.fetch_buyable(o["code"], m.price, False) + o["price"] * o["left"]
            if amount > cash:
                refuse(f"주문가능금액 {cash:,}원이 모자랍니다")
        d = await _rvsecncl(o, False, m.price, m.qty)
    except KISError as e:
        refuse(f"한투가 정정을 받지 않았습니다: {e}", 502)
    res = {**rec, "code": o["code"], "result": "접수", "msg": d.get("msg1", "").strip()}
    _log(res)
    return res
