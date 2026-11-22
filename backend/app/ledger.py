"""수기 자산: 연동 안 되는 계좌(다른 증권사, 해외, 코인, 예금 등)를 거래 기록으로 관리한다.

- 기록 종류: 매수(buy)·매도(sell)·배당이자(div)·금액 평가(value)
- 보유 수량·평균단가는 기록을 날짜순으로 다시 계산한다 (이동평균법). 가진 것보다 많이 파는 기록은 받지 않는다
- 저장: data/ledger.json (git 에 안 올라감). 한 사람이 쓰므로 파일 하나로 충분하다
- 한투 연동 계좌와 합치는 것은 main.py 의 /api/portfolio 가 한다 (2026-11-22 사용자: 모든 자산은 한 포트폴리오)
"""

import asyncio
import json
import os
import re
import time
from datetime import date

from fastapi import HTTPException
from pydantic import BaseModel

from . import config

FILE = config.DATA / "ledger.json"
_lock = asyncio.Lock()

ASSETS = {"kr": "국내주식", "us": "해외주식", "coin": "코인", "gold": "금현물", "cash": "예금·현금", "etc": "기타"}
TRADE_ASSETS = ("kr", "us", "coin", "gold")
# KRX 금시장 (수량 g, 가격 g당 원). 2026-11-23 확인: 한투 국내주식 현재가 API 에 이 코드를 넣으면 시세가 나온다 (공식 문서에는 없음)
GOLD = {"M04020000": "금 99.99 (1kg 시장)", "M04020100": "미니금 99.99 (100g 시장)"}
VALUE_ASSETS = ("cash", "etc")
DEFAULT_USD = 1400.0  # 환율을 아직 안 넣었을 때만


class RecordIn(BaseModel):
    kind: str  # buy | sell | div | value
    date: str  # YYYY-MM-DD
    account: str
    asset: str = ""
    symbol: str = ""
    name: str = ""
    qty: float = 0
    price: float = 0
    fee: float = 0
    amount: float = 0
    currency: str = "KRW"
    memo: str = ""


# ---------- 파일 ----------
def load() -> dict:
    try:
        d = json.loads(FILE.read_text("utf-8"))
    except (OSError, ValueError):
        d = {}
    d.setdefault("accounts", [])
    d.setdefault("records", [])
    d.setdefault("prices", {})
    d.setdefault("fx", {})
    d.setdefault("seq", 0)
    return d


def _save(d: dict) -> None:
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, FILE)


def _next_id(d: dict, prefix: str) -> str:
    d["seq"] += 1
    return f"{prefix}{d['seq']}"


def key_of(asset: str, symbol: str) -> str:
    """종목 하나를 가리키는 키. 국내주식은 종목코드 그대로 (종목 페이지로 갈 수 있게)"""
    return symbol if asset == "kr" else f"{asset}:{symbol}"


def usd(d: dict) -> tuple[float, str]:
    """원/달러 환율과 출처: auto(한투) > manual(사람이 넣음) > default"""
    from . import prices

    if prices.fx.get("usd"):
        return prices.fx["usd"], "auto"
    v = float(d["fx"].get("USD") or 0)
    return (v, "manual") if v > 0 else (DEFAULT_USD, "default")


def auto_price(asset: str, symbol: str) -> dict | None:
    """자동 시세 (해외주식은 달러, 코인은 원). 없으면 None"""
    from . import prices

    if asset == "us":
        return prices.overseas.get(symbol)
    if asset == "coin":
        return prices.coins.get(symbol)
    if asset == "gold":
        return prices.gold.get(symbol)
    return None


def symbols(asset: str) -> list[str]:
    """지금 가진 해외주식·코인 (자동 시세를 받을 것)"""
    try:
        return [p["symbol"] for p in replay(load()["records"])["pos"].values() if p["asset"] == asset and p["qty"] > 1e-9]
    except HTTPException:
        return []


def uses_usd() -> bool:
    return any(r["currency"] == "USD" for r in load()["records"])


