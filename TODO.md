<!--
  - [ ] å gjøre   - [x] ferdig   - [~] påbegynt   - [?] usikker
  ! prioritert     ~ lav prioritet
-->

## Under arbeid

## Backlog

- [x] Fjern "loading geometry"-melding fra UI
- [x] Profil-popover: sett samme bredde som dato/tid-pickeren
- [x] Flytt "sun set showing tomorrow"-melding — fjern den fra animasjonsskjermen og vis den i stedet under dato/tid-pickeren når den fader inn
- [x] Når solen er nede og vi hopper til i morgen, bruk kl. 12:00 som standardtid fremfor å kopiere gjeldende klokkeslett
- [ ] PWA-manifest — gjør appen installerbar på mobilhjemskjerm
- [ ] Analytics — legg til Umami eller tilsvarende for å forstå brukeradferd
- [ ] Poler login-gate — forbedre design på innloggingsprompt i detaljpanelet
- [ ] Supabase custom auth-domene — vis findshades.app i Google-innloggingsdialog (krever Supabase Pro)
- [ ] Venue-eier login — eget dashboard der venues kan redigere sin profil og se statistikk

## Ideer

- [ ] Push-varsler: sol-anbefalinger basert på posisjon
  - Når solen snart går ned på stedet brukeren befinner seg, send varsel med nærmeste alternativer som fortsatt har sol
  - Krever: push-tillatelse (Service Worker + Web Push API), geolokasjon, og backend for å sende varsler (Supabase Edge Function e.l.)
  - Brukerforklaring: vis tydelig *hvorfor* vi trenger bakgrunnsposisjon og hva som trigger en varsel — brukeren må forstå avtalen
  - Geolokasjon-strategi: vurder å kun tracke posisjon mens solen er oppe (f.eks. mellom soloppgang og solnedgang lokalt) for å spare batteri og respektere personvern
  - Avhenger av: PWA-manifest (installerbar), Supabase-backend for push-tokens
- [ ] Favoritter synket på tvers av enheter (krever backend/Supabase)
- [?] 7-dagers sol-prognose (pro-funksjon)
- [?] Intro-sekvens: hopp over for tilbakevendende brukere via localStorage (én gang per sesjon e.l.) — avgjøres når vi har nok brukere til å si at animasjonen er kjent
