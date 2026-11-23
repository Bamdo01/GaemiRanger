"""1분 주기 알림 (2026-11-23 사용자 결정: 추천안).

매분 AI 없이 규칙으로 본다 (빠르고 공짜):
- 보유·규칙 종목 급등락: 정한 분(기본 5분) 사이 ±정한 %(기본 3%)
- 거래량 급증 (국내): 최근 5분 거래량이 오늘 5분 평균의 정한 배(기본 3배)
- 보유 국내 종목의 새 뉴스 (한투 시황·뉴스 제목)
- 보유 국내 종목의 새 공시 (OpenDART, .env 의 DART_API_KEY 가 있을 때만)
- 내 자산 오늘 손익이 ±정한 %(기본 3%)를 넘음 (3%, 6%, 9% … 단계마다 한 번)
- 규칙 발동 (rules 가 바로 부른다. 확인 대기는 5분 안에 눌러야 하므로 AI 없이 바로)

사건이 생기면 data/alerts.jsonl 에 남기고, 텔레그램과 화면 알림함에 바로 보낸다.
AI(Claude Code) 요약은 그다음에 붙인다: 사건이 있을 때만, 시간당 최대 aiPerHour 번 (구독 한도 보호).
밤(23~07시)에는 텔레그램을 소리 없이 보낸다 (미국장 알림이 있어서 끊지는 않는다).
"""

import asyncio
import json
import os
import time
from collections import deque
from datetime import datetime

import httpx
from fastapi import HTTPException
from pydantic import BaseModel

from . import config, market, telegram
from .kis import KISError, kis

FILE = config.DATA / "alerts.jsonl"
SETTINGS = config.DATA / "alert_settings.json"
SEEN = config.DATA / "alert_seen.json"  # 이미 본 뉴스·공시 번호 (다시 켜도 같은 걸 또 보내지 않게)
NEWS = "/uapi/domestic-stock/v1/quotations/news-title"
DART_LIST = "https://opendart.fss.or.kr/api/list.json"

DEFAULTS = {
    "enabled": True,
    "movePct": 3.0,  # 급등락 기준 %
    "moveMin": 5,  # 몇 분 사이
    "volX": 3.0,  # 거래량 몇 배
    "news": True,
    "disclosure": True,
    "dayPct": 3.0,  # 오늘 손익 기준 % (0 이면 끔)
    "aiPerHour": 6,  # AI 요약 시간당 최대 (0 이면 AI 요약 안 함)
    "telegram": True,
    "quietNight": True,  # 23~07시 소리 없이
}
RANGES = {"movePct": (0.5, 30), "moveMin": (1, 60), "volX": (1.5, 20), "dayPct": (0, 30), "aiPerHour": (0, 30)}
COOLDOWN = 30 * 60  # 같은 종목·같은 종류는 30분에 한 번
MIN_VOL_WON = 50_000_000  # 거래량 급증은 5분 거래대금이 5천만원 넘을 때만 (작은 종목 잡음 줄이기)
KIND = {"move": "급등락", "volume": "거래량", "news": "뉴스", "disclosure": "공시", "day": "오늘 손익", "rule": "규칙", "test": "시험"}

recent: deque[dict] = deque(maxlen=300)  # 최근 알림 (화면·AI 가 본다). 켤 때 파일에서 채운다
state = {"lastRun": 0.0, "lastError": "", "news": "", "dart": "", "aiHour": "", "aiN": 0, "watching": 0}
_hist: dict[str, deque] = {}  # 코드 → (시각, 가격, 누적거래량)
_cool: dict[str, float] = {}
_day = {"date": "", "level": 0}
_seen: dict[str, list[str]] = {"news": [], "dart": []}
_http: httpx.AsyncClient | None = None
_seq = [0]


# ---------- 설정 ----------
def settings() -> dict:
    try:
        d = json.loads(SETTINGS.read_text("utf-8"))
    except (OSError, ValueError):
        d = {}
    return {**DEFAULTS, **{k: v for k, v in d.items() if k in DEFAULTS}}


class SettingsIn(BaseModel):
    enabled: bool
    movePct: float
    moveMin: int
    volX: float
    news: bool
    disclosure: bool
    dayPct: float
    aiPerHour: int
    telegram: bool
    quietNight: bool


