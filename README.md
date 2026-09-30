# LLM-Driven PCG Server

플레이어-NPC 대화를 언리얼 엔진 PCG용 Zone JSON으로 검증/보정해서 넘겨주는 Node.js 중간 서버입니다.
세션 관리(Redis)와 파라미터 보정(validator)을 담당하며, 언리얼 클라이언트 및 LLM 모듈과 연동됩니다.

## 요구사항

- Node.js 18+
- Redis (로컬 실행 또는 접속 가능한 인스턴스) — `/api/chat/send` 사용 시 필요
- `.env` 파일 (아래 참고)

## 설치 및 실행

```bash
npm install
cp .env.example .env   # 없다면 새로 생성
npm run dev             # nodemon으로 실행 (개발용)
# 또는
npm start                # 일반 실행
```

`.env` 예시:

```
PORT=8000
REDIS_URL=redis://127.0.0.1:6379
```

> ⚠️ 언리얼 클라이언트 기본 설정(`BackendUrl = http://127.0.0.1:8000/generate-zone`)에 맞추려면
> **PORT는 8000으로 고정하는 걸 권장**합니다. 그래야 언리얼 쪽 값을 따로 안 건드려도 됩니다.

서버가 뜨면 헬스체크로 확인:

```bash
curl http://127.0.0.1:8000/health
# {"status":"running"}
```

> ℹ️ Redis가 안 떠 있으면 콘솔에 `Redis Client Error ... ECONNREFUSED` 로그가 반복해서 찍히는데,
> `/generate-zone`(언리얼 연동용)이나 `/health`만 테스트할 거라면 무시해도 됩니다 — Redis는
> `/api/chat/send`, `/api/world/generate`처럼 대화 세션을 다루는 내부용 엔드포인트에만 필요합니다.

## 언리얼 클라이언트 연결 방법

### 1. 계약(Contract) 요약

언리얼(`APCGZoneController::RequestZoneDataFromBackend`)은 아래 형태로 **한 번의 POST 요청**을 보내고,
응답 body를 **그대로** Zone JSON으로 파싱합니다. 응답을 다른 필드로 감싸면 안 됩니다.

**요청**

```
POST /generate-zone
Content-Type: application/json

{
  "dialogue": [
    { "speaker": "npc", "text": "다음 구역엔 어떤 곳이 있을 것 같아?" },
    { "speaker": "player", "text": "어둡고 나무가 빽빽한 숲, 중간에 전투 구역도 있으면 좋겠어" }
  ]
}
```

- `userId`는 오지 않습니다. 서버에서 없으면 고정 테스트 ID로 대체하거나 무시하세요.

**응답 (200)** — Zone JSON이 최상위 구조 그대로 내려가야 합니다.

```json
{
  "theme": "forest",
  "base_environment": { "tree_density": 0.4, "rock_density": 0.3, "grass_density": 0.7 },
  "main_path": {
    "path_type": "main",
    "path_width": 500,
    "normalized_points": [
      { "x": 0.05, "y": 0.6 },
      { "x": 0.5, "y": 0.45 },
      { "x": 0.95, "y": 0.5 }
    ]
  },
  "areas": [
    { "area_type": "spawn",  "normalized_center": { "x": 0.12, "y": 0.5 }, "normalized_radius": 0.05, "detail_density": 0.2 },
    { "area_type": "combat", "normalized_center": { "x": 0.45, "y": 0.55 }, "normalized_radius": 0.10, "detail_density": 0.6 },
    { "area_type": "goal",   "normalized_center": { "x": 0.85, "y": 0.48 }, "normalized_radius": 0.06, "detail_density": 0.4 }
  ]
}
```

> `area_type`은 언리얼 `ParseAreaType()` 기준으로 `spawn / combat / goal / danger` 값만 인식합니다.
> 다른 문자열(`start_zone` 등)을 보내면 전부 `combat`으로 처리되어 버리니 주의하세요.

> ℹ️ **현재 상태**: `/generate-zone`은 구현되어 있지만, 아직 LLM API가 붙지 않아서 `dialogue` 내용을
> 실제로 해석하지는 않습니다. 요청 body에 `pcg_json`(LLM이 낼 법한 원본 포맷)을 같이 보내면 그걸
> validator로 보정해서 돌려주고, 안 보내면 기본 존(spawn+combat 1개+goal 구성의 안전한 forest 존)을
> 반환합니다. 즉 지금도 "테스트 JSON 넘기고 언리얼에서 실제로 구역이 생성되는지" 시연은 바로 가능하고,
> LLM 파트가 API로 노출되면 `app.js`의 TODO 주석 위치에서 `dialogue -> LLM 호출 -> pcg_json`으로
> 바꿔 끼우면 됩니다.

> ⚠️ **"전투 구역이 시작-전투-끝 3개로 고정되는 것 같다"는 리포트 관련 (2026-09-30)**:
> 확인 결과 `validator.js`의 `areas` 보정 로직 자체는 개수 제한이 없고, LLM이 몇 개를 보내든
> (`pcg_json.areas`) 그대로 통과시킵니다 (spawn/goal 최소 1개 보장 로직만 있음 — `test_validator.js`
> Test 3/4/6 참고). "고정 3개(=combat 1개)"로 보였던 건 **LLM API가 아직 `/generate-zone`에
> 연결되지 않아서**, `pcg_json` 없이 호출할 때 항상 같은 기본 존(combat 1개)이 나왔기 때문입니다.
> 이번에 `combat_count`(선택, 정수) 파라미터를 추가해서, LLM 없이도 combat 구역 개수가 가변이라는
> 걸 바로 확인할 수 있게 했습니다:
> ```bash
> curl -X POST http://127.0.0.1:8000/generate-zone \
>   -H "Content-Type: application/json" \
>   -d '{"combat_count": 3}'
> # areas: [spawn, combat, combat, combat, goal] (총 5구역)
> ```
> 다만 **언리얼 쪽 `APCGZoneController::ApplyAreaPCG()`는 `CurrentZoneData.Areas.Num()`이 레벨에
> 미리 배치된 `AreaPCGActors` 개수와 정확히 같아야만** 구역을 적용합니다 (다르면 경고 로그만 찍고
> 전체를 스킵). 그래서 백엔드가 몇 개를 보내든 해당 레벨에 그 개수만큼 Area 액터가 미리 배치돼
> 있어야 실제로 반영됩니다 — 이 부분은 레벨/언리얼 쪽에서 맞춰야 하는 부분이라 백엔드 코드로는
> 해결할 수 없고, 팀에 공유가 필요합니다.

