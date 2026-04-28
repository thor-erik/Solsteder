#!/usr/bin/env node
/**
 * Reassigns the `area` field on every venue in data/venues.json based on
 * the venue's coordinates, using a Voronoi-style nearest-seed lookup.
 *
 * Each Oslo neighbourhood gets one or more seed points that hug its
 * actual centre. The closest seed (haversine distance) wins.
 *
 * Run:  node scripts/reassign-areas.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const VENUES_PATH = path.join(__dirname, '..', 'data', 'venues.json');

// Seed points hand-tuned to each neighbourhood's actual centre.
// Multiple seeds per area help cover irregular shapes.
// Coords are [lat, lng].
const SEEDS = [
  // Sentrum — Karl Johan, Stortinget, Vaterland, Hammersborg
  ['Sentrum',         59.91339, 10.74070], // Karl Johan / Egertorget
  ['Sentrum',         59.91020, 10.73950], // Christiania torv / Rådhusgata
  ['Sentrum',         59.91530, 10.74880], // Youngstorget
  ['Sentrum',         59.91450, 10.75550], // Storgata / Hausmanns
  ['Sentrum',         59.90930, 10.74580], // Skippergata / Tollbugata
  ['Sentrum',         59.91080, 10.75100], // Jernbanetorget / Oslo S
  ['Sentrum',         59.90770, 10.75500], // Bjørvika / Opera
  ['Sentrum',         59.90400, 10.75300], // Sørenga
  ['Sentrum',         59.90600, 10.74100], // Akershus festning
  ['Sentrum',         59.91720, 10.74600], // Hammersborg

  // Aker Brygge — Stranden, Bryggetorget, Holmens gate (north of Tjuvholmen kanal)
  ['Aker Brygge',     59.91030, 10.72750], // Stranden mid
  ['Aker Brygge',     59.91060, 10.72660], // Beer Palace / Holmens gate
  ['Aker Brygge',     59.90945, 10.72485], // Bryggetorget / Eataly
  ['Aker Brygge',     59.91100, 10.72920], // Stranden 1 / Jarmann

  // Tjuvholmen — small peninsula south of the Tjuvholmen kanal
  ['Tjuvholmen',      59.90820, 10.72200], // Tjuvholmen allé / Hanami
  ['Tjuvholmen',      59.90790, 10.72330], // Strandpromenaden / The Salmon
  ['Tjuvholmen',      59.90880, 10.72280], // Olav Selvaags plass / Kenzai
  ['Tjuvholmen',      59.90830, 10.72360], // Lille Stranden / Døgnvill
  ['Tjuvholmen',      59.90680, 10.72180], // Strandpromenaden south / VentiVenti

  // Vika is technically Frogner bydel but in everyday use it's its own
  // micro-area between Aker Brygge and Sentrum. We bundle it into Sentrum
  // so we don't multiply tiny areas.
  ['Sentrum',         59.91300, 10.73000], // Vika / Ruseløkka
  ['Sentrum',         59.91450, 10.72600], // Solli plass border

  // Frogner — Frogner park, Briskeby, Skillebekk, Bygdøy allé, Bygdøy
  ['Frogner',         59.91970, 10.70500], // Frognerveien / Frogner park east
  ['Frogner',         59.92500, 10.70300], // Frognerparken / Anne på landet
  ['Frogner',         59.91870, 10.70900], // Kolonihagen Frogner
  ['Frogner',         59.91650, 10.71400], // Frogner / Cordial
  ['Frogner',         59.91990, 10.71700], // Briskeby
  ['Frogner',         59.91700, 10.71700], // Skovveien / Solli border
  ['Frogner',         59.91450, 10.71800], // Solli plass
  ['Frogner',         59.91100, 10.70500], // Frognerstranda / Filipstad
  ['Frogner',         59.91550, 10.71400], // Bygdøy allé / Babbo
  ['Frogner',         59.91100, 10.71800], // Munkedamsveien / Villa Heftye
  ['Frogner',         59.90700, 10.69500], // Bygdøy — Huk Aveny
  ['Frogner',         59.89800, 10.69400], // Bygdøy south — Herbern

  // Bislett — stadium, Pilestredet upper, Underhaugsveien
  ['Bislett',         59.92580, 10.73070], // Bislett stadium
  ['Bislett',         59.92400, 10.73120], // Pilestredet 63 / J2
  ['Bislett',         59.92650, 10.73120], // Thereses gate

  // Majorstuen — Bogstadveien, Vibes gate, Jacob Aalls
  ['Majorstuen',      59.92900, 10.71600], // Majorstuen station
  ['Majorstuen',      59.92750, 10.71900], // Bogstadveien middle
  ['Majorstuen',      59.92850, 10.72000], // Bogstadveien upper
  ['Majorstuen',      59.92650, 10.72260], // Vibes gate / Schulz
  ['Majorstuen',      59.92910, 10.71830], // Jacob Aalls gate
  ['Majorstuen',      59.92985, 10.71420], // Sørkedalsveien

  // St. Hanshaugen — park, Ullevålsveien, Stensparken
  ['St. Hanshaugen',  59.92450, 10.74050], // St. Hanshaugen park
  ['St. Hanshaugen',  59.92250, 10.73600], // Stensparken
  ['St. Hanshaugen',  59.91900, 10.73900], // Pilestredet park
  ['St. Hanshaugen',  59.91790, 10.73400], // St. Olavs plass
  ['St. Hanshaugen',  59.93150, 10.73620], // Adamstuen

  // Grünerløkka — Olaf Ryes plass, Birkelunden, Vulkan, Sofienberg
  ['Grünerløkka',     59.92340, 10.75830], // Olaf Ryes plass
  ['Grünerløkka',     59.92560, 10.76250], // Birkelunden
  ['Grünerløkka',     59.92200, 10.75400], // Vulkan / Mathallen
  ['Grünerløkka',     59.92750, 10.76700], // Sofienberg
  ['Grünerløkka',     59.92140, 10.75760], // Markveien south
  ['Grünerløkka',     59.92220, 10.75370], // Nedre Foss

  // Grønland — Grønland T-bane, Grønlandsleiret
  ['Grønland',        59.91300, 10.76050], // Grønland T-bane
  ['Grønland',        59.91450, 10.76450], // Grønlandsleiret north
  ['Grønland',        59.91100, 10.76700], // Grønland south / Schweigaards

  // Tøyen — Tøyenparken, Botanisk hage, Kampen border
  ['Tøyen',           59.91750, 10.77700], // Tøyen
  ['Tøyen',           59.92050, 10.78400], // Botanisk hage / Munch (old)
  ['Tøyen',           59.91450, 10.78200], // Kampen / Jens Bjelkes gate

  // Sagene — Sagene kirke, Bjølsen, Torshov, along Akerselva
  ['Sagene',          59.93350, 10.75600], // Sagene kirke
  ['Sagene',          59.93200, 10.75100], // Akerselva / Sagene bru
  ['Sagene',          59.93850, 10.75950], // Bjølsen
  ['Sagene',          59.93250, 10.76600], // Torshov
  ['Sagene',          59.93650, 10.76900], // Lille Tøyen / Torshovdalen

  // Nydalen
  ['Nydalen',         59.94950, 10.76350], // Nydalen station
  ['Nydalen',         59.94600, 10.76600], // Nydalen south
  ['Nydalen',         59.95100, 10.76800], // Nydalen north

  // Sinsen — Sinsen T-bane, Carl Berner, Storo
  ['Sinsen',          59.93550, 10.79350], // Sinsen
  ['Sinsen',          59.93000, 10.78500], // Carl Berner
  ['Sinsen',          59.93850, 10.80000], // Storo
  ['Sinsen',          59.94050, 10.78200], // Sinsen north / Refstad

  // Skøyen
  ['Skøyen',          59.92150, 10.68100], // Skøyen station
  ['Skøyen',          59.92600, 10.68500], // Skøyen north
  ['Skøyen',          59.91700, 10.68400], // Skøyen south

  // Vindern — Vinderen, Slemdal, Holmenkollen lower
  ['Vindern',         59.94850, 10.70500], // Vinderen station
  ['Vindern',         59.95400, 10.70350], // Slemdal
  ['Vindern',         59.94100, 10.70750], // Vindern south
  ['Vindern',         59.94300, 10.71700], // Marienlyst north / Suhms gate

  // Ullern — Ullern station, Ullernchausséen, Bestum
  ['Ullern',          59.92300, 10.66600], // Ullern station
  ['Ullern',          59.92000, 10.66500], // Ullernchausséen
  ['Ullern',          59.91500, 10.66600], // Bestum

  // Helsfyr — Helsfyr T-bane, Ensjø, Etterstad, Hasle, Kværnerbyen
  ['Helsfyr',         59.91450, 10.80950], // Helsfyr T-bane
  ['Helsfyr',         59.91500, 10.79500], // Ensjø
  ['Helsfyr',         59.91200, 10.80500], // Etterstad
  ['Helsfyr',         59.91900, 10.79000], // Hasle
  ['Helsfyr',         59.90550, 10.78700], // Kværnerbyen / Smia
  ['Helsfyr',         59.90400, 10.79000], // Kværnerbyen south / Turbinveien

  // Bryn — Bryn station, Brynseng, Bryn west
  ['Bryn',            59.90950, 10.82200], // Bryn station
  ['Bryn',            59.91000, 10.81100], // Brynsveien
  ['Bryn',            59.90400, 10.82150], // Bryn south / Østensjøveien
  ['Bryn',            59.89300, 10.84150], // Oppsal
  ['Bryn',            59.91100, 10.82800], // Tveita

  // Østensjø — Østensjøvann, Manglerud, Bøler
  ['Østensjø',        59.88700, 10.82300], // Østensjøvannet
  ['Østensjø',        59.88000, 10.80500], // Manglerud
  ['Østensjø',        59.87900, 10.80450], // Karlsrud / Raschs vei
  ['Østensjø',        59.89000, 10.86500], // Østmarka

  // Nordstrand — Nordstrand station, Bekkelaget, Ekeberg
  ['Nordstrand',      59.86150, 10.80050], // Nordstrand sentrum
  ['Nordstrand',      59.87300, 10.78400], // Bekkelaget
  ['Nordstrand',      59.88000, 10.77000], // Ekebergsletta / Sjømannsskolen
  ['Nordstrand',      59.86850, 10.78100], // Sæter
  ['Nordstrand',      59.89770, 10.78240], // Ekeberg / Ballplassveien
  ['Nordstrand',      59.89000, 10.78000], // Bekkelagshøgda

  // Ljan — Ljan station, Hauketo
  ['Ljan',            59.85050, 10.79050], // Ljan station
  ['Ljan',            59.84800, 10.78000], // Ljan south
  ['Ljan',            59.84960, 10.80130], // Hauketo / Ljabruveien
];

const AREA_NAMES = [...new Set(SEEDS.map(s => s[0]))];

/** Haversine distance in metres between two [lat, lng] points. */
function haversine(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function assignArea(coords) {
  let best = null;
  let bestDist = Infinity;
  for (const [name, lat, lng] of SEEDS) {
    const d = haversine(coords, [lat, lng]);
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return { area: best, distance: bestDist };
}

// ── Run ──────────────────────────────────────────────────────────────────────

const venues = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));

const changes = [];
for (const v of venues) {
  const prev = v.area;
  const { area, distance } = assignArea(v.coords);
  if (prev !== area) changes.push({ name: v.name, addr: v.address.split(',')[0], prev, next: area, dist: Math.round(distance) });
  v.area = area;
}

fs.writeFileSync(VENUES_PATH, JSON.stringify(venues, null, 2) + '\n');

// Report
console.log(`Reassigned ${changes.length} of ${venues.length} venues.\n`);
const byMove = {};
for (const c of changes) {
  const key = `${c.prev} → ${c.next}`;
  (byMove[key] ??= []).push(c);
}
for (const [k, list] of Object.entries(byMove).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${k}  (${list.length})`);
  for (const c of list.slice(0, 8)) {
    console.log(`  ${c.name}  (${c.addr})  [${c.dist}m]`);
  }
  if (list.length > 8) console.log(`  …and ${list.length - 8} more`);
}

// New distribution
const dist = {};
for (const v of venues) dist[v.area] = (dist[v.area] ?? 0) + 1;
console.log('\nNew area distribution:');
for (const [a, c] of Object.entries(dist).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${a.padEnd(20)} ${c}`);
}