# ---------- 계산 ----------
def replay(records: list[dict]) -> dict:
    """기록을 날짜순으로 다시 계산. 매도가 보유보다 많으면 HTTPException(400)"""
    pos: dict[str, dict] = {}  # 종목 키 → 합계
    per: dict[tuple[str, str], dict] = {}  # (계좌, 종목 키) → 수량·원가
    values: dict[tuple[str, str], dict] = {}  # (계좌, 이름) → 금액 평가
    divs: list[dict] = []
    for r in sorted(records, key=lambda x: (x["date"], x["n"])):
        k = r["kind"]
        if k in ("buy", "sell"):
            key = key_of(r["asset"], r["symbol"])
            p = pos.setdefault(key, {"key": key, "asset": r["asset"], "symbol": r["symbol"], "name": r["name"], "currency": r["currency"], "qty": 0.0, "cost": 0.0, "realized": 0.0, "last": r["price"]})
            if p["currency"] != r["currency"]:
                raise HTTPException(400, f"{r['name']}: 같은 종목은 통화를 하나로 써야 합니다 ({p['currency']})")
            a = per.setdefault((r["account"], key), {"qty": 0.0, "cost": 0.0})
            if k == "buy":
                a["qty"] += r["qty"]
                a["cost"] += r["qty"] * r["price"] + r["fee"]
            else:
                if r["qty"] > a["qty"] + 1e-9:
                    raise HTTPException(400, f"{r['date']} {r['name']}: 그 계좌에 가진 수량({_num(a['qty'])})보다 많이 팝니다")
                avg = a["cost"] / a["qty"] if a["qty"] else 0
                p["realized"] += r["qty"] * (r["price"] - avg) - r["fee"]
                a["cost"] -= r["qty"] * avg
                a["qty"] -= r["qty"]
                if a["qty"] < 1e-9:
                    a["qty"], a["cost"] = 0.0, 0.0
            p["last"] = r["price"]
            p["name"] = r["name"] or p["name"]
        elif k == "value":
            v = values.setdefault((r["account"], r["name"]), {"account": r["account"], "asset": r["asset"], "name": r["name"], "currency": r["currency"], "first": r["amount"], "amount": r["amount"], "date": r["date"]})
            v["amount"], v["date"], v["currency"] = r["amount"], r["date"], r["currency"]
        elif k == "div":
            divs.append(r)
    for (acct, key), a in per.items():
        p = pos[key]
        p["qty"] += a["qty"]
        p["cost"] += a["cost"]
        if a["qty"] > 0:
            p.setdefault("accounts", {})[acct] = a["qty"]
    return {"pos": pos, "values": list(values.values()), "divs": divs}


def _num(x: float) -> str:
    return f"{x:,.8f}".rstrip("0").rstrip(".")


def kr_codes() -> list[str]:
    """수기 계좌에 있는 국내 종목 (시세 순회에 넣는다)"""
    try:
        return [p["symbol"] for p in replay(load()["records"])["pos"].values() if p["asset"] == "kr" and p["qty"] > 0]
    except HTTPException:
        return []


def holdings(account: str, quotes: dict) -> dict:
    """한투 잔고와 같은 모양(원화)으로 바꾼 수기 자산. account = 'all' 또는 수기 계좌 id"""
    d = load()
    fx, fx_src = usd(d)
    recs = [r for r in d["records"] if account == "all" or r["account"] == account]
    res = replay(recs)
    names = {a["id"]: a["name"] for a in d["accounts"]}
    out, cash = [], 0.0
    for p in res["pos"].values():
        if p["qty"] <= 1e-9:
            continue
        rate = fx if p["currency"] == "USD" else 1.0
        auto = None
        fallback = False  # 시세를 아직 못 받아 마지막 거래 단가 등으로 임시 계산 중
        if p["asset"] == "kr":
            q = quotes.get(p["symbol"]) or {}
            fallback = not q.get("price")
            price, prev = q.get("price") or p["last"], q.get("prev") or q.get("price") or p["last"]
            sector = q.get("sector") or "기타"
        else:
            sector = ASSETS[p["asset"]]
            auto = auto_price(p["asset"], p["symbol"])
            if auto:
                # 자동 시세의 통화(해외 달러, 코인 원)를 이 종목의 기록 통화로 맞춘다
                src_usd = p["asset"] == "us"
                conv = (1.0 if src_usd else 1 / fx) if p["currency"] == "USD" else (fx if src_usd else 1.0)
                price, prev = auto["price"] * conv, auto["prev"] * conv
            else:
                mp = d["prices"].get(p["key"], {}).get("price")
                price = prev = mp or p["last"]
                fallback = True
        out.append(
            {
                "code": p["key"],
                "name": p["name"],
                "sector": sector,
                "asset": p["asset"],
                "qty": p["qty"],
                "avg": p["cost"] / p["qty"] * rate,
                "price": price * rate,
                "prev": prev * rate,
                "sellable": 0,
                "currency": p["currency"],
                "rawPrice": price,  # 원래 통화의 현재가 (화면에서 고칠 때)
                "manualPrice": p["asset"] != "kr" and not auto,
                "fallback": fallback,
                "accounts": [{"id": a, "name": names.get(a, a), "qty": q} for a, q in p.get("accounts", {}).items()],
            }
        )
    for v in res["values"]:
        rate = fx if v["currency"] == "USD" else 1.0
        if v["asset"] == "cash":
            cash += v["amount"] * rate
        elif v["amount"] > 0:
            out.append(
                {
                    "code": f"etc:{v['account']}:{v['name']}",
                    "name": v["name"],
                    "sector": ASSETS["etc"],
                    "asset": "etc",
                    "qty": 1,
                    "avg": v["first"] * rate,  # 처음 넣은 금액을 원가로
                    "price": v["amount"] * rate,
                    "prev": v["amount"] * rate,
                    "sellable": 0,
                    "currency": v["currency"],
                    "accounts": [{"id": v["account"], "name": names.get(v["account"], v["account"]), "qty": 1}],
                }
            )
    realized = sum(p["realized"] * (fx if p["currency"] == "USD" else 1) for p in res["pos"].values())
    dividends = sum(r["amount"] * (fx if r["currency"] == "USD" else 1) for r in res["divs"])
    return {"holdings": out, "cash": cash, "realized": realized, "dividends": dividends, "fx": fx, "fxSource": fx_src, "usesUsd": any(r["currency"] == "USD" for r in d["records"]), "fxDefault": fx_src == "default" and any(r["currency"] == "USD" for r in recs)}


