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
- [~] Forsk på oppdateringsstrategi: brukere skal få nye versjoner av appen uten å måtte slette nettleserdata — vurder cache-busting (f.eks. versjonerte filnavn), Service Worker update-flow, og evt. en "ny versjon tilgjengelig"-banner

### Eksisterende backlog
- [~] PWA-manifest — gjør appen installerbar på mobilhjemskjerm
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

## Ideer

- [~] Push-varsler: sol-anbefalinger basert på posisjon
  - Når solen snart går ned på stedet brukeren befinner seg, send varsel med nærmeste alternativer som fortsatt har sol
  - Krever: push-tillatelse (Service Worker + Web Push API), geolokasjon, og backend for å sende varsler (Supabase Edge Function e.l.)
  - Brukerforklaring: vis tydelig *hvorfor* vi trenger bakgrunnsposisjon og hva som trigger en varsel — brukeren må forstå avtalen
  - Geolokasjon-strategi: vurder å kun tracke posisjon mens solen er oppe (f.eks. mellom soloppgang og solnedgang lokalt) for å spare batteri og respektere personvern
  - Avhenger av: PWA-manifest (installerbar), Supabase-backend for push-tokens
- [~] Favoritter synket på tvers av enheter (krever backend/Supabase)
- [?] 7-dagers sol-prognose (pro-funksjon)
- [?] Intro-sekvens: hopp over for tilbakevendende brukere via localStorage (én gang per sesjon e.l.) — avgjøres når vi har nok brukere til å si at animasjonen er kjent
