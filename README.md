# LLM-Driven PCG Server

플레이어-NPC 대화를 언리얼 엔진 PCG용 Zone JSON으로 바꿔 넘겨주는 Node.js 백엔드입니다.

```
dialogue ──► 후보 Zone 생성 (vLLM | 규칙 기반 해석기) ──► validator v3 (레이아웃 정합성 보정) ──► Zone JSON ──► Unreal
                 ▲ Redis 세션(이전 배경/최근 대화) - 없어도 동작
```

- **validator v3**: LLM이 낸 값을 "범위만 맞추는" 수준이 아니라 경로 기하·경로-구역 결합·2D 겹침·테마·난이도까지 보정해서, 어떤 입력이 와도 언리얼이 그대로 읽을 수 있는 유효한 존을 만든다. 결정적(난수 없음)이고 멱등(결과를 다시 넣어도 그대로)이다.
- **dialogue 파이프라인**: vLLM(OpenAI 호환, JSON Schema 강제)이 있으면 호출하고, 없거나 실패/타임아웃이면 규칙 기반 해석기가 대화에서 테마·밀도·길 모양·전투 수·강도를 뽑아 후보 존을 만든다. GPU 없이도 "대화가 바뀌면 존이 바뀌는" 시연이 된다.
- **장애 허용**: Redis가 없어도 `/generate-zone`은 정상. LLM 서버가 죽어도 응답은 항상 유효한 존.
- **테스트**: 테스트 명세서 BE-T01~T12를 포함한 자동화 테스트 98건 + 무작위 입력 2,000건 fuzz. `npm run test:report`로 결과서(md/docx) 자동 생성.

## 요구사항

- Node.js 18+ (내장 fetch, `node:test` 사용. 개발은 22에서 확인)
- Redis (선택) — 세션/이전 배경 기능. 없으면 자동으로 비활성
- vLLM 서버 (선택) — 없으면 규칙 기반 해석기로 동작
- 결과서 docx 생성에만 Python 3 + `python-docx` (선택)

## 설치 및 실행

```bash
npm install
cp .env.example .env
npm run dev      # nodemon
npm start        # 일반 실행
npm test         # 전체 테스트
npm run demo     # 시연 시나리오 4개 콘솔 출력 (서버/Redis/LLM 없이 동작)
npm run test:report   # docs/TEST_RESULTS_1차.md + .docx 생성
```

`.env`:

```
PORT=8000                       # 언리얼 기본 BackendUrl이 127.0.0.1:8000이라 8000 권장
REDIS_URL=redis://127.0.0.1:6379
LLM_MODE=auto                   # auto | vllm | rule
LLM_API_URL=                    # 예: http://gpu-server:8000/v1  (비우면 규칙 기반)
LLM_MODEL=Qwen/Qwen3-8B
LLM_TIMEOUT_MS=8000
```

헬스체크:

```bash
curl http://127.0.0.1:8000/health
# {"status":"running","llm_mode":"auto","llm_api_url_set":false,"redis":true}
```

## 언리얼 클라이언트 연동

### 계약 (Choibw/LLMDrivenPlayablePCG `PCGZoneController.cpp` 2026-10-27 기준)

언리얼 `APCGZoneController::RequestZoneDataFromBackend`는 아래 POST 한 번을 보내고, 응답 body를 **그대로** Zone JSON으로 파싱한다. 봉투로 감싸면 안 된다.

**요청**

```http
POST /generate-zone
Content-Type: application/json

{
  "dialogue": [
    { "speaker": "npc", "text": "다음 구역엔 어떤 곳이 있을 것 같아?" },
    { "speaker": "player", "text": "어둡고 나무가 빽빽한 숲, 중간에 전투 3번" }
  ]
}
```

선택 필드: `userId`(없으면 `unreal-test`), `seed`(정수, 같은 대화로 다른 변형), `combat_count`(정수), `pcg_json`(LLM 원본 포맷 직접 주입 — 테스트용).
쿼리 `?debug=1`을 붙이면 응답에 `validation_report`(보정 내역·품질 점수·후보 출처)가 추가된다. 언리얼은 모르는 필드를 무시하므로 붙여도 파싱은 성공한다.

**응답 (항상 200)**

