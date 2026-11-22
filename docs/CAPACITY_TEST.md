# 연결·부하 검증 범위

2026-11-22 (Asia/Seoul). 현재 목표는 **최대 동시접속 40,000명**이다. 이 문서는 그 목표를 달성했다는 인증서가 아니다. 별도 유료 인프라를 사용하지 않는 이번 작업에서는 작은 격리 환경의 프로토콜 부하와 복구를 검증하며, 실제 관측한 수치만 보고한다.

## 무엇이 서로 다른 검증인가

| 검증 | 의미 | 이 도구의 범위 |
| --- | --- | --- |
| 소켓 수 | 동시에 열린 연결의 수 | 실제 합성 사용자 연결의 peak와 목표 동시 연결 유지 시간을 별도로 측정 |
| 게임 처리 | 역할·단계에 맞는 쓰기를 처리하고 다시 조회 | 준비/시작, 밤 능력, 낮 진술/채팅, 투표/판결의 서버 state 확인 |
| 재접속 | 같은 방의 같은 좌석으로 돌아옴 | 방마다 한 명을 연결 종료 후 정상 `join_only`로 재접속, ID와 `resumed` 확인 |
| 서버 장애 복구 | 프로세스가 사라져도 경기 복원 | 이 도구는 서버를 죽이지 않는다. 별도 DB/다중 프로세스 통합 검증이 필요 |
| 음성 미디어 | 실제 오디오 패킷이 전달됨 | 미검증. JSON 신호나 핑 응답을 통화 성공으로 간주하지 않음 |
| 운영 수용량 | 실제 proxy/gate/API/DB/네트워크에서 지속되는 성능 | loopback 결과로 검증할 수 없음 |

도구의 `passed: true`는 **출력된 작은 테스트 범위와 조건의 통과**다. 출력에는 언제나 `target_40000_validated: false`가 남는다. 로컬 수치에 서버 수를 곱해 40,000명을 검증했다고 보고하지 않는다.

## 실행 전 안전 조건

`backend/tools/ws_load.py`는 다음 제한을 기본으로 강제한다.

- `ws://127.0.0.1:<port>/api/ws` 또는 `ws://[::1]:<port>/api/ws`만 허용한다. 운영 URL, DNS 이름, URL 자격 증명·query·fragment를 거부한다. 시스템 proxy도 사용하지 않는다.
- 사용자 수는 증가하는 stage별 1~500명으로 제한한다. 기본은 `10,25`이고 초당 입장은 2명이다. 큰 수를 주어도 public deployment나 40,000명 실행 도구로 바뀌지 않는다.
- 시작 전과 실행 중 사용 가능한 RAM이 최소 1GiB인지 확인한다. 이 기준을 낮출 수 없다. 측정 불가능한 환경은 진행하지 않는다. Windows/Linux를 지원하고 Linux cgroup v2의 제한도 확인한다.
- 발생기 event loop가 한 번에 2초 넘게 밀리면 중단한다. 실패한 stage 뒤에 더 큰 stage를 실행하지 않는다.
- 연결·응답 대기와 정리를 시간 제한한다. 프레임 본문, 재접속 키, 전체 WebSocket query, backend 오류 원문을 출력하지 않는다.
- OS 포트 범위·파일 제한·커널 설정·배포 quota를 변경하거나 서버를 구매하지 않는다.

읽기 전용 조사 시점의 작업 PC는 논리 CPU 16개, RAM 15.57GiB, 사용 가능 RAM 약 1.60GiB였다. 이는 서버 성능 측정이 아니다. DB·브라우저 등을 추가 실행하면 여유가 줄 수 있으므로, guard가 중단하면 기준을 낮추지 말고 작업 환경의 메모리를 확보해야 한다.

## 재현 명령

전제: 격리된 로컬 API와 폐기 가능한 DB를 별도로 실행한 뒤, 그 API의 포트를 확인한다. 부하 도구는 서버·DB를 자동 기동하거나 migration하지 않는다. 운영 데이터베이스를 사용하는 서버에는 실행하지 않는다.

저장소 `backend` 디렉터리에서 실행한다. `websockets`는 기존 `uvicorn[standard]` 의존성에 포함되어 있다.

