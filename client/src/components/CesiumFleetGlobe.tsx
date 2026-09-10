import { useEffect, useRef } from "react";
import Cartesian3 from "@cesium/engine/Source/Core/Cartesian3.js";
import Color from "@cesium/engine/Source/Core/Color.js";
import CesiumMath from "@cesium/engine/Source/Core/Math.js";
import ScreenSpaceEventType from "@cesium/engine/Source/Core/ScreenSpaceEventType.js";
import CesiumWidget from "@cesium/engine/Source/Widget/CesiumWidget.js";
import ImageryLayer from "@cesium/engine/Source/Scene/ImageryLayer.js";
import OpenStreetMapImageryProvider from "@cesium/engine/Source/Scene/OpenStreetMapImageryProvider.js";
import PointPrimitiveCollection from "@cesium/engine/Source/Scene/PointPrimitiveCollection.js";
import {
  integrityColor,
  isRenderablePosition,
  type DurableTrackingPosition,
} from "./vehicleTrackingMapModel";

export type CesiumFleetGlobeProps = {
  positions: DurableTrackingPosition[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

function colorFromHex(hex: string) {
  return Color.fromCssColorString(hex);
}

/**
 * An explicitly selected, terrain-free 3D view. It intentionally uses only
 * CesiumWidget plus point primitives: no Ion token, geocoder, buildings,
 * terrain, timeline, or base-layer picker is loaded into the 3D route.
 */
export default function CesiumFleetGlobe({ positions, selectedId, onSelect }: CesiumFleetGlobeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<CesiumWidget | null>(null);
  const pointsRef = useRef<PointPrimitiveCollection | null>(null);

  useEffect(() => {
    if (!containerRef.current || widgetRef.current) return;
    (window as Window & { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = "/cesium";

    const widget = new CesiumWidget(containerRef.current, {
      baseLayer: new ImageryLayer(
        new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
      ),
      creditContainer: document.createElement("div"),
      useDefaultRenderLoop: true,
    });
    widget.scene.globe.depthTestAgainstTerrain = false;
    // The operational fleet globe intentionally omits decorative scene assets.
    // OSM supplies the only imagery; disabling these features keeps the 3D view
    // self-hostable without a multi-megabyte sky/terrain texture catalog.
    widget.scene.globe.showWaterEffect = false;
    widget.scene.globe.enableLighting = false;
    widget.scene.skyBox = undefined;
    widget.scene.skyAtmosphere.show = false;
    widget.scene.moon.show = false;
    widget.scene.sun.show = false;

    const points = new PointPrimitiveCollection();
    widget.scene.primitives.add(points);
    widget.screenSpaceEventHandler.setInputAction((movement) => {
      const picked = widget.scene.pick(movement.position);
      const id = picked?.primitive?.id;
      if (typeof id === "string") onSelect(id);
    }, ScreenSpaceEventType.LEFT_CLICK);

    widgetRef.current = widget;
    pointsRef.current = points;
    return () => {
      widget.destroy();
      widgetRef.current = null;
      pointsRef.current = null;
    };
  }, [onSelect]);

  useEffect(() => {
    const widget = widgetRef.current;
    const points = pointsRef.current;
    if (!widget || !points) return;

    points.removeAll();
    const renderable = positions.filter(isRenderablePosition);
    for (const position of renderable) {
      points.add({
        id: position.work_order_id,
        position: Cartesian3.fromDegrees(position.longitude, position.latitude, 30),
        color: colorFromHex(integrityColor(position.integrity_score)),
        pixelSize: position.work_order_id === selectedId ? 16 : 10,
        outlineColor: Color.WHITE,
        outlineWidth: position.work_order_id === selectedId ? 3 : 1,
      });
    }

    if (renderable.length && !selectedId) {
      const first = renderable[0];
      void widget.camera.flyTo({
        destination: Cartesian3.fromDegrees(first.longitude, first.latitude, 12_000),
        orientation: { heading: 0, pitch: CesiumMath.toRadians(-55), roll: 0 },
        duration: 0,
      });
    }
  }, [positions, selectedId]);

  return (
    <div
      ref={containerRef}
      className="h-[420px] w-full bg-slate-950"
      aria-label="3D authorized fleet tracking globe"
    />
  );
}
