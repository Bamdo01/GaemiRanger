"""지수 구성종목 (히트맵 보기용, 2026-11-24). 하루 한 번 받아 data/index_members.json 에 둔다. 실패하면 지난 값.

- 코스피200·코스닥150: 한투가 공개하는 종목 마스터 파일 (코스피200 업종 칸, 코스닥150 여부 칸)
- S&P 500: 위키백과 구성종목 표 (GICS 업종 포함). 공식 자료가 아니라 바뀐 직후 며칠은 틀릴 수 있다
- 나스닥100: 나스닥 공식 사이트의 목록
- 다우30: 위키백과 구성종목 틀의 회사 이름을 S&P 500 표로 티커로 바꾼다
"""

import asyncio
import io
import json
import re
import time
import zipfile
from datetime import date
from urllib.parse import unquote

import httpx

from . import config

FILE = config.DATA / "index_members.json"
UA = {"User-Agent": "GaemiRanger/1.0 (personal portfolio app)"}
MASTER = "https://new.real.download.dws.co.kr/common/master/{}.mst.zip"
WIKI = "https://en.wikipedia.org/w/api.php"
GICS = {
    "Information Technology": "정보기술",
    "Health Care": "헬스케어",
    "Financials": "금융",
    "Consumer Discretionary": "경기소비재",
    "Communication Services": "커뮤니케이션",
    "Industrials": "산업재",
    "Consumer Staples": "필수소비재",
    "Energy": "에너지",
    "Utilities": "유틸리티",
    "Real Estate": "부동산",
    "Materials": "소재",
}

# {"day": "2026-11-24", "kospi200": [{"code","name","shares"}], "kosdaq150": [...], "sp500": [{"code","name","sector"}], "ndx": [...], "dji": [...]}
data: dict = {}
_lock = asyncio.Lock()


def load() -> dict:
    if not data and FILE.exists():
        try:
            data.update(json.loads(FILE.read_text("utf-8")))
        except (OSError, ValueError):
            pass
    return data


def get(key: str) -> list[dict]:
    return load().get(key) or []


# ---------- 국내: 한투 종목 마스터 ----------
async def _master(h: httpx.AsyncClient, name: str) -> list[str]:
    r = await h.get(MASTER.format(name))
    r.raise_for_status()
    z = zipfile.ZipFile(io.BytesIO(r.content))
    return [ln.rstrip("\r") for ln in z.read(z.namelist()[0]).decode("cp949").split("\n") if ln.strip()]


def _industries(lines: list[str]) -> dict[str, str]:
    """한투 업종 코드표 (idxcode): 시장 1자리(0 코스피, 1 코스닥) + 코드 4자리 + 이름"""
    return {ln[:5]: ln[5:].strip() for ln in lines if len(ln) > 5}


def _kr_rows(lines: list[str], tail: int, pick, inds: dict[str, str] | None = None, mk: str = "0") -> list[dict]:
    """한 줄 = 단축코드(9) 표준코드(12) 한글명 + 끝의 고정폭 칸들 (tail 글자). 2026-11-24 확인: 고정폭 칸은 한 글자 앞에서 시작"""
    out = []
    for ln in lines:
        t = ln[-tail - 1 :]
        if len(ln) < tail + 22 or not pick(t):
            continue
        code = ln[:9].strip()
        try:
            cap = int(ln[-15:-6]) / 10000  # 전일 기준 시가총액 (억원 → 조원). 끝에서 15번째부터 9자리
        except ValueError:
            cap = 0
        # 그룹(2) 시총규모(1) 뒤 지수업종 대·중·소 (4자리씩). 중분류가 있으면 중분류, 없으면 대분류
        big, mid = t[4:8], t[8:12]
        sector = (inds or {}).get(mk + mid) if mid.strip("0 ") else None
        sector = sector or (inds or {}).get(mk + big) or "기타"
        out.append({"code": code, "name": ln[21 : -tail - 1].strip(), "cap": cap, "sector": sector})
    return out


async def _korea(h: httpx.AsyncClient) -> dict:
    ks = await _master(h, "kospi_code")
    kq = await _master(h, "kosdaq_code")
    inds = _industries(await _master(h, "idxcode"))
    # 코스피: 지수업종(2+1+4+4+4) 뒤 제조업·저유동성·지배구조 다음이 코스피200 업종 (0 이면 비구성)
    k200 = _kr_rows(ks, 227, lambda t: t[19] not in "0 ", inds, "0")
    # 코스닥: 1글자 여부 칸들 중 코스닥150 (벤처부터 21번째)
    q150 = _kr_rows(kq, 221, lambda t: t[36] == "Y", inds, "1")
    return {"kospi200": k200, "kosdaq150": q150}


