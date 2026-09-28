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
> validator로 보정해서 돌려주고, 안 보내면 기본 존(spawn+goal만 있는 안전한 forest 존)을 반환합니다.
> 즉 지금도 "테스트 JSON 넘기고 언리얼에서 실제로 구역이 생성되는지" 시연은 바로 가능하고,
> LLM 파트가 API로 노출되면 `app.js`의 TODO 주석 위치에서 `dialogue -> LLM 호출 -> pcg_json`으로
> 바꿔 끼우면 됩니다.

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

## API 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| GET | `/health` | 서버 상태 확인 |
| POST | `/generate-zone` | 언리얼 클라이언트용 — dialogue(+옵션 `pcg_json`)를 받아 Zone JSON을 그대로 반환. LLM 미연동 상태라 `pcg_json` 없으면 기본 존 반환 |
| POST | `/api/chat/send` | (내부용) 대화 적재 및 세션 컨텍스트 반환 — Redis 필요 |
| POST | `/api/world/generate` | (내부용) LLM 원본 출력(`llmResult`)을 받아 검증/보정 |

## 구성 요소

- `app.js` — Express 라우팅
- `sessionManager.js` — Redis 기반 대화 세션/슬라이딩 윈도우 관리
- `validator.js` — LLM 출력 파라미터 검증 및 보정 (밀도 합 정규화, soft clamp 등)
