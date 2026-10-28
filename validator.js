/**
 * validator.js (v3, 2026-10-28)
 * LLM이 낸 Zone 후보를 언리얼이 그대로 쓸 수 있는 "레이아웃 정합성이 보장된" Zone JSON으로 보정한다.
 *
 * 1차(값 범위/타입) → 2차(구역 순서/간격) → 3차(이 파일):
 *   경로 기하(중복점·자기교차·급회전·가장자리·spawn-goal 거리), 경로-구역 결합(spawn/goal 스냅,
 *   combat 경로 근접), 진행도(호길이) 기준 정렬, 2D 겹침 해소, 테마 4종 밀도 프로필, 난이도 곡선,
 *   보정 리포트/품질 점수.
 *
 * 설계 원칙
 *  - 결정적: 난수 없음. 같은 입력 → 같은 출력.
 *  - 멱등: validate(validate(x)) === validate(x). 출력은 이미 모든 규칙을 만족하므로 다시 넣어도 안 바뀐다.
 *    (그래서 tanh 소프트 클램프는 뺐다 - 소프트 압축은 멱등일 수 없고, 테마 범위 하드 클램프에 항상 지배되어
 *     실제 효과도 없었다. 증명: 멱등+단조+연속인 1변수 함수는 하드 클램프뿐.)
 *  - 최소 수정: 규칙을 어긴 경우에만, 어긴 만큼만 움직인다. LLM이 정한 모양/비율/순서를 최대한 보존.
 *  - 응답 계약 불변: 최상위 theme/base_environment/main_path/areas. debug일 때만 validation_report 추가.
 */

const g = require("./lib/geometry");
const { THEMES, VALID_THEMES, DEFAULT_THEME, getProfile, inferTheme } = require("./lib/themes");
const { CorrectionReport } = require("./lib/report");

const CONFIG = {
  themes: THEMES,
  max_density_sum: 1.8,
  path_width: { min: 100, max: 1500, def: 500 },
  points: { min: 2, max: 12 },
  edge_margin: 0.03,          // 맵 가장자리 여백
  merge_eps: 0.02,            // 이 거리 미만의 연속 점은 병합
  min_turn_deg: 25,           // 이보다 급하게 꺾이면 헤어핀으로 보고 완화
  min_spawn_goal: 0.45,       // spawn-goal 최소 직선거리
  combat_gap_max: 0.12,       // combat 원 가장자리~경로 최대 거리
  min_area_gap: 0.06,         // 인접 구역 최소 진행도 간격
  circle_pad: 0.01,           // 원 사이 최소 여유
  radius: { min: 0.01, max: 0.3, def: 0.05 },
  max_areas: 8,
  default_path_points: [
    { x: 0.05, y: 0.6 },
    { x: 0.5, y: 0.45 },
    { x: 0.95, y: 0.5 },
  ],
  defaults: {
    spawn: { radius: 0.05, detail: 0.2 },
    combat: { radius: 0.1, detail: 0.6 },
    goal: { radius: 0.06, detail: 0.4 },
    danger: { radius: 0.08, detail: 0.7 },
  },
};

const VALID_AREA_TYPES = ["spawn", "combat", "goal", "danger"];
const DECIMALS = 4;
const TOL = 1e-4;        // 규칙 판정 허용 오차 (반올림 때문에 생기는 1e-4 미만 오차를 흡수)
const MARGIN = 1e-3;     // 보정 시 규칙 경계보다 이만큼 더 안쪽으로 (반올림 후에도 규칙 만족)
const CONV_TOL = 5e-4;   // 서로 의존하는 두 보정(경로 근접 ↔ 반지름)의 재판정 허용 오차. 반올림 떨림(≤1e-4)보다 크고 MARGIN보다 작아야 멱등

const round = (v) => Math.round(v * 10 ** DECIMALS) / 10 ** DECIMALS;
const roundPt = (p) => ({ x: round(p.x), y: round(p.y) });

