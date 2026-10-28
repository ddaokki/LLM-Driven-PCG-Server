// (리뷰 Important-2) vLLM 경로에서도 요청의 combat_count가 반영되어야 한다. 가짜 vLLM 서버를 띄워 검증.
process.env.REDIS_URL = "redis://127.0.0.1:1";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

let fake, server, base;
test.before(async () => {
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const zone = {
        theme: "forest", base_environment: { tree_density: 0.5, rock_density: 0.3, grass_density: 0.6 },
        main_path: { path_type: "main", path_width: 500, normalized_points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] },
        combat_count: 1,
        areas: [
          { area_type: "spawn", normalized_center: { x: 0.1, y: 0.5 }, normalized_radius: 0.05, detail_density: 0.2 },
          { area_type: "combat", normalized_center: { x: 0.5, y: 0.5 }, normalized_radius: 0.08, detail_density: 0.6 },
          { area_type: "goal", normalized_center: { x: 0.9, y: 0.5 }, normalized_radius: 0.06, detail_density: 0.4 },
        ],
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(zone) } }] }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  process.env.LLM_MODE = "vllm";
  process.env.LLM_API_URL = `http://127.0.0.1:${fake.address().port}/v1`;
  const { createApp } = require("../app");
  await new Promise((r) => { server = createApp().listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  await require("../sessionManager").shutdown();
});

test("BE-T18 vllm 후보(combat 1) + combat_count 3 → combat 3, source=vllm", async () => {
  const res = await fetch(`${base}/generate-zone?debug=1`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dialogue: [{ speaker: "player", text: "숲" }], combat_count: 3 }),
  });
  const z = await res.json();
  assert.equal(z.validation_report.source, "vllm");
  assert.equal(z.areas.filter((a) => a.area_type === "combat").length, 3);
});
