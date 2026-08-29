/**
 * config.js — Global tuning constants.
 *
 * Every "magic number" of the rule set lives here so balance can be tuned
 * without touching engine code. See docs/GAME_RULES.md for the rationale
 * behind each value (most mirror Heroes of Might and Magic III).
 */

export const CONFIG = {
  // ---- Time -----------------------------------------------------------
  DAYS_PER_WEEK: 7,

  // ---- Adventure map ---------------------------------------------------
  TILE: 64,                 // world pixels per tile
  SIGHT_RADIUS: 5,          // base hero sight radius (tiles), +Scouting
  CAPTURE_REVEAL: 6,        // fog reveal radius when a town is captured
  MINE_REVEAL: 4,           // fog reveal radius when a mine is flagged
  // Camera zoom: wheel / +- keys / HUD buttons all clamp to this range and
  // persist the level (settings 'zoom') so it carries across games.
  ZOOM_MIN: 0.45,           // most zoomed OUT (widest view)
  ZOOM_MAX: 3.0,            // most zoomed IN (biggest tiles — for small/HiDPI screens)
  ZOOM_STEP: 1.14,          // multiplicative step per wheel notch / button press

  // Movement points are expressed in "centitiles": a straight step over
  // neutral terrain costs 100. Diagonal steps cost 141 (~sqrt(2)*100).
  MP_BASE: 1500,            // hero MP at slowest-creature speed <= 4
  MP_PER_SPEED: 100,        // extra MP per speed point above 4 ...
  MP_MAX_FROM_SPEED: 2000,  // ... capped here (speed 9+)
  MOVE_COST_STRAIGHT: 100,
  MOVE_COST_DIAGONAL: 141,

  // Extra cost multiplier per terrain (1.0 = no penalty). The *penalty*
  // part (anything above 1.0) is what the Pathfinding skill reduces.
  TERRAIN_COST: {
    grass: 1.0,
    dirt: 1.0,
    rough: 1.25,
    snow: 1.5,
    swamp: 1.75,
    lava: 1.0,
    sand: 1.5,
    water: 1.0, // only ever traversed aboard a boat; sails at open-sea speed
  },

  // Home-turf bonus: a hero on its FACTION's native terrain (FACTIONS.*.
  // nativeTerrain) moves at this multiplier instead of the terrain's own cost —
  // a small, symmetric edge on your own ground (locals stride it; invaders pay
  // the terrain's normal rate). Keep it in (0, 1]; 1.0 disables the bonus.
  NATIVE_TERRAIN_MULT: 0.9,

  // Roads (HoMM3-style) discount movement and OVERRIDE the terrain penalty — a
  // road across swamp is still fast. Multipliers < 1.0 make a road step cheaper
  // than any open ground; the generator lays a network connecting the towns.
  // (Keep every value in (0, 1]; the A* heuristic reads the minimum to stay
  // admissible when the cheapest step drops below MOVE_COST_STRAIGHT.)
  ROAD_COST: {
    dirt: 0.75,   // packed-earth track (layRoads spur)
    cobble: 0.50, // cobblestone highway (layRoads main)
  },

  // ---- Seasons ---------------------------------------------------------
  // Every month (4 weeks) the world shifts through a four-season cycle, derived
  // deterministically from state.day. A season only SLOWS off-road land travel
  // (multipliers are all >= 1.0, so the A* heuristic stays admissible and roads
  // — kept plowed — are unaffected); the OPENING month is temperate (all 1.0),
  // so the early game is untouched and the world only turns from month 2 on.
  // `tint` colours the view's seasonal wash. Terrains: grass/dirt/sand/rough are
  // land; lava/water are never season-slowed. See core/seasons.js + stepCost.
  SEASONS: [
    { name: 'Spring', tint: 0x7ec850, terrainMult: {} },                                  // opening — temperate
    { name: 'Summer', tint: 0xf0d060, terrainMult: {} },                                  // dry, fast roads
    { name: 'Autumn', tint: 0xd8853a, terrainMult: { grass: 1.1, dirt: 1.1 } },           // mud & fallen leaves
    { name: 'Winter', tint: 0xbcd4e6, terrainMult: { grass: 1.3, dirt: 1.25, sand: 1.2, rough: 1.25 } }, // snow
  ],

  // ---- Caravans --------------------------------------------------------
  // Dispatch a garrison stack from one owned town toward another of your team;
  // it plods the road network CARAVAN_SPEED tiles a day (roads finally pay off)
  // and merges into the destination garrison on arrival. Unescorted: an enemy
  // hero that reaches its tile scatters it (a raid), the raider pocketing
  // CARAVAN_RAID_XP_PER_VALUE × the lost stack's army value as experience.
  CARAVAN: {
    SPEED: 6,               // tiles advanced per day
    RAID_XP_PER_VALUE: 0.5, // interceptor XP = this × the scattered stack's army value
  },

  // ---- Economy ---------------------------------------------------------
  STARTING_RESOURCES: {
    gold: 10000, wood: 20, ore: 20,
    mercury: 5, sulfur: 5, crystal: 5, gems: 5,
  },

  // ---- Difficulty ------------------------------------------------------
  // The classic HoMM3 handicap: on harder settings YOU start with less and the
  // AI starts richer AND earns more each day. `human`/`ai` scale each side's
  // STARTING_RESOURCES; `aiIncome` scales the AI's daily income (dailyIncome).
  DEFAULT_DIFFICULTY: 'normal',
  DIFFICULTY_ORDER: ['easy', 'normal', 'hard', 'expert', 'impossible'],
  DIFFICULTIES: {
    easy:       { label: 'Easy',       human: 1.5,  ai: 0.9, aiIncome: 0.9 },
    normal:     { label: 'Normal',     human: 1.0,  ai: 1.0, aiIncome: 1.0 },
    hard:       { label: 'Hard',       human: 0.85, ai: 1.2, aiIncome: 1.15 },
    expert:     { label: 'Expert',     human: 0.7,  ai: 1.4, aiIncome: 1.3 },
    impossible: { label: 'Impossible', human: 0.6,  ai: 1.6, aiIncome: 1.5 },
  },

  // ---- Pacing preset ("Tide of War") -----------------------------------
  // An OPT-IN growth system layered over the base game (Phase C): weekly
  // map-creature growth (#7), army-commensurate "always-hard" scaling with
  // on-par town defense (#8), divine ZPD intervention (#9), explore-not-rush
  // pacing (#11), and monthly emergence of fresh wild stacks (#12). 'classic'
  // is the base game, byte-identical — the preset
  // is OFF by default, so every existing game, save and test reads as classic.
  // Stored on state (state.pacing), round-tripping the save spread with no
  // version bump, exactly like state.difficulty.
  DEFAULT_PACING: 'classic',
  PACING_ORDER: ['classic', 'tideOfWar'],
  PACING: {
    classic:   { label: 'Classic',     tideOfWar: false },
    tideOfWar: { label: 'Tide of War', tideOfWar: true },
  },
  // ---- Neutral population homeostasis (the crawling peg) -------------------
  // A wandering stack's value tracks the leading realm's army at PEG_RATIO, and
  // may move at most PEG_CRAWL_PCT of the gap per week toward that target. The
  // rate limit is the important half: without it a realm that doubles its army
  // in a day re-scales every stack on the map that same day, and a burst of
  // recruitment buys nothing. With it, the burst opens a real window in which
  // the world is soft, and exploiting that window is a strategy.
  //
  // PEG_RATIO is calibrated to the ratio the MAP GENERATOR already ships on day
  // 1 (the median wandering band is worth about a fifth of a starting realm), so
  // the peg is not a new difficulty knob — it is a promise that the open country
  // stays as dangerous, relative to the leader, as it was on the first morning.
  // MEASURED, not chosen: across six 100-day campaigns the median wandering band
  // is worth 0.150 of the leading realm's army on day 1 (guards, 0.247). The peg
  // therefore promises "as dangerous, relative to the leader, as the generator
  // shipped it" rather than a new difficulty setting.
  PEG_RATIO: 0.15,
  // The rate limit, as a fraction of the GAP closed per week — NOT a fraction of
  // the stack's own size. The anchor compounds (the leading realm grows a median
  // 71% per week, p90 225%), and against a compounding anchor a
  // fraction-of-current cap either never catches up or is indistinguishable from
  // tracking it exactly. Closing a share of the gap self-limits instead: it
  // accelerates when a stack is far behind and eases off near the target.
  //
  // The consequence is arithmetic and worth stating plainly: with the anchor
  // growing at factor g per week and the gap closing at c, the ratio settles at
  // r* = c / (g - 1 + c). At c = 0.5 and the measured median g = 1.71 that is
  // 0.41 of target — so the honest claim is a BAND, not a peg held at 1.0. No
  // rate-limited peg can hold parity with an anchor that doubles every ten days;
  // pretending otherwise would mean no rate limit at all, which is the thing the
  // design is for.
  PEG_CRAWL_PCT: 0.5,
  // 'max' — the strongest realm sets the world's difficulty for everyone (a
  // hegemon's arms race prices out smaller powers). 'mean' is the gentler
  // alternative; see neutrals.leadingRealmArmy for the trade.
  PEG_ANCHOR: 'max',
  // Each band keeps its PLACE in the distribution the map shipped, not just the
  // level of it. Pegging every band to one target flattened an 8x spread (the
  // generator ships bands from 425 to 3,220 against a median of 1,285) into a
  // world where every wandering stack was worth the same to the tile — measured,
  // p25 173,965 / median 174,006 / p75 176,355 on day 100. A band's own weight,
  // recorded once as `obj.peg`, multiplies its target, so a small band stays a
  // skirmish and a fat one stays a problem. Clamped to the shipped spread so no
  // outlier compounds into a monster.
  // The bounds are chosen so their GEOMETRIC mean is exactly 1 (0.4 x 2.5), and
  // fresh bands sample log-uniformly between them. Sampling a weight uniformly
  // over a multiplicative range is a quiet inflation: the median of a uniform
  // draw on [0.35, 2.5] is 1.425, so once the map had turned over the median
  // band sat 66% above target — measured, and it made the late world too hard
  // for every realm including the leader.
  PEG_SPREAD_MIN: 0.4,
  PEG_SPREAD_MAX: 2.5,
  // Fresh bands draw their weight LOGNORMALLY (median exactly 1, mean e^(s^2/2)
  // = 1.11), so most sit near the peg with a thin tail either side, rather than
  // the flat log-uniform spread that made a 0.4x band exactly as common as a
  // 2.5x one. Variety you can shop in wants a mode, not a plateau.
  PEG_SPREAD_SIGMA: 0.45,
  // ---- Where a band is decides WHOSE strength it is priced against ----------
  // A band on a realm's doorstep is pegged to THAT realm; one out in nobody's
  // country is pegged to the leader; in between it blends by distance to the
  // nearest owned town. There is no ownership map in this engine to switch on —
  // territory is inferred from town proximity exactly as the AI's own
  // nearestOwnTown does it — so a blend is not merely smoother than a boundary,
  // it is the only honest option: a hard partition would have to be invented and
  // would then cliff every time a town changed hands.
  //
  // No radius. A fixed one was tried at 14 tiles (bands sit a median 9-11 from the
  // nearest town) and measured wrong: a realm reduced to two towns has a
  // hinterland wider than any radius, so most of its own country was priced
  // against the leader and it stayed locked out — 0 % of the bands at home. The
  // blend now runs on how CONTESTED the ground is (distance to the host town over
  // the distance to host plus nearest rival), which is scale-free and caps at 0.5
  // on the line between two realms.
  // The blend is GEOMETRIC, not linear. Late-game realm armies differ by 30x or
  // more, and a linear blend at even a third of the way out is still dominated by
  // the leader's term — a trailing realm would see 100k bands beside its own
  // 50k army and still be locked out of its own country. Interpolating in log
  // space is the natural operation on a quantity that spans orders of magnitude
  // (and is the same reasoning as the lognormal weights above): at the midpoint a
  // band is the geometric mean of the two realms, which reads as a fair fight on
  // the frontier and a manageable one at home.
  PEG_TERRITORY_GEOMETRIC: true,
  // A pegged stack never falls below the size the map shipped it at: the world
  // may get harder relative to the leader, but the generator's own design is a
  // floor, not a starting point to be rolled back.
  PEG_FLOOR_AT_ORIGINAL: true,
  // Population floor: keep at least this share of the wandering bands the map
  // generated, refilled at most this many per week so clearing a region buys a
  // real period of quiet. Respawns keep this far from every hero and prefer
  // ground nobody has explored (see actions.respawnWildStacks).
  PEG_FLOOR_SHARE: 0.75,
  // MEASURED: at three a week the refill loses to sustained clearing — two of six
  // campaigns settled into a stable shortfall (29 bands against a floor of 35)
  // rather than a transient dip, because heroes were clearing about three a week.
  // Five closes it without weakening what the trickle is FOR: the promise that
  // clearing an area buys quiet is kept by WHERE bands reappear (in fog, well
  // away from every hero), not by how slowly the global count recovers.
  // Raised from five: the floor was still losing to sustained clearing (four of
  // six campaigns settled at 27-30 against a floor of 35), and with bands now
  // priced by WHERE they appear, more of them means more food in the places that
  // need it rather than a uniformly harder world.
  PEG_RESPAWN_PER_WEEK: 8,
  // …or half the deficit, whichever is more. A fixed weekly count keeps losing to
  // clearing whenever the world gets softer — anchoring the peg to what a realm
  // can FIELD roughly halved band values, heroes cleared faster in consequence,
  // and a flat eight a week fell from holding 35 bands to holding 15. Closing a
  // share of the gap is the same self-limiting shape the peg itself uses: it
  // accelerates when the world has been emptied and eases off as it fills. The
  // promise that clearing an area buys quiet is kept by WHERE bands reappear (in
  // fog, well away from every hero), not by how slowly the global count recovers.
  PEG_RESPAWN_CATCHUP: 0.5,
  PEG_RESPAWN_CLEARANCE: 8,
  // ---- Territorial defence (Phase D) ---------------------------------------
  // A holding (mine or dwelling) sits on a ladder: watch (free, automatic on
  // capture) -> garrison (bought bodies) -> fortification (a one-off wall). The
  // numbers below exist to make DEFENDING EVERYTHING unaffordable, because the
  // choice of what to defend is the decision the whole system is for.
  DEFENCE_GARRISON_TIER: 2,        // the line a realm garrisons with
  DEFENCE_GARRISON_MARKUP: 1.5,    // paid over the creature's own recruit cost
  // Gold per body per day. Calibrated against what a holding YIELDS: a gold mine
  // pays 1,000 a day, so manning one to the cap costs 320 — a third of its yield,
  // worth paying for the mine that funds your realm and plainly not worth it for
  // a sawmill. That grading IS the mechanism; a flat cheap rate would let a realm
  // man everything and buy invulnerability with pocket change.
  DEFENCE_GARRISON_UPKEEP: 8,      // gold per body per day
  // Bodies one holding may billet. A FLAT cap, and knowingly so.
  //
  // The tidier design is to scale it with what the owner can field, exactly as
  // Phase C scales the wild bands — a fixed quantity in a compounding economy
  // goes stale, and by day 60 a 40-body garrison is free XP for a hero worth
  // 100,000. That was built and measured, in two AI-spending variants, and it
  // made ownership churn WORSE on this phase's own criterion: 512 and 408 total
  // changes against 377 for the flat cap, with the worst five-day window going
  // 3 -> 4 and 3 -> 5. Bigger per-holding requirements soak an AI's defence
  // budget on fewer holdings and leave the rest naked, and spreading the budget
  // thinner traded depth for breadth without recovering the ground.
  //
  // So the flat cap ships because it measures better, and the staleness is
  // recorded rather than fixed by assumption: the real answer scales the cap AND
  // the spending rule together, and wants its own measurement.
  DEFENCE_GARRISON_MAX: 40,
  DEFENCE_FORTIFY_COST: 2500,      // one-off masonry
  DEFENCE_FORTIFY_UPKEEP: 40,      // gold per day
  DEFENCE_FORTIFY_BONUS: 3,        // defender bonus, as a town's Citadel gives
  // Even a won assault on a fortified holding costs the attacker this share of
  // its surviving army: walls are paid for in blood as well as gold, and it is
  // what stops a strong hero from farming defended ground for free.
  DEFENCE_FORTIFY_ATTRITION: 0.08,
  // Buying a garrison out instead of fighting it: mercenaries have a price, and
  // it is deliberately steep against the stack's own value — you are buying
  // certainty and your soldiers' lives. The money goes to the DEFENDER.
  DEFENCE_BUYOUT_RATE: 2.5,
  // How many days of a holding's own yield an attacker will pay to take it
  // bloodlessly. The blood anchor alone is not enough: predictedFightLoss caps
  // at the attacker's whole army, so a fight it would LOSE quotes the same price
  // as a fight it would barely survive — and a rich realm facing a garrison it
  // cannot beat would refuse to pay, which is backwards. Gold substituting for
  // force is exactly the move this mechanism exists to sell.
  DEFENCE_BUYOUT_HORIZON: 20,
  DEFENCE_BUYOUT_FORT_MULT: 1.5,   // a garrison behind walls sells itself dearer
  // A captured TOWN keeps a garrison scaled to the army that took it — the
  // clause that ends five-changes-in-four-days on its own.
  DEFENCE_CAPTURE_SHARE: 0.15,
  DEFENCE_CAPTURE_FLOOR: 500,
  // What an AI realm will put into holding what it has, as a share of its gold.
  AI_DEFENCE_BUDGET_SHARE: 0.35,
  AI_DEFENCE_GOLD_FLOOR: 2000,     // never spend the last of the treasury on walls
  // Gold an AI hero will pay per point of army value walking into its ranks when
  // it buys a neutral band instead of fighting it (AIPlayer.maybeParleyStack).
  // The GOODS anchor: the blood anchor alone reads 0 against a walkover, and a
  // walkover you can absorb whole is exactly the bargain worth taking.
  AI_PARLEY_GOODS_RATE: 1.0,
  // Seven full army slots — not gold, and not the rule — are what actually stop
  // a rival parleying: 408 of 666 neutral encounters in the sweep. So a hero may
  // DISMISS its weakest stack to take a band in, the same trade the human makes
  // by hand on the hero sheet. Only for a real upgrade, never for churn: the band
  // must be worth at least this multiple of what is thrown away, and the price is
  // then weighed against the NET gain rather than the gross.
  //
  // What it bought, over six 60-day games: 22 parleys became 26, five of them by
  // clearing a slot (+18%). Army fielded moved 3.55M → 3.38M, which reads like a
  // cost and is not distinguishable from one at this sample — neighbouring
  // settings on the same six seeds spread 3.30M–3.98M. Each individual trade is
  // strictly positive by construction (the band is worth twice what is dropped);
  // the spread is the realm's own variance, not the rule's.
  AI_PARLEY_EVICT_MARGIN: 2.0,
  // NOT here, and the absence is a measurement: a gold RESERVE held back from the
  // week's recruiting so a hero could actually pay for a band it met. The case
  // for it looked strong — over four 90-day games rival heroes reached 639
  // encounters they would have cleared a slot for, and 342 died on the price with
  // a median 11 gold on hand against 1,888 asked. It was built and swept over six
  // 60-day games, and it does buy the parleys; it also costs the realm the troops
  // that gold would have been. Army fielded, by reserve: 0 → 3.38M, 1000 → 3.98M,
  // 2500 → 3.30M (noise), and 5000 → 2.16M with three towns fewer, for 49 parleys
  // against 26. Recruiting beats bargaining at this scale, so the realm still
  // spends to the last coin and a hero bargains with whatever it happens to have.

  // Tide of War tuning (all inert in Classic).
  // #7 — map-creature growth: each week an unfought wild stack gains this
  // fraction of its current size (rounded, at least 1), capped at this multiple
  // of its ORIGINAL strength — a rising but bounded map threat, so a stack you
  // keep avoiding gets meaner without ever becoming impossible.
  TIDE_MAP_GROWTH_PCT: 0.10,
  TIDE_MAP_GROWTH_CAP: 2.5,
  // #8 — army-commensurate "always-hard" scaling. When a hero attacks a
  // neutral/PvE defender (wild stack, creature bank, Pandora guard) weaker than
  // TIDE_HARDNESS × the hero's army value, the defender's stacks are scaled UP
  // to that floor — never down, so a genuinely tough fight is left alone and you
  // can never simply outgrow the map into walkovers. The player picks the floor
  // in Settings (seeded into state.tideHardness); the "slacker penalty" is
  // emergent — never scaling DOWN means an under-developed hero still faces the
  // map's full (time-grown, #7) strength.
  TIDE_HARDNESS_DEFAULT: 0.85, // fights land at ~85% of your army by default
  TIDE_HARDNESS_MIN: 0.5,      // "Relaxed" — comfortable but never a walkover
  TIDE_HARDNESS_MAX: 1.3,      // "Brutal" — the world outweighs you
  // #8, the dial read as an OUTCOME. TIDE_HARDNESS is no longer a share of your
  // army VALUE — it is the share of your army the fight should COST you, found by
  // simulating the fight (actions.tideMultiplier → diplomacy.predictedArmyLoss)
  // rather than by pricing it.
  //
  // Why it changed. The old rule sized both sides with armyValue and hit its own
  // target every time: measured over 100 scaled battles of one half-game the
  // defender was built to a mean 1.093x the attacker's army value — and the
  // attacker's mean loss was 0.46%, with 90 of the 100 costing nothing at all.
  // Printed multipliers spanned x1.11 to x1924.77 and all of them landed in the
  // same [0.85, 1.25] band and died 100-0. armyValue carries no commander term and
  // the neutral has no commander at all, while the damage model applies the
  // commander multiplicatively to every stack, so the proxy could not see the term
  // that decided the fight. TIDE_REACH_* and TIDE_TARGET_ABS_MAX were both patches
  // on that same gap and are gone with it — a search over the real outcome has no
  // blindness for them to correct.
  //
  // The ends of the dial keep their meaning; only the units changed. Relaxed still
  // reads "comfortable but never a walkover", Brutal still reads "the world
  // outweighs you", and the number under them is now a percentage of your army you
  // can expect to bury.
  TIDE_LOSS_MIN: 0.06,  // "Relaxed"  — a fight you feel, at the bottom of the dial
  TIDE_LOSS_MAX: 0.38,  // "Brutal"   — the top of the dial, still resolvable
  // Search bounds. STRIDE^BRACKET sets the reachable ceiling (8^4 = 4096, which is
  // exactly TIDE_MULT_MAX); STEPS is the geometric bisection that follows, and the
  // guard then validates on its own seed family. Measured end to end, a cold search is
  // 42-46 auto-resolves and 11-71 ms; the result is cached per encounter, so a warm
  // read is ~0.1 ms and the hover card and the battle it precedes pay for one search
  // between them. It is affordable because the sim resolves STACKS, not bodies: 1.68 ms
  // at 4,096 creatures and 1.01 ms at 32,768.
  TIDE_SEARCH_STRIDE: 8,
  TIDE_SEARCH_BRACKET: 4,
  TIDE_SEARCH_STEPS: 4,
  // Seeds sampled per bisection probe. One is a poor estimator: the cost curve is a
  // cliff (0% → 100% across a third of the body count), so a single roll decides which
  // side of it the search believes it is on, and the same encounter would size
  // differently on a reload. A median needs an odd count to be a sample rather than an
  // average, and the guard samples its own, disjoint family (see SEED_FAMILY_* in
  // actions.js).
  //
  // FIVE TO THREE, because the search runs this many probes per bisection step and
  // that is where its cost is. What it buys and what it costs, both measured:
  //
  //   THE AIM IS INTACT. tide-cost at 200 fights lands on the IDENTICAL multiplier
  //   ladder — x6, x33, x304, x981, x1448 — with the same wipe counts, the same two
  //   free fights in two hundred, and a realised cost of median 20.8% / mean 21.1%
  //   against 20.4% / 20.9% at five. The dial promises ~20% of your army per fight
  //   and it still delivers it.
  //
  //   INDIVIDUAL ENCOUNTERS MOVE. Over a wider sweep — 72 sized encounters, 3 map
  //   seeds x 4 army sizes x 2 hardness x wild stacks, boxes and banks — a quarter
  //   of them size differently than they did at five, the largest by 48%. That is
  //   symmetric noise around an unchanged aim, not a shift in it: the median drift
  //   is 0.0%, and the ladder above does not move.
  //
  //   It is also noise a player cannot see. The answer is cached per world, hero,
  //   defender and budget (tideMultiplier), so an encounter is sized once and never
  //   re-rolled; what changes is which fight you get, not that a fight keeps
  //   changing. FOUR was measured too and is worse than either — the same drift as
  //   three (29% of encounters, worst 65%) for less of the saving.
  TIDE_SEARCH_SEEDS: 3,
  // The wipe guard, bounded by the SAME dial. Past the cliff the median cost and the
  // tail come apart: measured, x220 costs a median 27% of the army while one fight in
  // seven ends with it destroyed outright. Losing the commander is a different kind of
  // outcome, not a worse roll of the same one, so how often it may happen is its own
  // promise — and it is the dial's promise, because a player who chose Brutal is
  // asking for that risk and one who chose Relaxed is not.
  TIDE_WIPE_AT: 0.99,        // loss at or above this is "the army was destroyed"
  TIDE_WIPE_TOL_MIN: 0.03,   // "Relaxed" — one wild fight in thirty can end you
  TIDE_WIPE_TOL_MAX: 0.25,   // "Brutal"  — one in four
  // "Can this kill me" is a question about the TAIL, which a handful of draws does not
  // have — so the guard samples wider than the bisection, and on seeds the bisection
  // never touched, because validating on the draws that selected a point certifies
  // the selection instead of testing it.
  //
  // NINE TO FIVE, and this one is free: across the same 72-encounter sweep, nine,
  // seven, five, four and three all produced the IDENTICAL sized fight — 72/72, zero
  // drift — while five saves 11% of the search. At Brutal, where the guard is
  // loosest and so most able to show a difference, tide-cost reads median 24.7% /
  // mean 27.6% against 24.9% / 28.2% at nine, on the same multipliers and the same
  // wipes.
  //
  // FIVE AND NOT THREE, for a reason the sweep cannot see. The guard's resolution is
  // 1/N — with five seeds it can read 0%, 20%, 40%; with three, 0%, 33%, 67%. The
  // tolerance it is read against tops out at TIDE_WIPE_TOL_MAX (25%), so at three
  // seeds a SINGLE wipe already exceeds the most permissive setting the dial has and
  // the guard trips at every hardness. Brutal would stop being able to say "one
  // fight in four can end you" — not because the rule changed, but because the
  // instrument reading it got too coarse to express it. Five keeps the resolution
  // inside the ceiling; three does not.
  TIDE_GUARD_SEEDS: 5,
  TIDE_GUARD_STEPS: 3,
  // How many rounds ONE probe of the sizer's search simulates.
  //
  // A TAIL BOUND, AND NOT A SPEEDUP — which is worth stating plainly, because it
  // was added to be one. The search runs thirty to sixty full auto-resolved
  // battles to price an encounter, and a probe was free to run to the engine's own
  // 60-round limit, so bounding it looked like the obvious saving. Measured over
  // 2,400 probes (4 map seeds x 5 army sizes from a starting force to 900x it x
  // wild stacks, boxes and banks x every multiplier rung the bracket and the
  // bisection can visit x 4 seeds each), a probe runs:
  //
  //     median 2   p90 9   p99 17   p99.9 22   max 32
  //     past 20 rounds: 4 of 2400 (0.2%)      past 12: 106 (4.4%)
  //
  // The 60-round limit therefore never bound anything, and capping bought almost
  // nothing: swept across 72 sized encounters (3 seeds x 4 army sizes x 2 hardness
  // x kinds), every bound from 30 down to 5 produced the IDENTICAL sized fight —
  // 72/72, zero drift — while the whole sweep went from 8622ms to 8175ms at a
  // bound of 5. A 5% saving for clipping four fifths of the distribution.
  //
  // So the cost is the NUMBER of probes times a short battle, not the length of
  // any of them, and the levers that would actually move it are TIDE_SEARCH_SEEDS
  // and TIDE_GUARD_SEEDS — which change how many samples the median and the wipe
  // rate are taken over, and so change the dial itself.
  //
  // 24 is kept anyway, for what a bound is actually for: no single probe of sixty
  // can run away on a pairing the sweep did not sample. It sits above the measured
  // p99.9 with room, so it clips the longest 0.2% and nothing else.
  TIDE_PROBE_ROUNDS: 24,
  TIDE_GUARD_MAX_BACKOFF: 4, // the guard may quarter the multiplier, never more
  // How far past the requested cost a fight may land before the guard treats it as the
  // wrong fight. The cost curve is a cliff, so the two ends of a bisection can sit on
  // either side of the target with neither near it; this bounds how badly the nearer
  // end may still overshoot.
  TIDE_OVERSHOOT_MAX: 2.0,
  // Reaching this without meeting the target is a real answer, not a failure: one
  // stack of peasants cannot be made into a fight for a millions-strong hero at any
  // count, because a scaled guard is one stack on one hex and overkill against it is
  // free. Recording the capped multiplier says so; the old rule asked for 1,924x and
  // reported a hard fight that cost 0%.
  //
  // Set from measurement, not from taste. A week-8 doomstack against an 8-creature
  // wild stack needs x2048 before the fight costs anything at all (x512 → 0.0%,
  // x1024 → 6.7%, x2048 → 23.1%), so a lower cap quietly hands the late game back its
  // walkovers — which is the half of the session the chronicle complained about most.
  // It is affordable because the sim costs the same whatever the counts are: measured
  // 1.68 ms at 4,096 creatures and 1.01 ms at 32,768, since the engine resolves
  // STACKS, not bodies. STRIDE^BRACKET = 8^4 reaches exactly this ceiling.
  TIDE_MULT_MAX: 4096,
  TIDE_MULT_CACHE_MAX: 256,
  // Hover cards the adventure map keeps priced (AdventureScene.objectCardData).
  // Each one costs a full auto-resolved battle to produce — 26-99ms measured — and
  // this used to be a memo of ONE, so running the pointer along a road of guards
  // re-priced every stack on the way out and again on the way back. 128 covers any
  // neighbourhood a player actually sweeps, at a few hundred bytes an entry.
  MONSTER_CARD_CACHE_MAX: 128,
  // When an encounter takes longer than this to BUILD, say so in the console.
  // Sizing a PvE fight runs a bracket, a bisection and a wipe guard, each probe a
  // full auto-resolved battle — measured 15-180ms across every defender kind on a
  // real day-57 game, at every position of the hardness dial. A quarter second is
  // therefore comfortably above anything normal and well below the "several
  // seconds" a player would report, so the line only ever appears for the thing it
  // was added to catch, and its ABSENCE during a freeze is just as informative:
  // the time went somewhere other than the engine.
  SLOW_ENCOUNTER_MS: 250,
  // Siege arrow-tower damage multiplier. A tower's raw shot (roll[8,15], atk 12)
  // is a rounding error against a real assault army, so a fortress's towers felt
  // ornamental. This tunable (Settings slider, seeded per battle) scales every
  // tower shot so the walls bite. 1.0 = the raw creature stat (classic); the
  // default makes towers a genuine deterrent without deciding the siege.
  SIEGE_TOWER_DAMAGE_DEFAULT: 2.5,
  SIEGE_TOWER_DAMAGE_MIN: 0.5, // towers as a nuisance
  SIEGE_TOWER_DAMAGE_MAX: 6,   // "murder holes" — a turtle's dream
  // #9 — divine ZPD intervention. In a lopsided battle, if the weaker side is a
  // hero we can bolster (the attacker, or the defender in PvP) and sits below
  // TIDE_INTERVENTION_THRESHOLD × the opponent, roll the level's chance; on a
  // hit, gift that hero elite creatures until it reaches ~TARGET × the opponent.
  // Aggregate-fair (a predictable RATE + magnitude), not per-battle telegraphed
  // — it makes SKILL, not army size, decide, and helps whichever side is the
  // underdog (the AI too). The level is the player's knob.
  TIDE_INTERVENTION_DEFAULT: 'normal',
  TIDE_INTERVENTION_LEVELS: ['off', 'easy', 'normal', 'hard'],
  TIDE_INTERVENTION_CHANCE: { off: 0, easy: 0.85, normal: 0.65, hard: 0.4 },
  TIDE_INTERVENTION_THRESHOLD: 0.6, // only a "much weaker" side (<60% of the foe) qualifies
  TIDE_INTERVENTION_TARGET: 0.9,    // legacy default target (now the POWER slider's default)
  // The intervention now rolls TWICE: (1) the level's CHANCE decides IF it fires,
  // then (2) a random target multiple in [FLOOR, power] decides HOW BIG — the
  // underdog is lifted to that fraction of the foe. `power` is a Settings slider
  // (0 … MAX) so divine help can reach PARITY and beyond — up to 200% of the foe,
  // an overwhelming rescue — instead of the old fixed ~90% ceiling.
  TIDE_INTERVENTION_POWER_DEFAULT: 0.9, // slider default (≈ the old behaviour)
  TIDE_INTERVENTION_POWER_MIN: 0,       // 0% — magnitude off (chance still gated by the level)
  TIDE_INTERVENTION_POWER_MAX: 2.0,     // 200% — the heavens overwhelm the field
  TIDE_INTERVENTION_TARGET_FLOOR: 0.5,  // a fired gift lifts to at least ~50% of the foe
  TIDE_GIFT_CREATURE: 'archangel',  // the "divine" gift (falls back to the strongest creature)
  // The gift LADDER (strongest→weakest, all castle/holy so a "divine" gift reads
  // right). The intervention fills the gap to TARGET with the STRONGEST of these
  // that fits the remaining budget, then FLOORS the count — so a small gap gets a
  // smaller holy unit (a monk, a crusader) instead of a whole archangel that would
  // overshoot parity and obliterate an on-par foe. Combined power lands about equal.
  TIDE_GIFT_LADDER: ['archangel', 'angel', 'champion', 'cavalier', 'zealot', 'crusader', 'monk'],
  // AI stack-splitting: an AI army kept as ONE stack per creature is trivially
  // neutralized — Blind/Paralyze the single giant stack and its whole force is
  // out. At deploy, an AI side's strongest stack is spread across its EMPTY slots
  // (mildly randomized), so a single mass-disable only catches a fraction. The AI
  // may learn to split HARDER against a disable-happy foe (up to _MAX). Deploy-only:
  // survivors merge back on write-back, so the stored army stays consolidated.
  // A heroless PvE defender deploys split too (CombatEngine.deployArmyOf). Not a
  // difficulty setting but a rule, because it is the fix for an exploit rather than a
  // dial: a wild stack that deploys as one blob is disabled by one Blind and then
  // killed unretaliated, and the same one-stack-one-hex shape is what made overkill
  // against a tide-scaled guard free. Fewer pieces than a commanded army gets — a
  // wandering pack spreads out, it does not manoeuvre.
  PVE_STACK_SPLIT: true,
  PVE_SPLIT_PARTS: 3,
  AI_SPLIT_PARTS_DEFAULT: 3, // baseline pieces the strongest stack is torn into
  AI_SPLIT_PARTS_MAX: 5,     // the most a well-taught AI will fragment it
  // AI learning: a running memory of the human's tactics that nudges AI behavior
  // so the same trick stops working. v1 tracks how often the human MASS-DISABLES
  // (Blind) the AI's stacks — an EWMA over battles, so it weights RECENT fights
  // and forgets old ones (learns, then adapts if you change up). A high rate makes
  // the AI split HARDER (toward AI_SPLIT_PARTS_MAX). state.aiMemory, round-tripped.
  AI_LEARN_RATE: 0.34, // EWMA weight on the latest battle (~4 blind-heavy fights → max split)
  // ---- Learning from OUTCOMES, not just from numbers (state.aiMemory.tideBias) ----
  // The PvE sizer aims a fight at a target cost and never found out whether it hit.
  // Its estimate runs the defender against a SIMULATED copy of your hero on the
  // computer brain, and a human who plays better than that proxy — most of them —
  // is quoted a fight that costs a fraction of what was intended. This is the
  // correction: the sizer is graded on what the fight actually cost you, and aims
  // higher next time when it undershot.
  //
  // It is a CORRECTION, not a second difficulty dial. Bounds are deliberately
  // modest and symmetric in log terms, so a run of luck cannot compound into a
  // different game than the one the player chose — and so the dial they DID choose
  // still decides the shape of it.
  // ASYMMETRIC on purpose: quick to ease, slow to press. Relief for a player being
  // mauled should arrive while they still care; escalation against one walking
  // through the map should have to be EARNED over several fights, or a couple of
  // lucky walkovers peg the correction at its ceiling and the world stiffens for a
  // reason the player cannot see. Measured at the symmetric 0.25: two fights to the
  // cap, which is twitching rather than learning.
  TIDE_BIAS_RATE_UP: 0.03,   // pressing a player who keeps winning cheap (4 fights to the cap, measured)
  TIDE_BIAS_RATE_DOWN: 0.3,  // easing one who keeps being mauled (~2 fights to real relief)
  TIDE_BIAS_MIN: 0.6,        // the most it will ever ease a player it keeps mauling
  // The most it will ever press a player who keeps walking through. Chosen by
  // measurement, not taste: swept on scripts/sim/tide-cost.mjs --bias, 1.4 is the
  // largest correction that produced ZERO wipes across the whole sweep (median cost
  // 20.0% -> 25.1%). At 1.6 and above, week-1 fights start annihilating the
  // attacker outright. A correction that can kill you for winning four fights
  // cheaply is not a correction, and four cheap fights is also just what picking
  // your battles well looks like.
  TIDE_BIAS_MAX: 1.4,
  TIDE_BIAS_RATIO_MIN: 0.25, // a free win reads as "4x too easy", never as infinity
  TIDE_BIAS_RATIO_MAX: 3.0,  // and a mauling as "3x too hard"
  // The highest cost the correction may ever AIM a fight at, above the dial's own
  // top (TIDE_LOSS_MAX). It has to be allowed past that ceiling or the correction
  // is dead exactly where it is most needed: a player walking through Brutal is
  // already at 0.38, and clamping the aim there means the sizer can never respond.
  // What keeps such a fight survivable is not this number but the wipe guard, which
  // rejects any multiplier that annihilates the attacker too often.
  TIDE_BIAS_TARGET_MAX: 0.55,
  // AI engagement-ratio learning (Sun Tzu: win WITHOUT bleeding). The AI demands
  // its force exceed a target's by `courage × courageMult` before attacking. That
  // multiplier RECALIBRATES from results vs the human: a LOSS makes it demand much
  // more overkill next time (1.3 → 1.8 → 2.5 → …), a PYRRHIC win (bled heavily to
  // win) nudges it up, and a CHEAP win relaxes it toward the baseline — so it
  // gravitates to the ratio that wins cheaply and amasses ("lurk, amass, attack")
  // when it keeps losing. state.aiMemory.courageMult, round-tripped.
  AI_COURAGE_MULT_MAX: 4,      // the most overkill a burned AI will demand (× base courage)
  AI_COURAGE_UP_LOSS: 1.4,     // lost the fight → demand ~40% more force
  AI_COURAGE_UP_PYRRHIC: 1.15, // won but bled heavily → demand a bit more
  AI_COURAGE_RELAX: 0.92,      // won cheaply → the ratio's good, relax toward baseline
  AI_PYRRHIC_LOSS: 0.4,        // losing > 40% of your army to win is "pyrrhic"
  // Hero-strength estimate (heroUtils.heroPowerValue): raw armyValue ignores the
  // COMMANDER — a hero with a small army but big attack/defense and a full mana
  // bar of nukes is far stronger than its stacks suggest. This converts that into
  // an army-equivalent value so force comparisons (e.g. divine intervention) see
  // it. Scaled by the HERO_POWER_WEIGHT slider so a bad guess can't freeze the
  // game — turn it down (or to 0) and only armies count, as before.
  HERO_STAT_VALUE: 150,   // army-value per point of (attack + defense)
  HERO_SPELL_VALUE: 3,    // army-value per (spell power × mana) — burst potential
  HERO_POWER_WEIGHT_DEFAULT: 1.0, // slider default (full hero estimate)
  HERO_POWER_WEIGHT_MIN: 0,       // 0 = ignore the hero, armies only (classic)
  HERO_POWER_WEIGHT_MAX: 3.0,     // 300% — weight the commander heavily
  // #11 — explore-not-rush: for an opening grace period the AI damps its
  // appetite for the player's towns/heroes (× this factor), so it explores and
  // develops instead of blitzing you early — room to build (and study). The
  // army-superiority gate is untouched, so late-game aggression is unchanged.
  TIDE_NO_RUSH_WEEKS: 3,   // grace period, in weeks from the start
  TIDE_NO_RUSH_AGGR: 0.15, // enemy-town/hero desirability × this during the grace
  // #12 — living emergence: while #7 only SWELLS the stacks the map started
  // with, the world now also breeds NEW wild stacks onto open ground so it keeps
  // producing fresh quarry instead of a fixed set you eventually clear. It fires
  // EVERY week (from week 2 on) as a steady trickle, with a bigger surge at each
  // month's dawn (weeks 5, 9, 13, …) — so the map never goes quiet for weeks at a
  // stretch. Each stack's power scales with how far the game has run (a young
  // world stays soft, an old one breeds meaner), and every stack is stamped with
  // count0 so the weekly #7 growth then caps it like any other. Deterministic;
  // inert in Classic.
  TIDE_WEEK_SPAWN_BASE: 1,       // wild stacks bred each ORDINARY (non-month) week
  TIDE_WEEK_SPAWN_PER_MONTH: 0.5,// … +1 every ~2 elapsed months (floored) …
  TIDE_WEEK_SPAWN_MAX: 3,        // … clamped, so an aging map never floods
  TIDE_MONTH_SPAWN_BASE: 2,      // the bigger surge bred at the first monthly dawn (month 2)
  TIDE_MONTH_SPAWN_PER_MONTH: 1, // +this many stacks per elapsed month …
  TIDE_MONTH_SPAWN_MAX: 6,       // … clamped here, so the surge never floods
  TIDE_MONTH_SPAWN_BUDGET: [700, 1400], // aiValue window for a month-2 stack …
  TIDE_MONTH_SPAWN_BUDGET_GROWTH: 0.5,  // … ×(1 + this × elapsed months): older ⇒ meaner
  TIDE_MONTH_SPAWN_UNDERGROUND: 0.25,   // share of stacks that surface underground (when it exists)

  // ---- Study-break module: REMOVED IN THIS CLONE ---------------------------
  // Upstream, ~110 lines of tuning for an edutainment module: a Pomodoro study
  // break (#10) that pays in-game resources for auto-graded math problems, a
  // library reading break (#20) graded on a typed recall, and a doubling study
  // streak (#21). All of it — every STUDY_* key, the recall grader's constants
  // and the ladder table — goes with game/study*.js and scenes/StudyScene.js.
  // It also carried STUDY_MSG_SOURCE, which named a private third-party app.


  MINE_INCOME: {
    sawmill: { wood: 2 },
    orePit: { ore: 2 },
    goldMine: { gold: 1000 },
    alchemistLab: { mercury: 1 },
    sulfurMine: { sulfur: 1 },
    crystalCavern: { crystal: 1 },
    gemPond: { gems: 1 },
  },

  // ---- Boats & shipyards -------------------------------------------------
  // Price a visiting hero pays at a neutral shipyard to have a boat built on
  // an adjacent free water tile (mirrors HoMM3's 1000 gold + 10 wood).
  BOAT_COST: { gold: 1000, wood: 10 },

  // ---- Map generation ----------------------------------------------------
  // Habitat bias for wild stacks: the chance a seated stack is drawn from the
  // creatures whose FACTION is native to the tile's terrain (FACTIONS.*.
  // nativeTerrain) — a swamp tends to hold Fortress broods, lava Inferno,
  // snow Tower. Only a TENDENCY, never a law: the complement draws from the
  // full roster, so any creature can still turn up anywhere and no faction is
  // fenced out of the map. 0 = fully random seating (the old behaviour, which
  // landed a native stack only ~15% of the time — pure coincidence); 1 would
  // make terrain a uniform monoculture. 0.55 reads as "this land is THEIRS"
  // while every other stack stays a surprise.
  WILD_NATIVE_CHANCE: 0.55,

  // ---- Towns -----------------------------------------------------------
  GROWTH_CITADEL_MULT: 1.5, // weekly growth multiplier with Citadel
  GROWTH_CASTLE_MULT: 2.0,  // weekly growth multiplier with Castle
  GRAIL_GROWTH_MULT: 1.5,   // the Grail structure's blessing: +50% creature growth in its town
  // Per-faction Grail structure: every faction's Grail gives the +growth above,
  // and on top of that ONE signature blessing that echoes its identity —
  //   castle  (Order · Faith · Steel)     — a prosperous holy capital: +gold/day
  //   inferno (Fire · Fury · Dominion)    — the legions swell: a STRONGER growth
  //                                          multiplier (used instead of the base)
  //   tower   (Arcane · Frost · Wonder)   — an arcane font: a hero waking in the
  //                                          town restores ALL its mana
  //   rampart (Nature · Harmony · Grace)  — the forest teems with life: a
  //                                          stronger growth multiplier (used
  //                                          instead of the base)
  //   necropolis (Death · Silence · Dominion) — the crypts overflow: the
  //                                          strongest growth multiplier, the
  //                                          undead horde swelling without end
  //   dungeon (Magic · Malice · Mastery)  — a warlock's plundered hoard: the
  //                                          richest +gold/day of any capital
  //   stronghold (Blood · Fury · Iron)    — the endless horde: a stronger growth
  //                                          multiplier, barbarian numbers swelling
  //   fortress (Scale · Mire · Endurance) — the teeming swamp: a stronger growth
  //                                          multiplier, the fen breeding without end
  //   conflux (Air · Water · Fire · Earth) — a font of the elemental planes: a
  //                                          hero waking in the town restores ALL mana
  // Add a faction here to give its Grail a bonus; absent ⇒ just the +growth.
  // CLONE: all nine rows are kept even though only castle and inferno are playable
  // (data/factions.js), the same rule data/creatures.js and data/upgradeNodes.js
  // follow. The table is only ever read for an actual town's faction, so the seven
  // extra rows are inert — and they are what keeps the `fullMana` and `gold` Grail
  // perks under test (tests/grail-v2.test.js), neither of which the two playable
  // factions between them exercise. Restoring a faction needs no edit here.
  FACTION_GRAIL: {
    castle:  { gold: 500 },
    inferno: { growthMult: 2.0 },
    tower:   { fullMana: true },
    rampart: { growthMult: 1.75 },
    necropolis: { growthMult: 2.0 },
    dungeon: { gold: 750 },
    stronghold: { growthMult: 2.0 },
    fortress: { growthMult: 1.75 },
    conflux: { fullMana: true },
  },

  // ---- Weekly events ("Week of the ...") -------------------------------
  WEEK_CREATURE_CHANCE: 0.4,  // P(a new week is a "Week of the <creature>")
  WEEK_PLAGUE_CHANCE: 0.1,    // P(a "Week of the Plague") — the rest are plain
  WEEK_CREATURE_MULT: 2.0,    // matching creature's weekly growth ×this
  WEEK_CREATURE_BONUS: 5,     // …plus this flat bonus in each matching dwelling
  WEEK_PLAGUE_MULT: 0.5,      // plague weeks: all weekly growth ×this

  // ---- Monthly events ("Month of the ...") -----------------------------
  // At the dawn of each new MONTH (from month 2 on — weeks 5, 9, 13, …) a
  // stronger, rarer beat can land instead of a plain week: a bumper season for
  // one creature, or a harsher plague. Reuses the exact weekly-growth seam via
  // an event.month flag, so a Month of the <creature> just multiplies harder.
  MONTH_CREATURE_CHANCE: 0.5,  // P(a new month is a "Month of the <creature>")
  MONTH_PLAGUE_CHANCE: 0.12,   // P(a "Month of the Plague")
  MONTH_CREATURE_MULT: 3.0,    // matching creature's weekly growth ×this (vs 2.0 weekly)
  MONTH_CREATURE_BONUS: 10,    // …plus this flat bonus in each matching dwelling
  MONTH_PLAGUE_MULT: 0.25,     // plague months bite deeper than plague weeks

  // ---- Weekly-resource visitables (Windmill / Water Wheel) --------------
  WINDMILL_MIN: 3,          // Windmill yields this many…
  WINDMILL_MAX: 6,          // …up to this many of a random non-gold resource, weekly
  WATER_WHEEL_GOLD: 1000,   // Water Wheel yields this much gold, weekly

  // ---- Trade Fair: a weekly bundle of MIXED resources -------------------
  // The windmill pays one resource; a fair pays several at once, so a weekly
  // circuit of the realm is worth a hero's days rather than an afterthought.
  TRADE_FAIR_KINDS: 3,      // distinct non-gold resources in one bundle
  TRADE_FAIR_MIN: 2,        // each yields this many…
  TRADE_FAIR_MAX: 5,        // …up to this many
  TRADE_FAIR_GOLD: 750,     // plus this much gold

  // ---- Invasions (opt-in `invasions`): the waves of history ---------------
  // A realm is not a sealed box. Roughly every three to four months a foreign
  // people crosses the border; every 3rd wave is a real host and every 5th an
  // apex horde that forces even the rival realms to look away from you.
  INVASION_FIRST_DAY: 57,        // ~2 months of peace before the first outriders
  // 84+-14 -> 28+-7. Asked for as "shorten the bands too, they should come faster
  // everywhere", alongside the heavy tier's 55-95 -> 14-21.
  //
  // WHAT THIS ACTUALLY BUYS IS SMALLER THAN IT LOOKS, and saying so is the point.
  // The light tier STANDS DOWN whenever a nation is ashore (see tickInvasions:
  // bands on top of a nation double the pressure and the AI cost for no added
  // drama) and burns its slot when it does. Measured over 500 days against a
  // defender who breaks each foothold in 5-20 days, a nation is ashore 82% of the
  // calendar — so at 84 days the light tier landed ONE wave in five hundred, its
  // every other slot falling inside somebody's occupation. A shorter period does
  // not overrule the stand-down; it means more slots come due, so more of them
  // fall in the gaps between peoples, which is the only place a band wave was ever
  // going to land. Under the Pax the period is PAX_INVASION_PERIOD_DAYS (21).
  // LEFT AT 28 deliberately, though "keep them just as a rare once in a while event"
  // would seem to ask for widening it. It does not need to be widened: bands stand
  // down entirely while a nation is ashore (tickInvasions), and once nations begin
  // one is ashore most of the time. Measured over 200 days with nations from day 70
  // — ONE band landing against three nations, which is already "rare, once in a
  // while". Widening this to 56 changed that to one against three: nothing, at the
  // cost of contradicting the earlier ask in this same file ("shorten the bands too,
  // they should come faster everywhere"). Rarity here is a consequence of the
  // stand-down, not of the period, so the period keeps the meaning it was given.
  INVASION_PERIOD_DAYS: 28,      // a month between waves…
  INVASION_PERIOD_JITTER: 7,     // …give or take a week (so 3-5 weeks)
  INVASION_BASE_POWER: 2600,     // aiValue budget for one band of the first wave
  INVASION_WAVE_GROWTH: 0.55,    // each wave is this much stronger than the first
  INVASION_MIN_BAND: 4,          // never a band so small it reads as a stray
  INVASION_LANDFALL_SPREAD: 8,   // a people arrives from ONE direction, not all
  // How long a band should take to cross the country from its landfall to the
  // town it is marching on. A band used to take exactly one tile a day, which on
  // a 72x60 map meant landing 38 tiles out and arriving on DAY 141 — twelve weeks
  // after the herald, and past INVASION_BAND_LIFESPAN, so on the largest maps a
  // band could expire and go home without ever being seen. Each band now takes as
  // many steps a day as it needs to arrive in about this long, whatever the map
  // size, which also gives the herald an honest ETA to quote.
  INVASION_MARCH_DAYS: 16,
  INVASION_MARCH_MAX: 4,         // …but never a blur: at most this many tiles a day
  INVASION_ROUTE_AFTER: 2,       // no headway for this long ⇒ stop guessing, find a route
  INVASION_STUCK_DAYS: 8,        // and if there is no route at all ⇒ turn for home
  // A bigger world holds bigger nations. The band budget below is calibrated for
  // a 36x30 map; on larger ones it is multiplied by sqrt(area / that area), so the
  // largest map meets a wave about twice the size. Note this scales with the
  // WORLD, not with the player's army — the point of history is that it does not
  // check whether you are ready — but a realm with four times the land to farm
  // should not meet the same sixteen gogs.
  INVASION_BASE_AREA: 36 * 30,
  INVASION_AREA_SCALE_MAX: 2.5,
  // PARITY. The absolute budget above sets the floor history arrives with; this
  // sets the floor it arrives at RELATIVE to the age's greatest army, and a wave
  // takes whichever is larger.
  //
  // The absolute numbers alone produced a joke. Reported from week 9 of a largest
  // map: "33 pikemen approaching a town — no match for my armies. If they were 30
  // archangels it could be a fight, but with hero attack and defense counted,
  // better 50." Fifty archangels is ~439,000 army value; the wave-1 budget was
  // 5,200. Eighty-four times out.
  //
  // Taking the MAX preserves what the absolute budget was for — an under-developed
  // realm still meets the full historical wave and does not get an easier one for
  // being weak — while guaranteeing a developed realm meets something worth
  // marching out for. Exactly the shape of TIDE_HARDNESS: scaled UP to the floor,
  // never down. Measured against the strongest field army of ANY realm, not the
  // player's: the invaders come in proportion to the greatest power of the age.
  //
  // Per TIER, as a multiple of that army, TOTAL across the wave's bands:
  //   raid  — one army's hard fight (the player's own calibration)
  //   host  — half again; each of its two bands is beatable alone, together not
  //   horde — three times, spread over three bands; this is the one you need
  //           allies for, and the truce exists precisely because of it
  INVASION_PARITY: { raid: 0.9, host: 1.6, horde: 3.0 },
  // A band should read as an army, not a swarm: the budget buys the strongest
  // creature its people can field that still leaves at least this many of them.
  // Does a band that reaches a town STORM it? Reported as "they got to the town and
  // sit at the gate, they do not attack" — because nothing in the band model could.
  // A band that outweighs the defence goes over the walls; one that does not strips
  // what it can and rides on. Neither parks.
  // How far a band must outweigh the defence before it tries the walls. Measured over
  // 315 real assaults, by ratio of bandForce to townDefense:
  //   <0.5   0/81 taken      1.0-1.5  27/33 taken
  //   0.5-1.0 7/57 taken     >=1.5    30/30 taken, and undefended 45/45
  // The flip is tight — lowest win 0.94, highest loss 1.11 — so a gate at 1.15 meant
  // a band never lost an assault, and a defence that can never hold is not a defence.
  // At parity it wins about five times in six, which is a rational risk for it (a
  // repulsed band is destroyed) and leaves the near-enough garrison worth building.
  INVASION_ASSAULT_MARGIN: 1.0,
  INVASION_WALL_FACTOR: [1, 1.4, 1.7, 2.0], // what a Fort/Citadel/Castle is worth to
                                   // the defender, by tier — the same three buildings
                                   // the engine reads to raise real walls, so the
                                   // decision and the fight price the town alike
  INVASION_DISCIPLINE_WORTH: 0.12, // a people's drill is a flat attack/defense bonus
                                   // in combat; read as this much stack worth per
                                   // point, so the decision does not misprice them.
                                   // Applied by invasions.bandUnitWorth, which is
                                   // BOTH what the budget buys in and what bandForce
                                   // sells in — they used to disagree, and every band
                                   // landed over its parity share by its own drill
                                   // (a raid at 0.90 for a people with no discipline,
                                   // 1.22 for the Legion of the Eagle).
  // A band should read as an army, not a swarm: the budget buys the strongest creature
  // its people can field that still leaves at least this many of them. NOTE this is a
  // floor, not a ceiling — once the budget outgrows the top of a people's roster there
  // is nothing left to trade up to and the count simply grows. Measured on 72x60 at a
  // 250k benchmark (reached about day 90 in a played game): 79 champions for the Legion
  // of the Eagle, 402 liches for the Pale Migration, from the same budget — because a
  // lich is 15x cheaper than an archangel and the two rosters do not top out alike.
  INVASION_READABLE_BAND: 25,
  // …and the ceiling the floor never had. Past this, a stack stops reading as an army
  // and starts reading as a mob — the failure this module already met once ("and then
  // 3795 wolf riders"), which was fixed at the BUDGET level, and a budget fix cannot
  // bound a stack. Measured before the fix, on 72x60 over 1,440 (map, benchmark, wave,
  // people) cells: 31.3% of bands came out above 300 creatures, the worst 3,571.
  // A band over the cap does NOT get clipped — clipping would quietly make the wave
  // lighter than INVASION_PARITY says it is. It SPLITS: the same creatures arrive as
  // more bands (see splitBand), which is the module's own thesis — "they fielded more
  // armies than Rome could raise; the aggregate is the horror, not the stack".
  INVASION_MAX_BAND: 150,
  // What splitting costs, and therefore why it is affordable: a war-band is not a hero.
  // Measured through tickInvasions (marchBand + routing) at 0.15 ms per band per game
  // day — 32 bands cost 4.8 ms/day on 96x80, against 40-75 ms for ONE hero. The real
  // limits are the map's own: landfall spots near a single landing point number about
  // 15 (worst case 10 across every shipped size), and a wave that arrives as twenty
  // separate armies is a different feature. Twelve is the ceiling on both counts.
  INVASION_MAX_BANDS_PER_WAVE: 12,
  // A wave's quality FLOOR (waveIndex/2, plus a rung for a host and two for a horde)
  // could name a rung the budget cannot fill: measured, the Legion of the Eagle's host
  // at wave 9 was FIVE archangels, and 4.0% of all cells came out under
  // INVASION_READABLE_BAND. Five of anything is not an army either. The floor may now
  // give way by this many rungs — and only when doing so actually reaches a readable
  // band — so "a people never regresses" survives while token stacks do not. Two is the
  // SMALLEST value that clears the sweep: at 1 the Sublime Host's wave-9 host was still
  // 7 titans (6 cells, 0.4%); at 2 no cell is under the readable floor; 3 gains nothing.
  // With a budget too small for any rung the floor still stands unmoved, which is what
  // keeps "a people never regresses" true where it is actually claimed.
  INVASION_FLOOR_RELAX: 2,
  INVASION_SACK_SHARE: 0.25,     // share of stores carried off in a sack
  INVASION_TRUCE_DAYS: 42,       // how long a horde keeps the rivals off your back
  INVASION_SACK_COOLDOWN: 7,     // a band cannot strip the same town day after day
  INVASION_RAID_SACKS: 1,        // a raid takes this much and then rides on
  INVASION_BAND_LIFESPAN: 120,   // no band is immortal; it eventually withdraws

  // ---- AI force concentration ---------------------------------------------
  // Playtest report: "the AI does not have what to do, eventually it started
  // sending 1-2 heroes everyday, I killed them off ... no real threat, just have
  // to divert heroes to intercept". Measured in a 33-day sim: the AI held FOUR
  // heroes sharing 82,185 army value — ~20k each — against a single 223,552
  // player hero. It was not attacking hopelessly; it was dividing one army into
  // portions small enough to eat one at a time, and hiring replacements for the
  // ones it lost. A realm that is outclassed should mass, not dilute.
  AI_MASS_RATIO: 0.8,   // stop hiring while my best hero is under this × the strongest foe
  AI_MIN_HEROES: 2,     // …but never drop below this many (one to hold, one to work)
  // …and never below this many while the realm is ALSO losing the economy (it
  // holds under its fair share of the map's mines). Force concentration is a
  // military argument and has nothing to say about a hero walking to a mine;
  // left unqualified it latched on the moment the player pulled ahead and the
  // rival never flagged another mine — the "they cannot keep up with production
  // and economy" report. See AIPlayer.economyStarving.
  AI_ECON_HEROES: 3,

  // ---- The computer turn on the player's screen -----------------------------
  // Measured at the largest shipped preset (88×72 "Age of Empires", 60 days,
  // scripts/sim/aiperf.mjs 60 88 72): one AI turn's THINKING peaked at 2.8
  // seconds of continuous main-thread work before the engine work of 2026-08,
  // and its trail ANIMATION at 56 seconds — two different freezes, two knobs.
  //
  // AI_SLICE_MS is the thinking budget per AITurnController.next() call from
  // AdventureScene: the controller returns { type: 'paused' } once it's spent
  // and the scene hands the browser a frame before continuing. 12ms leaves
  // ~4ms of a 60fps frame for Phaser to render; the slice can overrun by one
  // atomic unit of work (one plan / one auto-battle), so the worst real block
  // is bounded by the engine's worst single plan, not by the whole turn.
  // Headless callers pass no budget and never pause. Slicing never changes
  // what the turn computes (tests/ai-slicing.test.js proves byte-identical
  // outcomes), so this knob is pure presentation and safe to retune.
  AI_SLICE_MS: 12,
  // The trail replay budget for one AI player's turn. Late-game at 88×72 a
  // turn's EXPLORED trail reaches ~100 steps on average and 226 at worst
  // (aiperf's by-quarter row) — at the base pace (150ms ÷ 0.8 animSpeed ≈
  // 188ms/step) that is 42 seconds of watching tokens glide. The budget
  // compresses the pace once a turn's trail would overrun it (never below
  // AI_TRAIL_MIN_STEP_MS — steps stay readable), and anything past the budget
  // lands instantly, exactly like the off-screen fast-forward. Short early-
  // game trails fit inside the budget untouched at the base pace.
  AI_TRAIL_BUDGET_MS: 6000,
  AI_TRAIL_MIN_STEP_MS: 40,
  // Base per-tile walk animation (ms, before the animSpeed setting divides it) —
  // one pace for the human's heroes and the computer's alike (the scene's
  // argument for one constant lives at its use site). It lives HERE rather than
  // in AdventureScene so scripts/sim/aiperf.mjs prices the trail off the number
  // the scene actually uses: the instrument spent a year claiming "200ms per
  // step" after the scene had moved to 150, because the constant was private to
  // a file an instrument cannot import (it pulls in Phaser).
  STEP_ANIM_MS: 150,

  // ---- The underworld ------------------------------------------------------
  // Measured against a play report of "4-5 mines, a monolith, 2 power poles,
  // mostly just walking": the caverns carried 38 objects to the surface's 120 on
  // the same grid, i.e. 27-38% of surface density depending on size. It read as
  // empty ground with a few prizes in it. This multiplies the vault's loot budget
  // and — more importantly — gives the lower level things worth RETURNING for
  // (dwellings that grow, weekly sites) rather than only one-shot pickups.
  UNDERGROUND_RICHNESS: 2.4,   // multiplier on the vault's loot counts

  // A one-shot reward site (Pandora's Box, Creature Bank, boss lair, Seer Hut)
  // is REOCCUPIED this many weeks after it is emptied — the `siteRespawn`
  // feature. The map is a place, not a checklist: an emptied vault standing open
  // for the rest of a sixty-week game is a dead tile, and re-seating one costs no
  // art, no new object type and no new sprite.
  //
  // Four weeks is the interval because it is long enough that clearing a site
  // still feels like clearing it, and short enough that a road you kept open
  // pays for itself twice in a long game.
  SITE_RESPAWN_WEEKS: 4,
  // The reoccupied site is TIDE-SIZED from the start: its guard is raised to
  // this fraction of the sizing army below, so the second visit is a fight worth
  // the trip rather than a walkover you have long outgrown. Never scaled DOWN —
  // a site whose own table is harder than that keeps its teeth. Deliberately the
  // same shape and the same number as TIDE_HARDNESS, and it uses the player's own
  // hardness setting when there is one, so "Relaxed" and "Brutal" mean the same
  // thing here as everywhere else.
  SITE_RESPAWN_TIDE: 0.85,
  // WHOSE army that fraction is OF is not a knob here, deliberately: a reload is
  // anchored by GEOGRAPHY, through the same neutrals.bandAnchor the wandering
  // stacks use (PEG_TERRITORY_GEOMETRIC and friends). It used to be the strongest
  // army in the world, which made every reoccupied site on the map a wall for
  // everybody except the leader — a trailing realm met them at up to seven times
  // its whole army, its own back yard included, and was locked out of the rule
  // for good. The band peg had already measured and answered exactly that, so a
  // vault now reads the map the same way its wandering neighbours do: your own
  // hinterland priced against you, a contested frontier against whoever is over
  // the line, open country against the leader.
  //
  // Anti-farming then lives where the farming is. Farming is harvesting the SAME
  // renewable tile again and again, not winning one hard fight — so each reload
  // of a given site adds this fraction to its own guard, for whoever is doing it,
  // capped so a sixty-week game cannot drive one tile to absurdity.
  SITE_RESPAWN_RELOAD_STEP: 0.45,
  SITE_RESPAWN_RELOAD_CAP: 4,   // the escalation stops climbing after this many reloads

  // Artifacts are a COLLECTION, not an economy. Mines, monsters, chests and
  // boosters scale with a map's AREA because territory is what they measure —
  // but the artifact catalog holds a finite number of DISTINCT artifacts, and
  // past the map size it can fill, an extra seat can only repeat one. World's
  // Edge (144×120) asked for 110 artifacts across its two levels against 52 the
  // catalog could serve, and handed out the same sword four times.
  //
  // So artifact density grows with the map up to this area and then stops.
  // 96×80 is Clash of Kingdoms, the largest preset the catalog fills without a
  // repeat (see tests/artifact-treasure.test.js, which pins that line). Every
  // preset at or below it is unaffected, seat for seat and draw for draw.
  // Raising it means adding artifacts first, or the repeats come back.
  ARTIFACT_DENSITY_CAP_AREA: 96 * 80,
  UNDERGROUND_DWELLINGS: 2,    // per reference area; recruitment worth a trip back
  UNDERGROUND_WEEKLY: 2,       // a deep market / an underground river wheel

  // ---- Rich Lands (opt-in `richLands`): a husbandry economy ---------------
  // Default maps put every RARE mine in the contested middle band, so a small
  // map has exactly one crystal cavern and one gem pond for all three towns and
  // no reason to tour your own ground. Rich Lands gives each town's zone a full
  // set of all seven mines, a spare of each in the band, and enough weekly
  // sites that keeping the land in shape is a standing job.
  RICH_LANDS_ZONE_SET: 1,     // mines of EVERY resource per town zone
  RICH_LANDS_BAND_SPARE: 1,   // spare of every resource in the contested band
  RICH_LANDS_WATER_WHEELS: 3, // seated early, before the map crowds
  RICH_LANDS_WINDMILLS: 4,
  RICH_LANDS_TRADE_FAIRS: 3,
  // A weekly stop on your doorstep is not a circuit stop — it is a zero-detour
  // freebie for whoever holds that town, and nothing at all for the other player.
  // Measured: 17% of weekly sites sat within 5 tiles of a town, and the two zones
  // could split them 3 against 9, which is why one player reported having "only
  // one wheel available to me" while the rival's stood beside its castle.
  WEEKLY_MIN_TOWN_DIST: 7,   // keep a weekly site this far from any town

  // ---- Utility visitables (Observatory / Magic Spring / Hill Fort) ------
  OBSERVATORY_REVEAL: 12,   // Redwood Observatory: fog-reveal radius (tiles)
  MAGIC_SPRING_MULT: 2,     // Magic Spring: refills mana to this × the hero's max, weekly
  HILL_FORT_FREE_TIER: 4,   // Hill Fort upgrades tiers ≤ this free; higher tiers cost the difference

  // ---- Hero specialties ------------------------------------------------
  // Bonus a creature-specialist hero grants its matching stacks in battle.
  SPECIALTY_CREATURE: { attack: 1, defense: 1, speed: 1 },

  // ---- Combat ----------------------------------------------------------
  BATTLE_W: 15,             // battlefield hex columns
  BATTLE_H: 11,             // battlefield hex rows
  ATTACK_BONUS_PER_POINT: 0.05,   // +5% damage per Attack over Defense
  ATTACK_BONUS_CAP: 3.0,          // max +300% (total x4)
  DEFENSE_REDUCTION_PER_POINT: 0.025, // -2.5% damage per Defense over Attack
  DEFENSE_REDUCTION_CAP: 0.7,     // max -70%
  RANGED_FULL_RANGE: 10,    // hexes; beyond this ranged damage is halved
  DEFEND_DEFENSE_MULT: 1.2, // defending stance: +20% defense stat

  // ---- Multi-day jobs --------------------------------------------------
  // Crews are a REALM-wide pool, not a per-town one: a second town does not
  // double your masons, it competes for them. With unlimited crews every job
  // finishes in exactly `days` days and the scheduler is a list of timers —
  // scarcity is what makes queue order a decision.
  JOBS: {
    // Crews a player starts with, per pool. These are the realm's existing
    // labour and cost NO upkeep — see CREW_UPKEEP_GOLD for why that matters.
    CREWS: { masons: 2, fletchers: 2 },
    DEFAULT_DAYS: 3,          // crew-days a job takes when it names no figure
    // Hiring beyond the starting allotment. Expansion must SOMETIMES be
    // worthless: when the queue is blocked by a dependency chain rather than by
    // crew availability, another crew changes nothing and the upkeep is pure
    // loss. That is Amdahl's law, and it is meant to be discoverable by buying
    // a crew and watching nothing improve.
    CREW_HIRE: { gold: 1500 },
    // Charged per HIRED crew per day, idle or not. Deliberately NOT charged on
    // the starting crews: levying upkeep on those would re-tune the economy of
    // every game ever played, including ones that never queue a job.
    CREW_UPKEEP_GOLD: 40,
    MAX_CREWS_PER_POOL: 6,
    // Option A on starvation (spec §0): no aging, but a job waiting longer than
    // this is flagged so the queue's consequences are legible rather than fair.
    STARVATION_DAYS: 7,
  },

  // ---- Physical damage model (world constants) -------------------------
  // SI units throughout. The per-creature parameters live in creatures.js as a
  // `phys` block; these are the constants of the *world* those parameters sit
  // in, shared by the authoring-time derivation script
  // (scripts/data/derive-physical.mjs) and — from the moment the opt-in
  // `physicalDamage` feature reads them — by the runtime model. One source of
  // truth, so a battlefield that is 2 m per hex in the data cannot be 1.5 m in
  // the formula.
  //
  // A note on why the derivation is authoring-time. ECMA-262 leaves the
  // precision of `pow`/`exp`/`log`/trig implementation-defined, so a damage
  // number computed with a fractional exponent is NOT bit-identical across
  // engines. Everything derived with one is therefore computed once, offline,
  // and committed as a plain number; the runtime model uses + - * / only.
  PHYS_HEX_METERS: 2.0,     // m — width of one battlefield hex (15 hexes ≈ 30 m of front)
  PHYS_AIR_K: 0.919,        // kg/m³ — ½·ρ·Cd for air at sea level (ρ 1.225, Cd 1.5)
  PHYS_SHAPE_K: 1.0,        // — silhouette factor in the ⅔-power frontal-area law
  PHYS_PENETRATION_DEPTH: 0.02, // m — reference distance the impact pressure is taken over
  // What a point of Attack / Defense means once damage comes from momentum. The
  // classic ladder adds ±5%/2.5% per point of difference to the damage itself and
  // caps at +300%/−70%; here Attack is the force behind the point and Defense is
  // what the point has to get through, so the contest is pressure vs hardness and
  // it saturates on its own at "the blow goes all the way in".
  // Both FITTED, not chosen: swept against the classic ladder over all 7,023
  // (attack, defense) pairs that creatures within one tier of each other can
  // actually present, minimising RMS relative error. 4.3%, inside ±5% across the
  // realistic range. That is a calibration target, not a claim that the two
  // models agree — an authored creature departs from the ladder wherever its
  // physics says so, which is the point. It is the UN-authored ones that must
  // not drift, or a sweep measures its own stand-ins.
  PHYS_ATTACK_COUPLING: 0.025,  // fractional blow energy per point of Attack
  PHYS_DEFENSE_COUPLING: 0.17,  // fractional armour hardness per point of Defense
  // TIP RIGIDITY — the only place a blow's MASS has any consequence.
  //
  // With the bow's energy authored, d = E/(σA) has no mass term at all: a heavier
  // head carries the same joules, only slower. That made every mass-increasing
  // upgrade strictly negative and inverted I3 for the whole material-swap class
  // — a denser tip was a downgrade, which is the opposite of the thing the
  // schema exists to express.
  //
  // Real arrows penetrate better when heavier, and the reason lives outside that
  // equation: a tip sustains penetrating force in proportion to its SECTIONAL
  // DENSITY, m/A. Below a rigidity threshold it mushrooms, the effective area
  // grows, and penetration collapses. So mass buys resistance to DEFORMATION,
  // which is worth a great deal against plate and nothing at all against hide.
  //
  // The threshold sectional density is taken as proportional to the hardness the
  // tip meets, and this constant carries the units — kg/m² of tip per Pa of
  // armour — exactly as PHYS_AIR_K and PHYS_SHAPE_K carry theirs.
  //
  // ITS VALUE PLACES THE NICHE, and that is what it is FOR. The gain from added
  // head mass rises with hardness, peaks, then falls away as the coverage gap
  // takes over the total — so every tip has a target class it is worth buying
  // for, and this constant decides which one. The first value, 1.667e-5, was
  // chosen to put a pikeman between a bodkin and a broadhead and nothing else;
  // measured against the roster it left five of six shooters with their niche
  // pinned on the ARCHANGEL, the hardest creature in the game, with no content
  // beyond it. That is a dead investment class dressed as a design, and no test
  // would have noticed.
  //
  // Set by scan now. `scripts/sim/diagnose-peak.mjs` walks k and reports where
  // each shooter's niche lands on the authored ladder; 3.5e-5 sits in the middle
  // of the plateau where every niche has authored targets on both sides of it and
  // at least four of them pay. The invariant is in src/core/rigidity.js and is
  // asserted in tests/physical-damage.test.js — it landed inside the roster by
  // luck the first time and stays inside by assertion now.
  // THE FOUNDING COUPLING, and it was missing from Phase 1 until now. The original
  // brief's exemplar was: denser head -> heavier arrow -> same bow energy -> lower
  // velocity -> shorter reach. `blowSpeed_mps` was derived and then read by NOTHING,
  // so the second half of that chain had nowhere to land and mass was free.
  //
  // It lands on AIM, not on a range cliff, and the arithmetic says why. A slower
  // arrow drops more: drop = 1/2 g (d/v)^2, so d(drop)/dd = g*d/v^2, and a shooter who
  // mis-judges the range by dd misses vertically by g*d*dd/v^2. Divided by d that is
  // an ANGULAR error g*dd/v^2 -- constant in distance, so it adds straight to
  // `dispersion_rad`, which is where the model already turns angle into a hit
  // fraction. A second distance cliff on top of the dispersion falloff would have
  // been double-counting the same loss.
  PHYS_G: 9.81,             // m/s² — gravity, for the drop term
  PHYS_RANGE_ERROR_M: 1.5,  // m — how badly a shooter judges the range at battle distance
  // The bound on that term, as a share of the weapon's own authored aim. It exists
  // because g*dd/v^2 is the FLAT-FIRE linearisation: it holds while the drop over the
  // flight is small against the range (v^2 >> g*d/2, so v >> 10 m/s at battle
  // distance) and says nothing once the shot is a lob. Every bow, sling and bolt in
  // the roster leaves at 21-78 m/s; the two Cyclops heave their boulder at 10.5, sit
  // exactly on the boundary, and were handed 0.133 rad of aim error against an
  // authored 0.04 — 3.3x, against a next-worst of 1.3x. At 1.0 the rule reads
  // "ballistics may at most double a weapon's group", which leaves every authored
  // arrow untouched (their drop is 0.1-0.4x of their aim) and stops one formula
  // becoming the whole weapon for the one class it does not describe.
  PHYS_DROP_MAX_SHARE: 1.0,
  PHYS_RIGIDITY_SD_PER_PA: 3.5e-5, // kg/m² of sectional density needed per Pa of armour
  // ---- The wound: how deep, how wide, and what width is worth ----------------
  //
  // TWO RESISTANCES, BECAUSE THE TRAVERSE CROSSES A REGIME CHANGE. A head opening
  // fresh tissue meets cavity-expansion resistance; the SHAFT behind it rides in a
  // channel that is already open and meets friction. Only 8–24% of a documented
  // penetration depth is inside the head (see `npm run sim:arrest` §4), so a model
  // with one σ is a model of the wrong three quarters — and the two authored heads
  // demand σ values 2.8x apart to reach the same documented depth under one.
  //
  // σ_tissue is the anchored one: cavity-expansion resistance for a sharp penetrator
  // in soft tissue, tens of MPa. The channel is expressed as a FRACTION of it rather
  // than as a second free constant, so the regime change is one named number that
  // can be argued about instead of two that can be traded off against each other.
  //
  // The fraction is what was fitted, to put a base warbow arrow at the middle of the
  // documented 0.25–0.60 m band — and it lands at 4.0 MPa, inside the 3–6 MPa the
  // shaft regime was independently bracketed at. The LEVEL is fitted; that the two
  // fork heads then agree to 1.14x (against 3.1x apart under a head-only model) is
  // free, and is the check.
  PHYS_TISSUE_SIGMA_PA: 2.5e7,  // Pa — cavity-expansion resistance of soft tissue
  PHYS_CHANNEL_FRACTION: 0.16,  // — shaft friction as a fraction of σ_tissue (4.0 MPa)
  // Body thickness along the shot, d_max = K·V^(1/3). Anchored on a human torso:
  // 65 kg of flesh is V^(1/3) = 0.401 m, and a torso is 0.22 m front to back, so
  // K = 0.55. THE ISOTROPIC ASSUMPTION WAS THE WORRY and it survives its own test —
  // a horse at 700 kg gives 0.49 m against a barrel that measures about 0.45–0.50,
  // so the separate walker/flyer factors that were expected are not needed.
  PHYS_DEPTH_K: 0.55,           // — d_max = K · (bodyMass/density)^(1/3)
  // WIDTH, AND WHY IT IS A THRESHOLD. Hunting regulations specify a minimum cut
  // width — commonly 22 mm — precisely because narrower wounds close and stop
  // bleeding. Real broadheads run 25–40 mm, a bodkin shank 6–9 mm, so the threshold
  // sits in the gap with room on both sides: it discriminates the authored content
  // without having been fitted to it. This is what the retracted perimeter term was
  // reaching for and could not express — perimeter is smooth and cancels against
  // area, and CLOSURE IS A THRESHOLD, which cannot cancel.
  PHYS_CUT_WIDTH_M: 0.022,      // m — below this a cut closes and does not bleed
  // λ, and it is ANCHORED BEFORE THE GATE RUNS rather than solved for afterwards.
  // Bleeding tracks cut AREA, width × depth. A full broadhead wound — 30 mm wide
  // through a 220 mm torso — is 6.6e-3 m², and haemorrhage is the mechanism by
  // which such a wound kills, so it is worth about DOUBLING the unarmoured hit:
  // λ = 1/6.6e-3 ≈ 150. What the fork actually needs is reported separately as
  // λ_min by `npm run sim:width`, and comparing the two is the point. Tuning this
  // until the gate greens is the failure this project has already refused twice.
  PHYS_BLEED_LAMBDA: 150,       // 1/m² — bleeding per m² of cut area
  // War machines a hero buys at a Blacksmith and brings into battle. Deployed by
  // CombatEngine.deployWarMachines (not the 7 army slots), flagged `noncombatant`
  // so they never keep a side "alive". Ballista shoots, First Aid Tent heals one
  // wounded stack per round, Ammo Cart gives that side's shooters unlimited shots.
  FIRST_AID_HEAL: 60,       // HP a First Aid Tent restores to one stack each round
  WAR_MACHINES: {
    ballista: { cost: { gold: 2500 } },
    firstAidTent: { cost: { gold: 750 } },
    ammoCart: { cost: { gold: 1000 } },
  },
  // ---- Real sieges -----------------------------------------------------
  // A Fort/Citadel/Castle raises a destructible curtain wall on the defender's
  // side of the battlefield. Walls block walkers (flyers sail over); the gate is
  // the central passage; a moat in front bites any stack that ends its move in
  // it; the besieging hero always brings a Catapult that batters the wall down.
  // The old flat +2/+3/+4 defense bonus (Fort/Citadel/Castle) still applies on
  // top — the walls are additive tactical texture, not a rebalance.
  SIEGE: {
    WALL_X: 12,          // battlefield column the curtain wall stands on
    MOAT_X: 11,          // the moat band just in front of the wall
    GATE_ROW: 5,         // the central wall segment is the gate (breaches faster)
    wallHp: 300,         // HP of a curtain-wall segment (Fort / Citadel)
    wallHpCastle: 450,   // Castle walls are tougher
    gateHp: 200,         // the gate is weaker than the wall
    catapultDamage: [130, 190], // per Catapult shot vs a wall/gate segment
    moatDamage: 90,      // HP a stack loses when it ends its move in the moat
    moatFromTier: 2,     // Citadel (2) and Castle (3) dig a moat; a bare Fort does not
    // Arrow towers: destructible auto-shooters just behind the wall. A Citadel
    // raises the central keep; a Castle adds an upper and a lower tower.
    towerCol: 13,
    towerRows: { 1: [], 2: [5], 3: [1, 5, 9] }, // by fort tier
  },
  SURRENDER_COST_MULT: 0.5, // surrender price = this × gold value of the army you keep
  // ---- Adventure spells, laddered by magic-school mastery ----------------
  // Every `*_BY_SCHOOL` array is indexed [none, Basic, Advanced, Expert] in the
  // spell's OWN school, and index 1 equals index 0 because casting without the
  // skill is the Basic effect (HoMM3). The plain scalar of the same name is
  // DERIVED from index 0 below — never written twice — so an unskilled hero
  // reads exactly the numbers this file has always held. Resolved for a given
  // hero by magic.adventureParam; nothing reads a ladder directly.
  DIM_DOOR_RANGE_BY_SCHOOL: [8, 8, 12, 16],       // max Chebyshev jump distance (tiles)
  DIM_DOOR_MP_BY_SCHOOL: [400, 400, 300, 200],    // movement points spent per jump
  DIM_DOOR_USES_BY_SCHOOL: [2, 2, 3, 4],          // casts allowed per hero per day
  TOWN_PORTAL_MP_BY_SCHOOL: [200, 200, 100, 0],   // movement spent per cast (Expert Earth: free)
  VISIONS_RANGE_BY_SCHOOL: [10, 10, 15, 22],      // fog-reveal radius around the hero (tiles)
  SCUTTLE_RANGE_BY_SCHOOL: [6, 6, 9, 12],         // max Chebyshev distance to the target boat
  SUMMON_BOAT_RANGE_BY_SCHOOL: [4, 4, 6, 8],      // how far the summoned hull may be sought
  // Disguise: how far an enemy AI OVER-estimates a cloaked hero's army. At 1 it
  // assumes its own best hero's strength (the pre-existing behaviour); mastery
  // inflates the bluff, so an Expert Air cloak actually deters rather than
  // merely withholding. See AIPlayer.enemyHeroValue.
  DISGUISE_BLUFF_BY_SCHOOL: [1, 1, 1.25, 1.5],
  MORALE_CHANCE_PER_POINT: 1 / 24, // P(extra turn) per morale point
  LUCK_CHANCE_PER_POINT: 1 / 24,   // P(double damage) per luck point
  MORALE_LUCK_MAX: 3,
  // Buff/debuff duration = spell.duration + min(CAP, floor(Power / DIV)) rounds.
  // Power extends effects modestly but is bounded, so a high-Power hero can't
  // Blind/Slow a key stack for the entire battle.
  SPELL_DURATION_POWER_DIV: 3,
  SPELL_DURATION_POWER_CAP: 3,
  // Magic-school mastery (see src/core/magic.js + docs/MAGIC_SCHOOLS.md).
  // A hero skilled in a spell's OWN school pays less mana for it: the fraction
  // taken off at Basic / Advanced / Expert. Rounded, floored at 1 — a spell is
  // never free. Deliberately modest: mastery's real payoff is the mass cast
  // below, and a discount steep enough to matter on its own would let a hero
  // chain-cast its best spell every round of a long battle.
  SPELL_SCHOOL_DISCOUNT: [0.10, 0.15, 0.20],
  // The school level at which a spell flagged `mass` in the catalog stops being
  // single-target and covers every stack on the relevant side (HoMM3: Expert).
  SPELL_MASS_MASTERY: 3,

  // ---- Visitable landmarks ----------------------------------------------
  // Wayfarer's Camp ('move' booster): extra movement points granted for the
  // current day. Reusable, but at most once per hero per day (tracked in
  // hero.boostDays — see actions.applyBooster).
  MOVE_BOOST: 1500,
  STABLES_MOVE_BONUS: 400,  // weekly extra movement a town's Stables grants
  // ---- Experience denominated in the CREATURE-VALUE currency ------------
  // Combat XP moved from hit points to creature value in 2026-08 (see
  // docs/GAME_RULES.md), which multiplied every battle's award by the roster's
  // value-to-HP ratio — mean x17.8, x16.3 on a representative seven-stack army.
  // Every FLAT reward below is quoted in the new currency: its pre-change number
  // times 18. They are baked rather than computed so this file still states what
  // a player actually receives, and so they can be retuned independently.
  LEARNING_STONE_XP: 18000, // XP from the Learning Stone ('xp' booster)  [was 1000]
  // Obelisk ('obelisk' booster): fog-reveal radius around the visiting hero
  // and the one-time experience award (once per hero, via hero.visited).
  OBELISK_REVEAL: 10,
  OBELISK_XP: 9000,        // [was 500]

  // Nemesis heroes: an enemy hero that defeats one of yours is branded your
  // nemesis. It fights YOUR heroes with an escalating attack+defense edge
  // (EDGE_PER_KILL each, capped at EDGE_CAP), and carries a bounty — bonus XP
  // (BOUNTY_XP × kills) plus a guaranteed artifact — for whoever finally takes
  // it down. See actions.brandNemesis / nemesisBounty and CombatEngine's edge.
  NEMESIS: {
    EDGE_PER_KILL: 1,
    EDGE_CAP: 3,
    BOUNTY_XP: 13500,     // [was 750]
  },

  // AI Warlord personalities: each AI player is dealt a named temperament at
  // game start (deterministic per seed, no map-gen rng consumed). A warlord is
  // a pure TUNING profile layered over the goal-scoring seam — three multipliers
  // that scale how much the AI covets conquest, economy, and exploration, so
  // different opponents feel distinct. It deliberately does NOT touch the
  // safety gate: `aggression` raises a target's DESIRABILITY, never the
  // army-superiority margin an AI demands before it will attack, so the
  // "only fights from strength" invariant is preserved for every profile.
  // See GameState.newGame (assignment) and AIPlayer (application).
  WARLORDS: {
    warmonger:     { title: 'the Conqueror', aggression: 1.45, economy: 0.85, exploration: 0.90 },
    industrialist: { title: 'the Steward',   aggression: 0.85, economy: 1.35, exploration: 0.95 },
    wayfarer:      { title: 'the Wayfarer',   aggression: 0.95, economy: 1.05, exploration: 1.45 },
    tactician:     { title: 'the Tactician',  aggression: 1.00, economy: 1.00, exploration: 1.00 },
    // A people from outside the world. Not a temperament dealt from the seed like the
    // four above — every invader realm gets this one, because a horde that came to
    // take the world is not also weighing whether to develop a sawmill. Measured
    // before it existed: over fourteen days, 958 of 969 goals the Horde's eight
    // commanders chose were map loot, with two million in armies standing idle in
    // front of a hegemon's towns. An invader that farms is not an invasion.
    horde:         { title: 'the Scourge',    aggression: 2.20, economy: 0.35, exploration: 0.70 },
  },
  // The temperaments that may be DEALT to a local realm, in order. Kept as an
  // explicit list rather than Object.keys(WARLORDS) because warlordFor hashes
  // (seed, index) into that list: adding `horde` to the table silently reshuffled
  // every existing seed's opponents and broke two AI tests, which is exactly the
  // determinism warlordFor's own comment promises. A profile that is assigned
  // rather than dealt — an invader's — belongs in the table and NOT in this list.
  WARLORD_POOL: ['warmonger', 'industrialist', 'wayfarer', 'tactician'],

  // Treasure Chest: the penalty applied when the hero takes experience instead of
  // gold (xp = gold - penalty).
  CHEST_XP_PENALTY: 500,
  // A chest offers gold OR experience, so its XP has to be quoted in the same
  // currency battles pay in or the choice is dead — before this every player
  // simply took the gold. Gold-denominated rewards (the chest, a Seer Hut's
  // experience prize) convert at this rate; it is the same 18 the flat rewards
  // above were scaled by, named once because two call sites share it.
  XP_PER_GOLD: 18,

  // Chest gold, as a WEIGHTED tier table rather than a flat pick.
  //
  // It used to be rng.pick([1000, 1500, 2000]): a 2x spread with no tail, so every
  // chest on the map paid about the same and none was ever memorable. Reported as
  // "need higher amplitudes, so sometime we get 15k 20k others 4k-5k".
  //
  // A long tail is the point: most finds are pocket change, a few are a good day,
  // and rarely one is a hoard you reorganise a turn around. Weights are relative.
  // Mean works out ~1900 against the old flat 1500, so chest income rises about a
  // quarter while the FELT range goes from 2x to 40x. Tune the weights, not the
  // engine, if that drifts.
  CHEST_GOLD_TIERS: [
    { weight: 74, min: 500, max: 1200 },     // the everyday find
    { weight: 22, min: 2000, max: 3500 },    // a good day
    { weight: 4, min: 12000, max: 20000 },   // a hoard — rare, and remembered
  ],

  // ---- Colored keys (Keymaster Tents gate Border Guards) ---------------
  // Visiting a Keymaster Tent grants the whole PLAYER a permanent colored key;
  // a matching Border Guard blocks passage until that player holds the key. id is
  // the internal color, name is shown to the player, tint drives the map art.
  KEY_COLORS: [
    { id: 'red', name: 'Red', tint: 0xcc3b3b },
    { id: 'blue', name: 'Blue', tint: 0x3b6ecc },
    { id: 'green', name: 'Green', tint: 0x3faa55 },
    { id: 'purple', name: 'Purple', tint: 0xa14fd0 },
  ],

  // ---- Heroes ----------------------------------------------------------
  ARMY_SLOTS: 7,
  MAX_SECONDARY_SKILLS: 8,   // a hero can hold at most this many secondary skills (the Witch Hut caps here too)
  HERO_COST: 2500,          // tavern recruitment price
  // Re-hiring a retired (fled/surrendered/defeated) veteran from your pool costs
  // the base price plus a small premium per experience level — a discount vs the
  // hero's real worth, but not free.
  HERO_REHIRE_LEVEL_PREMIUM: 250,
  MANA_PER_KNOWLEDGE: 10,
  BASE_MANA_REGEN: 1,       // mana per day, +Mysticism +artifacts

  // XP needed to go from level N to N+1 (cumulative table built at runtime).
  // The 1.2x curve makes the upper levels reachable only in very long games,
  // so a high cap lets heroes keep growing without inflating normal-length play.
  XP_BASE: 1000,
  XP_GROWTH: 1.2,
  HERO_MAX_LEVEL: 74,

  // ---- Altar of Transmutation --------------------------------------------
  // Convert an army stack into another creature the town can build. Output is
  // valued by aiValue: outCount = floor(inValue × TRANSMUTE_EFFICIENCY /
  // aiValue(target)). Efficiency < 1 is the transmutation "tax" — you can never
  // gain total power, so it reshapes an army's COMPOSITION rather than minting
  // it. A gold fee (scaled by the output's power) is charged on top.
  // The Altar converts ONLY into the town's TIER-2 creature (Castle -> Archers,
  // Inferno -> Gogs, ...). Deliberately narrow: a converter that could output any
  // built dwelling's creature let a peasant horde become Archangels and flattened
  // the recruitment economy. See core/transmute.transmuteTargets.
  // A battle won without losing a single creature pays this premium on the normal
  // experience — the reward is for winning CHEAPLY, not merely winning. Applied in
  // CombatEngine.battleResult so every path (live, quick-resolve, AI) agrees.
  // Lizard Ghosts (opt-in, `lizardGhosts` feature): when a lizard stack is wiped
  // out it MAY leave a shade behind — a chance event, so a Fortress fight can turn
  // on whether the marsh gives its dead back. One roll per stack per battle, drawn
  // off the seeded battle rng (so a replay is identical, and Classic draws nothing).
  // The shade never leaves a shade of its own — no chains.
  GHOST_REMNANT_CHANCE: 0.25,     // how often a wiped lizard stack rises as a shade
  GHOST_REMNANT_FRACTION: 0.25,   // shades = this x the fallen stack's STARTING count
  GHOST_REMNANT_CREATURE: 'lizardGhost',
  FLAWLESS_XP_BONUS: 0.10,
  // What a DEFEAT teaches, as a share of the value the beaten hero destroyed before
  // it fell (CombatEngine.battleResult -> defeatXp, paid in actions.learnFromDefeat).
  // Losing a hero already costs its army and its artifacts; before this it also
  // erased the entire fight from the hero's own history, so the game's hardest
  // battles were the only ones that taught nothing at all.
  //
  // Denominated in what you DESTROYED, not what you faced, so it is self-limiting:
  // a hero crushed 100-0 learns nothing, a hero that nearly won learns a great deal.
  // At 0.5 it cannot pay better than winning the same battle would (a victory pays
  // the enemy's whole army, since they were annihilated), so there is never a reason
  // to throw a fight — while a narrow defeat against a giant still outweighs an easy
  // win over a weakling, which is the real content of "a defeat teaches more".
  DEFEAT_XP_SHARE: 0.5,

  // ---- Ronins: masterless captains in the open country (opt-in `ronins`) ----
  // A wandering wild stack may acquire a commander and start walking toward the
  // fighting, joining whichever side was ATTACKED. See core/ronins.js.
  RONIN_SHARE: 0.06,          // captains as a share of the map's wandering stacks
  RONIN_MAX: 6,               // …and never more than this, however big the map
  RONIN_MIN_STACK_VALUE: 800, // a band too small to matter gets no captain
  // How near a ronin has to be to a fight to join it. Three tiles is close enough
  // to read as "it was standing right there" and far enough that a player can see
  // one coming and decide whether to start the fight at all — which is the whole
  // tactical content of the feature.
  RONIN_HELP_RADIUS: 3,
  // Tiles a captain covers in a day. A led band MARCHES — an ordinary wild stack
  // sits on its tile forever, and one that drifts a single tile a dawn toward a
  // hero that rides ten is a public defender who never arrives. Measured over 90
  // days on seed 4242: at one tile a day the whole corps managed ONE intervention;
  // the feature existed and no player would ever have seen it.
  RONIN_SPEED: 4,
  // What a tavern charges for a captain's service, per level of the experience it
  // earned in the field. Steeper than HERO_REHIRE_LEVEL_PREMIUM (a returning
  // veteran of your own): that hero's experience was bought with your armies,
  // while a ronin's was earned at nobody's expense and arrives with its retinue
  // already mustered. You are buying a finished thing, and it is priced like one.
  RONIN_HIRE_LEVEL_PREMIUM: 900,

  // How many days a View Earth sighting is worth anything (core/actions.viewEarth).
  // A snapshot, not a subscription: armies move and the marks do not, so the view
  // fades as it ages and lapses entirely at the end. A week is long enough to plan
  // a march on and short enough that the answer has to be bought again.
  VIEW_EARTH_DAYS: 7,
  TRANSMUTE_TARGET_TIER: 2,
  TRANSMUTE_EFFICIENCY: 0.8,      // fraction of the input's power score kept
  TRANSMUTE_GOLD_PER_VALUE: 0.5,  // gold fee = ceil(output aiValue × this)
  // AND THE AI DOES NOT USE THIS, which was built three ways and measured three
  // times rather than assumed. Asked for as "transmute the unwanted creatures to
  // the level 2 stack, preferably shooters", and the AI genuinely could not — the
  // Altar was not in its build order at all. Adding both, over paired 90-day
  // games, the realm did not get stronger:
  //
  //   Altar early, melt everything under the target tier   median +1.8%,  7/12
  //   Altar at the tail, same rule                         median -4.7%,  3/8
  //   Altar at the tail, melt only a rump (<=5% of army)   median -5.3%,  4/12
  //
  // The one positive reading is confounded: it needed the Altar built EARLY,
  // which takes a day and 4,000 gold from the Castle and the Capitol — the best
  // return in the catalog — and moving it off that slot flipped the sign. Which
  // is the tell: transmuting keeps only TRANSMUTE_EFFICIENCY of what goes in, so
  // a rival melting its own troops is paying a 20% tax for tidier slots, and the
  // slots are not worth 20%. The human's Altar is untouched — the arithmetic
  // there is the player's to judge, and a player can pick the moment. Raise
  // TRANSMUTE_EFFICIENCY, or find a use for the freed slots worth more than the
  // haircut, before trying this again.

  // ---- Balance of Power (#9, opt-in via features.balanceOfPower) -----------
  // When a single TEAM holds this share of the world's fielded MILITARY (heroes
  // + garrisons, not treasury), rival AIs covet that hegemon's holdings and ease
  // off each other — a coalition against the runaway. Desirability only; the AI's
  // army-superiority gate is untouched, so it never forces an unwinnable attack.
  BOP_HEGEMON_THRESHOLD: 0.45, // leading team's military share that triggers it
  BOP_LEADER_BIAS: 1.6,        // × desirability of the leader's towns/heroes
  BOP_TRUCE_DAMP: 0.5,         // × desirability of OTHER (non-leader) rivals

  // ---- Battle stances (engine mechanic; the AI chooses one, the player always
  // fights at classic 'press' — there is no pre-battle probability screen) -----
  // Three EV-neutral pre-battle stances the human picks; all share the same mean
  // damage, differing only in VARIANCE. 'hold' = fixed mean (zero variance, and
  // no luck/morale swings); 'press' = the classic uniform roll; 'allin' = bimodal
  // min-or-max plus amplified luck/morale. Teaches gambler's-ruin risk (seek
  // variance when behind, suppress it when ahead). Only the human side ever
  // leaves 'press', so Classic auto-resolve is byte-identical.
  BF_ALLIN_SWING: 1.5, // All-or-Nothing multiplies the luck & morale event chances

  // ---- AI Battle Formations (Settings → aiBattleFormations, live-read) ------
  // The AI picks its OWN pre-battle stance from the odds — the same lesson the
  // human picker teaches: variance helps the underdog, suppress it when ahead.
  // Measured (600-battle MC, 10-v-13 pikemen): all-in nearly doubles the
  // underdog's win rate vs press (1.8% → 3.2%); hold turns a 13-v-10 favorite's
  // 98.2% into 100.0%. Odds come from one Monte-Carlo with both sides at press
  // (fixed seeds — no live rng drawn), or a value-ratio shortcut for routs.
  AI_STANCE_UNDERDOG: 0.38, // win prob at or below this → 'allin' (seek variance)
  AI_STANCE_FAVORITE: 0.62, // win prob at or above this → 'hold' (kill variance)
  AI_STANCE_SAMPLES: 24,    // Monte-Carlo samples behind the odds estimate
  AI_STANCE_SKIP_RATIO: 4,  // army-value ratio beyond which the MC is skipped (a rout)

  // ---- Cohesion & the Breaking Point (#11, opt-in via features.cohesionRout) --
  // A stack that has lost this fraction of its round-start number rolls a morale
  // break check, at most once per round: P = clamp(BASE - PER_MORALE·morale, MIN,
  // MAX). A first failure makes it WAVER (cower, forfeit its next turn); a second
  // ROUTS it (survivors flee the field). Undead + war machines are fearless. The
  // cap sits well below certainty so one roll never auto-wipes a horde — a hard
  // blow can shatter a formation, but only after it is already badly bloodied.
  ROUT_LOSS_FRACTION: 0.5, // must have lost >= half its round-start number
  ROUT_BASE: 0.5,
  ROUT_PER_MORALE: 0.08,   // each +morale point steadies the stack
  ROUT_MIN: 0.02,
  ROUT_MAX: 0.6,           // hard ceiling on break chance

  // ---- Cunning AI (#12, opt-in via features.cunningAI) ---------------------
  // A human-facing combat AI occasionally deviates from its single best choice,
  // softmax-sampling among its NEAR-best options (off the seeded battle rng, so
  // still reload-scum-proof). Covers both stack MOVES and the hero's SPELLBOOK —
  // you can no longer memorise one exploit, or pre-counter the one spell it was
  // always going to cast, and auto-win. Scoped to enemy sides facing the human —
  // AI-vs-AI and neutral clearing keep strict argmax, so AI economy is unaffected.
  CUNNING_EPSILON: 0.3,  // chance of deviating from the argmax on a given choice
  CUNNING_NEAR: 0.85,    // only options scoring >= this fraction of the best are candidates
  CUNNING_TEMP: 0.15,    // softmax temperature as a fraction of the best score (smaller = peakier)

  // ---- Sunk-Cost Siege (#14, opt-in via features.sunkCostSiege) ------------
  // A town remembers the army value the AI has thrown away in FAILED assaults on
  // it (per attacker, decaying). While that memory lasts the AI lowers the
  // superiority margin it demands to attack THAT town — escalation of commitment,
  // distinct from the rational week-by-week courage decay. Bounded: the memory
  // caps and decays, the margin cut is capped, and it never drops below the
  // courage floor, so a cheap walled garrison can bait an over-committing AI
  // without the AI ever suiciding outright.
  SUNK_COST_CAP: 20000,       // max remembered loss value at a town
  SUNK_COST_DECAY_DAYS: 14,   // the memory fades linearly to zero over two weeks
  SUNK_COST_SLOPE: 0.3,       // margin cut per unit of (remembered loss / own army value)
  SUNK_COST_MAX_REDUCTION: 0.3, // hard cap on how far the margin can be cut
  SUNK_COST_FLOOR: 1.05,      // never demand less than this ratio (matches courage floor)

  // ---- Hall of Reflection (#15, opt-in via features.hallOfReflection) -------
  // A visiting hero forgets one secondary skill for a level-scaled gold fee
  // (cheap early, dear late), freeing the slot for a future level-up pick. Stats,
  // XP and artifacts are untouched. Teaches that lock-in is expensive, not infinite.
  REFLECTION_DROP_COST: 1000, // gold per hero level to forget one skill

  // ---- Diplomacy (#16, opt-in via features.diplomacy) ----------------------
  // A weak-enough neutral stack may be persuaded to JOIN for gold instead of
  // fought — a Coasean side-payment that averts a deadweight battle. The price is
  // anchored to the army value the hero would LOSE fighting (× PARLEY_PRICE_MULT,
  // so it can exceed the cost of just fighting); the stronger the stack relative
  // to the hero, the likelier it flatly REFUSES — so the fork is real, not a
  // mandatory click. The refusal roll is seeded per-encounter (no reload-scum).
  PARLEY_MAX_RATIO: 0.6,    // a stack above this fraction of your army won't bargain
  PARLEY_PRICE_MULT: 1.5,   // join price = predicted combat loss × this …
  // … but NEVER less than this share of what the stack would cost to RECRUIT.
  // Pricing off the avoided fight alone was exploitable to the point of breaking
  // the game: a developed hero loses nothing beating a wild stack, so the
  // predicted loss is 0 and the price floored at 1 gold. Measured against a
  // 139,872-value hero — 8,900 gold of swordsmen for ONE gold, 0.01% of value,
  // and the same for every stack on the map. You are buying an army, not merely
  // averting a battle, so the goods set the floor. Below 1.0 keeps a real
  // discount for avoiding the fight and the wait, which is the Coasean point.
  PARLEY_COST_SHARE: 0.8,
  PARLEY_REFUSE_BASE: 0.4,  // refusal chance = this + (stack/hero ratio) × slope …
  PARLEY_REFUSE_SLOPE: 0.6, // …
  PARLEY_REFUSE_MAX: 0.85,  // … capped here, then cut by the hero's Diplomacy.
  // The BASE is the half of that formula the skill exists for. Without it the
  // refusal chance was the ratio term alone, and a developed hero's ratio is
  // ~0 against every wild stack — so it never fired. Measured over six 44x36
  // maps, 172 stacks each: a grown hero was offered a deal by 100% of them and
  // 97.1% said yes; an overwhelming hero, 100% and 100%. That is not a Coasean
  // fork, it is a shop with the whole map on the shelves. A flat reluctance
  // makes the deal something a hero without the training mostly does NOT get,
  // and makes Diplomacy the thing that buys it back.
  //
  // ---- Diplomacy, the SKILL (data/skills.js: 0.25 / 0.5 / 0.75) ------------
  // Its magnitude `dip` enters in four places, so training it is felt at every
  // step of the bargain rather than as one number moving:
  //   band    — maxRatio = PARLEY_MAX_RATIO × (1 + dip × PARLEY_BAND_BONUS)
  //   refusal — × (1 - dip)
  //   price   — × (1 - dip × (BARGAIN_BASE + BARGAIN_MOOD × mood))
  //   free    — kin under PARLEY_FREE_RATIO × dip of your host join for nothing
  PARLEY_BAND_BONUS: 1.0,   // an Expert diplomat bargains with stacks ~1.05× their army
  // "In HoMM3 some were at a bargain and some were free." The bargain is the
  // mood: a per-encounter seeded disposition (0..1), so two identical stacks on
  // one map ask different prices and neither can be reload-scummed. BASE is the
  // discount a trained hero always gets, MOOD the part the band's temper adds.
  // An Expert (0.75) pays between 0.775× and 0.25× of the normal price; an
  // untrained hero pays full, mood or not — they have nothing to bargain with.
  PARLEY_BARGAIN_BASE: 0.3,
  PARLEY_BARGAIN_MOOD: 0.7,
  // FREE, and the reason it does not reopen the one-gold hole: kin only. A band
  // joins for nothing when the hero ALREADY fields that creature and the band is
  // under this fraction (× dip) of the hero's army — 1.5% at Basic, 4.5% at
  // Expert. You cannot hoover a map with it: it pays out only in the creatures
  // you already carry, only while they are a rounding error next to your host,
  // and only through seven slots. Everything else is bought.
  PARLEY_FREE_RATIO: 0.06,
  // Diplomacy also cuts what YOUR OWN surrender costs (HoMM3's other half of the
  // skill): a hero who can talk buys their army's way off the field cheaper.
  SURRENDER_DIPLOMACY_CUT: 0.6, // surrender price × (1 - dip × this) → 0.55× at Expert

  // ---- Flee and chase ------------------------------------------------------
  // The other way an encounter ends without a battle, and the mirror of a
  // parley: a band far weaker than the hero BREAKS AND RUNS on contact. Reported
  // as "a weak stack may flee, and a user may decide to chase if they need the
  // experience, or to let them go and save time" — so the flee is not the end of
  // it, it is a fork the player resolves.
  //
  //   LET THEM GO — no battle at all. The road opens and nothing else changes:
  //     no experience, no spoils, no necromancy raise, and no prize (see below).
  //     You bought the ground with the experience you walked away from.
  //   CHASE — you run them down and fight the FULL, tide-sized battle you came
  //     for, at the cost of CHASE_MOVE_COST of the day's movement. Running a band
  //     to ground takes the afternoon; that is what "save time" means on an
  //     adventure map, and it is what stops the chase from being a free yes.
  //
  // WHO NEVER RUNS. A guard posted on a prize holds its post — that one is
  // load-bearing, since letting a band go clears its tile and a fleeing guard
  // would hand over its mine or artifact for nothing. Ronin-led bands (a captain
  // holds them) and invading war-bands (on an errand, not squatting) are out too.
  // The roll is seeded per encounter like the parley refusal, so a reload cannot
  // turn a flight into a fight.
  //
  // WEIGHED ON THE STACK AS IT STANDS, not on what the tide sizer would mass it
  // into — see diplomacy.fleeCheck for the measurement that forced that (weighing
  // the massed army gave 0 flights in 114 encounters, i.e. a dead feature). At
  // these numbers, measured over four maps: a starting column frightens nobody
  // (0%), a grown army sees 15% of encounters break and run, an overwhelming one
  // 18%. Exempting guards is what took that down from 26-36% — the difference is
  // exactly the map's guarded prizes.
  FLEE_MAX_RATIO: 0.12,   // a band above this fraction of your army stands and fights
  FLEE_CHANCE_MAX: 0.7,   // chance at ratio 0, falling linearly to 0 at FLEE_MAX_RATIO
  CHASE_MOVE_COST: 0.15,  // the chase costs this fraction of the hero's DAILY movement

  // ---- Town Bank (#17, opt-in via features.townBank) -----------------------
  // Borrow gold to rush a big-ticket building weeks early. The loan is SECURED
  // against the very building it buys: you repay principal+interest in weekly
  // installments, and if you can't make a payment the bank REPOSSESSES that
  // building. So a failed leverage bet unwinds the thing it bought — a stalled
  // rush loses the snowball instead of compounding it. Teaches leverage + default.
  BANK_INTEREST: 0.5,       // owed = principal × (1 + this)
  // Eight, not four, and the difference is measured in repossessions. A 10,000
  // Capitol owes 15,000; over four weeks that is 3,750 a week out of a realm
  // that is also recruiting, and an AI borrowing toward its Capitol defaulted
  // once in 24 runs — the bank taking back the Capitol it had just financed,
  // which leaves the realm worse off than if it had never borrowed. Over eight
  // weeks the same policy defaulted zero times in 24, and a deliberately
  // reckless borrow-for-everything policy went from four repossessions to none.
  // The total owed is unchanged; only the installment shrinks. Default is still
  // reachable — a realm that borrows and then loses its income will still lose
  // the collateral, which is the lesson the mechanic exists to teach.
  BANK_WEEKS: 8,            // repaid in equal weekly installments over this many weeks
  BANK_MIN_PRINCIPAL: 4000, // only builds costing at least this much gold are financable

  /**
   * CREATURE-BANK REWARD, AS A SHARE OF THE GARRISON THE MAP PLACED.
   *
   * The bank tables in data/creatureBanks.js name a fixed prize — a Dwarven Treasury
   * guarded by 14 dwarves pays 4 of them back, a sensible 29%. The guard is not fixed
   * though: weekly growth, the crawling peg and site respawn all move a real garrison,
   * and a prize pinned to the table collapses against one that has genuinely grown. So
   * the creature prize is this share of the placed guard, floored at the table value —
   * the floor is what keeps an unscaled bank paying exactly what it always paid.
   *
   * IT IS NOT A SHARE OF THE GARRISON AS FOUGHT, and that is the correction. It was,
   * and the share was then taken from the count tideScaleDefender had inflated for one
   * particular hero — while the difficulty that count bought was capped and measured at
   * 0% attacker cost. Every bank paid back roughly a tenth of the hero's own army in
   * creatures, and the next bank was sized against the bigger hero. Measured over one
   * half-game: 24 bank and lair fights, 38.6M of inflated guard beaten, ~3.9M of free
   * creatures against ~5.3M of total army growth. The tell was that the REPEL path
   * already divided the same inflation out, on the stated grounds that it must not
   * persist — so the number was a fiction when it would make the map harder and a fact
   * when it paid the player.
   *
   * A hard fight still pays a premium, in gold (BANK_COST_GOLD_SHARE), off what the
   * battle actually cost and capped at a multiple of the site's own gold — a currency
   * that cannot size the next fight the way creatures can.
   */
  BANK_REWARD_SHARE: 0.10,
  // The premium a costly bank fight pays, as a share of the army value the battle
  // actually took out of the attacker. Paid in GOLD on purpose: the creature share
  // above is a share of the garrison the MAP placed, so nothing about a bank can feed
  // the loop where a bigger army buys a bigger scaled guard which pays a bigger
  // creature prize which buys a bigger army. Gold is spent on the economy; creatures
  // are spent on the next fight's difficulty.
  BANK_COST_GOLD_SHARE: 0.25,
  // ...and never more than this multiple of the site's own table gold. See
  // grantBankReward: without a ceiling the premium scales with the ATTACKER, because
  // the sizer guarantees the fight costs a fixed share of its army.
  //
  // A HUNDRED, raised from two, and deliberately: the ceiling was the whole
  // complaint. Reported as "a Dwarven Treasury pays $3000 if kept by 100 creatures
  // or 100k creatures — let's allow a prorated reward, this way a hit may bring
  // 300k, and that would solve the AI players' constant lack of money." At two,
  // a treasury paid at most 9,000 however hard the fight; at a hundred the same
  // treasury can pay 303,000, which is the number that was asked for.
  //
  // The ceiling stays a multiple of the SITE's own table gold rather than
  // disappearing, so a Dwarven Treasury and a Dragon Utopia still differ by what
  // they are, and the premium is still bounded by something that is not the
  // attacker. What changed is only how much headroom a genuinely hard fight has
  // inside that bound. Gold remains the right currency for this and creatures
  // remain the wrong one, for the reason BANK_REWARD_SHARE sets out at length:
  // gold is spent on the economy, creatures are spent on the next fight's
  // difficulty, and only the second can size the guard that pays the next prize.
  BANK_PREMIUM_MAX: 100,

  // A bank also takes DEPOSITS: gold you are still holding when the week turns
  // earns interest, so hoarding becomes a strategy rather than dead weight and a
  // second, third, fourth bank is worth building. The first
  // BANK_DEPOSIT_STACK banks pay the full rate each; beyond that the returns
  // diminish, because five towns' worth of banks is already a large commitment.
  BANK_DEPOSIT_RATE: 0.10,       // per bank, on the week-ending gold balance
  BANK_DEPOSIT_STACK: 5,         // how many banks pay the full rate
  BANK_DEPOSIT_EXTRA_RATE: 0.05, // every bank past that
  // Interest is paid on the first this-much gold and no more. Without a ceiling
  // the rate compounds without limit: 5 banks is 50% a week, which doubles a
  // treasury in two weeks and then runs away from every other economy in the
  // game. Capping the PRINCIPAL keeps the incentive to hold a reserve (and to
  // build more banks) while bounding what a hoard can earn. Raise it — or set it
  // to Infinity — for uncapped compounding.
  // 100,000, raised from 30,000. At 30,000 the cap taxed precisely the strategy
  // it should have rewarded: a realm that banks its gold instead of spending it
  // beat a spending one by 54,913 of day-150 army value, winning 14 of 24 seeds
  // — indistinguishable from noise, so hoarding was not a strategy at all.
  //
  // Measured across the sweep (24 seeds, one unmolested realm, day 150), the
  // hoarder's advantage over a spender in army value:
  //     30k  +54,913  (14/24 seeds)      250k  +492,204  (16/16)
  //     100k +251,150 (14/16)           1000k  +505,215  (16/16, +1.8M with gold)
  //     inf  +454,178 (24/24 — and a pure hoarder ends on 5.3M of gold)
  // 100k is the largest cap where hoarding is REAL but not DOMINANT: a genuine
  // ~13% edge that still loses seeds. From 250k up it wins every seed measured.
  //
  // It costs ordinary play nothing. The default spending AI is byte-identical at
  // every cap (day-150 army 1,848,105, interest 48,815 — the cap never binds on
  // it), and a normal competitive game is unchanged at every cap tested:
  // identical median end day 34, identical leader share of world army 0.664,
  // identical interest 3,014, because those games are decided long before
  // anyone is holding six figures at a week boundary.
  // 900,000, raised from 100,000 on request — a reserve worth holding is the
  // point of the building, and at 100,000 a realm that hoards half a million was
  // earning on a fifth of it. The rate ladder above is unchanged, so five banks
  // still pay 50% a week; what moves is how much principal that rate can reach.
  BANK_DEPOSIT_CAP: 900000,
  // AND THE AI DOES NOT HOARD FOR IT, which was tried and measured rather than
  // assumed. A rival already earns interest on what it genuinely cannot spend
  // (16,895–54,602 gold over 90 days across sample seeds, with no change at all),
  // so the question was only whether it should hold MORE. It was built in the
  // cheapest form the mechanic allows — defer recruiting on the LAST DAY OF THE
  // WEEK only, since interest pays on the week-ending balance and dwelling stock
  // accumulates rather than resetting, so nothing is lost but a day. It doubled
  // the interest (23,977 → 44,062 on one seed) and made the realm WEAKER: over
  // twelve paired 90-day games the median realm ended 5.7% smaller and only 4 of
  // 12 came out ahead. The cost lands almost entirely on the GARRISON — 289,107
  // → 124,124 and 225,236 → 129,941 on two seeds, with field armies unmoved —
  // because gold held past the week turn is spent on BUILDINGS first when the new
  // week opens (manageTowns builds before it recruits), so a hoard does not come
  // back as troops. A permanent 100,000 reserve, the literal reading, can only be
  // worse: the same experiment on the parley reserve cost 36% of the army at
  // 5,000 held. Raise BANK_DEPOSIT_RATE or drop building's priority before
  // reaching for this again.


  // ---- The invader bank: peoples from outside the world --------------------
  // A wave is not a monster stack but a REAL realm: a treasury, a colour, named
  // commanders, and beachhead towns on the border to march out of. See
  // data/invaders.js for the bank and core/invaderRealms.js for the machinery.
  INVADER_QUEUE_DEPTH: 4,        // how many nations the forecast shows ahead
  INVADER_GOODS_DIVISOR: 900,    // gold treasury / this = each other resource
  INVADER_BEACHHEAD_BAND: 3,     // how deep from the map edge a camp may be planted
  INVADER_BEACHHEAD_ROOM: 5,     // open neighbours a camp tile needs to be marchable
  // Beachheads per nation. The bank asks for 1-2; the ceiling is here because
  // towns are the economy AND the victory condition — a nation that DEPLOYS five
  // has already won before it fights, so everything past this it has to take.
  // TWO camps per landing, up from one. Asked for as "increase significantly the
  // ratio of invasions with beachhead towns over the rogue bands", and the honest
  // lever for that is camps PER LANDING rather than the two schedules: measured
  // over 500 days, camp-bearing landings already outnumber band waves 24:1 to 59:1
  // once the heavy tier runs at a fortnight, because of the stand-down above. What
  // was not moving was the camps themselves — exactly 1.00 a landing on every board
  // under the big-map threshold.
  //
  // The measurement that set this to one was "eight commanders out of two camps
  // took three towns on the landing day, because the defender can only be in one
  // place and every commander outgunned their best hero". That reading was already
  // retired for the biggest boards one field down, for a reason that applies here
  // too: it was taken under the OLD roster of five-to-eight commanders per wave,
  // and it is three or four now (INVADER_COMMANDERS_*). Two camps is no longer
  // eight armies out of two gates; it is three or four out of two, which is the
  // same wave arriving on a wider front.
  INVADER_BEACHHEAD_MAX: 2,
  // …EXCEPT ON THE BIGGEST BOARDS, where the reasoning above stops applying for two
  // separate reasons. (1) The measurement that set the cap was taken under the OLD
  // roster of five-to-eight commanders per wave; it is three or four now
  // (INVADER_COMMANDERS_*), so two camps no longer means eight armies out of two
  // gates. (2) "One camp is one front" is a statement about the map, not about the
  // camp: a nation's camps land within INVADER_LANDFALL_SPREAD (10 tiles) of each
  // other, which is a quarter of a 44-wide board and a fourteenth of a 144-wide one
  // — on World's Edge two camps ten tiles apart ARE one front, and one camp on a
  // 17,280-tile map is a pinprick. Asked for directly ("allow 2 camps per landing on
  // the biggest maps"), and it is also what makes that map's 42-town charge a game
  // rather than a vigil: half the peoples in the bank ask for two camps, so the
  // biggest boards average ~1.5 camps a landing instead of 1.
  // Raised in step with the ordinary cap, so the biggest boards keep the extra
  // front that made them different rather than being levelled with the rest.
  INVADER_BEACHHEAD_MAX_BIG: 3,
  // The board that earns the second camp: 4.5x the 44x36 reference area (7,128
  // tiles). Of the maps we ship that is Clash of Kingdoms (7,680) and World's Edge
  // (17,280); Age of Empires at 6,336 keeps one, which is the line between "a big
  // map" and "the biggest maps".
  INVADER_BEACHHEAD_BIG_AREA: 7128,
  // ---- The tempo of the peoples --------------------------------------------
  // "Shorten the interval between invasions if the hero keeps 88% of the army or
  // more after the invasion[;] the interval between invasions is not a big problem
  // if the invaders are not annihilating my armies."
  //
  // Which is the same argument the long interval was set on, run backwards: the
  // 55-95 days exist because "a wave that costs ~35% of a standing army needs long
  // enough to be rebuilt before the next, and at ~30 top creatures a week the
  // rebuild is the constraint". A realm that came through nearly intact has nothing
  // to rebuild, so the reason for the wait is gone and the next people need not
  // wait either.
  //
  // Measured at the LOW-WATER MARK of the defence, sampled daily while a people is
  // ashore and judged when its foothold breaks — not at the army you have finished
  // rebuilding by then, which would let a realm that was gutted and spent three
  // weeks recovering claim it was never touched.
  INVADER_TEMPO_KEEP: 0.88,      // keep this share of your standing army through it…
  INVADER_TEMPO_MIN: 25,         // …and the next people is 25-40 days out instead of
  INVADER_TEMPO_MAX: 40,         // 55-95. Never LATER than the standing schedule.
  INVADER_LANDFALL_SPREAD: 10,   // a people arrives from one direction
  // The schedule. First nation at day 60, then every 20-30 days — the asked-for
  // cadence was 10-20, widened because at 10 the population outruns the AI time
  // budget below (~40-75ms per hero per game-day, measured).
  // Day 90, not 60, and the reason is production arithmetic rather than taste.
  // A tier-7 dwelling yields ~2 a week, so fifteen castled towns make ~30 top
  // creatures a week: by day 60 that is a few dozen, against a wave that lands
  // with hundreds. Ninety days is what it takes to have ~200 top creatures and a
  // shooter core standing when the first wave hits — enough to fight it rather
  // than to watch it.
  //
  // 90 -> 70, and ONLY because the wave that lands on day 70 is no longer the wave
  // that argument was measured against. The paragraph above was calibrated when a
  // nation arrived at x6.3-x6.7 of the whole defending realm; after the parity
  // rebalance above (INVADER_WAVE_PER_*, INVADER_LEADER_*) the same instrument
  // reports x3.9, and the FIRST one lands lighter still — x2.3, because small
  // budgets round down against creature granularity (scripts/sim/invasion-weight.mjs
  // reports delivery as its own column). A gentler first nation can afford to come
  // sooner.
  //
  // Why it should: days 57-90 were the only invasion most games ever saw, and they
  // are band-only — the single-creature raids reported as "very easy to kill or
  // buy". The beachhead nation is what an invasion is supposed to MEAN in this game,
  // and it was scheduled past the end of most sessions. This is the same finding as
  // review defect #9, from the other end.
  INVADER_REALM_FIRST_DAY: 70,
  // Days between peoples. Widened from 20-30 after a chronicle showed a 100-day
  // treasury and four armies spent in three days of war and the next people due in
  // 17 — "so I can recoup and regroup and plan, which is 90% of the whole game for
  // me". A wide band also means the pause itself is a thing to read: a short one is
  // a scramble, a long one is a chance to rebuild deliberately.
  // Raised to 55-95 for the same reason as the first day: a wave that costs ~35%
  // of a standing army needs long enough to be rebuilt before the next, and at
  // ~30 top creatures a week the rebuild is the constraint, not the treasury.
  // 55-95 -> 14-21, asked for in those words alongside the battle count: "then
  // resume the present schedule, 14 or 21 days." The rebuild argument above is not
  // discarded, it is REDIRECTED — the surge ladder below is what now decides
  // whether a realm needed the season, and it decides it from the realm's own
  // losses rather than from a constant. A realm that is being hurt still gets its
  // gap, because the ladder only ever shortens the wait for one that is not.
  INVADER_REALM_PERIOD_MIN: 14,
  INVADER_REALM_PERIOD_MAX: 21,
  // ---- The surge ladder: an invasion that costs nothing comes straight back ---
  //
  // Reported: "if an invasion did not decrease my realm army but increased it or
  // kept it the same, do another invasion in 1 day at 2x the size; then if still
  // decreased under 2%, another at 2x the size of the last, till the realm army
  // takes an actual hit of 15% or more, then resume the present schedule."
  //
  // This is a SEARCH, and that is why it is better than a bigger constant. Nobody
  // knows what a given realm on a given map at a given day can absorb — the whole
  // history of these numbers is a sequence of guesses re-measured against
  // chronicles. A doubling ladder finds it in log2 steps and then stops, so the
  // wave that lands is the one sized to the defence in front of it rather than to
  // an average of every defence that has ever been measured.
  //
  // INVADER_TEMPO_KEEP (0.88) is the older, gentler form of the same idea and is
  // kept: it pulls the NEXT landing nearer without resizing it. The ladder is the
  // sharp end — it fires only when a wave was very nearly free (a hit under
  // 1 - SURGE_KEEP), and it stands down the moment one lands properly.
  INVADER_SURGE_KEEP: 0.98,      // a wave that left 98%+ of the realm army standing…
  INVADER_SURGE_HURT: 0.15,      // …comes back until one costs at least this share
  INVADER_SURGE_MULT: 2,         // each rung is twice the last
  INVADER_SURGE_DELAY: 1,        // and lands the day after
  // A CEILING, because a doubling ladder with no top is an unbounded number in a
  // save file. Five rungs is 32x, which is past anything the placement limits can
  // put on a map (INVASION_MAX_BANDS_PER_WAVE x INVASION_MAX_BAND), so the ladder
  // saturates against the map before it saturates against this — the cap is here
  // to bound the arithmetic, not to bound the design.
  INVADER_SURGE_MAX: 32,
  // Concurrency. Three great powers carving at the world at once is the fantasy;
  // a fourth is a slideshow. At the cap a SPENT realm is displaced and a healthy
  // one makes the next people wait — waves displacing waves.
  INVADER_MAX_REALMS: 3,
  // Armies per wave. Asked for 10-20; this is the AI-time ceiling, and the
  // aggregate is still several times anything one realm can field, which is where
  // the horror is meant to live.
  // THREE or four, down from five-to-eight. With the wave sized per commander
  // (below), the count is what the defender's day actually costs: eight armies
  // each stronger than your best hero cannot be fought at all, only survived.
  // Three can be met one at a time by a defender who picks their ground.
  INVADER_COMMANDERS_MIN: 3,
  INVADER_COMMANDERS_MAX: 4,
  // Each army, as a share of the average kingdom army — ROLLED PER COMMANDER, so a
  // wave has weak flanks and a terrible centre instead of N copies of one number.
  // The WHOLE WAVE, as a multiple of the greatest single army in the world
  // (wavePowerBase), shared out unevenly across its commanders.
  //
  // Sized as an aggregate rather than per commander because the chronicle caught the
  // per-commander form swinging with hero count: the same band against the same player
  // gave 5-8x of their army with four heroes and 17.8x with one, since the base was a mean
  // over their own commanders. The strongest single army cannot be moved by how many
  // heroes you keep, and dividing the total still lands each commander at the 200-600% of
  // an average hero that was asked for.
  //
  // Calibrated against the report that one hero at 20/20/18/14 killed five commanders for
  // the loss of twenty marksmen out of eight hundred: 6-10x is a war that must be fought
  // from walls and won by breaking camps, where 2-6x PER commander reached 35x and had no
  // defensive answer at all.
  // PER COMMANDER, as a multiple of the strongest single army in the world — and
  // the aggregate is simply whatever that sums to (3-8x across three or four).
  //
  // This reverses the aggregate sizing above, and the reason the aggregate form
  // existed no longer applies. It was adopted because a per-commander roll swung
  // with the defender's hero count — 5-8x with four heroes, 17.8x with one —
  // but that was when the base was a MEAN over the defender's own commanders. The
  // base is now the strongest single army, which no hero count can move, and the
  // commander count is a tight 3-4 rather than 5-8, so the total no longer swings
  // with anything the defender is not choosing.
  //
  // What the aggregate form cost, measured in play: an 11.7x wave over eight
  // commanders is ~1.5x the defender's best hero EACH, and the unevenness roll
  // pushed the worst to 1.75x. Every commander individually outgunned the best
  // hero in the world, so the two the defender could catch cost 3% and 60% and
  // the other six walked into towns at no loss at all.
  //
  // 1.0-2.0 was the fix for that and it did not go far enough, which
  // scripts/sim/invasion-weight.mjs was written to show rather than argue: it
  // delivered a median 1.41x and a p90 of 1.91x of the world's BEST army, PER
  // commander, four commanders at a time — an aggregate of x6.3 to x6.7 of the
  // whole defending realm's standing military. Reported as "fighting someone with
  // 1.5x stats is like fighting a concrete wall, especially if their army is 1.5x
  // or 2x superior too", and the numbers say exactly that.
  //
  // 0.7-1.1 makes each commander a PEER: a fight you can win with the hero you
  // have, which is the only kind of fight that is worth having. The invasion's
  // weight comes from there being three or four of them and from the beachhead
  // that keeps feeding them (reinforceInvaders), not from any one being unbeatable.
  // A nation is still a war — the same instrument reports the aggregate — it is
  // just a war made of battles rather than of walls.
  INVADER_WAVE_PER_MIN: 0.7,
  INVADER_WAVE_PER_MAX: 1.1,
  // And each leader's stats, as a share of the average hero's. The lead commander
  // draws from the top half of the band; the captains draw the whole of it.
  // A commander's stats and level, as a multiple of the BEST commander in the world
  // (bestHero) — "on par with my heroes as stats, so not to be penalized for being
  // behind". Centred on parity rather than a multiple of an average: measured, the mean
  // over a world of ground-down realms was a stat sum of 22 against the player's 72, so
  // even the old 2.0 ceiling arrived a third weaker at everything.
  //
  // The ceiling came down from 1.4 for the same reason as the army band above: the
  // lead commander draws the TOP half of it, so 1.4 meant the hero you actually met
  // first was reliably a quarter stronger than the best in the world, before its
  // army was counted. Stats enter the damage model multiplicatively on every stack
  // (see docs/PHYSICAL_MODEL.md), so a stat edge and an army edge compound into the
  // wall the request named. Parity, with a little either way, is the ask.
  INVADER_LEADER_MIN: 0.85,
  INVADER_LEADER_MAX: 1.05,
  // A light thumb on the scale only: the MEASUREMENT already tracks the world
  // getting richer, so growth on top of it compounds. At 0.25 the fifth people
  // arrived at nineteen times the average kingdom army.
  // Trimmed 0.15 -> 0.10 now that the gaps are 55-95 days rather than 29-79. The
  // base measurement already tracks the world getting richer, so growth on top
  // of it is a second helping of the same thing — and over a longer gap the
  // defender's own rebuild is already counted once, in the base.
  INVADER_WAVE_GROWTH: 0.10,
  INVADER_READABLE_BAND: 25,     // an army, not a swarm: buy quality first
  INVADER_BAND_MAX: 300,         // …and not so many of it that it reads as a swarm
  INVADER_TROOP_CHOICES: 3,      // draw from the best few it can afford, not always the best
  // Kinds of troop per commander: "several kinds of units in each army so to be able to
  // be more versatile". Heavy centre, lighter wings (see factionSpread). One stack is
  // also a gift to the defender — a single Blind or one shooter answers the whole army.
  INVADER_STACKS: 4,
  // Daily reinforcements, while a people still holds a camp: "they to get each day
  // strong reinforcements until i take their castles or they defeat me". A fraction of
  // what the nation landed with, so it scales with the world exactly as the wave did.
  // Beating the landing armies now buys a week; taking the camps is what ends it.
  // A daily draft of 4% of the landing was measured at 403,000 a day against a player
  // army of 534,000 — a whole army arriving every morning, compounding with no ceiling.
  // 1% is still a fifth of their army daily, which is what "strong" has to mean here.
  INVADER_REINFORCE_SHARE: 0.01,
  INVADER_REINFORCE_STACKS: 2,
  // …and a nation's reserve is FINITE: it can pour in this much more than it landed
  // with, and no more. Logistics, not a fountain — it gives a defender a second path
  // besides the camps (outlast the reserve) and stops an unbounded exponential.
  INVADER_REINFORCE_CAP: 2.0,

  // ---- Pacts: vassalage, tribute, loyalty, revolt --------------------------
  // A realm can be made to serve rather than destroyed: it keeps its mines and
  // its farms and sends a share of the proceeds, answers the call when a wave
  // lands, and is defended in return. Loyalty is what makes it a game — it moves
  // for reasons the player can read, and betrayal is a threshold, never a roll.
  PACT_TRIBUTE_SHARE: 0.15,      // the opening offer: a share of the proceeds
  // HUSBANDRY (a pact term): the vassal's stewards work the weekly sites —
  // windmills, water wheels, trade fairs — standing in their OWN lands, and the
  // suzerain takes the pact's usual share of the yield.
  //
  // The clause exists because the map bleeds: measured over eight weeks, 90% of
  // weekly sites on a 72x60 map and larger were never visited by anyone, which
  // on a 96x80 is 154 000 gold of water wheels alone left to rot. A hero cannot
  // be everywhere, and a realm that has sworn to you has heroes of its own doing
  // nothing with the countryside they still hold.
  //
  // A steward is not a hero, so the yield is a FRACTION: riding out to a mill
  // yourself is still the better take, and the clause supplements the map rather
  // than replacing a reason to move.
  PACT_HUSBANDRY_YIELD: 0.6,
  PACT_TRIBUTE_EASY: 0.10,       // at or under this a vassal counts the hand light
  PACT_TRIBUTE_WEIGHT: 60,       // loyalty per point of share above/below that
  PACT_LOYALTY_START: 60,        // sworn, not yet devoted
  PACT_LOYALTY_WARN: 30,         // "grows restless" — the player's last warning
  PACT_LOYALTY_REVOLT: 0,        // the oath breaks
  PACT_LOYALTY_HELD: 2,          // a quiet week under your banner
  PACT_LOYALTY_LOST_TOWN: 25,    // …and the cost of failing to defend them
  PACT_LOYALTY_WEAK_LORD: 8,     // obedience to someone weaker is a choice, not a duty
  PACT_LOYALTY_SHARED_ENEMY: 6,  // a foreign wave afoot is the best glue there is
  PACT_OVERMATCH: 1.25,          // a vassal this much stronger stops looking up to you
  PACT_ACCEPT_OVERMATCH: 1.5,    // …so a lord only takes an oath it can actually back:
                                 // the deal sells protection, and a lord no stronger
                                 // than its client has nothing to sell
  PACT_ASK_COOLDOWN_DAYS: 7,     // how often a cornered realm sends envoys out again
  // Liberation. Taking a realm's nation back off whoever conquered it and handing
  // it over buys an allegiance a beaten realm never gives: a standing weekly bonus
  // for as long as the pact lives, on top of a warmer start. Keeping the town pays
  // better this week and worse every week after, which is the point.
  PACT_LOYALTY_LIBERATED: 5,       // every week, for as long as they remember
  PACT_LOYALTY_LIBERATED_START: 25, // and they start out already grateful
  PACT_LOYALTY_UNDER_DEBT: 4,      // …and the mirror: an oath sworn to settle a bill
                                   // bleeds every week, because they swore to a
                                   // creditor and not to a lord
  // Cornered: how a realm knows it is finished. Both halves must be true — a small
  // realm with a great army is a fortress, a large one with no army is undefended.
  PACT_CORNERED_FORCE_WEIGHT: 0.7, // how much of the pressure is "can I still fight"
  PACT_CORNERED_THRESHOLD: 0.55,   // combined pressure at which it seeks terms

  // ---- Patronage: the cornered realm that was refused goes shopping ---------
  // Refusing to negotiate with someone weak is only safe if you can actually
  // finish them. A realm squeezed to nothing and left there does not die quietly;
  // it finds somebody who would rather pay for a war on your flank than fight one
  // on their own ground. Cheaper for the patron, fatal for the strategy of
  // starving a neighbour and walking away.
  PATRON_PATIENCE_DAYS: 14,      // cornered this long with no offer IS a refusal
  PATRON_MIN_TREASURY: 8000,     // a broke realm cannot buy a war
  PATRON_TREASURY_FLOOR: 2000,   // …and no patron spends itself down to nothing
  PATRON_RICH: 30000,            // above this, money stops being the constraint
  PATRON_SUBSIDY_SHARE: 0.25,    // a quarter of a patron's weekly gold…
  PATRON_TREASURY_SHARE: 0.08,   // …or this much of the war chest, whichever is more.
                                 // A people from outside is an enormous treasury
                                 // attached to two village halls: sized on income
                                 // alone it would sit on forty thousand gold and
                                 // dribble. Lenin got a chest, not a standing order.
  PATRON_SUBSIDY_MIN: 500,       // below this it is not worth the paperwork
  PATRON_SUBSIDY_MAX: 6000,      // per week, however rich the patron
  PATRON_FEAR_MIN: 0.5,          // a local only funds a proxy war against someone
                                 // who actually overshadows it
  PATRON_INVADER_WEIGHT: 2.0,    // a people from outside outbids any local: it has
                                 // no local balance to protect and every reason to
                                 // see the strongest realm here bled
  PATRON_MAX_CLIENTS: 1,         // one client per patron — legible, and cheap
  PATRON_SHIPMENT_WEEKS: 2,      // how often a contingent physically arrives
  PATRON_SHIPMENT_SHARE: 0.5,    // of that week's subsidy, spent on troops not coin
  PATRON_DETACH_SHARE: 0.10,     // …or a tenth of a stack off the patron's own best
                                 // commander, which is the form that changes a war.
                                 // Nothing is minted: the patron is weaker by exactly
                                 // what the client is stronger, so sponsoring a proxy
                                 // costs blood and is self-limiting.
  PATRON_DETACH_MIN: 2,          // below this it is a gesture, not a detachment
  PATRON_SHIPMENT_MIN: 3,        // fewer than this is a rumour, not a shipment
  PATRON_SHIPMENT_MAX: 60,       // and a contingent, not a second army
  // Calling in the debt. A sponsorship that ends leaves a ledger, and the ledger is
  // the point: Germany bankrolled Lenin and then presented the bill at
  // Brest-Litovsk. Three ways it settles — the client pays, the client cannot pay
  // and swears, or the client tells its creditor to go hang. Which one happens is
  // decided by arithmetic the player can follow, not by a roll.
  // The front the money buys. A sponsorship with no war attached is a wire transfer:
  // the patron funds a war on your border and then wanders off to loot a windmill.
  PATRON_WAR_BIAS: 1.8,          // how far a patron (and its client) covet the realm
                                 // the money was spent against
  PATRON_TRUCE_DAMP: 0.15,       // …and how far the two of them ease off each other
  PATRON_DEBT_OVERMATCH: 1.5,    // a creditor must be this much stronger to enforce a
                                 // bill. Below it, the client repudiates — which is
                                 // exactly what a patron who gave until it was spent
                                 // has coming.
  PATRON_DEBT_TRIBUTE: 0.25,     // terms taken at the point of a bill are worse than
                                 // terms negotiated freely (the standing offer is 15%)
  PATRON_DEBT_RESENTMENT: 20,    // …and the oath starts that much colder
  PATRON_DRY_WEEKS: 4,           // weeks with nothing to send — no coin, and no
                                 // commander left who outguns the client — before the
                                 // sponsorship is written off as spent. A patron
                                 // between paydays recovers in a week or two; without
                                 // this an exhausted one stayed on the books forever.
  PATRON_PARITY: 0.9,            // a client this close to matching the realm it was
                                 // armed against no longer needs anyone's coin. The
                                 // account exists to fight ONE realm, so parity with
                                 // that realm closes it — measured against the world
                                 // instead, a client sponsored by a people ashore is
                                 // compared to its own patron and reads as cornered
                                 // forever.

  // ---- Uprisings: the bought rebellion (see core/uprisings.js) -------------
  // Asked for as: "I need the vassals either one by one or two or three of them to
  // suddenly decide from time to time to overthrow me and take my castles — an outside
  // power finances them and they can buy big armies (200k, 300k of gold each rebel
  // ruler), so they can quickly amass huge armies and attack me."
  //
  // The trigger was never the missing piece — pacts.js already revolts on a loyalty
  // slide. The WAR CHEST is: a vassal that walks away is still the one-town realm that
  // swore in the first place, so it cannot take a castle and does not try.
  UPRISING_MIN_PACT_DAYS: 28,    // a fortnight-old oath rising reads as the engine
                                 // cheating, and makes taking an oath a worse deal
                                 // than finishing them
  UPRISING_COOLDOWN_DAYS: 56,    // a coalition that survived one gets a season to put
                                 // itself back together
  UPRISING_WEEKLY_CHANCE: 0.06,  // the base weekly odds against a lord with one vassal…
  UPRISING_CHANCE_PER_VASSAL: 0.04, // …and per extra sworn realm: more doors to knock on
  UPRISING_CHANCE_MAX: 0.30,     // however restless and however large, never more
  UPRISING_RESTLESS_WEIGHT: 0.6, // how far the most tempted vassal raises the odds
  UPRISING_HEGEMON_WEIGHT: 0.5,  // …and how far the lord's share of the map does. A
                                 // banner over two thirds of the towns has already won
                                 // unless somebody spends money on it.
  UPRISING_RESTLESS_SHARE: 0.6,  // of seducibility: loyalty says whether they WANT to
                                 // leave, their own army says whether it is worth
                                 // anybody's money
  UPRISING_DEBT_BONUS: 0.15,     // an oath sworn to settle a bill turns easiest…
  UPRISING_GRATITUDE_DAMP: 0.15, // …and a realm you handed its nation back to, hardest
  UPRISING_MIN_LORD_FORCE: 250000, // nobody buys a rebellion against a realm that has
                                 // not won anything yet. MEASURED, and the difference
                                 // between a war and an execution: without it a rising
                                 // fired on day 36 of a 6-game sim against a lord
                                 // fielding 90k, and the 283k host it bought ended the
                                 // game two days later. The whole realm's armies and
                                 // garrisons (patrons.realmArmy), not one hero.
  UPRISING_REBEL_ODDS: [0.55, 0.30, 0.15], // one, two or three rise in the same hour
  UPRISING_REBEL_PER_CHEST: 2,   // …and how many the backer will actually pay for: one
                                 // more per this many chests' worth of lord to unseat.
                                 // Three rebellions against a small realm is money
                                 // wasted, and three chests against a large one is the
                                 // only thing that would work.
  UPRISING_CHEST_MIN: 200000,    // the figure the request named — and a FLOOR, not the
  UPRISING_CHEST_MAX: 300000,    // whole of it: flat money is a war in month three and
  UPRISING_CHEST_PER_FORCE: 0.40, // pocket change in month nine, so the chest also
  UPRISING_CHEST_CAP: 900000,    // tracks the army the rebel has to actually beat
  UPRISING_BACKER_SHARE: 0.5,    // of an on-map backer's spendable purse. The local half
                                 // is a real debit — funding a rebellion is a decision.
  UPRISING_HOST_SHARE: 0.6,      // of the chest arrives as MEN, not coin: gold has to be
                                 // spent through dwellings that grow weekly, and a
                                 // rebellion that needs six weeks to become dangerous is
                                 // one the player answers at leisure
  UPRISING_HOST_WEIGHTS: [0.4, 0.25, 0.2, 0.15], // across four tiers, top-heavy — one
                                 // enormous stack dies to a single Blind
  UPRISING_HOST_JITTER: 0.2,     // ±10% per stack, so two risings differ
  UPRISING_STAT_SHARE: 0.8,      // a bought captain against the world's best commander
  UPRISING_WAR_BIAS: 2.2,        // how far rebels covet their old lord's castles (and he
                                 // theirs). Desirability only — never the superiority
                                 // gate, so a rebel never charges a hopeless fight.
  UPRISING_MERCY_LOYALTY: 20,    // spared, and they remember it

  // ---- Library of Enlightenment -------------------------------------------
  // HoMM3's library gated its gift behind a hero worth teaching. Both halves asked
  // for: "after level 10 they gave 2 on all 4 hero main powers", and "more libraries
  // on the larger maps" — so a great map is worth crossing for more than land.
  LIBRARY_MIN_LEVEL: 10,   // below this a hero is turned away (and told why)
  LIBRARY_BONUS: 2,        // to EACH of the four primaries, once per hero
  LIBRARY_PER_TILES: 3600, // one library per this much land, past the first

  // ---- Town strip ----------------------------------------------------------
  // Three chips across the HUD strip stops working past ten towns: at fifteen it was
  // five pages of clicking to reach the one you wanted. Past this many the strip
  // collapses to one chip that opens a vertical carousel — "10 visible is the optimal".
  TOWN_CAROUSEL_FROM: 10,
  TOWN_CAROUSEL_VISIBLE: 10,

  // ---- Chronicle (the game's log book, for diagnosis) ----------------------
  // A ring buffer: a long game on a big map would otherwise put megabytes of daily
  // positions into localStorage. At roughly one position entry per day plus events, this
  // holds a year and a half of play before the oldest lines roll off — and the header
  // says how many were dropped, so a reader is never quietly missing the opening.
  CHRONICLE_MAX: 6000,

  // ---- Endless run (win a realm, march into the next) ----------------------
  // A run has no last chapter: each realm is regenerated from the setup that made
  // the first, your top heroes and your masonry carry, and everyone else's realm
  // advances with yours. These set how steeply.
  // How a rival's commanders are levelled against the player's, rank for rank
  // (endless.matchRivalProgression). 1.0 = a peer. Below 1 concedes the opening;
  // above 1 makes every realm an uphill fight from the first day. It is deliberately
  // NOT an army multiplier: ENDLESS_ARMY_MULT already escalates the stacks, and the
  // chronicle showed what happens when only the stacks escalate — armies at 1.05:1
  // and a battle that ended 100-3, because the commander enters the damage model
  // multiplicatively on every stack and the army enters it once.
  RIVAL_LEVEL_MATCH: 1.0,
  // …and the stat gap the levels leave behind (endless.matchRivalStats). Separate
  // from the level match because most of a carried commander's stats never came from
  // levelling: measured, 63 of one commander's 65 gained points came from map
  // boosters and artifacts, which a rival on a fresh map has had no chance to visit.
  RIVAL_STAT_MATCH: 1.0,
  ENDLESS_CARRY_HEROES: 3,     // the commander plus two lieutenants march on
  ENDLESS_ARMY_MULT: 1.6,      // a rival's starting army, per realm past the first
  ENDLESS_FOE_ARTIFACTS: 2,    // artifacts handed to each rival hero, per realm
  ENDLESS_TIDE_STEP: 0.12,     // added to the Tide of War floor each realm, so the
                               // wild world scales with a veteran army too
  // The realm should also get BIGGER, not merely harder: "start a bigger more
  // complicated map — if none available, can be same size map, just dial the
  // monsters a notch up". So each realm grows the map by a step until it hits the
  // ceiling, and past the ceiling only the hardness keeps climbing (which it does
  // from realm 2 onward regardless, via ENDLESS_TIDE_STEP).
  ENDLESS_MAP_STEP: 12,        // tiles added to BOTH axes per realm, until…
  ENDLESS_MAP_MAX_W: 144,      // …the widest map the generator ships (scenarios.js)
  ENDLESS_MAP_MAX_H: 120,

  // ---- The Pax (peace by oath) ---------------------------------------------
  // Every surviving rival sworn to you is not a conquest — they keep their lands
  // and can throw the banner off. The map keeps running and the age is decided by
  // what comes from outside instead: repel this many invasions and it is yours.
  PAX_INVASION_TARGET: 5,
  // The counts offered in the custom-game victory picker, and when the Pax asks
  // how long a watch you want to stand.
  PAX_INVASION_CHOICES: [3, 5, 10, 15],

  // ---- The long watch: an age measured in BATTLES, not in waves -------------
  //
  // Reported, and the arithmetic is the player's own: "the games finish too
  // early — I fight off three waves, sometimes it's just 3 bands, and the game is
  // over. Let's make it two hundred battles against invaders: 10 bands in one big
  // wave = 10 battles, 2 castles by 4 invader heroes are 8 battles, so they
  // accumulate fast."
  //
  // That is a different UNIT, not a bigger number, and the difference is the whole
  // point. `repelInvasions` tallies a WAVE — deliberately, because counting bands
  // once ended a game on the first raid of it (actions.noteInvasionRepelled) — so
  // a wave that took ten separate fights and a wave that arrived as three bands
  // and rode home both score exactly 1. A player who wants a long defensive age
  // has no way to ask for one: the only dial is a wave count, and fifteen waves at
  // a season apiece is a different complaint.
  //
  // Counting battles asks for the thing the player actually spends: turns at the
  // wall. It also self-scales — a bigger wave IS more of the objective, so the
  // surge ladder below feeds it rather than fighting it.
  PAX_BATTLE_TARGET: 200,
  PAX_BATTLE_CHOICES: [50, 100, 200, 400],
  // Once the Pax is on, the waves come CLOSER TOGETHER. The ordinary 84-day
  // period is paced for a map whose story is the war between realms, with the
  // sea as an interruption; under the Pax that war is over and the coast IS the
  // story, so the same period turns the endgame into a wait — measured, five
  // invasions at the old cadence lands past day 390.
  //
  // 28 -> 21 with the battle count: two hundred battles at ten a wave is twenty
  // landings, and at 28 days apiece that is a year and a half of calendar spent
  // mostly waiting. The rebuild argument that set the heavy tier's period does not
  // apply with the same force here, because the surge ladder below only shortens
  // the gap for a realm the last wave did not hurt.
  PAX_INVASION_PERIOD_DAYS: 21,

  // ---- Rule the realm: the town-count ending -------------------------------
  // Asked for in these words: "presently the biggest map starts with 22 towns, the
  // big invasions bring 1 or 2 new towns[;] we can set usual ending condition for
  // the biggest map 42 towns for the main nation (20 more towns from invasions) and
  // prorated for the smaller maps like a smallest map: 5 towns added and captured
  // from invasions, the others in between."
  //
  // So the target is the map's OWN towns plus a share that can only come from the
  // sea. Every generated map's town count was measured rather than guessed —
  // 36x30: 3 · 44x36: 3 · 56x46: 5 · 72x60: 8 · 88x72: 10 · 96x80: 12 ·
  // 144x120: 22 — and the two anchors below are exactly the two numbers in the
  // report (3 towns -> +5, 22 towns -> +20), interpolated linearly for everything
  // between and extrapolated past the top for a map bigger than any we ship.
  // The resulting ladder: 8 · 8 · 12 · 17 · 21 · 24 · 42.
  //
  // WHY THE BONUS CAN ONLY COME FROM THE SEA, and the pace of it: an invader nation
  // arrives with a beachhead camp — a fully developed town — and taking it keeps it
  // (core/invaderRealms.plantBeachhead). Camps are the only towns anybody adds to a
  // map after generation.
  //
  // MEASURED, for a player who takes every camp as it lands and keeps their army
  // through it (which is what INVADER_TEMPO_KEEP asks; a realm that gets mauled
  // waits the full season and the numbers below roughly double):
  //   72x60, one camp a landing:  +5 by day ~220 · +12 by ~460 · +20 by ~735
  //   144x120, ~1.5 camps a landing (INVADER_BEACHHEAD_MAX_BIG): +5 by ~170 ·
  //   +12 by ~320 · +20 by ~520
  // So the 42-town charge on World's Edge is about a year and a half of game time
  // rather than the four years it was before the camp cap and the tempo — which is
  // the reason both of those exist. Two seeds apiece, no fighting in the sim, so
  // read them as the best case the tempo allows.
  HOLD_TOWNS_ANCHOR_LOW: 3,      // the smallest map's town count…
  HOLD_TOWNS_BONUS_MIN: 5,       // …and the towns it must take from the invasions
  HOLD_TOWNS_ANCHOR_HIGH: 22,    // the biggest map's town count…
  HOLD_TOWNS_BONUS_MAX: 20,      // …and its share
  HOLD_TOWNS_MIN: 2,             // a bound, so a hand-typed target is never absurd

  // ---- The age floor (how long an age must run before it can be won) -------
  // Reported: "this game finished after I beat up the first rogue band attacking
  // me — can we set up some guardrails so I can play enough time in developing
  // [the] game, in medium developed and a fully developed? I could not finish and
  // try my castle units improvements nor to face some full fledge invasions from
  // enemy hordes."
  //
  // A floor does NOT change any victory condition. It says when the realm is
  // grown enough for one to SETTLE: a win earned before then is held — announced,
  // recorded, and awarded the day the floor is met (see core/ages.js). Nothing
  // holds a DEFEAT, and the player can always take the crown early, so this can
  // only ever add days you asked for.
  //
  // Each floor is a list of things a realm actually does, not one timer:
  //   days       the calendar alone — an age is not measured in battles
  //   hall/fort  the seat of power: one town carrying that hall and that wall
  //   dwellings  creature dwellings standing in that same town…
  //   upgrades   …and how many of them upgraded (the "castle units improvements")
  //   waves      foreign waves that have come ashore and been weathered
  //   patience   the backstop, in absolute days: past this the floor lifts on its
  //              own, so a realm that CANNOT meet a requirement (its capital razed,
  //              its masons dead) is never trapped in a game it has already won.
  //
  // The wave counts are read off the invasion calendar and not invented: the first
  // lands on day 57, the third — the first that is a `host` rather than a raid —
  // around day 225, which is why the golden floor's calendar sits where it does.
  AGE_FLOORS: {
    swift: {
      id: 'swift', name: 'Swift', menu: 'Swift — win the moment you have won',
      blurb: 'The age ends when it is decided. No guardrail.',
      days: 0, hall: null, fort: null, dwellings: 0, upgrades: 0, waves: 0, patience: 0,
    },
    settled: {
      id: 'settled', name: 'A settled realm', menu: 'Settled realm — a developed capital first',
      blurb: 'A city hall behind a citadel, five dwellings raised and one of them '
        + 'upgraded, and a people met on the shore — about four months.',
      days: 112, hall: 'cityHall', fort: 'citadel', dwellings: 5, upgrades: 1, waves: 1,
      patience: 224,
    },
    golden: {
      id: 'golden', name: 'A golden age', menu: 'Golden age — a finished realm, and the hordes',
      blurb: 'A capitol behind a castle, every dwelling standing and four of them '
        + 'upgraded, and three waves weathered — the third of them a host. About eight months.',
      days: 224, hall: 'capitol', fort: 'castle', dwellings: 7, upgrades: 4, waves: 3,
      patience: 448,
    },
  },
  DEFAULT_AGE_FLOOR: 'swift',
};

