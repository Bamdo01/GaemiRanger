"""규칙: 사람이 걸어 둔 "이 가격이 되면 이렇게"를 서버가 지켜보다가 실행한다. 정의서 docs/pages/rules.md

- 종류: stop 손절 · take 익절 · trail 추적 손절 · buy 조건부 매수 · alert 가격 알림
- 실행 방식 (2026-11-23 사용자: 추천안으로): 매도 규칙은 notify/confirm/auto 중 고름, 매수는 항상 confirm, 알림은 notify
- 확인 후 주문은 5분 안에 사람이 [주문]을 눌러야 나간다. 지나면 취소
- 장중에만 발동. [모두 정지]면 아무것도 발동하지 않는다
- 주문은 orders.place 를 거친다 → 장 시간, 1회 한도, 하루 횟수, 매도 가능 수량, 매수 가능 금액을 서버가 다시 검사
"""

import asyncio
import json
import os
import time
from datetime import datetime

from fastapi import HTTPException
from pydantic import BaseModel

from . import config, market

FILE = config.DATA / "rules.json"
EVENTS = config.DATA / "rule_events.jsonl"  # 발동 기록 (기록 메뉴 L2)
CONFIRM_SEC = 300
KINDS = {"stop": "손절", "take": "익절", "trail": "추적 손절", "buy": "조건부 매수", "alert": "가격 알림"}
SELL_KINDS = ("stop", "take", "trail")
MODES = {"notify": "알림만", "confirm": "확인 후 주문", "auto": "자동 주문"}
_lock = asyncio.Lock()
pending: dict[str, dict] = {}  # 확인 대기 (서버를 다시 켜면 사라진다 — 5분짜리라 괜찮음)


class RuleIn(BaseModel):
    code: str
    kind: str
    mode: str = "confirm"
    pct: float | None = None  # 손절·익절·추적 % / 알림 오늘 등락 %
    price: int | None = None  # 손절·익절 가격, 매수 가격, 알림 가격
    dir: str = ""  # 알림: above | below | day
    qty: int | None = None  # None 이면 전부 (매도)
    days: int = 30


def load() -> dict:
    try:
        d = json.loads(FILE.read_text("utf-8"))
    except (OSError, ValueError):
        d = {}
    d.setdefault("rules", [])
    d.setdefault("halted", False)
    d.setdefault("seq", 0)
    return d


def _save(d: dict) -> None:
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, FILE)


def _event(rec: dict) -> None:
    with EVENTS.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"at": datetime.now(market.KST).isoformat(timespec="seconds"), **rec}, ensure_ascii=False) + "\n")


def _held(code: str) -> dict | None:
    return next((h for h in market.balance.get("holdings", []) if h["code"] == code), None)


def codes() -> list[str]:
    """감시 중인 규칙의 종목 (실시간 자리 3순위)"""
    d = load()
    if d["halted"]:
        return []
    return list(dict.fromkeys(r["code"] for r in d["rules"] if r["state"] == "watching"))


# ---------- 조건 ----------
def trigger_price(r: dict) -> float | None:
    """이 가격에 닿으면 발동 (방향은 r 의 종류로)"""
    k = r["kind"]
    if k in ("stop", "take"):
        if r.get("price"):
            return r["price"]
        h = _held(r["code"])
        if not h or not r.get("pct"):
            return None
        return h["avg"] * (1 - r["pct"] / 100) if k == "stop" else h["avg"] * (1 + r["pct"] / 100)
    if k == "trail":
        return r.get("high", 0) * (1 - r["pct"] / 100) if r.get("high") else None
    if k == "buy":
        return r["price"]
    if k == "alert":
        if r["dir"] in ("above", "below"):
            return r["price"]
        q = market.quotes.get(r["code"]) or {}
        prev = q.get("prev")
        if not prev:
            return None
        return prev * (1 + r["pct"] / 100) if r["pct"] >= 0 else prev * (1 + r["pct"] / 100)
    return None


def _goes_down(r: dict) -> bool:
    """가격이 내려와야 발동하는가"""
    if r["kind"] in ("stop", "trail", "buy"):
        return True
    if r["kind"] == "take":
        return False
    return r["dir"] == "below" or (r["dir"] == "day" and r["pct"] < 0)


