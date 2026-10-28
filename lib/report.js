/**
 * lib/report.js
 * validator가 어떤 값을 왜 바꿨는지 기록하는 보정 리포트.
 * - corrections: 단계별 {step, target, before, after, reason}
 * - hard_violations_before: 보정 전 입력이 어긴 "필수 규칙"(자기교차, spawn-goal 거리, 겹침 등) 수
 * - quality_score: 1 − 0.03×보정 수 − 0.1×필수 규칙 위반 수 (0 이하로는 안 내려감)
 *   → LLM 출력이 얼마나 "그대로 쓸 수 있는 상태"였는지의 대략적 지표. 발표/로그용.
 */
class CorrectionReport {
  constructor() {
    this.corrections = [];
    this.hardViolations = [];
  }

  add(step, target, before, after, reason) {
    this.corrections.push({ step, target, before, after, reason });
  }

  hard(step, detail) {
    this.hardViolations.push({ step, detail });
  }

  toJSON() {
    const score = 1 - 0.03 * this.corrections.length - 0.1 * this.hardViolations.length;
    return {
      correction_count: this.corrections.length,
      hard_violations_before: this.hardViolations.length,
      quality_score: Math.max(0, Math.round(score * 1000) / 1000),
      hard_violations: this.hardViolations,
      corrections: this.corrections,
    };
  }
}

module.exports = { CorrectionReport };
