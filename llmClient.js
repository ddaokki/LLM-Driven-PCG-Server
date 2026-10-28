/**
 * llmClient.js
 * dialogue → Zone 후보(JSON) 생성. 두 경로:
 *   - vllm : OpenAI 호환 chat/completions(vLLM)에 JSON Schema 강제로 요청. LLM 파트(kjs1214/LLMDrivenPlayablePCG-LLM)의
 *            app.py와 동일한 스키마/규칙을 쓰되, 입력을 3문항 폼 대신 dialogue 배열 + Redis 이전 배경으로 바꿨다.
 *   - rule : dialogueInterpreter.js 규칙 기반 (LLM 서버가 없거나 실패/타임아웃일 때 폴백)
 *
 * 모드: LLM_MODE = auto(기본) | vllm | rule
 *   auto는 LLM_API_URL이 있을 때만 vllm을 시도하고, 실패하면 rule로 폴백한다.
 * 어떤 경우에도 예외를 밖으로 던지지 않고 {candidate, source, llm_error?}를 돌려준다.
 */

const { interpretDialogue, buildCandidateZone, hashDialogue, normalizeDialogue } = require("./dialogueInterpreter");

const POINT = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
};

// LLM 레포 app.py SCHEMA와 동일 (combat_count를 areas보다 앞에 두어 전투 수를 먼저 정하게 하는 트릭 포함)
const ZONE_SCHEMA = {
  type: "object",
  properties: {
    theme: { type: "string", enum: ["forest", "grassland", "desert", "snow"] },
    base_environment: {
      type: "object",
      properties: { tree_density: { type: "number" }, rock_density: { type: "number" }, grass_density: { type: "number" } },
      required: ["tree_density", "rock_density", "grass_density"],
      additionalProperties: false,
    },
    main_path: {
      type: "object",
      properties: {
        path_type: { type: "string", enum: ["main"] },
        path_width: { type: "number" },
        normalized_points: { type: "array", items: POINT, minItems: 2, maxItems: 10 },
      },
      required: ["path_type", "path_width", "normalized_points"],
      additionalProperties: false,
    },
    combat_count: { type: "integer" },
    areas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          area_type: { type: "string", enum: ["spawn", "combat", "goal"] },
          normalized_center: POINT,
          normalized_radius: { type: "number" },
          detail_density: { type: "number" },
        },
        required: ["area_type", "normalized_center", "normalized_radius", "detail_density"],
        additionalProperties: false,
      },
    },
  },
  required: ["theme", "base_environment", "main_path", "combat_count", "areas"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `너는 플레이어와 NPC의 대화를 읽고, 다음 구역(Zone)의 레벨 레이아웃을 언리얼 PCG용 JSON으로 설계한다.

좌표계: 맵 전체를 0~1로 정규화한 2D 평면. x는 왼쪽(0)→오른쪽(1), y는 위(0)→아래(1).

[반드시 지킬 규칙]
- main_path는 spawn에서 시작해 goal에서 끝나는 하나의 이어진 길이다. normalized_points의 첫 점이 spawn 중심, 마지막 점이 goal 중심이다.
- spawn과 goal은 직선거리로 0.45 이상 떨어뜨린다.
- 길은 자기 자신과 교차하지 않고, 제자리로 확 꺾여 되돌아가지 않는다. 모든 좌표는 0.05~0.95 사이.
- combat_count에 대화에서 요청된 전투 횟수를 먼저 적는다. "3회", "세 번", "전투 3개"는 모두 3. 언급이 없으면 1, "전투 없이"면 0.
- areas에는 spawn 1개, goal 1개, combat은 정확히 combat_count개. combat 원의 가장자리는 길에서 0.12 이상 떨어지지 않게 한다.
- 전투끼리는 겹치지 않게 떨어뜨린다.
- density와 detail_density는 0.0~1.0, normalized_radius는 0.03~0.15, path_width는 200~1500(cm).

[대화 해석]
- player 발화를 가장 중요하게 본다. npc 발화는 질문/제안이므로 player가 동의한 경우에만 반영한다.
- "이전 배경"이 주어지면 서사적 연속성을 유지한다(갑자기 테마가 바뀌면 대화에 근거가 있어야 함).
- 곧은 길: 점이 적고 방향 변화가 작다. 구불구불한 길: 점이 많고 방향이 자주 바뀐다. 넓은 길 path_width 900 이상, 좁은 길 400 이하.
- 크기: 작은 영역 radius 0.03~0.06, 보통 0.06~0.09, 큰 0.10~0.15. 전투 강도: 약함 detail_density 0.3~0.4, 보통 0.5~0.6, 격함 0.7~0.9.
- 테마 성향: forest 나무 많음, grassland 나무 적고 풀 많음, desert 풀 거의 없고 바위 많음, snow 풀 거의 없음.

JSON만 출력한다.`;

function buildMessages({ dialogue, context }) {
  const msgs = normalizeDialogue(dialogue);
  const lines = msgs.map((m) => `${m.speaker}: ${m.text}`);
  const parts = [];
  if (context && context.previous_background) parts.push(`[이전 배경]\n${context.previous_background}`);
  if (context && context.recent_chat) parts.push(`[최근 대화 요약]\n${context.recent_chat}`);
  parts.push(`[이번 대화]\n${lines.length ? lines.join("\n") : "(대화 없음 - 기본 숲 구역을 자유롭게 설계)"}`);
  parts.push("위 대화를 반영한 다음 구역의 레이아웃 JSON을 출력하라.");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];
}

