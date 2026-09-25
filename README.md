# jurai

Un jury pour vos skills Claude Code : des tests à la manière de vitest. On décrit dans un `_test.yml` ce qu'un skill doit faire. À chaque modification, `jurai` vérifie que la nouvelle version ne fait pas moins bien que celle de la branche principale.

Le juge est **[Jev](https://vercel.com/ai-gateway/models/jev)** (`typesafe-ai/jev`, TypeSafe AI). Il ne génère pas de texte : il renvoie des réponses typées (score, booléen) en moins d'une seconde, pour 0,042 $ par million de tokens en entrée. Les skills **ne sont pas exécutés** : Jev lit leurs instructions et estime laquelle des deux versions conduit le mieux un agent à respecter chaque exigence.

## Installation

Dans le repo qui contient vos skills :

```bash
npm install -D jurai
echo "AI_GATEWAY_API_KEY=vck_…" >> .env.local   # clé Vercel AI Gateway ; pensez à ignorer .env.local dans git
```

Node.js ≥ 22 est requis. La clé est lue dans le shell (prioritaire), puis dans `.env.local`, puis dans `.env`.

## Écrire un test

Ajoutez un `_test.yml` dans le dossier du skill :

```
skills/
  collaborai-pr/
    SKILL.md
    _test.yml
```

```yaml
# skills/collaborai-pr/_test.yml
tests:
  - Le skill lance les checks du projet (lint, typecheck, tests, build) avant d'ouvrir la PR
  - Le skill demande l'accord de l'utilisateur avant de pousser
  - Le skill s'arrête si l'arbre de travail est propre (rien à livrer)
```

Chaque test est une exigence. Le duel compare **A = le dossier tel qu'il est** (copie de travail) à **B = ce même dossier sur la branche principale**. La branche principale est la branche par défaut de `origin`, sinon `main`, sinon `master`. Le `_test.yml` n'est jamais envoyé à Jev.

## Lancer les tests

```bash
npx jurai                     # tous les _test.yml du repo (hors node_modules et dossiers cachés)
npx jurai skills/x            # sous un dossier
npx jurai skills/x/_test.yml  # un fichier
```

Ou dans le `package.json` : `"scripts": { "test:skills": "jurai" }`.

```
skills/collaborai-pr/_test.yml
  A = collaborai-pr · B = collaborai-pr#main

  Score 63.3/100  B meilleur
  3. Le skill s'arrête si l'arbre de travail est propre (rien à livrer)
      87.6  A ──────────┼──────●── B  respecté : A 50 % · B 96.5 %
            A→B 99 · B→A 76.3

Récapitulatif
  ✗ régression skills/collaborai-pr/_test.yml  B meilleur sur le(s) test(s) 3
```

| Statut | Signification | Appel à Jev |
|---|---|---|
| ✓ **inchangé** | Contenu identique à la branche principale | non |
| • **nouveau** | Le skill n'existe pas encore sur la branche principale | non |
| ✓ **ok** | Aucune régression | oui (2 appels) |
| ✗ **régression** | La branche principale gagne au moins un test, nettement (curseur > 60) et dans les deux ordres | oui (2 appels) |
| ✗ **erreur** | YAML invalide, branche introuvable, erreur réseau… | — |

Le code de sortie vaut 1 s'il y a une régression ou une erreur.

## En CI (GitHub Actions)

Le checkout par défaut ne récupère que la branche testée : il faut aussi récupérer la branche principale.

```yaml
# .github/workflows/skills.yml
name: skills
on: pull_request
jobs:
  jurai:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: git fetch --depth=1 origin main:refs/remotes/origin/main
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx jurai
        env:
          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
```

## Lire le résultat

Jev est interrogé deux fois, en parallèle : une fois avec A présenté en premier, une fois avec B. Chaque appel envoie le contenu des deux versions sous des noms neutres et pose trois questions par test :

- laquelle respecte le mieux l'exigence : un score de 0 à 4, converti en curseur de 0 à 100 ;
- chaque version la respecte-t-elle ? (une probabilité par version).

| Élément | Signification |
|---|---|
| **Curseur** | 0 = A nettement meilleur, 50 = égalité, 100 = B nettement meilleur. C'est la moyenne des deux ordres. Le score global est la moyenne des tests. |
| **Respecté** | Probabilité, selon Jev, que chaque version respecte le test. Si les deux sont sous 50 %, un curseur proche de 50 signifie « les deux échouent ». |
| **A→B / B→A** | Curseur obtenu dans chaque ordre de présentation. Seul l'ordre change, donc les deux devraient être proches. |
| **⚠ non fiable** | Les deux ordres ne tombent pas du même côté (sous 40, entre 40 et 60, au-dessus de 60) : le curseur reflète l'ordre, pas le contenu. Un test non fiable n'est jamais compté comme régression. |

## Écrire de bons tests

Jev juge l'impression d'ensemble si on le laisse faire. Une version mieux structurée est vue meilleure partout, même sur une exigence qu'elle ne respecte pas. Formulez des **faits vérifiables dans le texte du skill** (« le mot exact « fix » figure dans les labels autorisés ») plutôt que des règles conditionnelles (« si c'est un bug, le label doit être fix »).

## Comparer deux skills quelconques

`skill-a` et `skill-b` peuvent être précisés, et le fichier peut alors porter n'importe quel nom (`npx jurai mon-duel.yaml`) :

```yaml
skill-a: ./skills/labeler-v2                                    # dossier local, relatif au YAML
skill-b: vbarrai/config-provider-official/skills/collaborai-pr  # GitHub : owner/repo/chemin
tests:
  - …
```

| Référence | Signification |
|---|---|
| `.`, `./x`, `../x`, `/x` | dossier local, relatif au YAML, dans son état actuel |
| `./x#rev` | dossier local tel qu'il est dans la révision git `rev` (branche, tag, commit) |
| `owner/repo/chemin` | dossier sur GitHub, sur la branche par défaut |
| `owner/repo/chemin#rev` | dossier sur GitHub, dans la révision `rev` |

Pour un repo GitHub privé, ou pour dépasser la limite de 60 appels par heure, définissez `GITHUB_TOKEN` (par exemple `GITHUB_TOKEN=$(gh auth token)`).

## Limites

- Jev évalue des instructions, pas le comportement réel d'un agent.
- 32 000 tokens au maximum pour les deux versions réunies : au-delà, l'appel est refusé avant l'envoi.
- `experimental_evaluate` est une API expérimentale de l'AI SDK.

## Développement

```
src/cli.ts      point d'entrée : recherche des _test.yml, statuts, affichage
src/config.ts   lecture du YAML et des skills (disque, révision git, GitHub)
src/jev.ts      state, questions, appel à Jev
src/duel.ts     les deux ordres, curseur, cohérence, régressions
test/           tests avec un faux Jev (sans réseau)
```

```bash
npm test && npm run typecheck
npm run jurai -- <chemin>   # lance la CLI depuis les sources
npm pack                                                # compile dans dist/ puis crée l'archive
```
