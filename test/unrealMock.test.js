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
