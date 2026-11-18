"""로그인 비밀번호 해시 만들기: .venv\\Scripts\\python -m app.hashpw
나온 한 줄을 backend/.env 의 APP_PASSWORD_HASH= 뒤에 붙여 넣는다. 비밀번호 자체는 어디에도 저장하지 않는다."""

import getpass
import secrets

from .auth import hash_password

if __name__ == "__main__":
    pw = getpass.getpass("로그인 비밀번호 (12자 이상): ")
    if len(pw) < 12:
        raise SystemExit("12자 이상으로 정해 주세요.")
    if pw != getpass.getpass("한 번 더: "):
        raise SystemExit("두 번 입력한 값이 다릅니다.")
    print("\n.env 에 아래 두 줄을 넣으세요 (SESSION_SECRET 이 이미 있으면 그대로 두세요):\n")
    print(f"APP_PASSWORD_HASH={hash_password(pw)}")
    print(f"SESSION_SECRET={secrets.token_hex(32)}")
