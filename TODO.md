<!--
  - [ ] å gjøre   - [x] ferdig   - [~] påbegynt   - [?] usikker
  ! prioritert     ~ lav prioritet
-->

## Under arbeid

## Backlog

### Fase 1 — Fiks eksisterende 109 venues
Mål: eksisterende venues representerer realiteten før vi skalerer.

- [x] Skriv `scripts/refresh-opening-hours.mjs`: OSM Overpass først (gratis), Google Places Contact-tier som fallback; lagrer full ukesplan i `openingHoursWeekly`; sjekker `CLOSED_PERMANENTLY` og skriver rapport
- [ ] Kjør `node scripts/refresh-opening-hours.mjs` og review `data/closed-venues-report.json`
- [ ] Fjern eventuelle stengte venues fra `venues.json`

### Fase 2 — Utvid Oslo-dekning
Mål: ~400–600 venues, hele Oslo kommune dekket.

- [x] Utvidet `fetch-venues-places.mjs`: 20 søkepunkter (alle bydeler), Places API v1 union-filter (`outdoorSeating: true` + keyword `uteservering`), lagrer `discoverySignal` per venue
- [ ] Kjør `node scripts/fetch-venues-places.mjs` og review `data/venues-fetched.json`
- [ ] Merge og kjør `update-geometry.mjs`
- [ ] Flagg venues uten bygningsgeometri i UI ("Soldata begrenset")

### Fase 4 — Brukerforslag i søkefeltet
Mål: sikkerhetsnett for venues automatikken ikke fanger.

- [x] Implementert: ingen treff + søkeord → "Suggest this venue →" knapp → Google Places-oppslag → bekreftelse → åpner GitHub Issue med forhåndsutfylt innhold

### Fase 3 — Automatisering (GitHub Actions)
Avhenger av at Fase 1 og 2 er stabile.

- [ ] Ukentlig jobb: OSM-sync av åpningstider for alle venues (gratis)
- [ ] Månedlig jobb: Google Places-refresh for venues uten OSM-data + `CLOSED_PERMANENTLY`-sjekk + ny discovery (field masking — kun be om felt vi bruker)
- [ ] Sesong-trigger 1. april + 1. september: full åpningstider-refresh + bilder-404-sjekk
- [ ] Automatisk diff: nye venues flagges som kandidater, stengte fjernes — ingen manuell review for endringer, kun for nye tillegg

### Fase 5 — Hele Norge
Avhenger av at Fase 3 er på plass.

- [ ] Bygg automatisk kvalitetsfilter for discovery (minimum rating, minimum antall anmeldelser) så manuell review ikke skalerer lineært
- [ ] Rull ut geografisk: Akershus først, deretter resten av Norge

---

### Visuelle feil
- [~] Hover-markøren over venues (etter solnedgang) er samme ikon som geolokasjons-ikonet — bytt til vanlig pointer
- [~] Ulik høyde på søkefelt og dato/tid-picker — juster slik at de er like høye
- [~] Venueliste og detaljpanel er ikke alignet i toppen på desktop

### Kart og detaljpanel
- [ ] Skyggescrubber-slider i kartruten over detail panel: lar brukeren skrubbe gjennom timer på dagen og se skyggene bevege seg i sanntid; vis klokkeslett-indikator; vurder om ruten trenger mer plass; lukking av panelet resetter til forrige valgte tidspunkt i kartet

### Dato/tid-picker
- [x] Del dato- og tid-picker i to separate pill-knapper side om side (Google Maps-stil, tilpasset vårt design); kalender-ikon i dato-picker, klokke-ikon i tid-picker; vis "Now" i tid-picker når nåværende tidspunkt er valgt
- [ ] Redesign tid-picker: erstatt solkurven med en temperaturkurve; gjør værforhold (overskyet, regn osv.) tydeligere og mer gradert; gjør scrubbing av tid mer intuitiv
- [ ] Dato-picker: legg til knapp for å ekspandere til full kalender; vis tydelig at værdata kun finnes 10 dager frem (etter det: bare sol/skygge-data)

