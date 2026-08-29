/**
 * campaigns.js — EMPTY CAMPAIGN REGISTRY (jma3-clone).
 *
 * Upstream this file is ~66 KB of hand-authored story campaigns: ordered chains of
 * scenarios with scripted events, fixed enemy rosters and carried-over heroes.
 * This clone studies AI PLAYER logic on ordinary maps, so it ships none of them.
 *
 * The file itself stays because core/actions.js imports `campaignById` and calls
 * `applyCampaignEvents()` once per day inside the core day tick — and actions.js is
 * kept BYTE-IDENTICAL to upstream so AI work patches cleanly in both directions.
 * With an empty registry `campaignById` always returns null, the per-day pass falls
 * straight through, and core/campaign.js's `isCampaign()` / `currentScenario()`
 * report "not a campaign" to the two scenes that ask.
 *
 * There is a second reason this could not simply keep upstream's data: every one of
 * the six campaigns names factions this clone does not carry (necropolis, tower,
 * rampart) as player or enemy rosters, which would seat towns of a faction absent
 * from the registry.
 *
 * To restore campaigns, copy this file back from the parent repo — but re-add the
 * factions its rosters name first (see data/factions.js).
 */

/** No campaigns in this clone. Same shape as upstream: an array of campaign defs. */
export const CAMPAIGNS = [];

/** Look a campaign up by id. Always null here — the registry is empty. */
export function campaignById(id) {
  return CAMPAIGNS.find((c) => c.id === id) || null;
}
