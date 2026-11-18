"""한투 Open API 클라이언트 (모의투자).

- 토큰은 하루 유효, 발급할 때마다 알림톡이 오고 1분에 1번만 발급된다 → 파일에 캐시해서 재사용.
- 모든 호출은 초당 KIS_RPS 를 넘지 않게 한 줄로 세운다.
- 경로·TR ID 는 공식 저장소 koreainvestment/open-trading-api 기준 (PLAN.md 부록).
"""

import asyncio
import json
import time
from datetime import datetime

import httpx

from . import config

TOKEN_FILE = config.DATA / "kis_token.json"


class KISError(Exception):
    def __init__(self, msg: str, code: str = ""):
        super().__init__(msg)
        self.code = code


class KIS:
    def __init__(self) -> None:
        self.http = httpx.AsyncClient(base_url=config.KIS_BASE, timeout=10)
        self._token: str = ""
        self._token_exp: float = 0
        self._token_lock = asyncio.Lock()
        self._rate_lock = asyncio.Lock()
        self._last_call = 0.0
        self.last_ok: float = 0
        self.last_error: str = ""
        self._load_token()

    # ---------- 토큰 ----------
    def _load_token(self) -> None:
        try:
            d = json.loads(TOKEN_FILE.read_text("utf-8"))
            if d.get("app") == config.KIS_APP_KEY[-6:]:
                self._token, self._token_exp = d["token"], float(d["exp"])
        except (OSError, ValueError, KeyError):
            pass

    async def token(self) -> str:
        async with self._token_lock:
            if self._token and self._token_exp - time.time() > 600:
                return self._token
            r = await self.http.post(
                "/oauth2/tokenP",
                json={"grant_type": "client_credentials", "appkey": config.KIS_APP_KEY, "appsecret": config.KIS_APP_SECRET},
            )
            d = r.json() if r.content else {}
            if r.status_code != 200 or "access_token" not in d:
                raise KISError(f"토큰 발급 실패: {d.get('error_description') or d.get('msg1') or r.status_code}", d.get("error_code", ""))
            self._token = d["access_token"]
            self._token_exp = time.time() + int(d.get("expires_in", 86400))
            # 토큰은 data/ 에만 둔다 (git 제외). 앱키 끝 6자리로 다른 키의 토큰과 구분
            TOKEN_FILE.write_text(json.dumps({"token": self._token, "exp": self._token_exp, "app": config.KIS_APP_KEY[-6:]}), "utf-8")
            return self._token

    # ---------- 호출 ----------
    async def _wait_rate(self) -> None:
        async with self._rate_lock:
            gap = 1 / config.KIS_RPS - (time.monotonic() - self._last_call)
            if gap > 0:
                await asyncio.sleep(gap)
            self._last_call = time.monotonic()

    async def call(self, method: str, path: str, tr_id: str, params: dict | None = None, body: dict | None = None, tr_cont: str = "") -> dict:
        if not config.kis_configured():
            raise KISError("한투 키가 설정되지 않았습니다", "NOT_CONFIGURED")
        refreshed = False
        for attempt in range(4):
            tok = await self.token()
            await self._wait_rate()
            headers = {
                "content-type": "application/json; charset=utf-8",
                "authorization": f"Bearer {tok}",
                "appkey": config.KIS_APP_KEY,
                "appsecret": config.KIS_APP_SECRET,
                "tr_id": tr_id,
                "custtype": "P",
            }
            if tr_cont:
                headers["tr_cont"] = tr_cont
            try:
                r = await self.http.request(method, path, params=params, json=body, headers=headers)
            except httpx.HTTPError as e:
                self.last_error = f"{datetime.now():%H:%M:%S} 연결 실패: {e.__class__.__name__}"
                raise KISError("한투 서버에 연결하지 못했습니다") from e
            d = r.json() if r.content else {}
            # 토큰 만료면 한 번만 다시 발급받아 재시도
            if d.get("msg_cd") == "EGW00123" and not refreshed:
                refreshed = True
                self._token_exp = 0
                continue
            # 초당 거래건수 초과: 조회만 잠깐 쉬고 다시 (주문은 다시 보내지 않는다)
            if d.get("msg_cd") == "EGW00201" and method == "GET" and attempt < 3:
                async with self._rate_lock:
                    await asyncio.sleep(1.0)
                    self._last_call = time.monotonic()
                continue
            if r.status_code != 200 or d.get("rt_cd") != "0":
                msg = d.get("msg1") or f"HTTP {r.status_code}"
                self.last_error = f"{datetime.now():%H:%M:%S} {tr_id} {msg}"
                raise KISError(msg.strip(), d.get("msg_cd", ""))
            self.last_ok = time.time()
            d["_tr_cont"] = r.headers.get("tr_cont", "")
            return d
        raise KISError("여러 번 다시 해 봤지만 실패했습니다 (호출 한도 또는 토큰)", "RETRY")

    async def get(self, path: str, tr_id: str, params: dict, tr_cont: str = "") -> dict:
        return await self.call("GET", path, tr_id, params=params, tr_cont=tr_cont)

    async def post(self, path: str, tr_id: str, body: dict) -> dict:
        return await self.call("POST", path, tr_id, body=body)

    async def close(self) -> None:
        await self.http.aclose()


kis = KIS()
