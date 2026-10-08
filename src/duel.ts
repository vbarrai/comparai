import type { Duel } from "./config.ts";
import { askJev, USD_PER_INPUT_TOKEN, type Model } from "./jev.ts";

export interface TestResult {
  test: string;
  /** Cursor from B's point of view (0 = A clearly better, 100 = B clearly better), per presentation order. */
  ab: number;
  ba: number;
  /** Mean of both orders. */
  score: number;
  /** Do both orders land on the same side (below 40, 40–60, above 60)? */
  consistent: boolean;
  /** Mean probability, in %, that A (resp. B) meets the test. */
  passA: number;
  passB: number;
}

export interface DuelResult {
  tests: TestResult[];
  /** Mean of the tests' cursors. */
  score: number;
  costUsd: number;
  durationMs: number;
}

const side = (score: number) => (score < 40 ? -1 : score > 60 ? 1 : 0);
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Two parallel calls to Jev: A presented first, then B.
 * Comparing both orders reveals position bias; the final cursor is their mean.
 */
export async function runDuel(duel: Duel, model: Model = "typesafe-ai/jev"): Promise<DuelResult> {
  const started = Date.now();
  const [ab, ba] = await Promise.all([
    askJev(duel.a, duel.b, duel.tests, model), // A = skill_1
    askJev(duel.b, duel.a, duel.tests, model), // B = skill_1: inverted to get back to B's point of view
  ]);

  const tests = duel.tests.map((test, i): TestResult => {
    const x = ab.answers[i];
    const y = ba.answers[i];
    const abScore = x.score;
    const baScore = 100 - y.score;
    return {
      test,
      ab: round(abScore),
      ba: round(baScore),
      score: round((abScore + baScore) / 2),
      consistent: side(abScore) === side(baScore),
      passA: round(((x.pass1 + y.pass2) / 2) * 100),
      passB: round(((x.pass2 + y.pass1) / 2) * 100),
    };
  });

  return {
    tests,
    score: round(tests.reduce((sum, t) => sum + t.score, 0) / tests.length),
    costUsd: (ab.inputTokens + ba.inputTokens) * USD_PER_INPUT_TOKEN,
    durationMs: Date.now() - started,
  };
}

/** A test is a regression when B (the reference, by default the main branch) clearly wins in both orders. */
export function regressions(result: DuelResult): TestResult[] {
  return result.tests.filter((t) => t.consistent && t.score > 60);
}

/** Two skills with identical content: no need to call Jev. */
export function sameContent(duel: Duel): boolean {
  return JSON.stringify(duel.a.files) === JSON.stringify(duel.b.files);
}
