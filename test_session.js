/**
 * test_session.js
 * 레디스 컨텍스트 필터링 및 컨텍스트 보존 알고리즘 검증 스크립트
 */
const { updateHistory, getFullContext } = require("./sessionManager");
const { createClient } = require("redis");
const assert = require("assert").strict;

async function runSessionTest() {
    console.log("==================================================");
    console.log("🧪 Redis 컨텍스트 윈도우 및 지능형 필터링 테스트 시작");
    console.log("==================================================");

    const testUserId = "test_player_123";
    const client = createClient();
    await client.connect();

    // 이전 테스트 데이터 초기화
    await client.del(`history:${testUserId}`);
    await client.del(`summary:${testUserId}`);

    try {
        // Test 1: 노이즈 필터링 성능 확인
        console.log("-> Test 1: 노이즈 데이터 주입...");
        await updateHistory(testUserId, "네");
        await updateHistory(testUserId, "오케이...");
        await updateHistory(testUserId, "어둡고 나무가 많은 숲으로 가자."); // 정상 데이터

        const context1 = await getFullContext(testUserId);
        // "네", "오케이"는 무시되고 정상 메시지 1개만 남아야 함
        const chatArray1 = context1.recent_chat.split("\n").filter(Boolean);
        assert.equal(chatArray1.length, 1, "❌ 노이즈 필터가 대화를 걸러내지 못했습니다.");
        console.log("✅ Test 1 성공: 감탄사 및 공백 데이터 완벽 차단");

        // Test 2: 슬라이딩 윈도우 한계 도달 시 중요 단어 보존성 테스트
        console.log("\n-> Test 2: 슬라이딩 윈도우 임계치 초과 및 가중치 키워드 보존 테스트...");
        // 현재 1개 쌓여있음 + 일반 대화 9개 추가 주입 = 총 10개
        for (let i = 1; i <= 9; i++) {
            await updateHistory(testUserId, `일반 대화 데이터 로그 수집 중 ${i}`);
        }

        // 이 시점에서 0번 인덱스는 "어둡고 나무가 많은 숲으로 가자." (중요 키워드 포함)
        // 여기에 11번째 메시지를 주입하여 슬라이딩 윈도우 밀어내기 발생 유도
        await updateHistory(testUserId, "새로 유입된 11번째 일반 대화");

        const context2 = await getFullContext(testUserId);
        const chatArray2 = context2.recent_chat.split("\n");

        // 가장 오래되었지만 중요 단어가 포함된 0번 메시지가 살아있는지 검증
        assert.ok(chatArray2[0].includes("어둡고 나무가 많은"), "❌ 중요 키워드가 포함된 대화가 유실되었습니다.");
        console.log("✅ Test 2 성공: 윈도우 크기 초과 시에도 공간/방향 가중치 키워드 보존 완료");

    } catch (err) {
        console.error("❌ 테스트 실패:", err.message);
    } finally {
        // 테스트 종료 후 정리
        await client.del(`history:${testUserId}`);
        await client.disconnect();
        console.log("==================================================");
        console.log("📊 Redis 세션 및 맥락 필터링 테스트 종료");
        console.log("==================================================");
    }
}

runSessionTest();