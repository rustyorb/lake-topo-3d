import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ColorSchemeMode, TerrainGridData, TerrainShadingStyle } from '../types.js';
import { fieldFrom2D, isolines, levelRange, sampleBilinear } from '../lib/contours.js';
import { gridToLatLon } from '../lib/structure.js';
import { boostedElevation, boostedMinElevation } from '../lib/relief.js';
import type { OverlayLine, PickMode } from '../lib/overlays.js';
import { Compass, RotateCcw, Eye, Waves, Mountain, MapPin, Ruler } from 'lucide-react';

export type WaterDisplayMode = 'carved-bed' | 'translucent' | 'filled';

export interface ThermoclineBand {
  enabled: boolean;
  minFt: number;
  maxFt: number;
}

/** A marker drawn on the terrain: a structure feature or a user waypoint. */
export interface ViewerMarker {
  id: string;
  row: number;
  col: number;
  color: number;
  label: string;
  detail?: string;
  shape: 'sphere' | 'pin';
}

export interface ProbeInfo {
  elevationFt: number;
  depthFt: number;
  isWater: boolean;
  lat: number;
  lon: number;
}

const FT_PER_M = 3.28084;
const MODEL_WIDTH = 100; // scene units across the east-west extent

interface Lake3DViewerProps {
  gridData: TerrainGridData;
  verticalExaggeration: number;
  baseThicknessRatio: number;
  colorScheme: ColorSchemeMode;
  showWaterPlane: boolean;
  showWireframe: boolean;
  showSolidBase: boolean;
  showContours: boolean;
  contourIntervalFt: number;
  waterOpacity: number;
  waterMode?: WaterDisplayMode;
  waterLevelOffsetFt?: number;
  shadingStyle?: TerrainShadingStyle;
  terraceStepFt?: number;
  flatShading?: boolean;
  terrainSharpness?: number;
  /** Extra vertical multiplier on the lake bed only (1 = none). */
  depthBoost?: number;
  /** Drape the native survey contour vectors instead of re-contouring the grid (when available). */
  useSurveyContours?: boolean;
  thermocline?: ThermoclineBand;
  markers?: ViewerMarker[];
  selectedMarkerId?: string | null;
  /** What a plain click does; shift-click always drops a pin. */
  pickMode?: PickMode;
  /** Lines draped on the surface: section line, contour routes, windblown shore. */
  overlays?: OverlayLine[];
  focusRequest?: { row: number; col: number; nonce: number } | null;
  onPick?: (cell: { row: number; col: number }, mode: Exclude<PickMode, 'none'>) => void;
  onSelectMarker?: (id: string) => void;
  onUpdateShadingStyle?: (style: TerrainShadingStyle) => void;
  onUpdateTerraceStep?: (stepFt: number) => void;
  onUpdateFlatShading?: (flat: boolean) => void;
  onUpdateWaterMode?: (mode: WaterDisplayMode) => void;
  onUpdateWaterLevelOffsetFt?: (offsetFt: number) => void;
  onSetPickMode?: (mode: PickMode) => void;
  onProbeInfo?: (info: ProbeInfo | null) => void;
}

/** Scene units per metre of relief: true scale (same as horizontal) times the exaggeration. */
function verticalScale(data: TerrainGridData, exaggeration: number): number {
  const widthM = Math.max(50, (data.physicalWidthKm || 1) * 1000);
  return (MODEL_WIDTH / widthM) * Math.max(0.1, exaggeration);
}

function modelLength(data: TerrainGridData): number {
  return MODEL_WIDTH * ((data.physicalHeightKm || 1) / (data.physicalWidthKm || 1));
}

function landContourInterval(reliefFt: number): number {
  return reliefFt > 600 ? 40 : reliefFt > 250 ? 20 : 10;
}

// Navionics-style depth bands, 5 ft each, light to dark.
const CHART_BANDS = [0xd9f2ff, 0xb3e2ff, 0x8fd0ff, 0x67b8f5, 0x4a9de6, 0x3583d1, 0x2668b8, 0x1b4f9c, 0x143b7a, 0x0e2a5a, 0x081b3d];
const THERMO_TINT = new THREE.Color(0xf59e0b);

