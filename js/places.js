/**
 * places.js — Google Places photo fetching.
 * Requires GOOGLE_PLACES_KEY from js/config.js.
 * Caches photo URLs in localStorage for 7 days.
 */

const PLACES_CACHE_KEY = 'solsteder_places_v1';
const PLACES_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

function _loadGoogleMapsScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps?.places) { resolve(); return; }
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_PLACES_KEY}&libraries=places`;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Google Maps script failed to load'));
    document.head.appendChild(s);
  });
}

function _fetchVenuePhotos(service, v) {
  return new Promise(resolve => {
    service.findPlaceFromQuery({
      query: `${v.name}${v.area ? ', ' + v.area : ''}, Oslo`,
      fields: ['place_id'],
      locationBias: new google.maps.LatLng(v.lat, v.lng),
    }, (results, status) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !results?.[0]) {
        resolve(null); return;
      }
      service.getDetails({
        placeId: results[0].place_id,
        fields: ['photos'],
      }, (place, detStatus) => {
        if (detStatus !== google.maps.places.PlacesServiceStatus.OK || !place?.photos?.length) {
          resolve(null); return;
        }
        resolve({
          placeId:   results[0].place_id,
          photoUrls: place.photos.slice(0, 6).map(p => p.getUrl({ maxWidth: 800 })),
        });
      });
    });
  });
}

async function initPlaces() {
  // Restore from cache first so photos appear immediately on repeat visits
  try {
    const raw = localStorage.getItem(PLACES_CACHE_KEY);
    if (raw) {
      const { ts, venues: cached } = JSON.parse(raw);
      if (Date.now() - ts < PLACES_CACHE_TTL) {
        VENUES.forEach(v => {
          const c = cached[v.id];
          if (c) { v.placeId = c.placeId; v.photoUrls = c.photoUrls; }
        });
        if (typeof updateDetailPanel === 'function') updateDetailPanel();
        console.log('Places: restored from cache');
        return;
      }
    }
  } catch (_) {}

  try {
    await _loadGoogleMapsScript();
  } catch (err) {
    console.warn('Places: Google Maps JS unavailable —', err.message);
    return;
  }

  // PlacesService requires a DOM element to render attributions into
  const attrEl = document.createElement('div');
  document.body.appendChild(attrEl);
  const service = new google.maps.places.PlacesService(attrEl);

  const cacheData = {};
  await Promise.all(VENUES.map(async v => {
    const result = await _fetchVenuePhotos(service, v);
    if (!result) return;
    v.placeId   = result.placeId;
    v.photoUrls = result.photoUrls;
    cacheData[v.id] = result;
  }));

  try {
    localStorage.setItem(PLACES_CACHE_KEY, JSON.stringify({ ts: Date.now(), venues: cacheData }));
  } catch (_) {}

  const n = VENUES.filter(v => v.photoUrls?.length).length;
  console.log(`Places: loaded photos for ${n}/${VENUES.length} venues`);
  if (typeof updateDetailPanel === 'function') updateDetailPanel();
}