def hit(r: dict, price: float) -> bool:
    t = trigger_price(r)
    if t is None or not price:
        return False
    return price <= t if _goes_down(r) else price >= t


def describe(r: dict) -> str:
    k, n = r["kind"], r.get("name") or r["code"]
    qty = "전부" if r.get("qty") is None else f"{r['qty']:,}주"
    if k in ("stop", "take"):
        cond = f"{r['price']:,}원 {'이하' if k == 'stop' else '이상'}" if r.get("price") else f"평균단가 {'−' if k == 'stop' else '+'}{r['pct']:g}%"
        return f"{n}: {cond}면 {qty} 매도"
    if k == "trail":
        return f"{n}: 건 뒤 최고가에서 −{r['pct']:g}%면 {qty} 매도"
    if k == "buy":
        return f"{n}: {r['price']:,}원 이하면 {r['qty']:,}주 매수 (지정가)"
    if r["dir"] == "day":
        return f"{n}: 오늘 {r['pct']:+g}%{'이하' if r['pct'] < 0 else '이상'}이면 알림"
    return f"{n}: {r['price']:,}원 {'이상' if r['dir'] == 'above' else '이하'}이면 알림"


# ---------- 만들기·바꾸기 ----------
async def add(b: RuleIn) -> dict:
    code = b.code.strip()
    if not config.is_kr_code(code):
        raise HTTPException(400, "국내 종목코드 6자리만 됩니다 (한투 계좌 종목)")
    if b.kind not in KINDS:
        raise HTTPException(400, "규칙 종류가 잘못됐습니다")
    if not 1 <= b.days <= 365:
        raise HTTPException(400, "기한은 1~365일입니다")
    r = {"code": code, "name": (market.quotes.get(code) or {}).get("name") or market.NAMES.get(code, code), "kind": b.kind, "pct": None, "price": None, "dir": "", "qty": b.qty}
    if b.kind in SELL_KINDS:
        h = _held(code)
        if not h:
            raise HTTPException(400, "한투 계좌에 가진 종목에만 매도 규칙을 걸 수 있습니다")
        if b.mode not in MODES:
            raise HTTPException(400, "실행 방식이 잘못됐습니다")
        if b.qty is not None and not 1 <= b.qty <= h["qty"]:
            raise HTTPException(400, f"수량은 1~{h['qty']:,}주 (또는 전부)입니다")
        if b.kind == "trail" or b.price is None:
            if not (b.pct and 0 < b.pct < 100):
                raise HTTPException(400, "%는 0보다 크고 100보다 작아야 합니다")
            r["pct"] = float(b.pct)
        else:
            if b.price <= 0:
                raise HTTPException(400, "가격을 넣어 주세요")
            r["price"] = int(b.price)
        r["mode"] = b.mode
    elif b.kind == "buy":
        if not (b.price and b.price > 0 and b.qty and b.qty > 0):
            raise HTTPException(400, "매수 가격과 수량을 넣어 주세요")
        from . import settings

        if b.price * b.qty > settings.get("orderLimit"):
            raise HTTPException(400, f"1회 주문 한도 {settings.get('orderLimit'):,}원을 넘습니다")
        r.update(price=int(b.price), mode="confirm")  # 매수는 항상 확인 (사용자 결정)
    else:
        if b.dir in ("above", "below"):
            if not (b.price and b.price > 0):
                raise HTTPException(400, "알림 가격을 넣어 주세요")
            r["price"] = int(b.price)
        elif b.dir == "day":
            if not (b.pct and -30 <= b.pct <= 30):
                raise HTTPException(400, "오늘 등락 %는 −30~30 사이입니다")
            r["pct"] = float(b.pct)
        else:
            raise HTTPException(400, "알림 조건이 잘못됐습니다")
        r.update(dir=b.dir, mode="notify", qty=None)
    q = market.quotes.get(code) or {}
    if b.kind == "trail":
        r["high"] = q.get("price") or (_held(code) or {}).get("price") or 0
    async with _lock:
        d = load()
        d["seq"] += 1
        r.update(id=f"u{d['seq']}", state="watching", created=time.time(), expires=time.time() + b.days * 86400)
        d["rules"].append(r)
        _save(d)
    _event({"rule": r["id"], "event": "만듦", "text": describe(r)})
    return r


