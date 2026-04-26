// Cloudflare Pages Function: /api/place-photo
// Proxies Google Places photo media to avoid exposing the API key
// Usage: /api/place-photo?ref=places/ChIJ.../photos/AUc...

export async function onRequest(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const ref = url.searchParams.get('ref');

    if (!ref) {
      return new Response('Missing ref parameter', { status: 400 });
    }

    const apiKey = env.GOOGLE_PLACES_SERVER_KEY;
    if (!apiKey) {
      return new Response('API key not configured', { status: 500 });
    }

    const photoUrl = `https://places.googleapis.com/v1/${ref}/media?maxWidthPx=600&key=${apiKey}`;
    const resp = await fetch(photoUrl, { redirect: 'follow' });

    if (!resp.ok) {
      return new Response('Photo not found', { status: 404 });
    }

    // Stream the image back with caching headers
    return new Response(resp.body, {
      status: 200,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400', // cache 24h
      },
    });
  } catch (error) {
    return new Response('Error fetching photo', { status: 500 });
  }
}
