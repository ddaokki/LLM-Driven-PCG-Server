const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("../lib/geometry");

test("segmentsIntersect: X자 교차는 true", () => {
  assert.equal(g.segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }), true);
});

test("segmentsIntersect: 끝점만 공유하는 인접 구간은 false", () => {
  assert.equal(g.segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }), false);
});

test("segmentsIntersect: 평행 비접촉은 false", () => {
  assert.equal(g.segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }), false);
});

test("projectToPolyline: 경로 중간 위 점은 t≈0.5, dist≈0", () => {
  const pts = [{ x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }];
  const r = g.projectToPolyline({ x: 0.5, y: 0.5 }, pts);
  assert.ok(Math.abs(r.t - 0.5) < 1e-9, `t=${r.t}`);
  assert.ok(r.dist < 1e-9);
});

test("projectToPolyline: 경로 옆 점은 수직 거리와 투영점 반환", () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  const r = g.projectToPolyline({ x: 0.25, y: 0.3 }, pts);
  assert.ok(Math.abs(r.t - 0.25) < 1e-9);
  assert.ok(Math.abs(r.dist - 0.3) < 1e-9);
  assert.deepEqual(r.point, { x: 0.25, y: 0 });
});

test("pointAtProgress: t=0 첫 점, t=1 마지막 점, t=0.5 중간", () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  assert.deepEqual(g.pointAtProgress(pts, 0), { x: 0, y: 0 });
  assert.deepEqual(g.pointAtProgress(pts, 1), { x: 1, y: 1 });
  assert.deepEqual(g.pointAtProgress(pts, 0.5), { x: 1, y: 0 });
});

test("turnAngleDeg: 직진 180, 직각 90, 헤어핀 ~0", () => {
  assert.ok(Math.abs(g.turnAngleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }) - 180) < 1e-9);
  assert.ok(Math.abs(g.turnAngleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }) - 90) < 1e-9);
  assert.ok(g.turnAngleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.01, y: 0.001 }) < 10);
});

test("mergeClosePoints: eps 이내 연속점 병합, 양 끝은 유지", () => {
  const pts = [{ x: 0, y: 0 }, { x: 0.005, y: 0 }, { x: 0.5, y: 0 }, { x: 0.51, y: 0 }, { x: 1, y: 0 }];
  const out = g.mergeClosePoints(pts, 0.02);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { x: 0, y: 0 });
  assert.deepEqual(out[out.length - 1], { x: 1, y: 0 });
});

test("findSelfIntersections / untangle: 8자 경로 → 교차 0", () => {
  const eight = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }];
  assert.equal(g.findSelfIntersections(eight).length, 1);
  const r = g.untangle(eight);
  assert.equal(g.findSelfIntersections(r.points).length, 0);
  assert.ok(r.flips >= 1);
  assert.deepEqual(r.points[0], eight[0], "시작점 고정");
  assert.deepEqual(r.points[r.points.length - 1], eight[eight.length - 1], "끝점 고정");
});

test("relaxSharpTurns: 25° 미만 꼭짓점 완화 후 각도 증가", () => {
  const pts = [{ x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.05, y: 0.55 }, { x: 1, y: 0.5 }];
  assert.ok(g.turnAngleDeg(pts[0], pts[1], pts[2]) < 25);
  const r = g.relaxSharpTurns(pts, 25);
  assert.ok(r.count >= 1);
  const a = g.turnAngleDeg(r.points[0], r.points[1], r.points[2]);
  assert.ok(a > g.turnAngleDeg(pts[0], pts[1], pts[2]));
});

test("pushEndpointsApart: 양 끝 거리 < minDist → ≥ minDist, 범위 [0,1] 유지", () => {
  const pts = [{ x: 0.4, y: 0.5 }, { x: 0.5, y: 0.6 }, { x: 0.6, y: 0.5 }];
  const r = g.pushEndpointsApart(pts, 0.45);
  assert.ok(r.moved);
  const d = g.dist(r.points[0], r.points[r.points.length - 1]);
  assert.ok(d >= 0.45 - 1e-9, `d=${d}`);
  for (const p of r.points) {
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  }
});

test("pushEndpointsApart: 이미 충분히 멀면 그대로", () => {
  const pts = [{ x: 0.05, y: 0.5 }, { x: 0.95, y: 0.5 }];
  const r = g.pushEndpointsApart(pts, 0.45);
  assert.equal(r.moved, false);
  assert.deepEqual(r.points, pts);
});

test("separateCircles: 겹친 원들이 분리되고 locked 원은 움직이지 않음", () => {
  const circles = [
    { x: 0.5, y: 0.5, r: 0.1, locked: true },
    { x: 0.52, y: 0.5, r: 0.1 },
    { x: 0.5, y: 0.53, r: 0.08 },
  ];
  const r = g.separateCircles(circles, 0.01);
  assert.deepEqual({ x: r.circles[0].x, y: r.circles[0].y }, { x: 0.5, y: 0.5 });
  for (let i = 0; i < r.circles.length; i++) {
    for (let j = i + 1; j < r.circles.length; j++) {
      const d = g.dist(r.circles[i], r.circles[j]);
      assert.ok(d >= r.circles[i].r + r.circles[j].r + 0.01 - 1e-6, `pair ${i},${j} d=${d}`);
    }
  }
});

test("cumulativeLengths / polylineLength", () => {
  const pts = [{ x: 0, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.4 }];
  assert.deepEqual(g.cumulativeLengths(pts).map((v) => +v.toFixed(6)), [0, 0.3, 0.7]);
  assert.ok(Math.abs(g.polylineLength(pts) - 0.7) < 1e-9);
});
