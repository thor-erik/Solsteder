<!--
  - [ ] å gjøre   - [x] ferdig   - [~] påbegynt   - [?] usikker
  ! prioritert     ~ lav prioritet
-->

## Under arbeid

## Backlog

### Visuelle feil
- [x] Gul outline på pins og gul tekst i tidbobler (venues som snart får sol) — feil farge, skal bruke riktig designtoken
- [~] Hover-markøren over venues (etter solnedgang) er samme ikon som geolokasjons-ikonet — bytt til vanlig pointer
- [~] Ulik høyde på søkefelt og dato/tid-picker — juster slik at de er like høye
- [~] Venueliste og detaljpanel er ikke alignet i toppen på desktop

### Mobil UX
- [x] Detaljpanel på mobil opptar for mye skjerm — reduser høyde slik at mer av kartet er synlig
- [x] Aktivér map fly-over til venue ved tap på mobil (samme logikk som desktop, tilpasset liten skjerm)
- [x] Lukke detaljpanel på mobil: panelet skal følge drag-bevegelsen nedover; gi mer luft mellom bilder og drag-ikon; legg til X-knapp til høyre for drag-ikonet
- [x] Swipe-følsomhet på venuelisten: skru ned velocity-terskel for fullskjerm; hvis finger er i listen og passerer trigger-sonen oppover, gå fullskjerm når fingeren slippes

### Desktop UX
- [x] "Locate me"-knapp er ikke på rad med (eller like stor som) navigasjonsknappene
- [x] Venuelisten på desktop skal ikke animere inn fra bunnen — fade inn som øvrige elementer
- [x] "Locate me"-knappen skjules ikke når venuelisten ekspanderes — den skal dekkes av listen

### Kart og detaljpanel
- [x] Pin-klikk og liste-klikk skal dele samme fly-over/pan/zoom-logikk; X/swipe ned på detaljpanel resetter til kameratilstand før valg — begge veier må bruke felles kode slik at fremtidige forbedringer kun trengs ett sted
- [x] Hvis man har panna/zoomet i mini-kartet over åpen detail panel og deretter lukker panelet (X eller swipe): behold pan og zoom, men reset tilt til standard
- [x] "<Venues"-knappen i detail panel: swipe ned på panelet og åpne venuelisten i ekspandert tilstand
- [x] Vind-partikelanimasjon i bygningsruten over detail panel: hastighet skalerer etter faktisk vindstyrke; partiklene tar hensyn til bygningspolygonet og viser hvordan vinden treffer bygget; på sikt: hensyn til nabobygg; optimaliser — vurder en kort delay før animasjonen starter dersom bruker blar raskt mellom venues
- [ ] Skyggescrubber-slider i kartruten over detail panel: lar brukeren skrubbe gjennom timer på dagen og se skyggene bevege seg i sanntid; vis klokkeslett-indikator; vurder om ruten trenger mer plass; lukking av panelet resetter til forrige valgte tidspunkt i kartet

### Dato/tid-picker
- [ ] Del dato- og tid-picker i to separate pill-knapper side om side (Google Maps-stil, tilpasset vårt design); kalender-ikon i dato-picker, klokke-ikon i tid-picker; vis "Now" i tid-picker når nåværende tidspunkt er valgt
- [ ] Redesign tid-picker: erstatt solkurven med en temperaturkurve; gjør værforhold (overskyet, regn osv.) tydeligere og mer gradert; gjør scrubbing av tid mer intuitiv
- [ ] Dato-picker: legg til knapp for å ekspandere til full kalender; vis tydelig at værdata kun finnes 10 dager frem (etter det: bare sol/skygge-data)
- [ ] Pins i nærheten av brukerens posisjon skal prioriteres / løftes i kartet
- [ ] Editor på mobil (og desktop): toolbar er for lang — komprimér; type uteservering flyttes til en dropdown/popover-liste
- [~] Gjennomgang av sol-estimeringslogikk for ulike typer uteserveringer — dokumentér hvordan det fungerer og vurder om det er presist nok
- [~] Typografi-gjennomgang: etablér konsistente regler for farge, uppercase/lowercase og skråskrift — særlig i venuelisten og øvrig UI
- [~] Områdenavn under venue-kort ("Sentrum", "Aker Brygge" osv.) er ofte feil — vurder kilde og forbedring (Google API?)

### Redaksjonelt / innhold
- [~] Vink-integrasjon: vis Vink-symbol på pins, i listen og i detaljpanel; lenke til Vink-artikkel; vurder Vink-filter og prioritering av omtalte venues
- [~] Foreslå venue: knapp under profilikonet for å foreslå en venue som mangler — avklar håndteringsflyt
- [~] Venue-redigering med rettigheter: kun admins godkjenner endringer; vanlige brukere kan foreslå endringer som går til admin-gjennomgang

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
- [x] "Locate me"-knapp er ikke på rad med (eller like stor som) navigasjonsknappene
- [x] Venuelisten på desktop skal ikke animere inn fra bunnen — fade inn som øvrige elementer
- [x] Detaljpanel på mobil opptar for mye skjerm — redusert til 69svh
- [x] Aktivér map fly-over til venue ved tap på mobil — sentrerer i synlig kartområde over panelet
- [x] Lukke detaljpanel på mobil: panelet følger drag-bevegelsen; mer luft mellom bilder og drag-ikon; X-knapp lagt til
- [x] Swipe-følsomhet på venuelisten: trigger-sone låser scroll tidlig; liste og panel slåss ikke lenger

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
