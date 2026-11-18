r"""복구 코드 만들기. 실행: .venv\Scripts\python -m app.recovery_codes

텔레그램을 못 쓸 때(휴대폰 분실, 텔레그램 장애) 비밀번호 + 복구 코드 하나로 들어간다.
코드마다 한 번만 쓸 수 있다. 다시 실행하면 예전 코드는 모두 못 쓰게 된다.
코드는 이 화면에만 한 번 나온다. 서버에는 해시만 남는다.
"""

from .auth import make_recovery_codes

if __name__ == "__main__":
    codes = make_recovery_codes()
    print("복구 코드 (한 번씩만 쓸 수 있음). 종이에 적거나 비밀번호 관리자에 넣어 두세요.")
    print("이 창을 닫으면 다시 볼 수 없습니다. 예전 복구 코드는 이제 못 씁니다.\n")
    for i, c in enumerate(codes, 1):
        print(f"  {i}. {c}")
