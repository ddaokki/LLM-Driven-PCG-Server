/**
 * dialogueInterpreter.js
 * LLM(vLLM)이 아직 백엔드에 붙지 않은 상태에서도 "대화 내용이 실제로 Zone에 반영되는" 파이프라인을
 * 돌리기 위한 규칙 기반 해석기. 두 단계로 나뉜다.
 *
 *   interpretDialogue(dialogue) → Intent   : 한국어/영어 키워드로 테마·밀도 성향·길 모양·전투 수·강도·크기 추출
 *   buildCandidateZone(intent, seed) → Zone : 의도대로 경로/구역을 가진 "LLM이 낼 법한" 원본 Zone JSON 생성
 *
 * 후보는 그대로 validator.js를 통과한다(LLM 출력과 같은 자리). 난수는 전부 seed(mulberry32)로 재현되며,
 * seed를 안 주면 dialogue 해시를 쓰므로 같은 대화는 항상 같은 존을 만든다(시연·회귀 테스트에 유리).
 * LLM API가 연결되면 llmClient.js가 이 모듈을 폴백으로만 쓴다.
 */

const { getProfile, DEFAULT_THEME } = require("./lib/themes");
const g = require("./lib/geometry");

// ---------------------------------------------------------------- 난수/해시
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32bit. 대화 내용(화자+텍스트)으로 재현 가능한 seed를 만든다. */
function hashDialogue(dialogue) {
  const str = normalizeDialogue(dialogue).map((m) => `${m.speaker}:${m.text}`).join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function normalizeDialogue(dialogue) {
  if (!Array.isArray(dialogue)) return [];
  return dialogue
    .filter((m) => m && typeof m === "object" && typeof m.text === "string" && m.text.trim())
    .map((m) => ({ speaker: typeof m.speaker === "string" ? m.speaker.toLowerCase() : "unknown", text: m.text.trim() }));
}

// ---------------------------------------------------------------- 키워드 표
const THEME_KEYWORDS = {
  forest: ["숲", "삼림", "정글", "밀림", "forest", "jungle", "woods"],
  grassland: ["초원", "들판", "평원", "목초", "grassland", "meadow", "prairie", "plain"],
  desert: ["사막", "황야", "모래", "desert", "dune", "wasteland"],
  snow: ["설원", "설산", "눈", "빙하", "얼음", "snow", "ice", "glacier", "tundra", "frozen"],
};
const DENSITY_RULES = [
  { re: /빽빽|울창|우거|나무가? 많|숲이 깊|dense|thick/i, tree: +0.3 },
  { re: /어둡|어두운|dark|gloomy/i, tree: +0.1 },
  { re: /황량|트인|탁 트|나무가? 없|민둥|나무 적|sparse|open/i, tree: -0.3 },
  { re: /바위|돌|암석|절벽|rock|boulder|stone|cliff/i, rock: +0.3 },
  { re: /바위 없|돌 없|평탄|smooth/i, rock: -0.2 },
  { re: /풀이? 많|무성|풀밭|grass|lush/i, grass: +0.25 },
  { re: /풀이? 없|메마른|황폐|barren|dry/i, grass: -0.3 },
];
const KOREAN_NUMERALS = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8 };
const ENGLISH_NUMERALS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const COMBAT_WORDS = /전투|싸움|싸우|몬스터|적|보스|교전|battle|fight|combat|enemy|monster|boss/i;
const NO_COMBAT = /전투\s*(없이|없는|는 없|빼고)|싸움\s*없|평화|조용히|no (combat|fight|enem)|peaceful/i;
const MANY_COMBAT = /전투\s*(많이|여러|연속)|계속 싸우|쉴 새 없|many (fights|battles)|lots of (enem|combat)/i;
const MAX_COMBAT = 6;