# ---------- 미국 ----------
async def _wiki(h: httpx.AsyncClient, page: str, prop: str = "text") -> str:
    r = await h.get(WIKI, params={"action": "parse", "page": page, "prop": prop, "format": "json", "formatversion": "2"})
    r.raise_for_status()
    return r.json()["parse"][prop]


def _cells(row: str) -> list[str]:
    return re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)


def _txt(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).replace("&amp;", "&").strip()


async def _sp500(h: httpx.AsyncClient) -> tuple[list[dict], dict[str, str]]:
    html = await _wiki(h, "List_of_S&P_500_companies")
    m = re.search(r'<table[^>]*id="constituents"[^>]*>(.*?)</table>', html, re.S)
    if not m:
        raise ValueError("S&P 500 표를 찾지 못함")
    out, by_link = [], {}
    for row in m.group(1).split("<tr")[2:]:
        c = _cells(row)
        if len(c) < 4:
            continue
        sym = _txt(c[0]).replace(".", "/")  # 한투는 BRK/B 처럼 쓴다
        link = re.search(r'href="/wiki/([^"#]+)"', c[1])
        out.append({"code": sym, "name": _txt(c[1]), "sector": GICS.get(_txt(c[2]), _txt(c[2]) or "기타")})
        if link:
            by_link.setdefault(unquote(link.group(1)).replace("_", " "), sym)  # %26 → &
    if len(out) < 450:
        raise ValueError(f"S&P 500 이 {len(out)}종목뿐")
    return out, by_link


async def _ndx(h: httpx.AsyncClient) -> list[dict]:
    r = await h.get("https://api.nasdaq.com/api/quote/list-type/nasdaq100", headers={"Accept": "application/json"})
    rows = ((r.json().get("data") or {}).get("data") or {}).get("rows") or []
    if len(rows) < 90:
        raise ValueError(f"나스닥100 이 {len(rows)}종목뿐")
    return [{"code": x["symbol"].replace(".", "/"), "name": x.get("companyName", "").replace(" Common Stock", "").strip()} for x in rows if x.get("symbol")]


async def _dji(h: httpx.AsyncClient, by_link: dict[str, str]) -> list[dict]:
    w = await _wiki(h, "Template:Dow Jones Industrial Average companies", "wikitext")
    out = []
    for target in re.findall(r"\[\[([^\]|]+)", w):
        target = target.strip()
        sym = by_link.get(target)
        if sym and not any(o["code"] == sym for o in out):
            out.append({"code": sym, "name": target})
    if not 28 <= len(out) <= 32:
        raise ValueError(f"다우가 {len(out)}종목")
    return out


async def refresh(force: bool = False) -> None:
    """하루 한 번. 하나가 실패해도 나머지는 새로, 실패한 것은 지난 값"""
    def fresh() -> bool:
        # 오늘 받았고, 실패한 것이 있으면 1시간 뒤 다시
        return data.get("day") == date.today().isoformat() and not (data.get("errors") and time.time() - data.get("at", 0) > 3600)

    load()
    if not force and fresh():
        return
    async with _lock:
        if not force and fresh():
            return
        new = dict(data)
        errs = []
        async with httpx.AsyncClient(timeout=30, headers=UA, follow_redirects=True) as h:
            try:
                new.update(await _korea(h))
            except Exception as e:  # noqa: BLE001
                errs.append(f"국내 {e}")
            try:
                sp, by_link = await _sp500(h)
                new["sp500"] = sp
                try:
                    new["dji"] = await _dji(h, by_link)
                except Exception as e:  # noqa: BLE001
                    errs.append(f"다우 {e}")
            except Exception as e:  # noqa: BLE001
                errs.append(f"S&P {e}")
            try:
                new["ndx"] = await _ndx(h)
            except Exception as e:  # noqa: BLE001
                errs.append(f"나스닥100 {e}")
        new["day"] = date.today().isoformat()
        new["errors"] = errs
        new["at"] = time.time()
        data.clear()
        data.update(new)
        try:
            FILE.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        except OSError:
            pass


def us_sector(sym: str) -> str:
    for s in get("sp500"):
        if s["code"] == sym:
            return s["sector"]
    return ""
