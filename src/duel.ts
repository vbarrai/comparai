import type { Duel } from "./config.ts";
import { askJev, USD_PER_INPUT_TOKEN, type Model } from "./jev.ts";

export interface TestResult {
  test: string;
  /** Curseur du point de vue de B (0 = A nettement meilleur, 100 = B nettement meilleur), selon l'ordre de présentation. */
  ab: number;
  ba: number;
  /** Moyenne des deux ordres. */
  score: number;
  /** Les deux ordres tombent-ils du même côté (sous 40, 40–60, au-dessus de 60) ? */
  consistent: boolean;
  /** Probabilité moyenne, en %, que A (resp. B) respecte le test. */
  passA: number;
  passB: number;
}

export interface DuelResult {
  tests: TestResult[];
  /** Moyenne des curseurs des tests. */
  score: number;
  costUsd: number;
  durationMs: number;
}

const side = (score: number) => (score < 40 ? -1 : score > 60 ? 1 : 0);
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Deux appels à Jev en parallèle : A présenté en premier, puis B.
 * Comparer les deux ordres révèle le biais de position ; le curseur final est leur moyenne.
 */
export async function runDuel(duel: Duel, model: Model = "typesafe-ai/jev"): Promise<DuelResult> {
  const started = Date.now();
  const [ab, ba] = await Promise.all([
    askJev(duel.a, duel.b, duel.tests, model), // A = skill_1
    askJev(duel.b, duel.a, duel.tests, model), // B = skill_1 : on inverse pour revenir au point de vue de B
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

/** Un test est une régression quand B (la référence, par défaut la branche principale) gagne nettement dans les deux ordres. */
export function regressions(result: DuelResult): TestResult[] {
  return result.tests.filter((t) => t.consistent && t.score > 60);
}

/** Deux skills au contenu identique : inutile d'appeler Jev. */
export function sameContent(duel: Duel): boolean {
  return JSON.stringify(duel.a.files) === JSON.stringify(duel.b.files);
}
