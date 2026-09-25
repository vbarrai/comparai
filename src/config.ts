import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

const exec = promisify(execFile);

export interface Skill {
  /** Nom affiché dans le résumé (jamais envoyé à Jev). */
  name: string;
  files: { path: string; content: string }[];
}

export interface Duel {
  a: Skill;
  b: Skill;
  tests: string[];
}

/** Le dossier du skill n'existe pas dans la révision demandée (typiquement : nouveau skill, pas encore sur la branche principale). */
export class NotInRevision extends Error {}

/** Révision spéciale : la branche principale du repo, déduite au moment du chargement (voir `mainBranch`). */
export const MAIN_BRANCH = "@main-branch";

/**
 * Où trouver un skill :
 * - `local` : un dossier, dans son état actuel ou (avec `ref`) tel qu'il est dans une révision git ;
 * - `github` : un dossier d'un repo GitHub (`repo` = owner/repo), sur la branche par défaut ou `ref`.
 */
export type SkillSource =
  | { kind: "local"; dir: string; ref?: string }
  | { kind: "github"; repo: string; dir: string; ref?: string };

/**
 * Garde les fichiers texte (SKILL.md en premier), sauf les fichiers et dossiers cachés et `exclude`.
 * `read` lit un fichier à partir de son chemin relatif au skill (« / » comme séparateur).
 */
async function buildSkill(
  name: string,
  paths: string[],
  read: (p: string) => Promise<Buffer>,
  exclude?: string,
): Promise<Skill> {
  const kept = paths
    .filter((p) => p !== exclude && !p.split("/").some((part) => part.startsWith(".")))
    .sort((x, y) => Number(y === "SKILL.md") - Number(x === "SKILL.md") || x.localeCompare(y));
  if (kept[0] !== "SKILL.md") throw new Error(`SKILL.md absent dans ${name}`);

  const files = [];
  for (const p of kept) {
    const buffer = await read(p);
    if (buffer.includes(0)) continue; // binaire
    files.push({ path: p, content: buffer.toString("utf8") });
  }
  return { name, files };
}

async function loadFromDisk(dir: string, exclude?: string): Promise<Skill> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => {
    throw new Error(`Dossier de skill introuvable : ${dir}`);
  });
  const paths = entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
  return buildSkill(path.basename(dir), paths, (p) => readFile(path.join(dir, p)), exclude);
}

/** Le dossier tel qu'il est dans la révision git `ref` (branche, tag, commit). */
async function loadFromGit(dir: string, ref: string, exclude?: string): Promise<Skill> {
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: dir, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })).stdout;
  const name = `${path.basename(dir)}#${ref}`;

  // Chemin du dossier depuis la racine du repo, avec « / » final (vide à la racine).
  const prefix = (
    await git("rev-parse", "--show-prefix").catch(() => {
      throw new Error(`${dir} n'est pas dans un repo git (nécessaire pour « #${ref} »).`);
    })
  )
    .toString()
    .trim();
  await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).catch(() => {
    throw new Error(`Révision git introuvable : « ${ref} ».`);
  });
  const listing = await git("ls-tree", "-r", "--name-only", "--full-tree", ref, "--", prefix || ".");
  const paths = listing.toString().split("\n").filter(Boolean).map((p) => p.slice(prefix.length));
  if (!paths.length) throw new NotInRevision(`${prefix || "."} n'existe pas dans la révision « ${ref} ».`);

  return buildSkill(name, paths, (p) => git("show", `${ref}:${prefix}${p}`), exclude);
}


/** Appel à l'API GitHub ; GITHUB_TOKEN (optionnel) donne accès aux repos privés et relève la limite d'appels. */
async function github(url: string, accept: string): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "jurai", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status} pour ${url}`);
  return res;
}

async function loadFromGithub(repo: string, dir: string, ref = "HEAD"): Promise<Skill> {
  const prefix = dir ? `${dir}/` : "";
  const api = `https://api.github.com/repos/${repo}`;
  const rev = encodeURIComponent(ref);

  const { tree } = (await (await github(`${api}/git/trees/${rev}?recursive=1`, "application/vnd.github+json")).json()) as {
    tree: { path: string; type: string }[];
  };
  const paths = tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix)).map((e) => e.path.slice(prefix.length));
  const name = `${repo}/${dir}${ref === "HEAD" ? "" : `#${ref}`}`;
  if (!paths.length) throw new Error(`Dossier introuvable sur GitHub : ${name}`);

  return buildSkill(name, paths, async (p) => {
    const res = await github(`${api}/contents/${encodeURI(prefix + p)}?ref=${rev}`, "application/vnd.github.raw");
    return Buffer.from(await res.arrayBuffer());
  });
}

