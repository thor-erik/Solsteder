// Cloudflare Pages Function: /api/place-details
// Fetches details for a single place by ID via Google Places API (New)
// Usage: /api/place-details?id=ChIJ...

export async function onRequest(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const placeId = url.searchParams.get('id');

    if (!placeId) {
      return new Response(
        JSON.stringify({ error: 'Missing query parameter: id' }),
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

    const resp = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key':   apiKey,
        'X-Goog-FieldMask': 'displayName,formattedAddress,location,photos,types',
      },
    });

    const data = await resp.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), {
        status: data.error.code || 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build photo URLs (Google Places photo references)
    // Return photo references as proxied URLs (key stays server-side)
    const photos = (data.photos || []).slice(0, 3).map(p => {
      return `/api/place-photo?ref=${encodeURIComponent(p.name)}`;
    });

    const result = {
      name:    data.displayName?.text || '',
      address: data.formattedAddress || '',
      lat:     data.location?.latitude || 0,
      lng:     data.location?.longitude || 0,
      photos,
      types:   data.types || [],
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[place-details] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
