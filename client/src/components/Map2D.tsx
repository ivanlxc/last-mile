import { useEffect, useId, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import type {
  KnownLocation,
  SceneId,
} from "../../../docs/engineering_v0.5/contracts/public.types";
import { useI18n } from "../lib/i18n";
import { locationPoint, mapData } from "../lib/map";
import { mapRendererCopy } from "../lib/mapRendererCopy";
import "./map-2d.css";

// The orthographic terrain image uses GLB X right, Z south. This projection is
// shared by the imagery, public route geometry, locations and convoy position.
const WIDTH = 1536;
const HEIGHT = 1024;
const MAX_ZOOM = 4;
const project = (point: number[]) => [
  (point[0] + 24) * 32,
  (point[2] + 16) * 32,
];
type View = { zoom: number; x: number; y: number };
const initialView: View = { zoom: 1, x: 0, y: 0 };
type Frame = { width: number; height: number; pixelScale: number };
const initialFrame: Frame = {
  width: WIDTH,
  height: HEIGHT,
  pixelScale: 1,
};

export function Map2D({
  location,
  sceneId,
  onSelectLocation,
  selectedNodeId = null,
  active = true,
  inputBlocked = false,
}: {
  location: KnownLocation;
  sceneId: SceneId | null;
  onSelectLocation?: (nodeId: string) => void;
  selectedNodeId?: string | null;
  active?: boolean;
  inputBlocked?: boolean;
}) {
  const { t, nodeLabel, locale } = useI18n();
  const copy = mapRendererCopy(locale);
  const edgeId = useId();
  const container = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [imageStatus, setImageStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [frame, setFrame] = useState(initialFrame);
  const [view, setView] = useState(initialView);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    point: DOMPoint;
    view: View;
  } | null>(null);
  const dragged = useRef(false);
  const interactive = !!onSelectLocation;
  const canInteract = interactive && active && !inputBlocked;
  const compact = frame.width * frame.pixelScale < 600;
  // Fill the viewport, but retain every public location even in a wide panel.
  // Empty margins on unusually wide views use the same subdued earth tone.
  const fit = Math.min(1, frame.width / 1280, frame.height / 640);
  const scale = fit * view.zoom;
  const symbolScale = 1 / (scale * frame.pixelScale);
  const [cx, cy] = project(locationPoint(location));

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const pixelScale = Math.max(width / WIDTH, height / HEIGHT);
      setFrame({
        width: width / pixelScale,
        height: height / pixelScale,
        pixelScale,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const bounded = (next: View): View => {
    const extentX = Math.max(0, (WIDTH * fit * next.zoom - frame.width) / 2);
    const extentY = Math.max(0, (HEIGHT * fit * next.zoom - frame.height) / 2);
    return {
      ...next,
      x: Math.max(-extentX, Math.min(extentX, next.x)),
      y: Math.max(-extentY, Math.min(extentY, next.y)),
    };
  };
  useEffect(() => {
    setView((previous) => bounded(previous));
  }, [frame.width, frame.height, fit]);

  const pointerPoint = (clientX: number, clientY: number) => {
    const matrix = svg.current?.getScreenCTM();
    return matrix
      ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
      : null;
  };
  const zoomAt = (
    factor: number,
    point = new DOMPoint(WIDTH / 2, HEIGHT / 2),
  ) =>
    setView((previous) => {
      const zoom = Math.max(1, Math.min(MAX_ZOOM, previous.zoom * factor));
      const ratio = zoom / previous.zoom;
      return bounded({
        zoom,
        x: point.x - WIDTH / 2 - (point.x - WIDTH / 2 - previous.x) * ratio,
        y: point.y - HEIGHT / 2 - (point.y - HEIGHT / 2 - previous.y) * ratio,
      });
    });

  useEffect(() => {
    const element = svg.current;
    if (!element || !canInteract) return;
    const wheel = (event: WheelEvent) => {
      const point = pointerPoint(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1);
      zoomAt(Math.exp(-Math.max(-600, Math.min(600, delta)) * 0.0015), point);
    };
    // A non-passive listener keeps wheel navigation inside the map instead of
    // scrolling the surrounding briefing or report page at the same time.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [canInteract, frame.width, frame.height, fit]);

  useEffect(() => {
    if (canInteract) return;
    drag.current = null;
    setDragging(false);
  }, [canInteract]);

  return (
    <div
      ref={container}
      className={`satellite-map ${interactive ? "interactive" : "static"} ${dragging ? "dragging" : ""}`}
      data-imagery={imageStatus}
      data-compact={compact}
    >
      <svg
        ref={svg}
        className="map2d"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid slice"
        role={interactive ? "group" : "img"}
        aria-label={t("ui.publicRouteMapAndCurrentConvoyPosition")}
        onPointerDown={(event) => {
          if (!canInteract || event.button !== 0) return;
          const point = pointerPoint(event.clientX, event.clientY);
          if (!point) return;
          dragged.current = false;
          drag.current = { pointerId: event.pointerId, point, view };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!canInteract || !start || start.pointerId !== event.pointerId)
            return;
          const point = pointerPoint(event.clientX, event.clientY);
          if (!point) return;
          const dx = point.x - start.point.x;
          const dy = point.y - start.point.y;
          if (!dragged.current && Math.hypot(dx, dy) * frame.pixelScale < 5)
            return;
          if (!dragged.current) {
            event.currentTarget.setPointerCapture(event.pointerId);
            dragged.current = true;
            setDragging(true);
          }
          event.preventDefault();
          setView(
            bounded({
              ...start.view,
              x: start.view.x + dx,
              y: start.view.y + dy,
            }),
          );
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <defs>
          <linearGradient id={`${edgeId}-left`}>
            <stop stopColor="var(--satellite-earth)" />
            <stop
              offset="1"
              stopColor="var(--satellite-earth)"
              stopOpacity="0"
            />
          </linearGradient>
          <linearGradient id={`${edgeId}-right`}>
            <stop stopColor="var(--satellite-earth)" stopOpacity="0" />
            <stop offset="1" stopColor="var(--satellite-earth)" />
          </linearGradient>
        </defs>
        <g
          className="satellite-world"
          transform={`translate(${WIDTH / 2 + view.x} ${HEIGHT / 2 + view.y}) scale(${scale}) translate(${-WIDTH / 2} ${-HEIGHT / 2})`}
          data-zoom={view.zoom.toFixed(4)}
        >
          <rect width={WIDTH} height={HEIGHT} className="satellite-fallback" />
          {imageStatus !== "error" && (
            <image
              className="satellite-imagery"
              href="/assets/valley-satellite-v1.webp"
              width={WIDTH}
              height={HEIGHT}
              preserveAspectRatio="none"
              onLoad={() => setImageStatus("ready")}
              onError={() => setImageStatus("error")}
              aria-hidden="true"
            />
          )}
          <g pointerEvents="none" aria-hidden="true">
            <rect width="40" height={HEIGHT} fill={`url(#${edgeId}-left)`} />
            <rect
              x={WIDTH - 40}
              width="40"
              height={HEIGHT}
              fill={`url(#${edgeId}-right)`}
            />
          </g>
          <g className="satellite-routes" aria-hidden="true">
            {mapData.routes.map((route) => (
              <polyline
                key={route.routeId}
                data-route-id={route.routeId}
                className={`satellite-route ${route.enabled ? "" : "secondary"} ${route.routeId === location.routeId ? "current" : ""}`}
                points={route.waypoints
                  .map((point) => project(point).join(","))
                  .join(" ")}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
          {mapData.nodes.map((node) => {
            const [x, y] = project(node.position);
            const current = sceneId !== null && node.sceneId === sceneId;
            const selected = node.nodeId === selectedNodeId;
            const major =
              !!node.sceneId || ["N00", "N07"].includes(node.nodeId);
            return (
              <g
                key={node.nodeId}
                data-node-id={node.nodeId}
                className={`satellite-node ${current ? "current" : ""} ${selected ? "selected" : ""} ${major || selected || view.zoom >= 1.75 ? "labelled" : ""}`}
                transform={`translate(${x} ${y}) scale(${symbolScale})`}
                role={interactive ? "button" : undefined}
                tabIndex={canInteract ? 0 : undefined}
                aria-label={interactive ? nodeLabel(node.nodeId) : undefined}
                aria-pressed={interactive ? selected : undefined}
                onClick={() => {
                  if (canInteract && !dragged.current)
                    onSelectLocation?.(node.nodeId);
                }}
                onKeyDown={(event) => {
                  if (
                    canInteract &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    onSelectLocation?.(node.nodeId);
                  }
                }}
              >
                <title>
                  {node.nodeId} · {nodeLabel(node.nodeId)}
                </title>
                {interactive && <circle className="satellite-hit" r={15} />}
                <circle className="satellite-node-ring" r={9} />
                <circle
                  className="satellite-node-dot"
                  r={current ? 4.8 : major ? 3.6 : 2.8}
                />
                <text
                  className="satellite-node-label"
                  y={-14}
                  textAnchor="middle"
                >
                  {compact && !current && !selected
                    ? node.nodeId
                    : nodeLabel(node.nodeId)}
                </text>
              </g>
            );
          })}
          <g
            className="satellite-convoy"
            transform={`translate(${cx} ${cy})`}
            aria-hidden="true"
          >
            <g transform={`scale(${symbolScale})`}>
              <circle className="satellite-convoy-halo" r={12} />
              <circle className="satellite-convoy-dot" r={5} />
            </g>
          </g>
        </g>
      </svg>
      {imageStatus === "error" && (
        <span className="satellite-image-status" role="status">
          {copy.terrainUnavailable}
        </span>
      )}
      {interactive && (
        <>
          <div
            className="satellite-navigation"
            role="group"
            aria-label={copy.mapNavigation}
          >
            <button
              aria-label={copy.zoomIn}
              title={copy.zoomIn}
              disabled={!canInteract || view.zoom >= MAX_ZOOM}
              onClick={() => zoomAt(1.4)}
            >
              <Plus size={17} />
            </button>
            <button
              aria-label={copy.zoomOut}
              title={copy.zoomOut}
              disabled={!canInteract || view.zoom <= 1}
              onClick={() => zoomAt(1 / 1.4)}
            >
              <Minus size={17} />
            </button>
            <button
              aria-label={copy.resetMap}
              title={copy.resetMap}
              disabled={!canInteract}
              onClick={() => setView(initialView)}
            >
              <RotateCcw size={15} />
            </button>
          </div>
          <span className="satellite-map-hint" aria-hidden="true">
            {copy.satelliteControls}
          </span>
        </>
      )}
    </div>
  );
}
