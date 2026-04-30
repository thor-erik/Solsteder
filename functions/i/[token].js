// Cloudflare Pages Function: /i/<base64token>
//
// Server-rendered Open Graph preview for invite links. Bots (Slack, iMessage,
// WhatsApp, Telegram, Discord) get a meta-tag-only HTML response so they can
// build a rich preview card. Real browsers get the same response with an
// instant client-side redirect to /#invite/<token>, where the SPA's existing
// hash handler takes over.

export async function onRequest(context) {
  const { request, params } = context;
  const token = (params && params.token) || '';
  const origin = new URL(request.url).origin;

  // Default fallback meta (used when the token can't be decoded)
  let venueName  = 'Solsteder';
  let venueArea  = '';
  let inviteHour = '';
  let ogImage    = `${origin}/shades-logo.png`;

  try {
    const payload = JSON.parse(_b64decode(token));
    const venueId = payload.v;
    const tStr    = String(payload.t || '');

    if (venueId != null) {
      // Pull venue + photo refs from bundled static assets
      const [venuesRes, photosRes] = await Promise.all([
        fetch(`${origin}/data/venues.json`).catch(() => null),
        fetch(`${origin}/data/venue-photos.json`).catch(() => null),
      ]);
      const venues = venuesRes && venuesRes.ok ? await venuesRes.json() : [];
      const photos = photosRes && photosRes.ok ? await photosRes.json() : [];
      const venue  = Array.isArray(venues) ? venues.find(v => String(v.id) === String(venueId)) : null;
      if (venue) {
        venueName = venue.name || venueName;
        venueArea = venue.area || '';
      }
      const ph = Array.isArray(photos) ? photos.find(p => String(p.id) === String(venueId)) : null;
      if (ph && Array.isArray(ph.photoRefs) && ph.photoRefs.length) {
        ogImage = `${origin}/api/place-photo?ref=${encodeURIComponent(ph.photoRefs[0])}`;
      }
    }
    // Pull HH:MM out of e.g. "2026-04-30T18:00"
    const hm = tStr.match(/T(\d{1,2}):(\d{2})/);
    if (hm) inviteHour = `${hm[1].padStart(2,'0')}:${hm[2]}`;
  } catch (e) {
    // Token malformed — render a generic preview that still bounces correctly
  }

  const ogTitle = inviteHour
    ? `${venueName} — kl. ${inviteHour} ☀️`
    : venueName;
  const ogDesc = venueArea
    ? `Sol-tips fra Shades · ${venueArea}`
    : 'Sol-tips fra Shades';

  const safeToken = encodeURIComponent(token);
  const html = `<!doctype html>
<html lang="no">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${_escape(ogTitle)}</title>
  <meta property="og:type" content="website">
  <meta property="og:title" content="${_escape(ogTitle)}">
  <meta property="og:description" content="${_escape(ogDesc)}">
  <meta property="og:image" content="${_escape(ogImage)}">
  <meta property="og:url" content="${origin}/i/${_escape(token)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${_escape(ogTitle)}">
  <meta name="twitter:description" content="${_escape(ogDesc)}">
  <meta name="twitter:image" content="${_escape(ogImage)}">
  <meta http-equiv="refresh" content="0; url=/#invite/${safeToken}">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #111E38; color: #FFF2EB; margin: 0; padding: 24px; text-align: center; }
    a { color: #FFAF85; }
  </style>
</head>
<body>
  <p>Åpner Shades…</p>
  <p><a href="/#invite/${safeToken}">Klikk her hvis appen ikke åpnes automatisk</a></p>
  <script>location.replace('/#invite/' + ${JSON.stringify(token)});</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300', // cache short — invite links are time-bound
    },
  });
}

function _b64decode(s) {
  // atob is available in Cloudflare Workers
  return atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
}

function _escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
