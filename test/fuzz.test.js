/**
 * test/fuzz.test.js
 * 무작위로 망가진 입력 2,000건(seed 0~1999)을 validator에 넣어
 *  - 예외 0건
 *  - 불변식(test/helpers/invariants.js) 100% 통과
 *  - 멱등성(validate∘validate = validate) 100%
 * 를 확인한다. LLM 테스트 명세 LLM-T06(무작위 입력 강건성)의 백엔드 판 (BE-FUZZ).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePCGParams } = require("../validator");
const { checkInvariants } = require("./helpers/invariants");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREA_TYPES = ["spawn", "combat", "goal", "danger", "boss_zone", "start_zone", "", null, 7];
const THEMES = ["forest", "grassland", "desert", "snow", "lava", "", null, 3];

function junkNumber(rnd, lo, hi) {
  const r = rnd();
  if (r < 0.08) return null;
  if (r < 0.14) return String((lo + rnd() * (hi - lo)).toFixed(3));
  if (r < 0.18) return "abc";
  if (r < 0.2) return NaN;
  if (r < 0.22) return undefined;
  return lo + rnd() * (hi - lo);
}

function randomInput(seed) {
  const rnd = mulberry32(seed);
  const nPts = Math.floor(rnd() * 16);        // 0~15
  const nAreas = Math.floor(rnd() * 11);      // 0~10
  const points = [];
  for (let i = 0; i < nPts; i++) {
    if (rnd() < 0.05) points.push(null);
    else points.push({ x: junkNumber(rnd, -0.5, 1.5), y: junkNumber(rnd, -0.5, 1.5) });
  }
  const areas = [];
  for (let i = 0; i < nAreas; i++) {
    if (rnd() < 0.05) { areas.push("junk"); continue; }
    areas.push({
      area_type: AREA_TYPES[Math.floor(rnd() * AREA_TYPES.length)],
      normalized_center: rnd() < 0.08 ? null : { x: junkNumber(rnd, -0.5, 1.5), y: junkNumber(rnd, -0.5, 1.5) },
      normalized_radius: junkNumber(rnd, -0.2, 0.6),
      detail_density: junkNumber(rnd, -1, 2),
    });
  }
  const nested = rnd() < 0.6;
  const dens = { tree_density: junkNumber(rnd, -1, 3), rock_density: junkNumber(rnd, -1, 3), grass_density: junkNumber(rnd, -1, 3) };
  const path = { path_type: "main", path_width: junkNumber(rnd, -100, 3000), normalized_points: rnd() < 0.05 ? "x" : points };
  const base = { theme: THEMES[Math.floor(rnd() * THEMES.length)], areas: rnd() < 0.05 ? "nope" : areas };
  if (rnd() < 0.3) base.combat_count = Math.floor(rnd() * 8) - 1;
  return nested ? { ...base, base_environment: dens, main_path: path } : { ...base, ...dens, ...path };
}

test("BE-FUZZ 무작위 입력 2000건: 예외 0, 불변식 100%, 멱등성 100%", () => {
  const N = 2000;
  const failures = [];
  let totalCorrections = 0, totalHard = 0, scoreSum = 0;
  for (let seed = 0; seed < N; seed++) {
    const input = randomInput(seed);
    let out;
    try {
      out = validatePCGParams(input, { debug: true });
    } catch (e) {
      failures.push({ seed, error: e.stack });
      continue;
    }
    const { validation_report: rep, ...zone } = out;
    totalCorrections += rep.correction_count; totalHard += rep.hard_violations_before; scoreSum += rep.quality_score;
    const problems = checkInvariants(zone);
    if (problems.length) failures.push({ seed, problems });
    const again = validatePCGParams(zone);
    try { assert.deepEqual(again, zone); } catch (e) { failures.push({ seed, idempotency: e.message.slice(0, 400) }); }
  }
  // 결과서용 통계 (TAP diagnostic로 출력)
  console.log(`# fuzz-stats seeds=${N} failures=${failures.length} avg_corrections=${(totalCorrections / N).toFixed(2)} avg_hard=${(totalHard / N).toFixed(2)} avg_score=${(scoreSum / N).toFixed(3)}`);
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length}/${N} 실패`);
});
