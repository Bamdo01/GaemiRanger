"""투자 하네스: 계좌 하나를 맡아 굴리는 자동매매 틀 (2026-11-25, 지금은 가상 계좌만).

구조
- 전략: AI(Claude, 도구 없음)가 1시간마다 시장별(국내 정규장·미국 정규장)로 판단해 JSON 으로 주문안을 낸다
- 안전장치(코드가 강제): 투자 범위, 한 종목 최대 비중, 한 번 매매 최대 금액, 하루 매매 횟수, 최소 현금, 손절선, 정규장만, 비상 정지
- 체결: 가상 장부. 실제 한투 시세로 바로 체결한 것으로 보고 수수료·세금을 뗀다 (호가 잔량·미체결은 단순화)
- 기록: 판단(시장 판단 한 줄, 주문안, 통과·거절 이유)과 매매를 모두 남긴다
- 보고: 국내 장 마감 뒤(15:45)와 미국 장 마감 뒤(06:15) 텔레그램

진짜 계좌 주문(orders.py)은 부르지 않는다. 진짜 계좌로 넓히는 것은 가상 성적을 보고 따로 정한다.
"""

import asyncio
import json
import math
import re
import time
from datetime import datetime

from . import ai, config, market, members, prices, settings, telegram, views
from .kis import KISError

FILE = config.DATA / "harness.json"
START = 10_000_000
FEE_KR = 0.00015  # 국내 매매 수수료 (온라인, 대략)
TAX_KR = 0.0020  # 국내 매도 세금 (증권거래세+농특세, 2026년 기준 대략)
FEE_US = 0.0025  # 미국 매매 수수료 (대략). 환전 비용은 뺐다
LIMITS = {
    "maxPosPct": 15,  # 한 종목 최대 비중 (총평가 대비 %)
    "maxTradePct": 10,  # 한 번 매수 최대 금액 (총평가 대비 %)
    "maxTradesDay": 10,  # 하루 매매 횟수 (손절 포함)
    "minCashPct": 5,  # 매수 뒤에도 남겨 둘 현금 (%)
    "stopPct": -10,  # 평균단가 대비 이만큼 떨어지면 1분 안에 전량 매도
    "maxOrdersPerDecision": 3,
    "decideEveryMin": 60,
}
KR_ETF = {
    "069500": "KODEX 200",
    "102110": "TIGER 200",
    "229200": "KODEX 코스닥150",
    "360750": "TIGER 미국S&P500",
    "133690": "TIGER 미국나스닥100",
    "379800": "KODEX 미국S&P500",
    "114260": "KODEX 국고채3년",
    "132030": "KODEX 골드선물(H)",
    "153130": "KODEX 단기채권",
}
US_ETF = {"SPY", "VOO", "IVV", "QQQ", "VTI", "DIA", "IWM", "SCHD", "TLT", "IEF", "SHY", "GLD", "SMH", "SOXX", "VEA", "VWO", "BND"}

data: dict = {}
_lock = asyncio.Lock()
state = {"lastError": "", "running": ""}


def _now() -> datetime:
    return datetime.now(market.KST)


def _iso() -> str:
    return _now().isoformat(timespec="seconds")


def load() -> dict:
    if not data:
        if FILE.exists():
            try:
                data.update(json.loads(FILE.read_text("utf-8")))
            except (OSError, ValueError):
                pass
        if not data.get("accounts"):
            data["accounts"] = [_new_account("paper1", "가상 하네스 (AI)")]
            _save()
    return data


def _new_account(aid: str, name: str) -> dict:
    return {"id": aid, "name": name, "kind": "paper", "strategy": "ai", "start": START, "cash": START, "createdAt": _iso(), "enabled": True, "positions": {}, "trades": [], "decisions": [], "equity": [], "lastDecide": {}, "today": {"day": "", "n": 0}, "reported": {}}


def _save() -> None:
    try:
        tmp = FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        tmp.replace(FILE)
    except OSError:
        pass


