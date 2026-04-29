/**
 * Shared neighbourhood-assignment seeds and lookup.
 * Used by reassign-areas.mjs (post-hoc) and fetch-venues-places.mjs
 * (assigning area to newly-discovered venues at ingest time).
 *
 * Each entry is [areaName, lat, lng]. Areas have multiple seeds to
 * cover irregular shapes; the closest seed (haversine) wins.
 */

export const SEEDS = [
  // Sentrum — Karl Johan, Stortinget, Vaterland, Hammersborg
  ['Sentrum',         59.91339, 10.74070],
  ['Sentrum',         59.91020, 10.73950],
  ['Sentrum',         59.91530, 10.74880],
  ['Sentrum',         59.91450, 10.75550],
  ['Sentrum',         59.90930, 10.74580],
  ['Sentrum',         59.91080, 10.75100],
  ['Sentrum',         59.90770, 10.75500],
  ['Sentrum',         59.90400, 10.75300],
  ['Sentrum',         59.90600, 10.74100],
  ['Sentrum',         59.91720, 10.74600],

  // Aker Brygge
  ['Aker Brygge',     59.91030, 10.72750],
  ['Aker Brygge',     59.91060, 10.72660],
  ['Aker Brygge',     59.90945, 10.72485],
  ['Aker Brygge',     59.91100, 10.72920],

  // Tjuvholmen
  ['Tjuvholmen',      59.90820, 10.72200],
  ['Tjuvholmen',      59.90790, 10.72330],
  ['Tjuvholmen',      59.90880, 10.72280],
  ['Tjuvholmen',      59.90830, 10.72360],
  ['Tjuvholmen',      59.90680, 10.72180],

  // Vika bundled into Sentrum
  ['Sentrum',         59.91300, 10.73000],
  ['Sentrum',         59.91450, 10.72600],

  // Frogner
  ['Frogner',         59.91970, 10.70500],
  ['Frogner',         59.92500, 10.70300],
  ['Frogner',         59.91870, 10.70900],
  ['Frogner',         59.91650, 10.71400],
  ['Frogner',         59.91990, 10.71700],
  ['Frogner',         59.91700, 10.71700],
  ['Frogner',         59.91450, 10.71800],
  ['Frogner',         59.91100, 10.70500],
  ['Frogner',         59.91550, 10.71400],
  ['Frogner',         59.91100, 10.71800],
  ['Frogner',         59.90700, 10.69500],
  ['Frogner',         59.89800, 10.69400],

  // Bislett
  ['Bislett',         59.92580, 10.73070],
  ['Bislett',         59.92400, 10.73120],
  ['Bislett',         59.92650, 10.73120],

  // Majorstuen
  ['Majorstuen',      59.92900, 10.71600],
  ['Majorstuen',      59.92750, 10.71900],
  ['Majorstuen',      59.92850, 10.72000],
  ['Majorstuen',      59.92650, 10.72260],
  ['Majorstuen',      59.92910, 10.71830],
  ['Majorstuen',      59.92985, 10.71420],

  // St. Hanshaugen
  ['St. Hanshaugen',  59.92450, 10.74050],
  ['St. Hanshaugen',  59.92250, 10.73600],
  ['St. Hanshaugen',  59.91900, 10.73900],
  ['St. Hanshaugen',  59.91790, 10.73400],
  ['St. Hanshaugen',  59.93150, 10.73620],

  // Grünerløkka
  ['Grünerløkka',     59.92340, 10.75830],
  ['Grünerløkka',     59.92560, 10.76250],
  ['Grünerløkka',     59.92200, 10.75400],
  ['Grünerløkka',     59.92750, 10.76700],
  ['Grünerløkka',     59.92140, 10.75760],
  ['Grünerløkka',     59.92220, 10.75370],

  // Grønland
  ['Grønland',        59.91300, 10.76050],
  ['Grønland',        59.91450, 10.76450],
  ['Grønland',        59.91100, 10.76700],

  // Tøyen
  ['Tøyen',           59.91750, 10.77700],
  ['Tøyen',           59.92050, 10.78400],
  ['Tøyen',           59.91450, 10.78200],

  // Sagene
  ['Sagene',          59.93350, 10.75600],
  ['Sagene',          59.93200, 10.75100],
  ['Sagene',          59.93850, 10.75950],
  ['Sagene',          59.93250, 10.76600],
  ['Sagene',          59.93650, 10.76900],

  // Nydalen
  ['Nydalen',         59.94950, 10.76350],
  ['Nydalen',         59.94600, 10.76600],
  ['Nydalen',         59.95100, 10.76800],

  // Sinsen
  ['Sinsen',          59.93550, 10.79350],
  ['Sinsen',          59.93000, 10.78500],
  ['Sinsen',          59.93850, 10.80000],
  ['Sinsen',          59.94050, 10.78200],

  // Skøyen
  ['Skøyen',          59.92150, 10.68100],
  ['Skøyen',          59.92600, 10.68500],
  ['Skøyen',          59.91700, 10.68400],

  // Vindern
  ['Vindern',         59.94850, 10.70500],
  ['Vindern',         59.95400, 10.70350],
  ['Vindern',         59.94100, 10.70750],
  ['Vindern',         59.94300, 10.71700],

  // Ullern
  ['Ullern',          59.92300, 10.66600],
  ['Ullern',          59.92000, 10.66500],
  ['Ullern',          59.91500, 10.66600],

  // Helsfyr
  ['Helsfyr',         59.91450, 10.80950],
  ['Helsfyr',         59.91500, 10.79500],
  ['Helsfyr',         59.91200, 10.80500],
  ['Helsfyr',         59.91900, 10.79000],
  ['Helsfyr',         59.90550, 10.78700],
  ['Helsfyr',         59.90400, 10.79000],

  // Bryn
  ['Bryn',            59.90950, 10.82200],
  ['Bryn',            59.91000, 10.81100],
  ['Bryn',            59.90400, 10.82150],
  ['Bryn',            59.89300, 10.84150],
  ['Bryn',            59.91100, 10.82800],

  // Østensjø
  ['Østensjø',        59.88700, 10.82300],
  ['Østensjø',        59.88000, 10.80500],
  ['Østensjø',        59.87900, 10.80450],
  ['Østensjø',        59.89000, 10.86500],

  // Nordstrand
  ['Nordstrand',      59.86150, 10.80050],
  ['Nordstrand',      59.87300, 10.78400],
  ['Nordstrand',      59.88000, 10.77000],
  ['Nordstrand',      59.86850, 10.78100],
  ['Nordstrand',      59.89770, 10.78240],
  ['Nordstrand',      59.89000, 10.78000],

  // Ljan
  ['Ljan',            59.85050, 10.79050],
  ['Ljan',            59.84800, 10.78000],
  ['Ljan',            59.84960, 10.80130],
];

export const AREA_NAMES = [...new Set(SEEDS.map(s => s[0]))];

export function haversine(a, b) {
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

/** Returns { area, distance } for the given [lat, lng]. */
export function assignArea(coords) {
  let best = null;
  let bestDist = Infinity;
  for (const [name, lat, lng] of SEEDS) {
    const d = haversine(coords, [lat, lng]);
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return { area: best, distance: bestDist };
}
