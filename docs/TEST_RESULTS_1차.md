# 1차 테스트 결과서 — 백엔드 (LLM-Driven PCG Server)

생성: 2026-10-28 11:02 (로컬) · 대상 커밋: `d6e8f1c` (feat/validator-v3, 2026-10-28) · Node v22.21.0 · win32

## 1. 개요

프로젝트: LLM-Driven PCG — 대화 맥락에 반응하는 playable한 적응형 게임 환경 구축 (건국대학교 졸업프로젝트 3201)

담당: 202111306 서정민(백엔드). 테스트 명세서(2026-09-28) 백엔드 항목 BE-T01~T12를 자동화 테스트로 옮기고, 3차 고도화(validator v3, dialogue 파이프라인, Redis 장애 허용)에 대한 항목을 추가했다. 모든 항목은 `npm test`로 재실행 가능하며 이 문서는 `npm run test:report`로 자동 생성된다.

## 2. 테스트 환경

| 구분 | 값 |
|---|---|
| 실행 환경 | Node.js v22.21.0, win32 x64 |
| 러너 | Node 내장 `node:test` + `assert/strict` (추가 의존성 없음) |
| 대상 코드 | https://github.com/ddaokki/LLM-Driven-PCG-Server — 커밋 `d6e8f1c` |
| 언리얼 계약 기준 | Choibw/LLMDrivenPlayablePCG `PCGZoneController.cpp` 2026-10-27 커밋 (Area 액터 자동 생성, 전 combat 클리어 시 goal 활성화) |
| 입력 방식 | `validatePCGParams()` 직접 호출 / 임시 포트 HTTP 서버에 fetch |
| 확인 수단 | assert, 불변식 검사기(`test/helpers/invariants.js`), 언리얼 목 파서(`unreal_parser_mock.js`) |
| Redis | API 테스트는 의도적으로 미연결(포트 1) 상태에서 실행(BE-T09). 세션 테스트는 로컬 Redis 있을 때만 실행 |
| LLM | vLLM 미연결(LLM_API_URL 비움) → 규칙 기반 해석기 경로. vLLM 경로는 fetch 주입 목으로 검증 |

## 3. 결과 요약

| 총 항목 | 통과 | 실패 | 건너뜀 | 판정 |
|---|---|---|---|---|
| 98 | 98 | 0 | 0 | **전체 통과** |

무작위 입력 강건성(BE-FUZZ):

| 입력 수 | 예외/불변식/멱등성 실패 | 입력당 평균 보정 수 | 입력당 평균 필수규칙 위반(보정 전) | 평균 품질 점수(보정 전 기준) |
|---|---|---|---|---|
| 2000 | 0 | 19.87 | 3.04 | 0.163 |

> 무작위 입력은 좌표 −0.5~1.5, 밀도 −1~3, 문자열/null/NaN 혼입 등 의도적으로 망가진 데이터라 보정 수·위반 수가 크고 품질 점수가 낮은 것이 정상이다. 핵심은 실패 0건: 어떤 입력이 와도 언리얼이 읽을 수 있는 유효한 Zone이 나오고, 그 결과를 다시 넣어도 바뀌지 않는다.

## 4. 세부 결과

### 4.1 기능 테스트 — validator v3 자동 보정 (명세 4.1 BE-T01~T05, T11, T12 + 3차 신규 V3-xx)