def account(aid: str) -> dict | None:
    return next((a for a in load()["accounts"] if a["id"] == aid), None)


# ---------- 시세 ----------
def _fx() -> float:
    return prices.fx.get("usd") or 1350.0


async def price_of(asset: str, code: str) -> tuple[float, str]:
    """(현재가, 이름). 국내는 원, 미국은 달러. 3분 넘은 값이면 새로 받는다"""
    if asset == "kr":
        q = market.quotes.get(code)
        if not q or time.time() - q.get("at", 0) > 180:
            q = await market.fetch_quote(code)
        return float(q.get("price") or 0), KR_ETF.get(code) or q.get("name") or code
    p = views._us_px.get(code)
    if p and time.time() - p.get("at", 0) < 180:
        return float(p["price"]), p.get("name") or code
    d = await views.us_detail(code)
    return float(d["price"]), d.get("name") or code


def in_universe(asset: str, code: str) -> bool:
    if asset == "kr":
        return code in KR_ETF or any(m["code"] == code for m in members.get("kospi200"))
    return code in US_ETF or any(m["code"] == code for v in ("sp500", "ndx", "dji") for m in members.get(v))


def session_open(asset: str) -> bool:
    return (market.kr_session()["code"] == "regular") if asset == "kr" else (market.us_session()["code"] == "regular")


async def valuation(a: dict, fetch: bool = False) -> dict:
    """총평가와 종목별 평가 (원). fetch=False 면 받아 둔 값만 쓴다 (화면용)"""
    fx = _fx()
    rows, invest = [], 0.0
    for key, p in a["positions"].items():
        price = 0.0
        if fetch:
            try:
                price, _ = await price_of(p["asset"], p["code"])
            except KISError:
                price = 0.0
        if not price:
            if p["asset"] == "kr":
                price = float((market.quotes.get(p["code"]) or {}).get("price") or 0)
            else:
                price = float((views._us_px.get(p["code"]) or {}).get("price") or 0)
        price = price or p["avg"]
        krw = price * (fx if p["asset"] == "us" else 1)
        amt = p["qty"] * krw
        cost = p["qty"] * p["avgKrw"]
        invest += amt
        rows.append({**p, "key": key, "price": price, "priceKrw": krw, "amt": amt, "pnl": amt - cost, "pnlPct": (p["qty"] and (price / p["avg"] - 1) * 100) if p["avg"] else 0})
    total = a["cash"] + invest
    for r in rows:
        r["weight"] = r["amt"] / total * 100 if total else 0
    rows.sort(key=lambda r: -r["amt"])
    return {"total": total, "cash": a["cash"], "invest": invest, "pnl": total - a["start"], "pnlPct": (total / a["start"] - 1) * 100, "rows": rows, "fx": fx}


# ---------- 체결 (안전장치를 여기서 강제) ----------
def _today(a: dict) -> dict:
    day = _now().strftime("%Y-%m-%d")
    if a["today"].get("day") != day:
        a["today"] = {"day": day, "n": 0}
    return a["today"]


