/**
 * worker.js — Web Worker for solar window computation.
 *
 * Receives a pre-built sun table + slim venue list from the main thread.
 * Returns computed sun windows for all venues.
 * Runs off the main thread so heavy computation never blocks the UI.
 *
 * Protocol:
 *   main → worker:  { type:'compute', venues, sunTableBuffer:ArrayBuffer, dateStr }
 *   worker → main:  { type:'result',  dateStr, result: { [venueId]: {windows,open,close} } }
 */

importScripts('solar.js');

self.onmessage = function(e) {
  const { type, venues, sunTableBuffer, dateStr } = e.data;
  if (type !== 'compute') return;

  const table  = new Float64Array(sunTableBuffer);
  const result = {};

  for (const v of venues) {
    result[v.id] = computeSunWindowsFromTable(v, table);
  }

  self.postMessage({ type: 'result', dateStr, result });
};
