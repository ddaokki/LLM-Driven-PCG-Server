/**
 * Redis 세션 테스트 (기존 test_session.js 이전). 로컬 Redis(REDIS_URL, 기본 127.0.0.1:6379)가 없으면 skip.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const session = require("../sessionManager");

const userId = "test_player_123";
let available = false;

test.before(async () => {
  available = await session.waitUntilReady(1500);
  if (available) { await session.clearUser(userId); }
});
test.after(async () => {
  if (available) await session.clearUser(userId);
  await session.shutdown();
});

test("SESSION-01 노이즈 발화('네', '오케이...')는 적재되지 않음", async (t) => {
  if (!available) return t.skip("Redis 미연결");
  assert.equal(await session.updateHistory(userId, "네"), false);
  assert.equal(await session.updateHistory(userId, "오케이..."), false);
  assert.equal(await session.updateHistory(userId, "어둡고 나무가 많은 숲으로 가자."), true);
  const ctx = await session.getFullContext(userId);
  assert.deepEqual(ctx.recent_chat.split("\n").filter(Boolean), ["어둡고 나무가 많은 숲으로 가자."]);
});

test("SESSION-02 윈도우 10개 초과 시 핵심 키워드 발화는 보존", async (t) => {
  if (!available) return t.skip("Redis 미연결");
  for (let i = 1; i <= 9; i++) await session.updateHistory(userId, `일반 대화 데이터 로그 수집 중 ${i}`);
  await session.updateHistory(userId, "새로 유입된 11번째 일반 대화");
  const ctx = await session.getFullContext(userId);
  const chat = ctx.recent_chat.split("\n");
  assert.equal(chat.length, 10);
  assert.ok(chat[0].includes("어둡고 나무가 많은"));
  assert.ok(!chat.includes("일반 대화 데이터 로그 수집 중 1"), "핵심 키워드 없는 두 번째 항목이 밀려남");
});

test("SESSION-03 processLLMResponse: 보정 결과 + updated_background 저장", async (t) => {
  if (!available) return t.skip("Redis 미연결");
  const r = await session.processLLMResponse(userId, { pcg_json: { theme: "desert" }, updated_background: "사막을 지나는 중" });
  assert.equal(r.success, true);
  assert.equal(r.dataForUnreal.theme, "desert");
  const ctx = await session.getFullContext(userId);
  assert.equal(ctx.previous_background, "사막을 지나는 중");
});

test("SESSION-04 isAvailable()는 연결 상태를 반영", (t) => {
  if (!available) return t.skip("Redis 미연결");
  assert.equal(session.isAvailable(), true);
});
