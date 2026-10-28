#!/usr/bin/env node
/**
 * scripts/test-report.js
 * 테스트 스위트를 파일별로 실행(TAP)하고 결과를 "1차 테스트 결과서"로 정리한다.
 *   - docs/TEST_RESULTS_1차.md   (항상 생성)
 *   - docs/TEST_RESULTS_1차.docx (python-docx 사용, python 없으면 건너뜀)
 * 사용: npm run test:report
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEST_DIR = path.join(ROOT, "test");
const OUT_MD = path.join(ROOT, "docs", "TEST_RESULTS_1차.md");
const OUT_DOCX = path.join(ROOT, "docs", "TEST_RESULTS_1차.docx");

// 테스트 파일 → 결과서 섹션 이름/대응 명세
const SECTIONS = [
  ["validator.test.js", "기능 테스트 — validator v3 자동 보정 (명세 4.1 BE-T01~T05, T11, T12 + 3차 신규 V3-xx)"],
  ["fuzz.test.js", "강건성 테스트 — 무작위 입력 2,000건 (LLM 명세 LLM-T06 대응, BE-FUZZ)"],
  ["geometry.test.js", "단위 테스트 — 기하 유틸 (lib/geometry.js)"],
  ["themes.test.js", "단위 테스트 — 테마 프로필/보정 리포트 (lib/themes.js, lib/report.js)"],
  ["interpreter.test.js", "기능 테스트 — 규칙 기반 dialogue 해석기 (RULE-xx)"],
  ["llmClient.test.js", "기능 테스트 — LLM 클라이언트/폴백 (LLM-xx, 명세 '후속 테스트: 호출 실패·시간 초과 시 기본 Zone')"],
  ["unrealMock.test.js", "계약 테스트 — 언리얼 ApplyZoneJsonString 목 파서 (명세 BE-T10, UE-MOCK-xx)"],
  ["api.test.js", "통합/비기능 테스트 — HTTP 엔드포인트, Redis 장애 허용 (명세 4.2 BE-T06~T09, T11 + 신규 T13~T17)"],
  ["apiVllm.test.js", "통합 테스트 — vLLM 경로(가짜 vLLM 서버)에서 combat_count 강제 (BE-T18)"],
  ["session.test.js", "통합 테스트 — Redis 세션 슬라이딩 윈도우 (SESSION-xx, Redis 있을 때만)"],
];

function runFile(file) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(TEST_DIR, file)], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const tests = [];
  const lines = out.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(ok|not ok) (\d+) - (.*?)(?: # (SKIP|TODO).*)?$/);
    if (m) {
      current = { status: m[4] === "SKIP" ? "skip" : m[1] === "ok" ? "pass" : "fail", name: m[3].trim(), duration: null, error: null };
      tests.push(current);
      continue;
    }
    if (current) {
      const d = line.match(/^\s+duration_ms:\s*([\d.]+)/);
      if (d && current.duration === null) current.duration = parseFloat(d[1]);
      const e = line.match(/^\s+error:\s*(.*)$/);
      if (e && !current.error) current.error = e[1].replace(/^['|-]+\s*/, "").slice(0, 200);
    }
  }
  const stats = out.match(/fuzz-stats (.*)$/m);
  return { file, tests, fuzzStats: stats ? stats[1].trim() : null, exitCode: r.status };
}

function gitInfo() {
  const g = (args) => { const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : "n/a"; };
  return { commit: g(["rev-parse", "--short", "HEAD"]), branch: g(["rev-parse", "--abbrev-ref", "HEAD"]), date: g(["log", "-1", "--format=%cd", "--date=short"]) };
}

