# Live Boston

Boston in real time: every T, commuter rail, Silver Line, ferry and Amtrak train in 3D, with service alerts, your commute, Bluebikes, and the city's real sky and weather.

**[jdank417.github.io/live-boston](https://jdank417.github.io/live-boston/)**

- Every Red, Orange, Blue, Green, Mattapan, Silver Line and commuter rail
  vehicle, live: crisp dots from afar, and real 3D trains up close with the
  actual number of cars the MBTA reports, true car dimensions and lit windows.
  Cars follow the curves of their own track, and trains hidden by buildings or
  underground show through as a faint outline
- **Ferries and Amtrak**: MBTA harbor ferries as boats, and Amtrak trains near
  Boston (from [Amtraker](https://amtraker.com)) running on the commuter rail
  tracks they share, with how late each one is
- One sidebar (a draggable bottom sheet on phones) with four tabs: **Lines**
  with live counts, toggles and disruption flags; **Alerts**; **Following**,
  for trains you've starred; and **Map**, for 2D/3D, layers, getting the app,
  and today's sunrise and sunset
- **Alerts**: the MBTA's service alerts, worst first, with suspended stretches
  and closed stations marked in amber on the map. Outside causes (freight
  trains, drawbridges, Amtrak traffic, rough seas) are called out, and
  **bunched trains** running nose to tail are worked out from live positions
- **Search** stations, lines, any train by number, ferries by name and
  Bluebikes docks. Press `/` on a keyboard
- **Where to?** Directions from where you are (by GPS) or anywhere, to any
  station, address or place, or a spot you tap on the map. The trip is drawn
  on the map: the real way on foot, the real track for each ride. Each step
  has live times: which train to catch, where it is right now (tap to watch
  it come), how many stops, and where to get off. **Preview the trip** flies
  the camera along the whole route in 3D. Other ways are listed beside the
  fastest (ferries and commuter rail too, when one gets you there sooner),
  and "Directions here" on any station starts one. **Plan ahead** with
  "Leave at" or "Arrive by" a day and time, from the timetable
- **My commute**: save a trip and the top of the sidebar counts down to when
  to leave, timed from where you are now. At the far end it turns around for
  the way back. There's an optional reminder while the app is open
- **Installable**: add it to your home screen as an app, with rich link previews
- **Ride along** steps the interface aside and follows a train with a minimal
  panel (tap the line's name for the stops ahead), or switch to the **cab
  view** to look down the line from the driver's seat, dragging to look
  around; **Take the tour** hops between trains on its own
- **Find me**: the locate button shows where you are and the nearest station,
  and on the move it spots the train you're riding (one that stays with you,
  fix after fix, going your way) and offers to ride along. GPS drops out
  underground, so this works where trains run in the open
- **Spin the city** with two fingers: twist on a touchscreen, or swipe
  sideways on a trackpad (any browser; a real twist works in Safari too).
  While riding along, spinning looks around, then eases back behind the train
- Tap a train for its next stops and speed, a station for its departures, or a
  Bluebikes dock for bikes and open docks
- **Speed map**: track colored by how fast trains actually move over it, so
  slow zones show up red. Measured from the trains' own reports, it fills in
  as you watch and is kept on your device for six hours
- A quiet custom basemap, light that follows the real sun over Boston, and live
  weather (rain, snow, fog, storms). Preview with `?hour=21.5` or `?weather=snow`
- Link straight to a train (`#train=<vehicle id>`), a station
  (`#station=place-pktrm`), your list (`#following`) or the alerts (`#alerts`)

## How accurate is it?

Every position report is snapped onto the exact route shape that train's trip
runs on, and the train then glides *along the track* to its next report rather
than cutting across. In testing, reports sat a median of 3.5 m from their
track, 57 of 58 moving trains faced the same way as the MBTA's own bearing,
and small backward jitters are held rather than shown.

Reports are about 20 seconds old when they arrive, and about a quarter of
moving trains go a 12-second poll without a new one. So each train is drawn
where it probably is *now*: its last report, plus how far it has likely gone
since at its measured speed (or the line's typical speed until it has one),
never past the stop it's heading to and never while the MBTA says it's
stopped. The drawn train follows that estimate with realistic acceleration
and braking, and never reverses. In testing, a new report moved the estimate
a median of 13 m. Positions are as fresh
as the MBTA's own reports, usually under 30 seconds old; the panel shows each
train's age.

Commuter rail doesn't report its consist, so those trains are drawn as a
typical locomotive and six coaches, and the panel says so.

## How it works

It's a static site with no backend. The browser pulls live data straight from
the [MBTA V3 API](https://api-v3.mbta.com) every 12 seconds.
Directions are found in the browser on the MBTA's own trip patterns, then
timed with its live predictions (or timetable). Walking routes come from
[Valhalla](https://valhalla.github.io/valhalla/) on OpenStreetMap's public
server, and addresses from [Photon](https://photon.komoot.io), falling back
to [Nominatim](https://nominatim.org) when it's down. The map is
[MapLibre GL](https://maplibre.org) on [OpenFreeMap](https://openfreemap.org)
tiles with buildings extruded from OpenStreetMap heights, and the trains are
drawn with [three.js](https://threejs.org) in a custom layer that shares the
map's depth buffer. Bluebikes come from the system's public
[GBFS feed](https://gbfs.bluebikes.com/gbfs/gbfs.json) and the weather from
[Open-Meteo](https://open-meteo.com); neither needs a key.

Without an API key the MBTA allows 20 requests a minute per visitor, which is
plenty. To use a key, set `VITE_MBTA_API_KEY` at build time (the deploy
workflow reads it from a `MBTA_API_KEY` repository secret).

## Run it locally

```sh
npm install
npm run dev
```

Pushes to `main` build and deploy to GitHub Pages through
`.github/workflows/deploy.yml`.

## Roadmap

- Account for service alerts (suspensions, shuttles) when picking a route
