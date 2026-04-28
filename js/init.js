if (USE_FLOATING_TIME_SLIDER) document.body.classList.add('fts');

loadVenues().then(async () => {
  _buildAreaIndex();  // build area search index immediately (before slow initFacings)
  updateRangeFill();
  update();
  if (USE_FLOATING_TIME_SLIDER) initFts();
  initDpTimeline();
  try { await initFacings(); } catch (e) { console.error('initFacings error:', e); }
  if (!_introDataReady) { _introDataReady = true; _introCheckReady(); }
  const _wxLats = VENUES.map(v => v.lat), _wxLngs = VENUES.map(v => v.lng);
  const _wxLat  = (Math.min(..._wxLats) + Math.max(..._wxLats)) / 2;
  const _wxLng  = (Math.min(..._wxLngs) + Math.max(..._wxLngs)) / 2;
  initWeather(_wxLat, _wxLng); // fetch MET Norway forecast (async, re-renders when data arrives)
  initPlaces();      // fetch Google Places photos (async, cached 7 days)
  loadApprovedSuggestions(); // merge admin-approved user submissions into VENUES
  // Apply i18n to search placeholder on load
  const inp = document.getElementById('venue-search');
  if (inp) inp.placeholder = t('search_placeholder');
}).catch(e => {
  console.error('loadVenues chain error:', e);
  // Ensure intro proceeds even if initialization throws
  _introDataReady = true;
  _introGeoReady  = true;
  _introCheckReady();
});