```powershell
# 먼저 작은 10초 smoke. 이 길이로 낮/투표/판결을 검증했다고 말하지 않는다.
uv run python -m tools.ws_load --url ws://127.0.0.1:8000/api/ws --stages 10 --duration 10 --json-output ..\..\..\outputs\local-smoke-unique.json

# 메모리 여유와 첫 결과를 확인한 뒤 정상 시계로 각 stage를 420초 관찰한다.
uv run python -m tools.ws_load --url ws://127.0.0.1:8000/api/ws --stages 10,25 --room-size 4 --duration 420 --json-output ..\..\..\outputs\local-active-unique.json

# 발생기 자체의 제한/ACK 계수 테스트. 네트워크를 열지 않는 frame queue 테스트다.
uv run --extra dev python -m pytest tests/test_load_harness.py -q
uv run --extra dev python -m ruff check tools/ws_load.py tests/test_load_harness.py
```

출력 파일의 부모 폴더는 미리 존재해야 하며, 파일이 이미 있으면 덮어쓰지 않는다. stage가 실패하거나 자원 안전 검사가 중단되면 exit1, 지정한 작은 범위가 통과하면 exit0이다. Ctrl+C는 정리 후 exit130이다.

## 실제 workload와 관측 방법

1. 합성 사용자를 방마다 4명 또는 6명씩 분배한다. 마지막 방의 사람이 부족하면 정상 `fill_bots` 명령으로만 남은 좌석을 채운다. `requested_users`와 peak는 **사람 역할의 실제 WebSocket만** 세고, 봇 좌석은 `counts.bot_seats`로 별도 보고한다.
2. 실제 준비·방장 시작 명령을 보내고 새 state로 확인한다. 전용 첫 사건 fixture나 단축 시계, 엔진 직접 호출로 진행을 건너뛰지 않는다.
3. 공개된 각자의 역할과 서버 단계에 따라 밤 행동, 발언 순서의 공식 진술, 15초 간격 낮 채팅, 투표와 판결을 전송한다. 사망자/피고인/마피아 동료 등의 서버 규칙을 존중한다.
4. 명령 이전의 오래된 state가 이미 비슷한 값을 갖고 있어도 ACK로 세지 않는다. **명령 이후 도착한 새 state에서 해당 값이 확인돼야** 접수 지연을 계수한다. 실패 시 무조건 재전송해 성공률을 꾸미지 않는다.
5. JSON ping/pong으로 실제 게임 라우트의 RTT를 확인한다. 각 방의 한 좌석을 활성 경기 도중 계획적으로 끊고 같은 ID 복귀를 확인한다. 이 계획된 공백 때문에 peak 수와 연속 유지 시간은 다르며 `minimum_connected_during_hold`, `seconds_at_requested_concurrency`를 함께 읽어야 한다.
6. 관측 중 게임이 끝나면 정상 rematch·준비·시작을 사용한다. 실행 시간이 짧거나 무작위 결말로 특정 단계를 보지 못했다면 `phase_frame_counts`와 `acknowledgements`에 없는 항목은 미검증이다. 프레임 수는 고유 라운드 수나 사용자 수가 아니다.

## JSON 결과와 통과 기준

각 stage는 요청/성공/재접속 수, peak, 관측 시간, 단계별 프레임·명령 ACK, 오류 유형, 수신 바이트, 최소 가용 RAM, 발생기 CPU 시간을 출력한다. 서버 CPU/RSS/DB 대기/네트워크 상태를 이 값으로 대신하지 않는다.

이 도구는 loopback의 암호화하지 않은 WebSocket을 사용하고 메시지 압축을 끈다. 브라우저의 TLS·압축 협상·렌더링 비용과 다르므로 수신 바이트나 지연을 그대로 운영 비용/성능으로 환산하지 않는다.

가입→첫 state, 명령→확인 state, ping RTT, 좌석 복귀, 발생기 event-loop lag에 대해 p50/p95/p99를 출력한다. 표본은 최대 최신10,000개만 보존하며 총 계수와 실제 보존 수를 함께 표시한다. 큰 실행의 전체 분포인 것처럼 보고하지 않는다. 표본이 없으면 지연0이 아니라 `null`이다.

네트워크/ACK 지연은 `perf_counter`로 측정하고 시계의 해상도를 결과에 기록한다. Windows Python3.11의 `monotonic`은 이 PC에서15.625ms 해상도이므로 그 시계를 사용한 초기 smoke의0ms/16ms 값은 정밀한 성능 근거로 사용하지 않는다. 주기·대기용 monotonic과 미세 지연 측정을 구분한다.

`seat_resume`는 발생기의 입장 속도 제한 대기 이후 handshake→복원 state 시간이다. `planned_disconnect_to_restored_state`는 의도된250ms 단절과 발생기 대기까지 포함한다. 실제 브라우저의 장애 감지·backoff까지 포함한 전체 복구 시간으로 전용하지 않는다. 자원 guard로 중단되면 실패를 일으킨 메모리 표본도 최소값에 포함한다.

