/**
 * skirmishScenarios.js — Battle Gym presets (pure data).
 *
 * Each scenario is a "prepare under constraints -> fight -> debrief" puzzle:
 * a fixed enemy army you can see, and a point budget you compose your own
 * company within. Points use each creature's aiValue (a single power score
 * that already exists in the catalog), so the constraint needs no new economy.
 *
 * HOW TO ADD ONE: append an entry with a unique id, a playerFaction, a
 * pointBudget, and an enemy { faction, hero, army:[{creature,count}] } using
 * real creature ids from data/creatures.js.
 */

import { CREATURES } from './creatures.js';

export const SKIRMISH_SCENARIOS = [
  {
    id: 'border-skirmish',
    name: 'Border Skirmish',
    brief: 'A raiding party slipped across the frontier. Assemble a small company and throw them back.',
    playerFaction: 'castle',
    pointBudget: 2400,
    enemyFaction: 'inferno',
    enemyHero: 'fiona',
    enemyArmy: [{ creature: 'imp', count: 25 }, { creature: 'gog', count: 8 }],
  },
  {
    id: 'undermanned-hold',
    name: 'The Undermanned Hold',
    brief: 'You are outnumbered and cannot afford a fair fight. Spend well — every unit must earn its place.',
    playerFaction: 'castle',
    pointBudget: 3500,
    enemyFaction: 'inferno',
    enemyHero: 'marius',
    enemyArmy: [
      { creature: 'imp', count: 20 },
      { creature: 'gog', count: 10 },
      { creature: 'hellHound', count: 6 },
    ],
  },
  {
    id: 'devils-at-the-gate',
    name: 'Devils at the Gate',
    brief: 'The abyss sends its elite. Only a balanced, well-timed company survives this.',
    playerFaction: 'castle',
    pointBudget: 8000,
    enemyFaction: 'inferno',
    enemyHero: 'axsis',
    enemyArmy: [
      { creature: 'efreeti', count: 3 },
      { creature: 'cerberus', count: 6 },
      { creature: 'magog', count: 8 },
    ],
  },
  {
    id: 'hounds-of-the-waste',
    name: 'Hounds of the Waste',
    brief: 'A hunting pack ranges ahead of the legion. Blunt them before the main host arrives.',
    playerFaction: 'castle',
    pointBudget: 2500,
    enemyFaction: 'inferno',
    enemyHero: 'ignatius',
    enemyArmy: [
      { creature: 'imp', count: 18 },
      { creature: 'hellHound', count: 5 },
    ],
  },
  {
    id: 'cornered-legion',
    name: 'The Cornered Legion',
    brief: 'The tables turn: you march for the abyss against a royal column dug in on native soil.',
    playerFaction: 'inferno',
    pointBudget: 3600,
    enemyFaction: 'castle',
    enemyHero: 'valeska',
    enemyArmy: [
      { creature: 'archer', count: 10 },
      { creature: 'griffin', count: 4 },
      { creature: 'swordsman', count: 3 },
    ],
  },
  {
    id: 'crucible-of-angels',
    name: 'Crucible of Angels',
    brief: 'The war ends here. Match the abyss lords stack for stack — or bury your company trying.',
    playerFaction: 'castle',
    pointBudget: 19000,
    enemyFaction: 'inferno',
    enemyHero: 'axsis',
    enemyArmy: [
      { creature: 'devil', count: 2 },
      { creature: 'efreeti', count: 4 },
      { creature: 'cerberus', count: 8 },
    ],
  },
];

/** Total power of a list of {creature, count} stacks, in aiValue points. */
export function armyPoints(stacks) {
  return (stacks || []).reduce((n, s) => n + (CREATURES[s.creature]?.aiValue || 0) * (s.count || 0), 0);
}
