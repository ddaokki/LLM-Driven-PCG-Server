/**
 * sessionManager.js
 * Redis 기반 핵심 키워드 보존형 슬라이딩 윈도우 + 장기 배경(updated_background) 관리.
 *
 * v3 변경: Redis 장애 허용. 연결이 없거나 끊겨도 어떤 함수도 예외를 밖으로 던지지 않는다.
 *  - updateHistory → false, getFullContext → 기본 컨텍스트, processLLMResponse → 보정 결과(배경 저장만 생략)
 *  - 에러 로그는 상태가 바뀔 때 1회만 (ECONNREFUSED 로그 도배 방지)
 *  - /generate-zone(언리얼 연동)은 세션 없이도 정상 동작 (요구사항 분석서 비기능-2)
 */
const { createClient } = require("redis");
const { validatePCGParams } = require("./validator");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const WINDOW_SIZE = 10;

// 1. 의미 없는 노이즈 대화 필터링용 정규식
const NOISE_WORDS = /^(아|오|음|네|넵|오케이|그으|음어|확인|하하|물론이죠|글쎄요|\?|\!|\.)+$/i;

// 2. 짧아도 절대 버리면 안 되는 핵심 공간/지형 키워드 목록 (가중치 단어)
const CORE_KEYWORDS = [
  "왼쪽", "오른쪽", "동굴", "숲", "늪", "몬스터", "싸우자", "도망", "상자",
  "보스", "용암", "북쪽", "남쪽", "구석", "빽빽", "어둡", "위험", "안전",
  "사막", "초원", "설원", "눈", "바위", "전투",
];

let client = null;
let ready = false;
let lastLoggedState = null;
let connectPromise = null;

const logState = (state, detail) => {
  if (lastLoggedState === state) return;
  lastLoggedState = state;
  if (state === "up") console.log(`[session] Redis 연결됨 (${REDIS_URL})`);
  else console.warn(`[session] Redis 미연결 - 세션 기능 비활성, 핵심 엔드포인트는 정상 동작 (${detail || ""})`);
};

function getClient() {
  if (client) return client;
  client = createClient({
    url: REDIS_URL,
    socket: {
      connectTimeout: 1500,
      // 2번만 재시도 후 포기 → 이후 요청마다 lazy로 다시 시도 (연결 안 되면 조용히 비활성)
      reconnectStrategy: (retries) => (retries >= 2 ? false : 500),
    },
  });
  client.on("error", (err) => { ready = false; logState("down", err && err.code ? err.code : err && err.message); });
  client.on("ready", () => { ready = true; logState("up"); });
  client.on("end", () => { ready = false; });
  return client;
}

/** 연결 시도(여러 호출이 겹쳐도 한 번만). 성공 여부를 돌려주고 절대 throw하지 않음. */
async function ensureConnected() {
  const c = getClient();
  if (ready && c.isOpen) return true;
  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        if (!c.isOpen) await c.connect();
        ready = c.isReady;
        if (ready) logState("up");
        return ready;
      } catch (err) {
        ready = false;
        logState("down", err && (err.code || err.message));
        // 실패한 클라이언트는 버리고 다음 호출 때 새로 만든다 (redis v4는 실패한 connect 재사용이 불안정)
        try { if (c.isOpen) await c.disconnect(); } catch (_) { /* ignore */ }
        client = null;
        return false;
      } finally {
        connectPromise = null;
      }
    })();
  }
  return connectPromise;
}

const isAvailable = () => ready && !!client && client.isOpen;

/** 테스트/기동용: ms 안에 연결되면 true */
async function waitUntilReady(ms = 1500) {
  const p = ensureConnected();
  const t = new Promise((resolve) => setTimeout(() => resolve(false), ms));
  return Promise.race([p, t]);
}

async function shutdown() {
  if (client) {
    try { if (client.isOpen) await client.quit(); } catch (_) { /* ignore */ }
  }
  client = null; ready = false; connectPromise = null;
}

async function clearUser(userId) {
  if (!(await ensureConnected())) return false;
  try { await client.del([`history:${userId}`, `summary:${userId}`]); return true; } catch (_) { return false; }
}

/**
 * 대화 내용 필터링 및 Redis 적재 (Sliding Window). 적재됐으면 true.
 */
async function updateHistory(userId, message) {
  if (typeof message !== "string") return false;
  const trimmedMsg = message.trim();
  // [단계 A] 단순 감탄사나 공백 노이즈 필터링
  if (NOISE_WORDS.test(trimmedMsg) || trimmedMsg.length === 0) {
    console.log(`[Filter] 노이즈 대화 스킵됨: "${trimmedMsg}"`);
    return false;
  }
  if (!(await ensureConnected())) return false;
  const historyKey = `history:${userId}`;
  try {
    // [단계 B] Redis에 대화 추가
    await client.rPush(historyKey, trimmedMsg);

    // [단계 C] 슬라이딩 윈도우 10개 유지 관리
    const historyLen = await client.lLen(historyKey);
    if (historyLen > WINDOW_SIZE) {
      const oldestMsg = await client.lIndex(historyKey, 0);
      const hasCoreKeyword = CORE_KEYWORDS.some((keyword) => oldestMsg.includes(keyword));
      if (hasCoreKeyword) {
        // 중요 정보가 있다면 밀어내지 않고 두 번째 메시지를 제거하여 컨텍스트 유실 방지
        console.log(`[Context Preserve] 중요 키워드 감지로 노드 보존: "${oldestMsg}"`);
        const listEntries = await client.lRange(historyKey, 0, -1);
        listEntries.splice(1, 1);
        const multi = client.multi().del(historyKey);
        for (const entry of listEntries) multi.rPush(historyKey, entry);
        await multi.exec();
      } else {
        await client.lPop(historyKey);
      }
    }
    return true;
  } catch (err) {
    ready = false; logState("down", err && err.message);
    return false;
  }
}

/**
 * LLM 통합 JSON 처리 및 배경 요약 정보 반영 (내부용 /api/world/generate)
 */
async function processLLMResponse(userId, rawLLMData, options = {}) {
  try {
    const { pcg_json, updated_background } = rawLLMData || {};
    const validatedPCG = validatePCGParams(pcg_json, options);
    let backgroundSaved = false;
    if (updated_background && (await ensureConnected())) {
      try { await client.set(`summary:${userId}`, String(updated_background)); backgroundSaved = true; } catch (_) { backgroundSaved = false; }
    }
    return { success: true, dataForUnreal: validatedPCG, background_saved: backgroundSaved };
  } catch (error) {
    console.error("Processing Error:", error);
    return { success: false, dataForUnreal: validatePCGParams(null) };
  }
}

/**
 * 전체 맥락 조회 (AI 전송용 묶음 데이터). Redis 없으면 기본 컨텍스트.
 */
async function getFullContext(userId) {
  if (!(await ensureConnected())) {
    return { previous_background: "(세션 저장소 미연결)", recent_chat: "", session_available: false };
  }
  try {
    const summary = (await client.get(`summary:${userId}`)) || "이전 배경 정보 없음 (초기 상태)";
    const recentHistory = await client.lRange(`history:${userId}`, 0, -1);
    return { previous_background: summary, recent_chat: recentHistory.join("\n"), session_available: true };
  } catch (err) {
    ready = false; logState("down", err && err.message);
    return { previous_background: "(세션 저장소 오류)", recent_chat: "", session_available: false };
  }
}

module.exports = { updateHistory, processLLMResponse, getFullContext, isAvailable, waitUntilReady, shutdown, clearUser, CORE_KEYWORDS, NOISE_WORDS };
