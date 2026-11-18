# GaemiRanger 서버 (FastAPI)

한투 Open API(모의투자)에 붙는 서버. 화면은 이 서버의 `/api` 만 부르고, 한투 키는 서버의 `.env` 에만 있다.

- 키가 없으면 화면은 예시 데이터로 돈다 (GitHub Pages 도 그렇게 돈다).
- 모든 `/api` 는 로그인해야 쓸 수 있다.
- 주문은 모의투자만 된다 (`KIS_MODE=mock` 이 아니면 서버가 켜지지 않는다). 주문 전에 서버가 다시 검사한다: 장중인지, 호가 단위, 상·하한가, 1회 한도, 주문가능금액, 매도가능수량, 하루 횟수. 모든 주문 시도는 `data/orders.jsonl` 에 남는다.

## 1. 한투 모의투자 키 받기

메뉴 이름은 바뀔 수 있다. 아래는 순서만 적었다 (2026-11 기준, 화면은 직접 확인).

1. 한국투자증권 계좌를 만든다 (한국투자 앱에서 비대면 개설).
2. 한국투자증권 홈페이지나 앱에서 **모의투자 참가 신청**을 한다 → 모의투자 계좌번호(8자리-2자리)가 나온다.
3. **KIS Developers** (apiportal.koreainvestment.com) 에 로그인해서 **API 서비스 신청**을 한다. 계좌는 모의투자 계좌를 고른다.
4. 신청이 끝나면 **App Key** 와 **App Secret** 이 나온다. 이 둘은 비밀번호처럼 다룬다 (채팅·메일·코드에 붙여 넣지 않는다).

## 2. 이 PC 에서 켜기 (Windows)

처음 한 번:

```bash
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
notepad .env
```

`backend\.env` 를 메모장으로 열어 `=` 뒤에 네 가지를 쓰고 저장한다: 앱키, 시크릿, 모의투자 계좌번호, 이 사이트 로그인 비밀번호(`APP_PASSWORD`, 8자 이상). 서버가 켜질 때 비밀번호를 해시로 바꿔 메모리에만 둔다.

켜기:

```bash
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

화면 보기 (둘 중 하나):

- 개발용: 다른 창에서 `npm --prefix ../frontend run dev` → http://localhost:5173/GaemiRanger/ (`/api` 는 8000 으로 넘어간다)
- 서버가 같이 내보내기: `npm --prefix ../frontend run build:server` 한 뒤 http://127.0.0.1:8000/

## 3. 확인

- 메뉴 줄 오른쪽 표시가 **모의투자 · 한투 연결** 이면 진짜 모의 데이터다. **모의 · 예시** 면 키가 없거나 로그인 전이다.
- 표시에 마우스를 올리면 마지막 한투 오류가 보인다.
- 토큰은 하루에 한 번 받는다 (받을 때 알림톡이 온다). `data/kis_token.json` 에 저장해 다시 쓴다.

## 4. 아직 확인 못 한 것

키가 없어서 한투 쪽은 실제로 불러 보지 못했다. 키를 넣은 뒤 첫 실행 때 확인할 것:

- 모의투자에서 지수(업종 현재지수), 호가, 일봉 조회가 되는지
- 잔고·주문가능금액 응답의 항목 이름 (`prvs_rcdl_excc_amt`, `ord_psbl_cash` 등)
- 주문 TR ID `VTTC0012U`(매수) / `VTTC0011U`(매도) 가 받아지는지
- 모의투자 초당 호출 한도 (`KIS_RPS`, 기본 2)

## 5. 서버에 올리기 (다음 단계)

클라우드 서버(서울)에 올리고 도메인 + HTTPS + 로그인으로 연다. 그때 `.env` 의 `COOKIE_SECURE=true`.
