# Live Boston

Boston in real time: every T train moving on a 3D map of the city.

**[jdank417.github.io/live-boston](https://jdank417.github.io/live-boston/)**

- Every Red, Orange, Blue, Green and Mattapan train, gliding between live position updates
- Click a train to see where it's headed and when it reaches its next stops
- **Follow this train** flies into a tilted 3D view and keeps the camera on it
- Toggle lines on and off from the legend
- Link straight to a train with `#train=<vehicle id>`

## How it works

It's a static site with no backend. The browser pulls live data straight from
the [MBTA V3 API](https://api-v3.mbta.com) every 12 seconds and draws it with
[MapLibre GL](https://maplibre.org) on [OpenFreeMap](https://openfreemap.org)
tiles, with buildings extruded from OpenStreetMap heights.

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

- Buses and commuter rail
- Bluebikes stations with live bike and dock counts
- Planes in and out of Logan
- Pin a station for a live countdown
