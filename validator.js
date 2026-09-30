/**
 * validator.js
 * LLM의 상대적 의도(비율)를 보존하는 수학적 보정 엔진 (합 정규화 및 스무딩 적용)
 */

// 0. 타입 안전장치: 문자열/null/NaN 등 비정형 입력이 들어와도 항상 유한한 숫자를 반환한다.
//    (이게 없으면 LLM이 "0.5" 같은 문자열이나 null을 보냈을 때 NaN이 그대로
//     전체 파이프라인을 타고 언리얼까지 전파될 수 있다.)
const safeNumber = (val, def) => {
  const n = typeof val === "number" ? val : parseFloat(val);
  return Number.isFinite(n) ? n : def;
};

// Sigmoid 스타일의 부드러운 스무딩 함수 (0~무한대 입력을 0~max 제한값으로 부드러운 매핑)
const softClamp = (val, max = 1.0) => {
  if (val <= 0) return 0;
  // 하이퍼볼릭 탄젠트를 이용한 부드러운 상한선 수렴
  return max * Math.tanh(val / max);
};

const validatePCGParams = (aiData, options = {}) => {
  // 1. 클라이언트(병욱) 요구사항 기반 도메인 제약 조건 정의
  const CONFIG = {
    theme: "forest",
    valid_themes: ["forest"], // 추후 테마 확장 시 여기에 추가
    path_type: "main",
    density: {
      tree: { min: 0.2, max: 0.8, def: 0.4 },
      rock: { min: 0.1, max: 0.6, def: 0.3 },
      grass: { min: 0.3, max: 0.9, def: 0.7 },
      max_total_sum: 1.8 // 세 밀도의 총합이 이 값을 넘으면 과도한 에셋 배치로 판정
    },
    path_width: { min: 100, max: 1500, def: 500 },
    points_count: { min: 2, max: 8, def_length: 2 },
    radius: { min: 0.01, max: 0.30, def: 0.05 },
    // LLM이 아직 안 붙었거나 normalized_points를 안 보냈을 때 쓰는 기본 경로.
    // README에 적어둔 연동 예시와 동일한 값으로 맞춰서, pcg_json 없이 테스트해도
    // 직선 한 줄이 아니라 자연스럽게 꺾이는 경로 + spawn/combat/goal이 다 보이는
    // 데모용 존이 나오게 함 (일직선 2점짜리는 시연할 때 밋밋해서 개선함)
    default_path_points: [
      { x: 0.05, y: 0.6 },
      { x: 0.5, y: 0.45 },
      { x: 0.95, y: 0.5 }
    ]
  };

  // 언리얼 ParseAreaType() 기준 (spawn/combat/goal/danger). 다른 문자열은 전부 combat으로 보정.
  const validAreaTypes = ["spawn", "combat", "goal", "danger"];

  // 주의: 언리얼 ApplyZoneJsonString()은 밀도/경로 값을 최상위가 아니라
  // base_environment / main_path 하위 객체에서 읽는다 (PCGZoneController.cpp
  // TryGetObjectField(TEXT("base_environment")/"main_path") 참고). 최상위에
  // 평평하게 내려주면 파싱 자체가 실패(및 false 반환)하므로 반드시 중첩시켜야 함.
  //
  // combatCount: LLM API가 아직 /generate-zone에 붙지 않아서(README 참고) dialogue를
  // 실제로 해석하지 못하는 동안에도, "전투 구역이 여러 개 생성되는" 시나리오를 데모/검증할
  // 수 있게 하는 옵션. 기본값 1(spawn+combat 1개+goal = 총 3개, 기존 동작과 동일)이며,
  // 값을 늘리면 combat 구역을 그만큼 경로상에 고르게 배치한 존을 반환한다.
  // (강지석/최병욱 공유: "전투구역이 시작-전투-끝 3개로 고정된다"는 건 이 데모 존이 원래
  // combat 1개짜리였기 때문이지, areas 배열 자체에 개수 제한이 걸려있던 건 아니다 - 아래
  // 5번 "구역(Areas) 데이터 보정" 로직은 원래부터 aiData.areas 길이를 그대로 통과시킨다.)
  const defaultZone = (combatCount = 1) => {
    const safeCombatCount = Math.max(0, Math.min(Math.round(safeNumber(combatCount, 1)), CONFIG.points_count.max));

    const combatAreas = [];
    for (let i = 0; i < safeCombatCount; i++) {
      // spawn(0.12)과 goal(0.85) 사이 구간에 combat 구역들을 고르게 분산 배치
      const t = safeCombatCount === 1 ? 0.5 : (i + 1) / (safeCombatCount + 1);
      const x = parseFloat((0.12 + t * (0.85 - 0.12)).toFixed(3));
      const y = parseFloat((0.5 + (i % 2 === 0 ? -0.05 : 0.05)).toFixed(3));
      combatAreas.push({
        area_type: "combat",
        normalized_center: { x, y },
        normalized_radius: 0.10,
        detail_density: 0.6
      });
    }

    return {
      theme: CONFIG.theme,
      base_environment: {
        tree_density: CONFIG.density.tree.def,
        rock_density: CONFIG.density.rock.def,
        grass_density: CONFIG.density.grass.def
      },
      main_path: {
        path_type: CONFIG.path_type,
        path_width: CONFIG.path_width.def,
        normalized_points: CONFIG.default_path_points
      },
      areas: [
        { area_type: "spawn", normalized_center: { x: 0.12, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.2 },
        ...combatAreas,
        { area_type: "goal", normalized_center: { x: 0.85, y: 0.48 }, normalized_radius: 0.06, detail_density: 0.4 }
      ]
    };
  };

  if (!aiData) {
    return defaultZone(options.combatCount);
  }

  const validated = { base_environment: {}, main_path: {} };

  // theme: 화이트리스트 통과 시에만 LLM 값 반영, 아니면 기본 forest로 보정
  validated.theme = CONFIG.valid_themes.includes(aiData.theme) ? aiData.theme : CONFIG.theme;

  // 2. [기법 ② 적용] 소프트 클램핑을 통한 1차 음수 제거 및 상한선 완화
  let rawTree = softClamp(safeNumber(aiData.tree_density, CONFIG.density.tree.def));
  let rawRock = softClamp(safeNumber(aiData.rock_density, CONFIG.density.rock.def));
  let rawGrass = softClamp(safeNumber(aiData.grass_density, CONFIG.density.grass.def));

  // 3. [기법 ① 적용] 밀도 합 정규화 (Density Sum Normalization)
  const totalSum = rawTree + rawRock + rawGrass;
  if (totalSum > CONFIG.density.max_total_sum) {
    // LLM이 의도한 비율(Ratio)을 유지하면서 총합 1.8 규격 내로 압축 스케일링
    const scaleFactor = CONFIG.density.max_total_sum / totalSum;
    rawTree *= scaleFactor;
    rawRock *= scaleFactor;
    rawGrass *= scaleFactor;
  }

  // 최종 밀도는 에셋별 허용 범위(min~max)로 클램프 (기획 의도: 나무는 최소 0.2는 있어야 숲처럼 보임 등)
  const finalClamp = (val, min, max) => Math.min(Math.max(val, min), max);
  validated.base_environment.tree_density = finalClamp(rawTree, CONFIG.density.tree.min, CONFIG.density.tree.max);
  validated.base_environment.rock_density = finalClamp(rawRock, CONFIG.density.rock.min, CONFIG.density.rock.max);
  validated.base_environment.grass_density = finalClamp(rawGrass, CONFIG.density.grass.min, CONFIG.density.grass.max);

  // 4. 경로(Path) 데이터 보정
  validated.main_path.path_type = CONFIG.path_type;
  validated.main_path.path_width = finalClamp(
    safeNumber(aiData.path_width, CONFIG.path_width.def),
    CONFIG.path_width.min,
    CONFIG.path_width.max
  );

  // 이동 경로 노드 개수 스무딩 및 스케일링
  if (Array.isArray(aiData.normalized_points) && aiData.normalized_points.length >= CONFIG.points_count.min) {
    let points = aiData.normalized_points.slice(0, CONFIG.points_count.max);
    validated.main_path.normalized_points = points.map(pt => ({
      x: finalClamp(safeNumber(pt && pt.x, 0.5), 0.0, 1.0),
      y: finalClamp(safeNumber(pt && pt.y, 0.5), 0.0, 1.0)
    }));
  } else {
    validated.main_path.normalized_points = CONFIG.default_path_points;
  }

  // 5. 구역(Areas) 데이터 보정
  if (Array.isArray(aiData.areas)) {
    validated.areas = aiData.areas.map(area => {
      const type = validAreaTypes.includes(area && area.area_type) ? area.area_type : "combat";

      return {
        area_type: type,
        normalized_center: {
          x: finalClamp(safeNumber(area && area.normalized_center && area.normalized_center.x, 0.5), 0.0, 1.0),
          y: finalClamp(safeNumber(area && area.normalized_center && area.normalized_center.y, 0.5), 0.0, 1.0)
        },
        // 반지름 소프트 클램핑 적용
        normalized_radius: finalClamp(
          softClamp(safeNumber(area && area.normalized_radius, CONFIG.radius.def), CONFIG.radius.max),
          CONFIG.radius.min,
          CONFIG.radius.max
        ),
        detail_density: finalClamp(safeNumber(area && area.detail_density, 0.5), 0.0, 1.0)
      };
    });
  } else {
    validated.areas = [];
  }

  // 6. 플레이 가능성 구조 검증: spawn/goal이 최소 1개씩은 있도록 보장한다.
  //    (combat은 없어도 게임이 깨지지 않으므로 강제하지 않음 - 평화로운 존도 유효한 설계)
  const hasType = (t) => validated.areas.some(a => a.area_type === t);
  if (!hasType("spawn")) {
    validated.areas.unshift({
      area_type: "spawn",
      normalized_center: { x: 0.12, y: 0.5 },
      normalized_radius: CONFIG.radius.def,
      detail_density: 0.2
    });
  }
  if (!hasType("goal")) {
    validated.areas.push({
      area_type: "goal",
      normalized_center: { x: 0.85, y: 0.48 },
      normalized_radius: CONFIG.radius.def,
      detail_density: 0.4
    });
  }

  return validated;
};

module.exports = { validatePCGParams };