const detectCombatCount = (text) => {
  if (NO_COMBAT.test(text)) return 0;
  const hasCombatWord = COMBAT_WORDS.test(text);
  // 아라비아 숫자: "전투 3번", "3회 전투", "전투 구역 2개"
  const digit = text.match(/(\d+)\s*(번|회|개|차례|군데|곳|times?|fights?|battles?|combats?)/i) || (hasCombatWord && text.match(/(\d+)/));
  if (digit) return Math.min(parseInt(digit[1], 10), MAX_COMBAT);
  if (hasCombatWord) {
    const kor = text.match(/(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟)\s*(번|개|차례|군데|곳|마리|의)?/);
    if (kor && KOREAN_NUMERALS[kor[1]]) return Math.min(KOREAN_NUMERALS[kor[1]], MAX_COMBAT);
    const eng = text.match(/\b(one|two|three|four|five|six)\b/i);
    if (eng) return ENGLISH_NUMERALS[eng[1].toLowerCase()];
    if (MANY_COMBAT.test(text)) return 3;
  }
  return null;
};

// ---------------------------------------------------------------- 의도 추출
function interpretDialogue(dialogue) {
  const msgs = normalizeDialogue(dialogue);
  const intent = {
    theme: DEFAULT_THEME,
    density: null,
    pathShape: "normal",
    pathWidth: "normal",
    combatCount: 1,
    intensity: "mid",
    areaSize: "mid",
    keywords: [],
  };
  const themeScore = {};
  const densityAdj = { tree: 0, rock: 0, grass: 0 };
  let combat = null;

  msgs.forEach((m, idx) => {
    const w = m.speaker === "player" ? 2 : 1;
    const text = m.text;
    for (const [theme, words] of Object.entries(THEME_KEYWORDS)) {
      for (const kw of words) {
        if (text.toLowerCase().includes(kw.toLowerCase())) {
          themeScore[theme] = (themeScore[theme] || 0) + w + idx * 0.01; // 동점이면 나중 발화 우선
          intent.keywords.push(kw);
        }
      }
    }
    for (const r of DENSITY_RULES) {
      if (r.re.test(text)) {
        for (const k of ["tree", "rock", "grass"]) if (r[k]) densityAdj[k] += r[k] * (w / 2);
        intent.keywords.push(r.re.source.split("|")[0]);
      }
    }
    if (/구불|굽이|꼬불|휘어|winding|curvy|twist/i.test(text)) intent.pathShape = "winding";
    else if (/곧은|곧게|직선|쭉 뻗|straight/i.test(text)) intent.pathShape = "straight";
    if (/넓은 길|넓고|넓은|wide|broad/i.test(text) && !/넓은 전투|넓은 구역/.test(text)) intent.pathWidth = "wide";
    if (/좁은|좁고|좁다|narrow/i.test(text)) intent.pathWidth = "narrow";
    if (/격렬|치열|위험|보스|강한 적|힘든|빡센|hard|intense|dangerous|brutal/i.test(text)) intent.intensity = "high";
    else if (/가벼운|약한|쉬운|살짝|easy|light|weak/i.test(text)) intent.intensity = "low";
    if (/큰 전투|넓은 전투|대규모|거대한|big (fight|battle)|large/i.test(text)) intent.areaSize = "large";
    else if (/작은 전투|소규모|작게|small|tiny/i.test(text)) intent.areaSize = "small";

    const c = detectCombatCount(text);
    if (c !== null && (m.speaker === "player" || combat === null)) combat = c;
  });

  const bestTheme = Object.entries(themeScore).sort((a, b) => b[1] - a[1])[0];
  if (bestTheme) intent.theme = bestTheme[0];
  if (combat !== null) intent.combatCount = combat;

  const prof = getProfile(intent.theme);
  intent.density = {
    tree: g.clamp(prof.tree.def + densityAdj.tree, 0, 1),
    rock: g.clamp(prof.rock.def + densityAdj.rock, 0, 1),
    grass: g.clamp(prof.grass.def + densityAdj.grass, 0, 1),
  };
  intent.keywords = [...new Set(intent.keywords)];
  return intent;
}

