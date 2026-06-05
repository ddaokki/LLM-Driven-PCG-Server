/**
 * sessionManager.js
 * Redis를 활용한 핵심 키워드 보존형 슬라이딩 윈도우 및 컨텍스트 관리 엔진
 */
const { createClient } = require("redis");
const { validatePCGParams } = require("./validator");

const client = createClient();
client.on("error", (err) => console.error("Redis Client Error", err));
client.connect().catch(console.error);

// 1. 의미 없는 노이즈 대화 필터링용 정규식
const NOISE_WORDS = /^(아|오|음|네|넵|오케이|그으|음어|확인|하하|물론이죠|글쎄요|\?|\!|\.)+$/i;

// 2. 짧아도 절대 버리면 안 되는 핵심 공간/지형 키워드 목록 (가중치 단어)
const CORE_KEYWORDS = [
  "왼쪽", "오른쪽", "동굴", "숲", "늪", "몬스터", "싸우자", "도망", "상자",
  "보스", "용암", "북쪽", "남쪽", "구석", "빽빽", "어둡", "위험", "안전"
];

/**
 * 대화 내용 필터링 및 Redis 적재 (Sliding Window)
 */
async function updateHistory(userId, message) {
  const historyKey = `history:${userId}`;

  // [단계 A] 단순 감탄사나 공백 노이즈 필터링
  const trimmedMsg = message.trim();
  if (NOISE_WORDS.test(trimmedMsg) || trimmedMsg.length === 0) {
    console.log(`[Filter] 노이즈 대화 스킵됨: "${trimmedMsg}"`);
    return; // 레디스에 적재하지 않고 버림
  }

  // [단계 B] Redis에 대화 추가
  await client.rPush(historyKey, trimmedMsg);

  // [단계 C] 슬라이딩 윈도우 10개 유지 관리
  let historyLen = await client.lLen(historyKey);

  if (historyLen > 10) {
    // 윈도우를 초과할 때, 가장 오래된 첫 번째 메시지가 핵심 키워드를 포함하고 있는지 검사
    const oldestMsg = await client.lIndex(historyKey, 0);
    const hasCoreKeyword = CORE_KEYWORDS.some(keyword => oldestMsg.includes(keyword));

    if (hasCoreKeyword) {
      // 중요 정보가 있다면 밀어내지 않고 두 번째 메시지를 제거하여 컨텍스트 유실 방지
      console.log(`[Context Preserve] 중요 키워드 감지로 노드 보존: "${oldestMsg}"`);
      // 인덱스 1번(두 번째 항목)을 임시 값으로 바꾸고 제거하는 방식 등으로 순서 제어
      const listEntries = await client.lRange(historyKey, 0, -1);
      // 두 번째 항목(인덱스 1)을 제외하고 다시 세팅
      await client.del(historyKey);
      listEntries.splice(1, 1);
      for (const entry of listEntries) {
        await client.rPush(historyKey, entry);
      }
    } else {
      // 일반 대화라면 앞에서부터 정상적으로 밀어냄 (Pop)
      await client.lPop(historyKey);
    }
  }
}

/**
 * LLM 통합 JSON 처리 및 배경 요약 정보 반영
 */
async function processLLMResponse(userId, rawLLMData) {
  try {
    const { pcg_json, updated_background } = rawLLMData;

    // 개편된 validator의 고급 정규화 보정 알고리즘 통과
    const validatedPCG = validatePCGParams(pcg_json);

    // LLM이 요약해 준 장기 문맥 배경 정보를 레디스에 갱신
    if (updated_background) {
      await client.set(`summary:${userId}`, updated_background);
    }

    return {
      success: true,
      dataForUnreal: validatedPCG,
    };
  } catch (error) {
    console.error("Processing Error:", error);
    // 에러 발생 시 시스템 붕괴를 막기 위한 완화 조치 (Default 템플릿 반환)
    return { success: false, dataForUnreal: validatePCGParams(null) };
  }
}

/**
 * 전체 맥락 조회 (AI 전송용 묶음 데이터)
 */
async function getFullContext(userId) {
  const summary = await client.get(`summary:${userId}`) || "이전 배경 정보 없음 (초기 상태)";
  const recentHistory = await client.lRange(`history:${userId}`, 0, -1);

  return {
    previous_background: summary,
    recent_chat: recentHistory.join("\n"),
  };
}

module.exports = { updateHistory, processLLMResponse, getFullContext };