파일: `test/validator.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| BE-T01 밀도 합 정규화 + 테마별 범위 클램프 | PASS | 3.7 ms |
| BE-T02 범위 초과 단일값(0.95)은 테마 상한으로 보정되고 리포트에 남음 | PASS | 0.3 ms |
| BE-T03 area_type 화이트리스트: 구버전 문자열은 combat으로 | PASS | 1.1 ms |
| BE-T04 spawn/goal 없으면 자동 추가되어 경로 양끝에 위치 | PASS | 1.4 ms |
| BE-T05 응답 스키마: base_environment/main_path 중첩, 최상위 평평한 필드 없음 | PASS | 0.5 ms |
| normalizeInput: 평평한 구버전과 중첩 신버전 모두 같은 형태로 | PASS | 0.2 ms |
| BE-T11 combat_count 0/1/3 (입력 없음) | PASS | 0.8 ms |
| BE-T12 뒤섞인 순서 → 진행도 정렬, 과밀집 → 최소 간격 0.06 | PASS | 0.4 ms |
| V3-01 8자 경로 자기교차 해소 + hard violation 기록 | PASS | 0.6 ms |
| V3-02 spawn-goal 거리 0.2 → 0.45 이상 | PASS | 0.4 ms |
| V3-03 spawn/goal 중심이 경로 양끝에서 떨어져 있으면 스냅 | PASS | 0.2 ms |
| V3-04 경로에서 먼 combat은 가장자리 거리 ≤ 0.12로 끌어옴 | PASS | 0.2 ms |
| V3-05 겹친 combat 두 개 → 2D 분리, 둘 다 살아남음 | PASS | 0.6 ms |
| V3-06 난이도 곡선: combat detail_density가 진행 방향으로 단조 비감소, 값 집합 유지 | PASS | 0.3 ms |
| V3-07 테마 4종 통과, 미지정이면 밀도로 추정, 모르는 값은 forest | PASS | 0.3 ms |
| V3-07b 테마 밀도 프로필: desert는 나무 ≤ 0.15, grassland는 풀 ≥ 0.6 | PASS | 0.1 ms |
| V3-08 멱등성: validate(validate(x)) deepEqual validate(x) | PASS | 0.7 ms |
| V3-09 위→아래 진행 경로: x가 아니라 진행도 순으로 정렬 | PASS | 0.2 ms |
| V3-10 길이 0 경로(점 전부 동일) → 기본 경로로 대체, 예외 없음 | PASS | 0.1 ms |
| V3-11 spawn 3개/goal 0개 → spawn 1개만 유지, 나머지 combat 강등, goal 추가 | PASS | 0.2 ms |
| V3-12 debug 옵션일 때만 validation_report 포함 | PASS | 0.1 ms |
| V3-13 구역 9개 이상이면 8개로 제한(spawn/goal 유지) | PASS | 0.3 ms |
| V3-14 combatCount 옵션이 입력과 함께 오면 그 개수로 맞춤(부족분 추가/초과분 제거) | PASS | 0.4 ms |
| V3-15 급회전(헤어핀) 완화: 출력 경로에 25° 미만 꼭짓점 없음 | PASS | 0.2 ms |
| 타입 오염: 문자열/NaN/null/배열 아님 → 예외 없이 유효한 존 | PASS | 0.2 ms |
| V3-16 처음에 겹쳐 있던 큰 combat들은 간격 확보 후 반지름이 과도하게 줄지 않음(최종 위치 기준 축소) | PASS | 0.2 ms |
| V3-17 (리뷰 Important-1) 레이아웃 루프가 상한에 걸려도 최종 반지름 패스로 겹침 0 | PASS | 0.8 ms |
| V3-18 (리뷰 Important-3) areas 80,000개 + combat_count 0 → 1초 이내 | PASS | 15.5 ms |

### 4.2 강건성 테스트 — 무작위 입력 2,000건 (LLM 명세 LLM-T06 대응, BE-FUZZ)

파일: `test/fuzz.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| BE-FUZZ 무작위 입력 2000건: 예외 0, 불변식 100%, 멱등성 100% | PASS | 455.5 ms |

### 4.3 단위 테스트 — 기하 유틸 (lib/geometry.js)

파일: `test/geometry.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| segmentsIntersect: X자 교차는 true | PASS | 1.0 ms |
| segmentsIntersect: 끝점만 공유하는 인접 구간은 false | PASS | 0.1 ms |
| segmentsIntersect: 평행 비접촉은 false | PASS | 0.1 ms |
| projectToPolyline: 경로 중간 위 점은 t≈0.5, dist≈0 | PASS | 0.8 ms |
| projectToPolyline: 경로 옆 점은 수직 거리와 투영점 반환 | PASS | 0.5 ms |
| pointAtProgress: t=0 첫 점, t=1 마지막 점, t=0.5 중간 | PASS | 0.1 ms |
| turnAngleDeg: 직진 180, 직각 90, 헤어핀 ~0 | PASS | 0.2 ms |
| mergeClosePoints: eps 이내 연속점 병합, 양 끝은 유지 | PASS | 0.2 ms |
| findSelfIntersections / untangle: 8자 경로 → 교차 0 | PASS | 0.4 ms |
| relaxSharpTurns: 25° 미만 꼭짓점 완화 후 각도 증가 | PASS | 0.4 ms |
| pushEndpointsApart: 양 끝 거리 < minDist → ≥ minDist, 범위 [0,1] 유지 | PASS | 0.3 ms |
| pushEndpointsApart: 이미 충분히 멀면 그대로 | PASS | 0.1 ms |
| separateCircles: 겹친 원들이 분리되고 locked 원은 움직이지 않음 | PASS | 0.2 ms |
| cumulativeLengths / polylineLength | PASS | 0.1 ms |

### 4.4 단위 테스트 — 테마 프로필/보정 리포트 (lib/themes.js, lib/report.js)

파일: `test/themes.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| VALID_THEMES는 4종 | PASS | 1.3 ms |
| inferTheme: 바위 많고 풀/나무 없음 → desert | PASS | 0.2 ms |
| inferTheme: 풀 많고 나무 적음 → grassland | PASS | 0.1 ms |
| inferTheme: forest 기본값 근처 → forest | PASS | 0.1 ms |
| inferTheme: 입력 없음 → forest | PASS | 0.1 ms |
| getProfile: 모르는 테마는 forest 프로필 | PASS | 0.1 ms |
| CorrectionReport: 점수/카운트 계산 | PASS | 0.2 ms |
| CorrectionReport: 점수는 0 미만으로 내려가지 않음 | PASS | 0.1 ms |