// 타입 안전장치: 문자열/null/NaN/배열 등 비정형 입력이 와도 유한한 숫자 또는 null
const toNumber = (val) => {
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 입력 정규화. 1차 시절 평평한 스키마(tree_density 최상위)와 현재 중첩 스키마
 * (base_environment/main_path) 둘 다 같은 내부 형태로 바꾼다. 숫자는 toNumber로, 없는 건 null.
 */
function normalizeInput(aiData) {
  const d = isObj(aiData) ? aiData : {};
  const be = isObj(d.base_environment) ? d.base_environment : {};
  const mp = isObj(d.main_path) ? d.main_path : {};
  const pick = (...vals) => {
    for (const v of vals) if (v !== undefined) return v;
    return undefined;
  };
  // 무거운 처리(투영/정렬/겹침)는 전부 O(n²) 이상이므로 입력 단계에서 미리 자른다.
  // 언리얼/LLM 계약상 점 ≤ 12, 구역 ≤ 8 이지만 여유를 두고 자르고, 실제 상한은 뒤 단계에서 적용한다.
  const INPUT_CAP = { points: 64, areas: 64 };
  const rawPointsAll = pick(mp.normalized_points, d.normalized_points);
  const rawPoints = Array.isArray(rawPointsAll) ? rawPointsAll.slice(0, INPUT_CAP.points) : rawPointsAll;
  const rawAreas = Array.isArray(d.areas) ? d.areas.slice(0, INPUT_CAP.areas) : d.areas;
  return {
    theme: typeof d.theme === "string" ? d.theme.trim().toLowerCase() : null,
    tree: toNumber(pick(be.tree_density, d.tree_density)),
    rock: toNumber(pick(be.rock_density, d.rock_density)),
    grass: toNumber(pick(be.grass_density, d.grass_density)),
    pathWidth: toNumber(pick(mp.path_width, d.path_width)),
    points: Array.isArray(rawPoints)
      ? rawPoints.map((p) => (isObj(p) ? { x: toNumber(p.x), y: toNumber(p.y) } : null))
      : null,
    areas: Array.isArray(rawAreas)
      ? rawAreas.map((a) => {
          if (!isObj(a)) return null;
          const c = isObj(a.normalized_center) ? a.normalized_center : {};
          return {
            type: typeof a.area_type === "string" ? a.area_type.trim().toLowerCase() : null,
            x: toNumber(c.x),
            y: toNumber(c.y),
            radius: toNumber(a.normalized_radius),
            detail: toNumber(a.detail_density),
          };
        })
      : null,
    combatCount: toNumber(d.combat_count),
  };
}

/**
 * LLM 미연동/파싱 불가 시 반환하는 데모용 기본 존.
 * spawn/goal은 기본 경로 양끝, combat은 경로 진행도를 균등 분할한 지점에 길옆으로 살짝 비켜 배치.
 * 다른 입력과 똑같이 보정 파이프라인을 통과시켜 불변식(간격/겹침/스냅)을 코드로 보장한다.
 */
function defaultZone(combatCount = 1) {
  const n = Math.max(0, Math.min(Math.round(toNumber(combatCount) ?? 1), CONFIG.max_areas - 2));
  const path = CONFIG.default_path_points;
  const combatAreas = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : (i + 1) / (n + 1);
    const p = g.pointAtProgress(path, t);
    combatAreas.push({
      area_type: "combat",
      normalized_center: { x: p.x, y: p.y + (i % 2 === 0 ? 0.05 : -0.05) },
      normalized_radius: CONFIG.defaults.combat.radius,
      detail_density: CONFIG.defaults.combat.detail,
    });
  }
  const prof = getProfile(DEFAULT_THEME);
  const raw = {
    theme: DEFAULT_THEME,
    base_environment: { tree_density: prof.tree.def, rock_density: prof.rock.def, grass_density: prof.grass.def },
    main_path: { path_type: "main", path_width: CONFIG.path_width.def, normalized_points: path },
    areas: [
      { area_type: "spawn", normalized_center: path[0], normalized_radius: CONFIG.defaults.spawn.radius, detail_density: CONFIG.defaults.spawn.detail },
      ...combatAreas,
      { area_type: "goal", normalized_center: path[path.length - 1], normalized_radius: CONFIG.defaults.goal.radius, detail_density: CONFIG.defaults.goal.detail },
    ],
  };
  return validateWithReport(raw).zone;
}