이번 소규모 로컬 회귀의 선택한 기준은 다음과 같다. 특정 논문이나 업계 보편 기준이 아니며 40,000명 운영 SLO를 대신하지 않는다.

| 항목 | 로컬 통과 기준 |
| --- | --- |
| 연결·시작 | 요청한 모든 합성 사용자와 모든 방의 시작 확인 |
| 관측·오류 | 요청한 관측 시간 완료, 기록된 오류0 |
| 재접속 | 각 방에서 같은 좌석으로 복귀 확인 |
| 가입 지연 | p95 ≤ 2,000ms |
| 명령 ACK / ping | 각 p95 ≤ 1,000ms |
| 좌석 복귀 | p95 ≤ 3,000ms |
| 발생기 lag | p99 ≤ 250ms |

발생기 자체가 CPU/메모리/포트에 막힌 결과는 서버의 처리 한계로 단정하지 않는다. 반대로 연결만 많이 열리고 실제 게임 명령이 처리되지 않은 결과를 서비스 수용량으로 보고하지 않는다.

## 40,000명 검증에 남는 조건

- 현행 기본 상한12,000을40,000으로 올리는 것과 실제 수용은 다르다. 여러 API 복제본이 같은 방을 나누어 처리하지 않도록 소유권·라우팅·영속 상태와 장애 복원을 먼저 검증해야 한다.
- 별도 발생기와 운영과 동급인 승인된 격리 환경에서 단계적으로 증가시키고, 실제40,000명의 연결 유지·능력/채팅/투표·재접속 폭주·API 재시작을 관찰해야 한다. 방당 인원, 활성/유휴 비율, 메시지율, 음성 참여율은 측정 또는 명시한 테스트 가정이어야 한다.
- Windows PC의 실제 TCP 동적 포트 범위는49,152~65,535(16,384개)였다. 하나의 출발지 IP와 동일 목적지 조합으로40,000개 연결을 발생시키면 포트 제약이 먼저 문제가 될 수 있다. 이 도구는 OS 범위를 바꾸거나 다중 IP로 우회하지 않는다.
- 현재 Coders 공개 manifest에는 `scale`·`resources`·복제 수 지정이 없고 UDP/TURN 노출도 명시되어 있지 않다. free tier의 존재는40,000명 용량 약정이 아니다. 운영 quota/egress와 플랫폼 지원 범위의 확인이 필요하다.
- API에 직접 연결하는 loopback 검사는 nginx·gate·Cloudflare를 거치지 않는다. 저장소는 nginx의 worker 연결/파일 제한을 설정하지 않으며 실제 이미지·플랫폼의 값은 미측정이다. nginx의 연결 한도에는 클라이언트뿐 아니라 upstream 연결도 포함되므로 앱의 상한 숫자로 proxy 수용량을 보장할 수 없다.
- 음성은 별도 미디어 검증이다. 방당12명의 완전 mesh는66개의 peer pair를 만들며,40,000명 모두가12명 방에서 음성을 사용한다면 대략22만 pair 규모다. 이는 배치에 따른 산술 예시이지 처리량 측정이 아니다. TURN/SFU, 제한된 네트워크, 실제 오디오의 복구와 권한을 따로 검증해야 한다.

## 2026-11-22 실제 로컬 실행 기록

Windows/Python3.11.5, 논리CPU16, 별도의 `mafia_load` PostgreSQL과 정상 시계의 durable API `127.0.0.1:8011`에서 실행했다. 운영 사이트·플랫폼 gate에는 부하를 보내지 않았다. 원본 JSON은 저장소 밖 작업 증거이며 배포 이미지에 포함하지 않는다.

| 실행 | 실제 결과 | 명령 ACK p95 / p99 | ping p95 / p99 |
| --- | --- | --- | --- |
| 10명·10초, 고해상도 재검사 | peak10,3개 방,3/3 동일 좌석 복귀, 오류0, smoke 통과 | 21.913 /21.913ms (11개 ACK) | 2.089 /2.462ms |
| 25명·420초 요청 | peak25,7개 방,7/7 복귀. 관측24.906초 뒤 메모리 안전 중단으로 **실패/미완료** | 28.339 /29.983ms (45개 ACK) | 6.046 /20.127ms |

25명 실행은 밤 행동19개를 포함한45개 명령을 확인했지만 낮·투표·판결은 관측하지 못했다. 420초 완료나25명 지속 수용량을 검증했다고 하지 않는다. 발생기 lag p99는16ms였고, 게임/연결 오류 대신 `insufficient_free_memory` 한 건으로 종료했다. 계획적 재접속을 포함해 실제25명 모두가 동시에 연결된 시간은21.625초였다. 단순 peak25와 구분한다.