async def execute(a: dict, o: dict, by: str) -> str:
    """주문안 하나를 검사하고 가상 체결. 돌려주는 글은 결과 (체결 또는 거절 이유)"""
    side, asset, code = o.get("side"), o.get("market"), str(o.get("code") or "").upper().strip()
    if side not in ("buy", "sell") or asset not in ("kr", "us") or not code:
        return "거절: 주문 형식이 잘못됨"
    if settings.get("emergency"):
        return "거절: 비상 정지 중"
    if not a.get("enabled") and by != "stop":
        return "거절: 하네스가 꺼져 있음"
    if not session_open(asset):
        return "거절: 정규장 시간이 아님"
    t = _today(a)
    if t["n"] >= LIMITS["maxTradesDay"] and by != "stop":
        return f"거절: 오늘 매매 {LIMITS['maxTradesDay']}번을 다 씀"
    key = f"{asset}:{code}"
    pos = a["positions"].get(key)
    if side == "buy" and not in_universe(asset, code):
        return "거절: 투자 범위 밖 (코스피200·S&P500·나스닥100·다우30·지정 ETF만)"
    try:
        price, name = await price_of(asset, code)
    except KISError as e:
        return f"거절: 시세를 못 받음 ({e})"
    if price <= 0:
        return "거절: 시세 없음"
    fx = _fx() if asset == "us" else 1.0
    krw = price * fx
    val = await valuation(a)
    total = val["total"]
    fee_rate = FEE_KR if asset == "kr" else FEE_US

    if side == "buy":
        amount = float(o.get("amountKrw") or 0)
        amount = min(amount, total * LIMITS["maxTradePct"] / 100)
        held = (pos["qty"] * krw) if pos else 0
        amount = min(amount, total * LIMITS["maxPosPct"] / 100 - held)
        amount = min(amount, a["cash"] - total * LIMITS["minCashPct"] / 100)
        qty = math.floor(amount / (krw * (1 + fee_rate))) if amount > 0 else 0
        if qty < 1:
            return f"거절: 한도 안에서 살 수 있는 수량이 없음 (1주 {krw:,.0f}원, 한 종목 {LIMITS['maxPosPct']}%·한 번 {LIMITS['maxTradePct']}%·현금 {LIMITS['minCashPct']}% 남기기)"
        cost = qty * krw
        fee = cost * fee_rate
        a["cash"] -= cost + fee
        if pos:
            n = pos["qty"] + qty
            pos["avg"] = (pos["avg"] * pos["qty"] + price * qty) / n
            pos["avgKrw"] = (pos["avgKrw"] * pos["qty"] + krw * qty) / n
            pos["qty"] = n
        else:
            a["positions"][key] = {"asset": asset, "code": code, "name": name, "qty": qty, "avg": price, "avgKrw": krw, "since": _iso()}
        tax = 0.0
    else:
        if not pos:
            return "거절: 갖고 있지 않은 종목"
        want = o.get("qty")
        qty = pos["qty"] if want in (None, "all") else min(int(float(want)), pos["qty"])
        if qty < 1:
            return "거절: 팔 수량이 없음"
        cost = qty * krw
        fee = cost * fee_rate
        tax = cost * TAX_KR if asset == "kr" else 0.0
        a["cash"] += cost - fee - tax
        realized = (krw - pos["avgKrw"]) * qty - fee - tax
        pos["qty"] -= qty
        if pos["qty"] <= 0:
            a["positions"].pop(key)
    t["n"] += 1
    tr = {"at": _iso(), "side": side, "market": asset, "code": code, "name": name, "qty": qty, "price": price, "fx": fx if asset == "us" else None, "amount": round(cost), "fee": round(fee), "tax": round(tax), "by": by, "reason": str(o.get("reason") or "")[:300]}
    if side == "sell":
        tr["realized"] = round(realized)
    a["trades"].append(tr)
    a["trades"] = a["trades"][-500:]
    _save()
    word = "매수" if side == "buy" else "매도"
    unit = f"${price:,.2f}" if asset == "us" else f"{price:,.0f}원"
    return f"체결: {name} {qty}주 {word} ({unit}, {cost:,.0f}원)"


# ---------- 손절 (1분마다) ----------
async def check_stops(a: dict) -> list[str]:
    out = []
    for key, p in list(a["positions"].items()):
        if not session_open(p["asset"]):
            continue
        try:
            price, _ = await price_of(p["asset"], p["code"])
        except KISError:
            continue
        if price and p["avg"] and (price / p["avg"] - 1) * 100 <= LIMITS["stopPct"]:
            r = await execute(a, {"side": "sell", "market": p["asset"], "code": p["code"], "qty": "all", "reason": f"손절선 {LIMITS['stopPct']}% 도달 (평균 {p['avg']:,.2f} → {price:,.2f})"}, "stop")
            out.append(r)
            if r.startswith("체결") and telegram.configured():
                try:
                    await telegram.send(f"[가상 하네스] 손절 {r[4:]}")
                except Exception:  # noqa: BLE001
                    pass
    return out


