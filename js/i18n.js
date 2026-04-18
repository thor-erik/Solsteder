/**
 * i18n.js — Language preference, temperature unit, and translation helper.
 * Loaded before all other JS. Exposes: t(key), prefLang(), prefTempUnit(),
 * setPrefLang(l), setPrefTempUnit(u), formatTemp(celsius).
 */

const _STRINGS = {
  en: {
    // Profile panel
    signout:            'Sign out',
    signin_google:      'Sign in with Google',
    pending_edits:      'Pending suggestions',
    manage_users:       'Manage users',
    settings:           'Settings',
    language:           'Language',
    temperature:        'Temperature',
    my_suggestions:     'My suggestions',
    privacy_policy:     'Privacy policy',
    no_suggestions_yet: 'No suggestions yet',
    status_pending:     'Pending',
    status_approved:    'Approved',
    status_rejected:    'Rejected',
    status_withdrawn:   'Withdrawn',
    withdraw:           'Withdraw',
    withdraw_confirm:   'Withdraw this suggestion?',
    // Search + suggest flow
    search_placeholder:  'Search venues or areas…',
    not_seeing_venue:    'Not seeing your venue?',
    no_results_for:      'No results for',
    suggest_venue:       'Suggest venue →',
    suggest_submitted:   'Thanks! Your suggestion has been submitted.',
    suggest_login_hint:  'Sign in to save your suggestion to your profile',
    // Candidate badge
    candidate_badge:     'Not yet reviewed',
    // Date
    today:               'Today',
    tomorrow:            'Tomorrow',
    // Admin
    admin_venue_suggestions: 'Venue suggestions',
  },
  no: {
    signout:            'Logg ut',
    signin_google:      'Logg inn med Google',
    pending_edits:      'Ventende endringer',
    manage_users:       'Administrer brukere',
    settings:           'Innstillinger',
    language:           'Språk',
    temperature:        'Temperatur',
    my_suggestions:     'Mine forslag',
    privacy_policy:     'Personvern',
    no_suggestions_yet: 'Ingen forslag ennå',
    status_pending:     'Venter',
    status_approved:    'Godkjent',
    status_rejected:    'Avvist',
    status_withdrawn:   'Trukket tilbake',
    withdraw:           'Trekk tilbake',
    withdraw_confirm:   'Trekke tilbake dette forslaget?',
    search_placeholder:  'Søk etter steder eller områder…',
    not_seeing_venue:    'Finner du ikke stedet?',
    no_results_for:      'Ingen treff for',
    suggest_venue:       'Foreslå sted →',
    suggest_submitted:   'Takk! Ditt forslag er sendt inn.',
    suggest_login_hint:  'Logg inn for å lagre forslaget på profilen din',
    candidate_badge:     'Ikke vurdert ennå',
    today:               'I dag',
    tomorrow:            'I morgen',
    admin_venue_suggestions: 'Stedforslag',
  },
  sv: {
    signout:            'Logga ut',
    signin_google:      'Logga in med Google',
    pending_edits:      'Väntande ändringar',
    manage_users:       'Hantera användare',
    settings:           'Inställningar',
    language:           'Språk',
    temperature:        'Temperatur',
    my_suggestions:     'Mina förslag',
    privacy_policy:     'Integritetspolicy',
    no_suggestions_yet: 'Inga förslag ännu',
    status_pending:     'Väntar',
    status_approved:    'Godkänd',
    status_rejected:    'Avvisad',
    status_withdrawn:   'Tillbakadragen',
    withdraw:           'Dra tillbaka',
    withdraw_confirm:   'Dra tillbaka det här förslaget?',
    search_placeholder:  'Sök efter ställen eller områden…',
    not_seeing_venue:    'Hittar du inte stället?',
    no_results_for:      'Inga träffar för',
    suggest_venue:       'Föreslå ställe →',
    suggest_submitted:   'Tack! Ditt förslag har skickats in.',
    suggest_login_hint:  'Logga in för att spara förslaget på din profil',
    candidate_badge:     'Inte granskat ännu',
    today:               'I dag',
    tomorrow:            'I morgon',
    admin_venue_suggestions: 'Platsförslag',
  },
  da: {
    signout:            'Log ud',
    signin_google:      'Log ind med Google',
    pending_edits:      'Afventende ændringer',
    manage_users:       'Administrer brugere',
    settings:           'Indstillinger',
    language:           'Sprog',
    temperature:        'Temperatur',
    my_suggestions:     'Mine forslag',
    privacy_policy:     'Privatlivspolitik',
    no_suggestions_yet: 'Ingen forslag endnu',
    status_pending:     'Afventer',
    status_approved:    'Godkendt',
    status_rejected:    'Afvist',
    status_withdrawn:   'Trukket tilbage',
    withdraw:           'Træk tilbage',
    withdraw_confirm:   'Vil du trække dette forslag tilbage?',
    search_placeholder:  'Søg efter steder eller områder…',
    not_seeing_venue:    'Kan du ikke finde stedet?',
    no_results_for:      'Ingen resultater for',
    suggest_venue:       'Foreslå sted →',
    suggest_submitted:   'Tak! Dit forslag er indsendt.',
    suggest_login_hint:  'Log ind for at gemme dit forslag på din profil',
    candidate_badge:     'Ikke gennemgået endnu',
    today:               'I dag',
    tomorrow:            'I morgen',
    admin_venue_suggestions: 'Stedsforslag',
  },
};

function prefLang()     { return localStorage.getItem('pref_lang') || 'no'; }
function prefTempUnit() { return localStorage.getItem('pref_temp') || 'C'; }

function setPrefLang(l) {
  localStorage.setItem('pref_lang', l);
  const inp = document.getElementById('venue-search');
  if (inp) inp.placeholder = t('search_placeholder');
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
}

function setPrefTempUnit(u) {
  localStorage.setItem('pref_temp', u);
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
  if (typeof update === 'function') update();
}

function t(key) {
  const lang = prefLang();
  return (_STRINGS[lang] || _STRINGS.no)[key] ?? _STRINGS.en[key] ?? key;
}

/** Format a temperature in °C into the user's preferred unit. */
function formatTemp(celsius) {
  if (celsius == null) return '—';
  if (prefTempUnit() === 'F') return `${Math.round(celsius * 9 / 5 + 32)}°F`;
  return `${celsius}°`;
}