100명으로 늘릴 조건은 가용 RAM2GiB 이상이었다. 실제 실행 전에는1.71~1.80GiB여서25명으로 낮췄고, 이후 가용 RAM이1GiB 미만으로 내려가 더 실행하지 않았다. API 프로세스의 읽기 전용 표본은25명 실행 전 private bytes63.50MiB /누적 CPU4.625초, 실행 후66.45MiB /8.203125초였다. 이 표본만으로 호스트 전체 메모리 감소의 원인이나 장기 누수 여부를 판정할 수 없다.

보존한 작업 증거:

- `outputs/mafia-durable-load-smoke-10-20261122-qa1.json`: 초기 coarse-clock 검사. 연결/복귀 계수만 참고하며0/16ms 지연은 성능 근거에서 제외한다.
- `outputs/mafia-durable-load-smoke-10-20261122-qa2-perf.json`: 고해상도 smoke 재검사.
- `outputs/mafia-durable-load-active-25-20261122-qa1.json`: 안전 중단된25명 검사. 이 당시 최소 메모리 기록은 guard 통과 뒤에 이루어져 실패 표본을 빠뜨렸다. 원본을 고치지 않고 보존했으며 도구는 이후 실패 표본과 `stopped_reason`도 기록하도록 수정했다.

위 경로는 작업 디렉터리의 `g/outputs`이며 저장소 내부 경로가 아니다. 작은 표본의 p99는 최대값과 같을 수 있다. 이 결과는 플랫폼 인증·패스포트 HTTP 조회/집계 부하, 브라우저 렌더링, TLS·proxy, 음성 미디어, 다중 API 복제와40,000명 수용량을 포함하지 않는다.

### 별도 격리 CI 검사 — 실행 대기

`.github/workflows/load-check.yml`에 수동25/50/100명 선택, 정상 시계420초 관측, fresh PostgreSQL과 durable API를 사용하는 격리 검사를 준비했다. 실행기는 `ubuntu-latest`, 작업 상한은15분이며 운영 URL에 요청하지 않는다. JSON은 job log에 남기고 별도 artifact storage를 업로드하지 않는다. **이 문서 작성 시에는 실행 대기이며 성공이나100명 통과로 표시하지 않는다.** 실제 실행의 commit/run ID·완료 상태·JSON을 확인한 뒤 별도 결과를 기록해야 한다.

마지막 API 프로세스의 RSS/누적 CPU 표본과 `VmHWM`을 읽을 수 있지만, 이는 지속적인 시스템·DB·네트워크 관측을 대신하지 않는다. CI에서100명이 통과하더라도 실제 Coders의 proxy·quota·다중 복제·음성 경로 또는40,000명을 검증한 결과가 아니다.

## 이번에 읽은 공식 원문과 적용

- [Coders 실행 계약](https://github.com/coders-kr/template-coders/blob/main/PLATFORM.md) §5·§9와 [배포 안내](https://coders.kr/llms.txt): 2026-11-22 직접 열람. WebSocket 단절·재접속, strict manifest와 metered pool의 조건을 사용했다. 미문서화된 자원 보장을 추가하지 않았다.
- [Grafana k6 대규모 테스트](https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/): 발생기 CPU·RAM·네트워크/OS 제약을 서버 지표와 구분한다. 문서의 VU 수나 예시 RPS를 이번 서비스 수용량으로 전용하지 않았다. 이번 작은 도구는 기존 Python/WebSocket 스택을 사용하며 k6를 설치하거나 cloud 실행하지 않는다.
- [k6 thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/): 검사 조건과 실패 exit를 명시하는 원칙을 적용했다. 문서 예시의 지연 수치를 이 제품의 보편 기준으로 복사하지 않았다.
- [Microsoft 동적 포트 범위](https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/default-dynamic-port-range-tcpip-chang): 문서와 실제 `netsh int ipv4 show dynamicport tcp` 읽기 결과를 구분했다. 시스템 설정은 변경하지 않았다.
- [websockets asyncio client](https://websockets.readthedocs.io/en/stable/reference/asyncio/client.html), [Python asyncio 동기화](https://docs.python.org/3/library/asyncio-sync.html): bounded queue, timeout, proxy 비활성화와 단일 reader/조건 변수를 적용했다. 자체 frame queue 단위 검사는 실제 네트워크·DB·운영 검증과 별도다.
- [nginx worker_connections](https://nginx.org/en/docs/ngx_core_module.html#worker_connections): proxy upstream을 포함한 연결 한도와 OS open-file 제약을 별도 경계로 남겼다. 공식 기본값을 실제 운영 이미지의 측정값으로 보고하지 않았다.
