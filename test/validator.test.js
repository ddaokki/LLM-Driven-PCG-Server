const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePCGParams, validateWithReport, normalizeInput, CONFIG } = require("../validator");
const { checkInvariants } = require("./helpers/invariants");
const g = require("../lib/geometry");

const area = (type, x, y, r = 0.05, dd = 0.5) => ({
  area_type: type, normalized_center: { x, y }, normalized_radius: r, detail_density: dd,
});
const pts = (...xy) => xy.map(([x, y]) => ({ x, y }));
const combats = (zone) => zone.areas.filter((a) => a.area_type === "combat");
const expectInvariants = (zone) => assert.deepEqual(checkInvariants(zone), []);

test("BE-T01 밀도 합 정규화 + 테마별 범위 클램프", () => {
  const z = validatePCGParams({ theme: "forest", tree_density: 2.0, rock_density: 1.0, grass_density: 1.0 });
  const { tree_density: t, rock_density: r, grass_density: gr } = z.base_environment;
  assert.ok(t >= 0.2 && t <= 0.8);
  assert.ok(r >= 0.1 && r <= 0.6);
  assert.ok(gr >= 0.3 && gr <= 0.9);
  assert.ok(t + r + gr <= 1.8 + 1e-9);
  expectInvariants(z);
});

test("BE-T02 범위 초과 단일값(0.95)은 테마 상한으로 보정되고 리포트에 남음", () => {
  const { zone, report } = validateWithReport({ theme: "forest", base_environment: { tree_density: 0.95 } });
  assert.ok(zone.base_environment.tree_density < 0.95);
  assert.equal(zone.base_environment.tree_density, 0.8);
  assert.ok(report.corrections.some((c) => c.target === "tree_density" && c.before === 0.95));
});

test("BE-T03 area_type 화이트리스트: 구버전 문자열은 combat으로", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.05, 0.5], [0.95, 0.5]) },
    areas: [
      area("spawn", 0.05, 0.5), area("start_zone", 0.3, 0.5), area("boss_zone", 0.7, 0.5),
      area("danger", 0.5, 0.5), area("goal", 0.95, 0.5),
    ],
  });
  const types = z.areas.map((a) => a.area_type);
  assert.equal(types.filter((t) => t === "combat").length, 2);
  assert.equal(types.filter((t) => t === "danger").length, 1);
  assert.equal(z.areas.length, 5);
  expectInvariants(z);
});

test("BE-T04 spawn/goal 없으면 자동 추가되어 경로 양끝에 위치", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.1, 0.2], [0.5, 0.5], [0.9, 0.8]) },
    areas: [area("combat", 0.5, 0.5)],
  });
  assert.equal(z.areas[0].area_type, "spawn");
  assert.equal(z.areas[z.areas.length - 1].area_type, "goal");
  assert.deepEqual(z.areas[0].normalized_center, z.main_path.normalized_points[0]);
  expectInvariants(z);
});

test("BE-T05 응답 스키마: base_environment/main_path 중첩, 최상위 평평한 필드 없음", () => {
  const z = validatePCGParams(null);
  assert.ok(z.base_environment && z.main_path);
  assert.equal(z.tree_density, undefined);
  assert.equal(z.normalized_points, undefined);
  assert.equal(z.validation_report, undefined);
  expectInvariants(z);
});

test("normalizeInput: 평평한 구버전과 중첩 신버전 모두 같은 형태로", () => {
  const flat = normalizeInput({ tree_density: "0.5", rock_density: null, path_width: 300, normalized_points: pts([0, 0], [1, 1]), areas: [] });
  const nested = normalizeInput({ base_environment: { tree_density: 0.5 }, main_path: { path_width: 300, normalized_points: pts([0, 0], [1, 1]) }, areas: [] });
  assert.equal(flat.tree, 0.5);
  assert.equal(flat.rock, null);
  assert.equal(flat.pathWidth, 300);
  assert.deepEqual(flat.points, nested.points);
  assert.equal(nested.tree, 0.5);
});

test("BE-T11 combat_count 0/1/3 (입력 없음)", () => {
  for (const n of [0, 1, 3]) {
    const z = validatePCGParams(null, { combatCount: n });
    assert.equal(combats(z).length, n, `combat_count=${n}`);
    assert.equal(z.areas[0].area_type, "spawn");
    assert.equal(z.areas[z.areas.length - 1].area_type, "goal");
    expectInvariants(z);
  }
});

test("BE-T12 뒤섞인 순서 → 진행도 정렬, 과밀집 → 최소 간격 0.06", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.05, 0.5], [0.95, 0.5]) },
    areas: [area("goal", 0.95, 0.5), area("combat", 0.6, 0.5), area("combat", 0.601, 0.5), area("spawn", 0.05, 0.5)],
  });
  assert.deepEqual(z.areas.map((a) => a.area_type), ["spawn", "combat", "combat", "goal"]);
  const ts = z.areas.map((a) => g.projectToPolyline(a.normalized_center, z.main_path.normalized_points).t);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 0.06 - 1e-4, `gap ${i}=${ts[i] - ts[i - 1]}`);
  expectInvariants(z);
});