# ---------- 바꾸기 ----------
_SYM = {"us": re.compile(r"^[A-Z0-9.\-]{1,12}$"), "coin": re.compile(r"^[A-Z0-9]{1,15}$")}


async def _clean(d: dict, b: RecordIn, find_name) -> dict:
    if b.kind not in ("buy", "sell", "div", "value"):
        raise HTTPException(400, "기록 종류가 잘못됐습니다")
    try:
        day = date.fromisoformat(b.date)
    except ValueError:
        raise HTTPException(400, "날짜는 YYYY-MM-DD 로 넣어 주세요") from None
    if day > date.today():
        raise HTTPException(400, "앞으로의 날짜는 넣을 수 없습니다")
    if b.account not in {a["id"] for a in d["accounts"]}:
        raise HTTPException(400, "계좌를 먼저 만들어 주세요")
    cur = b.currency.upper()
    if cur not in ("KRW", "USD"):
        raise HTTPException(400, "통화는 원(KRW) 또는 달러(USD)입니다")
    r = {"kind": b.kind, "date": b.date, "account": b.account, "asset": "", "symbol": "", "name": b.name.strip()[:40], "qty": 0.0, "price": 0.0, "fee": 0.0, "amount": 0.0, "currency": cur, "memo": b.memo.strip()[:100]}
    if b.kind in ("buy", "sell"):
        if b.asset not in TRADE_ASSETS:
            raise HTTPException(400, "매수·매도는 국내주식, 해외주식, 코인, 금현물만 됩니다")
        sym = b.symbol.strip().upper()
        if b.asset == "kr":
            if not config.is_kr_code(sym):
                raise HTTPException(400, "국내주식은 6자리 종목코드를 넣어 주세요")
            if cur != "KRW":
                raise HTTPException(400, "국내주식은 원화입니다")
            r["name"] = r["name"] or await find_name(sym)
        elif b.asset == "gold":
            if sym not in GOLD:
                raise HTTPException(400, "금현물은 금 99.99 (M04020000) 또는 미니금 (M04020100) 입니다")
            if cur != "KRW":
                raise HTTPException(400, "금현물은 원화입니다")
            r["name"] = r["name"] or GOLD[sym]
        elif not _SYM[b.asset].match(sym):
            raise HTTPException(400, "티커는 영문 대문자와 숫자로 넣어 주세요 (예: AAPL, BTC)")
        if not (b.qty > 0 and b.price > 0 and b.fee >= 0):
            raise HTTPException(400, "수량과 단가는 0보다 커야 하고, 수수료는 0 이상이어야 합니다")
        r.update(asset=b.asset, symbol=sym, name=r["name"] or sym, qty=float(b.qty), price=float(b.price), fee=float(b.fee))
    elif b.kind == "div":
        if not b.amount > 0:
            raise HTTPException(400, "배당·이자 금액은 0보다 커야 합니다")
        r.update(amount=float(b.amount), name=r["name"] or "배당·이자", asset=b.asset if b.asset in ASSETS else "", symbol=b.symbol.strip().upper()[:15])
    else:
        if b.asset not in VALUE_ASSETS:
            raise HTTPException(400, "금액 평가는 예금·현금 또는 기타입니다")
        if not r["name"]:
            raise HTTPException(400, "이름을 넣어 주세요 (예: 예금, 전세보증금)")
        if b.amount < 0:
            raise HTTPException(400, "금액은 0 이상입니다")
        r.update(asset=b.asset, amount=float(b.amount))
    return r