async def set_state(rid: str, state: str) -> dict:
    if state not in ("watching", "paused"):
        raise HTTPException(400, "상태가 잘못됐습니다")
    async with _lock:
        d = load()
        r = next((x for x in d["rules"] if x["id"] == rid), None)
        if not r:
            raise HTTPException(404, "없는 규칙입니다")
        if state == "watching" and r["state"] in ("fired", "expired", "failed"):
            r["expires"] = max(r["expires"], time.time() + 86400 * 30)
            if r["kind"] == "trail":
                r["high"] = (market.quotes.get(r["code"]) or {}).get("price") or r.get("high", 0)
        r["state"] = state
        _save(d)
    _event({"rule": rid, "event": "다시 켬" if state == "watching" else "멈춤"})
    return r


async def delete(rid: str) -> None:
    async with _lock:
        d = load()
        n = len(d["rules"])
        d["rules"] = [x for x in d["rules"] if x["id"] != rid]
        if len(d["rules"]) == n:
            raise HTTPException(404, "없는 규칙입니다")
        _save(d)
    for k in [k for k, p in pending.items() if p["rule"] == rid]:
        pending.pop(k, None)
    _event({"rule": rid, "event": "지움"})


async def halt(on: bool) -> None:
    async with _lock:
        d = load()
        d["halted"] = on
        _save(d)
    if on:
        pending.clear()
    _event({"event": "모두 정지" if on else "다시 시작"})


def _notify() -> None:
    from . import realtime

    realtime._bump()  # 화면(확인 대기 알림)에 바로 알린다


# ---------- 실행 ----------
def _order_for(r: dict, price: float):
    from .orders import OrderIn

    if r["kind"] == "buy":
        return OrderIn(code=r["code"], side="buy", kind="limit", price=r["price"], qty=r["qty"])
    h = _held(r["code"]) or {}
    qty = h.get("sellable", 0) if r.get("qty") is None else min(r["qty"], h.get("sellable", 0))
    return OrderIn(code=r["code"], side="sell", kind="market", price=0, qty=max(qty, 1))


async def _execute(r: dict, price: float, by: str) -> dict:
    from . import orders

    try:
        res = await orders.place(_order_for(r, price), by=by)
        return {"ok": True, "orderNo": res.get("orderNo", ""), "msg": res.get("msg", "")}
    except HTTPException as e:
        return {"ok": False, "msg": str(e.detail)}
    except Exception as e:  # noqa: BLE001 - 검사에서 막힌 수량 0 등
        return {"ok": False, "msg": f"{e.__class__.__name__}: {e}"}


async def _fire(r: dict, price: float) -> None:
    from . import realtime

    r["firedAt"], r["firedPrice"] = time.time(), price
    text = describe(r)
    if r["mode"] == "notify":
        r["state"], r["result"] = "fired", "알림"
        _event({"rule": r["id"], "event": "발동", "mode": "알림만", "price": price, "text": text})
    elif r["mode"] == "confirm":
        r["state"], r["result"] = "fired", "확인 대기"
        pid = f"p{r['id']}{int(time.time())}"
        pending[pid] = {"id": pid, "rule": r["id"], "code": r["code"], "name": r.get("name", r["code"]), "kind": r["kind"], "text": text, "price": price, "at": time.time(), "until": time.time() + CONFIRM_SEC}
        _event({"rule": r["id"], "event": "발동", "mode": "확인 후 주문", "price": price, "text": text})
    else:
        res = await _execute(r, price, f"규칙 {r['id']} 자동")
        r["state"] = "fired" if res["ok"] else "failed"
        r["result"] = f"자동 주문 접수 {res.get('orderNo', '')}".strip() if res["ok"] else f"자동 주문 실패: {res['msg']}"
        _event({"rule": r["id"], "event": "발동", "mode": "자동 주문", "price": price, "text": text, **res})
    from . import alerts

    mode = {"notify": "알림만", "confirm": "확인 후 주문"}.get(r["mode"], "자동 주문")
    alerts.rule_fired(r, price, text + (f" → {r['result']}" if r["mode"] == "auto" else ""), mode)
    realtime._bump()  # 화면에 바로 알린다