test("V3-01 8자 경로 자기교차 해소 + hard violation 기록", () => {
  const { zone, report } = validateWithReport({
    main_path: { normalized_points: pts([0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]) },
    areas: [area("spawn", 0.1, 0.1), area("goal", 0.1, 0.9)],
  });
  assert.equal(g.findSelfIntersections(zone.main_path.normalized_points).length, 0);
  assert.ok(report.hard_violations_before >= 1);
  assert.ok(report.corrections.some((c) => c.step === "path"));
  expectInvariants(zone);
});

test("V3-02 spawn-goal 거리 0.2 → 0.45 이상", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.4, 0.5], [0.5, 0.55], [0.6, 0.5]) },
    areas: [area("spawn", 0.4, 0.5), area("goal", 0.6, 0.5)],
  });
  const p = z.main_path.normalized_points;
  assert.ok(g.dist(p[0], p[p.length - 1]) >= 0.45 - 1e-4);
  expectInvariants(z);
});

test("V3-03 spawn/goal 중심이 경로 양끝에서 떨어져 있으면 스냅", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.1, 0.5], [0.5, 0.3], [0.9, 0.5]) },
    areas: [area("spawn", 0.2, 0.7), area("goal", 0.8, 0.2)],
  });
  assert.deepEqual(z.areas[0].normalized_center, z.main_path.normalized_points[0]);
  assert.deepEqual(z.areas[1].normalized_center, z.main_path.normalized_points[2]);
  expectInvariants(z);
});

test("V3-04 경로에서 먼 combat은 가장자리 거리 ≤ 0.12로 끌어옴", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.05, 0.9], [0.95, 0.9]) },
    areas: [area("spawn", 0.05, 0.9), area("combat", 0.5, 0.1, 0.05), area("goal", 0.95, 0.9)],
  });
  const c = combats(z)[0];
  const pr = g.projectToPolyline(c.normalized_center, z.main_path.normalized_points);
  assert.ok(pr.dist - c.normalized_radius <= 0.12 + 1e-4, `edge dist=${pr.dist - c.normalized_radius}`);
  assert.ok(Math.abs(c.normalized_center.x - 0.5) < 0.05, "경로 진행 위치(x)는 유지");
  expectInvariants(z);
});

test("V3-05 겹친 combat 두 개 → 2D 분리, 둘 다 살아남음", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.05, 0.5], [0.95, 0.5]) },
    areas: [area("spawn", 0.05, 0.5), area("combat", 0.5, 0.45, 0.1), area("combat", 0.52, 0.55, 0.1), area("goal", 0.95, 0.5)],
  });
  const cs = combats(z);
  assert.equal(cs.length, 2);
  const d = g.dist(cs[0].normalized_center, cs[1].normalized_center);
  assert.ok(d >= cs[0].normalized_radius + cs[1].normalized_radius - 1e-4);
  expectInvariants(z);
});

test("V3-06 난이도 곡선: combat detail_density가 진행 방향으로 단조 비감소, 값 집합 유지", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.05, 0.5], [0.95, 0.5]) },
    areas: [
      area("spawn", 0.05, 0.5), area("combat", 0.3, 0.5, 0.05, 0.9), area("combat", 0.5, 0.5, 0.05, 0.3),
      area("combat", 0.7, 0.5, 0.05, 0.6), area("goal", 0.95, 0.5),
    ],
  });
  assert.deepEqual(combats(z).map((c) => c.detail_density), [0.3, 0.6, 0.9]);
  expectInvariants(z);
});

test("V3-07 테마 4종 통과, 미지정이면 밀도로 추정, 모르는 값은 forest", () => {
  for (const t of ["forest", "grassland", "desert", "snow"]) {
    assert.equal(validatePCGParams({ theme: t }).theme, t);
  }
  assert.equal(validatePCGParams({ base_environment: { tree_density: 0.05, rock_density: 0.7, grass_density: 0.1 } }).theme, "desert");
  assert.equal(validatePCGParams({ theme: "lava" }).theme, "forest");
  assert.equal(validatePCGParams({ theme: "lava" }).base_environment.tree_density, CONFIG.themes.forest.tree.def);
});

test("V3-07b 테마 밀도 프로필: desert는 나무 ≤ 0.15, grassland는 풀 ≥ 0.6", () => {
  assert.ok(validatePCGParams({ theme: "desert", base_environment: { tree_density: 0.8 } }).base_environment.tree_density <= 0.15);
  assert.ok(validatePCGParams({ theme: "grassland", base_environment: { grass_density: 0.1 } }).base_environment.grass_density >= 0.6);
});

