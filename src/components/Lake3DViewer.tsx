import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ColorSchemeMode, TerrainGridData, TerrainShadingStyle } from '../types.js';
import { fieldFrom2D, isolines, levelRange, sampleBilinear } from '../lib/contours.js';
import { Compass, RotateCcw, Eye, Waves, Mountain } from 'lucide-react';

export type WaterDisplayMode = 'carved-bed' | 'translucent' | 'filled';

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
  onUpdateShadingStyle?: (style: TerrainShadingStyle) => void;
  onUpdateTerraceStep?: (stepFt: number) => void;
  onUpdateFlatShading?: (flat: boolean) => void;
  onUpdateWaterMode?: (mode: WaterDisplayMode) => void;
  onUpdateWaterLevelOffsetFt?: (offsetFt: number) => void;
  onProbeInfo?: (info: { elevationFt: number; depthFt: number; isWater: boolean } | null) => void;
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
  onUpdateShadingStyle,
  onUpdateTerraceStep,
  onUpdateWaterMode,
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
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());

  const [hoverData, setHoverData] = useState<{ x: number; y: number; elevFt: number; depthFt: number; isWater: boolean } | null>(null);

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
    controls.minDistance = 15;
    controls.maxDistance = 600;
    controls.target.set(0, 4, 0);
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xfff7ed, 1.3);
    sun.position.set(120, 200, 100);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
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
    const bg = colorScheme === 'print-resin' ? 0xf1f5f9 : colorScheme === 'slate' ? 0x0f172a : 0x070b14;
    sceneRef.current.background = new THREE.Color(bg);
  }, [colorScheme]);

  const getVertexColor = (elevM: number, depthM: number, isWater: boolean, maxElev: number, waterElev: number): THREE.Color => {
    const maxDepth = Math.max(1, gridData.maxDepth);
    if (colorScheme === 'print-resin') {
      if (isWater) return new THREE.Color().lerpColors(new THREE.Color(0xe2e8f0), new THREE.Color(0x94a3b8), Math.min(1, depthM / maxDepth));
      return new THREE.Color(0xf8fafc);
    }
    if (colorScheme === 'slate') {
      if (isWater) return new THREE.Color().lerpColors(new THREE.Color(0x1e293b), new THREE.Color(0x020617), Math.min(1, depthM / maxDepth));
      const hRatio = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
      return new THREE.Color().lerpColors(new THREE.Color(0x334155), new THREE.Color(0x64748b), hRatio);
    }
    if (colorScheme === 'bathymetric') {
      if (isWater) {
        const d = Math.min(1, depthM / maxDepth);
        if (d < 0.25) return new THREE.Color().lerpColors(new THREE.Color(0x38bdf8), new THREE.Color(0x0284c7), d * 4);
        if (d < 0.6) return new THREE.Color().lerpColors(new THREE.Color(0x0284c7), new THREE.Color(0x1d4ed8), (d - 0.25) / 0.35);
        return new THREE.Color().lerpColors(new THREE.Color(0x1d4ed8), new THREE.Color(0x030712), (d - 0.6) / 0.4);
      }
      return new THREE.Color(0xd6d3d1);
    }
    if (colorScheme === 'topographic') {
      if (isWater) return new THREE.Color().lerpColors(new THREE.Color(0x67e8f9), new THREE.Color(0x0369a1), Math.min(1, depthM / maxDepth));
      const h = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
      if (h < 0.3) return new THREE.Color().lerpColors(new THREE.Color(0x86efac), new THREE.Color(0xca8a04), h / 0.3);
      if (h < 0.7) return new THREE.Color().lerpColors(new THREE.Color(0xca8a04), new THREE.Color(0xc2410c), (h - 0.3) / 0.4);
      return new THREE.Color().lerpColors(new THREE.Color(0xc2410c), new THREE.Color(0x78350f), (h - 0.7) / 0.3);
    }
    if (colorScheme === 'satellite') {
      if (isWater) return new THREE.Color().lerpColors(new THREE.Color(0x155e75), new THREE.Color(0x082f49), Math.min(1, depthM / maxDepth));
      const h = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
      return new THREE.Color().lerpColors(new THREE.Color(0x2d4a22), new THREE.Color(0x57534e), h);
    }
    // hypsometric default
    if (isWater) {
      const d = Math.min(1, depthM / maxDepth);
      if (d < 0.2) return new THREE.Color().lerpColors(new THREE.Color(0x22d3ee), new THREE.Color(0x0ea5e9), d * 5);
      if (d < 0.6) return new THREE.Color().lerpColors(new THREE.Color(0x0ea5e9), new THREE.Color(0x1e40af), (d - 0.2) / 0.4);
      return new THREE.Color().lerpColors(new THREE.Color(0x1e40af), new THREE.Color(0x0b132b), (d - 0.6) / 0.4);
    }
    const hM = elevM - waterElev;
    const h = Math.min(1, hM / Math.max(1, maxElev - waterElev));
    if (hM < 1.5) return new THREE.Color(0xfde68a);
    if (h < 0.35) return new THREE.Color().lerpColors(new THREE.Color(0x4ade80), new THREE.Color(0x16a34a), h / 0.35);
    if (h < 0.7) return new THREE.Color().lerpColors(new THREE.Color(0x16a34a), new THREE.Color(0xb45309), (h - 0.35) / 0.35);
    return new THREE.Color().lerpColors(new THREE.Color(0xb45309), new THREE.Color(0x7c2d12), (h - 0.7) / 0.3);
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

  // ---- terrain, base and contour lines
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    disposeObject(terrainMeshRef.current); terrainMeshRef.current = null;
    disposeObject(baseMeshRef.current); baseMeshRef.current = null;
    disposeObject(contourGroupRef.current); contourGroupRef.current = null;

    const { gridSize, elevations, waterMask, depths, minElevation, maxElevation, waterElevation } = gridData;
    const length = modelLength(gridData);
    const zScale = verticalScale(gridData, verticalExaggeration);
    const baseBottomY = -5 * baseThicknessRatio;

    // Transformed elevation field (shading styles alter the heights)
    const shaped: number[][] = [];
    const shapedDepth: number[][] = [];
    const stepM = (terraceStepFt || 5) * 0.3048;
    const sharp = terrainSharpness || 1.8;
    for (let r = 0; r < gridSize; r++) {
      shaped[r] = [];
      shapedDepth[r] = [];
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
        shapedDepth[r][c] = depthM;
      }
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const xOf = (c: number) => (c / (gridSize - 1) - 0.5) * MODEL_WIDTH;
    const zOf = (r: number) => (r / (gridSize - 1) - 0.5) * length;
    const yOf = (elevM: number) => (elevM - minElevation) * zScale;

    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        positions.push(xOf(c), yOf(shaped[r][c]), zOf(r));
        uvs.push(c / (gridSize - 1), r / (gridSize - 1));
        const col = getVertexColor(shaped[r][c], shapedDepth[r][c], waterMask[r][c], maxElevation, waterElevation);
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
        quad(xOf(c), yOf(shaped[0][c]), zOf(0), xOf(c + 1), yOf(shaped[0][c + 1]), zOf(0));
        quad(xOf(c + 1), yOf(shaped[last][c + 1]), zOf(last), xOf(c), yOf(shaped[last][c]), zOf(last));
      }
      for (let r = 0; r < last; r++) {
        quad(xOf(0), yOf(shaped[r + 1][0]), zOf(r + 1), xOf(0), yOf(shaped[r][0]), zOf(r));
        quad(xOf(last), yOf(shaped[r][last]), zOf(r), xOf(last), yOf(shaped[r + 1][last]), zOf(r + 1));
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

    // Real contour lines draped on the surface
    if (showContours) {
      const relFt = shaped.map((row) => row.map((e) => (e - waterElevation) * FT_PER_M));
      const field = fieldFrom2D(relFt);
      const maxLandFt = (maxElevation - waterElevation) * FT_PER_M;
      const maxDepthFt = gridData.maxDepth * FT_PER_M;
      const landInt = shadingStyle === 'stepped-terraces' ? terraceStepFt : contourIntervalFt || landContourInterval(maxLandFt);
      const waterInt = shadingStyle === 'stepped-terraces' ? terraceStepFt : Math.min(contourIntervalFt || 5, gridData.metadata.contourIntervalFt || 5);
      const lift = 0.05 + zScale * 0.02;
      const group = new THREE.Group();
      const dark = colorScheme === 'print-resin';
      const build = (levels: number[], indexEvery: number, colorIdx: number, colorMinor: number) => {
        const major: number[] = [];
        const minor: number[] = [];
        levels.forEach((lvl, i) => {
          const target = (i + 1) % indexEvery === 0 ? major : minor;
          for (const line of isolines(field, gridSize, gridSize, lvl)) {
            for (let k = 1; k < line.length; k++) {
              const [x0, y0] = line[k - 1];
              const [x1, y1] = line[k];
              target.push(
                xOf(x0), yOf(sampleBilinear(shaped, x0, y0)) + lift, zOf(y0),
                xOf(x1), yOf(sampleBilinear(shaped, x1, y1)) + lift, zOf(y1)
              );
            }
          }
        });
        const mk = (arr: number[], color: number, opacity: number) => {
          if (!arr.length) return;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
          group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })));
        };
        mk(major, colorIdx, 0.95);
        mk(minor, colorMinor, 0.55);
      };
      build(levelRange(landInt, maxLandFt, landInt), 5, dark ? 0x334155 : 0x3b2a1a, dark ? 0x64748b : 0x5c3d24);
      build(levelRange(waterInt, maxDepthFt, waterInt).map((d) => -d), 2, dark ? 0x1e3a8a : 0xbae6fd, dark ? 0x3b82f6 : 0x7dd3fc);
      scene.add(group);
      contourGroupRef.current = group;
    }
  }, [gridData, verticalExaggeration, baseThicknessRatio, colorScheme, showSolidBase, showContours, contourIntervalFt, shadingStyle, terraceStepFt, flatShading, terrainSharpness]);

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

    const { gridSize, elevations, minElevation, waterElevation } = gridData;
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
  }, [gridData, verticalExaggeration, showWaterPlane, waterMode, waterLevelOffsetFt]);

  useEffect(() => {
    const mesh = waterMeshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshPhysicalMaterial;
    mat.opacity = Math.max(0.12, Math.min(0.92, waterOpacity));
    mat.transmission = waterOpacity > 0.6 ? 0.25 : 0.7;
  }, [waterOpacity]);

  // ---- hover probe
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !cameraRef.current || !terrainMeshRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const hit = raycasterRef.current.intersectObject(terrainMeshRef.current)[0];
    if (hit?.uv) {
      const { gridSize, elevations, depths, waterMask } = gridData;
      const col = Math.min(gridSize - 1, Math.max(0, Math.round(hit.uv.x * (gridSize - 1))));
      const row = Math.min(gridSize - 1, Math.max(0, Math.round(hit.uv.y * (gridSize - 1))));
      const elevFt = Math.round(elevations[row][col] * FT_PER_M);
      const depthFt = Math.round(depths[row][col] * FT_PER_M * 10) / 10;
      const isWater = waterMask[row][col];
      setHoverData({ x: e.clientX - rect.left, y: e.clientY - rect.top, elevFt, depthFt, isWater });
      onProbeInfo?.({ elevationFt: elevFt, depthFt, isWater });
      return;
    }
    setHoverData(null);
    onProbeInfo?.(null);
  };

  const handlePointerLeave = () => {
    setHoverData(null);
    onProbeInfo?.(null);
  };

  const setPresetView = (view: 'iso' | 'top' | 'south' | 'side') => {
    if (!cameraRef.current || !controlsRef.current) return;
    const cam = cameraRef.current;
    const ctl = controlsRef.current;
    const len = modelLength(gridData);
    ctl.target.set(0, 4, 0);
    if (view === 'iso') cam.position.set(0, 95, 150);
    else if (view === 'top') cam.position.set(0, Math.max(130, len * 1.4), 0.1);
    else if (view === 'south') cam.position.set(0, 30, len * 1.2 + 40);
    else if (view === 'side') cam.position.set(150, 34, 0);
    ctl.update();
  };

  const btn = (active: boolean, activeCls: string) =>
    `px-2 py-1 rounded font-medium transition-all cursor-pointer ${active ? activeCls : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`;

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[460px] bg-slate-950 overflow-hidden rounded-xl select-none">
      <canvas ref={canvasRef} className="w-full h-full cursor-grab active:cursor-grabbing block" onPointerMove={handlePointerMove} onPointerLeave={handlePointerLeave} />

      <div className="absolute top-4 left-4 z-10 flex flex-wrap items-center gap-1.5 bg-slate-900/90 backdrop-blur-md px-2.5 py-1.5 rounded-lg border border-slate-700/70 shadow-lg text-xs text-slate-200">
        <span className="text-slate-400 font-medium px-1 flex items-center gap-1"><Eye className="w-3.5 h-3.5 text-sky-400" /> View:</span>
        <button onClick={() => setPresetView('iso')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer" title="Isometric">3D</button>
        <button onClick={() => setPresetView('top')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer" title="Top-down (north up)">Top</button>
        <button onClick={() => setPresetView('south')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer" title="Looking north from the south edge">South</button>
        <button onClick={() => setPresetView('side')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer" title="Cross profile from the east">Profile</button>
        <button onClick={() => setPresetView('iso')} className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors ml-1 cursor-pointer" title="Reset camera"><RotateCcw className="w-3.5 h-3.5" /></button>
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
        <span className="font-mono text-slate-500">{verticalExaggeration.toFixed(1)}× vertical</span>
      </div>

      {hoverData && (
        <div
          className="absolute pointer-events-none z-20 bg-slate-950/90 backdrop-blur-md border border-sky-500/40 px-3 py-2 rounded-lg shadow-xl text-xs text-white"
          style={{ left: Math.min(hoverData.x + 15, (containerRef.current?.clientWidth || 600) - 170), top: Math.max(hoverData.y - 65, 20) }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-sky-300">
            {hoverData.isWater ? (<><Waves className="w-3.5 h-3.5 text-cyan-400" /><span>Lake bed</span></>) : (<><Compass className="w-3.5 h-3.5 text-emerald-400" /><span>Land</span></>)}
          </div>
          <div className="mt-1 space-y-0.5 text-slate-300">
            <div>Elev: <span className="font-mono font-medium text-white">{hoverData.elevFt} ft</span></div>
            {hoverData.isWater && <div>Depth: <span className="font-mono font-medium text-cyan-300">{hoverData.depthFt} ft</span></div>}
          </div>
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