### 4.5 기능 테스트 — 규칙 기반 dialogue 해석기 (RULE-xx)

파일: `test/interpreter.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| RULE-01 '나무가 빽빽한 숲, 전투 3번' → forest, combat 3, tree 성향 높음 | PASS | 2.9 ms |
| RULE-02 '전투 없이 탐험' → combat 0 | PASS | 0.6 ms |
| RULE-03 한글 수사: '세 번 싸우고' → 3, '두 개의 전투' → 2 | PASS | 0.4 ms |
| RULE-04 테마 키워드: 사막/초원/설원, 영어도 | PASS | 0.5 ms |
| RULE-05 길 모양/폭, 강도, 크기 | PASS | 0.8 ms |
| RULE-06 빈 dialogue / 비배열 / 텍스트 없음 → 기본 의도(forest, combat 1) | PASS | 0.1 ms |
| RULE-07 npc 질문의 키워드는 player 답변보다 약하게 반영 | PASS | 0.2 ms |
| RULE-08 hashDialogue 결정적, 내용 다르면 다름 | PASS | 0.2 ms |
| RULE-09 mulberry32: 같은 seed 같은 수열, [0,1) | PASS | 0.3 ms |
| RULE-10 buildCandidateZone: 같은 의도+seed → deepEqual, seed 다르면 경로 다름 | PASS | 1.3 ms |
| RULE-11 후보 → validator 통과 후 combat 수/테마 보존, 불변식 만족 (seed 0~199) | PASS | 60.6 ms |
| RULE-12 후보 자체가 validator를 거의 안 거치게 생성됨(평균 보정 수 작음) | PASS | 3.4 ms |
| RULE-13 '격렬한 큰 전투 두 번' → 2 ('격렬한'의 '한'을 수사로 오인하지 않음) | PASS | 0.4 ms |
| RULE-14 (리뷰 Important-4) 전투와 무관한 숫자/단어는 전투 수로 세지 않음 | PASS | 0.4 ms |
| RULE-15 (리뷰 Important-4) 영어 키워드는 단어 경계, '눈'은 눈앞/눈치에 안 걸림 | PASS | 0.3 ms |

### 4.6 기능 테스트 — LLM 클라이언트/폴백 (LLM-xx, 명세 '후속 테스트: 호출 실패·시간 초과 시 기본 Zone')

파일: `test/llmClient.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| LLM-01 vllm 정상 응답 → source=vllm, 후보는 LLM JSON | PASS | 21.9 ms |
| LLM-02 500 응답 → rule 폴백 + llm_error | PASS | 3.0 ms |
| LLM-03 타임아웃(50ms, fetch 무응답) → rule 폴백, 500ms 이내 | PASS | 54.8 ms |
| LLM-04 잘못된 JSON 본문 → rule 폴백 | PASS | 1.0 ms |
| LLM-05 mode=rule → fetch 호출 없음 | PASS | 0.4 ms |
| LLM-06 mode=auto + apiUrl 없음 → rule, fetch 호출 없음 | PASS | 0.3 ms |
| LLM-07 seed/combatCount 옵션이 rule 후보에 반영 | PASS | 1.0 ms |
| LLM-08 buildMessages: system에 규칙, user에 대화+이전 배경 | PASS | 0.2 ms |
| LLM-09 ZONE_SCHEMA: theme enum 4종, areas enum 3종, combat_count 포함 | PASS | 0.3 ms |

### 4.7 계약 테스트 — 언리얼 ApplyZoneJsonString 목 파서 (명세 BE-T10, UE-MOCK-xx)

