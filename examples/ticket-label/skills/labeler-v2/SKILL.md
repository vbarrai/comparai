---
name: ticket-labeler
description: Attribue exactement un label de la taxonomie à un ticket (Linear, GitHub, Jira). À utiliser dès qu'il faut classer, trier ou labelliser un ticket.
---

# Labelliser un ticket

## Sortie attendue
Exactement **un** label, issu de `references/taxonomy.md`, suivi d'une justification d'une phrase :

```
label: <label>
raison: <une phrase>
```

## Procédure
1. Identifie ce que le ticket **demande** (pas seulement ce qu'il décrit).
2. Compare avec les définitions de `references/taxonomy.md` et choisis le label dont la définition correspond.
3. Si plusieurs labels semblent possibles, applique les règles de départage ci-dessous.
4. Si le ticket est trop vague pour trancher, réponds `label: needs-triage` et indique l'information manquante.

## Règles de départage (dans l'ordre)
1. `security` l'emporte sur tout le reste.
2. Un comportement cassé par rapport à l'attendu est un `bug`, même si le ticket propose une solution.
3. Une nouvelle capacité est une `feature` ; l'amélioration d'une capacité existante est une `improvement`.
4. Une lenteur mesurable est `performance`, sauf si elle provoque une erreur (alors `bug`).
