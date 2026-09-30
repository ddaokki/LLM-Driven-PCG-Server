require("dotenv").config();
const express = require("express");
const {
  updateHistory,
  processLLMResponse,
  getFullContext,
} = require("./sessionManager");
const { validatePCGParams } = require("./validator");

const app = express();
app.use(express.json());

// 서버 상태 체크
app.get("/health", (req, res) => {
  res.json({ status: "running" });
});

/**
 * 0. 언리얼 클라이언트 실연동용 엔드포인트 (APCGZoneController가 실제로 호출하는 규격)
 *    - 요청: { "dialogue": [{ "speaker": "...", "text": "..." }, ...] }
 *    - 응답: 봉투(success/dataForUnreal) 없이 Zone JSON을 최상위로 그대로 반환
 *      (theme, tree_density, ..., areas: [...])
 *
 *    LLM 파트가 아직 HTTP API로 노출되지 않은 상태라, 지금은 dialogue를 받아서
 *    (있다면) 테스트용 pcg_json을 validator에 통과시키고, 없으면 기본 존을 반환한다.
 *    -> "테스트 JSON 넘기고 작동 확인" 수준의 실연동 시연에는 이걸로 충분하고,
 *       LLM API가 붙으면 dialogue -> LLM 호출 -> pcg_json 로 교체하면 된다.
 *
 *    [2026-09-30] combat_count(선택, 정수) 추가: pcg_json 없이 호출할 때 기본 존의
 *    combat 구역 개수를 지정할 수 있다. LLM이 아직 안 붙어서 dialogue 내용대로
 *    "전투 구역 여러 개"를 실제로 생성해볼 방법이 없었는데, 이 옵션으로 최소한
 *    /generate-zone 계약 자체는 combat 구역 개수가 가변이라는 걸 언리얼 쪽에서
 *    바로 확인할 수 있다. (예: {"combat_count": 3}) 안 보내면 기존과 동일하게
 *    combat 1개(총 3구역)짜리 데모 존을 반환한다.
 */
app.post("/generate-zone", (req, res) => {
  try {
    const { dialogue, pcg_json, combat_count } = req.body || {};
    if (dialogue !== undefined && !Array.isArray(dialogue)) {
      return res.status(400).json({ error: "dialogue는 배열이어야 합니다." });
    }

    // TODO(LLM API 연동 후): dialogue를 LLM 파이프라인에 넘겨 pcg_json을 실시간 생성
    const validated = validatePCGParams(pcg_json || null, { combatCount: combat_count });
    res.json(validated);
  } catch (error) {
    console.error("Generate Zone Error:", error);
    res.status(500).json(validatePCGParams(null));
  }
});

/**
 * 1. 유저 메시지 수신 및 맥락 반환
 * (유저/NPC 대화가 발생할 때마다 호출되어 Redis 윈도우를 갱신함)
 */
app.post("/api/chat/send", async (req, res) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ success: false, error: "userId와 message는 필수입니다." });
    }

    // 지능형 필터링 및 슬라이딩 윈도우 적재
    await updateHistory(userId, message);

    // AI 모델(강지석 님 파트)로 던질 때 필요한 '요약본 + 최근 10개 대화' 묶음 반환
    const context = await getFullContext(userId);
    res.json({ success: true, context });
  } catch (error) {
    console.error("Chat Send Error:", error);
    res.status(500).json({ success: false, error: "서버 내부 오류" });
  }
});

/**
 * 2. LLM 응답 수신 ➔ 데이터 보정 ➔ 언리얼 데이터 반환 (핵심 Core Loop)
 */
app.post("/api/world/generate", async (req, res) => {
  try {
    const { userId, llmResult } = req.body;
    if (!userId || !llmResult) {
      return res.status(400).json({ success: false, error: "userId와 llmResult는 필수입니다." });
    }

    // 합 정규화, 스무딩, 구역 타입 매핑 등 고급 보정 알고리즘 수행
    const result = await processLLMResponse(userId, llmResult);

    // 최종 보정된 안전한 데이터를 클라(언리얼)에 응답
    res.json(result);
  } catch (error) {
    console.error("World Generate Error:", error);
    res.status(500).json({ success: false, error: "서버 내부 오류" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});