// ---------------------------------------------------------------- 1~2. 테마 + 밀도
function fixThemeAndDensity(input, rep) {
  let theme;
  if (input.theme && VALID_THEMES.includes(input.theme)) {
    theme = input.theme;
  } else {
    theme = inferTheme({ tree: input.tree, rock: input.rock, grass: input.grass });
    rep.add("theme", "theme", input.theme, theme, input.theme ? "화이트리스트 밖 → 밀도 패턴으로 추정" : "미지정 → 밀도 패턴으로 추정");
  }
  const prof = getProfile(theme);
  const dens = {};
  for (const [k, field] of [["tree", "tree_density"], ["rock", "rock_density"], ["grass", "grass_density"]]) {
    const raw = input[k];
    if (raw === null) {
      dens[k] = prof[k].def;
      rep.add("density", field, raw, dens[k], `누락/비정형 → ${theme} 기본값`);
      continue;
    }
    const c = g.clamp(raw, prof[k].min, prof[k].max);
    if (c !== raw) rep.add("density", field, raw, round(c), `${theme} 허용 범위 [${prof[k].min}, ${prof[k].max}] 클램프`);
    dens[k] = c;
  }
  // 합 정규화: 비율 유지하며 총합을 max_density_sum 이내로. 스케일 후 min 아래로 떨어지면 min으로 올리는데,
  // 그러면 합이 다시 커질 수 있으므로 min 보장은 두 번째 패스에서 최종 확인한다 (min들의 합 < 1.8이라 항상 수렴).
  const sum = dens.tree + dens.rock + dens.grass;
  if (sum > CONFIG.max_density_sum + 1e-12) {
    const s = CONFIG.max_density_sum / sum;
    for (const k of ["tree", "rock", "grass"]) {
      const before = dens[k];
      dens[k] = Math.max(dens[k] * s, prof[k].min);
      rep.add("density", `${k}_density`, round(before), round(dens[k]), `밀도 합 ${round(sum)} > ${CONFIG.max_density_sum} → 비율 유지 스케일(${round(s)})`);
    }
  }
  for (const k of ["tree", "rock", "grass"]) dens[k] = round(dens[k]);
  return { theme, dens };
}

// ---------------------------------------------------------------- 3. 경로 기하
function fixPath(input, rep) {
  const lo = CONFIG.edge_margin, hi = 1 - CONFIG.edge_margin;
  let pts = (input.points || [])
    .filter((p) => p && p.x !== null && p.y !== null)
    .map((p) => ({ x: g.clamp(p.x, 0, 1), y: g.clamp(p.y, 0, 1) }));

  const rawCount = Array.isArray(input.points) ? input.points.length : 0;
  if (pts.length !== rawCount) rep.add("path", "normalized_points", rawCount, pts.length, "숫자 x/y가 아닌 점 제거");
  if (pts.length > CONFIG.points.max) {
    rep.add("path", "normalized_points", pts.length, CONFIG.points.max, `경로 점 상한 ${CONFIG.points.max}`);
    pts = pts.slice(0, CONFIG.points.max);
  }

  const useDefault = (reason) => {
    rep.add("path", "normalized_points", pts.length, "default", reason);
    return CONFIG.default_path_points.map(roundPt);
  };
  if (pts.length < CONFIG.points.min) return useDefault("경로 점 2개 미만 → 기본 경로");
  if (g.polylineLength(pts) < CONFIG.merge_eps) return useDefault("경로 길이 0(점 전부 동일) → 기본 경로");

  // 가장자리 여백
  let margined = 0;
  pts = pts.map((p) => {
    const q = { x: g.clamp(p.x, lo, hi), y: g.clamp(p.y, lo, hi) };
    if (q.x !== p.x || q.y !== p.y) margined++;
    return q;
  });
  if (margined) rep.add("path", "normalized_points", margined, 0, `맵 가장자리 여백 ${CONFIG.edge_margin} 안으로 이동`);

  // 보정 전 필수 규칙 위반 기록
  const xBefore = g.findSelfIntersections(pts).length;
  if (xBefore) rep.hard("path", `자기교차 ${xBefore}건`);
  if (g.dist(pts[0], pts[pts.length - 1]) < CONFIG.min_spawn_goal - TOL) rep.hard("path", `spawn-goal 거리 ${round(g.dist(pts[0], pts[pts.length - 1]))} < ${CONFIG.min_spawn_goal}`);

  // 기하 보정 루프: 각 단계가 다른 단계의 전제를 깰 수 있으므로 안정될 때까지 반복
  for (let round_ = 0; round_ < 6; round_++) {
    let changed = false;

    const merged = g.mergeClosePoints(pts, CONFIG.merge_eps);
    if (merged.length !== pts.length) {
      rep.add("path", "normalized_points", pts.length, merged.length, `근접(<${CONFIG.merge_eps}) 중복점 병합`);
      pts = merged; changed = true;
    }
    if (pts.length < 2) return useDefault("병합 후 점 부족 → 기본 경로");

    const un = g.untangle(pts, 30);
    if (un.flips) { rep.add("path", "normalized_points", "crossing", "untangled", `2-opt 구간 뒤집기 ${un.flips}회로 자기교차 해소`); pts = un.points; changed = true; }

    // 급회전: 몇 번 완화해보고 그래도 안 풀리면 꼭짓점 제거
    let relaxed = 0, removed = 0;
    for (let i = 0; i < 8; i++) {
      const r = g.relaxSharpTurns(pts, CONFIG.min_turn_deg, 0.5);
      if (!r.count) break;
      pts = r.points; relaxed += r.count;
    }
    for (let guard = 0; guard < pts.length; guard++) {
      const idx = pts.findIndex((p, i) => i > 0 && i < pts.length - 1 && g.turnAngleDeg(pts[i - 1], p, pts[i + 1]) < CONFIG.min_turn_deg);
      if (idx < 0) break;
      pts = pts.filter((_, i) => i !== idx); removed++;
    }
    if (relaxed || removed) { rep.add("path", "normalized_points", "hairpin", "relaxed", `급회전(<${CONFIG.min_turn_deg}°) 완화 ${relaxed}회, 제거 ${removed}점`); changed = true; }

    const pushed = g.pushEndpointsApart(pts, CONFIG.min_spawn_goal, { target: CONFIG.min_spawn_goal + MARGIN, lo, hi, tol: TOL });
    if (pushed.moved) { rep.add("path", "spawn-goal", round(g.dist(pts[0], pts[pts.length - 1])), CONFIG.min_spawn_goal, "spawn-goal 최소 거리 확보(양 끝점 반대 방향으로 이동)"); pts = pushed.points; changed = true; }

    pts = pts.map((p) => ({ x: g.clamp(p.x, lo, hi), y: g.clamp(p.y, lo, hi) }));
    pts = pts.map(roundPt);
    if (!changed) break;
  }
  if (pts.length < 2 || g.findSelfIntersections(pts).length) return useDefault("기하 보정 실패 → 기본 경로");
  return pts;
}