test("V3-08 멱등성: validate(validate(x)) deepEqual validate(x)", () => {
  const inputs = [
    null,
    { theme: "snow", tree_density: 2, areas: [area("combat", 0.5, 0.5, 0.2), area("combat", 0.52, 0.5, 0.2), area("boss", 0.9, 0.9)] },
    { main_path: { normalized_points: pts([0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]) }, areas: [area("goal", 0.3, 0.3), area("spawn", 0.7, 0.7), area("combat", 0.1, 0.9, 0.3)] },
    { main_path: { normalized_points: pts([0.5, 0.05], [0.52, 0.3], [0.48, 0.6], [0.5, 0.95]) }, areas: [area("spawn", 0.5, 0.05), area("combat", 0.9, 0.5), area("danger", 0.1, 0.5), area("goal", 0.5, 0.95)] },
  ];
  for (const x of inputs) {
    const once = validatePCGParams(x);
    const twice = validatePCGParams(once);
    assert.deepEqual(twice, once, JSON.stringify(x));
  }
});

test("V3-09 위→아래 진행 경로: x가 아니라 진행도 순으로 정렬", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.5, 0.05], [0.5, 0.95]) },
    areas: [
      area("spawn", 0.5, 0.05),
      area("combat", 0.2, 0.7),   // x 작지만 경로상 뒤
      area("combat", 0.8, 0.3),   // x 크지만 경로상 앞
      area("goal", 0.5, 0.95),
    ],
  });
  const cs = combats(z);
  assert.ok(cs[0].normalized_center.y < cs[1].normalized_center.y, "진행도(y) 오름차순");
  expectInvariants(z);
});

test("V3-10 길이 0 경로(점 전부 동일) → 기본 경로로 대체, 예외 없음", () => {
  const z = validatePCGParams({ main_path: { normalized_points: pts([0.5, 0.5], [0.5, 0.5], [0.5, 0.5]) } });
  assert.deepEqual(z.main_path.normalized_points, CONFIG.default_path_points);
  expectInvariants(z);
});

test("V3-11 spawn 3개/goal 0개 → spawn 1개만 유지, 나머지 combat 강등, goal 추가", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.05, 0.5], [0.95, 0.5]) },
    areas: [area("spawn", 0.05, 0.5), area("spawn", 0.4, 0.5), area("spawn", 0.6, 0.5)],
  });
  assert.equal(z.areas.filter((a) => a.area_type === "spawn").length, 1);
  assert.equal(z.areas.filter((a) => a.area_type === "goal").length, 1);
  assert.equal(combats(z).length, 2);
  expectInvariants(z);
});

test("V3-12 debug 옵션일 때만 validation_report 포함", () => {
  const d = validatePCGParams({ tree_density: 5 }, { debug: true });
  assert.ok(d.validation_report);
  assert.ok(typeof d.validation_report.quality_score === "number");
  assert.ok(Array.isArray(d.validation_report.corrections));
  assert.equal(validatePCGParams({ tree_density: 5 }).validation_report, undefined);
});

test("V3-13 구역 9개 이상이면 8개로 제한(spawn/goal 유지)", () => {
  const many = [area("spawn", 0.05, 0.5)];
  for (let i = 0; i < 10; i++) many.push(area("combat", 0.1 + i * 0.08, 0.5, 0.02));
  many.push(area("goal", 0.95, 0.5));
  const z = validatePCGParams({ main_path: { normalized_points: pts([0.05, 0.5], [0.95, 0.5]) }, areas: many });
  assert.equal(z.areas.length, 8);
  expectInvariants(z);
});

test("V3-14 combatCount 옵션이 입력과 함께 오면 그 개수로 맞춤(부족분 추가/초과분 제거)", () => {
  const base = { main_path: { normalized_points: pts([0.05, 0.5], [0.95, 0.5]) }, areas: [area("spawn", 0.05, 0.5), area("combat", 0.5, 0.5), area("goal", 0.95, 0.5)] };
  assert.equal(combats(validatePCGParams(base, { combatCount: 3 })).length, 3);
  assert.equal(combats(validatePCGParams(base, { combatCount: 0 })).length, 0);
  expectInvariants(validatePCGParams(base, { combatCount: 3 }));
});

test("V3-15 급회전(헤어핀) 완화: 출력 경로에 25° 미만 꼭짓점 없음", () => {
  const z = validatePCGParams({
    main_path: { normalized_points: pts([0.05, 0.5], [0.6, 0.5], [0.1, 0.52], [0.95, 0.5]) },
  });
  const p = z.main_path.normalized_points;
  for (let i = 1; i < p.length - 1; i++) assert.ok(g.turnAngleDeg(p[i - 1], p[i], p[i + 1]) >= 25 - 1e-6);
  expectInvariants(z);
});

test("타입 오염: 문자열/NaN/null/배열 아님 → 예외 없이 유효한 존", () => {
  const z = validatePCGParams({
    theme: 42, tree_density: "abc", rock_density: NaN, grass_density: null, path_width: "넓게",
    main_path: { normalized_points: "x" }, areas: "nope",
  });
  expectInvariants(z);
  const z2 = validatePCGParams({ areas: [null, 1, "s", { area_type: "combat", normalized_center: "x" }] });
  expectInvariants(z2);
});