/** Ordered list of the seven resources. Order is used across all UI. */
export const RESOURCES = ['gold', 'wood', 'ore', 'mercury', 'sulfur', 'crystal', 'gems'];

export const RESOURCE_LABELS = {
  gold: 'Gold', wood: 'Wood', ore: 'Ore', mercury: 'Mercury',
  sulfur: 'Sulfur', crystal: 'Crystal', gems: 'Gems',
};

/** Cumulative XP thresholds: XP_TABLE[level] = total XP required to reach that level. */
export const XP_TABLE = (() => {
  const t = [0, 0]; // levels are 1-based; level 1 requires 0 XP
  let step = CONFIG.XP_BASE;
  for (let lvl = 2; lvl <= CONFIG.HERO_MAX_LEVEL; lvl++) {
    t[lvl] = Math.round(t[lvl - 1] + step);
    step *= CONFIG.XP_GROWTH;
  }
  return t;
})();

/**
 * validateConfig — dev-time referential-integrity check over the constants
 * above. Pure and side-effect-free: returns an array of human-readable
 * problem strings (empty === everything lines up) and never throws, so it is
 * safe to import. It does NOT run on import; wire it into a dev boot or a
 * test if you want it to fire, e.g. `console.warn(validateConfig().join('\n'))`.
 *
 * `terrains` (optional) is the caller's terrain enum — pass it to assert that
 * TERRAIN_COST has an entry for every terrain the map can produce. config.js
 * stays a dependency-free leaf, so the enum is injected rather than imported.
 */