```json
{
  "theme": "forest",
  "base_environment": { "tree_density": 0.8, "rock_density": 0.3, "grass_density": 0.7 },
  "main_path": {
    "path_type": "main",
    "path_width": 480,
    "normalized_points": [ { "x": 0.08, "y": 0.4233 }, { "x": 0.2109, "y": 0.4725 }, "...", { "x": 0.92, "y": 0.1883 } ]
  },
  "areas": [
    { "area_type": "spawn",  "normalized_center": { "x": 0.08,   "y": 0.4233 }, "normalized_radius": 0.05,  "detail_density": 0.2 },
    { "area_type": "combat", "normalized_center": { "x": 0.3188, "y": 0.5096 }, "normalized_radius": 0.072, "detail_density": 0.5401 },
    { "area_type": "combat", "normalized_center": { "x": 0.4593, "y": 0.3593 }, "normalized_radius": 0.0827,"detail_density": 0.5893 },
    { "area_type": "combat", "normalized_center": { "x": 0.7072, "y": 0.2793 }, "normalized_radius": 0.0788,"detail_density": 0.6449 },
    { "area_type": "goal",   "normalized_center": { "x": 0.92,   "y": 0.1883 }, "normalized_radius": 0.06,  "detail_density": 0.4 }
  ]
}
```

응답이 항상 만족하는 불변식 (테스트로 고정, `test/helpers/invariants.js`):

| 항목 | 보장 |
|---|---|
| 구조 | `theme`(forest/grassland/desert/snow) · `base_environment` · `main_path`(점 2~12) · `areas`(2~8) |
| 밀도 | 각 테마 허용 범위 안, 합 ≤ 1.8 |
| 경로 | 자기교차 0, 25° 미만 급회전 0, 가장자리 여백 0.03, spawn-goal 직선거리 ≥ 0.45 |
| 구역 | spawn 정확히 1개(areas[0], 경로 시작점) · goal 정확히 1개(areas[마지막], 경로 끝점) |
| 배치 | 배열 순서 = 경로 진행도 순서, 인접 구역 진행도 간격 ≥ 0.06, combat 가장자리~경로 ≤ 0.12, 원끼리 겹침 0 (예외: 경로가 접혀 두 중심이 0.03 미만으로 붙는 극단 입력에서는 언리얼 최소 반지름 0.01 때문에 ≤0.02 겹침이 남을 수 있음 — 적대적 입력 18,000건 중 48건) |
| 난이도 | combat `detail_density`가 진행 방향으로 단조 비감소 |
| 멱등 | `validate(validate(x)) === validate(x)` |

### 언리얼 10/27 변경과의 관계

- Area PCG 액터가 **자동 생성**되므로 "레벨에 액터 수를 맞춰야 한다"는 제약이 없어졌다. 백엔드는 combat 0~6개를 자유롭게 보낸다.
- **모든 combat 구역을 클리어해야 goal이 활성화**된다(`ExpectedCombatAreaCount` = combat 수). 그래서 validator가 combat 개수를 입력과 일치시키고, 난이도를 진행 순으로 정렬하는 것이 플레이 흐름과 직접 연결된다.
- 언리얼 파싱 규칙은 `unreal_parser_mock.js`에 그대로 재현되어 있고, API 테스트의 모든 응답이 이 목 파서를 통과한다.

### 언리얼에서 붙여보기

1. 서버를 8000번 포트로 실행.
2. `BP_PCGZoneController` 선택 → `TestNPCQuestion`, `TestPlayerAnswer` 입력.
3. `BackendUrl`이 `http://127.0.0.1:8000/generate-zone`인지 확인(다른 PC면 서버 IP).
4. `RequestZoneDataFromBackend` 실행 → Output Log에서 `Backend Response Code: 200`, `Parsed areas. AreaCount=N` 확인.
5. 서버 콘솔에는 요청마다 한 줄이 남는다: `[generate-zone] user=unreal-test source=rule corrections=0 hard=0 score=1 combats=3`

| 증상 | 원인 | 확인 |
|---|---|---|
| `Failed to start HTTP request` | 서버 미기동/포트 불일치 | `/health`, `BackendUrl`, 방화벽 |
| `Failed to apply backend response JSON` | 응답이 감싸져 있거나 필수 필드 누락 | `npm test`의 `unrealMock`/`api` 테스트, `?debug=1` |
| 대화를 바꿔도 존이 비슷함 | 키워드가 해석기 표에 없음 | `?debug=1`의 `validation_report.intent` 확인, `dialogueInterpreter.js` 키워드 표 |
| 매번 같은 존 | 같은 대화 = 같은 seed(의도된 재현성) | `seed` 필드로 변형 |

## validator v3 보정 파이프라인

