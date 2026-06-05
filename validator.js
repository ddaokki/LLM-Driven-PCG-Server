/**
 * validator.js
 * LLM의 상대적 의도(비율)를 보존하는 수학적 보정 엔진 (합 정규화 및 스무딩 적용)
 */

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

  if (!aiData) {
    return {
      theme: CONFIG.theme,
      tree_density: CONFIG.density.tree.def,
      rock_density: CONFIG.density.rock.def,
      grass_density: CONFIG.density.grass.def,
      path_type: CONFIG.density.path_type,
      path_width: CONFIG.path_width.def,
      normalized_points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
      areas: []
    };
  }

  const validated = {};
  validated.theme = CONFIG.theme; // forest 고정

  // 2. [기법 ② 적용] 소프트 클램핑을 통한 1차 음수 제거 및 상한선 완화
  let rawTree = aiData.tree_density !== undefined ? softClamp(aiData.tree_density) : CONFIG.density.tree.def;
  let rawRock = aiData.rock_density !== undefined ? softClamp(aiData.rock_density) : CONFIG.density.rock.def;
  let rawGrass = aiData.grass_density !== undefined ? softClamp(aiData.grass_density) : CONFIG.density.grass.def;

  // 3. [기법 ① 적용] 밀도 합 정규화 (Density Sum Normalization)
  const totalSum = rawTree + rawRock + rawGrass;
  if (totalSum > CONFIG.density.max_total_sum) {
    // LLM이 의도한 비율(Ratio)을 유지하면서 총합 1.8 규격 내로 압축 스케일링
    const scaleFactor = CONFIG.density.max_total_sum / totalSum;
    rawTree *= scaleFactor;
    rawRock *= scaleFactor;
    rawGrass *= scaleFactor;
  }

  // 최종 밀도는 하한선 무결성 보장을 위해 클램프
  const finalClamp = (val, min, max) => Math.min(Math.max(val, min), max);
  validated.tree_density = finalClamp(rawTree, 0.0, 1.0);
  validated.rock_density = finalClamp(rawRock, 0.0, 1.0);
  validated.grass_density = finalClamp(rawGrass, 0.0, 1.0);

  // 4. 경로(Path) 데이터 보정
  validated.path_type = CONFIG.path_type;
  validated.path_width = finalClamp(aiData.path_width !== undefined ? aiData.path_width : CONFIG.path_width.def, CONFIG.path_width.min, CONFIG.path_width.max);

  // 이동 경로 노드 개수 스무딩 및 스케일링
  if (Array.isArray(aiData.normalized_points) && aiData.normalized_points.length >= CONFIG.points_count.min) {
    let points = aiData.normalized_points.slice(0, CONFIG.points_count.max);
    validated.normalized_points = points.map(pt => ({
      x: finalClamp(pt.x !== undefined ? pt.x : 0.5, 0.0, 1.0),
      y: finalClamp(pt.y !== undefined ? pt.y : 0.5, 0.0, 1.0)
    }));
  } else {
    validated.normalized_points = [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }];
  }

  // 5. 구역(Areas) 데이터 보정
  const validAreaTypes = ["start_zone", "combat_zone", "boss_zone"];

  if (Array.isArray(aiData.areas)) {
    validated.areas = aiData.areas.map(area => {
      let type = area.area_type;
      if (!validAreaTypes.includes(type)) type = "combat_zone"; // 오타 및 예외 매핑

      return {
        area_type: type,
        normalized_center: {
          x: finalClamp(area.normalized_center?.x !== undefined ? area.normalized_center.x : 0.5, 0.0, 1.0),
          y: finalClamp(area.normalized_center?.y !== undefined ? area.normalized_center.y : 0.5, 0.0, 1.0)
        },
        // 반지름 소프트 클램핑 적용
        normalized_radius: finalClamp(area.normalized_radius !== undefined ? softClamp(area.normalized_radius, CONFIG.radius.max) : CONFIG.radius.def, CONFIG.radius.min, CONFIG.radius.max),
        detail_density: finalClamp(area.detail_density !== undefined ? finalClamp(area.detail_density, 0.0, 1.0) : 0.5)
      };
    });
  } else {
    validated.areas = [];
  }

  return validated;
};

module.exports = { validatePCGParams };