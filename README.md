# Live Boston

Boston in real time: every T and commuter rail train, drawn in 3D on a live map of the city.

**[jdank417.github.io/live-boston](https://jdank417.github.io/live-boston/)**

- Every Red, Orange, Blue, Green, Mattapan and commuter rail train as a real 3D
  train: the actual number of cars it's running (as the MBTA reports it), true
  car dimensions, lit windows, headlights and taillights
- Each car follows the curves of its own track, and trains hidden by buildings
  or underground stations show through as a faint outline
- **Ride along** puts the camera behind a train and turns with the track;
  **Tour** hops between trains on its own
- Tap a train for its next stops and speed, or a station for its live departure board
- **☆ Follow** any train to keep it in your **Following** tab with its live
  status; followed trains glow gold on the map (saved on your device)
- **2D / 3D**: a flat north-up map, or the tilted city with buildings
- Link straight to a train (`#train=<vehicle id>`) or a station (`#station=place-pktrm`)

## How accurate is it?

Every position report is snapped onto the exact route shape that train's trip
runs on, and the train then glides *along the track* to its next report rather
than cutting across. In testing, reports sat a median of 3.5 m from their
track, 57 of 58 moving trains faced the same way as the MBTA's own bearing,
and small backward jitters are held rather than shown.

About a quarter of moving trains go 12 seconds or more without a new report.
Rather than freeze them, the app keeps them rolling at their measured speed
(or the line's typical speed until it has one), never past the stop they're
heading to and never while the MBTA says they're stopped. A new report then
corrects them without sliding backwards. Positions are as fresh
as the MBTA's own reports, usually under 30 seconds old; the panel shows each
train's age.

Commuter rail doesn't report its consist, so those trains are drawn as a
typical locomotive and six coaches, and the panel says so.

## How it works

It's a static site with no backend. The browser pulls live data straight from
the [MBTA V3 API](https://api-v3.mbta.com) every 12 seconds. The map is
[MapLibre GL](https://maplibre.org) on [OpenFreeMap](https://openfreemap.org)
tiles with buildings extruded from OpenStreetMap heights, and the trains are
drawn with [three.js](https://threejs.org) in a custom layer that shares the
map's depth buffer.

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

- Bluebikes stations with live bike and dock counts
- Buses
- Pin a station for a live countdown
