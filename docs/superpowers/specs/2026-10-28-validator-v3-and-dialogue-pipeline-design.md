# 설계: validator 3차 고도화 + dialogue → Zone 파이프라인 (2026-10-28)

## 배경 / 왜 지금

- 10/29 3차 중간발표(구현 보고서 + 1차 테스트 결과서). 백엔드는 현재 "LLM 미연동, dialogue 무시, 항상 기본 존" 상태.
- 언리얼 레포(Choibw/LLMDrivenPlayablePCG)가 10/24~27에 바뀜: Area PCG 액터 자동 생성, **모든 combat 클리어 시에만 goal 활성화**, radius 허용 0.01~0.30, path_width 100~1500, 경로 점 2개 이상 필수, areas 1개 이상 필수, theme 문자열 필수(값은 로그용).
- LLM 파트(kjs1214/LLMDrivenPlayablePCG-LLM)는 아직 HTTP API 없음. vLLM(OpenAI 호환, JSON Schema 강제)을 Gradio 앱이 직접 호출. theme 4종(forest/grassland/desert/snow) 출력. 백엔드는 forest만 허용 → 문서상 "조율 필요" 미해결.

## 목표

1. validator가 "값 범위 보정기"에서 "레이아웃 정합성 보정기"로 격상. 경로 기하·경로-구역 결합·2D 겹침·테마·난이도까지 다룸.
2. dialogue가 실제로 Zone에 반영됨. LLM(vLLM)이 없어도 규칙 기반 해석기로 시연 가능. LLM이 생기면 `.env`만으로 전환.
3. Redis 없이도 `/generate-zone` 정상. 세션은 있으면 쓰고 없으면 건너뜀.
4. 테스트 명세서(BE-T01~T12)가 실제 코드로 존재하고 `npm test`로 돈다. 결과서가 자동 생성된다(md + docx).

## 비목표

- 언리얼/LLM 레포 수정. 테마별 에셋, 전투 AI 등 클라이언트 영역.
- LLM 파인튜닝, 프롬프트 품질 실험.
- 인증/배포/운영.

## 안티골 (이러면 실패)

- 언리얼이 응답을 못 읽음(봉투로 감싸기, 필드 이름 변경, 최상위 필드 추가로 파싱 실패). → 응답 최상위 구조는 그대로. 디버그 정보는 `?debug=1`일 때만 `validation_report` 필드로 추가(언리얼은 모르는 필드 무시함을 소스로 확인).
- 보정이 LLM 의도를 지워버림(모든 입력이 같은 존으로 수렴). → 보정은 "위반 시에만, 최소 이동" 원칙. 보정 전/후 diff를 리포트로 남김.
- 비결정적 결과. → validator에 난수 없음. 규칙 기반 해석기의 난수는 dialogue 해시 seed로 재현.

## 계약 (언리얼 소스 기준, 변경 없음)

요청 `POST /generate-zone` `{ dialogue: [{speaker, text}], userId?, pcg_json?, combat_count?, seed? }`
응답 200: Zone JSON 최상위 그대로. `theme`(string), `base_environment{tree,rock,grass}`, `main_path{path_type, path_width, normalized_points[≥2]}`, `areas[≥1]`.

## validator v3 파이프라인 (순서 고정, 전부 결정적)

입력 → `normalizeInput`(타입 안전화, 평평한 구버전/중첩 신버전 둘 다 수용)

1. **theme**: 4종 화이트리스트. 미지정/불명이면 밀도 패턴으로 추정(풀≫나무→grassland, 바위≫풀→desert …), 그래도 애매하면 forest.
2. **density**: softClamp(tanh) → 테마 프로필 범위로 클램프 → 합 정규화(max_total_sum 1.8) → 다시 클램프. 누락값은 테마 기본값.
3. **path 기하**:
   - 점 수 2~12로 자르기(LLM 스키마 최대 10), 좌표 [0,1] 클램프 후 가장자리 여백 0.03 안으로.
   - 중복/근접점(거리 < 0.02) 병합.
   - 자기교차 풀기: 교차 구간 사이 점 순서 뒤집기(2-opt), 최대 N회.
   - 급회전(사이각 < 25°) 완화: 꼭짓점을 이웃 중점 쪽으로 이동.
   - spawn-goal 직선거리 < 0.45면 양 끝점을 원래 방향 유지하며 밀어냄.
   - 점이 1개 이하가 되면 기본 경로.
