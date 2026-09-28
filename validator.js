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

const validatePCGParams = (aiData) => {
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
    radius: { min: 0.01, max: 0.30, def: 0.05 }
  };

  // 언리얼 ParseAreaType() 기준 (spawn/combat/goal/danger). 다른 문자열은 전부 combat으로 보정.
  const validAreaTypes = ["spawn", "combat", "goal", "danger"];

  const defaultZone = () => ({
    theme: CONFIG.theme,
    tree_density: CONFIG.density.tree.def,
    rock_density: CONFIG.density.rock.def,
    grass_density: CONFIG.density.grass.def,
    path_type: CONFIG.path_type,
    path_width: CONFIG.path_width.def,
    normalized_points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
    areas: [
      { area_type: "spawn", normalized_center: { x: 0.1, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.2 },
      { area_type: "goal", normalized_center: { x: 0.9, y: 0.5 }, normalized_radius: 0.06, detail_density: 0.4 }
    ]
  });

  if (!aiData) {
    return defaultZone();
  }

  const validated = {};

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
  validated.tree_density = finalClamp(rawTree, CONFIG.density.tree.min, CONFIG.density.tree.max);
  validated.rock_density = finalClamp(rawRock, CONFIG.density.rock.min, CONFIG.density.rock.max);
  validated.grass_density = finalClamp(rawGrass, CONFIG.density.grass.min, CONFIG.density.grass.max);

  // 4. 경로(Path) 데이터 보정
  validated.path_type = CONFIG.path_type;
  validated.path_width = finalClamp(
    safeNumber(aiData.path_width, CONFIG.path_width.def),
    CONFIG.path_width.min,
    CONFIG.path_width.max
  );

  // 이동 경로 노드 개수 스무딩 및 스케일링
  if (Array.isArray(aiData.normalized_points) && aiData.normalized_points.length >= CONFIG.points_count.min) {
    let points = aiData.normalized_points.slice(0, CONFIG.points_count.max);
    validated.normalized_points = points.map(pt => ({
      x: finalClamp(safeNumber(pt && pt.x, 0.5), 0.0, 1.0),
      y: finalClamp(safeNumber(pt && pt.y, 0.5), 0.0, 1.0)
    }));
  } else {
    validated.normalized_points = [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }];
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
      normalized_center: { x: 0.1, y: 0.5 },
      normalized_radius: CONFIG.radius.def,
      detail_density: 0.2
    });
  }
  if (!hasType("goal")) {
    validated.areas.push({
      area_type: "goal",
      normalized_center: { x: 0.9, y: 0.5 },
      normalized_radius: CONFIG.radius.def,
      detail_density: 0.4
    });
  }

  return validated;
};

module.exports = { validatePCGParams };