// ---------------------------------------------------------------- 4~5. 구역 타입/값 + 구조 보장
function fixAreas(input, pathPts, rep, combatCountOpt) {
  const start = pathPts[0], end = pathPts[pathPts.length - 1];
  const raw = Array.isArray(input.areas) ? input.areas : [];
  const dropped = raw.filter((a) => !a).length;
  if (dropped) rep.add("areas", "areas", raw.length, raw.length - dropped, "객체가 아닌 항목 제거");

  let areas = raw.filter(Boolean).map((a, i) => {
    const type = VALID_AREA_TYPES.includes(a.type) ? a.type : "combat";
    if (type !== a.type) rep.add("areas", `areas[${i}].area_type`, a.type, type, "화이트리스트(spawn/combat/goal/danger) 밖 → combat");
    const def = CONFIG.defaults[type];
    const x = a.x === null ? null : g.clamp(a.x, 0, 1);
    const y = a.y === null ? null : g.clamp(a.y, 0, 1);
    let radius = a.radius === null ? def.radius : g.clamp(a.radius, CONFIG.radius.min, CONFIG.radius.max);
    if (a.radius !== null && radius !== a.radius) rep.add("areas", `areas[${i}].normalized_radius`, a.radius, radius, `반지름 [${CONFIG.radius.min}, ${CONFIG.radius.max}] 클램프`);
    let detail = a.detail === null ? def.detail : g.clamp(a.detail, 0, 1);
    return { type, x, y, radius, detail, hadCenter: x !== null && y !== null };
  });

  // spawn/goal 정확히 1개: 첫 번째만 유지, 나머지는 combat으로 강등
  for (const t of ["spawn", "goal"]) {
    let seen = false;
    areas = areas.map((a, i) => {
      if (a.type !== t) return a;
      if (!seen) { seen = true; return a; }
      rep.add("areas", `areas[${i}].area_type`, t, "combat", `${t}은 1개만 허용 → 추가분은 combat으로 강등`);
      return { ...a, type: "combat" };
    });
  }
  if (!areas.some((a) => a.type === "spawn")) {
    rep.hard("areas", "spawn 없음");
    rep.add("areas", "areas", "no spawn", "spawn added", "spawn 자동 추가(경로 시작점)");
    areas.unshift({ type: "spawn", x: start.x, y: start.y, radius: CONFIG.defaults.spawn.radius, detail: CONFIG.defaults.spawn.detail, hadCenter: true });
  }
  if (!areas.some((a) => a.type === "goal")) {
    rep.hard("areas", "goal 없음");
    rep.add("areas", "areas", "no goal", "goal added", "goal 자동 추가(경로 끝점)");
    areas.push({ type: "goal", x: end.x, y: end.y, radius: CONFIG.defaults.goal.radius, detail: CONFIG.defaults.goal.detail, hadCenter: true });
  }

  // 중심 좌표 없는 구역: 경로 위 고른 위치에 배치
  const noCenter = areas.filter((a) => !a.hadCenter);
  noCenter.forEach((a, i) => {
    const p = g.pointAtProgress(pathPts, (i + 1) / (noCenter.length + 1));
    a.x = p.x; a.y = p.y; a.hadCenter = true;
    rep.add("areas", "normalized_center", null, roundPt(p), "중심 누락 → 경로 위 균등 배치");
  });

  // combat_count: 옵션 또는 입력의 combat_count. 부족하면 가장 큰 빈 구간에 추가, 초과하면 뒤에서부터 제거
  const want = combatCountOpt !== undefined ? toNumber(combatCountOpt) : null;
  if (want !== null) {
    const target = Math.max(0, Math.min(Math.round(want), CONFIG.max_areas - 2));
    let combats = areas.filter((a) => a.type === "combat");
    if (combats.length > target) {
      // 뒤쪽 combat부터 제거 (한 번의 filter로 처리)
      const removeSet = new Set(combats.slice(target));
      areas = areas.filter((a) => !removeSet.has(a));
      rep.add("areas", "combat_count", combats.length, target, `요청 전투 수 ${target}에 맞춰 ${combats.length - target}개 제거`);
      combats = areas.filter((a) => a.type === "combat");
    }
    while (combats.length < target) {
      const ts = [0, ...areas.filter((a) => a.type !== "spawn" && a.type !== "goal").map((a) => g.projectToPolyline(a, pathPts).t), 1].sort((p, q) => p - q);
      let bi = 0;
      for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > ts[bi + 1] - ts[bi]) bi = i - 1;
      const p = g.pointAtProgress(pathPts, (ts[bi] + ts[bi + 1]) / 2);
      const c = { type: "combat", x: p.x, y: p.y, radius: CONFIG.defaults.combat.radius, detail: CONFIG.defaults.combat.detail, hadCenter: true };
      areas.push(c); combats = areas.filter((a) => a.type === "combat");
      rep.add("areas", "combat_count", combats.length - 1, combats.length, `요청 전투 수 ${target}에 맞춰 가장 넓은 빈 구간에 추가`);
    }
  }

  // 총 구역 수 상한
  if (areas.length > CONFIG.max_areas) {
    const spawn = areas.find((a) => a.type === "spawn");
    const goal = areas.find((a) => a.type === "goal");
    const middle = areas.filter((a) => a !== spawn && a !== goal).slice(0, CONFIG.max_areas - 2);
    rep.add("areas", "areas", areas.length, CONFIG.max_areas, `구역 수 상한 ${CONFIG.max_areas}(언리얼 Area 액터/경로 길이 대비 과밀 방지)`);
    areas = [spawn, ...middle, goal];
  }
  // 이후 단계와 최종 출력이 같은 숫자를 보도록 여기서 반올림 (멱등성: 두 번째 패스가 같은 입력을 봄)
  for (const a of areas) { a.x = round(a.x); a.y = round(a.y); a.radius = round(a.radius); a.detail = round(a.detail); }
  return areas;
}