# ---------- AI 판단 ----------
SYSTEM = """너는 '개미레인저' 앱의 가상 투자 하네스를 맡은 펀드매니저다. 진짜 돈이 아닌 가상 계좌(시작 1천만 원)를 굴려, 사용자가 자동매매를 맡겨도 될지 판단할 성적과 기록을 만든다.

원칙
- 목표는 '자산 지키기'를 먼저 두고 시장 평균(코스피·S&P500)을 이기는 것. 큰 손실을 피하는 것이 수익보다 우선이다.
- 분산한다. 국내와 미국, 개별 종목과 지수 ETF 를 섞는다. 현금도 선택지다.
- 근거는 아래에 주는 데이터(가격, 오늘 등락률, 알림·뉴스 제목, 보유 현황)만 쓴다. 데이터에 없는 뉴스·실적을 지어내지 않는다.
- 자주 사고팔지 않는다. 바꿀 이유가 없으면 주문 없이 지켜본다.
- 코드가 강제하는 한도: 한 종목 최대 15%, 한 번 매수 최대 총평가의 10%, 매수 뒤 현금 5% 이상, 하루 매매 10번, 평균단가 대비 -10%면 자동 손절. 이 한도를 넘는 주문은 잘린다.
- 이번 판단에서 주문할 수 있는 시장은 아래 [이번 시장] 하나뿐이다.

답은 JSON 하나만, 다른 글 없이:
{"view": "지금 시장과 계좌에 대한 판단 한두 문장", "orders": [{"side": "buy", "market": "kr 또는 us", "code": "종목코드 또는 티커", "amountKrw": 1000000, "reason": "이유 한 문장"}, {"side": "sell", "market": "us", "code": "AAPL", "qty": "all 또는 주식 수", "reason": "이유 한 문장"}]}
주문은 최대 3개. 할 것이 없으면 "orders": []."""


def _fmt_rows(rows: list[dict], usd: bool) -> list[str]:
    out = []
    for s in rows:
        pct = (s["price"] / s["prev"] - 1) * 100 if s.get("prev") else 0
        p = f"${s['price']:,.2f}" if usd else f"{s['price']:,.0f}"
        out.append(f"{s['code']} {s['name']} {p} ({pct:+.2f}%)")
    return out


