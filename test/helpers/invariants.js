/**
 * test/helpers/invariants.js
 * validator 출력이 항상 만족해야 하는 불변식. 단위 테스트와 fuzz 테스트가 공유한다.
 * 하나라도 깨지면 이유 문자열 배열로 돌려준다(빈 배열 = 전부 통과).
 */
const g = require("../../lib/geometry");
const { VALID_THEMES } = require("../../lib/themes");

const TOL = 1e-4;

function checkInvariants(zone, cfg = {}) {
  const minGap = cfg.minGap ?? 0.06;
  const maxAreas = cfg.maxAreas ?? 8;
  const maxPoints = cfg.maxPoints ?? 12;
  const maxSum = cfg.maxSum ?? 1.8;
  const minSpawnGoal = cfg.minSpawnGoal ?? 0.45;
  const combatGapMax = cfg.combatGapMax ?? 0.12;
  const problems = [];
  const push = (ok, msg) => { if (!ok) problems.push(msg); };

  push(zone && typeof zone === "object", "zone is not object");
  if (!zone || typeof zone !== "object") return problems;

  push(VALID_THEMES.includes(zone.theme), `theme invalid: ${zone.theme}`);

  const be = zone.base_environment || {};
  const ds = [be.tree_density, be.rock_density, be.grass_density];
  for (const d of ds) push(typeof d === "number" && d >= 0 && d <= 1, `density out of range: ${d}`);
  push(ds.reduce((a, b) => a + (b || 0), 0) <= maxSum + TOL, `density sum > ${maxSum}`);

  const mp = zone.main_path || {};
  push(mp.path_type === "main", "path_type !== main");
  push(typeof mp.path_width === "number" && mp.path_width >= 100 && mp.path_width <= 1500, `path_width: ${mp.path_width}`);
  const pts = Array.isArray(mp.normalized_points) ? mp.normalized_points : [];
  push(pts.length >= 2 && pts.length <= maxPoints, `point count: ${pts.length}`);
  for (const p of pts) push(p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `point out of range: ${JSON.stringify(p)}`);
  push(g.findSelfIntersections(pts).length === 0, "path self-intersects");
  if (pts.length >= 2) push(g.dist(pts[0], pts[pts.length - 1]) >= minSpawnGoal - TOL, "spawn-goal too close");

  const areas = Array.isArray(zone.areas) ? zone.areas : [];
  push(areas.length >= 2 && areas.length <= maxAreas, `area count: ${areas.length}`);
  const spawns = areas.filter((a) => a.area_type === "spawn");
  const goals = areas.filter((a) => a.area_type === "goal");
  push(spawns.length === 1, `spawn count ${spawns.length}`);
  push(goals.length === 1, `goal count ${goals.length}`);
  if (areas.length) {
    push(areas[0].area_type === "spawn", "areas[0] not spawn");
    push(areas[areas.length - 1].area_type === "goal", "areas[last] not goal");
  }
  for (const a of areas) {
    push(["spawn", "combat", "goal", "danger"].includes(a.area_type), `area_type ${a.area_type}`);
    const c = a.normalized_center || {};
    push(c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1, `center out of range ${JSON.stringify(c)}`);
    push(a.normalized_radius >= 0.01 - TOL && a.normalized_radius <= 0.3 + TOL, `radius ${a.normalized_radius}`);
    push(a.detail_density >= 0 && a.detail_density <= 1, `detail_density ${a.detail_density}`);
  }
  if (pts.length >= 2 && spawns.length === 1 && goals.length === 1) {
    push(g.dist(spawns[0].normalized_center, pts[0]) <= TOL, "spawn not at path start");
    push(g.dist(goals[0].normalized_center, pts[pts.length - 1]) <= TOL, "goal not at path end");
    // 진행도 단조 증가 + 최소 간격
    const ts = areas.map((a) => g.projectToPolyline(a.normalized_center, pts).t);
    for (let i = 1; i < ts.length; i++) {
      push(ts[i] - ts[i - 1] >= minGap - TOL, `progress gap ${i}: ${(ts[i] - ts[i - 1]).toFixed(4)}`);
    }
    // combat/danger 가장자리~경로 거리
    for (const a of areas) {
      if (a.area_type === "combat" || a.area_type === "danger") {
        const pr = g.projectToPolyline(a.normalized_center, pts);
        push(pr.dist - a.normalized_radius <= combatGapMax + TOL, `combat too far from path: ${pr.dist.toFixed(3)}`);
      }
    }
  }
  // 2D 겹침 없음(접촉 허용)
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const d = g.dist(areas[i].normalized_center, areas[j].normalized_center);
      push(d >= areas[i].normalized_radius + areas[j].normalized_radius - TOL, `areas ${i},${j} overlap d=${d.toFixed(4)}`);
    }
  }
  // 난이도 곡선: combat detail_density 단조 비감소
  const combats = areas.filter((a) => a.area_type === "combat");
  for (let i = 1; i < combats.length; i++) {
    push(combats[i].detail_density >= combats[i - 1].detail_density - TOL, "difficulty not monotone");
  }
  return problems;
}

module.exports = { checkInvariants };
