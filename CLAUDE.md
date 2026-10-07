# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projet

`comparai` est une CLI npm qui teste des skills Claude Code. Pour chaque `_test.yml`, elle met en duel deux versions d'un dossier de skill : **A** (par défaut la copie de travail) contre **B** (par défaut le même dossier sur la branche principale). Le juge est Jev (`typesafe-ai/jev`, via Vercel AI Gateway et `experimental_evaluate` de l'AI SDK). Les skills ne sont jamais exécutés : Jev lit leurs instructions. Le README (en français) documente le format YAML, les statuts et la lecture des résultats côté utilisateur.

## Commandes

```bash
npm test                                        # node --test test/*.test.ts (faux Jev, sans réseau)
node --test --test-name-pattern="<nom>" test/duel.test.ts   # un seul test
npm run typecheck                               # tsc --noEmit (src + test)
npm run comparai -- <chemin>                    # CLI depuis les sources ; appelle vraiment Jev
npm run build                                   # tsc -p tsconfig.build.json → dist/ (lancé aussi par prepare)
```

Lancer la CLI réelle demande `AI_GATEWAY_API_KEY` (ou `VERCEL_OIDC_TOKEN`), lue dans le shell puis `.env.local` puis `.env` (`process.loadEnvFile`, qui n'écrase pas le shell).

## TypeScript sans build en dev

Node ≥ 22 exécute directement les `.ts` (type stripping) ; `tsc` ne sert qu'au typecheck et à produire `dist/` pour la publication. Conséquences :

- Les imports relatifs portent l'extension `.ts` (`./config.ts`) ; `rewriteRelativeImportExtensions` la réécrit en `.js` au build.
- `erasableSyntaxOnly` et `verbatimModuleSyntax` : pas d'`enum`, de `namespace` ni de propriétés de paramètres ; les imports de types utilisent `import type` / `type X`.

## Architecture

Le flux va de `cli.ts` → `config.ts` (chargement) → `duel.ts` (orchestration) → `jev.ts` (appel au modèle).

- **`config.ts`** résout chaque côté du duel en `SkillSource` (`local` avec `ref` git optionnelle, ou `github`), puis en `Skill` = liste de fichiers texte. `buildSkill` est le filtre commun aux trois sources (disque, `git ls-tree`/`git show`, API GitHub) : `SKILL.md` obligatoire et placé en premier, fichiers/dossiers cachés et binaires ignorés, et le fichier de tests lui-même exclu s'il est dans le dossier du skill. La révision sentinelle `MAIN_BRANCH` (`@main-branch`) est résolue paresseusement par `mainBranch()` (HEAD de `origin`, sinon `main`, sinon `master`). Un dossier absent de la révision lève `NotInRevision`, que la CLI traduit en statut « nouveau » plutôt qu'en erreur.
- **`jev.ts`** construit le `state` (les deux skills anonymisés en `skill_1`/`skill_2`, nom jamais envoyé) et, par test, trois questions : un score 0–4 (comparaison) et deux booléens (chaque skill respecte-t-il l'exigence). Toutes les questions de tous les tests partent en **un seul appel**. Garde-fou : ~32 000 tokens max (estimés à 4 caractères/token), vérifié avant l'envoi.
- **`duel.ts`** fait deux appels en parallèle en inversant l'ordre de présentation pour mesurer le biais de position, ramène les deux au point de vue de B (`100 - score` pour l'ordre B→A) et en fait la moyenne. Un test est `consistent` si les deux ordres tombent dans la même zone (<40, 40–60, >60). `regressions()` = tests cohérents avec score > 60 ; un test non cohérent n'est jamais une régression. `sameContent()` court-circuite l'appel quand A et B sont identiques.
- **`cli.ts`** collecte les `_test.yml` (hors dossiers cachés et `node_modules`), exécute les duels séquentiellement, affiche jauge et récapitulatif ; code de sortie 1 s'il y a une régression ou une erreur.

Convention de sens partout : curseur **0 = A nettement meilleur, 100 = B nettement meilleur**.

## Tests

`test/duel.test.ts` crée ses fixtures à la volée (dossiers temporaires, repos git temporaires via `execFileSync`) et remplace Jev par `Experimental_EvaluationMockModelV4` de `ai/test`, passé en paramètre `model` de `runDuel`. Aucun test ne doit dépendre du réseau ni d'exemples versionnés dans le repo.

## Conventions

Code, commentaires JSDoc, messages d'erreur et sorties CLI sont en français ; garder cette langue et le style de commentaires existant.
