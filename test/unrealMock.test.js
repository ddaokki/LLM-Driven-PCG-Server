const test = require("node:test");
const assert = require("node:assert/strict");
const { applyZoneJsonString } = require("../unreal_parser_mock");
const { validatePCGParams } = require("../validator");

const good = () => validatePCGParams(null);

test("UE-MOCK-01 validator 기본 존은 파싱 성공", () => {
  const r = applyZoneJsonString(JSON.stringify(good()));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.data.areas.length, 3);
  assert.equal(r.data.main_path.normalized_points.length, 3);
});

test("UE-MOCK-02 평평한 구버전 스키마(base_environment 없음) → 실패", () => {
  const z = good();
  const flat = { theme: z.theme, tree_density: 0.4, rock_density: 0.3, grass_density: 0.7, main_path: z.main_path, areas: z.areas };
  const r = applyZoneJsonString(JSON.stringify(flat));
  assert.equal(r.ok, false);
  assert.match(r.reason, /base_environment/);
});

test("UE-MOCK-03 경로 점 1개 → 실패", () => {
  const z = good();
  z.main_path.normalized_points = [{ x: 0.5, y: 0.5 }];
  assert.equal(applyZoneJsonString(JSON.stringify(z)).ok, false);
});

test("UE-MOCK-04 숫자 아닌 점은 건너뛰고 남은 점이 2개 미만이면 실패", () => {
  const z = good();
  z.main_path.normalized_points = [{ x: "a", y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.9 }];
  const r = applyZoneJsonString(JSON.stringify(z));
  assert.equal(r.ok, false);
});

test("UE-MOCK-05 areas 빈 배열 → 실패, theme 누락 → 실패, JSON 문법 오류 → 실패", () => {
  const z1 = good(); z1.areas = [];
  assert.equal(applyZoneJsonString(JSON.stringify(z1)).ok, false);
  const z2 = good(); delete z2.theme;
  assert.equal(applyZoneJsonString(JSON.stringify(z2)).ok, false);
  assert.equal(applyZoneJsonString("{ not json").ok, false);
});

test("UE-MOCK-06 클램프/기본값: 밀도 0~1, radius 0.01~0.30, path_width 100~1500, 모르는 area_type → combat", () => {
  const z = good();
  z.base_environment.tree_density = 5;
  z.main_path.path_width = 9999;
  z.areas[1].normalized_radius = 0.9;
  z.areas[1].area_type = "boss_zone";
  const r = applyZoneJsonString(JSON.stringify(z));
  assert.equal(r.ok, true);
  assert.equal(r.data.base_environment.tree_density, 1);
  assert.equal(r.data.main_path.path_width, 1500);
  assert.equal(r.data.areas[1].normalized_radius, 0.3);
  assert.equal(r.data.areas[1].area_type, "combat");
});

test("UE-MOCK-07 봉투(success/dataForUnreal)로 감싼 응답 → 실패 (언리얼은 최상위를 그대로 읽음)", () => {
  const r = applyZoneJsonString(JSON.stringify({ success: true, dataForUnreal: good() }));
  assert.equal(r.ok, false);
});

test("UE-MOCK-08 combat 개수 = 예상 전투 구역 수(ExpectedCombatAreaCount) 산출", () => {
  const r = applyZoneJsonString(JSON.stringify(validatePCGParams(null, { combatCount: 3 })));
  assert.equal(r.ok, true);
  assert.equal(r.data.expected_combat_area_count, 3);
});

// ---- 11-18(80a1ee1) branch_paths 규칙
// 언리얼 LoadSampleZoneJson()의 샘플 그대로 (desert, danger 1, combat 2, shortcut 1)
const sample = () => JSON.parse(JSON.stringify(require("./fixtures/unreal_sample_1118.json")));
const withBranch = (b) => { const z = sample(); z.branch_paths = b; return JSON.stringify(z); };

test("UM-B1 언리얼 11-18 샘플(shortcut 1개) → 파싱 성공, paths = [main, shortcut]", () => {
  const r = applyZoneJsonString(JSON.stringify(sample()));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.data.paths.length, 2);
  assert.equal(r.data.paths[1].path_type, "shortcut");
  assert.equal(r.data.paths[1].path_width, 480);
  assert.equal(r.data.paths[1].normalized_points.length, 5);
});

test("UM-B2 branch_paths가 배열이 아님 → 존 전체 실패", () => {
  assert.equal(applyZoneJsonString(withBranch({})).ok, false);
  assert.equal(applyZoneJsonString(withBranch(null)).ok, false);
});

test("UM-B3 branch 원소가 객체 아님 / 점 1개 → 존 전체 실패", () => {
  assert.equal(applyZoneJsonString(withBranch([1])).ok, false);
  assert.equal(applyZoneJsonString(withBranch([{ normalized_points: [{ x: 0.5, y: 0.5 }] }])).ok, false);
});

test("UM-B4 branch 좌표가 [0,1] 밖 → 클램프 없이 존 전체 실패", () => {
  assert.equal(applyZoneJsonString(withBranch([{ normalized_points: [{ x: 0.5, y: 0.5 }, { x: 1.2, y: 0.5 }] }])).ok, false);
});

test("UM-B5 branch 좌표가 숫자 아님 → 존 전체 실패", () => {
  assert.equal(applyZoneJsonString(withBranch([{ normalized_points: [{ x: 0.5, y: 0.5 }, { x: "0.7", y: 0.5 }] }])).ok, false);
});

test("UM-B6 branch path_width가 숫자 아님 → 무시하고 기본 폭, 빈 배열 → 성공(main만)", () => {
  const r = applyZoneJsonString(withBranch([{ path_width: "wide", normalized_points: [{ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 }] }]));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.data.paths[1].path_type, "branch");
  assert.equal(typeof r.data.paths[1].path_width, "number");
  const r2 = applyZoneJsonString(withBranch([]));
  assert.equal(r2.ok, true);
  assert.equal(r2.data.paths.length, 1);
});