// ---------------------------------------------------------------- 6~9. 경로-구역 결합, 정렬, 간격, 겹침, 반지름
/**
 * 구역 배치는 "경로 좌표계"에서 푼다: 각 중간 구역을 (진행도 t, 경로에서의 수직 오프셋 벡터)로 표현하고
 *  (a) t는 1D 최소 간격 문제로 푼다(앞으로 밀고, 끝을 넘치면 뒤로 당김 - 구역 ≤ 8이므로 항상 해가 있음)
 *  (b) 오프셋 길이는 반지름 + combat_gap_max 이내로 제한(경로 근접 규칙)
 *  (c) 겹침은 중심을 옮기지 않고 반지름만 줄여서 해소(이웃 중심 거리의 절반) → 서로 싸우는 루프가 없다
 * 모든 판정은 TOL 이내면 "이미 만족"으로 보고 건드리지 않는다(lazy) → 반올림 후 다시 넣어도 그대로(멱등).
 */
function layoutAreas(areas, pathPts, rep) {
  const start = pathPts[0], end = pathPts[pathPts.length - 1];
  const spawn = areas.find((a) => a.type === "spawn");
  const goal = areas.find((a) => a.type === "goal");
  const snap = (a, p, label) => {
    if (Math.abs(a.x - p.x) > TOL || Math.abs(a.y - p.y) > TOL) {
      rep.add("layout", `${label}.normalized_center`, roundPt(a), roundPt(p), `${label}은 경로 ${label === "spawn" ? "시작" : "끝"}점에 고정`);
    }
    a.x = p.x; a.y = p.y;
  };
  snap(spawn, start, "spawn");
  snap(goal, end, "goal");

  const middle = areas.filter((a) => a !== spawn && a !== goal);
  const gap = CONFIG.min_area_gap;
  const minCenterDist = 2 * CONFIG.radius.min + CONFIG.circle_pad; // 이보다 가까우면 반지름 최소값으로도 겹침

  // 보정 전 필수 규칙 위반 기록
  let farBefore = 0, overlapBefore = 0;
  for (const a of middle) {
    const pr = g.projectToPolyline(a, pathPts);
    if (pr.dist - a.radius > CONFIG.combat_gap_max + TOL) farBefore++;
  }
  for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) {
    if (g.dist(areas[i], areas[j]) < areas[i].radius + areas[j].radius - TOL) overlapBefore++;
  }
  if (farBefore) rep.hard("layout", `경로에서 먼 구역 ${farBefore}개(가장자리 거리 > ${CONFIG.combat_gap_max})`);
  if (overlapBefore) rep.hard("layout", `구역 원 겹침 ${overlapBefore}쌍`);

  // 경로 좌표계로 변환. radius0 = 입력 반지름(상한): 반지름은 "최종 위치에서 겹치지 않는 최대값"과 radius0 중
  // 작은 쪽으로 정해진다(위치가 벌어지면 다시 커질 수 있음 → 일시적 겹침으로 영구히 작아지는 일 없음).
  for (const a of areas) a.radius0 = a.radius;
  for (const a of middle) {
    const pr = g.projectToPolyline(a, pathPts);
    a.t = pr.t;
    a.off = { x: a.x - pr.point.x, y: a.y - pr.point.y };
  }

  let spaced = 0, pulled = 0, onPath = 0, shrunk = 0;
  const extraGap = new Map(); // 2D로 너무 가까운 쌍에 대해 늘린 간격 요구
  const placeOnPath = (a) => {
    const base = g.pointAtProgress(pathPts, a.t);
    a.x = round(g.clamp(base.x + a.off.x, 0, 1)); a.y = round(g.clamp(base.y + a.off.y, 0, 1));
    a.t = g.projectToPolyline(a, pathPts).t;
    const b2 = g.pointAtProgress(pathPts, a.t);
    a.off = { x: a.x - b2.x, y: a.y - b2.y };
  };
  // 반복 상한: 경로 근접(오프셋 ≤ r+0.12)과 반지름(이웃 거리/2)이 서로 의존해 기하급수적으로 수렴하는 경우가 있어
  // 넉넉히 둔다(n ≤ 8이라 비용은 무시할 수준). 변화가 TOL 이하면 종료.
  for (let iter = 0; iter < 400; iter++) {
    let changed = false;
    middle.sort((p, q) => p.t - q.t);

    // (a) lazy 1D 간격 풀이
    //   need[i] = 구역 i 앞에 필요한 간격(기본 gap + 2D 근접으로 늘린 extraGap). 총합이 1을 넘으면
    //   extraGap 부분만 비례 축소해 항상 해가 있게 한다(기본 gap 합 ≤ 7×0.061 < 1).
    //   하한(앞에서 밀기) → 상한(끝에서 당기기) 순서의 표준 1D 해법. 결과는 모든 제약을 동시에 만족하므로
    //   앞/뒤 패스가 번갈아 밀고 당기는 진동이 생기지 않는다.
    const n = middle.length;
    let needs = middle.map((a) => gap + (extraGap.get(a) || 0));
    const budget = 1 - MARGIN * (n + 1);
    const baseSum = gap * (n + 1);
    const extraSum = needs.reduce((acc, v) => acc + v, 0) + gap - baseSum;
    if (extraSum > 0 && baseSum + extraSum > budget) {
      const sc = Math.max(0, (budget - baseSum) / extraSum);
      needs = needs.map((v) => gap + (v - gap) * sc);
    }
    const lb = [];
    for (let i = 0; i < n; i++) lb[i] = Math.max(middle[i].t, (i === 0 ? 0 : lb[i - 1]) + needs[i] + MARGIN);
    const want = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      const cap = i === n - 1 ? 1 - gap - MARGIN : want[i + 1] - needs[i + 1] - MARGIN;
      want[i] = Math.min(lb[i], cap);
    }
    for (let i = 0; i < middle.length; i++) {
      if (Math.abs(want[i] - middle[i].t) > CONV_TOL) { middle[i].t = want[i]; placeOnPath(middle[i]); spaced++; changed = true; }
    }

    // (b) 경로 근접: 오프셋 길이 ≤ 반지름 + combat_gap_max
    for (const a of middle) {
      const len = Math.hypot(a.off.x, a.off.y);
      const maxLen = a.radius + CONFIG.combat_gap_max - MARGIN;
      if (len > maxLen + CONV_TOL) { const k = maxLen / len; a.off = { x: a.off.x * k, y: a.off.y * k }; placeOnPath(a); pulled++; changed = true; }
    }

    // (b') 경로가 휘어 투영 진행도가 배정값과 어긋나는 구역은 길 위로 (다음 패스가 같은 t를 보도록)
    middle.sort((p, q) => p.t - q.t);
    for (let i = 0; i < middle.length; i++) {
      const a = middle[i];
      const prev = i === 0 ? 0 : middle[i - 1].t, next = i === middle.length - 1 ? 1 : middle[i + 1].t;
      const len = Math.hypot(a.off.x, a.off.y);
      if (len > TOL && (a.t - prev < gap - TOL || next - a.t < gap - TOL)) {
        // 간격 위반이 오프셋 때문에 생겼을 수 있음 → 길 위로 올려 다시 풀게 한다
        a.off = { x: 0, y: 0 }; placeOnPath(a); onPath++; changed = true;
      }
    }

    // (c) 반지름 최소값으로도 겹치는 거리(중심 간 < 0.03)면 뒤 구역의 간격 요구를 늘려 다시 푼다
    const chain = [spawn, ...middle, goal];
    for (let i = 1; i < chain.length; i++) {
      if (g.dist(chain[i - 1], chain[i]) < minCenterDist - TOL && chain[i] !== goal) {
        // 상한(3×gap)까지만 늘린다. 경로가 접혀 2D 거리가 안 벌어지는 경우 무한히 늘어나며 루프가 안 끝나는 것 방지
        const cur = extraGap.get(chain[i]) || 0;
        if (cur < 3 * gap) { extraGap.set(chain[i], cur + gap); changed = true; }
      }
    }
    if (changed) continue;

    // (d) 위치가 안정된 뒤에만 반지름 정합성 적용: 가장 가까운 이웃 중심 거리의 절반(여유 포함) → 겹침 0
    //     (위치가 아직 움직이는 중에 줄이면 일시적 겹침 때문에 반지름이 영구히 과도하게 작아진다)
    let shrunkNow = 0;
    for (let i = 0; i < chain.length; i++) {
      let dmin = Infinity;
      for (let j = 0; j < chain.length; j++) if (j !== i) dmin = Math.min(dmin, g.dist(chain[i], chain[j]));
      const maxR = Math.max((dmin - CONFIG.circle_pad) / 2, CONFIG.radius.min);
      const target = round(Math.min(chain[i].radius0, maxR));
      if (Math.abs(chain[i].radius - target) > CONV_TOL) { chain[i].radius = target; shrunkNow++; }
    }
    shrunk += shrunkNow;
    if (!shrunkNow) break; // 위치도 반지름도 안 바뀜 → 수렴
  }
  if (spaced) rep.add("layout", "areas", "crowded", "spaced", `인접 구역 진행도 간격 ${gap} 확보(${spaced}회 이동)`);
  if (pulled) rep.add("layout", "combat.normalized_center", "far", "near path", `경로에서 먼 구역 ${pulled}회 경로 쪽으로 이동(가장자리 거리 ≤ ${CONFIG.combat_gap_max})`);
  if (onPath) rep.add("layout", "combat.normalized_center", "off-path", "on-path", `경로 굴곡으로 간격이 어긋나는 구역 ${onPath}회 길 위로 이동`);
  if (shrunk) rep.add("layout", "normalized_radius", "overlap", "shrunk", `이웃 구역과 겹치지 않도록 반지름 축소 ${shrunk}회`);

  middle.sort((p, q) => p.t - q.t);
  const ordered = [spawn, ...middle, goal];

  // 최종 안전 패스: 위 루프가 반복 상한에 걸려 (d)가 실행되지 않은 경우에도 겹침 0은 보장한다.
  // 반지름 축소 → 경로 근접 재적용 → 반지름 축소 순서 (수렴한 경우엔 전부 no-op이라 멱등성에 영향 없음)
  const shrinkAll = () => {
    let cnt = 0;
    for (let i = 0; i < ordered.length; i++) {
      let dmin = Infinity;
      for (let j = 0; j < ordered.length; j++) if (j !== i) dmin = Math.min(dmin, g.dist(ordered[i], ordered[j]));
      const maxR = Math.max((dmin - CONFIG.circle_pad) / 2, CONFIG.radius.min);
      if (ordered[i].radius > maxR + CONV_TOL) { ordered[i].radius = round(maxR); cnt++; }
    }
    return cnt;
  };
  let finalShrunk = 0;
  for (let k = 0; k < 100; k++) {
    let cnt = shrinkAll();
    for (const a of middle) {
      const pr = g.projectToPolyline(a, pathPts);
      const maxLen = a.radius + CONFIG.combat_gap_max - MARGIN;
      if (pr.dist > maxLen + CONV_TOL) {
        const kk = maxLen / pr.dist;
        a.x = round(pr.point.x + (a.x - pr.point.x) * kk); a.y = round(pr.point.y + (a.y - pr.point.y) * kk);
        cnt++;
      }
    }
    finalShrunk += cnt;
    if (!cnt) break;
  }
  if (finalShrunk) rep.add("layout", "normalized_radius", "overlap", "shrunk", `반복 상한 도달 후 최종 패스에서 반지름/근접 보정 ${finalShrunk}회`);
  return ordered;
}

