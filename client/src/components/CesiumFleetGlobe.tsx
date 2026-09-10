import { useEffect, useRef } from "react";
import {
  Cartesian3,
  Color,
  createOsmBuildingsAsync,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  PointPrimitiveCollection,
  ScreenSpaceEventType,
  Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
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

export default function CesiumFleetGlobe({ positions, selectedId, onSelect }: CesiumFleetGlobeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const pointsRef = useRef<PointPrimitiveCollection | null>(null);

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;
    // Static Cesium assets are copied to /cesium at build time. No Cesium ion token is used.
    (window as Window & { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = "/cesium";
    Ion.defaultAccessToken = "";
    const viewer = new Viewer(containerRef.current, {
      animation: false,
      baseLayer: new ImageryLayer(new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: true,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: true,
      timeline: false,
    });
    viewer.scene.globe.depthTestAgainstTerrain = false;
    void createOsmBuildingsAsync()
      .then((buildings) => {
        if (!viewer.isDestroyed()) viewer.scene.primitives.add(buildings);
      })
      .catch(() => undefined);
    const points = new PointPrimitiveCollection();
    viewer.scene.primitives.add(points);
    viewer.screenSpaceEventHandler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.position);
      const id = picked?.primitive?.id;
      if (typeof id === "string") onSelect(id);
    }, ScreenSpaceEventType.LEFT_CLICK);
    viewerRef.current = viewer;
    pointsRef.current = points;
    return () => {
      viewer.destroy();
      viewerRef.current = null;
      pointsRef.current = null;
    };
  }, [onSelect]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const points = pointsRef.current;
    if (!viewer || !points) return;
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
      void viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(first.longitude, first.latitude, 12_000),
        orientation: { heading: 0, pitch: CesiumMath.toRadians(-55), roll: 0 },
        duration: 0,
      });
    }
  }, [positions, selectedId]);

  return <div ref={containerRef} className="h-[420px] w-full bg-slate-950" aria-label="3D authorized fleet tracking globe" />;
}