async def add_record(b: RecordIn, find_name) -> dict:
    async with _lock:
        d = load()
        r = await _clean(d, b, find_name)
        r["id"] = _next_id(d, "r")
        r["n"] = d["seq"]
        r["at"] = time.time()
        replay(d["records"] + [r])  # 매도 초과 등 확인 (실패하면 저장하지 않음)
        d["records"].append(r)
        _save(d)
        return r


async def edit_record(rid: str, b: RecordIn, find_name) -> dict:
    async with _lock:
        d = load()
        old = next((r for r in d["records"] if r["id"] == rid), None)
        if not old:
            raise HTTPException(404, "없는 기록입니다")
        r = await _clean(d, b, find_name)
        r.update(id=rid, n=old["n"], at=time.time())
        recs = [r if x["id"] == rid else x for x in d["records"]]
        replay(recs)
        d["records"] = recs
        _save(d)
        return r


async def delete_record(rid: str) -> None:
    async with _lock:
        d = load()
        recs = [x for x in d["records"] if x["id"] != rid]
        if len(recs) == len(d["records"]):
            raise HTTPException(404, "없는 기록입니다")
        replay(recs)  # 매수를 지워 매도가 넘치게 되면 막는다
        d["records"] = recs
        _save(d)


async def add_account(name: str) -> dict:
    name = name.strip()[:20]
    if not name:
        raise HTTPException(400, "계좌 이름을 넣어 주세요")
    async with _lock:
        d = load()
        if any(a["name"] == name for a in d["accounts"]) or name == config.KIS_ACCOUNT_NAME:
            raise HTTPException(400, "같은 이름의 계좌가 있습니다")
        a = {"id": _next_id(d, "a"), "name": name}
        d["accounts"].append(a)
        _save(d)
        return a


async def rename_account(aid: str, name: str) -> dict:
    name = name.strip()[:20]
    if not name:
        raise HTTPException(400, "계좌 이름을 넣어 주세요")
    async with _lock:
        d = load()
        a = next((x for x in d["accounts"] if x["id"] == aid), None)
        if not a:
            raise HTTPException(404, "없는 계좌입니다")
        if any(x["name"] == name and x["id"] != aid for x in d["accounts"]):
            raise HTTPException(400, "같은 이름의 계좌가 있습니다")
        a["name"] = name
        _save(d)
        return a


async def delete_account(aid: str) -> None:
    async with _lock:
        d = load()
        if any(r["account"] == aid for r in d["records"]):
            raise HTTPException(400, "기록이 있는 계좌는 지울 수 없습니다. 기록을 먼저 지워 주세요")
        n = len(d["accounts"])
        d["accounts"] = [a for a in d["accounts"] if a["id"] != aid]
        if len(d["accounts"]) == n:
            raise HTTPException(404, "없는 계좌입니다")
        _save(d)


async def set_fx(v: float) -> None:
    if not 100 <= v <= 10000:
        raise HTTPException(400, "환율이 이상합니다 (1달러 = 100~10,000원)")
    async with _lock:
        d = load()
        d["fx"]["USD"] = float(v)
        _save(d)


async def set_price(key: str, v: float) -> None:
    if not v > 0:
        raise HTTPException(400, "현재가는 0보다 커야 합니다")
    async with _lock:
        d = load()
        d["prices"][key] = {"price": float(v), "at": time.time()}
        _save(d)


def view() -> dict:
    """기록 화면용: 계좌, 기록(최근 것 먼저), 환율, 직접 넣는 현재가 목록"""
    d = load()
    fx, fx_src = usd(d)
    try:
        pos = replay(d["records"])["pos"]
    except HTTPException:
        pos = {}
    manual = [
        {"key": p["key"], "name": p["name"], "asset": p["asset"], "currency": p["currency"], "price": d["prices"].get(p["key"], {}).get("price"), "last": p["last"]}
        for p in pos.values()
        if p["asset"] != "kr" and p["qty"] > 1e-9 and not auto_price(p["asset"], p["symbol"])
    ]
    recs = sorted(d["records"], key=lambda x: (x["date"], x["n"]), reverse=True)
    return {"accounts": d["accounts"], "records": recs, "fx": fx, "fxSource": fx_src, "fxDefault": fx_src == "default", "manual": manual, "assets": ASSETS}
