import { useI18n } from "../lib/i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Box,
  Map as MapIcon,
  LocateFixed,
  Expand,
  X,
  MapPin,
} from "lucide-react";
import type {
  KnownLocation,
  SceneId,
} from "../../../docs/engineering_v0.5/contracts/public.types";
import { mapData } from "../lib/map";
import { UnityMapSlot, useMapRenderer } from "../lib/mapRenderer";
import { mapRendererCopy } from "../lib/mapRendererCopy";
import { Modal } from "./Modal";
import { Map2D } from "./Map2D";
export { Map2D } from "./Map2D";
const Map3D = lazy(() => import("./Map3D"));
export function TacticalMap({
  location,
  sceneId,
  large = false,
  stage = false,
  onInvestigate,
}: {
  location: KnownLocation;
  sceneId: SceneId | null;
  large?: boolean;
  stage?: boolean;
  onInvestigate?: () => void;
}) {
  const { t, nodeLabel, locale } = useI18n();
  const renderer = useMapRenderer();
  const copy = mapRendererCopy(locale);
  const [expanded, setExpanded] = useState(false);
  const [setup, setSetup] = useState(false);
  const [locations, setLocations] = useState(false);
  const [threeLoaded, setThreeLoaded] = useState(renderer.mode === "three");
  useEffect(() => {
    if (renderer.mode === "three") setThreeLoaded(true);
  }, [renderer.mode]);
  const mapRoot = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = mapRoot.current;
    const expandForGestures = () => {
      if (!stage) setExpanded(true);
    };
    element?.addEventListener("last-mile-gesture-open", expandForGestures);
    // The persistent Unity view may have moved here from the briefing screen.
    if (element?.querySelector('.gesture-toggle[aria-expanded="true"]'))
      expandForGestures();
    return () =>
      element?.removeEventListener("last-mile-gesture-open", expandForGestures);
  }, []);
  const selected = mapData.nodes.find(
    (n) => n.nodeId === renderer.selectedNodeId,
  );
  const selection = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stage) selection.current?.scrollIntoView({ block: "nearest" });
  }, [renderer.selectedNodeId]);
  const three = renderer.mode === "three";
  const unity = renderer.mode === "unity";
  return (
    <section
      ref={mapRoot}
      data-map-mode={renderer.mode}
      className={`tactical-map renderer-map ${stage ? "stage-map" : ""} ${selected ? "has-selection" : ""} ${large ? "large" : ""} ${expanded ? "expanded" : ""}`}
      aria-label={t("ui.convoyTerrainModel")}
    >
      <div className="map-heading">
        <div>
          <span className="eyebrow">SAHEL VALLEY / OPERATIONS MAP</span>
          <h3>{t("ui.valleyOverview")}</h3>
        </div>
        <div className="map-tools">
          <button
            className={renderer.mode === "two" ? "active" : ""}
            aria-pressed={renderer.mode === "two"}
            onClick={() => renderer.selectMode("two")}
            title={t("ui.2dRouteMap")}
            aria-label={t("ui.2dRouteMap")}
          >
            <MapIcon size={16} />
          </button>
          <button
            className={three ? "active" : ""}
            aria-pressed={three}
            onClick={() => renderer.selectMode("three")}
            title={t("ui.3dTerrainModel")}
            aria-label={t("ui.3dTerrainModel")}
          >
            <Box size={16} />
          </button>
          <button
            className={`renderer-choice ${unity ? "active" : ""} ${renderer.availability !== "available" ? "unavailable" : ""}`}
            aria-label={copy.unity}
            aria-pressed={unity}
            onClick={() =>
              renderer.availability === "available"
                ? renderer.selectMode("unity")
                : setSetup(true)
            }
          >
            Unity
          </button>
          {stage && (
            <button
              aria-label={copy.locations}
              aria-expanded={locations}
              onClick={() => setLocations(!locations)}
              title={copy.locations}
            >
              <MapPin size={16} />
            </button>
          )}
          {!stage && (
            <button
              onClick={() => setExpanded(!expanded)}
              title={expanded ? t("ui.collapseMap") : t("ui.expandMap")}
              aria-label={expanded ? t("ui.collapseMap") : t("ui.expandMap")}
            >
              {expanded ? <X size={16} /> : <Expand size={16} />}
            </button>
          )}
        </div>
      </div>
      <div className="map-viewport">
        <div className="map-renderer-layer" hidden={!unity}>
          <UnityMapSlot />
        </div>
        {threeLoaded && (
          <div className="map-renderer-layer" hidden={!three}>
            <Suspense
              fallback={
                <div className="map-loading">
                  <span className="spinner" /> {t("ui.loadingTerrain")}
                </div>
              }
            >
              <Map3D
                location={location}
                active={three}
                inputBlocked={renderer.inputBlocked}
                onFailure={() => renderer.selectMode("two")}
              />
            </Suspense>
          </div>
        )}
        <div className="map-renderer-layer" hidden={unity || three}>
          <Map2D
            location={location}
            sceneId={sceneId}
            onSelectLocation={renderer.selectNode}
            selectedNodeId={renderer.selectedNodeId}
            active={!unity && !three}
            inputBlocked={renderer.inputBlocked}
          />
        </div>
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
          {unity
            ? copy.controls
            : three
              ? t("ui.dragToRotateScrollToZoom")
              : copy.satelliteTerrain}
        </span>
      </div>
      <div
        className={`map-engine-status ${renderer.runtimeError ? "error" : ""}`}
        role="status"
      >
        <span>
          {renderer.runtimeError
            ? copy.failed
            : renderer.checking
              ? copy.checking
              : renderer.availability === "unavailable"
                ? copy.missing
                : unity
                  ? renderer.ready
                    ? copy.ready
                    : renderer.missionStarted
                      ? copy.loadingActive
                      : copy.loading
                  : copy.available}
        </span>
        <button onClick={() => setSetup(true)}>{copy.setup}</button>
      </div>
      <div
        className="map-point-choices"
        hidden={stage && !locations}
        role="group"
        aria-label={copy.locations}
      >
        {mapData.nodes
          .filter((n) => !!n.sceneId)
          .map((node) => (
            <button
              key={node.nodeId}
              aria-pressed={renderer.selectedNodeId === node.nodeId}
              onClick={() => renderer.selectNode(node.nodeId)}
            >
              {nodeLabel(node.nodeId)}
            </button>
          ))}
      </div>
      {selected && (
        <div className="map-selection" ref={selection}>
          <div className="map-selection-title">
            <strong>{nodeLabel(selected.nodeId)}</strong>
            <span>
              {selected.nodeId} · {copy.selected}
            </span>
            <button
              onClick={() => renderer.selectNode(null)}
              aria-label={copy.closeLocation}
            >
              <X size={15} />
            </button>
          </div>
          <p>{copy.mapOnly}</p>
          {selected.sceneId &&
            (selected.sceneId === sceneId && onInvestigate ? (
              <button className="secondary" onClick={onInvestigate}>
                {copy.investigate}
              </button>
            ) : (
              <p>{copy.otherLocation}</p>
            ))}
        </div>
      )}
      {setup && (
        <Modal title={copy.setup} onClose={() => setSetup(false)}>
          <div className="unity-setup">
            <p>
              {renderer.availability === "available"
                ? copy.available
                : copy.missing}
            </p>
            {renderer.runtimeError && (
              <p role="alert">
                {copy.failed} {renderer.runtimeError}
              </p>
            )}
            <ol>
              <li>{copy.install}</li>
              <li>
                {copy.build}
                <p>
                  <code>pnpm build:unity</code>
                </p>
              </li>
            </ol>
            <p>{copy.editor}</p>
            <div className="unity-setup-actions">
              {renderer.availability === "available" && (
                <button
                  className="primary"
                  onClick={() => {
                    renderer.selectMode("unity");
                    setSetup(false);
                  }}
                >
                  {copy.useUnity}
                </button>
              )}
              <button
                className="secondary"
                disabled={renderer.checking}
                onClick={renderer.recheck}
              >
                {renderer.checking ? copy.checking : copy.recheck}
              </button>
              <button
                className="secondary"
                onClick={() => {
                  renderer.selectMode("three");
                  setSetup(false);
                }}
              >
                {copy.useMap}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
