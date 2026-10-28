const test = require("node:test");
const assert = require("node:assert/strict");
const { THEMES, VALID_THEMES, inferTheme, getProfile } = require("../lib/themes");
const { CorrectionReport } = require("../lib/report");

test("VALID_THEMES는 4종", () => {
  assert.deepEqual([...VALID_THEMES].sort(), ["desert", "forest", "grassland", "snow"]);
  for (const t of VALID_THEMES) {
    for (const k of ["tree", "rock", "grass"]) {
      const p = THEMES[t][k];
      assert.ok(p.min <= p.def && p.def <= p.max, `${t}.${k}`);
    }
  }
});

test("inferTheme: 바위 많고 풀/나무 없음 → desert", () => {
  assert.equal(inferTheme({ tree: 0.05, rock: 0.7, grass: 0.1 }), "desert");
});

test("inferTheme: 풀 많고 나무 적음 → grassland", () => {
  assert.equal(inferTheme({ tree: 0.1, rock: 0.1, grass: 0.9 }), "grassland");
});

test("inferTheme: forest 기본값 근처 → forest", () => {
  assert.equal(inferTheme({ tree: 0.45, rock: 0.3, grass: 0.65 }), "forest");
});

test("inferTheme: 입력 없음 → forest", () => {
  assert.equal(inferTheme({}), "forest");
});

test("getProfile: 모르는 테마는 forest 프로필", () => {
  assert.deepEqual(getProfile("lava"), THEMES.forest);
});

test("CorrectionReport: 점수/카운트 계산", () => {
  const r = new CorrectionReport();
  assert.equal(r.toJSON().quality_score, 1);
  r.add("density", "tree_density", 2.0, 0.8, "clamp");
  r.hard("path", "self-intersection");
  const j = r.toJSON();
  assert.equal(j.correction_count, 1);
  assert.equal(j.hard_violations_before, 1);
  assert.ok(Math.abs(j.quality_score - (1 - 0.03 - 0.1)) < 1e-9);
  assert.equal(j.corrections[0].step, "density");
  assert.equal(j.corrections[0].before, 2.0);
});

test("CorrectionReport: 점수는 0 미만으로 내려가지 않음", () => {
  const r = new CorrectionReport();
  for (let i = 0; i < 50; i++) r.hard("x", "y");
  assert.equal(r.toJSON().quality_score, 0);
});
