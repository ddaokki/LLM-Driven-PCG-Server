// Redis 없는 환경을 강제 (포트 1은 닫혀 있음) → 세션 기능 없이도 핵심 엔드포인트가 동작해야 함 (BE-T09)
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.LLM_MODE = "auto";
process.env.LLM_API_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");
const { applyZoneJsonString } = require("../unreal_parser_mock");
const { checkInvariants } = require("./helpers/invariants");
const session = require("../sessionManager");

let server, base;
test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await session.shutdown();
});

const post = async (path, body, headers = {}) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-json */ }
  return { status: res.status, json, text };
};
const combats = (z) => z.areas.filter((a) => a.area_type === "combat");

test("BE-T06 GET /health → {status:running}", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.status, "running");
  assert.equal(typeof j.llm_mode, "string");
  assert.equal(j.redis, false);
});

test("BE-T07 POST /generate-zone 빈 body → 200, 봉투 없는 Zone JSON, 언리얼 목 파서 통과", async () => {
  const r = await post("/generate-zone", {});
  assert.equal(r.status, 200);
  assert.equal(r.json.success, undefined);
  assert.equal(r.json.dataForUnreal, undefined);
  assert.equal(applyZoneJsonString(r.text).ok, true);
  assert.deepEqual(checkInvariants(r.json), []);
});

test("BE-T08 pcg_json(BD-03: 구버전 area_type + 문자열 밀도) → 보정 반영", async () => {
  const r = await post("/generate-zone", {
    pcg_json: {
      theme: "forest", tree_density: "0.5",
      main_path: { normalized_points: [{ x: 0.05, y: 0.5 }, { x: 0.95, y: 0.5 }] },
      areas: [
        { area_type: "spawn", normalized_center: { x: 0.05, y: 0.5 } },
        { area_type: "start_zone", normalized_center: { x: 0.3, y: 0.5 } },
        { area_type: "boss_zone", normalized_center: { x: 0.7, y: 0.5 } },
        { area_type: "goal", normalized_center: { x: 0.95, y: 0.5 } },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.base_environment.tree_density, 0.5);
  assert.deepEqual(r.json.areas.map((a) => a.area_type), ["spawn", "combat", "combat", "goal"]);
  assert.equal(applyZoneJsonString(r.text).ok, true);
});

test("BE-T11 combat_count 0/3 → combat 개수 가변", async () => {
  assert.equal(combats((await post("/generate-zone", { combat_count: 0 })).json).length, 0);
  assert.equal(combats((await post("/generate-zone", { combat_count: 3 })).json).length, 3);
});

test("BE-T13 dialogue '사막, 전투 2번' → theme desert, combat 2 (규칙 기반 해석)", async () => {
  const r = await post("/generate-zone", {
    dialogue: [
      { speaker: "npc", text: "다음 구역엔 어떤 곳이 있을 것 같아?" },
      { speaker: "player", text: "바위 많은 사막, 전투 2번 정도" },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.theme, "desert");
  assert.equal(combats(r.json).length, 2);
  assert.ok(r.json.base_environment.rock_density >= 0.5);
  assert.deepEqual(checkInvariants(r.json), []);
  assert.equal(applyZoneJsonString(r.text).ok, true);
});

test("BE-T14 같은 dialogue 두 번 → 같은 Zone (재현성), seed 주면 다른 Zone", async () => {
  const body = { dialogue: [{ speaker: "player", text: "구불구불한 숲길" }] };
  const a = await post("/generate-zone", body);
  const b = await post("/generate-zone", body);
  assert.deepEqual(a.json, b.json);
  const c = await post("/generate-zone", { ...body, seed: 99 });
  assert.notDeepEqual(a.json.main_path, c.json.main_path);
});

test("BE-T15 ?debug=1 → validation_report 포함(source/seed 포함), 없으면 부재", async () => {
  const body = { dialogue: [{ speaker: "player", text: "숲" }] };
  const d = await post("/generate-zone?debug=1", body);
  assert.ok(d.json.validation_report);
  assert.equal(d.json.validation_report.source, "rule");
  assert.equal(typeof d.json.validation_report.quality_score, "number");
  assert.equal(applyZoneJsonString(d.text).ok, true, "추가 필드가 있어도 언리얼 파싱은 성공");
  const n = await post("/generate-zone", body);
  assert.equal(n.json.validation_report, undefined);
});

test("BE-T16 잘못된 요청: dialogue가 배열 아님 → 400, JSON 문법 오류 → 400", async () => {
  assert.equal((await post("/generate-zone", { dialogue: "x" })).status, 400);
  const res = await fetch(base + "/generate-zone", { method: "POST", headers: { "content-type": "application/json" }, body: "{ bad json" });
  assert.equal(res.status, 400);
});

test("BE-T17 pcg_json이 깨진 값(문자열/배열/타입 오염) → 200 + 유효한 Zone", async () => {
  for (const pcg of ["garbage", [1, 2], { areas: "x", main_path: 5, tree_density: "abc" }]) {
    const r = await post("/generate-zone", { pcg_json: pcg });
    assert.equal(r.status, 200);
    assert.deepEqual(checkInvariants(r.json), []);
  }
});

test("BE-T09 Redis 미연결 상태에서 /api/chat/send → 503, /api/world/generate → 200 보정 결과", async () => {
  const c = await post("/api/chat/send", { userId: "u1", message: "숲으로 가자" });
  assert.equal(c.status, 503);
  const w = await post("/api/world/generate", { userId: "u1", llmResult: { pcg_json: { theme: "snow" } } });
  assert.equal(w.status, 200);
  assert.equal(w.json.success, true);
  assert.equal(w.json.dataForUnreal.theme, "snow");
});
