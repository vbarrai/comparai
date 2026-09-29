#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { findTestFiles, loadDuel, NotInRevision, TEST_FILE } from "./config.ts";
import { regressions, runDuel, sameContent, type DuelResult, type TestResult } from "./duel.ts";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const [bold, dim, blue, orange, red, green] = ["1", "2", "34", "33", "31", "32"].map(paint);

/** Jauge 0–100 : le curseur ● se déplace de A (gauche) vers B (droite). */
function gauge(score: number, width = 30): string {
  const pos = Math.round((score / 100) * (width - 1));
  const cells = Array.from({ length: width }, (_, i) => (i === pos ? bold("●") : i === width >> 1 ? dim("┼") : dim("─")));
  return `${blue("A")} ${cells.join("")} ${orange("B")}`;
}

function describe(score: number): string {
  if (score <= 10) return "A nettement meilleur";
  if (score < 40) return "A meilleur";
  if (score <= 60) return "équivalents";
  if (score < 90) return "B meilleur";
  return "B nettement meilleur";
}

function printTest(t: TestResult, i: number): string[] {
  const warnings = [];
  if (!t.consistent) warnings.push(orange("⚠ non fiable : Jev change d'avis selon l'ordre de présentation"));
  if (t.passA < 50 && t.passB < 50) warnings.push(orange("⚠ aucun des deux ne respecte ce test"));
  return [
    `  ${bold(`${i + 1}.`)} ${t.test}`,
    `     ${String(t.score).padStart(5)}  ${gauge(t.score, 20)}  respecté : ${blue("A")} ${t.passA} % · ${orange("B")} ${t.passB} %`,
    `            ${dim(`A→B ${t.ab} · B→A ${t.ba}`)}  ${warnings.join("  ")}`,
  ];
}

function printResult(result: DuelResult): void {
  console.log(
    [
      `  ${bold(`Score ${result.score}/100`)}  ${describe(result.score)}`,
      `  ${gauge(result.score, 40)}`,
      "",
      ...result.tests.flatMap(printTest),
      "",
      dim(`  2 appels à Jev · $${result.costUsd.toFixed(6)} · ${result.durationMs} ms`),
    ].join("\n"),
  );
}

type Status = "inchangé" | "nouveau" | "ok" | "régression" | "erreur";

/** Lance le duel d'un fichier de tests et l'affiche ; renvoie son statut pour le récapitulatif. */
async function runFile(file: string): Promise<{ status: Status; detail?: string }> {
  console.log(`\n${bold(path.relative(process.cwd(), file) || file)}`);
  try {
    const duel = await loadDuel(file);
    console.log(dim(`  A = ${duel.a.name} · B = ${duel.b.name}`));
    if (sameContent(duel)) {
      console.log(green("  Contenu identique : pas d'appel à Jev."));
      return { status: "inchangé" };
    }
    if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
      throw new Error("Clé Vercel AI Gateway absente : définissez AI_GATEWAY_API_KEY (shell, .env.local ou .env).");
    }
    const result = await runDuel(duel);
    console.log("");
    printResult(result);
    const lost = regressions(result);
    return lost.length
      ? { status: "régression", detail: `B meilleur sur le(s) test(s) ${lost.map((t) => result.tests.indexOf(t) + 1).join(", ")}` }
      : { status: "ok", detail: `score ${result.score}` };
  } catch (error) {
    const message = (error as Error).message;
    if (error instanceof NotInRevision) {
      console.log(dim(`  ${message} Pas de version de référence : duel ignoré.`));
      return { status: "nouveau" };
    }
    console.log(red(`  Erreur : ${message}`));
    return { status: "erreur", detail: message };
  }
}

const ICONS: Record<Status, string> = {
  inchangé: green("✓"),
  nouveau: dim("•"),
  ok: green("✓"),
  régression: red("✗"),
  erreur: red("✗"),
};

/**
 * `comparai [chemins…]` : chaque chemin est un fichier de tests ou un dossier
 * dans lequel chercher tous les `_test.yml` (par défaut, le dossier courant).
 */
async function main(): Promise<number> {
  // Les clés peuvent venir du shell (prioritaire), de .env.local ou de .env.
  for (const env of [".env.local", ".env"]) if (existsSync(env)) process.loadEnvFile(env);

  const targets = process.argv.slice(2);
  const files: string[] = [];
  for (const target of targets.length ? targets : ["."]) {
    if (!existsSync(target)) throw new Error(`Introuvable : ${target}`);
    files.push(...(statSync(target).isDirectory() ? await findTestFiles(path.resolve(target)) : [path.resolve(target)]));
  }
  if (!files.length) {
    console.log(`Aucun fichier ${TEST_FILE} trouvé.`);
    return 0;
  }

  const outcomes = [];
  for (const file of files) outcomes.push({ file, ...(await runFile(file)) });

  console.log(`\n${bold("Récapitulatif")}`);
  for (const o of outcomes) {
    const name = path.relative(process.cwd(), o.file) || o.file;
    console.log(`  ${ICONS[o.status]} ${o.status.padEnd(10)} ${name}${o.detail ? dim(`  ${o.detail}`) : ""}`);
  }
  console.log("");
  return outcomes.some((o) => o.status === "régression" || o.status === "erreur") ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Erreur : ${(error as Error).message}`);
    process.exit(1);
  },
);
