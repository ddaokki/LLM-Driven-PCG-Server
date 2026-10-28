const test = require("node:test");
const assert = require("node:assert/strict");
const { interpretDialogue, buildCandidateZone, hashDialogue, mulberry32 } = require("../dialogueInterpreter");
const { validatePCGParams } = require("../validator");
const { checkInvariants } = require("./helpers/invariants");

const dlg = (...texts) => texts.map((t, i) => ({ speaker: i % 2 === 0 ? "npc" : "player", text: t }));
const combats = (z) => z.areas.filter((a) => a.area_type === "combat");

test("RULE-01 '나무가 빽빽한 숲, 전투 3번' → forest, combat 3, tree 성향 높음", () => {
  const it = interpretDialogue(dlg("다음 구역은?", "어둡고 나무가 빽빽한 숲, 중간에 전투 3번 있으면 좋겠어"));
  assert.equal(it.theme, "forest");
  assert.equal(it.combatCount, 3);
  assert.ok(it.density.tree >= 0.7, `tree=${it.density.tree}`);
});

test("RULE-02 '전투 없이 탐험' → combat 0", () => {
  assert.equal(interpretDialogue(dlg("?", "전투 없이 조용히 탐험만 하고 싶어")).combatCount, 0);
});

test("RULE-03 한글 수사: '세 번 싸우고' → 3, '두 개의 전투' → 2", () => {
  assert.equal(interpretDialogue(dlg("?", "몬스터랑 세 번 싸우고 싶어")).combatCount, 3);
  assert.equal(interpretDialogue(dlg("?", "두 개의 전투 구역")).combatCount, 2);
});

test("RULE-04 테마 키워드: 사막/초원/설원, 영어도", () => {
  assert.equal(interpretDialogue(dlg("?", "바위투성이 사막")).theme, "desert");
  assert.equal(interpretDialogue(dlg("?", "넓은 초원")).theme, "grassland");
  assert.equal(interpretDialogue(dlg("?", "눈 덮인 설원")).theme, "snow");
  assert.equal(interpretDialogue(dlg("?", "a snowy mountain pass")).theme, "snow");
});

test("RULE-05 길 모양/폭, 강도, 크기", () => {
  const it = interpretDialogue(dlg("?", "좁고 구불구불한 길, 보스급으로 격렬한 큰 전투"));
  assert.equal(it.pathShape, "winding");
  assert.equal(it.pathWidth, "narrow");
  assert.equal(it.intensity, "high");
  assert.equal(it.areaSize, "large");
});

test("RULE-06 빈 dialogue / 비배열 / 텍스트 없음 → 기본 의도(forest, combat 1)", () => {
  for (const d of [[], null, undefined, "x", [{ speaker: "npc" }], [{ text: 42 }]]) {
    const it = interpretDialogue(d);
    assert.equal(it.theme, "forest");
    assert.equal(it.combatCount, 1);
  }
});

test("RULE-07 npc 질문의 키워드는 player 답변보다 약하게 반영", () => {
  // npc가 '사막'을 물었지만 player가 '숲'이라고 답함 → forest
  const it = interpretDialogue(dlg("사막으로 갈까?", "아니, 숲이 좋겠어"));
  assert.equal(it.theme, "forest");
});

test("RULE-08 hashDialogue 결정적, 내용 다르면 다름", () => {
  const a = hashDialogue(dlg("a", "b"));
  assert.equal(a, hashDialogue(dlg("a", "b")));
  assert.notEqual(a, hashDialogue(dlg("a", "c")));
  assert.ok(Number.isInteger(a) && a >= 0);
});

test("RULE-09 mulberry32: 같은 seed 같은 수열, [0,1)", () => {
  const r1 = mulberry32(42), r2 = mulberry32(42);
  for (let i = 0; i < 5; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test("RULE-10 buildCandidateZone: 같은 의도+seed → deepEqual, seed 다르면 경로 다름", () => {
  const it = interpretDialogue(dlg("?", "구불구불한 숲길, 전투 2번"));
  const z1 = buildCandidateZone(it, 7), z2 = buildCandidateZone(it, 7), z3 = buildCandidateZone(it, 8);
  assert.deepEqual(z1, z2);
  assert.notDeepEqual(z1.main_path.normalized_points, z3.main_path.normalized_points);
  assert.equal(z1.main_path.normalized_points.length, 8, "winding = 8점");
  assert.equal(z1.areas.filter((a) => a.area_type === "combat").length, 2);
});

test("RULE-11 후보 → validator 통과 후 combat 수/테마 보존, 불변식 만족 (seed 0~199)", () => {
  const cases = [
    ["나무가 빽빽한 숲, 전투 3번", "forest", 3],
    ["바위 많은 사막, 곧은 넓은 길, 전투 없이", "desert", 0],
    ["눈 내리는 설원, 구불구불, 전투 5번", "snow", 5],
    ["풀이 무성한 초원에서 한 번 싸우자", "grassland", 1],
  ];
  for (const [text, theme, n] of cases) {
    const it = interpretDialogue(dlg("?", text));
    for (let seed = 0; seed < 200; seed++) {
      const z = validatePCGParams(buildCandidateZone(it, seed));
      assert.equal(z.theme, theme, `${text} seed=${seed}`);
      assert.equal(combats(z).length, n, `${text} seed=${seed}`);
      assert.deepEqual(checkInvariants(z), [], `${text} seed=${seed}`);
    }
  }
});

test("RULE-12 후보 자체가 validator를 거의 안 거치게 생성됨(평균 보정 수 작음)", () => {
  const it = interpretDialogue(dlg("?", "숲, 전투 2번"));
  let total = 0;
  for (let seed = 0; seed < 100; seed++) {
    const z = validatePCGParams(buildCandidateZone(it, seed), { debug: true });
    total += z.validation_report.correction_count;
  }
  assert.ok(total / 100 < 2, `avg corrections ${total / 100}`);
});
