#!/usr/bin/env node
/**
 * scripts/demo.js — 발표/시연용. 서버를 임시 포트에 띄우고 /generate-zone 시나리오 4개를 실행해
 * "대화가 바뀌면 존이 바뀐다 / 깨진 LLM 출력도 언리얼이 읽는 존으로 복구된다"를 콘솔에서 보여준다.
 * 사용: npm run demo   (Redis/LLM 서버 없어도 동작)
 */
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const { createApp } = require("../app");
const { applyZoneJsonString } = require("../unreal_parser_mock");

const SCENARIOS = [
  {
    title: "① 숲 / 구불구불 / 전투 3번",
    body: { dialogue: [
      { speaker: "npc", text: "다음 구역엔 어떤 곳이 있을 것 같아?" },
      { speaker: "player", text: "어둡고 나무가 빽빽한 숲, 구불구불한 길, 중간에 전투 3번" },
    ] },
  },
  {
    title: "② 사막 / 곧고 넓은 길 / 전투 없음",
    body: { dialogue: [{ speaker: "player", text: "바위투성이 사막, 곧고 넓은 길, 전투 없이 탐험" }] },
  },
  {
    title: "③ 설원 / 보스급 큰 전투 두 번",
    body: { dialogue: [{ speaker: "player", text: "눈 덮인 설원에서 보스급으로 격렬한 큰 전투 두 번" }] },
  },
  {
    title: "④ 깨진 LLM 출력(pcg_json): 8자 경로, 모르는 테마, 밀도 2.5, 구역 3개 전부 겹침, spawn 없음",
    body: { pcg_json: {
      theme: "lava", tree_density: 2.5,
      main_path: { normalized_points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }] },
      areas: [
        { area_type: "goal", normalized_center: { x: 0.5, y: 0.5 }, normalized_radius: 0.3 },
        { area_type: "boss_zone", normalized_center: { x: 0.52, y: 0.5 }, normalized_radius: 0.3, detail_density: 0.9 },
        { area_type: "combat", normalized_center: { x: 0.5, y: 0.52 }, normalized_radius: 0.3, detail_density: 0.2 },
      ],
    } },
  },
];

function summarize(zone) {
  const p = zone.main_path.normalized_points;
  const be = zone.base_environment;
  const lines = [];
  lines.push(`  theme=${zone.theme}  tree/rock/grass=${be.tree_density}/${be.rock_density}/${be.grass_density}  path: ${p.length}점 width=${zone.main_path.path_width}`);
  lines.push(`  path: ${p.map((q) => `(${q.x},${q.y})`).join(" → ")}`);
  for (const a of zone.areas) lines.push(`  - ${a.area_type.padEnd(6)} center=(${a.normalized_center.x}, ${a.normalized_center.y}) r=${a.normalized_radius} detail=${a.detail_density}`);
  return lines.join("\n");
}

async function main() {
  const app = createApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const sc of SCENARIOS) {
      const res = await fetch(`${base}/generate-zone?debug=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sc.body) });
      const text = await res.text();
      const zone = JSON.parse(text);
      const rep = zone.validation_report; delete zone.validation_report;
      const ue = applyZoneJsonString(JSON.stringify(zone));
      console.log(`\n=== ${sc.title}`);
      if (rep.intent) console.log(`  intent: theme=${rep.intent.theme} combat=${rep.intent.combatCount} path=${rep.intent.pathShape}/${rep.intent.pathWidth} intensity=${rep.intent.intensity} size=${rep.intent.areaSize} seed=${rep.seed}`);
      console.log(summarize(zone));
      console.log(`  보정: source=${rep.source} 필수규칙 위반(보정 전)=${rep.hard_violations_before} 보정 ${rep.correction_count}건 품질점수=${rep.quality_score} | 언리얼 파서: ${ue.ok ? "OK" : "FAIL " + ue.reason} (combat ${ue.ok ? ue.data.expected_combat_area_count : "-"}개 → 전부 클리어 시 goal 활성화)`);
      if (rep.hard_violations.length) console.log(`  위반: ${rep.hard_violations.map((h) => h.detail).join(" / ")}`);
      for (const c of rep.corrections) console.log(`    · [${c.step}] ${c.target}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}  (${c.reason})`);
    }
  } finally {
    server.close();
    const session = require("../sessionManager");
    await session.shutdown();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