def save_settings(b: SettingsIn) -> dict:
    d = b.model_dump()
    for k, (lo, hi) in RANGES.items():
        if not lo <= d[k] <= hi:
            raise HTTPException(400, f"{k} 는 {lo}~{hi} 사이여야 합니다")
    old = settings()
    tmp = SETTINGS.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, SETTINGS)
    return {k: (old[k], v) for k, v in d.items() if old.get(k) != v}


# ---------- 기록 ----------
def _now() -> datetime:
    return datetime.now(market.KST)


def _load() -> None:
    if FILE.exists():
        by: dict[str, dict] = {}
        for line in FILE.read_text("utf-8").splitlines()[-1000:]:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("update"):  # AI 요약은 나중에 덧붙인 줄
                if r["id"] in by:
                    by[r["id"]]["ai"] = r.get("ai", "")
            else:
                by[r["id"]] = r
        recent.extend(list(by.values())[-300:])
    try:
        _seen.update(json.loads(SEEN.read_text("utf-8")))
    except (OSError, ValueError):
        pass


def _append(rec: dict) -> None:
    with FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _save_seen() -> None:
    for k in _seen:
        _seen[k] = _seen[k][-500:]
    SEEN.write_text(json.dumps(_seen), "utf-8")


def _new(kind: str, title: str, code: str = "", name: str = "", detail: str = "", link: str = "") -> dict:
    _seq[0] += 1
    return {"id": f"a{int(time.time() * 1000)}{_seq[0]}", "at": _now().isoformat(timespec="seconds"), "kind": kind, "code": code, "name": name, "title": title, "detail": detail, "link": link, "ai": ""}


def _cool_ok(key: str) -> bool:
    if time.time() - _cool.get(key, 0) < COOLDOWN:
        return False
    _cool[key] = time.time()
    return True


def view(limit: int = 50) -> dict:
    items = list(recent)[-limit:][::-1]
    s = settings()
    return {
        "items": items,
        "settings": s,
        "status": {
            "lastRun": state["lastRun"],
            "lastError": state["lastError"],
            "news": state["news"],
            "dart": state["dart"] or ("키 없음 (backend/.env 의 DART_API_KEY)" if not config.DART_API_KEY else ""),
            "telegram": telegram.configured(),
            "ai": _ai_ok(),
            "aiUsed": state["aiN"] if state["aiHour"] == _now().strftime("%Y%m%d%H") else 0,
            "watching": state["watching"],
        },
    }


def for_ai(hours: int = 24, n: int = 15) -> list[str]:
    """AI 리뷰에 넘길 최근 알림 (한 줄씩)"""
    since = _now().timestamp() - hours * 3600
    out = []
    for r in list(recent)[::-1]:
        try:
            t = datetime.fromisoformat(r["at"]).timestamp()
        except ValueError:
            continue
        if t < since or r["kind"] == "test":
            continue
        out.append(f"{r['at'][5:16].replace('T', ' ')} [{KIND.get(r['kind'], r['kind'])}] {r['title']}" + (f" ({r['detail'][:80]})" if r.get("detail") else ""))
        if len(out) >= n:
            break
    return out


# ---------- 내보내기 ----------
def _quiet() -> bool:
    h = _now().hour
    return settings()["quietNight"] and (h >= 23 or h < 7)


def _ai_ok() -> bool:
    from . import ai

    return ai.configured() and settings()["aiPerHour"] > 0


def _take_ai() -> bool:
    hour = _now().strftime("%Y%m%d%H")
    if state["aiHour"] != hour:
        state.update(aiHour=hour, aiN=0)
    if not _ai_ok() or state["aiN"] >= settings()["aiPerHour"]:
        return False
    state["aiN"] += 1
    return True


def _tg_text(evs: list[dict], ai_text: str = "") -> str:
    lines = [f"[개미레인저] {telegram.now_text('%H:%M')}"]
    for e in evs:
        lines.append(f"• {KIND.get(e['kind'], '')} | {e['title']}")
        if e.get("detail"):
            lines.append(f"  {e['detail'][:200]}")
        if e.get("link"):
            lines.append(f"  {e['link']}")
    if ai_text:
        lines += ["", "AI 요약 (참고용)", ai_text.strip()]
    return "\n".join(lines)[:3900]


