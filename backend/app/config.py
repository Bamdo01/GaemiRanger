"""설정. 모든 비밀 값은 backend/.env 에서만 읽는다 (git 에 올리지 않음)."""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
# GR_ENV_FILE 로 다른 설정 파일을 줄 수 있다 (시험용). 기본은 backend/.env
load_dotenv(os.getenv("GR_ENV_FILE") or BASE / ".env")

DATA = BASE / "data"  # 토큰 캐시, 주문 기록. .gitignore 에 들어 있다
DATA.mkdir(exist_ok=True)

KIS_MODE = os.getenv("KIS_MODE", "mock").strip()
if KIS_MODE != "mock":
    # 실전은 계획서 10단계(실전 전환)에서 점검표를 거친 뒤에 연다
    raise SystemExit("KIS_MODE 는 지금 mock 만 됩니다. 실전 전환은 아직 열지 않았습니다.")

KIS_BASE = "https://openapivts.koreainvestment.com:29443"
KIS_APP_KEY = os.getenv("KIS_APP_KEY", "").strip()
KIS_APP_SECRET = os.getenv("KIS_APP_SECRET", "").strip()
_acct = os.getenv("KIS_ACCOUNT", "").strip().replace(" ", "")
KIS_CANO, _, KIS_ACNT_PRDT_CD = _acct.partition("-")
KIS_RPS = max(0.5, float(os.getenv("KIS_RPS", "2")))

APP_PASSWORD_HASH = os.getenv("APP_PASSWORD_HASH", "").strip()
SESSION_SECRET = os.getenv("SESSION_SECRET", "").strip()
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
SESSION_HOURS = 12

ORDER_LIMIT_WON = int(os.getenv("ORDER_LIMIT_WON", "3000000"))


def kis_configured() -> bool:
    return bool(KIS_APP_KEY and KIS_APP_SECRET and len(KIS_CANO) == 8 and len(KIS_ACNT_PRDT_CD) == 2)


def login_configured() -> bool:
    return bool(APP_PASSWORD_HASH and len(SESSION_SECRET) >= 32)
