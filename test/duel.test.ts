import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Experimental_EvaluationMockModelV4 as MockEvaluationModel } from "ai/test";
import { findTestFiles, loadDuel, loadSkill, MAIN_BRANCH, mainBranch, NotInRevision, parseDuel, parseSource } from "../src/config.ts";
import { regressions, runDuel, sameContent } from "../src/duel.ts";
import { buildState } from "../src/jev.ts";

/** Duel de test : labeler-v1 (SKILL.md seul) contre labeler-v2 (avec taxonomie, un fichier caché et un binaire). */
function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "comparai-"));
  const write = (p: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), content);
  };
  write("skills/labeler-v1/SKILL.md", "Choisis un label.");
  write("skills/labeler-v2/SKILL.md", "Choisis un label de references/taxonomy.md.");
  write("skills/labeler-v2/references/taxonomy.md", "bug, feature");
  write("skills/labeler-v2/.notes.md", "caché");
  write("skills/labeler-v2/logo.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
  write("duel.yaml", "skill-a: ./skills/labeler-v1\nskill-b: ./skills/labeler-v2\ntests:\n  - t1\n  - t2\n  - t3\n");
  return path.join(root, "duel.yaml");
}
const example = fixture();

/** Faux Jev : `pick(state)` renvoie la position 0–4 et P(skill_1 respecte), P(skill_2 respecte). */
function mockJev(pick: (state: any) => [number, number, number]) {
  return new MockEvaluationModel({
    doEvaluate: async ({ state, questions }) => {
      const [score, p1, p2] = pick(state);
      const answers: Record<string, any> = {};
      for (const id of Object.keys(questions)) {
        if (id.endsWith("_skill_1")) answers[id] = { type: "boolean", probability: p1 };
        else if (id.endsWith("_skill_2")) answers[id] = { type: "boolean", probability: p2 };
        else answers[id] = { type: "score", score };
      }
      return { answers, usage: { inputTokens: 1000 }, warnings: [] };
    },
  });
}

const hasTaxonomy = (skill: { path: string }[]) => skill.some((f) => f.path === "references/taxonomy.md");

test("lecture du YAML et des skills (SKILL.md en premier, ni caché ni binaire)", async () => {
  const duel = await loadDuel(example);
  assert.equal(duel.a.name, "labeler-v1");
  assert.deepEqual(duel.b.files.map((f) => f.path), ["SKILL.md", "references/taxonomy.md"], "fichiers cachés et binaires exclus");
  assert.equal(duel.tests.length, 3);
});

test("références : local, local à une révision git, GitHub avec ou sans révision", () => {
  const src = (v: string) => parseSource(v, "skill-a", "/tmp/x");
  assert.deepEqual(src("./skills/a"), { kind: "local", dir: "/tmp/x/skills/a", ref: undefined });
  assert.deepEqual(src("."), { kind: "local", dir: "/tmp/x", ref: undefined });
  assert.deepEqual(src(".#master"), { kind: "local", dir: "/tmp/x", ref: "master" });
  assert.deepEqual(src("owner/repo/skills/b/"), { kind: "github", repo: "owner/repo", dir: "skills/b", ref: undefined });
  assert.deepEqual(src("owner/repo/skills/b#dev"), { kind: "github", repo: "owner/repo", dir: "skills/b", ref: "dev" });
  assert.throws(() => src(".#"), /révision vide/);
});

test("_test.yml réduit à « tests » : dossier courant contre la branche principale", () => {
  const d = parseDuel({ tests: ["t"] }, "/repo/skills/x");
  assert.deepEqual(d.a, { kind: "local", dir: "/repo/skills/x", ref: undefined });
  assert.deepEqual(d.b, { kind: "local", dir: "/repo/skills/x", ref: MAIN_BRANCH });
});

test("erreurs de configuration explicites", () => {
  assert.throws(() => parseDuel({ "skill-a": 3, tests: ["t"] }, "/tmp"), /skill-a/);
  assert.throws(() => parseDuel({ "skill-a": "labeler", "skill-b": "./b", tests: ["t"] }, "/tmp"), /ni un chemin local/);
  assert.throws(() => parseDuel({ "skill-a": "./a", "skill-b": "./b", tests: [] }, "/tmp"), /tests/);
});

