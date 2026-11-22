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

## 4. 텔레그램 로그인 승인 (켜는 걸 추천)

켜면 비밀번호가 맞은 뒤 텔레그램 봇이 [승인][거절] 메시지를 보내고, [승인]을 눌러야 들어가진다 (2분).
누가 비밀번호를 맞혀도 내 텔레그램이 없으면 못 들어온다. 비워 두면 예전처럼 비밀번호만으로 들어간다.

1. 텔레그램에서 `@BotFather` 를 찾아 `/newbot` → 봇 이름과 아이디(끝이 `bot`)를 정하면 토큰을 준다.
2. `.env` 의 `TELEGRAM_BOT_TOKEN=` 뒤에 토큰을 쓴다. 채팅에 붙여 넣지 않는다.
3. 만든 봇을 텔레그램에서 찾아 아무 말이나 한 번 보낸다.
4. 서버를 끄고 `.venv\Scripts\python -m app.telegram_setup` → 내 chat id 를 찾아 `.env` 에 써 넣고 시험 메시지를 보낸다.
5. `.venv\Scripts\python -m app.recovery_codes` → 복구 코드 8개가 한 번만 나온다. 적어 둔다.
   텔레그램을 못 쓸 때 로그인 화면의 "복구 코드로 들어가기"에서 비밀번호 + 코드 하나로 들어간다. 코드는 한 번씩만 쓰인다. 다시 실행하면 예전 코드는 못 쓴다.
6. 서버를 다시 켠다.

- 내 chat id 가 아닌 사람이 봇에 말을 걸거나 버튼을 눌러도 무시한다.
- 비밀번호를 5번 틀려 잠기거나 복구 코드로 들어오면 텔레그램으로 알림이 온다.
- 텔레그램 앱 설정 → 개인정보 및 보안 → **2단계 인증**을 켜 둔다. 텔레그램 계정이 이 사이트의 두 번째 열쇠다.

## 5. 아직 확인 못 한 것

- 실시간 체결이 장중에 실제로 들어오는지 (2026-11-22 일요일에 확인: 한투 모의 웹소켓 연결·등록 41자리, 해외 등록, 업비트 실시간은 됨. 국내·미국 체결 수신과 미국 시세 지연 여부는 장이 열릴 때)

- 모의 주문 (`VTTC0012U` 매수 / `VTTC0011U` 매도): 장중(09:00~15:30)에만 받으므로 아직 한 번도 보내 보지 않았다.
- 진짜 텔레그램 봇과의 연결: 가짜 텔레그램으로만 시험했다 (승인·거절·만료·남의 버튼 무시·복구 코드·잠금 알림).

## 6. 서버에 올리기 (2026-11-23 올림)

- 서버: AWS Lightsail 시드니 (Ubuntu 24.04, 1GB, 고정 IP). 계정 제한으로 시드니만 됨. 한투 모의 API·웹소켓 모두 시드니에서 확인
- 주소: https://15-135-201-31.sslip.io (도메인 없이 IP 로 HTTPS. sslip.io 는 IP 를 그대로 가리키는 무료 주소)
- 구성: Caddy(443, 인증서 자동) → uvicorn 127.0.0.1:8000 (`--proxy-headers`, 밖에서 8000 직접 접속 불가)
- 서비스: `systemctl status gaemiranger` (앱 계정 gaemi, 재부팅해도 자동 시작), Caddy 설정 `/etc/caddy/Caddyfile`
- 앱 위치: `/opt/gaemiranger/app` (GitHub 클론), 비밀 값 `backend/.env` (600, COOKIE_SECURE=true), 기록 `backend/data/` (700)
- 보안: SSH 키로만, ufw 로 22·80·443 만, 보안 업데이트 자동, 로그인 실패 IP당 5번·전체 15분 20번 제한, 12자 미만 비밀번호면 안 켜짐
- 이 PC 서버는 끄고 쓴다 (한투 웹소켓이 두 곳에서 붙지 않게)

고친 코드를 올릴 때 (이 PC 에서):

```
npm --prefix ../frontend run build:server
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-2.pem ubuntu@15.135.201.31 "sudo -u gaemi git -C /opt/gaemiranger/app pull"
tar -czf dist.tgz -C ../frontend dist && scp -i ~/.ssh/LightsailDefaultKey-ap-southeast-2.pem dist.tgz ubuntu@15.135.201.31:/tmp/
ssh -i ~/.ssh/LightsailDefaultKey-ap-southeast-2.pem ubuntu@15.135.201.31 "sudo chmod 644 /tmp/dist.tgz && sudo -u gaemi bash -c 'cd /opt/gaemiranger/app && rm -rf frontend/dist && tar -xzf /tmp/dist.tgz -C frontend' && sudo rm /tmp/dist.tgz && sudo systemctl restart gaemiranger"
```
