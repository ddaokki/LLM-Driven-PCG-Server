# validator v3 + dialogue 파이프라인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** validator를 레이아웃 정합성 보정기로 격상하고, dialogue가 실제로 Zone에 반영되게 하며, 테스트 명세서를 실행 가능한 테스트와 자동 결과서로 만든다.

**Architecture:** 순수 함수 모듈(`lib/geometry.js`, `lib/themes.js`, `lib/report.js`) 위에 결정적 파이프라인 `validator.js`를 올린다. `llmClient.js`가 vLLM(OpenAI 호환) 또는 규칙 기반 `dialogueInterpreter.js`로 후보 Zone을 만들고, `app.js`는 후보 → validator → 응답만 한다. Redis는 `sessionManager.js` 안에서만 다루며 없어도 동작한다.

**Tech Stack:** Node 22 (내장 fetch, `node:test`, `assert/strict`), Express 4, redis 4, python-docx(결과서 docx).

**Spec:** `docs/superpowers/specs/2026-10-28-validator-v3-and-dialogue-pipeline-design.md`

## Global Constraints

- 응답 최상위 구조는 언리얼 계약 그대로: `theme`, `base_environment{tree_density,rock_density,grass_density}`, `main_path{path_type,path_width,normalized_points[≥2]}`, `areas[≥1]`. 추가 필드는 `?debug=1`일 때 `validation_report` 하나만.
- 좌표 [0,1], 가장자리 여백 0.03, 근접점 병합 0.02, 급회전 25°, spawn-goal 최소 0.45, combat 가장자리~경로 최대 0.12, 인접 진행도 최소 0.06, 원 겹침 여유 0.01, radius [0.01,0.30], path_width [100,1500], 경로 점 2~12, 구역 최대 8, 밀도 합 최대 1.8.
- validator에 `Math.random` 금지. 해석기 난수는 seed(mulberry32)만.
- 새 npm 의존성 추가 금지(테스트 러너는 `node:test`).
- `.env` 키: `PORT`, `REDIS_URL`, `LLM_MODE`, `LLM_API_URL`, `LLM_MODEL`, `LLM_TIMEOUT_MS`.

## Review Focus

1. 경로 점이 전부 같은 좌표(길이 0 경로) → 기본 경로로 대체, 예외 없음. (Task 2 V3-10 + fuzz)
2. areas가 spawn 3개/goal 0개처럼 편중 → spawn 1개만 남기고 나머지 combat 강등, goal 자동 추가. (Task 2 V3-11)
3. 경로가 오른쪽→왼쪽/위→아래 진행 → 정렬이 x가 아니라 진행도 기준이어야 함. (Task 2 V3-09)
4. dialogue가 빈 배열/텍스트 없음/영어만 → 기본 의도(forest, combat 1)로 후보 생성. (Task 3)
5. `LLM_API_URL`이 죽은 주소 → 타임아웃 후 rule로 폴백, 응답 시간 ≤ LLM_TIMEOUT_MS+여유. (Task 4)

---

### Task 1: 기하/테마/리포트 유틸

**Files:**
- Create: `lib/geometry.js`, `lib/themes.js`, `lib/report.js`
- Test: `test/geometry.test.js`, `test/themes.test.js`

**Interfaces (Produces):**
- `geometry`: `clamp(v,min,max)`, `dist(a,b)`, `segmentsIntersect(p1,p2,p3,p4):boolean`(공유 끝점 제외), `cumulativeLengths(pts):number[]`, `polylineLength(pts)`, `projectToPolyline(pt,pts):{t,point,dist}`(t=호길이 진행도 0~1), `pointAtProgress(pts,t):{x,y}`, `turnAngleDeg(a,b,c):number`(b에서의 사이각, 직진=180), `mergeClosePoints(pts,eps):pts`, `findSelfIntersections(pts):[i,j][]`, `untangle(pts,maxIter=20):{points,flips}`(2-opt 뒤집기), `relaxSharpTurns(pts,minAngleDeg,factor=0.5):{points,count}`, `pushEndpointsApart(pts,minDist):{points,moved}`, `separateCircles(circles,pad,maxIter=20):{circles,iterations}`(circles: `{x,y,r,locked?}`; locked는 안 움직임).
- `themes`: `THEMES` = `{forest,grassland,desert,snow}` 각 `{tree:{min,max,def},rock:{...},grass:{...}}`, `VALID_THEMES`, `inferTheme({tree,rock,grass}):string`, `getProfile(theme)`.
  - 값: forest tree[0.2,0.8]/0.4 rock[0.1,0.6]/0.3 grass[0.3,0.9]/0.7; grassland tree[0,0.25]/0.1 rock[0,0.3]/0.1 grass[0.6,1]/0.85; desert tree[0,0.15]/0.05 rock[0.3,0.9]/0.65 grass[0,0.2]/0.1; snow tree[0.05,0.5]/0.25 rock[0.1,0.6]/0.35 grass[0,0.25]/0.1.
