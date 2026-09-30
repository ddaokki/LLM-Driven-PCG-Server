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
        const { tree_density, rock_density, grass_density } = result.base_environment;
        const finalSum = tree_density + rock_density + grass_density;

        // 1. 정규화 이후 값이 각 에셋의 CONFIG min/max 범위 안에 있는지 검증
        assert.ok(tree_density <= 0.8 && tree_density >= 0.2, `❌ tree_density 범위 이탈: ${tree_density}`);
        assert.ok(rock_density <= 0.6 && rock_density >= 0.1, `❌ rock_density 범위 이탈: ${rock_density}`);
        assert.ok(grass_density <= 0.9 && grass_density >= 0.3, `❌ grass_density 범위 이탈: ${grass_density}`);

        console.log(`✅ Test 1 성공: 밀도 정규화 + 에셋별 하드 클램프 적용 완료 (총합: ${finalSum.toFixed(2)}, tree=${tree_density.toFixed(2)}, rock=${rock_density.toFixed(2)}, grass=${grass_density.toFixed(2)})`);
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
        assert.ok(result.base_environment.tree_density < 0.95, "❌ 소프트 클램프 스무딩이 적용되지 않았습니다.");
        console.log(`✅ Test 2 성공: 한계치 근접 데이터 스무딩 필터링 완료 (원본 0.95 -> 보정치 ${result.base_environment.tree_density.toFixed(3)})`);
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

    // Test 5: 언리얼 ApplyZoneJsonString()이 실제로 기대하는 최상위 스키마 검증
    // (base_environment / main_path 하위 중첩 - 최상위에 tree_density 등이 평평하게
    //  있으면 언리얼 쪽 TryGetObjectField가 실패해서 파싱이 통째로 깨진다. 과거 버전에서
    //  이 부분이 flat 구조였던 게 발견되어 고쳐졌으므로, 회귀 방지용으로 스키마를 고정한다.)
    try {
        const result = validatePCGParams(null); // defaultZone() 경로도 같이 검증
        assert.ok(result.base_environment && typeof result.base_environment === "object", "❌ base_environment 객체가 없음");
        assert.ok(result.main_path && typeof result.main_path === "object", "❌ main_path 객체가 없음");
        assert.ok(typeof result.base_environment.tree_density === "number", "❌ base_environment.tree_density 누락");
        assert.ok(Array.isArray(result.main_path.normalized_points), "❌ main_path.normalized_points 누락");
        assert.ok(result.tree_density === undefined, "❌ 최상위에 tree_density가 평평하게 남아있음 (언리얼 파싱 실패 원인)");
        assert.ok(result.normalized_points === undefined, "❌ 최상위에 normalized_points가 평평하게 남아있음");

        const withInput = validatePCGParams({ tree_density: 0.5, areas: [] });
        assert.ok(withInput.base_environment && typeof withInput.base_environment.tree_density === "number", "❌ 입력이 있을 때도 base_environment 중첩이 유지되어야 함");

        console.log("✅ Test 5 성공: 최상위 스키마가 언리얼 계약(base_environment/main_path 중첩)과 일치함");
    } catch (err) {
        console.error("❌ Test 5 실패:", err.message);
    }

    // Test 6: combat_count 옵션 - LLM 미연동 상태에서도 combat 구역 개수를 가변으로
    // 생성할 수 있는지 검증 (강지석 님 리포트: "전투구역이 시작-전투-끝 3개로 고정되는 것
    // 같다" -> areas 배열 자체는 가변 길이를 지원하지만, pcg_json 없이 호출할 때 쓰는
    // 기본 존이 원래 combat 1개짜리였던 게 원인이었음. combat_count로 재현/검증한다.)
    try {
        const zeroInput = validatePCGParams(null); // 옵션 없으면 기존과 동일 (combat 1개)
        const zeroCombat = zeroInput.areas.filter(a => a.area_type === "combat").length;
        assert.equal(zeroCombat, 1, `❌ combat_count 미지정 시 기존 동작(combat 1개)이 깨짐: ${zeroCombat}`);

        const multi = validatePCGParams(null, { combatCount: 3 });
        const multiCombat = multi.areas.filter(a => a.area_type === "combat").length;
        assert.equal(multiCombat, 3, `❌ combat_count=3 지정 시 combat 구역이 3개 생성되지 않음: ${multiCombat}`);
        assert.equal(multi.areas[0].area_type, "spawn", "❌ combat_count 지정 시에도 spawn이 첫 구역이어야 함");
        assert.equal(multi.areas[multi.areas.length - 1].area_type, "goal", "❌ combat_count 지정 시에도 goal이 마지막 구역이어야 함");
        assert.equal(multi.areas.length, 5, `❌ areas 총 개수가 예상(spawn+combat3+goal=5)과 다름: ${multi.areas.length}`);

        const zero = validatePCGParams(null, { combatCount: 0 });
        const zeroLen = zero.areas.filter(a => a.area_type === "combat").length;
        assert.equal(zeroLen, 0, `❌ combat_count=0 지정 시 combat 구역이 0개여야 함: ${zeroLen}`);
        assert.ok(zero.areas.some(a => a.area_type === "spawn") && zero.areas.some(a => a.area_type === "goal"),
            "❌ combat_count=0이어도 spawn/goal은 유지되어야 함");

        console.log(`✅ Test 6 성공: combat_count 옵션으로 combat 구역 개수 가변 생성 확인 (0개/1개(기본)/3개)`);
    } catch (err) {
        console.error("❌ Test 6 실패:", err.message);
    }
}

runAdvancedTests();