/**
 * 병욱(Unreal)의 현재 PCG 구현 상황에 맞춘 데이터 보정
 */
const validatePCGParams = (aiData) => {
  const defaultParams = {
    theme: "plain",
    tree_density: 0.3,
    rock_density: 0.2,
    grass_density: 0.5,
  };

  if (!aiData) return defaultParams;

  // AI가 준 density 값을 병욱이가 필요한 개별 밀도로 분산하거나 보정
  return {
    theme: aiData.theme || defaultParams.theme,
    // AI가 준 전체 density를 기반으로 각 요소의 밀도를 계산 (보정 로직)
    tree_density: Math.min(
      Math.max(aiData.tree_density || aiData.density * 0.6 || 0.3, 0),
      1,
    ),
    rock_density: Math.min(
      Math.max(aiData.rock_density || aiData.density * 0.2 || 0.2, 0),
      1,
    ),
    grass_density: Math.min(
      Math.max(aiData.grass_density || aiData.density * 0.8 || 0.5, 0),
      1,
    ),
  };
};

module.exports = { validatePCGParams };