- `report`: `class CorrectionReport { add(step,target,before,after,reason); hard(step,detail); toJSON():{corrections[],hard_violations_before:number,quality_score:number,correction_count}; }` quality_score = max(0, 1 − 0.03×corrections − 0.1×hard).

- [ ] Step 1: `test/geometry.test.js` 작성: 교차 판정(X자 true, 공유 끝점 false), `projectToPolyline` 중간점 t≈0.5, `untangle`로 8자 경로 교차 0, `pushEndpointsApart` 후 거리 ≥0.45, `separateCircles` 후 모든 쌍 중심거리 ≥ r1+r2+pad.
- [ ] Step 2: `node --test test/geometry.test.js` → FAIL (module not found).
- [ ] Step 3: `lib/geometry.js` 구현.
- [ ] Step 4: `test/themes.test.js`: `inferTheme({tree:0.05,rock:0.7,grass:0.1})==='desert'`, grass 0.9/tree 0.1 → grassland, 전부 기본값 근처 → forest.
- [ ] Step 5: `lib/themes.js`, `lib/report.js` 구현. 테스트 PASS.
- [ ] Step 6: `git commit -m "feat(lib): 기하/테마/리포트 유틸 추가"`

### Task 2: validator v3

**Files:**
- Modify: `validator.js` (전면 재작성, 기존 export 유지)
- Test: `test/validator.test.js`, `test/fuzz.test.js`, 기존 `test_validator.js`는 삭제(내용은 test/로 이전)

**Interfaces:**
- Consumes: Task 1 전부.
- Produces: `validatePCGParams(aiData, options?)` → Zone(옵션 `{combatCount, debug}`; `debug`면 `validation_report` 포함). `validateWithReport(aiData, options?)` → `{zone, report}`. `CONFIG` export. `normalizeInput(aiData)` export(평평한 구버전 `tree_density` 최상위도 수용).

- [ ] Step 1: `test/validator.test.js` 작성. 각 테스트 이름에 명세 ID 접두: `BE-T01 밀도 합 정규화`, `BE-T02 soft clamp`, `BE-T03 area_type 화이트리스트`, `BE-T04 spawn/goal 보장`, `BE-T05 중첩 스키마`, `BE-T11 combat_count 0/1/3`, `BE-T12 진행도 정렬+간격`, `V3-01 8자 경로 교차 해소`, `V3-02 spawn-goal 거리<0.45 → ≥0.45`, `V3-03 spawn/goal 경로 양끝 스냅`, `V3-04 경로에서 먼 combat 투영(가장자리 거리 ≤0.12)`, `V3-05 겹친 combat 2D 분리`, `V3-06 난이도 단조 비감소`, `V3-07 테마 4종 통과 + 미지정 추정`, `V3-08 멱등성 deepEqual`, `V3-09 위→아래 경로 정렬`, `V3-10 길이 0 경로 → 기본 경로`, `V3-11 spawn 3개 → 1개`, `V3-12 debug 리포트 필드 존재/비debug 부재`.
- [ ] Step 2: 실행 → 다수 FAIL 확인.
- [ ] Step 3: `validator.js` 재작성(스펙 1~11단계 순서 그대로, 각 단계가 report에 기록).
- [ ] Step 4: `test/fuzz.test.js`: seed 0~1999, 좌표 −0.5~1.5, 점 0~15, 구역 0~10(타입 무작위 문자열 포함), 밀도 −1~3, 문자열/null 섞기 → 예외 0, 불변식(스펙 "불변식") 전부 통과.
- [ ] Step 5: `node --test test/` PASS. `git rm test_validator.js`.
- [ ] Step 6: commit `feat(validator): v3 - 경로 기하/경로-구역 결합/2D 겹침/테마/난이도/리포트`.