async def confirm(pid: str) -> dict:
    p = pending.pop(pid, None)
    if not p:
        raise HTTPException(404, "확인 대기가 없거나 이미 처리됐습니다")
    if time.time() > p["until"]:
        raise HTTPException(400, "5분이 지나 취소됐습니다")
    if load()["halted"]:
        raise HTTPException(400, "모두 정지 중이라 주문하지 않습니다")
    d = load()
    r = next((x for x in d["rules"] if x["id"] == p["rule"]), None)
    if not r:
        raise HTTPException(404, "규칙이 지워졌습니다")
    q = market.quotes.get(r["code"]) or {}
    res = await _execute(r, q.get("price") or p["price"], f"규칙 {r['id']} 확인")
    async with _lock:
        d = load()
        for x in d["rules"]:
            if x["id"] == r["id"]:
                x["result"] = f"주문 접수 {res.get('orderNo', '')}".strip() if res["ok"] else f"주문 실패: {res['msg']}"
                x["state"] = "fired" if res["ok"] else "failed"
        _save(d)
    _event({"rule": r["id"], "event": "확인 후 주문", **res})
    _notify()
    if not res["ok"]:
        raise HTTPException(400, res["msg"])
    return res


async def dismiss(pid: str) -> None:
    p = pending.pop(pid, None)
    if not p:
        raise HTTPException(404, "확인 대기가 없거나 이미 처리됐습니다")
    async with _lock:
        d = load()
        for x in d["rules"]:
            if x["id"] == p["rule"] and x.get("result") == "확인 대기":
                x["result"] = "무시함"
        _save(d)
    _event({"rule": p["rule"], "event": "무시"})
    _notify()


async def tick() -> None:
    """한 번 훑기: 만료 정리, 추적 손절 최고가, 조건 확인"""
    now = time.time()
    for k in [k for k, p in pending.items() if now > p["until"]]:
        p = pending.pop(k)
        _event({"rule": p["rule"], "event": "확인 시간 지남"})
        _notify()
        async with _lock:
            d = load()
            for x in d["rules"]:
                if x["id"] == p["rule"] and x.get("result") == "확인 대기":
                    x["result"] = "5분 지나 취소"
            _save(d)
    async with _lock:
        d = load()
        changed = False
        for r in d["rules"]:
            if r["state"] == "watching" and now > r["expires"]:
                r["state"], changed = "expired", True
        if d["halted"] or not market.market_open():
            if changed:
                _save(d)
            return
        for r in d["rules"]:
            if r["state"] != "watching":
                continue
            q = market.quotes.get(r["code"]) or {}
            price = q.get("price")
            if not price or now - q.get("at", 0) > 60:  # 1분 넘은 시세로는 발동하지 않는다
                continue
            if r["kind"] == "trail" and price > r.get("high", 0):
                r["high"], changed = price, True
            if hit(r, price):
                await _fire(r, price)
                changed = True
        if changed:
            _save(d)


async def run_forever() -> None:
    while True:
        try:
            await tick()
        except Exception as e:  # noqa: BLE001 - 감시가 죽지 않게
            _event({"event": "감시 오류", "msg": f"{e.__class__.__name__}: {e}"})
        await asyncio.sleep(1)


def view() -> dict:
    d = load()
    now = time.time()
    out = []
    for r in d["rules"]:
        q = market.quotes.get(r["code"]) or {}
        price = q.get("price")
        t = trigger_price(r)
        dist = ((t - price) / price * 100) if (t and price) else None
        out.append({**r, "kindName": KINDS[r["kind"]], "modeName": MODES[r["mode"]], "text": describe(r), "now": price, "trigger": round(t) if t else None, "dist": dist, "live": bool(q.get("live") and now - q.get("at", 0) < 10)})
    today = datetime.now(market.KST).strftime("%Y-%m-%d")
    fired_today = len([r for r in d["rules"] if r.get("firedAt") and datetime.fromtimestamp(r["firedAt"], market.KST).strftime("%Y-%m-%d") == today])
    return {"rules": out, "pending": sorted(pending.values(), key=lambda p: p["at"]), "halted": d["halted"], "firedToday": fired_today, "marketOpen": market.market_open()}
