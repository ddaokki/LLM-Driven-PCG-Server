/**
 * lib/geometry.js
 * 정규화 좌표(0~1) 2D 평면에서 경로(폴리라인)와 원(구역)을 다루는 순수 기하 유틸.
 * validator.js의 "레이아웃 정합성 보정"이 전부 여기 함수 위에서 돈다.
 * 난수 없음 - 같은 입력이면 항상 같은 출력(결정적).
 */

const EPS = 1e-12;

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 외적 부호 (p→q→r 방향). 0이면 일직선.
const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

const onSegment = (p, q, r) =>
  Math.min(p.x, r.x) - EPS <= q.x && q.x <= Math.max(p.x, r.x) + EPS &&
  Math.min(p.y, r.y) - EPS <= q.y && q.y <= Math.max(p.y, r.y) + EPS;

const samePoint = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/**
 * 두 선분 p1p2, p3p4가 교차하는가. 끝점만 공유하는 경우(인접 구간)는 교차로 보지 않는다.
 */
function segmentsIntersect(p1, p2, p3, p4) {
  // 끝점 공유는 제외 (인접 구간이 항상 "교차"로 잡히는 걸 막음)
  if (samePoint(p1, p3) || samePoint(p1, p4) || samePoint(p2, p3) || samePoint(p2, p4)) return false;

  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);

  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
      ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) {
    return true;
  }
  // 일직선 위에서 겹치는 경우
  if (Math.abs(d1) <= EPS && onSegment(p3, p1, p4)) return true;
  if (Math.abs(d2) <= EPS && onSegment(p3, p2, p4)) return true;
  if (Math.abs(d3) <= EPS && onSegment(p1, p3, p2)) return true;
  if (Math.abs(d4) <= EPS && onSegment(p1, p4, p2)) return true;
  return false;
}

function cumulativeLengths(pts) {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + dist(pts[i - 1], pts[i]));
  return out;
}

const polylineLength = (pts) => (pts.length < 2 ? 0 : cumulativeLengths(pts)[pts.length - 1]);

/**
 * 점을 폴리라인에 투영. t = 호길이 기준 진행도(0~1), point = 최근접점, dist = 거리.
 * 길이 0 경로(점 1개 또는 전부 같은 점)면 t=0, 첫 점으로 투영.
 */
function projectToPolyline(pt, pts) {
  if (!pts.length) return { t: 0, point: { x: 0.5, y: 0.5 }, dist: dist(pt, { x: 0.5, y: 0.5 }) };
  const cum = cumulativeLengths(pts);
  const total = cum[cum.length - 1];
  if (total <= EPS) return { t: 0, point: { ...pts[0] }, dist: dist(pt, pts[0]) };

  let best = { t: 0, point: { ...pts[0] }, dist: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let u = 0;
    if (len2 > EPS) u = clamp(((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2, 0, 1);
    const q = { x: a.x + u * dx, y: a.y + u * dy };
    const d = dist(pt, q);
    if (d < best.dist - EPS) {
      best = { t: (cum[i] + u * Math.sqrt(len2)) / total, point: q, dist: d };
    }
  }
  return best;
}

/** 진행도 t(0~1)에 해당하는 경로 위 좌표 */
function pointAtProgress(pts, t) {
  if (!pts.length) return { x: 0.5, y: 0.5 };
  if (pts.length === 1) return { ...pts[0] };
  const cum = cumulativeLengths(pts);
  const total = cum[cum.length - 1];
  if (total <= EPS) return { ...pts[0] };
  const target = clamp(t, 0, 1) * total;
  for (let i = 0; i < pts.length - 1; i++) {
    if (target <= cum[i + 1] + EPS) {
      const segLen = cum[i + 1] - cum[i];
      const u = segLen <= EPS ? 0 : (target - cum[i]) / segLen;
      return { x: pts[i].x + u * (pts[i + 1].x - pts[i].x), y: pts[i].y + u * (pts[i + 1].y - pts[i].y) };
    }
  }
  return { ...pts[pts.length - 1] };
}

/** b 꼭짓점에서의 사이각(도). 직진=180, 되돌아감=0 */
function turnAngleDeg(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
  if (n1 <= EPS || n2 <= EPS) return 180;
  const cosv = clamp((v1.x * v2.x + v1.y * v2.y) / (n1 * n2), -1, 1);
  return (Math.acos(cosv) * 180) / Math.PI;
}

/** 연속 점 중 eps 이내로 붙은 점 병합. 마지막 점은 항상 유지(끝점 보존). */
function mergeClosePoints(pts, eps) {
  if (pts.length <= 2) return pts.map((p) => ({ ...p }));
  const out = [{ ...pts[0] }];
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist(out[out.length - 1], pts[i]) >= eps) out.push({ ...pts[i] });
  }
  const last = pts[pts.length - 1];
  // 마지막 점이 직전 점과 너무 가까우면 직전 점을 버리고 마지막 점을 남긴다 (끝점 우선)
  if (out.length > 1 && dist(out[out.length - 1], last) < eps) out.pop();
  out.push({ ...last });
  return out;
}

/** 자기교차하는 구간 쌍 [i, j] 목록 (i < j, 구간 i = pts[i]→pts[i+1]) */
function findSelfIntersections(pts) {
  const found = [];
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (segmentsIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1])) found.push([i, j]);
    }
  }
  return found;
}