/**
 * Branche principale du repo qui contient `dir` : la branche par défaut de `origin`, sinon `main`, sinon `master`.
 * Utilise la branche locale si elle existe, sinon sa copie distante (`origin/…`).
 */
export async function mainBranch(dir: string): Promise<string> {
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  const fromOrigin = await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "");
  const candidates = [fromOrigin.replace(/^origin\//, ""), "main", "master"].filter(Boolean);
  for (const name of candidates) {
    for (const ref of [name, `origin/${name}`]) {
      if (await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).then(() => true, () => false)) return ref;
    }
  }
  throw new Error(
    "Branche principale introuvable (ni origin/HEAD, ni main, ni master). " +
      "Checkout superficiel (CI) ? Récupérez-la avec : git fetch --depth=1 origin main:refs/remotes/origin/main",
  );
}

/** `configFile` est exclu du skill s'il se trouve dans son dossier (fichier de tests rangé avec le skill). */
export async function loadSkill(source: SkillSource, configFile?: string): Promise<Skill> {
  if (source.kind === "github") return loadFromGithub(source.repo, source.dir, source.ref);
  const rel = configFile && path.relative(source.dir, configFile);
  const exclude = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : undefined;
  if (!source.ref) return loadFromDisk(source.dir, exclude);
  const ref = source.ref === MAIN_BRANCH ? await mainBranch(source.dir) : source.ref;
  return loadFromGit(source.dir, ref, exclude);
}

const isLocal = (location: string) => /^\.{0,2}(\/|$)/.test(location);

/**
 * Lit une référence de skill, avec une révision optionnelle après `#` :
 * - chemin local (`.`, `./…`, `../…`, `/…`), relatif au fichier de tests : `./skills/x`, `.#master` ;
 * - GitHub `owner/repo/chemin` : `vbarrai/config/skills/x`, `vbarrai/config/skills/x#dev`.
 */
export function parseSource(value: unknown, key: string, baseDir: string): SkillSource {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`« ${key} » doit être un chemin local (./…) ou une référence GitHub (owner/repo/chemin).`);
  }
  const [location, ref] = value.trim().split("#") as [string, string | undefined];
  if (ref !== undefined && !ref) throw new Error(`« ${key} » : révision vide après « # ».`);
  if (isLocal(location)) return { kind: "local", dir: path.resolve(baseDir, location), ref };

  const [owner, repo, ...rest] = location.split("/").filter(Boolean);
  if (!owner || !repo) {
    throw new Error(`« ${key} » : « ${value} » n'est ni un chemin local (./…) ni une référence GitHub (owner/repo/chemin).`);
  }
  return { kind: "github", repo: `${owner}/${repo}`, dir: rest.join("/"), ref };
}

/**
 * Valide le YAML : `tests` (liste non vide), `skill-a` et `skill-b`.
 * Par défaut, le fichier compare le dossier qui le contient (`skill-a: .`)
 * à ce même dossier sur la branche principale du repo (`skill-b: .#<branche principale>`).
 */
export function parseDuel(raw: unknown, baseDir: string): { a: SkillSource; b: SkillSource; tests: string[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const tests = r.tests;
  if (!Array.isArray(tests) || tests.length === 0 || !tests.every((t) => typeof t === "string" && t.trim())) {
    throw new Error("« tests » doit être une liste non vide d'exigences.");
  }
  return {
    a: parseSource(r["skill-a"] ?? ".", "skill-a", baseDir),
    b: r["skill-b"] === undefined ? { kind: "local", dir: baseDir, ref: MAIN_BRANCH } : parseSource(r["skill-b"], "skill-b", baseDir),
    tests: tests.map((t: string) => t.trim()),
  };
}

export const TEST_FILE = "_test.yml";

/** Tous les fichiers `_test.yml` sous `root`, hors dossiers cachés et node_modules, triés. */
export async function findTestFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === TEST_FILE) found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

export async function loadDuel(file: string): Promise<Duel> {
  const configFile = path.resolve(file);
  const text = await readFile(configFile, "utf8").catch(() => {
    throw new Error(`Fichier introuvable : ${file}`);
  });
  const { a, b, tests } = parseDuel(parse(text), path.dirname(configFile));
  const [skillA, skillB] = await Promise.all([loadSkill(a, configFile), loadSkill(b, configFile)]);
  return { a: skillA, b: skillB, tests };
}