test("skill GitHub : arborescence filtrée sur le dossier, fichiers lus via l'API", async (t) => {
  const tree = [
    { path: "README.md", type: "blob" },
    { path: "skills/pr/SKILL.md", type: "blob" },
    { path: "skills/pr/refs/guide.md", type: "blob" },
    { path: "skills/pr/refs", type: "tree" },
    { path: "skills/other/SKILL.md", type: "blob" },
  ];
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree }));
    return new Response(`contenu de ${url.split("/contents/")[1].split("?")[0]}`);
  });
  const skill = await loadSkill(parseSource("owner/repo/skills/pr", "skill-b", "/"));
  assert.equal(skill.name, "owner/repo/skills/pr");
  assert.deepEqual(skill.files, [
    { path: "SKILL.md", content: "contenu de skills/pr/SKILL.md" },
    { path: "refs/guide.md", content: "contenu de skills/pr/refs/guide.md" },
  ]);
  assert.equal(urls[0], "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1");
  assert.equal(urls[1], "https://api.github.com/repos/owner/repo/contents/skills/pr/SKILL.md?ref=HEAD");
});

/** Repo git temporaire dont la branche principale s'appelle `branch`, avec un skill commité. */
function tempRepo(branch: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "comparai-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const write = (p: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), text);
  };
  write("skills/labeler/SKILL.md", "v1");
  write("skills/labeler/references/taxonomy.md", "bug");
  write("skills/labeler/_test.yml", "tests: [t]\n");
  git("init", "-q", "-b", branch);
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "v1");
  git("checkout", "-q", "-b", "feature");
  return { root, write };
}

test("_test.yml : copie de travail contre la branche principale (déduite), fichier de tests exclu", async () => {
  const { root, write } = tempRepo("master");
  const dir = path.join(root, "skills", "labeler");
  assert.equal(await mainBranch(dir), "master");

  let duel = await loadDuel(path.join(dir, "_test.yml"));
  assert.equal(duel.b.name, "labeler#master");
  assert.ok(sameContent(duel), "rien n'a changé : pas besoin d'appeler Jev");

  write("skills/labeler/SKILL.md", "v2 (non commité)");
  duel = await loadDuel(path.join(dir, "_test.yml"));
  assert.ok(!sameContent(duel));
  assert.deepEqual(duel.a.files, [
    { path: "SKILL.md", content: "v2 (non commité)" },
    { path: "references/taxonomy.md", content: "bug" },
  ]);
  assert.deepEqual(duel.b.files, [
    { path: "SKILL.md", content: "v1" },
    { path: "references/taxonomy.md", content: "bug" },
  ]);
  await assert.rejects(loadSkill({ kind: "local", dir, ref: "nope" }), /Révision git introuvable : « nope »/);
});

test("nouveau skill absent de la branche principale → NotInRevision", async () => {
  const { root, write } = tempRepo("main");
  write("skills/neuf/SKILL.md", "neuf");
  write("skills/neuf/_test.yml", "tests: [t]\n");
  await assert.rejects(loadDuel(path.join(root, "skills/neuf/_test.yml")), NotInRevision);
});

test("découverte des _test.yml, hors dossiers cachés et node_modules", async () => {
  const { root, write } = tempRepo("main");
  write("node_modules/pkg/_test.yml", "tests: [t]\n");
  write(".cache/_test.yml", "tests: [t]\n");
  write("skills/autre/_test.yml", "tests: [t]\n");
  const found = (await findTestFiles(root)).map((f) => path.relative(root, f));
  assert.deepEqual(found, ["skills/autre/_test.yml", "skills/labeler/_test.yml"]);
});

test("le state n'envoie que le contenu, sous des noms neutres", async () => {
  const duel = await loadDuel(example);
  const state = JSON.stringify(buildState(duel.a, duel.b));
  assert.ok(!state.includes("labeler-v1") && !state.includes("labeler-v2"));
});

test("B (avec taxonomie) toujours préféré, dans les deux ordres → 100, cohérent", async () => {
  const duel = await loadDuel(example);
  const model = mockJev((s) => (hasTaxonomy(s.skill_2) ? [4, 0.1, 0.9] : [0, 0.9, 0.1]));
  const result = await runDuel(duel, model);
  assert.equal(result.score, 100);
  assert.deepEqual(result.tests[0], { test: duel.tests[0], ab: 100, ba: 100, score: 100, consistent: true, passA: 10, passB: 90 });
  assert.equal(regressions(result).length, duel.tests.length);
  assert.ok(Math.abs(result.costUsd - 2000 * 0.042e-6) < 1e-12);
});

test("biais de position pur (Jev préfère toujours skill_2) → 50, non fiable", async () => {
  const duel = await loadDuel(example);
  const result = await runDuel(duel, mockJev(() => [4, 0.5, 0.5]));
  assert.equal(result.score, 50);
  assert.equal(result.tests[0].consistent, false);
  assert.deepEqual([result.tests[0].ab, result.tests[0].ba], [100, 0]);
  assert.equal(regressions(result).length, 0, "un verdict non fiable n'est pas une régression");
});
