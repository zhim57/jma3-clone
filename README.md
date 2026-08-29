# Realms of Might & Magic — AI Research Clone

A lightweight, public fork of a Heroes-of-Might-and-Magic-III-style turn-based
strategy game, stripped down to one purpose: **experimenting with the AI player.**

The full rule engine and both AI engines are here and unmodified. What is gone is
everything that made the parent repository heavy or private — 330 MB of committed
raster art and audio, an edutainment study module, scripted campaigns, an
invasion system, an account service, an asset-generation lab.

```bash
npm install
npm run dev            # play it: http://localhost:5173
npm test               # 1,721 headless tests, ~60s, no browser
npm run sim            # 10 seeded AI-vs-AI games, one record each
```

Everything you see is drawn by code. There is not one image file in this
repository.

---

## Why this exists

Judging an AI change needs two things the parent repo made awkward: a fast loop,
and a run you can reproduce. This tree is that loop.

- **The engine is already headless.** `AIPlayer.js` and `CombatAI.js` import no
  Phaser, no scenes, no graphics — a full AI turn runs in plain Node.
- **The test suite has zero npm dependencies.** `npm test` works before
  `npm install`.
- **Runs are deterministic.** Seeded mulberry32 with separate mapgen, gameplay
  and repopulation streams, and no `Math.random()` anywhere in `core/`, `ai/`,
  `map/` or `data/`. Same seed, same game, byte for byte.
- **You can still watch it.** The browser game is intact, so a bad decision is
  something you can see rather than infer from a number.

## The instrument

`scripts/sim/batch.mjs` plays N seeded AI-vs-AI games and writes one record per
game. It is the thing to reach for when you change AI logic.

```bash
npm run sim -- --runs 40 --days 120                  # a real sample
npm run sim -- --runs 40 --json out/base.json        # record it
npm run sim -- --runs 40 --set cunningAI=true --json out/cunning.json
```

Seeds are `1..N` unless you pass `--seed0`, so two runs are directly comparable
pair by pair. Every output file carries the full configuration that produced it —
both halves of it, which matters more than it sounds like:

- **`features`** are game-scoped and live in the save.
- **six AI knobs** (`aiStackSplit`, `aiBattleFormations`, `aiDuskEconomy`,
  `aiFrontCaravans`, `aiCapitolRush`, `siegeTowerDamage`) are read through
  `getSetting()` from a module singleton and are **not** in the save.

That second group means `(seed, save)` does not by itself determine a run. The
`applyRunConfig()` seam in `game/settings.js` exists to close that hole: the batch
runner sets those knobs per run and records the resulting snapshot beside the
results. If you write your own harness, do the same.

