// Cloudflare Pages Function: /api/places-autocomplete
// Proxies Google Places Autocomplete (New) API
// Usage: /api/places-autocomplete?q=hummus+and+wine

export async function onRequest(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');

    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Missing query parameter: q' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = env.GOOGLE_PLACES_SERVER_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API key not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const resp = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   apiKey,
      },
      body: JSON.stringify({
        input: query,
        locationRestriction: {
          rectangle: {
            low:  { latitude: 59.80, longitude: 10.50 },
            high: { latitude: 60.05, longitude: 10.95 },
          },
        },
        includedPrimaryTypes: ['restaurant', 'bar', 'cafe', 'pub', 'food_court'],
        languageCode: 'no',
      }),
    });

    const data = await resp.json();

    // Simplify response — extract what the frontend needs
    const suggestions = (data.suggestions || [])
      .filter(s => s.placePrediction)
      .map(s => {
        const p = s.placePrediction;
        return {
          placeId:   p.placeId,
          name:      p.structuredFormat?.mainText?.text || p.text?.text || '',
          secondary: p.structuredFormat?.secondaryText?.text || '',
        };
      });

    return new Response(JSON.stringify({ suggestions }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[places-autocomplete] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