// ---------------------------------------------------------------- 후보 Zone 생성
const POINT_COUNT = { straight: 3, normal: 5, winding: 8 };
const WANDER = { straight: 0.03, normal: 0.08, winding: 0.15 };
const PATH_WIDTH = { narrow: 300, normal: 500, wide: 1000 };
const COMBAT_RADIUS = { small: 0.05, mid: 0.08, large: 0.12 };
const COMBAT_DETAIL = { low: 0.35, mid: 0.55, high: 0.8 };

const r4 = (v) => Math.round(v * 10000) / 10000;

function buildCandidateZone(intent, seed) {
  const rnd = mulberry32(seed >>> 0);
  const n = POINT_COUNT[intent.pathShape] || 5;
  const wander = WANDER[intent.pathShape] || 0.08;

  // 진행 방향 4종 중 택1 (왼→오, 오→왼, 위→아래, 아래→위). 언리얼 좌표계는 x 오른쪽, y 아래.
  const dir = Math.floor(rnd() * 4);
  let cross = 0.3 + rnd() * 0.4;
  const points = [];
  for (let i = 0; i < n; i++) {
    const along = 0.08 + (0.84 * i) / (n - 1) + (i === 0 || i === n - 1 ? 0 : (rnd() - 0.5) * 0.04);
    if (i > 0) cross = g.clamp(cross + (rnd() - 0.5) * 2 * wander, 0.12, 0.88);
    const a = dir === 1 || dir === 3 ? 1 - along : along;
    points.push(dir < 2 ? { x: r4(a), y: r4(cross) } : { x: r4(cross), y: r4(a) });
  }

  const combatN = Math.max(0, Math.min(Math.round(intent.combatCount), MAX_COMBAT));
  const baseR = COMBAT_RADIUS[intent.areaSize] || 0.08;
  const baseD = COMBAT_DETAIL[intent.intensity] || 0.55;
  const combats = [];
  for (let i = 0; i < combatN; i++) {
    const t = (i + 1) / (combatN + 1);
    const p = g.pointAtProgress(points, t);
    // 길 위 또는 길 옆(±0.04~0.08). 수직 방향은 국소 접선에서 계산.
    const ahead = g.pointAtProgress(points, Math.min(1, t + 0.02));
    const tx = ahead.x - p.x, ty = ahead.y - p.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len, ny = tx / len;
    const off = rnd() < 0.5 ? 0 : (0.04 + rnd() * 0.04) * (rnd() < 0.5 ? 1 : -1);
    combats.push({
      area_type: "combat",
      normalized_center: { x: r4(g.clamp(p.x + nx * off, 0.05, 0.95)), y: r4(g.clamp(p.y + ny * off, 0.05, 0.95)) },
      normalized_radius: r4(baseR + (rnd() - 0.5) * 0.02),
      detail_density: r4(g.clamp(baseD + i * 0.05 + (rnd() - 0.5) * 0.04, 0, 1)),
    });
  }

  return {
    theme: intent.theme,
    base_environment: {
      tree_density: r4(intent.density.tree),
      rock_density: r4(intent.density.rock),
      grass_density: r4(intent.density.grass),
    },
    main_path: {
      path_type: "main",
      path_width: Math.round((PATH_WIDTH[intent.pathWidth] || 500) + (rnd() - 0.5) * 100),
      normalized_points: points,
    },
    areas: [
      { area_type: "spawn", normalized_center: { ...points[0] }, normalized_radius: 0.05, detail_density: 0.2 },
      ...combats,
      { area_type: "goal", normalized_center: { ...points[points.length - 1] }, normalized_radius: 0.06, detail_density: 0.4 },
    ],
    _intent: intent,
    _seed: seed >>> 0,
  };
}

module.exports = { interpretDialogue, buildCandidateZone, hashDialogue, mulberry32, normalizeDialogue, MAX_COMBAT };
