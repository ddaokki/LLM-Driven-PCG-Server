# branch_paths 보정 + 언리얼 11-18 동기화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 들어온 `branch_paths`를 언리얼 11-18 파서가 항상 읽을 수 있게 보정(또는 버림)하고, 목 파서·불변식·결과서·문서를 그 기준으로 맞춘다.

**Architecture:** `validator.js`에 `fixBranches(input, mainPts, rep)` 단계를 추가하고 메인 경로 기하 루프를 재사용한다. `unreal_parser_mock.js`에 11-18 branch 파싱 규칙을 그대로 옮긴다. 출력 최상위 `branch_paths`는 유효 분기가 있을 때만 붙는다.

**Tech Stack:** Node 22, `node:test`, `assert/strict`. 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-11-19-branch-paths-and-unreal-1118-sync-design.md`

## Global Constraints

- 분기 최대 2개, 분기당 점 2~12, path_width [100,1500] 기본 400, 분기 최소 길이 0.1, shortcut 양 끝 진행도 차 ≥ 0.06.
- path_type은 `branch`/`shortcut`만 출력. 좌표 [0,1], 가장자리 여백 0.03.
- 유효 분기 0개면 출력에 `branch_paths` 키 없음.
- validator에 `Math.random` 금지, 멱등 유지. 새 npm 의존성 금지.
- 규칙 해석기(`dialogueInterpreter.js`), `llmClient.js` 스키마/프롬프트는 수정하지 않는다.

## Review Focus

1. `branch_paths`가 배열이 아님(객체/문자열/null) → 키 없이 정상 존, 리포트에 기록. (Task 2 V3-21)
2. 분기 점 좌표가 문자열 숫자·음수·1 초과 → 클램프 후 언리얼 파서 통과(언리얼은 범위 밖이면 전체 실패). (Task 2 V3-20)
3. 분기 3개 이상 → 앞 2개만. (Task 2 V3-22)
4. shortcut 끝점이 시작점보다 메인 경로상 뒤쪽 → 순서 뒤집어 진행 방향 일치. (Task 2 V3-23)
5. 보정 결과를 다시 넣어도 동일(멱등) + 무작위 branch 입력 fuzz. (Task 3)

---

### Task 1: 언리얼 목 파서 11-18 동기화

**Files:**
- Modify: `unreal_parser_mock.js` (헤더 주석 기준 커밋 `80a1ee1` 2026-11-18, branch 파싱 추가)
- Test: `test/unrealMock.test.js`

**Interfaces:**
- Produces: `applyZoneJsonString(json)` → 성공 시 `data.paths = [main, ...branches]`, 각 branch `{path_type, path_width, normalized_points}`; 실패 시 `{ok:false, reason}`.

- [ ] **Step 1: 실패 테스트** — `UM-B1` 언리얼 샘플(`LoadSampleZoneJson`의 desert + shortcut 1개)이 `ok` 이고 `paths.length === 2`, `paths[1].path_type === "shortcut"`, `path_width === 480`. `UM-B2` `branch_paths: {}` → `ok:false`. `UM-B3` 점 1개 branch → `ok:false`. `UM-B4` 점 x=1.2 → `ok:false` (클램프 아님). `UM-B5` 점 x가 문자열 → `ok:false`. `UM-B6` path_width `"wide"`(숫자 아님) → 통과, 기본 폭 유지.
- [ ] **Step 2:** `npm test` → UM-B1~B6 FAIL.
- [ ] **Step 3:** 구현. 규칙(cpp `ApplyZoneJsonString` branch 블록 그대로): `branch_paths` 키가 있으면 배열 필수, 원소 객체 필수, path_type 기본 branch, path_width 숫자면 비유한 → 실패 / 유한 → [100,1500] 클램프, points 배열 길이 ≥ 2, 점마다 객체·숫자 x/y·유한·[0,1] 아니면 실패.
- [ ] **Step 4:** `npm test` 전체 PASS.
- [ ] **Step 5:** commit `test(mock): 언리얼 11-18(80a1ee1) branch_paths 파싱 규칙 반영`

### Task 2: validator `branch_paths` 보정

**Files:**
- Modify: `validator.js` (`CONFIG.branch`, `normalizeInput`, `fixPath` 기하 루프 분리, `fixBranches`, `validateWithReport` 출력)
- Test: `test/validator.test.js`

**Interfaces:**
- Consumes: `lib/geometry.js` `projectToPolyline(pt, pts) → {point, t, ...}`, `mergeClosePoints`, `untangle`, `relaxSharpTurns`, `turnAngleDeg`, `findSelfIntersections`, `polylineLength`.
- Produces: `CONFIG.branch = { max: 2, width_def: 400, min_length: 0.1, min_t_gap: 0.06 }`; 출력 `zone.branch_paths?: [{path_type, path_width, normalized_points}]`.

- [ ] **Step 1: 실패 테스트**
  - `V3-19` 언리얼 샘플 입력 → `zone.branch_paths.length === 1`, type `shortcut`, 첫 점·끝 점이 `main_path` 위(`projectToPolyline` 거리 ≤ 1e-4), 목 파서 `ok`.
  - `V3-20` branch 점 `[{x:"-0.2",y:0.5},{x:1.4,y:0.3}]` → 모든 점 [0.03,0.97], 목 파서 `ok`.
  - `V3-21` `branch_paths` = `{}` / `"x"` / `null` → 키 없음, 예외 없음; `{}`·`"x"`는 리포트에 `branch` 항목.
  - `V3-22` 유효 분기 3개 → 출력 2개.
  - `V3-23` shortcut의 끝점이 메인 진행도상 시작점보다 앞 → 출력 첫 점 t < 끝 점 t.
  - `V3-24` 점 1개 / 길이 < 0.1 / 객체 아님 → 그 분기만 버림, 리포트에 이유.
  - `V3-25` branch 없는 입력 → `"branch_paths" in zone === false` (기존 응답 불변).
  - `V3-26` `validate(validate(x))` deep-equal (V3-19 입력).
- [ ] **Step 2:** `npm test` → V3-19~26 FAIL.
- [ ] **Step 3:** 구현.
  - `fixPath`의 "여백 → 병합 → 2-opt → 급회전" 루프를 `cleanPolyline(pts, rep, label, {pushEnds})`로 분리, 메인은 `pushEnds: true`(spawn-goal), 분기는 false. 메인 동작·리포트 문구 불변.
  - `fixBranches`: 정리 → 첫 점 스냅(이미 거리 ≤ TOL이면 유지) → shortcut은 끝점 스냅 + t 역순이면 reverse → 스냅 후 다시 병합 → 버림 조건 검사 → 반올림.
- [ ] **Step 4:** `npm test` 전체 PASS (기존 94 + 신규).
- [ ] **Step 5:** commit `feat(validator): branch_paths 보정(메인 경로 스냅, shortcut 방향, 무효 분기 제거)`

### Task 3: 불변식 + fuzz

**Files:**
- Modify: `test/helpers/invariants.js`, `test/fuzz.test.js`

- [ ] **Step 1:** invariants에 branch 검사 추가: 있으면 배열 1~2개, type ∈ {branch, shortcut}, 폭 [100,1500], 점 2~12·[0,1], 자기교차 0, 첫 점 메인 경로 위, shortcut 끝점 메인 경로 위·t 증가.
- [ ] **Step 2:** fuzz 생성기가 seed의 1/3에 무작위 `branch_paths`(0~4개, 좌표 -0.2~1.2, 문자열/누락 섞음)를 넣도록 확장. 모든 출력이 목 파서 `ok` + 불변식 + 멱등.
- [ ] **Step 3:** `npm test` 전체 PASS. 실패 seed 있으면 Task 2로 돌아가 수정.
- [ ] **Step 4:** commit `test: branch_paths 불변식 및 fuzz`

### Task 4: 결과서·README 갱신

**Files:**
- Modify: `README.md` (계약 표에 `branch_paths`, 언리얼 11-18 변경 절, 알려진 제약 갱신: path_width는 언리얼 적용됨), `scripts/test-report.js` (언리얼 계약 기준 문구 11-18)
- Regenerate: `docs/TEST_RESULTS_1차.md`, `.docx` (`npm run test:report`; docx는 python-docx 있을 때)

- [ ] **Step 1:** 수정 후 `npm run test:report` → 총 건수·전체 통과 확인.
- [ ] **Step 2:** commit `docs: README·결과서 11-18 언리얼 계약 반영`

### Task 5 (코드 외): 노트 문서·발표자료

- 노트 문서(claude.ai artifact `3pJ1jWw5nfMbvKtbdEnQxi`) 백엔드 섹션만: 구현 보고서 3차 내역, 테스트 명세서 BE-T02·BE-T12 정정 + 신규 항목, 1차 테스트 결과서 탭에 백엔드 절, 연동 노트 낡은 항목.
- Canva: 브라우저 패널(사용자 로그인)로 백엔드 슬라이드 갱신, 불가 시 교체 문구 + PNG.
