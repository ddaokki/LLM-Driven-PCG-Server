require("dotenv").config();
const express = require("express");
const {
  updateHistory,
  processLLMResponse,
  getFullContext,
} = require("./sessionManager");

const app = express();
app.use(express.json());

// 서버 상태 체크
app.get("/health", (req, res) => {
  res.json({ status: "running" });
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