// ---------------------------------------------------------------- 10. 난이도 곡선
function fixDifficultyCurve(ordered, rep) {
  const combats = ordered.filter((a) => a.type === "combat");
  const vals = combats.map((a) => a.detail);
  const sorted = vals.slice().sort((p, q) => p - q);
  if (vals.some((v, i) => Math.abs(v - sorted[i]) > 1e-12)) {
    rep.add("difficulty", "combat.detail_density", vals.map(round), sorted.map(round), "전투 강도가 진행 방향으로 단조 증가하도록 값 재배열(값 집합은 유지)");
    combats.forEach((a, i) => { a.detail = sorted[i]; });
  }
}

// ---------------------------------------------------------------- 진입점
function validateWithReport(aiData, options = {}) {
  const rep = new CorrectionReport();
  if (!isObj(aiData)) {
    if (aiData !== null && aiData !== undefined) rep.add("input", "pcg_json", typeof aiData, "default zone", "객체가 아닌 입력 → 기본 존");
    return { zone: defaultZone(options.combatCount), report: rep.toJSON() };
  }
  const input = normalizeInput(aiData);
  const { theme, dens } = fixThemeAndDensity(input, rep);

  let pathWidth = input.pathWidth === null ? CONFIG.path_width.def : g.clamp(input.pathWidth, CONFIG.path_width.min, CONFIG.path_width.max);
  if (input.pathWidth !== null && pathWidth !== input.pathWidth) rep.add("path", "path_width", input.pathWidth, pathWidth, `[${CONFIG.path_width.min}, ${CONFIG.path_width.max}] 클램프`);
  pathWidth = round(pathWidth);

  const pathPts = fixPath(input, rep);
  const combatCountOpt = options.combatCount !== undefined ? options.combatCount : (input.combatCount !== null ? input.combatCount : undefined);
  const areas = fixAreas(input, pathPts, rep, combatCountOpt);
  const ordered = layoutAreas(areas, pathPts, rep);
  fixDifficultyCurve(ordered, rep);

  const zone = {
    theme,
    base_environment: { tree_density: dens.tree, rock_density: dens.rock, grass_density: dens.grass },
    main_path: { path_type: "main", path_width: pathWidth, normalized_points: pathPts.map(roundPt) },
    areas: ordered.map((a) => ({
      area_type: a.type,
      normalized_center: { x: round(a.x), y: round(a.y) },
      normalized_radius: round(a.radius),
      detail_density: round(a.detail),
    })),
  };
  return { zone, report: rep.toJSON() };
}

function validatePCGParams(aiData, options = {}) {
  const { zone, report } = validateWithReport(aiData, options);
  if (options.debug) zone.validation_report = report;
  return zone;
}

module.exports = { validatePCGParams, validateWithReport, normalizeInput, defaultZone, CONFIG };
