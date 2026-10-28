/**
 * unreal_parser_mock.js
 * 언리얼 클라이언트 APCGZoneController::ApplyZoneJsonString() (Choibw/LLMDrivenPlayablePCG,
 * Source/LLMDrivenPlayablePCG/Private/PCGZoneController.cpp, 2026-10-27 커밋 기준)의 파싱 규칙을
 * Node로 그대로 재현한 목(mock). 백엔드 응답이 언리얼에서 실제로 읽히는지 테스트에서 확인하는 용도.
 *
 * 재현한 규칙:
 *  - 최상위 theme 문자열 필수 (값은 로그용, 검사 없음)
 *  - base_environment 객체 필수. tree/rock/grass_density는 있으면 읽고 [0,1] 클램프 (없으면 이전 값 유지 → 여기선 기본값)
 *  - main_path 객체 필수. path_type 없으면 main. path_width [100,1500] 클램프.
 *    normalized_points 배열 필수, x/y가 숫자가 아닌 점은 건너뜀, 남은 점 2개 미만이면 실패. 좌표 [0,1] 클램프.
 *  - areas 배열 필수, 객체 아닌 항목은 건너뜀, 남은 구역 0개면 실패.
 *    area_type 미인식 → Combat. normalized_center 없으면 (0.5,0.5). radius [0.01,0.30], detail [0,1] 클램프.
 *  - 파싱 성공 후 Paths = [MainPath]. ExpectedCombatAreaCount = combat 구역 수 (모든 combat 클리어 시 goal 활성화).
 *  - 알 수 없는 추가 필드(validation_report 등)는 무시된다 (TryGet* 방식).
 */

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function parseAreaType(s) {
  const t = String(s).toLowerCase();
  if (t === "spawn") return "spawn";
  if (t === "goal") return "goal";
  if (t === "danger") return "danger";
  return "combat";
}
function parsePathType(s) {
  const t = String(s).toLowerCase();
  if (t === "branch") return "branch";
  if (t === "shortcut") return "shortcut";
  return "main";
}

function applyZoneJsonString(jsonString) {
  let root;
  try {
    root = JSON.parse(jsonString);
  } catch (e) {
    return { ok: false, reason: `JSON deserialize 실패: ${e.message}` };
  }
  if (!isObj(root)) return { ok: false, reason: "최상위가 객체가 아님" };
  if (typeof root.theme !== "string") return { ok: false, reason: "theme 문자열 누락" };

  const data = { theme: root.theme, base_environment: { tree_density: 0.5, rock_density: 0.3, grass_density: 0.7 } };

  if (!isObj(root.base_environment)) return { ok: false, reason: "base_environment 객체 누락 (최상위 평평한 밀도 필드는 읽지 않음)" };
  for (const k of ["tree_density", "rock_density", "grass_density"]) {
    if (isNum(root.base_environment[k])) data.base_environment[k] = clamp(root.base_environment[k], 0, 1);
  }

  if (!isObj(root.main_path)) return { ok: false, reason: "main_path 객체 누락" };
  const mp = root.main_path;
  const path = { path_type: typeof mp.path_type === "string" ? parsePathType(mp.path_type) : "main", path_width: 500, normalized_points: [] };
  if (isNum(mp.path_width)) path.path_width = clamp(mp.path_width, 100, 1500);
  if (!Array.isArray(mp.normalized_points)) return { ok: false, reason: "main_path.normalized_points 배열 누락" };
  for (const p of mp.normalized_points) {
    if (!isObj(p) || !isNum(p.x) || !isNum(p.y)) continue;
    path.normalized_points.push({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) });
  }
  if (path.normalized_points.length < 2) return { ok: false, reason: `경로 점 ${path.normalized_points.length}개 (< 2)` };
  data.main_path = path;

  if (!Array.isArray(root.areas)) return { ok: false, reason: "areas 배열 누락" };
  data.areas = [];
  for (const a of root.areas) {
    if (!isObj(a)) continue;
    const area = { area_type: typeof a.area_type === "string" ? parseAreaType(a.area_type) : "combat", normalized_center: { x: 0.5, y: 0.5 }, normalized_radius: 0.1, detail_density: 0.5 };
    if (isObj(a.normalized_center)) {
      area.normalized_center = {
        x: clamp(isNum(a.normalized_center.x) ? a.normalized_center.x : 0.5, 0, 1),
        y: clamp(isNum(a.normalized_center.y) ? a.normalized_center.y : 0.5, 0, 1),
      };
    }
    if (isNum(a.normalized_radius)) area.normalized_radius = clamp(a.normalized_radius, 0.01, 0.3);
    if (isNum(a.detail_density)) area.detail_density = clamp(a.detail_density, 0, 1);
    data.areas.push(area);
  }
  if (data.areas.length <= 0) return { ok: false, reason: "areas 0개" };

  data.paths = [data.main_path];
  data.expected_combat_area_count = data.areas.filter((a) => a.area_type === "combat").length;
  return { ok: true, data };
}

module.exports = { applyZoneJsonString, parseAreaType, parsePathType };