async def emit(evs: list[dict], use_ai: bool = True) -> None:
    """사건 묶음을 남기고, 화면에 알리고, 텔레그램으로 보낸 뒤 AI 요약을 붙인다"""
    from . import realtime

    if not evs:
        return
    for e in evs:
        recent.append(e)
        _append(e)
    realtime._bump()
    evs = [e for e in evs if not e.get("mute")]  # 알림함에만 남길 것은 여기까지
    if not evs:
        return
    s = settings()
    mid = 0
    if s["telegram"] and telegram.configured():
        try:
            mid = await telegram.send(_tg_text(evs), silent=_quiet())
        except RuntimeError as ex:
            telegram.last_error = f"{telegram.now_text()} {ex}"
    if use_ai and _take_ai():
        asyncio.create_task(_summarize(evs, mid))


async def _summarize(evs: list[dict], mid: int) -> None:
    from . import ai

    try:
        text = await ai.brief([f"[{KIND.get(e['kind'], '')}] {e['title']}" + (f" - {e['detail']}" if e.get("detail") else "") for e in evs], await _ctx())
    except Exception as ex:  # noqa: BLE001 - 요약이 실패해도 알림은 이미 갔다
        state["lastError"] = f"{telegram.now_text()} AI 요약 실패: {ex}"
        return
    text = text.strip()
    if not text:
        return
    for e in evs:
        e["ai"] = text
        _append({"id": e["id"], "update": True, "ai": text})
    from . import realtime

    realtime._bump()
    if mid:
        await telegram.edit(mid, _tg_text(evs, text))


async def _ctx() -> str:
    from . import ai, main, rules

    try:
        port = main.get_portfolio("all")
    except HTTPException:
        port = None
    return ai.context(port, [r["text"] for r in rules.view()["rules"] if r["state"] == "watching"])


# ---------- 매분 보기 ----------
def _portfolio() -> dict | None:
    from . import main

    if not config.kis_configured():
        return None
    try:
        return main.get_portfolio("all")
    except HTTPException:
        return None


def _targets(port: dict | None) -> list[dict]:
    """감시 대상: 보유 종목(가격이 자동으로 오는 것만) + 규칙 종목"""
    from . import rules

    out: dict[str, dict] = {}
    for h in (port or {}).get("holdings", []):
        if h.get("asset") not in ("kr", "us", "coin", "gold") or h.get("manualPrice") or h.get("fallback"):
            continue
        q = market.quotes.get(h["code"], {}) if h["asset"] == "kr" else {}
        out[h["code"]] = {"code": h["code"], "name": h.get("name", h["code"]), "asset": h["asset"], "price": h.get("rawPrice") or h["price"], "vol": q.get("vol", 0), "at": q.get("at", time.time()), "held": True}
    for c in rules.codes():
        q = market.quotes.get(c)
        if c not in out and q:
            out[c] = {"code": c, "name": q.get("name", c), "asset": "kr", "price": q["price"], "vol": q.get("vol", 0), "at": q.get("at", 0), "held": False}
    return list(out.values())