/**
 * 2-opt 뒤집기로 자기교차 해소. 구간 i와 j가 교차하면 pts[i+1..j]를 뒤집는다
 * (TSP 2-opt와 동일한 원리 - 교차하는 두 구간을 풀면 총 길이가 줄어들어 수렴 보장).
 * 양 끝점은 절대 움직이지 않는다.
 */
function untangle(pts, maxIter = 20) {
  let points = pts.map((p) => ({ ...p }));
  let flips = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const hits = findSelfIntersections(points);
    if (!hits.length) break;
    const [i, j] = hits[0];
    const mid = points.slice(i + 1, j + 1).reverse();
    points = [...points.slice(0, i + 1), ...mid, ...points.slice(j + 1)];
    flips++;
  }
  return { points, flips };
}

/**
 * 사이각이 minAngleDeg 미만인 꼭짓점(헤어핀)을 이웃 두 점의 중점 쪽으로 factor만큼 이동.
 * 양 끝점 제외. 한 번 훑고 끝(반복은 호출자 몫).
 */
function relaxSharpTurns(pts, minAngleDeg, factor = 0.5) {
  const points = pts.map((p) => ({ ...p }));
  let count = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if (turnAngleDeg(points[i - 1], points[i], points[i + 1]) < minAngleDeg) {
      const mx = (points[i - 1].x + points[i + 1].x) / 2;
      const my = (points[i - 1].y + points[i + 1].y) / 2;
      points[i] = { x: points[i].x + (mx - points[i].x) * factor, y: points[i].y + (my - points[i].y) * factor };
      count++;
    }
  }
  return { points, count };
}

/**
 * 양 끝점 직선거리가 minDist 미만이면, 두 끝점을 서로 반대 방향으로 밀어 minDist 이상으로 만든다.
 * 원래 방향(첫점→끝점)을 유지하되 두 점이 겹쳐 있으면 x축 방향을 쓴다. 결과는 [0,1]로 클램프하고,
 * 클램프 때문에 모자라면 반대쪽을 더 민다.
 */
function pushEndpointsApart(pts, minDist) {
  const points = pts.map((p) => ({ ...p }));
  if (points.length < 2) return { points, moved: false };
  const a = points[0], b = points[points.length - 1];
  const d = dist(a, b);
  if (d >= minDist) return { points, moved: false };

  let ux, uy;
  if (d <= EPS) { ux = 1; uy = 0; } else { ux = (b.x - a.x) / d; uy = (b.y - a.y) / d; }
  const need = (minDist - d) / 2 + 1e-6;

  let na = { x: clamp(a.x - ux * need, 0, 1), y: clamp(a.y - uy * need, 0, 1) };
  let nb = { x: clamp(b.x + ux * need, 0, 1), y: clamp(b.y + uy * need, 0, 1) };
  let nd = dist(na, nb);
  if (nd < minDist) {
    // 한쪽이 벽에 막힘 → 남은 거리를 반대쪽으로 더 민다
    const rem = minDist - nd + 1e-6;
    const nb2 = { x: clamp(nb.x + ux * rem, 0, 1), y: clamp(nb.y + uy * rem, 0, 1) };
    if (dist(na, nb2) >= minDist) nb = nb2;
    else na = { x: clamp(na.x - ux * rem, 0, 1), y: clamp(na.y - uy * rem, 0, 1) };
  }
  points[0] = na;
  points[points.length - 1] = nb;
  return { points, moved: true };
}

/**
 * 원 겹침 반복 분리. 겹친 쌍을 중심 연결선 방향으로 밀어낸다. locked 원은 고정.
 * 둘 다 잠겨 있으면 건너뜀. 중심이 같으면 x축 방향 사용. 결과 좌표는 [0,1] 클램프.
 */
function separateCircles(circles, pad, maxIter = 20) {
  const cs = circles.map((c) => ({ ...c }));
  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    let movedAny = false;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j];
        if (a.locked && b.locked) continue;
        const need = a.r + b.r + pad;
        const d = dist(a, b);
        if (d >= need - 1e-9) continue;
        let ux, uy;
        if (d <= EPS) { ux = 1; uy = 0; } else { ux = (b.x - a.x) / d; uy = (b.y - a.y) / d; }
        const overlap = need - d + 1e-6;
        if (a.locked) {
          b.x = clamp(b.x + ux * overlap, 0, 1); b.y = clamp(b.y + uy * overlap, 0, 1);
        } else if (b.locked) {
          a.x = clamp(a.x - ux * overlap, 0, 1); a.y = clamp(a.y - uy * overlap, 0, 1);
        } else {
          a.x = clamp(a.x - ux * overlap / 2, 0, 1); a.y = clamp(a.y - uy * overlap / 2, 0, 1);
          b.x = clamp(b.x + ux * overlap / 2, 0, 1); b.y = clamp(b.y + uy * overlap / 2, 0, 1);
        }
        movedAny = true;
      }
    }
    if (!movedAny) break;
  }
  return { circles: cs, iterations };
}

module.exports = {
  clamp,
  dist,
  segmentsIntersect,
  cumulativeLengths,
  polylineLength,
  projectToPolyline,
  pointAtProgress,
  turnAngleDeg,
  mergeClosePoints,
  findSelfIntersections,
  untangle,
  relaxSharpTurns,
  pushEndpointsApart,
  separateCircles,
};