Two more sims are carried over: `npm run sim:perf` (where a turn's time goes) and
`npm run sim:goals` (what the AI decided, and why).

## Pick your baseline deliberately

Several AI behaviours ship **off** — `cunningAI`, `aiTownPortal`, `sunkCostSiege`,
`balanceOfPower`, `diplomacy`. Running at bare defaults measures a partly disabled
AI. `BASELINE_FEATURES` at the top of `batch.mjs` states an explicit starting
point rather than inheriting whatever the defaults happen to be. Change it on
purpose, not by accident.

### The vassalage flag, and why it is off

This is the one behavioural change to the game itself, and it is worth
understanding before you measure anything.

Upstream, a realm being ground down can **swear vassalage** to a stronger one,
after which the two fight as one banner. `wouldSeekTerms()` is unflagged there and
`AIPlayer` calls it every turn. Measured on this engine, in a plain 2-player
castle-vs-inferno AI-vs-AI game: **the two realms merged onto one team in 6 of 8
seeds by day 45.** The default AI testbed was quietly an alliance simulator.

So the behaviour is kept in full and put behind a flag that is **off** for the
baseline. Reproduce it yourself:

```bash
npm run sim -- --runs 8 --days 60                      # 0/8 merged, all decisive
npm run sim -- --runs 8 --days 60 --set vassalage=true # 4/8 merged, 4 undecided
```

The gate lives inside `core/pacts.js`, **not** at the `AIPlayer.js` call site —
which brings us to the important part.

## Patches travel both ways

The point of a clone is bringing ideas back. That only works if the files the
ideas live in have not forked.

`core/actions.js` (362 KB) and `ai/AIPlayer.js` (238 KB) are 63% of the AI
dependency closure, and both are **byte-identical to the parent repo.** So are
`GameState.js`, `CombatEngine.js`, `CombatAI.js`, `physicalDamage.js`, `power.js`,
`Pathfinding.js`, `diplomacy.js`, `neutrals.js`, `magic.js`, `heroUtils.js`,
`upgrades.js`, `jobs.js`, `aiMemory.js`, all of `ai/`, and the big data tables.

That is why the cuts are **stubs at the leaves** rather than edits at the call
sites. `core/invasions.js`, `invaderPlanner.js`, `invaderRealms.js` and `ronins.js`
keep their full export surface and return exactly what the real modules return
when their feature flags are off — which is how they ship upstream anyway. The
importers never notice.

Verify it any time:

```bash
diff <(git show HEAD:src/ai/AIPlayer.js) ../JMA3/src/ai/AIPlayer.js
```

Only `map/MapGenerator.js` differs among the engine files: two town-name tables
pruned, and two unguarded `FACTIONS[...].nativeTerrain` lookups given the `?.`
the rest of the file already uses.

## What changed, and what did not

### Two playable factions — but all nine bestiaries

`data/factions.js` registers **castle** and **inferno**. That is the pair the
parent repo's own AI benchmark uses and the pair every battle fixture is written
for.

**All ~140 creatures are still here**, and that is deliberate rather than lazy. A
default 2-player map places ~39 distinct off-roster creatures as wandering guards,
creature-bank defenders, Pandora rewards and hero starting armies — and
`CombatEngine` dereferences `CREATURES[id].abilities` unguarded in five places, so
a pruned roster is a hard `TypeError` on the first fight, not a thinner map.
Keeping the full bestiary also means map generation draws the same RNG stream as
upstream, the combat AI still meets the six abilities that exist only on other
factions' creatures, and Necromancy still finds `CREATURES.skeleton`.

Same rule for `UPGRADE_NODES` and `CONFIG.FACTION_GRAIL`: all nine trees kept,
because they are the corpus the physical damage model is tested against.
`HERO_ROSTER` **is** filtered to the playable factions — there, an unhireable hero
is not free, because `gfx/tokens.js` bakes a portrait texture for every entry at
boot.

So: **two factions you can build, nine factions' worth of creatures you can fight.**

### Removed

| | |
|---|---|
| `public/` (330 MB) | Raster sprite pack + recorded audio. All art and sound is generated at runtime. |
| `lab/` | The AI asset-generation workbench (and the only API keys in the tree). |
| `server/`, `deploy/`, `src/net/` | Magic-link account service and its VPS runbook. |
| Study module | A Pomodoro edutainment break. It carried two private third-party URLs — dropping it is what makes this tree publishable. |
| Campaigns, sagas | `data/campaigns.js` is an empty registry; `CampaignScene` is gone. Menu's **Play** goes straight to Custom Game. |
| Invasions, ronins | Stubbed at the leaves (see above). |
| Arena, Gantt scenes | With `arena/pareto/rigidity/sensitivity/dimensions` — creature-balance research, not AI research. |
| 24 balance sims | The creature-tuning sweeps. The AI harnesses stayed. |

`4` scenes dropped, `13` registered. Kept but unused-by-default: `core/campaign.js`
and `core/endless.js`, because cutting them means surgery on the two largest view
files to save ~30 KB.

### Test suite

**1,720 of 1,721 pass.** The one failure — `bank-reward-share.test.js:182` — fails
identically in the parent repo at the same line and is not caused by anything here.

Roughly 80 test files were removed (assets, audio, study, campaigns, invasions,
auth, per-faction) and about 20 adapted. Every adaptation carries a `CLONE:`
comment saying what changed and why, so nothing looks like an accident. The
common ones: rosters that named a non-playable faction, and the pacts/plea tests,
which now switch `vassalage` on explicitly because they are about that behaviour.

```bash
npm test          # everything, ~60s
npm run test:ai   # the AI + combat subset
npm run gate      # lint + the AI subset
```

## Layout

```
src/ai/          AIPlayer.js (the adventure AI) + telemetry
src/core/        the headless rule engine — actions.js is the verb surface
src/core/combat/ CombatEngine (hex battles) + CombatAI (per-stack decisions)
src/data/        creatures, buildings, heroes, artifacts, spells, upgrade trees
src/map/         MapGenerator, Pathfinding, fog
src/gfx/         procedural art: tokens, terrain, glyphs, icons
src/scenes/      Phaser views over the engine
scripts/sim/     batch.mjs (the instrument), aiperf, goal-audit
```

The architecture that makes this work is the parent repo's, not this fork's: a
**headless rule engine** of plain objects and functions, with a **presentation
layer** of Phaser scenes that render state and call engine verbs. The AI plays by
calling the same verbs the human UI does.

## Known limits

- Map RNG is comparable to upstream **only** because the full creature roster was
  kept. If you prune creatures, seeds stop matching and cross-repo replay ends.
- 49 tests assert on source **text** via `readFileSync`, some pinning the shape of
  `AIPlayer.js` internals. A large AI rewrite will need those guards rewritten too —
  in both repos.
- The six live AI knobs are process-global, so they cannot vary per run inside one
  Node process. The batch runner sets them once and records them.

## License

MIT — see [LICENSE](LICENSE).