입력은 LLM 원본(중첩 `base_environment/main_path`)과 1차 시절 평평한 포맷 둘 다 받는다. 단계 순서 고정, 전부 결정적.

| 단계 | 이름 | 하는 일 |
|---|---|---|
| 1 | theme | 4종 화이트리스트. 없거나 모르면 밀도 패턴으로 추정(바위≫풀→desert …), 그래도 애매하면 forest |
| 2 | density | 테마별 허용 범위 클램프 → 합 1.8 초과 시 비율 유지 스케일. 누락값은 테마 기본값 |
| 3 | path | 숫자 아닌 점 제거 → 점 2~12 → 가장자리 여백 → **근접점 병합(0.02)** → **2-opt로 자기교차 해소** → **급회전(<25°) 완화/제거** → **spawn-goal 거리 0.45 확보** (안정될 때까지 반복). 복구 불가면 기본 경로 |
| 4 | areas 값 | area_type 화이트리스트(밖이면 combat), radius [0.01, 0.30], detail [0,1], 중심 누락 시 경로 위 균등 배치 |
| 5 | 구조 | spawn/goal 정확히 1개(여분은 combat으로 강등, 없으면 추가), `combat_count` 반영(부족분은 가장 넓은 빈 구간에 추가), 구역 ≤ 8 |
| 6 | 결합 | spawn 중심 = 경로 첫 점, goal 중심 = 경로 끝 점으로 스냅 |
| 7 | 정렬 | 각 구역을 경로에 투영해 **호길이 진행도 t**로 정렬 (x좌표 정렬은 위→아래 경로에서 틀림) |
| 8 | 간격/근접/겹침 | 경로 좌표계(t, 수직 오프셋)에서 1D 간격 문제로 풀어 인접 간격 0.06 확보, 오프셋을 r+0.12 이내로 제한, 반지름은 "입력값과 최종 위치에서 겹치지 않는 최대값" 중 작은 쪽 → 겹침 0 |
| 9 | 난이도 | combat detail_density를 진행 순으로 오름차순 재배열(값 집합은 유지, LLM이 정한 강도 분포 보존) |
| 10 | 리포트 | 단계별 `{step, target, before, after, reason}`, 보정 전 필수 규칙 위반 수, 품질 점수 = 1 − 0.03×보정 − 0.1×위반 |

왜 tanh 소프트 클램프를 뺐나: 멱등·단조·연속인 1변수 함수는 하드 클램프뿐이라 소프트 압축은 멱등성과 양립할 수 없고, 실제로도 테마 범위 하드 클램프에 항상 지배되어 출력에 영향이 없었다. 대신 "무엇을 왜 바꿨는지"를 리포트로 남긴다.

`?debug=1` 응답 예 (깨진 LLM 출력을 넣었을 때):

```
위반(보정 전): 자기교차 1건 / spawn 없음 / 구역 원 겹침 3쌍
· [theme] "lava" → "forest"            (화이트리스트 밖 → 밀도 패턴으로 추정)
· [density] tree_density 2.5 → 0.8     (forest 허용 범위 [0.2, 0.8] 클램프)
· [path] "crossing" → "untangled"      (2-opt 구간 뒤집기 1회로 자기교차 해소)
· [areas] "no spawn" → "spawn added"   (spawn 자동 추가(경로 시작점))
· [layout] goal (0.5,0.5) → (0.1,0.9)  (goal은 경로 끝점에 고정)
· [difficulty] [0.9,0.2] → [0.2,0.9]   (전투 강도가 진행 방향으로 단조 증가하도록 재배열)
품질점수 0.34 → 언리얼 파서 OK
```

## dialogue → Zone

`llmClient.generateZoneCandidate({dialogue, context, seed, combatCount})`

| 모드 | 동작 |
|---|---|
| `vllm` | `POST {LLM_API_URL}/chat/completions`, `response_format: json_schema`(LLM 레포 `app.py`의 SCHEMA와 동일, theme 4종). 시스템 프롬프트는 LLM 레포 규칙을 dialogue 입력형으로 변형하고 Redis의 이전 배경/최근 대화를 함께 넣는다. 실패/타임아웃(`LLM_TIMEOUT_MS`)이면 rule로 폴백 |
| `rule` | `dialogueInterpreter.js`: 키워드 → 의도(테마, 밀도 성향, 길 모양/폭, 전투 수, 강도, 크기) → seed 기반 후보 존(경로 방향 4종, 굴곡은 길 모양에 따라, combat은 진행도 균등 분할 ± 길옆 오프셋). seed 기본값은 대화 해시 → 같은 대화는 같은 존 |
| `auto` | `LLM_API_URL`이 있으면 vllm 시도, 아니면 rule |

