/**
 * ui-telemetry-report.mjs — read an exported usage file and print what can be cut.
 *
 * The export button on Settings ▸ Advanced writes `jma3-usage-YYYY-MM-DD.json`.
 * This turns one (or several) of those into the five read-outs that answer the
 * question the counting exists for: which doors does anyone actually open?
 *
 * It shares `summarize()` with the game, so the console readout (`jma3Usage()`),
 * the unit tests and this script cannot disagree.
 *
 * Usage:
 *   node scripts/ui-telemetry-report.mjs ~/Downloads/jma3-usage-2026-08-11.json
 *   node scripts/ui-telemetry-report.mjs a.json b.json c.json     # merged
 */

import { readFileSync } from 'node:fs';
import { summarize, formatSummary } from '../src/game/uiTelemetry.js';

/**
 * Merge several players' exports into one document.
 *
 * Counters add; `paths` concatenate (a route is a route, whoever walked it);
 * `since` takes the earliest. Merging matters because the interesting signal —
 * a control nobody presses — needs more than one person's habits behind it
 * before it is safe to act on.
 */
export function mergeDocs(docs) {
  const out = {
    v: 1, since: null, sessions: 0, counts: {}, firstClick: {}, rendered: {}, scenes: {}, paths: [],
  };
  for (const d of docs) {
    if (!d) continue;
    out.sessions += d.sessions || 0;
    if (d.since && (!out.since || d.since < out.since)) out.since = d.since;
    for (const field of ['counts', 'firstClick', 'rendered', 'scenes']) {
      for (const [k, n] of Object.entries(d[field] || {})) out[field][k] = (out[field][k] || 0) + n;
    }
    out.paths.push(...(d.paths || []));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/ui-telemetry-report.mjs <exported-usage.json> [more.json ...]');
    process.exit(2);
  }
  const docs = files.map((f) => {
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) {
      console.error(`could not read ${f}: ${e.message}`);
      process.exit(1);
      return null;
    }
  });
  const merged = mergeDocs(docs);
  console.log(`${files.length} file(s) merged\n`);
  console.log(formatSummary(summarize(merged, { top: 20 })));

  // The one thing the shared formatter does not print, because only an operator
  // reading a merged file can act on it: the doors on the FRONT screens
  // specifically, which is where the simplification question was asked.
  const front = ['Menu', 'Campaign', 'CustomScenario'];
  const rows = Object.entries(merged.rendered)
    .filter(([id]) => front.includes(id.split(':')[0]))
    .map(([id, shown]) => ({ id, shown, used: merged.counts[id] || 0 }))
    .sort((a, b) => a.used - b.used || b.shown - a.shown);
  console.log('\n\nSTART-SCREEN DOORS, least used first');
  console.log('  used   shown   rate   control');
  for (const r of rows) {
    const rate = r.shown ? `${Math.round((r.used / r.shown) * 100)}%` : '—';
    console.log(`  ${String(r.used).padStart(4)}  ${String(r.shown).padStart(6)}  ${rate.padStart(5)}   ${r.id}`);
  }
}
