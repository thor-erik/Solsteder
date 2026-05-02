// Cloudflare Pages Function: GET /s/<id>
//
// Looks up the short ID in KV, then serves the SAME response as /i/<token>
// (OG meta tags + meta-refresh bounce to the SPA). We proxy to /i/<token>
// rather than redirecting because some preview crawlers (notably iMessage)
// don't follow redirects when fetching for OG tags — proxying keeps the
// short URL itself canonical for sharing while reusing the existing OG
// renderer.

export async function onRequest(context) {
  const { request, env, params } = context;
  const id = params && params.id;
  if (!id || !env.SHORTLINKS) {
    return new Response('Not found', { status: 404 });
  }
  const token = await env.SHORTLINKS.get(id);
  if (!token) {
    return new Response('Not found', { status: 404 });
  }
  // Proxy to the canonical /i/<token> handler so OG meta tags render
  // identically for crawlers and the SPA bounce works.
  const url = new URL(request.url);
  url.pathname = `/i/${token}`;
  return fetch(url.toString(), {
    method: 'GET',
    headers: request.headers,
  });
}