해석기가 아는 표현(일부): 숲/초원/사막/설원(눈) · 빽빽/울창/황량/바위/풀 · 구불구불/곧은/넓은/좁은 · "전투 3번", "세 번", "두 개의 전투", "전투 없이", "많이" · 격렬/보스/위험, 가벼운 · 큰/작은 전투.

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/health` | 상태 + LLM 모드/URL 설정 여부 + Redis 연결 여부 |
| POST | `/generate-zone` | 언리얼용. dialogue(+`userId`,`seed`,`combat_count`,`pcg_json`) → Zone JSON. `?debug=1`로 리포트 |
| POST | `/api/chat/send` | (내부) 대화 적재 + 컨텍스트 반환. Redis 없으면 503 |
| POST | `/api/world/generate` | (내부) `{userId, llmResult:{pcg_json, updated_background}}` → `{success, dataForUnreal}` |

## 테스트

```bash
npm test                 # node:test, 추가 의존성 없음
npm run test:report      # docs/TEST_RESULTS_1차.md, .docx (python-docx 필요)
```

| 파일 | 내용 |
|---|---|
| `test/validator.test.js` | 명세 BE-T01~T05, T11, T12 + V3-01~16 (교차 해소, 거리, 스냅, 투영, 겹침, 난이도, 테마, 멱등성, 위→아래 경로, 길이 0 경로, spawn 3개 …) |
| `test/fuzz.test.js` | seed 0~1999 무작위 망가진 입력: 예외 0, 불변식 100%, 멱등성 100% |
| `test/geometry.test.js`, `test/themes.test.js` | 기하/테마/리포트 단위 테스트 |
| `test/interpreter.test.js` | 키워드 해석, 수사, 재현성, 후보→validator 보존 |
| `test/llmClient.test.js` | fetch 주입으로 정상/500/타임아웃/깨진 JSON/모드 분기 |
| `test/unrealMock.test.js` | 언리얼 `ApplyZoneJsonString` 재현 파서 |
| `test/api.test.js` | Redis 미연결 상태에서 전체 엔드포인트 (BE-T06~T09, T11, T13~T17) |
| `test/session.test.js` | Redis 있을 때만: 노이즈 필터, 슬라이딩 윈도우 키워드 보존, 배경 저장 |

## 구성 요소

| 파일 | 역할 |
|---|---|
| `app.js` | Express 라우팅, `createApp()` |
| `validator.js` | v3 보정 파이프라인, `validatePCGParams` / `validateWithReport` / `normalizeInput` / `defaultZone` |
| `lib/geometry.js` | 투영·진행도·교차·2-opt·급회전·끝점 밀기 등 순수 기하 |
| `lib/themes.js` | 테마 4종 밀도 프로필, 추정 |
| `lib/report.js` | 보정 리포트/품질 점수 |
| `llmClient.js` | vLLM 호출 + 폴백, 프롬프트, JSON Schema |
| `dialogueInterpreter.js` | 규칙 기반 해석기 + seed 후보 생성 |
| `sessionManager.js` | Redis 슬라이딩 윈도우(장애 허용) |
| `unreal_parser_mock.js` | 언리얼 파싱 규칙 재현 |
| `scripts/demo.js`, `scripts/test-report.js`, `scripts/build-docx.py` | 시연, 결과서 생성 |
| `docs/superpowers/specs`, `docs/superpowers/plans` | 3차 고도화 설계 스펙/구현 플랜 |

## 알려진 제약 / 다음 단계

- vLLM 경로는 목(fetch 주입)으로만 검증됨. LLM 파트 서버가 열리면 `.env`에 `LLM_API_URL`만 넣으면 된다(프롬프트 품질은 그때 조정).
- 규칙 기반 해석기는 키워드 표 범위에서만 대화를 이해한다. 표에 없는 표현은 기본값(forest, 전투 1)으로 간다.
- 과밀 입력(큰 반지름 여러 개)에서는 반지름이 줄어든다. 의도적 선택: 중심 위치(LLM의 배치 의도)를 반지름보다 우선 보존.
- `path_width`/`detail_density`는 언리얼 쪽에서 아직 PCG 파라미터에 연결되지 않음(클라이언트 후속 작업).