def _check_moves(ts: list[dict], s: dict) -> list[dict]:
    evs = []
    now = time.time()
    is_open = market.market_open()
    open_min = (_now().hour * 60 + _now().minute) - 9 * 60
    for t in ts:
        if not t["price"] or now - t["at"] > 180:
            continue  # 오래된 값은 보지 않는다
        if t["asset"] in ("kr", "gold") and not is_open:
            continue
        h = _hist.setdefault(t["code"], deque(maxlen=90))
        h.append((now, float(t["price"]), int(t["vol"] or 0)))
        span = s["moveMin"] * 60
        old = next((x for x in h if now - x[0] <= span + 30), None)
        if old and now - old[0] >= span - 30 and old[1]:
            pct = (t["price"] - old[1]) / old[1] * 100
            if abs(pct) >= s["movePct"] and _cool_ok(f"move:{t['code']}:{pct > 0}"):
                unit = "$" if t["asset"] == "us" else ""
                p = f"{unit}{t['price']:,.2f}" if t["asset"] == "us" else f"{t['price']:,.0f}원"
                evs.append(_new("move", f"{t['name']} {s['moveMin']}분 사이 {pct:+.1f}% ({p})", t["code"], t["name"], "보유 종목" if t["held"] else "규칙 종목"))
        # 거래량 급증 (국내, 장 시작 20분 뒤부터)
        if t["asset"] == "kr" and is_open and open_min >= 20 and t["vol"]:
            v5 = next((x for x in h if now - x[0] <= 330), None)
            if v5 and now - v5[0] >= 240 and v5[2]:
                d5 = t["vol"] - v5[2]
                past_min = max(open_min - (now - v5[0]) / 60, 1)
                avg5 = v5[2] / past_min * 5
                if avg5 > 0 and d5 >= s["volX"] * avg5 and d5 * t["price"] >= MIN_VOL_WON and _cool_ok(f"vol:{t['code']}"):
                    evs.append(_new("volume", f"{t['name']} 거래량 급증: 최근 5분 {d5:,}주 (오늘 5분 평균의 {d5 / avg5:.1f}배)", t["code"], t["name"]))
    return evs


