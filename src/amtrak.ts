// Amtrak trains near Boston, from Amtraker (https://amtraker.com), a free
// community feed of Amtrak's own train tracker. Amtrak shares the MBTA's
// tracks into South Station (the Providence Line and the Worcester Line) and
// North Station (the Downeaster), so its trains are part of what moves the T.

const FEED = 'https://api-v3.amtraker.com/v3/trains';

/** Eastern Massachusetts and Rhode Island: roughly the commuter rail's reach. */
const REGION = { south: 41.6, north: 43.3, west: -72.2, east: -70.5 };

const COMPASS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

export interface AmtrakStop {
  name: string;
  code: string;
  /** Epoch ms: estimated (or actual) and scheduled arrival. */
  at: number;
  scheduled: number;
  /** "Enroute", "Station" or "Departed". */
  status: string;
}

export interface AmtrakTrain {
  id: string;
  number: string;
  /** e.g. "Acela", "Northeast Regional", "Downeaster". */
  service: string;
  lat: number;
  lng: number;
  /** Compass degrees; Amtrak only reports the nearest eighth of a turn. */
  bearing: number;
  /** Meters per second. */
  speed: number;
  origin: string;
  destination: string;
  /** Epoch ms of the position fix. */
  updatedAt: number;
  /** Stops it hasn't left yet, in order. */
  upcoming: AmtrakStop[];
  /** Minutes behind schedule at its next stop (negative if early). */
  late: number | null;
}

const time = (s?: string) => (s ? Date.parse(s) : NaN);

export async function loadAmtrak(): Promise<AmtrakTrain[]> {
  const res = await fetch(FEED);
  if (!res.ok) throw new Error(`Amtraker ${res.status}`);
  const data: Record<string, any[]> = await res.json();
  const out: AmtrakTrain[] = [];
  for (const t of Object.values(data).flat()) {
    if (t.trainState !== 'Active' || t.provider !== 'Amtrak') continue;
    if (t.lat < REGION.south || t.lat > REGION.north || t.lon < REGION.west || t.lon > REGION.east) continue;
    const upcoming: AmtrakStop[] = (t.stations ?? [])
      .filter((s: any) => s.status !== 'Departed')
      .map((s: any) => ({
        name: s.name,
        code: s.code,
        at: time(s.arr || s.dep),
        scheduled: time(s.schArr || s.schDep),
        status: s.status,
      }));
    const next = upcoming[0];
    out.push({
      id: `amtrak-${t.trainID}`,
      number: String(t.trainNum),
      service: t.routeName,
      lat: t.lat,
      lng: t.lon,
      bearing: COMPASS[t.heading] ?? 0,
      speed: (t.velocity ?? 0) * 0.44704,
      origin: t.origName,
      destination: t.destName,
      updatedAt: time(t.lastValTS),
      upcoming,
      late: next && Number.isFinite(next.at) && Number.isFinite(next.scheduled) ? Math.round((next.at - next.scheduled) / 60_000) : null,
    });
  }
  return out;
}