export function validateConfig({ terrains } = {}) {
  const problems = [];
  const resourceSet = new Set(RESOURCES);

  // RESOURCE_LABELS must name exactly the resources — no gaps, no strays.
  for (const r of RESOURCES) {
    if (!(r in RESOURCE_LABELS)) problems.push(`RESOURCE_LABELS missing "${r}"`);
  }
  for (const r of Object.keys(RESOURCE_LABELS)) {
    if (!resourceSet.has(r)) problems.push(`RESOURCE_LABELS has unknown resource "${r}"`);
  }

  // Every resource the economy references must be a known resource.
  for (const r of Object.keys(CONFIG.STARTING_RESOURCES)) {
    if (!resourceSet.has(r)) problems.push(`STARTING_RESOURCES has unknown resource "${r}"`);
  }
  for (const [mine, income] of Object.entries(CONFIG.MINE_INCOME)) {
    for (const r of Object.keys(income)) {
      if (!resourceSet.has(r)) problems.push(`MINE_INCOME.${mine} yields unknown resource "${r}"`);
    }
  }
  for (const [r, amount] of Object.entries(CONFIG.BOAT_COST)) {
    if (!resourceSet.has(r)) problems.push(`BOAT_COST charges unknown resource "${r}"`);
    if (!(amount > 0)) problems.push(`BOAT_COST.${r} must be a positive amount`);
  }

  // TERRAIN_COST: every cost is a positive multiplier, and (when the enum is
  // supplied) every terrain the game uses has a cost entry.
  for (const [t, cost] of Object.entries(CONFIG.TERRAIN_COST)) {
    if (!(cost > 0)) problems.push(`TERRAIN_COST.${t} must be a positive multiplier`);
  }
  if (terrains) {
    for (const t of terrains) {
      if (!(t in CONFIG.TERRAIN_COST)) problems.push(`TERRAIN_COST missing terrain "${t}"`);
    }
  }

  // ROAD_COST: every road discount is in (0, 1] — a road must be no slower than
  // open ground (else the A* heuristic, which floors at the minimum, breaks).
  for (const [r, cost] of Object.entries(CONFIG.ROAD_COST)) {
    if (!(cost > 0 && cost <= 1)) problems.push(`ROAD_COST.${r} must be a multiplier in (0, 1]`);
  }
  // NATIVE_TERRAIN_MULT: a home-turf bonus is likewise in (0, 1] (never a penalty).
  if (!(CONFIG.NATIVE_TERRAIN_MULT > 0 && CONFIG.NATIVE_TERRAIN_MULT <= 1)) {
    problems.push('NATIVE_TERRAIN_MULT must be a multiplier in (0, 1]');
  }

  // FACTION_GRAIL: each signature blessing is well-formed — a gold bonus is a
  // positive amount, a growthMult is a real (≥ 1) boost, fullMana is a flag.
  for (const [faction, perk] of Object.entries(CONFIG.FACTION_GRAIL)) {
    if ('gold' in perk && !(perk.gold > 0)) problems.push(`FACTION_GRAIL.${faction}.gold must be positive`);
    if ('growthMult' in perk && !(perk.growthMult >= 1)) problems.push(`FACTION_GRAIL.${faction}.growthMult must be ≥ 1`);
  }

  // Tide-of-War living emergence (#12): batch sizing must be non-negative and
  // clamp above the base, and the aiValue budget window must be a valid, ordered
  // positive range (rollWildStack reads [lo, hi] and ints across it).
  if (!(CONFIG.TIDE_WEEK_SPAWN_BASE >= 0)) problems.push('TIDE_WEEK_SPAWN_BASE must be ≥ 0');
  if (!(CONFIG.TIDE_WEEK_SPAWN_PER_MONTH >= 0)) problems.push('TIDE_WEEK_SPAWN_PER_MONTH must be ≥ 0');
  if (!(CONFIG.TIDE_WEEK_SPAWN_MAX >= CONFIG.TIDE_WEEK_SPAWN_BASE)) {
    problems.push('TIDE_WEEK_SPAWN_MAX must be ≥ TIDE_WEEK_SPAWN_BASE');
  }
  if (!(CONFIG.TIDE_MONTH_SPAWN_BASE >= 0)) problems.push('TIDE_MONTH_SPAWN_BASE must be ≥ 0');
  if (!(CONFIG.TIDE_MONTH_SPAWN_PER_MONTH >= 0)) problems.push('TIDE_MONTH_SPAWN_PER_MONTH must be ≥ 0');
  if (!(CONFIG.TIDE_MONTH_SPAWN_MAX >= CONFIG.TIDE_MONTH_SPAWN_BASE)) {
    problems.push('TIDE_MONTH_SPAWN_MAX must be ≥ TIDE_MONTH_SPAWN_BASE');
  }
  const spawnBudget = CONFIG.TIDE_MONTH_SPAWN_BUDGET;
  if (!Array.isArray(spawnBudget) || spawnBudget.length !== 2
      || !(spawnBudget[0] > 0) || !(spawnBudget[1] >= spawnBudget[0])) {
    problems.push('TIDE_MONTH_SPAWN_BUDGET must be an ordered positive [lo, hi] range');
  }

  // Landmark visitables: every grant must be a positive amount (a zero or
  // negative boost/reveal/XP would ship dead or actively harmful content).
  for (const key of ['MOVE_BOOST', 'OBELISK_REVEAL', 'OBELISK_XP',
    'STABLES_MOVE_BONUS', 'LEARNING_STONE_XP', 'CAPTURE_REVEAL', 'MINE_REVEAL']) {
    if (!(CONFIG[key] > 0)) problems.push(`${key} must be a positive number`);
  }

  // XP_TABLE must be strictly monotonic from level 2 up (level 1 costs 0 XP).
  if (XP_TABLE[1] !== 0) problems.push('XP_TABLE[1] should be 0 (level 1 costs no XP)');
  for (let lvl = 2; lvl <= CONFIG.HERO_MAX_LEVEL; lvl++) {
    if (!(XP_TABLE[lvl] > XP_TABLE[lvl - 1])) {
      problems.push(`XP_TABLE not monotonic at level ${lvl}`);
    }
  }

  return problems;
}

