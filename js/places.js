/**
 * places.js — Loads venue photos from the pre-fetched static file.
 * data/venue-photos.json is generated once by: node scripts/fetch-photos.mjs
 * No API calls at runtime — zero cost.
 */

async function initPlaces() {
  try {
    const resp = await fetch('data/venue-photos.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const entries = await resp.json();

    const byId = {};
    for (const e of entries) byId[e.id] = e;

    VENUES.forEach(v => {
      const e = byId[v.id];
      if (e?.placeId)    v.placeId   = e.placeId;
      if (e?.photoUrls?.length) v.photoUrls = e.photoUrls;
    });

    const n = VENUES.filter(v => v.photoUrls?.length).length;
    console.log(`Places: loaded photos for ${n}/${VENUES.length} venues`);
    if (typeof updateDetailPanel === 'function') updateDetailPanel();
  } catch (err) {
    console.warn('Places: venue-photos.json unavailable —', err.message);
  }
}
