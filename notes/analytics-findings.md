# Shades — Analytics & Business Findings

> Working notes. Living document — append as we learn more.
> Legend: 📊 **measured** (live data / source-backed) · 🔧 **assumption** (modelling input, flex it) · ⚠️ **risk/flag**

**Last updated:** 2026-05-21
**Project age:** Supabase project created 2026-04-14; analytics first event 2026-04-27.
**Stage:** Pre-launch. 10 registered users, 2 MAU(30d), 3 push devices.

---

## 1. Monthly run-rate (current, pre-launch)

📊 Supabase org `Shades Inc.` is on the **Pro plan** ($25/mo flat). Single project `Shades` (ref `wxalqodaeqgzahwlovnw`), region eu-west-1.

| Line item | Cost/mo | Basis |
|---|---:|---|
| Supabase Pro | **$25.00** | Flat. Deep inside every quota (42 MB of 8 GB DB, 2 of 100k MAU, 1 edge fn). |
| Apple Developer Program | **$8.25** | $99/yr amortized. |
| Domain (`findshades.app`) | **~$1.50** | ~$15–18/yr `.app`. |
| Google Cloud — data pipeline | **variable** (~$15–30/mo steady-state) | Scheduled crons; see §3. |
| Google — runtime (search) | **~$0** | Search-gated, see §3. |
| Mapbox GL JS | **$0** | Free <50k web map loads/mo. |
| Cloudflare Pages + Functions | **$0** | Free: 100k Function invocations/**day**. |
| met.no / yr.no weather | **$0** | Free (non-abusive use; revisit TOS at commercial scale). |
| Google Play | **~$0** | $25 one-time, paid. |

**Fixed run-rate ≈ $35/mo + Google pipeline (~$15–30).**

---

## 2. The `events` analytics table 📊

Live query (24.5-day span, 2026-04-27 → 05-21):

| Metric | Value |
|---|---|
| Rows | 55,349 → **2,262/day** |
| Size | 28 MB total (20 MB heap + 8 MB idx) → **534 B/row** |
| Sessions (`session_start`) | 1,892 → **~29 events/session** |

**Event mix (top):** `venue_impression` 28% · `time_change` 23% · `notification_shown`+`dismiss` 26% combined · `map_move` 8% · `session_start` 3% · `detail_open` 3%.
→ **~57% of rows are passive telemetry** (impressions / slider drags / notif show-dismiss / map moves), not user intent.

⚠️ **`events` has NO TTL.** `notifications` is pruned at 30 days (sql/031); `events` grows forever. This is the only unbounded-growth object in the system.

🔧 The reusable scaling unit is **29 events/session @ 534 B/row** — NOT the misleading "5,500 events/user" (that figure was dev/test traffic: 2 real MAU producing 1,892 synthetic sessions).

**Recommended actions:**
- Add a retention cron (e.g. delete `events` older than 90 days).
- Sample the passive events (`venue_impression`, `map_move`, `time_change`) — would cut row volume ~65% with no analytical loss.

---

## 3. Google Cloud spend 📊 + 🔧

📊 **Cumulative GCP spend to date: ~900 NOK (~$80 USD)** over ~5 weeks (per user, 2026-05-21).

**Key architectural finding:** the detail panel does **NOT** call Google on open. `/api/place-details` + `/api/place-photo` (Cloudflare Pages Functions) are invoked **only from the search flow** (app.js:6398 — when a user picks an off-dataset autocomplete result). The 542 catalogue venues render from `venues.json` with no live Google call.
→ Runtime Google scales with **searches** (📊 only 45 `search` events in 24.5d ≈ 2/day), so it stays tiny even at scale.

**Therefore the 900 NOK is almost entirely one-time bootstrap** (initial 542-venue discovery via Text Search @ ~$32/1k, photo fetch, seating-detection backfill, repeated dev re-runs) — not steady-state.

Steady-state recurring Google = scheduled crons against a **fixed 542-venue catalogue** (scales with catalogue size, not users):

| Cron (GitHub Actions) | Cadence | Driver | Est. recurring |
|---|---|---|---|
| `refresh-opening-hours` | weekly + seasonal | ~542 Place Details/wk | biggest item |
| `detect-seating-areas` | weekly (Sun) | new/uncached venues only | small post-backfill |
| `discover-venues` | monthly | handful of Text Searches | ~$1–2 |
| `fetch-photos` | on-demand | new venues only | small |

The 900 NOK / 5 wk **caps** total recurring at ~$73/mo even if 100% were recurring (it isn't). Realistic: **~$15–30/mo**.

🔧 **TODO:** read the **current-month** figure in GCP billing (not cumulative) to nail the true recurring number.

⚠️ Approx Google Places (New) SKU rates used in modelling (confirm against billing): Text Search ~$32/1k · Place Details (Pro fields, incl. hours/photos) ~$17/1k · Place Photos ~$7/1k · Autocomplete/request ~$2.83/1k. Post-March-2025 per-SKU free monthly allowances apply.

---

## 4. Cost at scale 🔧

Behavioural assumptions: **6 sessions/MAU/month**, 29 events/session, ~1.2 Mapbox loads/session, search ~0.024/session (observed).

| Line item | Launch (~250 MAU) | 1k MAU | 10k MAU |
|---|---:|---:|---:|
| Supabase Pro (base) | $25 | $25 | $25 |
| Apple Dev (amortized) | $8 | $8 | $8 |
| Domain | $2 | $2 | $2 |
| Google — data pipeline | ~$20 | ~$20 | ~$25 |
| Google — runtime (search) | ~$1 | ~$6 | ~$40 |
| Mapbox map loads | $0 | $0 | **~$110** |
| Supabase storage/egress | $0 | $0 | ~$25 |
| Cloudflare Functions | $0 | $0 | ~$5 |
| **Total / mo** | **~$56** | **~$61** | **~$240** |

**Reading the curve:**
- Launch → 1k MAU is **essentially flat (~$60/mo)**.
- First usage meter to bite: **Mapbox at ~42k sessions/mo** (~7k DAU-ish), then Supabase storage from the unpruned `events` table.
- **No hidden $1k+/mo cliff** — the earlier worry about detail-panel Google calls was wrong.

---

## 5. Market sizing — Oslo 📊 + 🔧

### Source data 📊
| Input | Value | Source |
|---|---|---|
| Oslo municipality | 724,290 (Jan 2025) | SSB / Wikipedia |
| Greater Oslo / urban area | 1.95M / 1.11M | Wikipedia |
| Eat out socially ≥ monthly | 80% of Norwegians (higher: young, male, urban — esp. Oslo) | ResearchGate |
| Frequency | ~49 meals out/person/yr (~4/mo) | ResearchGate |
| Sunny days Oslo | ~80–100/yr, concentrated May–Jul; 37% of daylight hrs sunny | Weather-and-Climate |
| Smartphone penetration | 93% (internet 99%) | Statista / DataReportal |
| Age skew | pronounced 20–39 in-migration bulge, median ~37 | Wikipedia |

### Funnel (Oslo municipality core)
| Layer | Who | Size |
|---|---|---:|
| Population | Oslo municipality | 724,000 |
| Adults (18+) ~80% | | ~580,000 |
| × smartphone 93% | | ~540,000 |
| **TAM** | go out socially ≥ monthly (~80%) | **~430,000** |
| **SAM** | younger/social/sun-motivated, would use a sun-finder app (~30–40% of TAM) | **~130,000–170,000** |
| **SOM** | indie, organic, 3–5 yr (5–15% of SAM) | **~10,000–25,000 registered** |

### Sun-relevant demand (occasion math) 🔧
- ~48 outings/user/yr; **~10–25 sun-relevant outings/user/yr** (clustered May–Aug).
- Across TAM ≈ **~5–8M sun-relevant outing-occasions/yr in Oslo**.

### ⚠️ Dominant factor: seasonality
**~5-month product** (May–Aug strong, Apr/Sep marginal, Dec–Feb near-dead). MAU is a **seasonal wave, ~5–10× peak-to-trough**. Launched May 2026 = correct timing.

---

## 6. Growth curve 🔧 (organic, indie, no paid acquisition)

reg = cumulative registered · peak MAU = busiest summer month · winter trough ≈ 5–10× lower.

| | Conservative | **Realistic** | Optimistic |
|---|---:|---:|---:|
| End 2026 (partial 1st season) | 800 / 300 | **1,500 / 600** | 4,000 / 1,500 |
| 2027 peak | 3,000 / 1,200 | **7,000 / 3,000** | 18,000 / 8,000 |
| 2028 peak | 8,000 / 3,000 | **18,000 / 7,000** | 45,000 / 20,000 |
| Mature (~2029–30) | 15,000 / 5,000 | **30,000 / 12,000** | 80,000 / 35,000 |

**Cost tie-in:** realistic mature peak ~7–12k MAU → free-tier most of the year (~$60/mo), **only Jul–Aug** nudges infra toward ~$200–250/mo, then falls back. Cost breathes with the season.

---

## 7. Market expansion assessment 📊 + 🔧

**Updated:** 2026-05-21.

### Core insight: the moat IS latitude
The shadow-computation differentiator only matters where the sun sits low enough for buildings to cast terrace-killing shadows. At Oslo's ~60°N (summer sun maxes ~53° altitude) this is a real, hard problem. At Mediterranean latitudes the summer sun is near-overhead → shadows short → sun-finding trivial, and demand inverts to **shade-finding**. ⇒ Expand along the latitude band, not radially.

### Code coupling audit (the real "easy expand" cost) 📊
| Coupling | Where | Cost |
|---|---|---|
| Solar math | `solar.js:7,33` (`OSLO_LAT`, hardcoded lng in solar-noon) | trivial — already lat/lng-parametric |
| Map/intro center | `app.js:116,1545` | trivial config |
| Places search | `places-search.js:32` (coords + appends " Oslo") | trivial config |
| Geocode bbox | `app.js:5941` (`'10.4,59.75,11.0,60.1'`) | trivial config |
| Area filters | `_areaIndex` — **data-derived from venues** | free ✅ |
| **Timezone** | SQL triggers hardcode `Europe/Oslo` (sql/026,027,033…) | **free for CET cities**; tz param needed for EET/GMT |
| Language | i18n `en`/`no` only | per-market translation |

**Key finding:** every easy target except Helsinki is **CET (UTC+1) = same wall-clock as `Europe/Oslo`** → Stockholm/Copenhagen/Gothenburg/Malmö/Berlin/Amsterdam need **zero backend tz change**. The real one-time cost is the **multi-city architecture** (city-config object, catalogue partitioning, city detection/selector), not de-Oslo-ing constants.

### Fit scoring (Tech-fit = latitude/shadow value; Friction 5 = easiest)
| City | Lat | Tech-fit | Culture | Friction | Market | Verdict |
|---|---|:--:|:--:|:--:|---|---|
| **Stockholm** | 59.3°N | 5 | 5 | 5 (CET, sv≈no) | 2.4M metro | ⭐ best first move |
| **Copenhagen** | 55.7°N | 4 | 5 | 5 (CET, da≈no) | 1.4M | ⭐ strong |
| Gothenburg+Malmö | 57–55°N | 4 | 4 | 5 (CET, sv) | ~1M | bolt-on |
| Helsinki | 60.2°N | 5 | 4 | 3 (EET, fi) | 1.5M | great fit, tz+lang work |
| Amsterdam | 52.4°N | 3 | 5 | 4 (CET, EN-ok) | 1.4M | strong, lower lat |
| Berlin/Hamburg | 52.5°N | 3 | 4 | 3 (CET, de) | 3.7M/1.8M | big, more localization |
| Edinburgh/Glasgow | 55.9°N | 4 | 3 | 3 (GMT, **EN**) | ~1.3M | English unlocks rollout |
| Reykjavík | 64°N | 2 | 5 (tiny/windy/low-rise) | 2 (GMT) | 244k | marginal |
| Domestic (Bergen/Trondheim/Stavanger/Tromsø) | 60–70°N | 4–5 | 5 | **5 (same everything)** | small | "free" validation |

### Recommended sequence 🔧
1. **Build multi-city refactor once** (city-config + catalogue partition + detection). The unlock.
2. **Validate domestically** (Bergen/Trondheim/**Tromsø**) — near-zero eng, pipeline only. Tromsø (69.6°N) = purest product demo.
3. **Scandinavian CET cluster: Stockholm → Copenhagen → Gothenburg/Malmö.** Lowest-friction large market on earth for this product (no tz work, sv/da cheap given no strings).
4. **Amsterdam / Berlin** (CET, bigger language lift).
5. **Helsinki + Baltics** after one tz-parametrization pass unlocks all EET.

### Two strategic flags ⚠️💡
- ⚠️ **A Nordic cluster does NOT fix seasonality (§5/§6).** All these cities go dark the same months → multiplies the same summer-only MAU wave, doesn't smooth it. True counter-seasonal smoothing needs Southern Hemisphere (Melbourne, Cape Town) — far off.
- 💡 **Shade-finder inversion.** Identical shadow engine answers "which terrace is in **shade** now" for hot summers (Madrid, Barcelona, Rome, Athens). Low latitude makes sun-finding pointless but shade-finding valuable — and the **"Shades" brand already means shadow.** A re-positioning, not a free expansion, but the only direction that breaks the latitude band.

### Expansion enablers (data) 📊
- Weather: **met.no / yr.no `locationforecast` is global** → no change needed for any city.
- Mapbox + Google Places: global.
- OSM building footprints (geometry pipeline dependency): near-complete across all Nordic + NW-European target cities.
⇒ Data is **not** the binding constraint for dense European cities; multi-city architecture + localization are.

---

## 8. Open questions / next steps

- [ ] Pull **current-month** GCP cost to confirm recurring Google figure (§3).
- [ ] Write `events` retention + sampling migration (§2).
- [ ] Model **Greater-Oslo (1.9M)** catchment as upside (~2.7× funnel).
- [ ] Sketch a **winter use-case** to flatten the seasonal MAU wave.
- [ ] Tourist audience (Oslo summer visitors) — unmodeled bonus, perfect product fit.
- [ ] Scope the **multi-city refactor** (city-config + catalogue partition + detection) — the expansion unlock (§7).
- [ ] Size the **Stockholm** market with the §5 funnel methodology (first expansion target).
- [ ] Decide whether the **shade-finder inversion** is a future product bet (§7).

## Sources
- [Oslo population (Wikipedia)](https://en.wikipedia.org/wiki/Oslo)
- [Greater Oslo Region (Wikipedia)](https://en.wikipedia.org/wiki/Greater_Oslo_Region)
- [Eating Out in Norway (ResearchGate)](https://www.researchgate.net/publication/233717762_Eating_Out_A_Multifaceted_Activity_in_Contemporary_Norway)
- [Oslo sunshine/climate (Weather-and-Climate)](https://weather-and-climate.com/average-monthly-hours-Sunshine,Oslo,Norway)
- [Norway smartphone penetration (Statista)](https://www.statista.com/statistics/568207/predicted-smartphone-user-penetration-rate-in-norway/)
- [Digital 2025: Norway (DataReportal)](https://datareportal.com/reports/digital-2025-norway)
- [Demographics of Oslo (Wikipedia)](https://en.wikipedia.org/wiki/Demographics_of_Oslo)