### Funksjonalitet
- [ ] Støy-klassifisering via Mapbox veidata: bruk `map.queryRenderedFeatures()` mot Mapbox Streets v8 veiklasser for å estimere støysoner (rød/gul/ingen) basert på veitype + avstand. Erstatter fjernet Geonorge WFS-integrasjon (CORS-blokkert). Skalerbart — fungerer globalt uten ekstra API.
- [ ] Pins i nærheten av brukerens posisjon skal prioriteres / løftes i kartet
- [ ] Editor på mobil (og desktop): toolbar er for lang — komprimér; type uteservering flyttes til en dropdown/popover-liste
- [~] Gjennomgang av sol-estimeringslogikk for ulike typer uteserveringer — dokumentér hvordan det fungerer og vurder om det er presist nok
- [~] Typografi-gjennomgang: etablér konsistente regler for farge, uppercase/lowercase og skråskrift — særlig i venuelisten og øvrig UI
- [~] Områdenavn under venue-kort ("Sentrum", "Aker Brygge" osv.) er ofte feil — vurder kilde og forbedring (Google API?)

### Redaksjonelt / innhold
- [~] Vink-integrasjon: vis Vink-symbol på pins, i listen og i detaljpanel; lenke til Vink-artikkel; vurder Vink-filter og prioritering av omtalte venues
- [ ] Adgangsnivåer for venue-redigering:
  - Admin (du): full tilgang til å redigere og godkjenne direkte
  - Innloggede brukere: kan foreslå endringer, men ikke publisere — forslaget sendes til admin-kø
  - Admin-flyt: varsling ved nye forslag, enkel godkjenn/avvis-UI (e-post eller dashboard)
  - Vurder Supabase Row-Level Security + en enkel `pending_edits`-tabell som mellomlagring

