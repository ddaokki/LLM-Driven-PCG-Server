require("dotenv").config();
const express = require("express");
const session = require("./sessionManager");
const { validateWithReport, validatePCGParams } = require("./validator");
const { generateZoneCandidate } = require("./llmClient");

const DEFAULT_USER_ID = "unreal-test";

function createApp() {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // 서버 상태 체크 (+ 연동 상태 한눈에)
  app.get("/health", (req, res) => {
    res.json({
      status: "running",
      llm_mode: process.env.LLM_MODE || "auto",
      llm_api_url_set: !!process.env.LLM_API_URL,
      redis: session.isAvailable(),
    });
  });

  /**
   * 0. 언리얼 클라이언트 실연동용 엔드포인트 (APCGZoneController::RequestZoneDataFromBackend 규격)
   *    요청: { dialogue: [{speaker, text}], userId?, pcg_json?, combat_count?, seed? }
   *    응답: 봉투 없이 Zone JSON 최상위 그대로 (theme/base_environment/main_path/areas)
   *          ?debug=1 이면 validation_report(보정 내역/품질 점수/후보 출처)를 추가 필드로 붙임
   *
   *    흐름: dialogue 세션 적재(가능할 때) → 후보 생성(pcg_json > vLLM > 규칙 기반) → validator v3 → 응답
   */
  app.post("/generate-zone", async (req, res) => {
    const debug = req.query.debug === "1" || req.query.debug === "true";
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const { dialogue, pcg_json, combat_count, seed } = body;
      if (dialogue !== undefined && !Array.isArray(dialogue)) {
        return res.status(400).json({ error: "dialogue는 배열이어야 합니다." });
      }
      const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : DEFAULT_USER_ID;

      // 세션 적재(best-effort): 언리얼이 보낸 player 발화를 히스토리에 쌓고, 누적 맥락을 LLM 프롬프트에 전달
      if (Array.isArray(dialogue)) {
        for (const m of dialogue) {
          if (m && typeof m.text === "string" && String(m.speaker).toLowerCase() === "player") {
            await session.updateHistory(userId, m.text);
          }
        }
      }
      const context = await session.getFullContext(userId);

      let candidate, source, llmError;
      if (pcg_json !== undefined && pcg_json !== null) {
        candidate = pcg_json; source = "pcg_json";
      } else {
        const r = await generateZoneCandidate({ dialogue: dialogue || [], context, seed, combatCount: combat_count });
        candidate = r.candidate; source = r.source; llmError = r.llm_error;
      }

      // pcg_json을 직접 준 경우에만 combat_count를 validator 옵션으로 넘긴다(후보 생성 경로에서는 이미 반영됨)
      const options = source === "pcg_json" && combat_count !== undefined ? { combatCount: combat_count } : {};
      const { zone, report } = validateWithReport(candidate, options);

      console.log(`[generate-zone] user=${userId} source=${source} corrections=${report.correction_count} hard=${report.hard_violations_before} score=${report.quality_score} combats=${zone.areas.filter((a) => a.area_type === "combat").length}${llmError ? ` llm_error="${llmError}"` : ""}`);

      if (debug) {
        zone.validation_report = {
          source,
          llm_error: llmError,
          seed: candidate && candidate._seed,
          intent: candidate && candidate._intent,
          session_available: context.session_available === true,
          ...report,
        };
      }
      res.json(zone);
    } catch (error) {
      console.error("Generate Zone Error:", error);
      // 어떤 경우에도 언리얼이 파싱 가능한 기본 존을 돌려준다 (요구사항: 장애 대응 Fallback JSON)
      res.status(200).json(validatePCGParams(null));
    }
  });

  /**
   * 1. 유저 메시지 수신 및 맥락 반환 (내부용 - Redis 필요)
   */
  app.post("/api/chat/send", async (req, res) => {
    try {
      const { userId, message } = req.body || {};
      if (!userId || !message) {
        return res.status(400).json({ success: false, error: "userId와 message는 필수입니다." });
      }
      if (!(await session.waitUntilReady(500))) {
        return res.status(503).json({ success: false, error: "세션 저장소(Redis) 미연결" });
      }
      await session.updateHistory(userId, message);
      const context = await session.getFullContext(userId);
      res.json({ success: true, context });
    } catch (error) {
      console.error("Chat Send Error:", error);
      res.status(500).json({ success: false, error: "서버 내부 오류" });
    }
  });

  /**
   * 2. LLM 응답 수신 ➔ 데이터 보정 ➔ 언리얼 데이터 반환 (내부용)
   */
  app.post("/api/world/generate", async (req, res) => {
    try {
      const { userId, llmResult } = req.body || {};
      if (!userId || !llmResult) {
        return res.status(400).json({ success: false, error: "userId와 llmResult는 필수입니다." });
      }
      const result = await session.processLLMResponse(userId, llmResult, { debug: req.query.debug === "1" });
      res.json(result);
    } catch (error) {
      console.error("World Generate Error:", error);
      res.status(500).json({ success: false, error: "서버 내부 오류" });
    }
  });

  // JSON 문법 오류 등 body-parser 에러 → 400
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.type === "entity.parse.failed" || err.status === 400)) {
      return res.status(400).json({ error: "요청 본문이 올바른 JSON이 아닙니다." });
    }
    console.error("Unhandled Error:", err);
    res.status(500).json({ error: "서버 내부 오류" });
  });

  return app;
}

if (require.main === module) {
  const PORT = process.env.PORT || 8000;
  createApp().listen(PORT, () => {
    console.log(`Server running on port ${PORT} (LLM_MODE=${process.env.LLM_MODE || "auto"}, LLM_API_URL=${process.env.LLM_API_URL ? "set" : "unset → 규칙 기반 해석기"})`);
    session.waitUntilReady(2000); // 기동 시 한 번 연결 시도 (실패해도 서버는 계속 동작)
  });
}

module.exports = { createApp };
