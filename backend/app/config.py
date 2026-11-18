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

# 로그인 비밀번호: .env 에 APP_PASSWORD 를 그냥 쓰면 된다. 서버가 켜질 때 해시로 바꿔 메모리에만 둔다.
# (APP_PASSWORD_HASH 를 쓰면 그쪽이 먼저)
APP_PASSWORD_HASH = os.getenv("APP_PASSWORD_HASH", "").strip()
_plain = os.getenv("APP_PASSWORD", "").strip()
if not APP_PASSWORD_HASH and _plain:
    if len(_plain) < 8:
        raise SystemExit(".env 의 APP_PASSWORD 는 8자 이상으로 정해 주세요.")
    import hashlib as _h, secrets as _s

    _salt = _s.token_bytes(16)
    APP_PASSWORD_HASH = f"scrypt$16384$8$1${_salt.hex()}${_h.scrypt(_plain.encode(), salt=_salt, n=2**14, r=8, p=1, dklen=32).hex()}"
del _plain

# 쿠키 서명 값: 안 쓰면 data/session_secret 에 한 번 만들어 두고 계속 쓴다
SESSION_SECRET = os.getenv("SESSION_SECRET", "").strip()
if len(SESSION_SECRET) < 32:
    _f = DATA / "session_secret"
    if not _f.exists():
        import secrets as _s2

        _f.write_text(_s2.token_hex(32), "utf-8")
    SESSION_SECRET = _f.read_text("utf-8").strip()
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
SESSION_HOURS = 12

ORDER_LIMIT_WON = int(os.getenv("ORDER_LIMIT_WON", "3000000"))


def kis_configured() -> bool:
    return bool(KIS_APP_KEY and KIS_APP_SECRET and len(KIS_CANO) == 8 and len(KIS_ACNT_PRDT_CD) == 2)


def login_configured() -> bool:
    return bool(APP_PASSWORD_HASH and len(SESSION_SECRET) >= 32)
