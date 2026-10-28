const test = require("node:test");
const assert = require("node:assert/strict");
const { generateZoneCandidate, buildMessages, ZONE_SCHEMA } = require("../llmClient");

const dialogue = [
  { speaker: "npc", text: "다음 구역엔 어떤 곳이 있을 것 같아?" },
  { speaker: "player", text: "바위 많은 사막, 전투 2번" },
];
const okZone = {
  theme: "desert",
  base_environment: { tree_density: 0.05, rock_density: 0.7, grass_density: 0.1 },
  main_path: { path_type: "main", path_width: 600, normalized_points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] },
  combat_count: 1,
  areas: [
    { area_type: "spawn", normalized_center: { x: 0.1, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.2 },
    { area_type: "combat", normalized_center: { x: 0.5, y: 0.5 }, normalized_radius: 0.08, detail_density: 0.6 },
    { area_type: "goal", normalized_center: { x: 0.9, y: 0.5 }, normalized_radius: 0.06, detail_density: 0.4 },
  ],
};
const okResponse = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(okZone) } }] }), { status: 200, headers: { "content-type": "application/json" } });

test("LLM-01 vllm 정상 응답 → source=vllm, 후보는 LLM JSON", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return okResponse(); };
  const r = await generateZoneCandidate({ dialogue, mode: "vllm", apiUrl: "http://llm.test/v1", fetchImpl });
  assert.equal(r.source, "vllm");
  assert.equal(r.candidate.theme, "desert");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://llm.test/v1/chat/completions");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.response_format.type, "json_schema");
  assert.ok(body.messages.some((m) => m.role === "user" && m.content.includes("바위 많은 사막")));
});

test("LLM-02 500 응답 → rule 폴백 + llm_error", async () => {
  const fetchImpl = async () => new Response("boom", { status: 500 });
  const r = await generateZoneCandidate({ dialogue, mode: "vllm", apiUrl: "http://llm.test/v1", fetchImpl });
  assert.equal(r.source, "rule");
  assert.match(r.llm_error, /500/);
  assert.equal(r.candidate.theme, "desert");
});

test("LLM-03 타임아웃(50ms, fetch 무응답) → rule 폴백, 500ms 이내", async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const t0 = Date.now();
  const r = await generateZoneCandidate({ dialogue, mode: "vllm", apiUrl: "http://llm.test/v1", timeoutMs: 50, fetchImpl });
  assert.equal(r.source, "rule");
  assert.match(r.llm_error, /timeout|abort/i);
  assert.ok(Date.now() - t0 < 500);
});

test("LLM-04 잘못된 JSON 본문 → rule 폴백", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json {" } }] }), { status: 200 });
  const r = await generateZoneCandidate({ dialogue, mode: "vllm", apiUrl: "http://llm.test/v1", fetchImpl });
  assert.equal(r.source, "rule");
});

test("LLM-05 mode=rule → fetch 호출 없음", async () => {
  let called = 0;
  const r = await generateZoneCandidate({ dialogue, mode: "rule", apiUrl: "http://llm.test/v1", fetchImpl: async () => { called++; } });
  assert.equal(called, 0);
  assert.equal(r.source, "rule");
  assert.equal(r.candidate._intent.combatCount, 2);
});

test("LLM-06 mode=auto + apiUrl 없음 → rule, fetch 호출 없음", async () => {
  let called = 0;
  const r = await generateZoneCandidate({ dialogue, mode: "auto", apiUrl: "", fetchImpl: async () => { called++; } });
  assert.equal(called, 0);
  assert.equal(r.source, "rule");
});

test("LLM-07 seed/combatCount 옵션이 rule 후보에 반영", async () => {
  const a = await generateZoneCandidate({ dialogue, mode: "rule", seed: 3 });
  const b = await generateZoneCandidate({ dialogue, mode: "rule", seed: 3 });
  const c = await generateZoneCandidate({ dialogue, mode: "rule", seed: 4, combatCount: 4 });
  assert.deepEqual(a.candidate, b.candidate);
  assert.notDeepEqual(a.candidate.main_path, c.candidate.main_path);
  assert.equal(c.candidate.areas.filter((x) => x.area_type === "combat").length, 4);
});

test("LLM-08 buildMessages: system에 규칙, user에 대화+이전 배경", () => {
  const msgs = buildMessages({ dialogue, context: { previous_background: "이전엔 숲이었다", recent_chat: "a\nb" } });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /spawn/);
  assert.match(msgs[msgs.length - 1].content, /이전엔 숲이었다/);
  assert.match(msgs[msgs.length - 1].content, /player: 바위 많은 사막/);
});

test("LLM-09 ZONE_SCHEMA: theme enum 4종, areas enum 3종, combat_count 포함", () => {
  assert.deepEqual(ZONE_SCHEMA.properties.theme.enum, ["forest", "grassland", "desert", "snow"]);
  assert.deepEqual(ZONE_SCHEMA.properties.areas.items.properties.area_type.enum, ["spawn", "combat", "goal"]);
  assert.ok(ZONE_SCHEMA.required.includes("combat_count"));
});
