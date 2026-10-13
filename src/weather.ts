// Current weather in Boston from Open-Meteo (free, no key), and rain or snow
// drawn over the map to match it.

export type WeatherKind = 'clear' | 'clouds' | 'fog' | 'rain' | 'snow' | 'storm';

export interface Weather {
  kind: WeatherKind;
  /** 0–1: drizzle to downpour, flurries to heavy snow. */
  intensity: number;
  /** 0–1 cloud cover; dims the daylight. */
  cloud: number;
  label: string;
  tempF: number | null;
  /** Where the wind blows from, degrees clockwise from north, and its speed in m/s. */
  windFrom: number;
  wind: number;
}

export const CLEAR: Weather = { kind: 'clear', intensity: 0, cloud: 0, label: '', tempF: null, windFrom: 270, wind: 3 };

/** WMO weather codes, as Open-Meteo reports them. */
function describe(code: number): Pick<Weather, 'kind' | 'intensity' | 'label'> {
  if (code === 0) return { kind: 'clear', intensity: 0, label: 'Clear' };
  if (code <= 2) return { kind: 'clouds', intensity: 0, label: 'Partly cloudy' };
  if (code === 3) return { kind: 'clouds', intensity: 0, label: 'Overcast' };
  if (code === 45 || code === 48) return { kind: 'fog', intensity: 0.7, label: 'Fog' };
  if (code >= 51 && code <= 57) return { kind: 'rain', intensity: 0.25, label: 'Drizzle' };
  if (code === 61 || code === 80) return { kind: 'rain', intensity: 0.4, label: 'Light rain' };
  if (code === 63 || code === 81 || code === 66) return { kind: 'rain', intensity: 0.65, label: 'Rain' };
  if (code === 65 || code === 82 || code === 67) return { kind: 'rain', intensity: 1, label: 'Heavy rain' };
  if (code === 71 || code === 77 || code === 85) return { kind: 'snow', intensity: 0.35, label: 'Light snow' };
  if (code === 73) return { kind: 'snow', intensity: 0.65, label: 'Snow' };
  if (code === 75 || code === 86) return { kind: 'snow', intensity: 1, label: 'Heavy snow' };
  if (code >= 95) return { kind: 'storm', intensity: 1, label: 'Thunderstorms' };
  return { kind: 'clouds', intensity: 0, label: '' };
}

export async function loadWeather(): Promise<Weather> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: '42.3601',
    longitude: '-71.0589',
    current: 'temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'ms',
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const c = (await res.json()).current;
  return {
    ...describe(c.weather_code),
    cloud: (c.cloud_cover ?? 0) / 100,
    tempF: c.temperature_2m ?? null,
    windFrom: c.wind_direction_10m ?? 270,
    wind: c.wind_speed_10m ?? 3,
  };
}

/** For trying the effects: `?weather=snow` (or rain, storm, fog, clear). */
export function weatherOverride(): Weather | null {
  const kind = new URLSearchParams(location.search).get('weather') as WeatherKind | null;
  if (!kind || !['clear', 'clouds', 'fog', 'rain', 'snow', 'storm'].includes(kind)) return null;
  const label = { clear: 'Clear', clouds: 'Overcast', fog: 'Fog', rain: 'Rain', snow: 'Snow', storm: 'Thunderstorms' }[kind];
  return { ...CLEAR, kind, label, intensity: kind === 'clear' || kind === 'clouds' ? 0 : 0.8, cloud: kind === 'clear' ? 0 : 0.9, wind: 6 };
}

// ---------------------------------------------------------------------------
// Precipitation over the map, on a plain 2D canvas: cheap, and it reads as
// weather in front of the camera rather than something on the ground.

interface Particle {
  x: number;
  y: number;
  speed: number;
  size: number;
  phase: number;
}

export class Precipitation {
  private readonly ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private weather: Weather = CLEAR;
  private flash = 0;
  private nextFlash = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener('resize', resize);
  }

  /** Whether to draw anything at all; the weather is still tracked when off. */
  enabled = true;

  set(weather: Weather) {
    this.weather = weather;
    const falling = weather.kind === 'rain' || weather.kind === 'storm' || weather.kind === 'snow';
    const n = falling ? Math.round((weather.kind === 'snow' ? 160 : 220) * (0.35 + 0.65 * weather.intensity)) : 0;
    this.particles = Array.from({ length: n }, () => this.spawn(true));
  }

  private spawn(anywhere: boolean): Particle {
    const snow = this.weather.kind === 'snow';
    return {
      x: Math.random() * (innerWidth + 200) - 100,
      y: anywhere ? Math.random() * innerHeight : -20,
      speed: snow ? 30 + Math.random() * 50 : 700 + Math.random() * 500,
      size: snow ? 0.8 + Math.random() * 1.6 : 12 + Math.random() * 12,
      phase: Math.random() * Math.PI * 2,
    };
  }

  /**
   * Advances and draws one frame. `bearing` is the map's, so the wind blows
   * the same way on screen as it does over the city.
   */
  frame(dt: number, bearing: number, now: number) {
    const { ctx, weather } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!this.enabled) return;
    const snow = weather.kind === 'snow';
    // Screen-space sideways drift from the wind, relative to the camera.
    const toward = ((weather.windFrom + 180 - bearing) * Math.PI) / 180;
    const drift = Math.sin(toward) * Math.min(1, weather.wind / 12);

    if (this.particles.length) {
      ctx.strokeStyle = 'rgba(200,215,255,0.16)';
      ctx.fillStyle = 'rgba(240,245,255,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of this.particles) {
        if (snow) {
          p.y += p.speed * dt;
          p.x += (drift * 40 + Math.sin(now / 900 + p.phase) * 18) * dt;
          ctx.moveTo(p.x + p.size, p.y);
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        } else {
          p.y += p.speed * dt;
          p.x += drift * p.speed * 0.25 * dt;
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - drift * p.size * 0.25, p.y - p.size);
        }
        if (p.y > innerHeight + 20 || p.x < -120 || p.x > innerWidth + 120) Object.assign(p, this.spawn(false));
      }
      if (snow) ctx.fill();
      else ctx.stroke();
    }

    // Lightning: a quick double flash every so often.
    if (weather.kind === 'storm') {
      if (now > this.nextFlash) {
        this.flash = 1;
        this.nextFlash = now + 6000 + Math.random() * 14000;
      }
      if (this.flash > 0) {
        const a = this.flash > 0.6 ? 0.18 : this.flash > 0.4 ? 0 : this.flash * 0.25;
        ctx.fillStyle = `rgba(220,230,255,${a})`;
        ctx.fillRect(0, 0, innerWidth, innerHeight);
        this.flash -= dt * 2.5;
      }
    }
  }
}