function main() {
  const started = new Date();
  const results = SECTIONS.map(([file]) => runFile(file));
  const all = results.flatMap((r) => r.tests);
  const pass = all.filter((t) => t.status === "pass").length;
  const fail = all.filter((t) => t.status === "fail").length;
  const skip = all.filter((t) => t.status === "skip").length;
  const git = gitInfo();
  const fuzz = results.find((r) => r.fuzzStats);
  const fmt = (n) => (n === null || n === undefined ? "-" : n < 1000 ? `${n.toFixed(1)} ms` : `${(n / 1000).toFixed(2)} s`);
  const mark = (s) => (s === "pass" ? "PASS" : s === "fail" ? "FAIL" : "SKIP");

  const md = [];
  md.push("# 1차 테스트 결과서 — 백엔드 (LLM-Driven PCG Server)");
  md.push("");
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${pad(started.getHours())}:${pad(started.getMinutes())} (로컬)`;
  md.push(`생성: ${stamp} · 대상 커밋: \`${git.commit}\` (${git.branch}, ${git.date}) · Node ${process.version} · ${process.platform}`);
  md.push("");
  md.push("## 1. 개요");
  md.push("");
  md.push("프로젝트: LLM-Driven PCG — 대화 맥락에 반응하는 playable한 적응형 게임 환경 구축 (건국대학교 졸업프로젝트 3201)");
  md.push("");
  md.push("담당: 202111306 서정민(백엔드). 테스트 명세서(2026-09-28) 백엔드 항목 BE-T01~T12를 자동화 테스트로 옮기고, 3차 고도화(validator v3, dialogue 파이프라인, Redis 장애 허용)에 대한 항목을 추가했다. 모든 항목은 `npm test`로 재실행 가능하며 이 문서는 `npm run test:report`로 자동 생성된다.");
  md.push("");
  md.push("## 2. 테스트 환경");
  md.push("");
  md.push("| 구분 | 값 |");
  md.push("|---|---|");
  md.push(`| 실행 환경 | Node.js ${process.version}, ${process.platform} ${process.arch} |`);
  md.push("| 러너 | Node 내장 `node:test` + `assert/strict` (추가 의존성 없음) |");
  md.push(`| 대상 코드 | https://github.com/ddaokki/LLM-Driven-PCG-Server — 커밋 \`${git.commit}\` |`);
  md.push("| 언리얼 계약 기준 | Choibw/LLMDrivenPlayablePCG `PCGZoneController.cpp` 2026-10-27 커밋 (Area 액터 자동 생성, 전 combat 클리어 시 goal 활성화) |");
  md.push("| 입력 방식 | `validatePCGParams()` 직접 호출 / 임시 포트 HTTP 서버에 fetch |");
  md.push("| 확인 수단 | assert, 불변식 검사기(`test/helpers/invariants.js`), 언리얼 목 파서(`unreal_parser_mock.js`) |");
  md.push("| Redis | API 테스트는 의도적으로 미연결(포트 1) 상태에서 실행(BE-T09). 세션 테스트는 로컬 Redis 있을 때만 실행 |");
  md.push("| LLM | vLLM 미연결(LLM_API_URL 비움) → 규칙 기반 해석기 경로. vLLM 경로는 fetch 주입 목으로 검증 |");
  md.push("");
  md.push("## 3. 결과 요약");
  md.push("");
  md.push(`| 총 항목 | 통과 | 실패 | 건너뜀 | 판정 |`);
  md.push(`|---|---|---|---|---|`);
  md.push(`| ${all.length} | ${pass} | ${fail} | ${skip} | **${fail === 0 ? "전체 통과" : "실패 있음"}** |`);
  md.push("");
  if (fuzz) {
    const kv = Object.fromEntries(fuzz.fuzzStats.split(/\s+/).map((p) => p.split("=")));
    md.push("무작위 입력 강건성(BE-FUZZ):");
    md.push("");
    md.push("| 입력 수 | 예외/불변식/멱등성 실패 | 입력당 평균 보정 수 | 입력당 평균 필수규칙 위반(보정 전) | 평균 품질 점수(보정 전 기준) |");
    md.push("|---|---|---|---|---|");
    md.push(`| ${kv.seeds} | ${kv.failures} | ${kv.avg_corrections} | ${kv.avg_hard} | ${kv.avg_score} |`);
    md.push("");
    md.push("> 무작위 입력은 좌표 −0.5~1.5, 밀도 −1~3, 문자열/null/NaN 혼입 등 의도적으로 망가진 데이터라 보정 수·위반 수가 크고 품질 점수가 낮은 것이 정상이다. 핵심은 실패 0건: 어떤 입력이 와도 언리얼이 읽을 수 있는 유효한 Zone이 나오고, 그 결과를 다시 넣어도 바뀌지 않는다.");
    md.push("");
  }
  md.push("## 4. 세부 결과");
  md.push("");
  results.forEach((r, i) => {
    md.push(`### 4.${i + 1} ${SECTIONS[i][1]}`);
    md.push("");
    md.push(`파일: \`test/${r.file}\``);
    md.push("");
    if (!r.tests.length) { md.push("(실행된 항목 없음)"); md.push(""); return; }
    md.push("| ID / 확인 항목 | 결과 | 소요 |");
    md.push("|---|---|---|");
    for (const t of r.tests) md.push(`| ${t.name.replace(/\|/g, "\\|")} | ${mark(t.status)}${t.error ? ` — ${t.error.replace(/\|/g, "\\|")}` : ""} | ${fmt(t.duration)} |`);
    md.push("");
  });
  md.push("## 5. 명세서 대비 변경/비고");
  md.push("");
  md.push("- BE-T02(soft clamp): 1차의 tanh 소프트 클램프는 제거했다. 테마별 하드 클램프에 항상 지배되어 실제 효과가 없었고, 멱등성(보정 결과를 다시 넣어도 동일)과 수학적으로 양립할 수 없기 때문이다. 판정 기준을 \"상한 초과값이 테마 상한으로 보정되고 리포트에 기록되면 통과\"로 재해석했다.");
  md.push("- BE-T10(언리얼 파서 시뮬레이션): 명세서에 언급만 되어 있던 `unreal_parser_mock.js`를 실제로 작성했다(10/27 언리얼 커밋 기준). API 테스트의 모든 응답이 이 목 파서를 통과한다.");
  md.push("- BE-T12: 구역 정렬 기준을 x좌표에서 경로 진행도(호길이)로 바꿨다. 위→아래, 오른쪽→왼쪽으로 진행하는 경로에서도 \"배열 순서 = 경로상 순서\"가 성립한다(V3-09).");
  md.push("- 신규: 경로 기하(자기교차·급회전·spawn-goal 거리), 경로-구역 결합(spawn/goal 스냅, combat 경로 근접), 2D 겹침, 테마 4종, 난이도 곡선, 멱등성, dialogue 해석, LLM 폴백, Redis 장애 허용 항목을 추가했다.");
  md.push("- 미수행: 실제 vLLM 서버 대상 생성 품질(LLM 파트 서버 미기동), 언리얼 에디터 실연동(언리얼 파트 일정). 두 항목은 2차 테스트 결과서(최종발표)에서 수행한다.");
  md.push("");
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");
  console.log(`md  → ${path.relative(ROOT, OUT_MD)} (${all.length} tests, pass ${pass}, fail ${fail}, skip ${skip})`);

  const py = spawnSync("python", ["-I", path.join(__dirname, "build-docx.py"), OUT_MD, OUT_DOCX], { cwd: ROOT, encoding: "utf8" });
  if (py.status === 0) console.log(`docx → ${path.relative(ROOT, OUT_DOCX)}`);
  else console.warn(`docx 생성 건너뜀 (python/python-docx 필요): ${(py.stderr || py.stdout || "").trim().split("\n").pop()}`);
  process.exit(fail ? 1 : 0);
}

main();
