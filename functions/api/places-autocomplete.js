// Cloudflare Pages Function: /api/places-autocomplete
// Proxies Google Places Autocomplete (New) API
// Usage: /api/places-autocomplete?q=hummus+and+wine&sw=59.8,10.5&ne=60.1,10.95

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

    // Build location restriction from client-supplied viewport bounds
    const sw = url.searchParams.get('sw');
    const ne = url.searchParams.get('ne');
    let locationRestriction;
    if (sw && ne) {
      const [swLat, swLng] = sw.split(',').map(Number);
      const [neLat, neLng] = ne.split(',').map(Number);
      if ([swLat, swLng, neLat, neLng].every(n => Number.isFinite(n))) {
        locationRestriction = {
          rectangle: {
            low:  { latitude: swLat, longitude: swLng },
            high: { latitude: neLat, longitude: neLng },
          },
        };
      }
    }

    const body = {
      input: query,
      includedPrimaryTypes: ['restaurant', 'bar', 'cafe', 'pub', 'food_court'],
    };
    if (locationRestriction) body.locationRestriction = locationRestriction;

    const resp = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();

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