function ruleCandidate({ dialogue, seed, combatCount }) {
  const intent = interpretDialogue(dialogue);
  if (combatCount !== undefined && combatCount !== null && Number.isFinite(Number(combatCount))) {
    intent.combatCount = Math.max(0, Math.round(Number(combatCount)));
  }
  const s = seed !== undefined && seed !== null && Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : hashDialogue(dialogue);
  return buildCandidateZone(intent, s);
}

async function callVllm({ dialogue, context, apiUrl, model, timeoutMs, fetchImpl, seed }) {
  const url = `${apiUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      model: model || "default",
      messages: buildMessages({ dialogue, context }),
      temperature: 0.8,
      response_format: { type: "json_schema", json_schema: { name: "zone_layout", schema: ZONE_SCHEMA } },
    };
    if (seed !== undefined && seed !== null) body.seed = Number(seed) >>> 0;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY || "EMPTY"}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res || !res.ok) throw new Error(`LLM API HTTP ${res ? res.status : "no response"}`);
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== "string") throw new Error("LLM 응답에 choices[0].message.content 없음");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") throw new Error("LLM 응답이 객체가 아님");
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{candidate: object, source: 'vllm'|'rule', llm_error?: string}>}
 */
async function generateZoneCandidate(opts = {}) {
  const mode = (opts.mode || process.env.LLM_MODE || "auto").toLowerCase();
  const apiUrl = opts.apiUrl !== undefined ? opts.apiUrl : process.env.LLM_API_URL || "";
  const model = opts.model || process.env.LLM_MODEL || "";
  const timeoutMs = Number(opts.timeoutMs || process.env.LLM_TIMEOUT_MS || 8000);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  const tryLlm = mode === "vllm" || (mode === "auto" && apiUrl);
  if (tryLlm && apiUrl && typeof fetchImpl === "function") {
    try {
      const candidate = await callVllm({ dialogue: opts.dialogue, context: opts.context, apiUrl, model, timeoutMs, fetchImpl, seed: opts.seed });
      return { candidate, source: "vllm" };
    } catch (e) {
      const msg = e && e.name === "AbortError" ? `LLM API timeout(${timeoutMs}ms)` : String((e && e.message) || e);
      return { candidate: ruleCandidate(opts), source: "rule", llm_error: msg };
    }
  }
  const r = { candidate: ruleCandidate(opts), source: "rule" };
  if (tryLlm && !apiUrl) r.llm_error = "LLM_API_URL 미설정";
  return r;
}

module.exports = { generateZoneCandidate, buildMessages, ZONE_SCHEMA, SYSTEM_PROMPT };