export const Lake3DViewer: React.FC<Lake3DViewerProps> = ({
  gridData,
  verticalExaggeration,
  baseThicknessRatio,
  colorScheme,
  showWaterPlane,
  showWireframe,
  showSolidBase,
  showContours,
  contourIntervalFt,
  waterOpacity,
  waterMode = 'carved-bed',
  waterLevelOffsetFt = 0,
  shadingStyle = 'faceted-topo',
  terraceStepFt = 5,
  flatShading = true,
  terrainSharpness = 1.6,
  depthBoost = 1,
  useSurveyContours = true,
  thermocline,
  markers = [],
  selectedMarkerId = null,
  pickMode = 'none' as PickMode,
  overlays = [] as OverlayLine[],
  focusRequest = null,
  onPick,
  onSelectMarker,
  onUpdateShadingStyle,
  onUpdateTerraceStep,
  onUpdateWaterMode,
  onSetPickMode,
  onProbeInfo,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const baseMeshRef = useRef<THREE.Mesh | null>(null);
  const contourGroupRef = useRef<THREE.Group | null>(null);
  const waterMeshRef = useRef<THREE.Mesh | null>(null);
  const markerGroupRef = useRef<THREE.Group | null>(null);
  const overlayGroupRef = useRef<THREE.Group | null>(null);
  const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
  const shapedRef = useRef<number[][] | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const [hoverData, setHoverData] = useState<{ x: number; y: number; elevFt: number; depthFt: number; isWater: boolean; lat: number; lon: number } | null>(null);
  const [hoverMarker, setHoverMarker] = useState<{ x: number; y: number; label: string; detail?: string } | null>(null);

  // ---- scene bootstrap
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;
    const width = containerRef.current.clientWidth || 800;
    const height = containerRef.current.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b14);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
    camera.position.set(0, 95, 150);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ canvas: canvasRef.current, antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = Math.PI / 2 + 0.05;
    controls.minDistance = 8;
    controls.maxDistance = 600;
    controls.target.set(0, 4, 0);
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xfff7ed, 1.3);
    sun.position.set(120, 200, 100);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // Three's default shadow camera is a ±5-unit box; widen it so the whole model casts shadows.
    const shadowCam = sun.shadow.camera;
    shadowCam.left = -MODEL_WIDTH * 1.1; shadowCam.right = MODEL_WIDTH * 1.1;
    shadowCam.top = MODEL_WIDTH * 1.1; shadowCam.bottom = -MODEL_WIDTH * 1.1;
    shadowCam.near = 1; shadowCam.far = 900;
    sun.shadow.bias = -0.0006;
    scene.add(sun);
    scene.add(sun.target);
    sunLightRef.current = sun;
    const fill = new THREE.DirectionalLight(0x93c5fd, 0.45);
    fill.position.set(-100, 80, -100);
    scene.add(fill);

    const gridHelper = new THREE.GridHelper(260, 26, 0x334155, 0x1e293b);
    gridHelper.position.y = -26;
    scene.add(gridHelper);

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      sceneRef.current = null;
    };
  }, []);

  // ---- background per palette
  useEffect(() => {
    if (!sceneRef.current) return;
    const bg = colorScheme === 'print-resin' ? 0xf1f5f9 : colorScheme === 'slate' ? 0x0f172a : colorScheme === 'fishing-chart' ? 0x0b1220 : 0x070b14;
    sceneRef.current.background = new THREE.Color(bg);
  }, [colorScheme]);

  const getVertexColor = (elevM: number, depthM: number, isWater: boolean, maxElev: number, waterElev: number): THREE.Color => {
    const maxDepth = Math.max(1, gridData.maxDepth);
    let col: THREE.Color;
    if (colorScheme === 'print-resin') {
      col = isWater
        ? new THREE.Color().lerpColors(new THREE.Color(0xe2e8f0), new THREE.Color(0x94a3b8), Math.min(1, depthM / maxDepth))
        : new THREE.Color(0xf8fafc);
    } else if (colorScheme === 'slate') {
      if (isWater) col = new THREE.Color().lerpColors(new THREE.Color(0x1e293b), new THREE.Color(0x020617), Math.min(1, depthM / maxDepth));
      else {
        const hRatio = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
        col = new THREE.Color().lerpColors(new THREE.Color(0x334155), new THREE.Color(0x64748b), hRatio);
      }
    } else if (colorScheme === 'fishing-chart') {
      if (isWater) {
        const band = Math.min(CHART_BANDS.length - 1, Math.floor((depthM * FT_PER_M) / 5));
        col = new THREE.Color(CHART_BANDS[band]);
      } else {
        const h = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
        col = new THREE.Color().lerpColors(new THREE.Color(0xe8dfc0), new THREE.Color(0xc9b98f), h);
      }
    } else if (colorScheme === 'bathymetric') {
      if (isWater) {
        const d = Math.min(1, depthM / maxDepth);
        if (d < 0.25) col = new THREE.Color().lerpColors(new THREE.Color(0x38bdf8), new THREE.Color(0x0284c7), d * 4);
        else if (d < 0.6) col = new THREE.Color().lerpColors(new THREE.Color(0x0284c7), new THREE.Color(0x1d4ed8), (d - 0.25) / 0.35);
        else col = new THREE.Color().lerpColors(new THREE.Color(0x1d4ed8), new THREE.Color(0x030712), (d - 0.6) / 0.4);
      } else col = new THREE.Color(0xd6d3d1);
    } else if (colorScheme === 'topographic') {
      if (isWater) col = new THREE.Color().lerpColors(new THREE.Color(0x67e8f9), new THREE.Color(0x0369a1), Math.min(1, depthM / maxDepth));
      else {
        const h = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
        if (h < 0.3) col = new THREE.Color().lerpColors(new THREE.Color(0x86efac), new THREE.Color(0xca8a04), h / 0.3);
        else if (h < 0.7) col = new THREE.Color().lerpColors(new THREE.Color(0xca8a04), new THREE.Color(0xc2410c), (h - 0.3) / 0.4);
        else col = new THREE.Color().lerpColors(new THREE.Color(0xc2410c), new THREE.Color(0x78350f), (h - 0.7) / 0.3);
      }
    } else if (colorScheme === 'satellite') {
      if (isWater) col = new THREE.Color().lerpColors(new THREE.Color(0x155e75), new THREE.Color(0x082f49), Math.min(1, depthM / maxDepth));
      else {
        const h = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
        col = new THREE.Color().lerpColors(new THREE.Color(0x2d4a22), new THREE.Color(0x57534e), h);
      }
    } else {
      // hypsometric default
      if (isWater) {
        const d = Math.min(1, depthM / maxDepth);
        if (d < 0.2) col = new THREE.Color().lerpColors(new THREE.Color(0x22d3ee), new THREE.Color(0x0ea5e9), d * 5);
        else if (d < 0.6) col = new THREE.Color().lerpColors(new THREE.Color(0x0ea5e9), new THREE.Color(0x1e40af), (d - 0.2) / 0.4);
        else col = new THREE.Color().lerpColors(new THREE.Color(0x1e40af), new THREE.Color(0x0b132b), (d - 0.6) / 0.4);
      } else {
        const hM = elevM - waterElev;
        const h = Math.min(1, hM / Math.max(1, maxElev - waterElev));
        if (hM < 1.5) col = new THREE.Color(0xfde68a);
        else if (h < 0.35) col = new THREE.Color().lerpColors(new THREE.Color(0x4ade80), new THREE.Color(0x16a34a), h / 0.35);
        else if (h < 0.7) col = new THREE.Color().lerpColors(new THREE.Color(0x16a34a), new THREE.Color(0xb45309), (h - 0.35) / 0.35);
        else col = new THREE.Color().lerpColors(new THREE.Color(0xb45309), new THREE.Color(0x7c2d12), (h - 0.7) / 0.3);
      }
    }

    // Thermocline band: warm tint on every bit of bottom inside the depth band, soft edges.
    if (isWater && thermocline?.enabled) {
      const dFt = depthM * FT_PER_M;
      const edge = 1.0;
      const inLo = Math.min(1, Math.max(0, (dFt - (thermocline.minFt - edge)) / edge));
      const inHi = Math.min(1, Math.max(0, ((thermocline.maxFt + edge) - dFt) / edge));
      const k = Math.min(inLo, inHi);
      if (k > 0) col = col.clone().lerp(THERMO_TINT, 0.6 * k);
    }
    return col;
  };

  const disposeObject = (obj: THREE.Object3D | null) => {
    if (!obj || !sceneRef.current) return;
    sceneRef.current.remove(obj);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
  };

  const xOf = (c: number) => (c / (gridData.gridSize - 1) - 0.5) * MODEL_WIDTH;
  const zOf = (r: number) => (r / (gridData.gridSize - 1) - 0.5) * modelLength(gridData);
  const yOf = (elevM: number) => (elevM - boostedMinElevation(gridData, depthBoost)) * verticalScale(gridData, verticalExaggeration);

  // ---- terrain, base and contour lines
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    disposeObject(terrainMeshRef.current); terrainMeshRef.current = null;
    disposeObject(baseMeshRef.current); baseMeshRef.current = null;
    disposeObject(contourGroupRef.current); contourGroupRef.current = null;

    const { gridSize, elevations, waterMask, depths, maxElevation, waterElevation } = gridData;
    const minElevation = boostedMinElevation(gridData, depthBoost);
    const length = modelLength(gridData);
    const zScale = verticalScale(gridData, verticalExaggeration);
    const baseBottomY = -5 * baseThicknessRatio;

    // Transformed elevation field (shading styles alter the heights). `shaped` keeps true depths for
    // contour levels; `shapedBoosted` is what the mesh is built from (bed pushed down by depthBoost).
    const shaped: number[][] = [];
    const shapedBoosted: number[][] = [];
    const stepM = (terraceStepFt || 5) * 0.3048;
    const sharp = terrainSharpness || 1.8;
    for (let r = 0; r < gridSize; r++) {
      shaped[r] = [];
      shapedBoosted[r] = [];
      for (let c = 0; c < gridSize; c++) {
        let elevM = elevations[r][c];
        let depthM = depths[r][c];
        const isWater = waterMask[r][c];
        if (shadingStyle === 'stepped-terraces') {
          if (isWater) {
            depthM = Math.floor(depthM / stepM) * stepM;
            elevM = waterElevation - depthM;
          } else {
            elevM = waterElevation + Math.floor((elevM - waterElevation) / stepM) * stepM;
          }
        } else if (shadingStyle === 'chiseled-ridges') {
          if (!isWater) {
            const maxH = Math.max(1, maxElevation - waterElevation);
            const normH = Math.min(1, Math.max(0, elevM - waterElevation) / maxH);
            elevM = waterElevation + Math.pow(normH, 1 / sharp) * maxH;
          } else {
            const maxD = Math.max(1, gridData.maxDepth);
            depthM = Math.pow(Math.min(1, depthM / maxD), 1.35) * maxD;
            elevM = waterElevation - depthM;
          }
        }
        shaped[r][c] = elevM;
        shapedBoosted[r][c] = boostedElevation(elevM, waterElevation, isWater, depthBoost);
      }
    }
    shapedRef.current = shapedBoosted;

    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const yOfLocal = (elevM: number) => (elevM - minElevation) * zScale;

    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        positions.push(xOf(c), yOfLocal(shapedBoosted[r][c]), zOf(r));
        uvs.push(c / (gridSize - 1), r / (gridSize - 1));
        // Colour from the true depth so thermocline/chart bands stay honest under terrace styling
        const col = getVertexColor(shapedBoosted[r][c], depths[r][c], waterMask[r][c], maxElevation, waterElevation);
        colors.push(col.r, col.g, col.b);
      }
    }
    for (let r = 0; r < gridSize - 1; r++) {
      for (let c = 0; c < gridSize - 1; c++) {
        const i00 = r * gridSize + c, i10 = (r + 1) * gridSize + c, i01 = r * gridSize + c + 1, i11 = (r + 1) * gridSize + c + 1;
        indices.push(i00, i10, i11, i00, i11, i01);
      }
    }
    const topGeometry = new THREE.BufferGeometry();
    topGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    topGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    topGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    topGeometry.setIndex(indices);
    const isCrisp = flatShading || shadingStyle !== 'smooth';
    const finalGeometry = isCrisp ? topGeometry.toNonIndexed() : topGeometry;
    if (isCrisp) topGeometry.dispose();
    finalGeometry.computeVertexNormals();

    const terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      wireframe: showWireframe,
      flatShading: isCrisp,
      roughness: colorScheme === 'print-resin' ? 0.35 : 0.65,
      metalness: colorScheme === 'print-resin' ? 0.05 : 0.08,
      side: THREE.DoubleSide,
    });
    const terrainMesh = new THREE.Mesh(finalGeometry, terrainMaterial);
    terrainMesh.receiveShadow = true;
    terrainMesh.castShadow = true;
    scene.add(terrainMesh);
    terrainMeshRef.current = terrainMesh;

    // Base skirt + plate
    if (showSolidBase) {
      const basePos: number[] = [];
      const baseIdx: number[] = [];
      let idx = 0;
      const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
        basePos.push(ax, ay, az, bx, by, bz, bx, baseBottomY, bz, ax, baseBottomY, az);
        baseIdx.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);
        idx += 4;
      };
      const last = gridSize - 1;
      for (let c = 0; c < last; c++) {
        quad(xOf(c), yOfLocal(shapedBoosted[0][c]), zOf(0), xOf(c + 1), yOfLocal(shapedBoosted[0][c + 1]), zOf(0));
        quad(xOf(c + 1), yOfLocal(shapedBoosted[last][c + 1]), zOf(last), xOf(c), yOfLocal(shapedBoosted[last][c]), zOf(last));
      }
      for (let r = 0; r < last; r++) {
        quad(xOf(0), yOfLocal(shapedBoosted[r + 1][0]), zOf(r + 1), xOf(0), yOfLocal(shapedBoosted[r][0]), zOf(r));
        quad(xOf(last), yOfLocal(shapedBoosted[r][last]), zOf(r), xOf(last), yOfLocal(shapedBoosted[r + 1][last]), zOf(r + 1));
      }
      basePos.push(-MODEL_WIDTH / 2, baseBottomY, -length / 2, -MODEL_WIDTH / 2, baseBottomY, length / 2, MODEL_WIDTH / 2, baseBottomY, length / 2, MODEL_WIDTH / 2, baseBottomY, -length / 2);
      baseIdx.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);
      const baseGeometry = new THREE.BufferGeometry();
      baseGeometry.setAttribute('position', new THREE.Float32BufferAttribute(basePos, 3));
      baseGeometry.setIndex(baseIdx);
      baseGeometry.computeVertexNormals();
      const baseMaterial = new THREE.MeshStandardMaterial({
        color: colorScheme === 'print-resin' ? 0xcfd8dc : 0x1e293b,
        roughness: 0.8,
        metalness: 0.1,
        wireframe: showWireframe,
        side: THREE.DoubleSide,
      });
      const baseMesh = new THREE.Mesh(baseGeometry, baseMaterial);
      baseMesh.receiveShadow = true;
      scene.add(baseMesh);
      baseMeshRef.current = baseMesh;
    }

    // Contour lines draped on the surface (grid-derived land lines; survey vectors for water when available)
    const group = new THREE.Group();
    const lift = 0.05 + zScale * 0.02;
    const dark = colorScheme === 'print-resin';
    const mkLines = (arr: number[], color: number, opacity: number) => {
      if (!arr.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })));
    };
    const pushPolyline = (target: number[], pts: Array<[number, number]>) => {
      for (let k = 1; k < pts.length; k++) {
        const [x0, y0] = pts[k - 1];
        const [x1, y1] = pts[k];
        target.push(
          xOf(x0), yOfLocal(sampleBilinear(shapedBoosted, x0, y0)) + lift, zOf(y0),
          xOf(x1), yOfLocal(sampleBilinear(shapedBoosted, x1, y1)) + lift, zOf(y1)
        );
      }
    };
    if (showContours) {
      const relFt = shaped.map((row) => row.map((e) => (e - waterElevation) * FT_PER_M));
      const field = fieldFrom2D(relFt);
      const maxLandFt = (maxElevation - waterElevation) * FT_PER_M;
      const maxDepthFt = gridData.maxDepth * FT_PER_M;
      const landInt = shadingStyle === 'stepped-terraces' ? terraceStepFt : contourIntervalFt || landContourInterval(maxLandFt);
      const surveyInt = gridData.metadata.contourIntervalFt || 5;
      const waterInt = shadingStyle === 'stepped-terraces' ? terraceStepFt : Math.min(contourIntervalFt || 5, surveyInt);
      const build = (levels: number[], indexEvery: number, colorIdx: number, colorMinor: number) => {
        const major: number[] = [];
        const minor: number[] = [];
        levels.forEach((lvl, i) => {
          const target = (i + 1) % indexEvery === 0 ? major : minor;
          for (const line of isolines(field, gridSize, gridSize, lvl)) pushPolyline(target, line);
        });
        mkLines(major, colorIdx, 0.95);
        mkLines(minor, colorMinor, 0.55);
      };
      build(levelRange(landInt, maxLandFt, landInt), 5, dark ? 0x334155 : 0x3b2a1a, dark ? 0x64748b : 0x5c3d24);

      const survey = useSurveyContours && shadingStyle !== 'stepped-terraces' ? gridData.surveyContours : undefined;
      if (survey && survey.length) {
        const major: number[] = [];
        const minor: number[] = [];
        const indexEvery = surveyInt <= 2 ? 5 : 2;
        for (const line of survey) {
          const isIndex = Math.round(line.depthFt / surveyInt) % indexEvery === 0;
          pushPolyline(isIndex ? major : minor, line.points);
        }
        mkLines(major, dark ? 0x1e3a8a : 0xbae6fd, 0.95);
        mkLines(minor, dark ? 0x3b82f6 : 0x7dd3fc, 0.6);
      } else {
        build(levelRange(waterInt, maxDepthFt, waterInt).map((d) => -d), 2, dark ? 0x1e3a8a : 0xbae6fd, dark ? 0x3b82f6 : 0x7dd3fc);
      }
    }
    // Thermocline band edges, always drawn when the band is on
    if (thermocline?.enabled) {
      const relFt = shaped.map((row) => row.map((e) => (e - waterElevation) * FT_PER_M));
      const field = fieldFrom2D(relFt);
      const edges: number[] = [];
      for (const lvl of [-thermocline.minFt, -thermocline.maxFt]) for (const line of isolines(field, gridSize, gridSize, lvl)) pushPolyline(edges, line);
      mkLines(edges, 0xfbbf24, 1);
    }
    if (group.children.length) {
      scene.add(group);
      contourGroupRef.current = group;
    }
  }, [gridData, verticalExaggeration, depthBoost, baseThicknessRatio, colorScheme, showSolidBase, showContours, contourIntervalFt, shadingStyle, terraceStepFt, flatShading, terrainSharpness, useSurveyContours, thermocline?.enabled, thermocline?.minFt, thermocline?.maxFt]);

  // ---- markers (structure features + waypoints)
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    disposeObject(markerGroupRef.current);
    markerGroupRef.current = null;
    const shaped = shapedRef.current;
    if (!shaped || !markers.length) return;
    const group = new THREE.Group();
    const n = gridData.gridSize;
    const r0 = MODEL_WIDTH * 0.011;
    const sphereGeo = new THREE.SphereGeometry(r0, 14, 10);
    const coneGeo = new THREE.ConeGeometry(r0 * 0.9, r0 * 2.6, 12);
    for (const m of markers) {
      const col = Math.max(0, Math.min(n - 1, m.col));
      const row = Math.max(0, Math.min(n - 1, m.row));
      const surfaceY = yOf(sampleBilinear(shaped, col, row));
      const selected = m.id === selectedMarkerId;
      const mat = new THREE.MeshStandardMaterial({ color: m.color, emissive: m.color, emissiveIntensity: selected ? 0.9 : 0.35, roughness: 0.4 });
      const data = { id: m.id, label: m.label, detail: m.detail };
      let mesh: THREE.Mesh;
      if (m.shape === 'pin') {
        mesh = new THREE.Mesh(coneGeo, mat);
        mesh.rotation.x = Math.PI; // point down
        mesh.position.set(xOf(col), surfaceY + r0 * 1.5, zOf(row));
        const poleGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(xOf(col), surfaceY, zOf(row)), new THREE.Vector3(xOf(col), surfaceY + r0 * 6, zOf(row))]);
        group.add(new THREE.Line(poleGeo, new THREE.LineBasicMaterial({ color: m.color })));
        const head = new THREE.Mesh(sphereGeo, mat);
        head.position.set(xOf(col), surfaceY + r0 * 6, zOf(row));
        head.userData = data;
        group.add(head);
      } else {
        mesh = new THREE.Mesh(sphereGeo, mat);
        mesh.position.set(xOf(col), surfaceY + r0 * 0.6, zOf(row));
      }
      if (selected) mesh.scale.setScalar(1.6);
      mesh.userData = data;
      group.add(mesh);
    }
    scene.add(group);
    markerGroupRef.current = group;
  }, [gridData, verticalExaggeration, depthBoost, shadingStyle, terraceStepFt, terrainSharpness, markers, selectedMarkerId]);

  // ---- overlay lines (section line, contour routes, windblown shore), draped on the boosted surface
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    disposeObject(overlayGroupRef.current);
    overlayGroupRef.current = null;
    const shaped = shapedRef.current;
    if (!shaped || !overlays.length) return;
    const group = new THREE.Group();
    const n = gridData.gridSize;
    const lift = 0.12 + verticalScale(gridData, verticalExaggeration) * 0.03;
    const dotGeo = new THREE.SphereGeometry(MODEL_WIDTH * 0.009, 12, 8);
    for (const line of overlays) {
      if (line.points.length < 2) continue;
      const pts: THREE.Vector3[] = [];
      for (const [c, r] of line.points) {
        const col = Math.max(0, Math.min(n - 1, c));
        const row = Math.max(0, Math.min(n - 1, r));
        pts.push(new THREE.Vector3(xOf(col), yOf(sampleBilinear(shaped, col, row)) + lift, zOf(row)));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const color = new THREE.Color(line.color);
      if (line.dashed) {
        const obj = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 1.4, gapSize: 0.9 }));
        obj.computeLineDistances();
        group.add(obj);
      } else {
        group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
      }
      if (line.endpoints) {
        for (const p of [pts[0], pts[pts.length - 1]]) {
          const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color }));
          dot.position.copy(p);
          group.add(dot);
        }
      }
    }
    scene.add(group);
    overlayGroupRef.current = group;
  }, [gridData, verticalExaggeration, depthBoost, shadingStyle, terraceStepFt, terrainSharpness, overlays]);

  // ---- fly to a cell
  useEffect(() => {
    if (!focusRequest || !cameraRef.current || !controlsRef.current || !shapedRef.current) return;
    const { row, col } = focusRequest;
    const target = new THREE.Vector3(xOf(col), yOf(sampleBilinear(shapedRef.current, col, row)), zOf(row));
    const cam = cameraRef.current;
    const ctl = controlsRef.current;
    const offset = new THREE.Vector3(MODEL_WIDTH * 0.14, MODEL_WIDTH * 0.2, MODEL_WIDTH * 0.26);
    ctl.target.copy(target);
    cam.position.copy(target.clone().add(offset));
    ctl.update();
  }, [focusRequest?.nonce]);

  // ---- wireframe toggle without rebuilding geometry
  useEffect(() => {
    for (const mesh of [terrainMeshRef.current, baseMeshRef.current]) {
      if (mesh) (mesh.material as THREE.MeshStandardMaterial).wireframe = showWireframe;
    }
  }, [showWireframe]);

  // ---- water surface
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    disposeObject(waterMeshRef.current);
    waterMeshRef.current = null;
    if (!showWaterPlane || waterMode === 'carved-bed') return;

    const { gridSize, elevations, waterElevation } = gridData;
    const minElevation = boostedMinElevation(gridData, depthBoost);
    const length = modelLength(gridData);
    const zScale = verticalScale(gridData, verticalExaggeration);
    const targetWaterElev = waterElevation + (waterLevelOffsetFt || 0) * 0.3048;
    const waterY = (targetWaterElev - minElevation) * zScale + 0.02;

    const pos: number[] = [];
    const idx: number[] = [];
    const map: number[][] = [];
    let v = 0;
    for (let r = 0; r < gridSize; r++) {
      map[r] = [];
      for (let c = 0; c < gridSize; c++) {
        // A cell is flooded if its bed is below the (possibly drawn-down or raised) pool elevation
        if (elevations[r][c] <= targetWaterElev) {
          pos.push((c / (gridSize - 1) - 0.5) * MODEL_WIDTH, waterY, (r / (gridSize - 1) - 0.5) * length);
          map[r][c] = v++;
        } else map[r][c] = -1;
      }
    }
    for (let r = 0; r < gridSize - 1; r++) {
      for (let c = 0; c < gridSize - 1; c++) {
        const i00 = map[r][c], i10 = map[r + 1][c], i01 = map[r][c + 1], i11 = map[r + 1][c + 1];
        if (i00 >= 0 && i10 >= 0 && i11 >= 0) idx.push(i00, i10, i11);
        if (i00 >= 0 && i11 >= 0 && i01 >= 0) idx.push(i00, i11, i01);
      }
    }
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x0284c7,
      transparent: true,
      opacity: Math.max(0.12, Math.min(0.92, waterOpacity)),
      roughness: 0.1,
      metalness: 0.1,
      transmission: waterOpacity > 0.6 ? 0.25 : 0.7,
      ior: 1.333,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    waterMeshRef.current = mesh;
  }, [gridData, verticalExaggeration, depthBoost, showWaterPlane, waterMode, waterLevelOffsetFt]);

  useEffect(() => {
    const mesh = waterMeshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshPhysicalMaterial;
    mat.opacity = Math.max(0.12, Math.min(0.92, waterOpacity));
    mat.transmission = waterOpacity > 0.6 ? 0.25 : 0.7;
  }, [waterOpacity]);

  // ---- pointer helpers
  const castFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !cameraRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    return rect;
  };

  const terrainHitToCell = (): { row: number; col: number } | null => {
    if (!terrainMeshRef.current) return null;
    const hit = raycasterRef.current.intersectObject(terrainMeshRef.current)[0];
    if (!hit?.uv) return null;
    const n = gridData.gridSize;
    return { col: Math.min(n - 1, Math.max(0, hit.uv.x * (n - 1))), row: Math.min(n - 1, Math.max(0, hit.uv.y * (n - 1))) };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = castFromEvent(e);
    if (!rect) return;
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    if (markerGroupRef.current) {
      const mh = raycasterRef.current.intersectObjects(markerGroupRef.current.children, false).find((h) => h.object.userData?.label);
      if (mh) {
        setHoverMarker({ x: localX, y: localY, label: mh.object.userData.label, detail: mh.object.userData.detail });
        setHoverData(null);
        return;
      }
    }
    setHoverMarker(null);

    const cell = terrainHitToCell();
    if (cell) {
      const { elevations, depths, waterMask } = gridData;
      const col = Math.round(cell.col);
      const row = Math.round(cell.row);
      const elevFt = Math.round(elevations[row][col] * FT_PER_M);
      const depthFt = Math.round(depths[row][col] * FT_PER_M * 10) / 10;
      const isWater = waterMask[row][col];
      const { lat, lon } = gridToLatLon(gridData, cell.row, cell.col);
      setHoverData({ x: localX, y: localY, elevFt, depthFt, isWater, lat, lon });
      onProbeInfo?.({ elevationFt: elevFt, depthFt, isWater, lat, lon });
      return;
    }
    setHoverData(null);
    onProbeInfo?.(null);
  };

  const handlePointerLeave = () => {
    setHoverData(null);
    setHoverMarker(null);
    onProbeInfo?.(null);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const down = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // it was a drag
    if (e.button !== 0) return;
    if (!castFromEvent(e)) return;
    if (markerGroupRef.current) {
      const mh = raycasterRef.current.intersectObjects(markerGroupRef.current.children, false).find((h) => h.object.userData?.id);
      if (mh) { onSelectMarker?.(mh.object.userData.id); return; }
    }
    let mode: PickMode = pickMode;
    if (e.shiftKey) mode = 'pin';
    if (mode !== 'none') {
      const cell = terrainHitToCell();
      if (cell) onPick?.(cell, mode);
    }
  };

  const setPresetView = (view: 'iso' | 'top' | 'south' | 'side' | 'lake') => {
    if (!cameraRef.current || !controlsRef.current) return;
    const cam = cameraRef.current;
    const ctl = controlsRef.current;
    const len = modelLength(gridData);
    ctl.target.set(0, 4, 0);
    if (view === 'lake') {
      // Frame just the water: bounding box of the water mask, looked at from the south-east.
      const n = gridData.gridSize;
      let r0 = n, r1 = -1, c0 = n, c1 = -1;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (gridData.waterMask[r][c]) { if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c; }
      if (r1 < 0) return setPresetView('iso');
      const cx = xOf((c0 + c1) / 2), cz = zOf((r0 + r1) / 2);
      const cy = shapedRef.current ? yOf(sampleBilinear(shapedRef.current, (c0 + c1) / 2, (r0 + r1) / 2)) : 4;
      const extent = Math.max(xOf(c1) - xOf(c0), zOf(r1) - zOf(r0), 12);
      ctl.target.set(cx, cy, cz);
      cam.position.set(cx + extent * 0.35, cy + extent * 0.7, cz + extent * 0.9);
      ctl.update();
      return;
    }
    if (view === 'iso') cam.position.set(0, 95, 150);
    else if (view === 'top') cam.position.set(0, Math.max(130, len * 1.4), 0.1);
    else if (view === 'south') cam.position.set(0, 30, len * 1.2 + 40);
    else if (view === 'side') cam.position.set(150, 34, 0);
    ctl.update();
  };

  const btn = (active: boolean, activeCls: string) =>
    `px-2 py-1 rounded font-medium transition-all cursor-pointer ${active ? activeCls : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`;

  const tip = hoverMarker || hoverData;

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[460px] bg-slate-950 overflow-hidden rounded-xl select-none">
      <canvas
        ref={canvasRef}
        className={`w-full h-full block ${pickMode !== 'none' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      />

      <div className="absolute top-4 left-4 z-10 flex flex-wrap items-center gap-1.5 bg-slate-900/90 backdrop-blur-md px-2.5 py-1.5 rounded-lg border border-slate-700/70 shadow-lg text-xs text-slate-200">
        <span className="text-slate-400 font-medium px-1 flex items-center gap-1"><Eye className="w-3.5 h-3.5 text-sky-400" /> View:</span>
        <button onClick={() => setPresetView('iso')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer" title="Isometric">3D</button>
        <button onClick={() => setPresetView('top')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer" title="Top-down (north up)">Top</button>
        <button onClick={() => setPresetView('south')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer" title="Looking north from the south edge">South</button>
        <button onClick={() => setPresetView('side')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer" title="Cross profile from the east">Profile</button>
        <button onClick={() => setPresetView('lake')} className="px-2 py-1 rounded bg-cyan-900/70 hover:bg-cyan-800 text-cyan-100 transition-colors cursor-pointer" title="Frame just the water">Lake</button>
        <button onClick={() => setPresetView('iso')} className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors ml-1 cursor-pointer" title="Reset camera"><RotateCcw className="w-3.5 h-3.5" /></button>
        <button
          onClick={() => onSetPickMode?.(pickMode === 'pin' ? 'none' : 'pin')}
          className={`ml-1 px-2 py-1 rounded font-medium transition-all cursor-pointer flex items-center gap-1 ${pickMode === 'pin' ? 'bg-yellow-400 text-slate-950 font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-200'}`}
          title="Click the lake to drop a waypoint (or shift-click any time)"
        >
          <MapPin className="w-3.5 h-3.5" /> {pickMode === 'pin' ? 'Dropping pins' : 'Drop pin'}
        </button>
        <button
          onClick={() => onSetPickMode?.(pickMode === 'section' ? 'none' : 'section')}
          className={`px-2 py-1 rounded font-medium transition-all cursor-pointer flex items-center gap-1 ${pickMode === 'section' ? 'bg-slate-100 text-slate-950 font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-200'}`}
          title="Click two points on the model to see the bottom profile between them"
        >
          <Ruler className="w-3.5 h-3.5" /> {pickMode === 'section' ? 'Pick 2 points' : 'Section'}
        </button>
      </div>

      <div className="absolute top-14 left-4 z-10 hidden sm:flex flex-wrap items-center gap-1.5 bg-slate-900/90 backdrop-blur-md px-2.5 py-1.5 rounded-lg border border-sky-500/30 shadow-lg text-xs text-slate-200">
        <span className="text-sky-400 font-semibold px-1 flex items-center gap-1 text-[11px]"><Mountain className="w-3.5 h-3.5 text-amber-400" /> Style:</span>
        <button onClick={() => onUpdateShadingStyle?.('faceted-topo')} className={btn(shadingStyle === 'faceted-topo', 'bg-sky-500 text-slate-950 font-bold shadow-sm')} title="Flat-shaded facets">Faceted</button>
        <button onClick={() => onUpdateShadingStyle?.('stepped-terraces')} className={btn(shadingStyle === 'stepped-terraces', 'bg-amber-500 text-slate-950 font-bold shadow-sm')} title="Stepped contour terraces (laser-cut look)">Terraces</button>
        <button onClick={() => onUpdateShadingStyle?.('chiseled-ridges')} className={btn(shadingStyle === 'chiseled-ridges', 'bg-purple-500 text-white font-bold shadow-sm')} title="Exaggerated ridgelines">Chiseled</button>
        <button onClick={() => onUpdateShadingStyle?.('smooth')} className={btn(shadingStyle === 'smooth', 'bg-slate-600 text-white font-bold shadow-sm')} title="Smooth normals">Smooth</button>
        {shadingStyle === 'stepped-terraces' && (
          <div className="flex items-center gap-1 pl-1.5 border-l border-slate-700">
            <span className="text-[10px] text-slate-400">Step:</span>
            {[5, 10, 20].map((step) => (
              <button key={step} onClick={() => onUpdateTerraceStep?.(step)} className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer ${terraceStepFt === step ? 'bg-amber-400 text-slate-950 font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}>{step}ft</button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1 pl-2 border-l border-slate-700">
          <span className="text-cyan-400 font-semibold px-0.5 flex items-center gap-1 text-[11px]"><Waves className="w-3.5 h-3.5 text-cyan-400" /> Lake:</span>
          <button onClick={() => onUpdateWaterMode?.('carved-bed')} className={btn(waterMode === 'carved-bed', 'bg-cyan-500 text-slate-950 font-bold shadow-sm')} title="Exposed lakebed (what the STL prints)">Carved bed</button>
          <button onClick={() => onUpdateWaterMode?.('translucent')} className={btn(waterMode === 'translucent', 'bg-cyan-400 text-slate-950 font-bold shadow-sm')} title="Glass water surface over the bathymetry">Water</button>
        </div>
      </div>

      <div className="absolute bottom-4 left-4 z-10 hidden sm:flex items-center gap-2 bg-slate-900/80 backdrop-blur-md px-3 py-1.5 rounded-md border border-slate-800 text-[11px] text-slate-400">
        <span>Rotate: <strong className="text-slate-200">Left drag</strong></span><span>•</span>
        <span>Pan: <strong className="text-slate-200">Right drag</strong></span><span>•</span>
        <span>Zoom: <strong className="text-slate-200">Scroll</strong></span><span>•</span>
        <span>Pin: <strong className="text-slate-200">Shift+click</strong></span><span>•</span>
        <span className="font-mono text-slate-500">{verticalExaggeration.toFixed(1)}× vertical{depthBoost > 1 ? ` · bed ×${depthBoost.toFixed(1)}` : ''}</span>
        {thermocline?.enabled && (<><span>•</span><span className="text-amber-400 font-mono">band {thermocline.minFt}–{thermocline.maxFt} ft</span></>)}
      </div>

      {tip && (
        <div
          className="absolute pointer-events-none z-20 bg-slate-950/90 backdrop-blur-md border border-sky-500/40 px-3 py-2 rounded-lg shadow-xl text-xs text-white max-w-[260px]"
          style={{ left: Math.min(tip.x + 15, (containerRef.current?.clientWidth || 600) - 270), top: Math.max(tip.y - 70, 20) }}
        >
          {hoverMarker ? (
            <>
              <div className="font-semibold text-yellow-300">{hoverMarker.label}</div>
              {hoverMarker.detail && <div className="mt-0.5 text-slate-300 leading-snug">{hoverMarker.detail}</div>}
            </>
          ) : hoverData ? (
            <>
              <div className="flex items-center gap-1.5 font-semibold text-sky-300">
                {hoverData.isWater ? (<><Waves className="w-3.5 h-3.5 text-cyan-400" /><span>Lake bed</span></>) : (<><Compass className="w-3.5 h-3.5 text-emerald-400" /><span>Land</span></>)}
              </div>
              <div className="mt-1 space-y-0.5 text-slate-300">
                {hoverData.isWater
                  ? <div>Depth: <span className="font-mono font-medium text-cyan-300">{hoverData.depthFt} ft</span></div>
                  : <div>Elev: <span className="font-mono font-medium text-white">{hoverData.elevFt} ft</span></div>}
                <div className="font-mono text-[10px] text-slate-400">{hoverData.lat.toFixed(5)}, {hoverData.lon.toFixed(5)}</div>
              </div>
            </>
          ) : null}
        </div>
      )}

      <div className="absolute top-4 right-4 z-10 flex flex-col items-center bg-slate-900/85 backdrop-blur-md p-2 rounded-lg border border-slate-700/60 shadow-lg text-slate-300">
        <div className="w-7 h-7 flex items-center justify-center relative">
          <div className="w-0.5 h-6 bg-slate-600 rounded-full" />
          <div className="absolute top-0 w-0 h-0 border-l-[4px] border-l-transparent border-r-[4px] border-r-transparent border-b-[8px] border-b-rose-500" />
          <span className="absolute -top-4 text-[10px] font-bold text-rose-400">N</span>
        </div>
        <span className="text-[9px] text-slate-400 uppercase tracking-widest font-mono mt-0.5">North</span>
      </div>
    </div>
  );
};