async def _context(a: dict, mkt: str) -> str:
    val = await valuation(a, fetch=True)
    lines = [
        f"[지금] {_now():%Y-%m-%d %H:%M} 한국 시간, 국내 {market.kr_session()['label']}, 미국 {market.us_session()['label']}",
        f"[이번 시장] {'국내 (코스피200 종목·국내 지정 ETF)' if mkt == 'kr' else '미국 (S&P500·나스닥100·다우30 종목·미국 지정 ETF)'}",
        f"[계좌] 총평가 {val['total']:,.0f}원 (시작 {a['start']:,.0f}원 대비 {val['pnlPct']:+.2f}%), 현금 {a['cash']:,.0f}원 ({a['cash'] / val['total'] * 100:.1f}%), 환율 {val['fx']:,.1f}원/달러, 오늘 매매 {_today(a)['n']}/{LIMITS['maxTradesDay']}번",
    ]
    if val["rows"]:
        lines.append("[보유]")
        for r in val["rows"]:
            p = f"${r['price']:,.2f} (평균 ${r['avg']:,.2f})" if r["asset"] == "us" else f"{r['price']:,.0f}원 (평균 {r['avg']:,.0f}원)"
            lines.append(f"- {r['asset']} {r['code']} {r['name']} {r['qty']}주 {p}, 수익률 {r['pnlPct']:+.1f}%, 비중 {r['weight']:.1f}%")
    else:
        lines.append("[보유] 없음 (전부 현금)")
    idx = [f"{i['name']} {i['value']:,.2f} ({(i['value'] / i['prev'] - 1) * 100:+.2f}%)" for i in market.indices.values() if i.get("prev")]
    if idx:
        lines.append("[지수] " + ", ".join(idx))
    if mkt == "kr":
        top = [q for c, _, _ in views.UNIVERSE if (q := market.quotes.get(c)) and q.get("price")][:50]
        lines.append("[국내 시총 상위 50 (코드 이름 가격 오늘)]")
        lines += _fmt_rows(top, False)
        etf = []
        for c, n in KR_ETF.items():
            q = market.quotes.get(c)
            if q and q.get("price"):
                etf.append({**q, "name": n})
        if etf:
            lines.append("[국내 지정 ETF]")
            lines += _fmt_rows(etf, False)
    else:
        want = {m["code"] for v in ("dji", "ndx") for m in members.get(v)} | US_ETF
        if time.time() - views._us_px_at[0] > 300:
            try:
                await views._us_rank_pages(want)
            except KISError:
                pass
        rows = [{"code": s, **p} for s, p in views._us_px.items() if s in want and p.get("price")]
        rows.sort(key=lambda r: -(r.get("cap") or 0))
        lines.append("[미국 주요 종목·ETF (티커 이름 가격 오늘)]")
        lines += _fmt_rows(rows[:70], True)
    try:
        from . import alerts

        news = alerts.for_ai(24, 12)
        if news:
            lines.append("[최근 24시간 알림·뉴스 제목 (사용자 실계좌 보유 종목 기준)]")
            lines += news
    except Exception:  # noqa: BLE001
        pass
    return "\n".join(lines)


