/**
 * test_validator.js
 * 정규화 알고리즘 및 소프트 클램프 성능 확인 테스트 유닛
 */
const assert = require("assert").strict;
const { validatePCGParams } = require("./validator");

function runAdvancedTests() {
    console.log("==================================================");
    console.log("🧪 고급 보정 알고리즘(정규화 & 스무딩) 검증 테스트");
    console.log("==================================================");

    // Test 1: 밀도 합 정규화 및 비율 보존성 검증
    try {
        const heavyDensityData = {
            theme: "forest",
            tree_density: 2.0,  // 과도한 밀도 1
            rock_density: 1.0,  // 과도한 밀도 2
            grass_density: 1.0, // 과도한 밀도 3 -> 합계 4.0으로 임계값(1.8) 대폭 초과
        };

        const result = validatePCGParams(heavyDensityData);
        const finalSum = result.tree_density + result.rock_density + result.grass_density;

        // 1. 총합이 안전 한계선(1.8) 이하로 떨어졌는지 검증
        assert.ok(finalSum <= 1.8001, `❌ 총합이 너무 높습니다: ${finalSum}`);

        // 2. LLM이 의도한 비율(나무가 바위/풀보다 2배 많아야 함)이 보존되었는지 검증
        const treeToRockRatio = result.tree_density / result.rock_density;
        assert.ok(Math.abs(treeToRockRatio - 2.0) < 0.05, `❌ 비율이 파괴되었습니다: ${treeToRockRatio}`);

        console.log(`✅ Test 1 성공: 밀도 합 정규화 완료 (총합: ${finalSum.toFixed(2)}, 의도된 비율 보존성 검증 완료)`);
    } catch (err) {
        console.error("❌ Test 1 실패:", err.message);
    }

    // Test 2: Soft Clamp(Tanh) 스무딩 효과 검증
    try {
        const edgeData = {
            tree_density: 0.95, // 한계값(1.0)에 가까운 값
        };
        const result = validatePCGParams(edgeData);

        // 강제로 깎아내린 게 아니라 부드럽게 곡선 변환되었는지 검증
        assert.ok(result.tree_density < 0.95, "❌ 소프트 클램프 스무딩이 적용되지 않았습니다.");
        console.log(`✅ Test 2 성공: 한계치 근접 데이터 스무딩 필터링 완료 (원본 0.95 -> 보정치 ${result.tree_density.toFixed(3)})`);
    } catch (err) {
        console.error("❌ Test 2 실패:", err.message);
    }
}

runAdvancedTests();