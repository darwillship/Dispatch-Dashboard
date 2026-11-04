// Test helper: a synthetic truck day from a list of stops (stationary plots every 30 s) joined by driving plots.
import * as M from "../match.ts";
export interface Halt { lat: number; lon: number; from: string; to: string | null; addr?: string; engineOff?: boolean }
const T = (s: string) => Date.parse(s);
export function track(halts: Halt[], end: string): M.Ev[] {
  const plots: M.Plot[] = [];
  const segs: M.Seg[] = [];
  const endT = T(end);
  // driving in from somewhere before the first halt (so the first visit is not "clipped")
  const h0 = halts[0];
  for (let k = 5; k >= 1; k--) plots.push({ t: T(h0.from) - k * 60_000, lat: h0.lat + 0.02 * k, lon: h0.lon + 0.02 * k, speed: 60 });
  halts.forEach((h, i) => {
    const a = T(h.from), d = h.to ? T(h.to) : endT;
    for (let t = a; h.to ? t < d : t <= d; t += 30_000) plots.push({ t, lat: h.lat, lon: h.lon, speed: 0, addr: h.addr ?? null });
    if (h.engineOff) segs.push({ start: d, end: null, complete: false, sLat: h.lat, sLon: h.lon } as any);
    const n = halts[i + 1];
    if (h.to && n) {
      const d0 = T(h.to), d1 = T(n.from) - 30_000;
      const steps = Math.max(1, Math.floor((d1 - d0) / 60_000));
      for (let k = 0; k <= steps; k++) {
        const f = (k + 1) / (steps + 2);
        plots.push({ t: d0 + ((d1 - d0) * k) / steps, lat: h.lat + (n.lat - h.lat) * f, lon: h.lon + (n.lon - h.lon) * f + 0.003, speed: 55 });
      }
    }
  });
  return M.buildTimeline(plots.sort((x, y) => x.t - y.t), []);
}
export const ct = (t: number | null | undefined) => M.ctClock(t);