### Task 3: 규칙 기반 dialogue 해석기

**Files:**
- Create: `dialogueInterpreter.js`
- Test: `test/interpreter.test.js`

**Interfaces (Produces):**
- `interpretDialogue(dialogue):Intent` — `{theme, density:{tree,rock,grass}(0~1 성향), pathShape:'straight'|'winding'|'normal', pathWidth:'narrow'|'wide'|'normal', combatCount:number, intensity:'low'|'mid'|'high', areaSize:'small'|'mid'|'large', keywords:string[]}`. player 발화 가중 2배, npc 가중 1.
- `buildCandidateZone(intent, seed):RawZone` — 경로 점 수 straight 3 / normal 5 / winding 8, 방향은 seed로 4방향 중 택1, combat은 진행도 (i+1)/(n+1) 지점 ± 길옆 오프셋.
- `hashDialogue(dialogue):number`(FNV-1a 32bit), `mulberry32(seed):()=>number`.
- 키워드 표(최소): 테마 숲/forest→forest, 초원/들판/grass→grassland, 사막/desert→desert, 설원/눈/snow→snow; 밀도 빽빽/울창/우거→tree↑, 황량/트인→tree↓, 바위/돌/암석→rock↑, 풀→grass↑; 길 구불/굽이→winding, 곧/직선→straight, 넓→wide, 좁→narrow; 전투 `(\d+)\s*(번|회|개|차례)` 또는 한/두/세/네/다섯 + (전투|싸움|몬스터), `전투 없이|평화`→0, `많이|여러`→3, 기본 1; 강도 격렬/위험/보스→high, 가벼/약→low; 크기 큰/넓은 전투→large, 작은→small.

- [ ] Step 1: 테스트: "어둡고 나무가 빽빽한 숲, 전투 3번" → theme forest, combatCount 3, density.tree ≥0.7; "전투 없이 탐험" → 0; 빈 배열 → forest/1; 같은 dialogue 2회 → deepEqual 후보; seed 다르면 경로 점 다름; 후보를 `validatePCGParams`에 넣으면 combat 수 보존.
- [ ] Step 2: FAIL 확인 → 구현 → PASS → commit `feat: 규칙 기반 dialogue 해석기`.

### Task 4: LLM 클라이언트

**Files:**
- Create: `llmClient.js`
- Test: `test/llmClient.test.js`
- Modify: `.env.example`

**Interfaces (Produces):**
- `generateZoneCandidate({dialogue, context, seed, combatCount, mode?, apiUrl?, timeoutMs?, fetchImpl?}):Promise<{candidate, source:'vllm'|'rule', llm_error?:string}>`
- `ZONE_SCHEMA`(LLM 레포 SCHEMA 동일 + theme enum 4종), `buildMessages({dialogue, context}):[{role,content}]`.
- 모드 결정: `mode ?? process.env.LLM_MODE ?? 'auto'`; auto는 `apiUrl ?? LLM_API_URL`이 있을 때만 vllm 시도.

- [ ] Step 1: 테스트(fetchImpl 주입): 정상 JSON 응답 → source vllm; 500 응답 → rule 폴백 + llm_error; AbortError(타임아웃 50ms, fetch가 영원히 pending) → rule 폴백, 소요 < 500ms; mode rule → fetch 미호출.
- [ ] Step 2: 구현 → PASS → `.env.example`에 LLM_* 4키 추가 → commit `feat: vLLM 클라이언트 + 규칙 폴백`.

### Task 5: 세션 장애 허용 + app 배선

**Files:**
- Modify: `sessionManager.js`, `app.js`
- Test: `test/api.test.js`