### 2. 로컬에서 붙여보기 (Unreal 없이 먼저 확인)

```bash
curl -X POST http://127.0.0.1:8000/generate-zone \
  -H "Content-Type: application/json" \
  -d '{"dialogue":[{"speaker":"npc","text":"..."},{"speaker":"player","text":"어둡고 위험한 숲"}]}'
```

응답이 위 예시처럼 **감싸지지 않은 순수 Zone JSON**으로 오면 절반은 성공입니다.

### 3. 언리얼에서 붙여보기

1. 서버를 8000번 포트로 실행해 둡니다.
2. 언리얼 에디터에서 `BP_PCGZoneController`(또는 `APCGZoneController`) 액터 선택.
3. `TestNPCQuestion`, `TestPlayerAnswer`에 테스트 문장 입력.
4. `BackendUrl`이 `http://127.0.0.1:8000/generate-zone`인지 확인 (다른 PC라면 서버 PC의 로컬 IP로 교체).
5. Details 패널에서 `RequestZoneDataFromBackend` 실행.
6. Output Log에서 `[PCGZoneController] Backend Response Code: 200` 및 `Zone JSON applied to CurrentZoneData` 로그 확인.
7. 레벨 뷰포트에서 기본 환경/경로/구역이 갱신되는지 확인.

### 4. 자주 나는 문제

| 증상 | 원인 | 확인할 것 |
|---|---|---|
| `Failed to start HTTP request` | 서버가 안 떠 있거나 URL/포트 불일치 | 서버 실행 여부, `BackendUrl` 값, 방화벽 |
| `Backend returned non-success status code` | 서버가 4xx/5xx 반환 | 서버 로그에서 어떤 필드 검증에서 걸렸는지 확인 |
| `Failed to apply backend response JSON` | 응답이 감싸져 있거나 `theme`/`areas` 누락 | 응답 body를 curl로 직접 찍어서 최상위 구조 확인 |
| 구역이 전부 Combat으로 생성됨 | `area_type` 문자열이 언리얼 기준과 다름 | `spawn/combat/goal/danger`로 통일 |
| 다른 PC에서 연결 안 됨 | `127.0.0.1`은 로컬 전용 | 서버 PC의 실제 IP + 포트 방화벽 오픈 |

## validator.js 검증/보정 로직 (2차 고도화, 2026-09-30)

1차 최종보고서 버전은 LLM이 준 값을 타입/범위만 안전하게 보정해서 그대로 통과시키는
수준이었다. 이번 학기에 실제 언리얼 계약(배열 인덱스 = Area PCG Actor 매칭)에 맞춰
아래 2단계를 추가했다:

| 단계 | 이름 | 하는 일 |
|---|---|---|
| 7 | 공간적 순서 일치 (Spatial Ordering) | `areas`를 spawn-맨앞 / goal-맨뒤 / 나머지(combat·danger)는 정규화 x좌표 오름차순으로 재정렬. LLM이 순서를 뒤섞어 보내도 "배열 순서 = 경로상 실제 위치 순서"가 항상 맞도록 보장 |
| 8 | 최소 간격 보정 (Minimum Spacing) | 정렬된 순서를 유지한 채, 인접 구역 간 x간격이 `min_area_gap`(0.06)보다 좁으면 뒤 구역만 부드럽게 밀어서 벌림 (앞 구역 위치·LLM의 상대적 배치 의도는 보존) |
| 9 | 반지름-간격 정합성 | 구역 반지름이 인접 구역까지 거리보다 크면 원이 겹쳐 보이므로, 좌우 인접 구역까지 거리의 절반을 넘지 않도록 추가 clamp (`radius.min`은 최소 보장) |

`test_validator.js` Test 7(순서 재정렬), Test 8(최소 간격)에서 회귀 검증한다. 요구사항
분석서의 "구역 배열 순서 일치" 비기능요구사항 항목이 이번에 실제로 구현됨.

## API 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| GET | `/health` | 서버 상태 확인 |
| POST | `/generate-zone` | 언리얼 클라이언트용 — dialogue(+옵션 `pcg_json`, `combat_count`)를 받아 Zone JSON을 그대로 반환. LLM 미연동 상태라 `pcg_json` 없으면 기본 존 반환 (`combat_count`로 combat 구역 개수 조절 가능) |
| POST | `/api/chat/send` | (내부용) 대화 적재 및 세션 컨텍스트 반환 — Redis 필요 |
| POST | `/api/world/generate` | (내부용) LLM 원본 출력(`llmResult`)을 받아 검증/보정 |

## 구성 요소

- `app.js` — Express 라우팅
- `sessionManager.js` — Redis 기반 대화 세션/슬라이딩 윈도우 관리
- `validator.js` — LLM 출력 파라미터 검증 및 보정 (밀도 합 정규화, soft clamp 등)
