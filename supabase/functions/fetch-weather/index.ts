// supabase/functions/fetch-weather/index.ts
//
// Pulls met.no's locationforecast for Oslo and upserts the hourly forecast
// into public.weather_oslo. Triggered by pg_cron every 30 minutes via the
// same X-Push-Secret header pattern as send-push (sql/037, sql/046).
//
// Why centralized: every client doing its own met.no fetch is wasteful and
// risks tripping their fair-use policy. One server fetch every 30 min,
// consumed by sql/047 process_sun_alerts + (eventually) a /api/weather
// Cloudflare proxy for the client.
//
// ── Deploy ──────────────────────────────────────────────────────────────────
//   supabase functions deploy fetch-weather --no-verify-jwt
//
// Required secrets (set manually):
//   PUSH_TRIGGER_SECRET     — matches _app_settings WHERE key='send_push_secret'
//                             (same secret as send-push; reused so we don't
//                             multiply trigger secrets)
//
// Required env (auto-injected by Supabase):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OSLO_LAT = 59.9139;
const OSLO_LON = 10.7522;
const MET_URL = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${OSLO_LAT}&lon=${OSLO_LON}`;

interface MetSeriesEntry {
  time: string;
  data: {
    instant?: {
      details?: {
        air_temperature?: number;
        cloud_area_fraction?: number;
      };
    };
    next_1_hours?: {
      summary?: { symbol_code?: string };
      details?: { precipitation_amount?: number };
    };
  };
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Constant-time gate against the shared trigger secret.
  const expected = Deno.env.get("PUSH_TRIGGER_SECRET");
  const supplied = req.headers.get("X-Push-Secret") ?? "";
  if (!expected || !constantTimeEq(expected, supplied)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Fetch met.no — they require a User-Agent identifying the app.
  let met;
  try {
    const resp = await fetch(MET_URL, {
      headers: { "User-Agent": "Shades (https://findshades.app)" },
    });
    if (!resp.ok) {
      return new Response(`met.no HTTP ${resp.status}`, { status: 502 });
    }
    met = await resp.json();
  } catch (e) {
    return new Response(`met.no fetch failed: ${e.message}`, { status: 502 });
  }

  const series: MetSeriesEntry[] = met?.properties?.timeseries ?? [];
  if (!series.length) {
    return new Response("met.no returned empty timeseries", { status: 502 });
  }

  // Build hour-bucketed rows from the first 72 hours of forecast — that
  // covers the visible alert horizon (today + couple days). Beyond 72h
  // resolution drops below hourly anyway.
  const cutoff = Date.now() + 72 * 3600 * 1000;
  const rows = [];
  for (const entry of series) {
    const t = new Date(entry.time).getTime();
    if (t > cutoff) break;
    const cloud = entry.data.instant?.details?.cloud_area_fraction;
    const precip = entry.data.next_1_hours?.details?.precipitation_amount;
    const symbol = entry.data.next_1_hours?.summary?.symbol_code;
    rows.push({
      forecast_for: entry.time,
      cloud_pct:    typeof cloud  === "number" ? cloud  : null,
      precip_mm:    typeof precip === "number" ? precip : null,
      symbol_code:  symbol ?? null,
      fetched_at:   new Date().toISOString(),
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { error: upErr } = await supabase
    .from("weather_oslo")
    .upsert(rows, { onConflict: "forecast_for" });
  if (upErr) {
    return new Response(`upsert failed: ${upErr.message}`, { status: 500 });
  }

  // TTL purge: anything older than 6h is stale (we've moved past the
  // forecast horizon for sun-alert lookups; keeping it around just bloats
  // the table). Idempotent.
  const purgeBefore = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  await supabase.from("weather_oslo").delete().lt("forecast_for", purgeBefore);

  return new Response(JSON.stringify({ upserted: rows.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
