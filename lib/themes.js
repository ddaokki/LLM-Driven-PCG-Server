/**
 * lib/themes.js
 * 테마별 밀도 프로필. LLM(kjs1214/LLMDrivenPlayablePCG-LLM)은 forest/grassland/desert/snow
 * 4종을 출력하고, 언리얼은 theme 문자열을 로그로만 쓰므로 백엔드가 4종을 전부 통과시켜도
 * 파싱이 깨지지 않는다. 밀도 min/max는 "그 테마처럼 보이는 최소 조건"(기획 제약)이다.
 */

const THEMES = {
  forest:    { tree: { min: 0.2,  max: 0.8,  def: 0.4  }, rock: { min: 0.1, max: 0.6, def: 0.3  }, grass: { min: 0.3, max: 0.9, def: 0.7  } },
  grassland: { tree: { min: 0.0,  max: 0.25, def: 0.1  }, rock: { min: 0.0, max: 0.3, def: 0.1  }, grass: { min: 0.6, max: 1.0, def: 0.85 } },
  desert:    { tree: { min: 0.0,  max: 0.15, def: 0.05 }, rock: { min: 0.3, max: 0.9, def: 0.65 }, grass: { min: 0.0, max: 0.2, def: 0.1  } },
  snow:      { tree: { min: 0.05, max: 0.5,  def: 0.25 }, rock: { min: 0.1, max: 0.6, def: 0.35 }, grass: { min: 0.0, max: 0.25, def: 0.1 } },
};

const VALID_THEMES = Object.keys(THEMES);
const DEFAULT_THEME = "forest";

const getProfile = (theme) => THEMES[theme] || THEMES[DEFAULT_THEME];

/**
 * theme이 없거나 모르는 값일 때 밀도 패턴으로 테마 추정.
 * 각 테마 기본값(def)과의 유클리드 거리가 가장 가까운 테마를 고른다. 동률/입력 없음 → forest.
 */
function inferTheme(d = {}) {
  const keys = ["tree", "rock", "grass"];
  const have = keys.filter((k) => typeof d[k] === "number" && Number.isFinite(d[k]));
  if (!have.length) return DEFAULT_THEME;

  let best = DEFAULT_THEME;
  let bestDist = Infinity;
  for (const t of VALID_THEMES) {
    let s = 0;
    for (const k of have) s += (d[k] - THEMES[t][k].def) ** 2;
    if (s < bestDist - 1e-12) { bestDist = s; best = t; }
  }
  return best;
}

module.exports = { THEMES, VALID_THEMES, DEFAULT_THEME, getProfile, inferTheme };
