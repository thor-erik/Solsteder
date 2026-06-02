// Dynamic rendering for venue pages (/steder/<slug>).
//
// Goal: venues are INDEXED by Google, but a human never sees a static landing
// page — they go straight to the venue (native app if installed via Universal/
// App Links, otherwise the web app here).
//
//   - Crawlers / link-preview bots  -> serve the static SEO HTML (next()).
//   - Humans without the app        -> 302 into the web app focused on the
//                                       venue (/#<slug>-<id>), which the SPA
//                                       already routes to the detail panel.
//   - Installed-app users           -> never reach this; the OS intercepts the
//                                       link via Universal/App Links first.
//
// This is dynamic rendering (different response per user-agent). It's a known,
// tolerated pattern for JS apps as long as bot and human reach the SAME venue,
// which they do. The static HTML is the crawl surface + ultimate fallback.

const BOT_RE = /(googlebot|google-inspectiontool|bingbot|bingpreview|duckduckbot|slurp|baiduspider|yandex|sogou|exabot|applebot|petalbot|facebookexternalhit|facebot|twitterbot|linkedinbot|embedly|quora|pinterest|slackbot|telegrambot|whatsapp|discordbot|ia_archiver|semrushbot|ahrefsbot|mj12bot|dotbot|crawler|spider)/i;

export async function onRequest(context) {
  const { request, params, next } = context;
  const slug = params.slug || '';

  // Direct asset hits (slug-map.json, *.html, etc.) -> serve as-is.
  if (slug.includes('.')) return next();

  const ua = request.headers.get('user-agent') || '';
  // Crawlers + link-preview bots -> static SEO HTML (keeps the venue indexed).
  if (BOT_RE.test(ua)) return next();

  // Humans -> resolve venue id, bounce into the web app on the venue.
  try {
    const map = await (await fetch(new URL('/steder/slug-map.json', request.url))).json();
    const id = map[slug];
    if (id != null) {
      const target = new URL('/', request.url);
      target.hash = `${slug}-${id}`;       // SPA reads #<slug>-<id> -> opens detail panel
      return Response.redirect(target.toString(), 302);
    }
  } catch (e) {
    // lookup failed -> fall through to the static page (safe fallback)
  }

  // Unknown slug / lookup failure -> serve the static page.
  return next();
}