파일: `test/unrealMock.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| UE-MOCK-01 validator 기본 존은 파싱 성공 | PASS | 4.3 ms |
| UE-MOCK-02 평평한 구버전 스키마(base_environment 없음) → 실패 | PASS | 0.5 ms |
| UE-MOCK-03 경로 점 1개 → 실패 | PASS | 0.4 ms |
| UE-MOCK-04 숫자 아닌 점은 건너뛰고 남은 점이 2개 미만이면 실패 | PASS | 0.5 ms |
| UE-MOCK-05 areas 빈 배열 → 실패, theme 누락 → 실패, JSON 문법 오류 → 실패 | PASS | 0.6 ms |
| UE-MOCK-06 클램프/기본값: 밀도 0~1, radius 0.01~0.30, path_width 100~1500, 모르는 area_type → combat | PASS | 0.7 ms |
| UE-MOCK-07 봉투(success/dataForUnreal)로 감싼 응답 → 실패 (언리얼은 최상위를 그대로 읽음) | PASS | 0.2 ms |
| UE-MOCK-08 combat 개수 = 예상 전투 구역 수(ExpectedCombatAreaCount) 산출 | PASS | 0.5 ms |

### 4.8 통합/비기능 테스트 — HTTP 엔드포인트, Redis 장애 허용 (명세 4.2 BE-T06~T09, T11 + 신규 T13~T17)

파일: `test/api.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| BE-T06 GET /health → {status:running} | PASS | 35.1 ms |
| BE-T07 POST /generate-zone 빈 body → 200, 봉투 없는 Zone JSON, 언리얼 목 파서 통과 | PASS | 1.05 s |
| BE-T08 pcg_json(BD-03: 구버전 area_type + 문자열 밀도) → 보정 반영 | PASS | 3.9 ms |
| BE-T11 combat_count 0/3 → combat 개수 가변 | PASS | 7.8 ms |
| BE-T13 dialogue '사막, 전투 2번' → theme desert, combat 2 (규칙 기반 해석) | PASS | 8.0 ms |
| BE-T14 같은 dialogue 두 번 → 같은 Zone (재현성), seed 주면 다른 Zone | PASS | 9.9 ms |
| BE-T15 ?debug=1 → validation_report 포함(source/seed 포함), 없으면 부재 | PASS | 7.8 ms |
| BE-T16 잘못된 요청: dialogue가 배열 아님 → 400, JSON 문법 오류 → 400 | PASS | 4.5 ms |
| BE-T17 pcg_json이 깨진 값(문자열/배열/타입 오염) → 200 + 유효한 Zone | PASS | 6.9 ms |
| BE-T09 Redis 미연결 상태에서 /api/chat/send → 503, /api/world/generate → 200 보정 결과 | PASS | 515.7 ms |

### 4.9 통합 테스트 — vLLM 경로(가짜 vLLM 서버)에서 combat_count 강제 (BE-T18)

파일: `test/apiVllm.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| BE-T18 vllm 후보(combat 1) + combat_count 3 → combat 3, source=vllm | PASS | 1.10 s |

### 4.10 통합 테스트 — Redis 세션 슬라이딩 윈도우 (SESSION-xx, Redis 있을 때만)

파일: `test/session.test.js`

| ID / 확인 항목 | 결과 | 소요 |
|---|---|---|
| SESSION-01 노이즈 발화('네', '오케이...')는 적재되지 않음 | PASS | 12.5 ms |
| SESSION-02 윈도우 10개 초과 시 핵심 키워드 발화는 보존 | PASS | 7.5 ms |
| SESSION-03 processLLMResponse: 보정 결과 + updated_background 저장 | PASS | 3.6 ms |
| SESSION-04 isAvailable()는 연결 상태를 반영 | PASS | 0.3 ms |

## 5. 명세서 대비 변경/비고

- BE-T02(soft clamp): 1차의 tanh 소프트 클램프는 제거했다. 테마별 하드 클램프에 항상 지배되어 실제 효과가 없었고, 멱등성(보정 결과를 다시 넣어도 동일)과 수학적으로 양립할 수 없기 때문이다. 판정 기준을 "상한 초과값이 테마 상한으로 보정되고 리포트에 기록되면 통과"로 재해석했다.
- BE-T10(언리얼 파서 시뮬레이션): 명세서에 언급만 되어 있던 `unreal_parser_mock.js`를 실제로 작성했다(10/27 언리얼 커밋 기준). API 테스트의 모든 응답이 이 목 파서를 통과한다.
- BE-T12: 구역 정렬 기준을 x좌표에서 경로 진행도(호길이)로 바꿨다. 위→아래, 오른쪽→왼쪽으로 진행하는 경로에서도 "배열 순서 = 경로상 순서"가 성립한다(V3-09).
- 신규: 경로 기하(자기교차·급회전·spawn-goal 거리), 경로-구역 결합(spawn/goal 스냅, combat 경로 근접), 2D 겹침, 테마 4종, 난이도 곡선, 멱등성, dialogue 해석, LLM 폴백, Redis 장애 허용 항목을 추가했다.
- 미수행: 실제 vLLM 서버 대상 생성 품질(LLM 파트 서버 미기동), 언리얼 에디터 실연동(언리얼 파트 일정). 두 항목은 2차 테스트 결과서(최종발표)에서 수행한다.
