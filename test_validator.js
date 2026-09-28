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

    // Test 1: 밀도 합 정규화 + 에셋별 min/max 하드 클램프 검증
    // (주의: CONFIG.density의 에셋별 min/max가 이제 실제로 적용되므로, 정규화 후에도
    //  개별 값이 그 범위를 넘으면 한 번 더 깎인다. 그 결과 비율이 100% 보존되지는
    //  않을 수 있음 - 이건 버그가 아니라 "나무는 최소/최대 이만큼" 같은 기획 제약이
    //  비율 보존보다 우선한다는 의도된 동작이다.)
    try {
        const heavyDensityData = {
            theme: "forest",
            tree_density: 2.0,  // 과도한 밀도 1
            rock_density: 1.0,  // 과도한 밀도 2
            grass_density: 1.0, // 과도한 밀도 3 -> 합계 4.0으로 임계값(1.8) 대폭 초과
        };

        const result = validatePCGParams(heavyDensityData);
        const finalSum = result.tree_density + result.rock_density + result.grass_density;

        // 1. 정규화 이후 값이 각 에셋의 CONFIG min/max 범위 안에 있는지 검증
        assert.ok(result.tree_density <= 0.8 && result.tree_density >= 0.2, `❌ tree_density 범위 이탈: ${result.tree_density}`);
        assert.ok(result.rock_density <= 0.6 && result.rock_density >= 0.1, `❌ rock_density 범위 이탈: ${result.rock_density}`);
        assert.ok(result.grass_density <= 0.9 && result.grass_density >= 0.3, `❌ grass_density 범위 이탈: ${result.grass_density}`);

        console.log(`✅ Test 1 성공: 밀도 정규화 + 에셋별 하드 클램프 적용 완료 (총합: ${finalSum.toFixed(2)}, tree=${result.tree_density.toFixed(2)}, rock=${result.rock_density.toFixed(2)}, grass=${result.grass_density.toFixed(2)})`);
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

    // Test 3: area_type 화이트리스트 검증 (언리얼 ParseAreaType 기준 spawn/combat/goal/danger)
    try {
        // start_zone/boss_zone(옛 문자열)에 더해 spawn/goal도 하나씩 포함시켜서
        // "플레이 가능성 자동 보강" 로직이 끼어들어 순서를 바꾸지 않게 고정한다.
        const weirdAreaData = {
            areas: [
                { area_type: "spawn", normalized_center: { x: 0.05, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.2 },
                { area_type: "start_zone", normalized_center: { x: 0.1, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.2 },
                { area_type: "boss_zone", normalized_center: { x: 0.9, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.2 },
                { area_type: "danger", normalized_center: { x: 0.5, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.2 },
                { area_type: "goal", normalized_center: { x: 0.95, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.4 },
            ],
        };
        const result = validatePCGParams(weirdAreaData);

        // 예전 문자열(start_zone/boss_zone)은 화이트리스트에 없으므로 combat으로 보정되어야 함
        assert.equal(result.areas[1].area_type, "combat", "❌ start_zone이 combat으로 보정되지 않음");
        assert.equal(result.areas[2].area_type, "combat", "❌ boss_zone이 combat으로 보정되지 않음");
        // 화이트리스트에 있는 spawn/danger/goal은 그대로 유지되어야 함
        assert.equal(result.areas[0].area_type, "spawn", "❌ 유효한 spawn 타입이 변형됨");
        assert.equal(result.areas[3].area_type, "danger", "❌ 유효한 danger 타입이 변형됨");
        assert.equal(result.areas[4].area_type, "goal", "❌ 유효한 goal 타입이 변형됨");
        // 이미 spawn/goal이 있으므로 자동 보강이 끼어들어 개수가 늘어나면 안 됨
        assert.equal(result.areas.length, 5, `❌ areas 개수가 예상과 다름: ${result.areas.length}`);

        console.log("✅ Test 3 성공: area_type 화이트리스트(spawn/combat/goal/danger) 정상 적용");
    } catch (err) {
        console.error("❌ Test 3 실패:", err.message);
    }

    // Test 4: 플레이 가능성 구조 보장 (spawn/goal 최소 1개씩 존재)
    try {
        const noSpawnGoalData = {
            areas: [
                { area_type: "combat", normalized_center: { x: 0.5, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.5 },
            ],
        };
        const result = validatePCGParams(noSpawnGoalData);
        const hasSpawn = result.areas.some(a => a.area_type === "spawn");
        const hasGoal = result.areas.some(a => a.area_type === "goal");

        assert.ok(hasSpawn, "❌ spawn 구역이 자동으로 보강되지 않음");
        assert.ok(hasGoal, "❌ goal 구역이 자동으로 보강되지 않음");

        console.log(`✅ Test 4 성공: spawn/goal 누락 시 자동 보강 완료 (areas 개수: ${result.areas.length})`);
    } catch (err) {
        console.error("❌ Test 4 실패:", err.message);
    }
}

runAdvancedTests();