**Interfaces:**
- `sessionManager`: 기존 3함수 유지 + `isAvailable():boolean`, `shutdown()`. 연결 실패 시 함수들은 throw 없이 `updateHistory`→false, `getFullContext`→`{previous_background:'(세션 저장소 미연결)', recent_chat:''}`. 에러 로그 1회.
- `app.js`: `createApp()` export, `require.main === module`일 때만 listen. `/generate-zone` 흐름: body 검증(400) → userId 기본 `unreal-test` → dialogue 적재(best-effort) → `pcg_json` 있으면 그것, 없으면 `generateZoneCandidate` → `validatePCGParams(candidate,{combatCount, debug: req.query.debug==='1'})` → 응답. 콘솔에 `[generate-zone] source=<vllm|rule|pcg_json> corrections=<n> score=<q>` 1줄. `/api/world/generate`, `/api/chat/send` 유지.

- [ ] Step 1: `test/api.test.js`(REDIS_URL을 `redis://127.0.0.1:1`로 두고 기동): `/health`; `/generate-zone` 빈 body → 200 + 목 파서 통과; dialogue "사막, 전투 2번" → theme desert, combat 2; `combat_count:3` → combat 3; `?debug=1` → `validation_report` 존재, 없으면 부재; `dialogue:"x"` → 400; `pcg_json` 깨진 객체 → 200.
- [ ] Step 2: 구현 → PASS → commit `feat(app): dialogue→후보→validator 배선, Redis 장애 허용`.

### Task 6: 언리얼 목 파서 + npm test

**Files:**
- Create: `unreal_parser_mock.js`
- Modify: `package.json`(`"test": "node --test test/"`), `test/api.test.js`(목 파서 사용)

**Interfaces (Produces):** `applyZoneJsonString(jsonString):{ok:boolean, reason?:string, data?}` — PCGZoneController.cpp 10/27 버전 규칙: theme 문자열 필수, base_environment 객체 필수, main_path 객체+normalized_points ≥2(숫자 x,y 없는 점은 skip) 필수, areas 배열 ≥1 필수, 밀도/좌표 [0,1], radius [0.01,0.30], path_width [100,1500] 클램프, area_type 미인식→combat.

- [ ] Step 1: `test/unrealMock.test.js`: 정상 통과, 평평한 구버전 스키마 → ok false, 점 1개 → false, areas [] → false.
- [ ] Step 2: 구현 → 전체 `npm test` PASS → commit.

### Task 7: 테스트 결과서 자동 생성 (md + docx)

**Files:**
- Create: `scripts/test-report.js`, `scripts/build-docx.py`, `docs/TEST_RESULTS_1차.md`(생성물), `docs/TEST_RESULTS_1차.docx`(생성물)
- Modify: `package.json`(`"test:report": "node scripts/test-report.js"`)

- [ ] Step 1: `scripts/test-report.js`: `node --test --test-reporter=tap test/` 자식 프로세스 실행 → TAP 파싱(ok/not ok, 이름, duration) → 표(ID, 확인 항목, 결과, 소요) + 요약(총/통과/실패, 실행 일시, Node 버전, 커밋 해시) + fuzz 통계 → md 저장 → `python scripts/build-docx.py <md> <docx>` 호출(실패해도 md는 남김).
- [ ] Step 2: `scripts/build-docx.py`: python-docx로 제목/표/문단 변환(명세서 docx와 같은 "프로젝트 개요 → 환경 → 결과표 → 결함/비고" 순).
- [ ] Step 3: `npm run test:report` 실행, 두 파일 생성 확인 → commit `test: 결과서 자동 생성 스크립트 + 1차 결과서`.

### Task 8: 문서 갱신

**Files:**
- Modify: `README.md`(validator v3 표, dialogue 파이프라인, LLM_* 환경변수, 언리얼 10/27 변경 반영, 테스트/결과서 실행법), Create: `docs/PRESENTATION_NOTES_2026-10-29.md`(발표용: 이번 학기 백엔드 변경점, 시연 시나리오 3개 curl, 수치)

- [ ] Step 1: 작성 → `npm test` 재확인 → commit `docs: README v3 + 발표 노트`.
