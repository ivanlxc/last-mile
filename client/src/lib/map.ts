import data from "./map-data.json";
import type { KnownLocation } from "../../../docs/engineering_v0.5/contracts/public.types";
export { data as mapData };
export function pointOnRoute(
  points: number[][],
  fraction: number,
): [number, number, number] {
  if (!points.length) return [0, 0, 0];
  if (points.length === 1) return [...points[0]] as [number, number, number];
  if (fraction <= 0) return [...points[0]] as [number, number, number];
  if (fraction >= 1) return [...points.at(-1)!] as [number, number, number];
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(...p.map((n, j) => n - points[i][j])));
  let remaining =
    lengths.reduce((a, b) => a + b, 0) * Math.min(1, Math.max(0, fraction));
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] ? remaining / lengths[i] : 0;
      return points[i].map((n, j) => n + (points[i + 1][j] - n) * t) as [
        number,
        number,
        number,
      ];
    }
    remaining -= lengths[i];
  }
  return [...points.at(-1)!] as [number, number, number];
}
export function locationPoint(
  location: KnownLocation,
): [number, number, number] {
  if (location.routeId) {
    const r = data.routes.find((r) => r.routeId === location.routeId);
    if (r) return pointOnRoute(r.waypoints, location.progressPermille / 1000);
  }
  return (data.nodes.find((n) => n.nodeId === location.nodeId)?.position ??
    data.nodes[0].position) as [number, number, number];
}