def _check_day(port: dict | None, s: dict) -> list[dict]:
    if not port or not s["dayPct"]:
        return []
    hs = [h for h in port["holdings"] if not h.get("manualPrice")]
    now_v = sum(h["qty"] * h["price"] for h in hs)
    prev_v = sum(h["qty"] * (h.get("prev") or h["price"]) for h in hs)
    total_prev = prev_v + port["cash"]
    if not total_prev:
        return []
    pct = (now_v - prev_v) / total_prev * 100
    today = _now().strftime("%Y-%m-%d")
    if _day["date"] != today:
        _day.update(date=today, level=0)
    level = int(abs(pct) // s["dayPct"]) * (1 if pct > 0 else -1)
    if level and abs(level) > abs(_day["level"]) or (level and (level > 0) != (_day["level"] > 0)):
        _day["level"] = level
        return [_new("day", f"내 자산 오늘 {pct:+.2f}% ({now_v - prev_v:+,.0f}원)", detail=f"총자산 {now_v + port['cash']:,.0f}원")]
    return []


async def _check_news(port: dict | None, s: dict) -> list[dict]:
    if not s["news"] or not config.kis_configured():
        return []
    held = {h["code"]: h.get("name", h["code"]) for h in (port or {}).get("holdings", []) if h.get("asset") == "kr"}
    if not held:
        state["news"] = "보유 국내 종목 없음"
        return []
    p = {"FID_NEWS_OFER_ENTP_CODE": "", "FID_COND_MRKT_CLS_CODE": "", "FID_INPUT_ISCD": "", "FID_TITL_CNTT": "", "FID_INPUT_DATE_1": "", "FID_INPUT_HOUR_1": "", "FID_RANK_SORT_CLS_CODE": "", "FID_INPUT_SRNO": ""}
    rows: list[dict] = []
    try:
        rows += (await kis.get(NEWS, "FHKST01011800", p)).get("output") or []
        # 시장 전체 최신 40건에 더해, 보유 종목을 돌아가며 2개씩 종목별로도 (바쁜 시간에 빠지지 않게)
        codes = sorted(held)
        k = int(time.time() // 60) % max(len(codes), 1)
        for c in (codes[k : k + 2] or codes[:2]):
            rows += (await kis.get(NEWS, "FHKST01011800", {**p, "FID_INPUT_ISCD": c})).get("output") or []
    except KISError as e:
        state["news"] = f"오류 {e}"
        return []
    first = not _seen["news"]
    seen = set(_seen["news"])
    today = _now().strftime("%Y%m%d")
    evs = []
    for r in rows:
        sid = r.get("cntt_usiq_srno") or (r.get("data_dt", "") + r.get("data_tm", "") + r.get("hts_pbnt_titl_cntt", "")[:20])
        if sid in seen:
            continue
        seen.add(sid)
        _seen["news"].append(sid)
        if first or r.get("data_dt") != today:
            continue  # 처음 켤 때는 기존 뉴스를 보내지 않는다
        code = r.get("iscd1", "")
        if code not in held:
            continue  # 그 종목이 주인공(첫 관련 종목)인 뉴스만. 시황 기사에 이름만 걸린 것은 뺀다
        title = (r.get("hts_pbnt_titl_cntt") or "").strip()
        e = _new("news", f"{held[code]}: {title}", code, held[code], f"{r.get('dorg', '')} {r.get('data_tm', '')[:2]}:{r.get('data_tm', '')[2:4]}".strip())
        if not _cool_ok(f"news:{code}"):
            e["mute"] = True  # 큰 종목은 뉴스가 많다: 텔레그램은 종목마다 30분에 한 번, 나머지는 알림함에만
        evs.append(e)
    state["news"] = f"정상 ({telegram.now_text('%H:%M')})"
    return evs[:8]


async def _check_dart(port: dict | None, s: dict) -> list[dict]:
    global _http
    if not s["disclosure"] or not config.DART_API_KEY:
        return []
    held = {h["code"]: h.get("name", h["code"]) for h in (port or {}).get("holdings", []) if h.get("asset") == "kr"}
    if not held:
        return []
    if _http is None:
        _http = httpx.AsyncClient(timeout=15)
    day = _now().strftime("%Y%m%d")
    try:
        r = await _http.get(DART_LIST, params={"crtfc_key": config.DART_API_KEY, "bgn_de": day, "end_de": day, "page_count": 100})
        d = r.json()
    except (httpx.HTTPError, ValueError) as e:
        state["dart"] = f"연결 실패 ({e.__class__.__name__})"
        return []
    if d.get("status") == "013":  # 오늘 공시 없음
        state["dart"] = f"정상 ({telegram.now_text('%H:%M')})"
        return []
    if d.get("status") != "000":
        state["dart"] = f"오류 {d.get('status')}: {d.get('message', '')}"
        return []
    first = not _seen["dart"]
    seen = set(_seen["dart"])
    evs = []
    for x in d.get("list") or []:
        no = x.get("rcept_no", "")
        if not no or no in seen:
            continue
        seen.add(no)
        _seen["dart"].append(no)
        if first or x.get("stock_code") not in held:
            continue
        evs.append(_new("disclosure", f"{held[x['stock_code']]} 공시: {x.get('report_nm', '').strip()}", x["stock_code"], held[x["stock_code"]], x.get("flr_nm", ""), f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={no}"))
    state["dart"] = f"정상 ({telegram.now_text('%H:%M')})"
    return evs


async def tick() -> None:
    s = settings()
    if not s["enabled"]:
        return
    port = _portfolio()
    ts = _targets(port)
    state["watching"] = len(ts)
    evs = _check_moves(ts, s) + _check_day(port, s)
    evs += await _check_news(port, s)
    evs += await _check_dart(port, s)
    _save_seen()
    state["lastRun"] = time.time()
    await emit(evs)


async def run_forever() -> None:
    _load()
    await asyncio.sleep(20)  # 켜자마자 잔고·시세가 들어올 시간
    while True:
        t0 = time.time()
        try:
            await tick()
            state["lastError"] = ""
        except Exception as e:  # noqa: BLE001 - 알림이 죽지 않게
            state["lastError"] = f"{telegram.now_text()} {e.__class__.__name__}: {e}"
        await asyncio.sleep(max(5, 60 - (time.time() - t0)))


# ---------- 규칙이 부른다 ----------
def rule_fired(r: dict, price: float, text: str, mode: str) -> None:
    title = f"규칙 발동 ({mode}): {text}"
    detail = f"발동 가격 {price:,.0f}원" + (" · 5분 안에 사이트 규칙 화면에서 확인해야 주문이 나갑니다" if mode == "확인 후 주문" else "")
    asyncio.get_event_loop().create_task(emit([_new("rule", title, r.get("code", ""), r.get("name", ""), detail)], use_ai=False))


async def test() -> dict:
    e = _new("test", "시험 알림입니다. 알림이 이렇게 옵니다.", detail="설정 화면에서 보낸 시험")
    await emit([e], use_ai=False)
    return {"ok": True, "telegram": telegram.configured() and settings()["telegram"]}


async def close() -> None:
    if _http is not None:
        await _http.aclose()
