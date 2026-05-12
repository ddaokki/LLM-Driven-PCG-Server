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

// 1. 유저 메시지 수신 및 맥락 반환
app.post("/api/chat/send", async (req, res) => {
  const { userId, message } = req.body;
  await updateHistory(userId, message);
  const context = await getFullContext(userId);
  res.json(context);
});

// 2. LLM 응답 처리 및 언리얼 데이터 반환
app.post("/api/world/generate", async (req, res) => {
  const { userId, llmResult } = req.body;
  const result = await processLLMResponse(userId, llmResult);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
