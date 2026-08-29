/**
 * scenarios.js — Preset scenario definitions (a size / scale ladder).
 *
 * Each preset just parameterises newGame; the map generator scales its layout
 * and object density to the given dimensions. An entry MAY additionally carry
 * a default `players` roster (each { faction, isHuman, team } — the shape
 * newGame's setup.players expects, with entry 0 as the human): scenes that
 * honor it should pass it through to newGame (overriding players[0].faction
 * with the menu's banner pick where one exists). Scenes that don't (or
 * presets without one) fall back to their own roster — every entry stays a
 * plain size preset for the classic 1v1 flow, and any size can be played
 * with 3+ players through the Custom Game form's match cycler.
 */

// Full size ladder — the generator scales its layout and object density to any
// of these (verified 0 crashes / 300 seeds per size, ~56 objects at 36×30 up to
// ~314 at 88×72). From 56×46 up, the countryside additionally seats neutral
// capturable towns (1 → 3 → 5 → 6 as the sizes grow; none on the two smallest,
// which keep their classic compact feel).
export const SCENARIOS = [
  { id: 'skirmish', name: 'Border Skirmish', desc: 'A compact duel — quick to settle.', mapW: 36, mapH: 30 },
  { id: 'duel', name: "Rivals' March", desc: 'The classic head-to-head.', mapW: 44, mapH: 36 },
  { id: 'frontier', name: 'Frontier War', desc: 'Room to maneuver and expand.', mapW: 56, mapH: 46 },
  { id: 'realms', name: 'Warring Realms', desc: 'A broad theatre of war.', mapW: 72, mapH: 60 },
  { id: 'empire', name: 'Age of Empires', desc: 'An epic, sprawling campaign.', mapW: 88, mapH: 72 },
  {
    id: 'worldsEdge',
    name: "World's Edge",
    desc: 'Half again as wide and half again as tall: two and a quarter times the land '
      + 'of any other map, for a war fought at the scale of an age.',
    mapW: 144,
    mapH: 120,
    players: [
      // CLONE: two playable factions, so a four-way is two of each rather than
      // four different towns. Still four independent teams — what the scenario is
      // actually for is the free-for-all, not the faction variety.
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
      { faction: 'castle', isHuman: false, team: 2 },
      { faction: 'inferno', isHuman: false, team: 3 },
    ],
  },
  {
    id: 'clash',
    name: 'Clash of Kingdoms',
    desc: 'Three crowns, nine castles: a vast land of neutral holds, mines and obelisks.',
    mapW: 96,
    mapH: 80,
    // Default 3-player roster: you against an allied pair of AI warlords (the
    // two-zone map splits every match into two sides, so 3 players means
    // 1 vs 2). With 3 start towns + 6 neutral surface towns the map seats ~9
    // castles above ground, plus the underground's own capturable holds.
    players: [
      { faction: 'castle', isHuman: true, team: 0 },
      { faction: 'inferno', isHuman: false, team: 1 },
      { faction: 'inferno', isHuman: false, team: 1 },
    ],
  },
];

/** Index of the default preset ("Rivals' March", the historical 44×36 size). */
export const DEFAULT_SCENARIO = 1;