def _parse(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("JSON 없음")
    d = json.loads(m.group(0))
    if not isinstance(d.get("orders"), list):
        d["orders"] = []
    return d


async def decide(a: dict, mkt: str, why: str = "정기") -> dict:
    """AI 에게 묻고, 주문안을 하나씩 검사해 가상 체결. 판단 기록을 돌려준다"""
    async with _lock:
        state["running"] = f"{a['id']}:{mkt}"
        rec = {"at": _iso(), "market": mkt, "why": why, "view": "", "orders": [], "results": [], "error": ""}
        try:
            ctx = await _context(a, mkt)
            text = await ai.ask_system(SYSTEM, ctx + "\n\n위 데이터로 이번 시장의 판단과 주문안을 JSON 으로.")
            d = _parse(text)
            rec["view"] = str(d.get("view") or "")[:400]
            for o in d["orders"][: LIMITS["maxOrdersPerDecision"]]:
                if not isinstance(o, dict):
                    continue
                if o.get("market") != mkt:
                    rec["orders"].append(o)
                    rec["results"].append("거절: 이번 판단의 시장이 아님")
                    continue
                rec["orders"].append(o)
                rec["results"].append(await execute(a, o, "ai"))
        except Exception as e:  # noqa: BLE001 - 실패도 기록으로 남긴다
            rec["error"] = f"{e.__class__.__name__}: {e}"[:300]
            state["lastError"] = rec["error"]
        finally:
            state["running"] = ""
        a["lastDecide"][mkt] = time.time()
        a["decisions"].append(rec)
        a["decisions"] = a["decisions"][-300:]
        _save()
        return rec


# ---------- 보고·기록 ----------
async def _snapshot(a: dict) -> None:
    day = _now().strftime("%Y-%m-%d")
    val = await valuation(a)
    eq = a["equity"]
    if eq and eq[-1]["day"] == day:
        eq[-1]["value"] = round(val["total"])
    else:
        eq.append({"day": day, "value": round(val["total"])})
    a["equity"] = eq[-400:]


async def report(a: dict, title: str) -> str:
    val = await valuation(a, fetch=True)
    us = title.startswith("미국")
    since = (_now().timestamp() - 20 * 3600) if us else _now().replace(hour=0, minute=0, second=0).timestamp()
    trades = [t for t in a["trades"] if (t["market"] == "us") == us and datetime.fromisoformat(t["at"]).timestamp() >= since]
    lines = [f"[가상 하네스] {title}", f"총평가 {val['total']:,.0f}원 ({val['pnlPct']:+.2f}%, 시작 {a['start']:,.0f}원)", f"현금 {a['cash']:,.0f}원 · 보유 {len(val['rows'])}종목"]
    for r in val["rows"][:6]:
        lines.append(f"- {r['name']} {r['weight']:.0f}% ({r['pnlPct']:+.1f}%)")
    if trades:
        lines.append(f"오늘 매매 {len(trades)}건")
        for t in trades[-5:]:
            lines.append(f"- {'매수' if t['side'] == 'buy' else '매도'} {t['name']} {t['qty']}주: {t['reason'][:60]}")
    else:
        lines.append("오늘 매매 없음")
    last = next((d for d in reversed(a["decisions"]) if d.get("view")), None)
    if last:
        lines.append(f"최근 판단: {last['view'][:150]}")
    return "\n".join(lines)


async def run_forever() -> None:
    load()
    while True:
        try:
            if config.kis_configured():
                await members.refresh()
                for a in load()["accounts"]:
                    await check_stops(a)
                    await _snapshot(a)
                    if a.get("enabled") and ai.configured() and not settings.get("emergency"):
                        for mkt, sess in (("kr", market.kr_session()), ("us", market.us_session())):
                            if sess["code"] != "regular":
                                continue
                            # 장 시작 30분 뒤부터, 1시간마다
                            n = _now() if mkt == "kr" else market.us_time()
                            open_min = (n.hour * 60 + n.minute) - (540 if mkt == "kr" else 570)
                            if open_min < 30:
                                continue
                            if time.time() - a["lastDecide"].get(mkt, 0) >= LIMITS["decideEveryMin"] * 60 - 30:
                                await decide(a, mkt)
                    # 보고: 국내 마감 뒤 15:45, 미국 마감 뒤 06:15 (평일)
                    n = _now()
                    for tag, hh, mm, title in (("kr", 15, 45, "국내 장 마감 보고"), ("us", 6, 15, "미국 장 마감 보고")):
                        key = f"{tag}:{n:%Y-%m-%d}"
                        if (n.weekday() < 5) if tag == "kr" else (1 <= n.weekday() <= 5):
                            if (n.hour, n.minute) >= (hh, mm) and (n.hour, n.minute) < (hh + 1, mm) and a["reported"].get(tag) != key:
                                a["reported"][tag] = key
                                _save()
                                if telegram.configured():
                                    await telegram.send(await report(a, title), silent=True)
                    _save()
        except Exception as e:  # noqa: BLE001 - 하네스가 죽지 않게
            state["lastError"] = f"{_now():%H:%M:%S} {e.__class__.__name__}: {e}"[:300]
        await asyncio.sleep(60)


# ---------- 화면 ----------
async def view() -> dict:
    out = []
    for a in load()["accounts"]:
        val = await valuation(a)
        out.append(
            {
                "id": a["id"],
                "name": a["name"],
                "kind": a["kind"],
                "strategy": a["strategy"],
                "enabled": a["enabled"],
                "start": a["start"],
                "createdAt": a["createdAt"],
                "value": val,
                "today": _today(a),
                "trades": a["trades"][-40:][::-1],
                "decisions": a["decisions"][-30:][::-1],
                "equity": a["equity"][-120:],
                "lastDecide": a["lastDecide"],
            }
        )
    return {"accounts": out, "limits": LIMITS, "sessions": market.sessions(), "ai": ai.configured(), "running": state["running"], "lastError": state["lastError"], "fees": {"kr": FEE_KR, "krTax": TAX_KR, "us": FEE_US}}