4. **areas 타입/값**: 화이트리스트(spawn/combat/goal/danger), radius [0.01,0.30] soft clamp, detail_density [0,1].
5. **구조 보장**: spawn/goal 정확히 1개씩(여러 개면 첫 번째만 유지, 나머지 combat으로 강등). combat 0개 허용. 총 구역 수 상한 8.
6. **경로-구역 결합**:
   - spawn 중심 = 경로 첫 점, goal 중심 = 경로 마지막 점(스냅).
   - combat/danger: 원 가장자리~경로 거리 > 0.12면 중심을 경로 최근접점 방향으로 최소 이동.
7. **진행도 기반 정렬**: 각 구역을 경로에 투영해 진행도 t∈[0,1] 계산. spawn 맨앞, goal 맨뒤, 나머지 t 오름차순.
8. **간격/겹침 해소(2D)**: 인접 구역 진행도 차 < 0.06이면 뒤 구역을 경로 따라 밀기. 원끼리 겹치면(중심거리 < r1+r2+0.01) 반복 분리(최대 20회), 분리 후 경로 근접 규칙 재적용. 끝까지 안 풀리면 반지름 축소.
9. **반지름 정합성**: 이웃 중심까지 2D 거리의 절반 초과 금지(최소 0.01 보장).
10. **난이도 곡선**: combat의 detail_density를 진행도 순으로 단조 비감소(isotonic). LLM이 준 최댓값은 유지.
11. **리포트**: 각 단계가 `{step, target, before, after, reason}` 푸시. `quality_score` = 1 − Σ(가중치×보정량), `hard_violations_before`(교차·거리·겹침 등 필수 규칙 위반 수), `idempotent` 여부.

불변식(테스트로 고정): 출력은 언리얼 목 파서 통과 / spawn·goal 1개씩 / spawn·goal이 경로 양끝 / 교차 0 / 인접 진행도 ≥ 0.06 / 원 겹침 0 / 밀도 합 ≤ 1.8 / `validate(validate(x)) deep-equal validate(x)`.

## dialogue → Zone

`llmClient.generateZoneCandidate({dialogue, context, seed})` → raw Zone JSON (validator 입력).

- `LLM_MODE=rule|vllm|auto` (기본 `auto`: `LLM_API_URL` 있으면 vllm 시도, 실패/타임아웃(`LLM_TIMEOUT_MS`, 기본 8000)이면 rule).
- vllm: OpenAI 호환 `POST {LLM_API_URL}/chat/completions`, `response_format: json_schema`(LLM 레포 SCHEMA와 동일), 시스템 프롬프트는 LLM 레포 것을 dialogue 입력형으로 변형. Node 22 내장 fetch + AbortController.
- rule(`dialogueInterpreter.js`): 한국어 키워드 → 의도 추출(theme, 밀도 성향, 길 모양/폭, 전투 수, 강도, 크기). seed = `seed` 옵션 또는 dialogue 해시(FNV-1a). seeded PRNG(mulberry32)로 경로 점 생성(방향·굴곡은 의도 반영) + combat을 경로 진행도 균등 분할 지점에 배치. 출력에 `_intent`(디버그용, validator가 제거).

## 세션

- Redis 클라이언트를 `sessionManager`가 lazy/graceful하게 관리: 연결 실패 시 `available=false`, 모든 함수가 예외 없이 기본값 반환. 에러 로그는 1회만.
- `/generate-zone`: `userId` 없으면 `unreal-test`. dialogue의 각 text를 `updateHistory`로 적재(가능할 때). `getFullContext`를 LLM 프롬프트 context로 전달.

## 테스트

- 러너: Node 내장 `node:test` + `assert/strict`. `npm test` = `node --test test/`.
- `test/validator.test.js`: BE-T01~T05, T11, T12 + v3 신규(경로 교차, spawn-goal 거리, 경로 스냅, combat 투영, 2D 겹침, 난이도 곡선, 테마 4종, 멱등성).
- `test/fuzz.test.js`: seed 0~1999 무작위 입력 → 예외 0, 불변식 100%.
- `test/interpreter.test.js`: 키워드 → 의도, seed 재현성.
- `test/api.test.js`: 임시 포트로 서버 기동, `/health`, `/generate-zone`(기본/pcg_json/combat_count/dialogue/debug), 잘못된 body 400, Redis 없을 때 정상.
- `unreal_parser_mock.js`: `ApplyZoneJsonString` 규칙 재현(필수 필드, 점 ≥2, areas ≥1, 클램프). BE-T10.
- `scripts/test-report.js`: `node --test --test-reporter=json` 결과 → `docs/TEST_RESULTS_1차.md` + `docs/TEST_RESULTS_1차.docx`(python-docx).

## 빌더에게 맡기는 것

- 상수 값의 미세 조정(여백 0.03, 근접 병합 0.02, 반복 횟수 등). 스펙의 값은 출발점.
- 리포트 가중치.
- 파일 분할(`geometry.js`, `themes.js` 등).
