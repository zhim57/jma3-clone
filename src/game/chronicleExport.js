/**
 * chronicleExport.js — get the log book out of the browser and into a file.
 *
 * The chronicle is written by the rule engine (core/chronicle.js) and rides the save.
 * This is the only piece that needs a DOM: turning it into something you can attach to a
 * message. Kept out of core for that reason.
 *
 * Two doors, because the useful one depends on where you are:
 *   a Settings button, for when you are playing; and
 *   window.jma3Log() / window.jma3LogJson() in the console, for when you are debugging
 *   and would rather have the text than a download.
 */

import { chronicleText, chronicleJson, chronicleEntries } from '../core/chronicle.js';
import { getState } from './session.js';

/** A filename that sorts and says what it is: jma3-log-seed12345-day87.txt */
function logName(state, ext) {
  return `jma3-log-seed${state?.seed ?? 'x'}-day${state?.day ?? 0}.${ext}`;
}

/** Push `text` at the browser as a download. Returns false when there is no DOM. */
function saveText(text, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a timer rather than immediately: Safari has been known to cancel the
  // download if the object URL dies in the same tick as the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/**
 * Download the chronicle of the game in progress. Returns
 * { ok, entries, filename } | { ok: false, reason } so a caller can say something useful
 * instead of appearing to do nothing.
 */
export function downloadChronicle({ json = false } = {}) {
  const state = getState();
  if (!state) return { ok: false, reason: 'no game in progress' };
  const entries = chronicleEntries(state).length;
  if (!entries) return { ok: false, reason: 'nothing logged yet — end a turn first' };
  const filename = logName(state, json ? 'json' : 'txt');
  const ok = saveText(json ? chronicleJson(state) : chronicleText(state), filename);
  return ok ? { ok: true, entries, filename } : { ok: false, reason: 'no browser download available' };
}

/** Console doors: `jma3Log()` for the text, `jma3LogJson()` for the raw entries. */
export function installChronicleConsole(scope = (typeof window !== 'undefined' ? window : null)) {
  if (!scope) return;
  scope.jma3Log = () => {
    const s = getState();
    return s ? chronicleText(s) : 'no game in progress';
  };
  scope.jma3LogJson = () => {
    const s = getState();
    return s ? chronicleJson(s) : 'null';
  };
  scope.jma3LogSave = (json = false) => downloadChronicle({ json });
}