// The unskilled value of every school-laddered knob IS index 0 of its ladder.
// Derived here rather than repeated in the literal above, so `CONFIG.X` and
// `CONFIG.X_BY_SCHOOL[0]` cannot drift apart — and so every reader that has no
// hero in hand (and therefore no mastery to apply) keeps reading a plain number.
for (const [key, ladder] of Object.entries(CONFIG)) {
  if (key.endsWith('_BY_SCHOOL')) CONFIG[key.slice(0, -'_BY_SCHOOL'.length)] = ladder[0];
}

/**
 * A config read that FAILS on an unknown key, instead of quietly defaulting.
 *
 * I12 mandates `?? default` for save fields and is right to: a field absent from an
 * old save is EXPECTED absence, and defaulting is the migration. Config is the
 * opposite case. A key missing from `CONFIG` is not an old version of anything — it
 * is a typo, and `??` turns that typo into a silent wrong answer.
 *
 * This is not hypothetical. `exposure.mjs` read `CONFIG.BATTLE_COLS ?? 15` for a key
 * the config has never had. It got the right number by coincidence, because
 * `BATTLE_W` happens to be 15, and it would have gone on returning 15 after any
 * change to the battlefield's width — an instrument silently pinned to a constant it
 * believed it was reading.
 *
 * THE DISTINCTION, stated once so it can be applied elsewhere: **`??` is for expected
 * absence; unexpected absence needs an assertion.** Same operator, opposite
 * intentions, and only one of them belongs in a config read.
 */
export function cfg(key) {
  if (!Object.hasOwn(CONFIG, key)) {
    throw new Error(`CONFIG.${key} does not exist. A missing config key is a typo, not a `
      + 'default — see cfg() in src/config.js. Did you mean one of: '
      + `${Object.keys(CONFIG).filter((k) => k.startsWith(key.slice(0, 4))).join(', ') || '(no near match)'}?`);
  }
  return CONFIG[key];
}
