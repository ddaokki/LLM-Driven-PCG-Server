const { createClient } = require("redis");
const { validatePCGParams } = require("./validator");

const client = createClient();
client.on("error", (err) => console.error("Redis Client Error", err));
client.connect().catch(console.error);

// 최신 대화 로그 업데이트 (Sliding Window)
async function updateHistory(userId, newMessage) {
  const historyKey = `history:${userId}`;
  await client.rPush(historyKey, newMessage);
  const historyLen = await client.lLen(historyKey);
  if (historyLen > 10) {
    await client.lTrim(historyKey, -10, -1);
  }
}

// LLM 통합 JSON 처리 (검증 및 배경 정보 갱신)
async function processLLMResponse(userId, rawLLMData) {
  try {
    const { pcg_json, updated_background } = rawLLMData;

    // PCG 데이터 검증
    const validatedPCG = validatePCGParams(pcg_json);

    // 배경 정보 요약본 Redis 저장
    if (updated_background) {
      await client.set(`summary:${userId}`, updated_background);
    }

    return {
      success: true,
      dataForUnreal: validatedPCG,
    };
  } catch (error) {
    console.error("Processing Error:", error);
    return { success: false, dataForUnreal: validatePCGParams({}) };
  }
}

// 전체 맥락 조회 (요약본 + 최신 로그)
async function getFullContext(userId) {
  const summary =
    (await client.get(`summary:${userId}`)) || "이전 배경 정보 없음";
  const recentHistory = await client.lRange(`history:${userId}`, 0, -1);

  return {
    previous_background: summary,
    recent_chat: recentHistory.join("\n"),
  };
}

module.exports = { updateHistory, processLLMResponse, getFullContext };