### Infrastruktur / lansering
- [~] Lanseringsklarhet: kartlegg robusthet ved plutselig høy trafikk (f.eks. 17. mai); vurder auto-skalering av backend/Supabase
- [x] Oppdateringsstrategi: versjonerte filnavn (?v=...) + Service Worker med proper cache-policy + Cloudflare `_headers` (sw.js no-cache, /js/* immutable, /index.html no-cache). "Ny versjon tilgjengelig"-banner ikke implementert.

### App Store / Play Store-klargjøring
Mål: PWA-baseline klar for innlevering (PWABuilder eller Capacitor-wrapper).

- [ ] iOS oppstartsskjermer (apple-touch-startup-image PNG-er for alle aktuelle device-størrelser) — krever bildegenerering
- [ ] Regenerér ikon-pakke med maskable-trygg padding (Android adaptive icons klipper kanten på dagens logo)
- [ ] Personvernerklæring: komplett gjennomgang av tredjeparts datadeling (Supabase, Mapbox, Google Places, OSM/Overpass) + localStorage-disclosure
- [ ] Vilkår for bruk-side (eksisterer ikke ennå — kreves av App Store)
- [ ] Native deep-link: `apple-app-site-association` + `.well-known/assetlinks.json` — krever Apple Team ID + Android signing-cert SHA-256
- [ ] Forklaringsprompt før geolokasjon spørres første gang (App Store best practice, øker grant-rate)
- [ ] Lighthouse-audit: PWA, performance, accessibility, best-practices — kjør og fiks kritiske issues
- [ ] Beslutning: PWA-only (PWABuilder TWA på Play Store, iOS via "Add to Home Screen") vs Capacitor-wrapper (full native med APNs/FCM push). Påvirker offline-strategi + deep-link-implementering.
- [ ] App Store-metadata: skjermbilder (iPhone 6.7"/6.5", iPad 12.9"), beskrivelse, keywords, Apple privacy nutrition labels, age rating
- [ ] Migrér fra legacy SUPABASE_ANON_KEY til SUPABASE_PUBLISHABLE_KEY før Supabase deprekerer den gamle

### Eksisterende backlog
- [x] PWA-manifest — appen installerbar; manifest utvidet med id/scope/shortcuts/screenshots/maskable icons + iOS PWA-meta-tags i `index.html` + service worker offline-shell
- [~] Analytics — legg til Umami eller tilsvarende for å forstå brukeradferd
- [~] Poler login-gate — forbedre design på innloggingsprompt i detaljpanelet
- [~] Supabase custom auth-domene — vis findshades.app i Google-innloggingsdialog (krever Supabase Pro)
- [~] Venue-eier login — eget dashboard der venues kan redigere sin profil og se statistikk

### Fullført
- [x] Fjern "loading geometry"-melding fra UI
- [x] Profil-popover: sett samme bredde som dato/tid-pickeren
- [x] Flytt "sun set showing tomorrow"-melding — fjern den fra animasjonsskjermen og vis den i stedet under dato/tid-pickeren når den fader inn
- [x] Når solen er nede og vi hopper til i morgen, bruk kl. 12:00 som standardtid fremfor å kopiere gjeldende klokkeslett
- [x] Splash/PWA-oppstart: viser først logo uten tekst, deretter logo med "Shades" — vis kun logo med tekst fra start
- [x] Gul outline på pins og gul tekst i tidbobler — feil farge fikset til riktig designtoken
- [x] "Locate me"-knapp på rad med navigasjonsknappene
- [x] "Locate me"-knappen skjules av venuelisten når den ekspanderes
- [x] Venuelisten på desktop fader inn fremfor å animere fra bunnen
- [x] Detaljpanel på mobil redusert til 69svh — mer kart synlig
- [x] Map fly-over til venue ved tap på mobil — sentrerer i synlig kartområde over panelet
- [x] Lukke detaljpanel på mobil: panelet følger drag-bevegelsen; mer luft mellom bilder og drag-ikon; X-knapp lagt til
- [x] Swipe-følsomhet på venuelisten: trigger-sone låser scroll tidlig; liste og panel slåss ikke lenger
- [x] Pin-klikk og liste-klikk deler felles fly-over/pan/zoom-logikk; X/swipe resetter kameratilstand
- [x] Pan/zoom i mini-kart beholdes ved lukking av panel; tilt resettes til standard
- [x] "<Venues"-knappen swiper ned panelet og åpner venuelisten ekspandert
- [x] Vind-partikelanimasjon i bygningsruten over detail panel implementert

### Sosial-stack (mai 2026)
- [x] Supabase social-schema migrert til prod: 8 tabeller (`favorites`, `sun_alerts`, `user_preferences`, `friendships`, `checkins`, `plans`, `plan_invites`, `push_subscriptions`) + RLS-policies + `profiles.avatar_url`-kolonne + auto-create trigger på `auth.users` insert
- [x] Realtime-subscriptions for `plan_invites` + `friendships` (instant accept/decline/friend-request) — 60 s social-poll beholdt som fallback
- [x] Vennsystem: explicit-only friending (auto-friend ved aksept fjernet), `_handleFriendPromptAdd` med 3 s undo, fjern-venn med bekreftelse, avvis-venneforespørsel
- [x] "Add friend"-flyt på post-accept med commit-animasjon + glide-out
- [x] Cold-link welcome-card for `#friend/<id>` for anonyme besøkende ("X vil bli vennen din på Shades")
- [x] Aktivitetsinnboks i profil-panel: ventende invitasjoner + venneforespørsler + nylige svar på egne planer
- [x] Friends-pin på detail-page (canvas-rendering av aksept + decline med strikethrough på avslag)
- [x] Avatar-badge på søkebar-avatar når noe venter (forespørsler eller ventende invitasjoner)
- [x] Profile-sync: speil `auth.users.user_metadata.{name, avatar_url}` til `profiles`-tabell på hver auth-load
- [x] "Logget inn med Apple" istedenfor opaque `@privaterelay.appleid.com`-email
- [x] Notifikasjon når en venn aksepterer/avslår invitasjon (toast med navn + venue, navigerer til detail-page)
- [x] Vedvarende notifikasjon for venneforespørsler (re-fyrer på ny session, inline Accept-knapp)
- [x] Web push-pipeline LIVE i prod: VAPID-nøkler + `js/push.js` klient + `sw.js` service worker + `send-push` Supabase edge function + DB-triggers på `plan_invites` + `friendships`. Push-toggle i profil-panel. iOS krever 16.4+ og add-to-home-screen.
- [x] iOS PWA install: home-screen rendrer fullscreen (apple-mobile-web-app-capable + status-bar-style + title)
- [x] Service worker offline app-shell: pre-cache + network-first HTML + SWR for `data/*.json`
- [x] Cloudflare `_headers` cache-policy: sw.js no-cache, /js/* immutable, /index.html no-cache
- [x] Sun-table cache fix: `_findFirstSunDayAndHour` bygger fresh sun-tabell for fremtidige datoer (gjorde at close-on-confirm aldri navigerte forbi i dag)
- [x] Weather-aware next-sun-scan: bruker `qualifyingWindows` med vær-gate så scan hopper over overskyede dager
- [x] Søk-tilføyde venues (`Hummus & Wine`): terrace test-points filtreres mot adjacent buildings så de ikke alltid markeres som skyggelagte
- [x] Calendar ICS download: iOS Safari = data-URI via window.location, iOS Chrome / desktop = blob+download med riktig filnavn
- [x] Vennelenke (`#friend/<id>`): auto-accept friendship på klikk (begge parter har samtykket via lenke-deling), toast "Du og {name} er nå venner"
- [x] Notifikasjon-gating: `post-accept-active` body-class hindrer queue-notifikasjoner fra å lekke gjennom confirmation-panelet
- [x] Auto-hide scrubber på plan-preview 2,5 s etter siste drag (unngår "har jeg valgt ny tid?"-forvirring)
- [x] Profile RLS: public SELECT-policy + column-grant så anon kan lese `id` + `name` (men ikke email) — lar logget-ut invite-link-besøker se "Anna inviterte deg"
- [x] CLAUDE.md dokumenterer backend-tabeller, realtime-config, push-pipeline (key-rotation, iOS caveat, edge-function URL)

## Ideer

- [~] Push-varsler: sol-anbefalinger basert på posisjon (push-pipeline LIVE; trigger-logikken gjenstår)
  - Når solen snart går ned på stedet brukeren befinner seg, send varsel med nærmeste alternativer som fortsatt har sol
  - Infrastruktur klar: VAPID-nøkler + `js/push.js` + `sw.js` + `send-push` edge function + `push_subscriptions`-tabell — alt LIVE i prod (mai 2026)
  - Gjenstår: trigger-funksjon som krysser brukerposisjon (frivillig opt-in for bakgrunnstracking) mot sun-windows + sender push når en venue brukeren er nær går ut av sol
  - Brukerforklaring: vis tydelig *hvorfor* vi trenger bakgrunnsposisjon og hva som trigger en varsel
  - Geolokasjon-strategi: vurder å kun tracke posisjon mens solen er oppe lokalt
- [x] Push-varsler for invitasjons-akseptanse (Phase 4 av invite-flyten) — LIVE i prod (mai 2026). Database-trigger på `plan_invites` status-endring → `send-push` edge function → web push til alle inviterens devices. Dedup via `solsteder_seen_invite_responses`. Tilsvarende trigger på `friendships` for venneforespørsler. Inline Accept-knapp i venneforespørsel-toast for ett-tap-godta.
- [ ] Plan-preview internasjonal håndtering: når brukeren er langt fra `VENUE_CLUSTER.center` (f.eks. utenfor Norge), vis en mild prompt "Solsteder dekker bare Oslo i dag — meld interesse for ditt område" med e-post-fangst. Krever ny `interest_signups`-tabell. Avhenger av eksisterende `_isFarFromCluster()` (app.js:1296). Out of scope for v1 av invite-flyten.
- [~] Favoritter synket på tvers av enheter (krever backend/Supabase)
- [?] 7-dagers sol-prognose (pro-funksjon)
- [?] Intro-sekvens: hopp over for tilbakevendende brukere via localStorage (én gang per sesjon e.l.) — avgjøres når vi har nok brukere til å si at animasjonen er kjent
- [ ] Smart auto-shift av møtetid på accept-page: når en mottaker velger en ankomsttid som avviker betydelig (f.eks. >1t) fra `planned_at`, OG ingen andre har akseptert ennå, oppdater planens `planned_at` automatisk til den nye tiden og varsle inviteren ("{name} flyttet møtet til {time}"). Bredere "foreslå annen dag/tid"-flyt kan bygges på toppen som en tredje knapp ved siden av Aksepter/Avslå med backend-skriving til en `proposed_at`-kolonne. Tenk gjennom: terskel for "betydelig avvik", hva skjer hvis mottaker 2 også vil shifte, om inviter kan opt-ute, og om mottakeren får en tydelig "dette flytter møtet"-bekreftelse før tap.
- [ ] Drag-to-dismiss-gest på accept-page-panelet: drag-handlen (`.pp-grabber` i `js/ui-plan-preview.js` + CSS i `index.html`) er kosmetisk nå. Wire opp touch-events → translateY-tracking → terskel for `closePlanPreview()` (samme close-flyt som tilbake-knappen) for native iOS-følelse. Mønster å gjenbruke: `.invite-sheet`-animasjonen i `js/ui-detail.js`.
- [ ] Quick-share-rad på inviter-arket: WhatsApp / Messenger / SMS / Mail-ikon-chips over venneliste, så brukere som vet hvilken app de vil bruke slipper å scrolle gjennom venner først. Krever per-plattform-deeplink-håndtering (`whatsapp://send?text=...`, `sms:?body=...`, `mailto:?body=...`) + plattform-deteksjon for å skjule chips som ikke er installert.
