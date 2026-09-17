import { useI18n } from "../lib/i18n";
import { lazy, Suspense, useState } from "react";
import { Box, Map as MapIcon, LocateFixed, Expand, X } from "lucide-react";
import type {
  KnownLocation,
  SceneId,
} from "../../../docs/engineering_v0.5/contracts/public.types";
import { mapData, locationPoint } from "../lib/map";
const Map3D = lazy(() => import("./Map3D"));
export function TacticalMap({
  location,
  sceneId,
  large = false,
}: {
  location: KnownLocation;
  sceneId: SceneId | null;
  large?: boolean;
}) {
  const { t, nodeLabel } = useI18n();
  const [three, setThree] = useState(true),
    [expanded, setExpanded] = useState(false);
  return (
    <section
      className={`tactical-map ${large ? "large" : ""} ${expanded ? "expanded" : ""}`}
      aria-label={t("ui.convoyTerrainModel")}
    >
      <div className="map-heading">
        <div>
          <span className="eyebrow">SAHEL VALLEY / OPERATIONS MAP</span>
          <h3>{t("ui.valleyOverview")}</h3>
        </div>
        <div className="map-tools">
          <button
            className={!three ? "active" : ""}
            onClick={() => setThree(false)}
            title={t("ui.2dRouteMap")}
            aria-label={t("ui.2dRouteMap")}
          >
            <MapIcon size={16} />
          </button>
          <button
            className={three ? "active" : ""}
            onClick={() => setThree(true)}
            title={t("ui.3dTerrainModel")}
            aria-label={t("ui.3dTerrainModel")}
          >
            <Box size={16} />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            title={expanded ? t("ui.collapseMap") : t("ui.expandMap")}
            aria-label={expanded ? t("ui.collapseMap") : t("ui.expandMap")}
          >
            {expanded ? <X size={16} /> : <Expand size={16} />}
          </button>
        </div>
      </div>
      <div className="map-viewport">
        {three ? (
          <Suspense
            fallback={
              <div className="map-loading">
                <span className="spinner" /> {t("ui.loadingTerrain")}{" "}
              </div>
            }
          >
            <Map3D location={location} onFailure={() => setThree(false)} />
          </Suspense>
        ) : (
          <Map2D location={location} sceneId={sceneId} />
        )}
        <span className="map-north">
          N <i>↑</i>
        </span>
      </div>
      <div className="map-caption">
        <span>
          <LocateFixed size={13} />
          <b>
            {location.nodeId ? nodeLabel(location.nodeId) : t("map.inTransit")}
          </b>
        </span>
        <span>
          {three
            ? t("ui.dragToRotateScrollToZoom")
            : t("ui.routeDiagramNotLiveReconnaissance")}
        </span>
      </div>
    </section>
  );
}
export function Map2D({
  location,
  sceneId,
}: {
  location: KnownLocation;
  sceneId: SceneId | null;
}) {
  const { t, nodeLabel } = useI18n();
  const p = locationPoint(location),
    xy = (p: number[]) => [70 + (p[0] + 17) * 15, 48 + (p[2] + 10) * 13];
  const [cx, cy] = xy(p);
  return (
    <svg
      className="map2d"
      viewBox="0 0 620 330"
      role="img"
      aria-label={t("ui.publicRouteMapAndCurrentConvoyPosition")}
    >
      <defs>
        <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">
          <path
            d="M30 0H0V30"
            fill="none"
            stroke="#97b5a2"
            strokeOpacity=".09"
          />
        </pattern>
        <radialGradient id="glow">
          <stop stopColor="#6b947e" stopOpacity=".13" />
          <stop offset="1" stopColor="#6b947e" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="620" height="330" fill="#15201d" />
      <rect width="620" height="330" fill="url(#grid)" />
      <ellipse cx="260" cy="130" rx="240" ry="150" fill="url(#glow)" />
      <path
        d="M379 -10C336 55 421 94 390 153S368 255 426 350"
        stroke="#334e49"
        strokeWidth="31"
        fill="none"
      />
      <path
        d="M379 -10C336 55 421 94 390 153S368 255 426 350"
        stroke="#6b9990"
        strokeOpacity=".3"
        strokeDasharray="3 6"
        fill="none"
      />
      {[0, 1, 2, 3].map((i) => (
        <path
          key={i}
          d={`M${i * 23 - 80} 70 Q90 ${-i * 22 - 40} 240 ${i * 12 + 22} T600 55`}
          fill="none"
          stroke="#c2b58b"
          strokeOpacity=".1"
        />
      ))}
      {mapData.routes.map((r) => (
        <polyline
          key={r.routeId}
          points={r.waypoints.map((p) => xy(p).join(",")).join(" ")}
          fill="none"
          stroke={
            r.routeId === location.routeId
              ? "#edbc76"
              : r.enabled
                ? "#77988a"
                : "#3e5149"
          }
          strokeWidth={r.routeId === location.routeId ? 3 : 1.7}
          strokeDasharray={r.enabled ? undefined : "3 4"}
        />
      ))}
      {mapData.nodes.map((n) => {
        const [x, y] = xy(n.position),
          active = n.sceneId === sceneId,
          major = !!n.sceneId || ["N00", "N07"].includes(n.nodeId);
        return (
          <g key={n.nodeId}>
            <circle
              cx={x}
              cy={y}
              r={active ? 7 : major ? 4 : 2.5}
              fill={
                active ? "#d6af73" : n.nodeId === "N07" ? "#a2c6b2" : "#5d7b6b"
              }
            />
            {major && (
              <>
                <text
                  x={x}
                  y={y - 12}
                  textAnchor="middle"
                  fill={active ? "#f0d5ac" : "#a3b5a8"}
                  fontSize="10"
                  fontFamily="system-ui"
                >
                  {nodeLabel(n.nodeId)}
                </text>
                <text
                  x={x}
                  y={y + 17}
                  textAnchor="middle"
                  fill="#658573"
                  fontSize="8"
                >
                  {n.nodeId}
                </text>
              </>
            )}
          </g>
        );
      })}
      <circle
        cx={cx}
        cy={cy}
        r="12"
        fill="none"
        stroke="#f4c685"
        strokeOpacity=".5"
      />
      <circle
        cx={cx}
        cy={cy}
        r="5"
        fill="#ffe4b5"
        stroke="#705736"
        strokeWidth="2"
      />
      <text x="477" y="308" fill="#668776" fontSize="8" letterSpacing="3">
        WADI / SECTOR 07
      </text>
    </svg>
  );
}
