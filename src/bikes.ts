// Bluebikes docks and how many bikes each has, from the system's public GBFS feed.

const FEED = 'https://gbfs.bluebikes.com/gbfs/en';

export interface Dock {
  id: string;
  name: string;
  lng: number;
  lat: number;
  capacity: number;
  bikes: number;
  ebikes: number;
  docks: number;
  renting: boolean;
  /** Epoch ms of the dock's last report. */
  reportedAt: number;
}

export async function loadDocks(): Promise<Dock[]> {
  const [info, status] = await Promise.all(
    ['station_information', 'station_status'].map((f) =>
      fetch(`${FEED}/${f}.json`).then((r) => {
        if (!r.ok) throw new Error(`Bluebikes ${r.status}`);
        return r.json();
      }),
    ),
  );
  const byId = new Map<string, any>(status.data.stations.map((s: any) => [s.station_id, s]));
  const docks: Dock[] = [];
  for (const s of info.data.stations) {
    const st = byId.get(s.station_id);
    if (!st || !st.is_installed) continue;
    const ebikes = st.num_ebikes_available ?? 0;
    docks.push({
      id: s.station_id,
      name: s.name,
      lng: s.lon,
      lat: s.lat,
      capacity: s.capacity ?? 0,
      // GBFS counts e-bikes inside num_bikes_available; split them out.
      bikes: Math.max(0, (st.num_bikes_available ?? 0) - ebikes),
      ebikes,
      docks: st.num_docks_available ?? 0,
      renting: !!st.is_renting,
      reportedAt: (st.last_reported ?? 0) * 1000,
    });
  }
  return docks;
}
