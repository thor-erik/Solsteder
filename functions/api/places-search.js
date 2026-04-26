// Cloudflare Pages Function: /api/places-search
// Proxies Google Places Text Search API to bypass CORS restrictions
// Usage: /api/places-search?q=hummus+and+wine

export async function onRequest(context) {
  const { request, env } = context;

  try {
    // Parse query parameter
    const url = new URL(request.url);
    const query = url.searchParams.get('q');

    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Missing query parameter: q' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = env.GOOGLE_PLACES_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API key not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Call Google Places API server-side (no CORS issues)
    const searchQuery = `${query} Oslo`;
    const placesUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    placesUrl.searchParams.set('query', searchQuery);
    placesUrl.searchParams.set('location', '59.9139,10.7522');
    placesUrl.searchParams.set('radius', '20000');
    placesUrl.searchParams.set('key', apiKey);

    const response = await fetch(placesUrl.toString(), {
      headers: { 'Referer': 'https://findshades.app/' },
    });
    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[places-search] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
