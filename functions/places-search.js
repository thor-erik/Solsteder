// Cloudflare Pages Function: proxy Google Places Text Search API
// Allows browser to search venues without CORS issues

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    const query = url.searchParams.get('q');

    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Missing query parameter: q' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get API key from environment
    const GOOGLE_PLACES_KEY = context.env.GOOGLE_PLACES_KEY;
    if (!GOOGLE_PLACES_KEY) {
      return new Response(
        JSON.stringify({ error: 'API key not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Call Google Places API server-side (no CORS issues)
    const searchQuery = `${query} Oslo`;
    const placesUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${encodeURIComponent(searchQuery)}` +
      `&location=59.9139,10.7522&radius=20000` +
      `&key=${GOOGLE_PLACES_KEY}`;

    const response = await fetch(placesUrl);
    const data = await response.json();

    // Return results to frontend
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
