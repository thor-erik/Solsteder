if (USE_FLOATING_TIME_SLIDER) document.body.classList.add('fts');

loadVenues().then(async () => {
  _buildAreaIndex();  // build area search index immediately (before slow initFacings)
  updateRangeFill();
  update();
  if (USE_FLOATING_TIME_SLIDER) initFts();
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

  // Dev-only: ?ppdemo=1 opens the accept page with mock invite data so the
  // auth-gated accept→confirm slide is verifiable on a (logged-out) preview.
  if (/[?&]ppdemo=1\b/.test(location.search) && typeof openPlanPreview === 'function' && VENUES.length) {
    window._ppDemo = true;
    // Seed a pending friend prompt so the confirm pane leads with the
    // "Add Anna" card (leftmost = primary), before Share onward. The
    // 'test-' prefix makes _commitFriendRequest a no-op (no DB write) so
    // the slide-out + leader-promotion UX runs without a real friendship.
    window._pendingFriendPrompt = { inviterId: 'test-ppdemo', inviterName: 'Anna' };
    const dv = VENUES.find(v => /hanami/i.test(v.name)) || VENUES[0];
    const when = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    setTimeout(() => openPlanPreview({ venueId: dv.id, plannedAt: when, inviteId: 'ppdemo', inviterId: 'ppdemo', inviterName: 'Anna', mode: 'invite' }), 700);
  }
}).catch(e => {
  console.error('loadVenues chain error:', e);
  // Ensure intro proceeds even if initialization throws
  _introDataReady = true;
  _introGeoReady  = true;
  _introCheckReady();
});
