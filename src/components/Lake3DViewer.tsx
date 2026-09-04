import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ColorSchemeMode, TerrainGridData, TerrainShadingStyle } from '../types.js';
import { 
  Compass, 
  Layers, 
  RotateCcw, 
  Eye, 
  Waves, 
  Sliders,
  Mountain,
  Sparkles,
  Check
} from 'lucide-react';

export type WaterDisplayMode = 'carved-bed' | 'translucent' | 'filled';

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
  onUpdateFlatShading,
  onUpdateWaterMode,
  onUpdateWaterLevelOffsetFt,
  onProbeInfo,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  const terrainMeshRef = useRef<THREE.Mesh | null>(null);
  const baseWallsMeshRef = useRef<THREE.Mesh | null>(null);
  const waterPlaneMeshRef = useRef<THREE.Mesh | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());

  const [hoverData, setHoverData] = useState<{
    x: number;
    y: number;
    elevFt: number;
    depthFt: number;
    isWater: boolean;
  } | null>(null);

  // Initialize Three.js Scene
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return;

    const width = containerRef.current.clientWidth || 800;
    const height = containerRef.current.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(colorScheme === 'slate' ? 0x111827 : 0x0a0f1d);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
    camera.position.set(0, 115, 145);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = Math.PI / 2 + 0.05; // allow slight under-angle
    controls.minDistance = 20;
    controls.maxDistance = 600;
    controls.target.set(0, 8, 0);
    controlsRef.current = controls;

    // Lighting setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfff7ed, 1.25);
    sunLight.position.set(120, 200, 100);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.45);
    fillLight.position.set(-100, 80, -100);
    scene.add(fillLight);

    // Subtle grid ground helper
    const gridHelper = new THREE.GridHelper(260, 26, 0x334155, 0x1e293b);
    gridHelper.position.y = -25;
    scene.add(gridHelper);

    // Resize handling via ResizeObserver
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: newW, height: newH } = entry.contentRect;
        if (newW > 0 && newH > 0) {
          camera.aspect = newW / newH;
          camera.updateProjectionMatrix();
          renderer.setSize(newW, newH);
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    // Animation loop
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.dispose();
    };
  }, []);

  // Update Background color when theme changes
  useEffect(() => {
    if (!sceneRef.current) return;
    if (colorScheme === 'print-resin') {
      sceneRef.current.background = new THREE.Color(0xf1f5f9);
    } else if (colorScheme === 'slate') {
      sceneRef.current.background = new THREE.Color(0x0f172a);
    } else {
      sceneRef.current.background = new THREE.Color(0x070b14);
    }
  }, [colorScheme]);

  // Color generator based on scheme, elevation and depth
  const getVertexColor = (
    elevM: number,
    depthM: number,
    isWater: boolean,
    minElev: number,
    maxElev: number,
    waterElev: number
  ): THREE.Color => {
    if (colorScheme === 'print-resin') {
      if (isWater) {
        const dRatio = Math.min(1, depthM / 30);
        return new THREE.Color().lerpColors(new THREE.Color(0xe2e8f0), new THREE.Color(0x94a3b8), dRatio);
      }
      return new THREE.Color(0xf8fafc);
    }

    if (colorScheme === 'slate') {
      if (isWater) {
        const dRatio = Math.min(1, depthM / 35);
        return new THREE.Color().lerpColors(new THREE.Color(0x1e293b), new THREE.Color(0x020617), dRatio);
      }
      const hRatio = Math.min(1, (elevM - waterElev) / 40);
      return new THREE.Color().lerpColors(new THREE.Color(0x334155), new THREE.Color(0x64748b), hRatio);
    }

    if (colorScheme === 'bathymetric') {
      if (isWater) {
        const dRatio = Math.min(1, depthM / Math.max(1, gridData.maxDepth));
        // Vivid oceanic gradient: Cyan -> Deep Blue -> Navy -> Midnight
        if (dRatio < 0.25) {
          return new THREE.Color().lerpColors(new THREE.Color(0x38bdf8), new THREE.Color(0x0284c7), dRatio * 4);
        } else if (dRatio < 0.6) {
          return new THREE.Color().lerpColors(new THREE.Color(0x0284c7), new THREE.Color(0x1d4ed8), (dRatio - 0.25) / 0.35);
        } else {
          return new THREE.Color().lerpColors(new THREE.Color(0x1d4ed8), new THREE.Color(0x030712), (dRatio - 0.6) / 0.4);
        }
      } else {
        // Neutral earthy shoreline
        return new THREE.Color(0xd6d3d1);
      }
    }

    if (colorScheme === 'topographic') {
      if (isWater) {
        const dRatio = Math.min(1, depthM / Math.max(1, gridData.maxDepth));
        return new THREE.Color().lerpColors(new THREE.Color(0x67e8f9), new THREE.Color(0x0369a1), dRatio);
      }
      const hRatio = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
      if (hRatio < 0.3) {
        return new THREE.Color().lerpColors(new THREE.Color(0x86efac), new THREE.Color(0xca8a04), hRatio / 0.3);
      } else if (hRatio < 0.7) {
        return new THREE.Color().lerpColors(new THREE.Color(0xca8a04), new THREE.Color(0xc2410c), (hRatio - 0.3) / 0.4);
      } else {
        return new THREE.Color().lerpColors(new THREE.Color(0xc2410c), new THREE.Color(0x78350f), (hRatio - 0.7) / 0.3);
      }
    }

    if (colorScheme === 'satellite') {
      if (isWater) {
        const dRatio = Math.min(1, depthM / Math.max(1, gridData.maxDepth));
        return new THREE.Color().lerpColors(new THREE.Color(0x155e75), new THREE.Color(0x082f49), dRatio);
      }
      const hRatio = Math.min(1, (elevM - waterElev) / Math.max(1, maxElev - waterElev));
      return new THREE.Color().lerpColors(new THREE.Color(0x2d4a22), new THREE.Color(0x57534e), hRatio);
    }

    // Default: 'hypsometric' (Rich, balanced cartographic palette)
    if (isWater) {
      const dRatio = Math.min(1, depthM / Math.max(1, gridData.maxDepth));
      // Shoreline aquamarine -> Azure -> Deep Navy
      if (dRatio < 0.2) {
        return new THREE.Color().lerpColors(new THREE.Color(0x22d3ee), new THREE.Color(0x0ea5e9), dRatio * 5);
      } else if (dRatio < 0.6) {
        return new THREE.Color().lerpColors(new THREE.Color(0x0ea5e9), new THREE.Color(0x1e40af), (dRatio - 0.2) / 0.4);
      } else {
        return new THREE.Color().lerpColors(new THREE.Color(0x1e40af), new THREE.Color(0x0b132b), (dRatio - 0.6) / 0.4);
      }
    } else {
      // Midwestern shoreline beach -> Lush glacial pasture/forest -> Moraine hills -> High ridge
      const hM = elevM - waterElev;
      const hRatio = Math.min(1, hM / Math.max(1, maxElev - waterElev));
      if (hM < 1.5) {
        return new THREE.Color(0xfde68a); // Sand shoreline
      } else if (hRatio < 0.35) {
        return new THREE.Color().lerpColors(new THREE.Color(0x4ade80), new THREE.Color(0x16a34a), hRatio / 0.35);
      } else if (hRatio < 0.7) {
        return new THREE.Color().lerpColors(new THREE.Color(0x16a34a), new THREE.Color(0xb45309), (hRatio - 0.35) / 0.35);
      } else {
        return new THREE.Color().lerpColors(new THREE.Color(0xb45309), new THREE.Color(0x7c2d12), (hRatio - 0.7) / 0.3);
      }
    }
  };

  // Build / Update Terrain & Solid Base Geometries
  useEffect(() => {
    if (!sceneRef.current) return;
    const scene = sceneRef.current;

    // Remove existing meshes
    if (terrainMeshRef.current) {
      scene.remove(terrainMeshRef.current);
      terrainMeshRef.current.geometry.dispose();
      (terrainMeshRef.current.material as THREE.Material).dispose();
      terrainMeshRef.current = null;
    }
    if (baseWallsMeshRef.current) {
      scene.remove(baseWallsMeshRef.current);
      baseWallsMeshRef.current.geometry.dispose();
      (baseWallsMeshRef.current.material as THREE.Material).dispose();
      baseWallsMeshRef.current = null;
    }
    if (waterPlaneMeshRef.current) {
      scene.remove(waterPlaneMeshRef.current);
      waterPlaneMeshRef.current.geometry.dispose();
      (waterPlaneMeshRef.current.material as THREE.Material).dispose();
      waterPlaneMeshRef.current = null;
    }

    const { gridSize, elevations, waterMask, depths, minElevation, maxElevation, waterElevation } = gridData;

    // Physical dimensions in 3D scene units (scaled to ~100 units width)
    const modelWidth = 100;
    const aspect = (gridData.physicalHeightKm || 1) / (gridData.physicalWidthKm || 1);
    const modelLength = modelWidth * aspect;

    // Z exaggeration scaling factor
    const elevSpan = Math.max(1, maxElevation - minElevation);
    const zScale = (18 / elevSpan) * verticalExaggeration;
    const baseHeight = 5 * baseThicknessRatio;
    const baseBottomY = -baseHeight;

    // Generate Top Surface Geometry
    const topGeometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Map of vertices for quick access
    const vertexMap: { x: number; y: number; z: number }[][] = [];

    for (let r = 0; r < gridSize; r++) {
      vertexMap[r] = [];
      const zPos = (r / (gridSize - 1) - 0.5) * modelLength;

      for (let c = 0; c < gridSize; c++) {
        const xPos = (c / (gridSize - 1) - 0.5) * modelWidth;
        let elevM = elevations[r][c];
        let depthM = depths[r][c];
        const isWater = waterMask[r][c];

        // Apply Topo Shading Style Transformations
        if (shadingStyle === 'stepped-terraces') {
          // Quantize elevations into discrete horizontal contour terraces (like laser-cut wooden/acrylic topo maps)
          const stepM = (terraceStepFt || 5) * 0.3048;
          if (isWater) {
            const steppedDepthM = Math.floor(depthM / stepM) * stepM;
            depthM = steppedDepthM;
            elevM = waterElevation - steppedDepthM;
          } else {
            const hAboveWater = elevM - waterElevation;
            const steppedH = Math.floor(hAboveWater / stepM) * stepM;
            elevM = waterElevation + steppedH;
          }
        } else if (shadingStyle === 'chiseled-ridges') {
          // Chiseled ridges and sharp breaklines
          const sharpness = terrainSharpness || 1.8;
          if (!isWater) {
            const hM = Math.max(0, elevM - waterElevation);
            const maxH = Math.max(1, maxElevation - waterElevation);
            const normH = Math.min(1, hM / maxH);
            const sharpNormH = Math.pow(normH, 1 / sharpness);
            elevM = waterElevation + sharpNormH * maxH;
          } else {
            const maxD = Math.max(1, gridData.maxDepth);
            const normD = Math.min(1, depthM / maxD);
            const sharpNormD = Math.pow(normD, 1.35);
            depthM = sharpNormD * maxD;
            elevM = waterElevation - depthM;
          }
        }

        // Relief in units
        const yRelief = (elevM - minElevation) * zScale;
        const yPos = yRelief;

        positions.push(xPos, yPos, zPos);
        uvs.push(c / (gridSize - 1), r / (gridSize - 1));

        vertexMap[r][c] = { x: xPos, y: yPos, z: zPos };

        // Color computation
        const col = getVertexColor(elevM, depthM, isWater, minElevation, maxElevation, waterElevation);

        // Crisp Topo Contour Lines with Index Emphasizing
        if (showContours) {
          const elevFt = elevM * 3.28084;
          const interval = shadingStyle === 'stepped-terraces' ? (terraceStepFt || 5) : contourIntervalFt;
          const contourMod = Math.abs(elevFt % interval);
          if (contourMod < 0.95 || contourMod > interval - 0.95) {
            // Index contour (every 5th line)
            const isIndex = Math.abs(elevFt % (interval * 5)) < 1.1 || Math.abs(elevFt % (interval * 5)) > (interval * 5 - 1.1);
            if (isIndex) {
              col.multiplyScalar(0.40); // High-contrast bold index line
            } else {
              col.multiplyScalar(0.70); // Intermediate contour line
            }
          }
        }

        colors.push(col.r, col.g, col.b);
      }
    }

    // Top surface triangle indices
    for (let r = 0; r < gridSize - 1; r++) {
      for (let c = 0; c < gridSize - 1; c++) {
        const i00 = r * gridSize + c;
        const i10 = (r + 1) * gridSize + c;
        const i01 = r * gridSize + (c + 1);
        const i11 = (r + 1) * gridSize + (c + 1);

        indices.push(i00, i10, i11);
        indices.push(i00, i11, i01);
      }
    }

    topGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    topGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    topGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    topGeometry.setIndex(indices);

    // Make geometry non-indexed for crisp face normals (zero blurred normal bleeding across slope edges)
    const isCrisp = flatShading || shadingStyle !== 'smooth';
    const finalTopGeometry = isCrisp ? topGeometry.toNonIndexed() : topGeometry;
    finalTopGeometry.computeVertexNormals();

    const terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      wireframe: showWireframe,
      flatShading: isCrisp,
      roughness: colorScheme === 'print-resin' ? 0.35 : 0.65,
      metalness: colorScheme === 'print-resin' ? 0.05 : 0.08,
      side: THREE.DoubleSide,
    });

    const terrainMesh = new THREE.Mesh(finalTopGeometry, terrainMaterial);
    terrainMesh.receiveShadow = true;
    terrainMesh.castShadow = true;
    scene.add(terrainMesh);
    terrainMeshRef.current = terrainMesh;

    // Solid 3D printable base & skirt walls
    if (showSolidBase) {
      const baseGeometry = new THREE.BufferGeometry();
      const basePos: number[] = [];
      const baseColors: number[] = [];
      const baseIndices: number[] = [];

      const wallColor = colorScheme === 'print-resin' ? new THREE.Color(0xcfd8dc) : new THREE.Color(0x1e293b);

      // Add 4 vertical walls
      let idx = 0;
      const addQuad = (
        p1: { x: number; y: number; z: number },
        p2: { x: number; y: number; z: number },
        b1: { x: number; y: number; z: number },
        b2: { x: number; y: number; z: number }
      ) => {
        basePos.push(p1.x, p1.y, p1.z);
        basePos.push(p2.x, p2.y, p2.z);
        basePos.push(b2.x, b2.y, b2.z);
        basePos.push(b1.x, b1.y, b1.z);

        for (let k = 0; k < 4; k++) {
          baseColors.push(wallColor.r, wallColor.g, wallColor.b);
        }

        baseIndices.push(idx, idx + 1, idx + 2);
        baseIndices.push(idx, idx + 2, idx + 3);
        idx += 4;
      };

      // South edge (r = 0)
      for (let c = 0; c < gridSize - 1; c++) {
        const t1 = vertexMap[0][c];
        const t2 = vertexMap[0][c + 1];
        addQuad(t1, t2, { x: t1.x, y: baseBottomY, z: t1.z }, { x: t2.x, y: baseBottomY, z: t2.z });
      }

      // North edge (r = gridSize - 1)
      const lastR = gridSize - 1;
      for (let c = 0; c < gridSize - 1; c++) {
        const t1 = vertexMap[lastR][c + 1];
        const t2 = vertexMap[lastR][c];
        addQuad(t1, t2, { x: t1.x, y: baseBottomY, z: t1.z }, { x: t2.x, y: baseBottomY, z: t2.z });
      }

      // West edge (c = 0)
      for (let r = 0; r < gridSize - 1; r++) {
        const t1 = vertexMap[r + 1][0];
        const t2 = vertexMap[r][0];
        addQuad(t1, t2, { x: t1.x, y: baseBottomY, z: t1.z }, { x: t2.x, y: baseBottomY, z: t2.z });
      }

      // East edge (c = gridSize - 1)
      const lastC = gridSize - 1;
      for (let r = 0; r < gridSize - 1; r++) {
        const t1 = vertexMap[r][lastC];
        const t2 = vertexMap[r + 1][lastC];
        addQuad(t1, t2, { x: t1.x, y: baseBottomY, z: t1.z }, { x: t2.x, y: baseBottomY, z: t2.z });
      }

      // Bottom plate
      const b00 = { x: -modelWidth / 2, y: baseBottomY, z: -modelLength / 2 };
      const b01 = { x: modelWidth / 2, y: baseBottomY, z: -modelLength / 2 };
      const b11 = { x: modelWidth / 2, y: baseBottomY, z: modelLength / 2 };
      const b10 = { x: -modelWidth / 2, y: baseBottomY, z: modelLength / 2 };

      basePos.push(b00.x, b00.y, b00.z);
      basePos.push(b10.x, b10.y, b10.z);
      basePos.push(b11.x, b11.y, b11.z);
      basePos.push(b01.x, b01.y, b01.z);
      for (let k = 0; k < 4; k++) baseColors.push(wallColor.r * 0.8, wallColor.g * 0.8, wallColor.b * 0.8);
      baseIndices.push(idx, idx + 1, idx + 2);
      baseIndices.push(idx, idx + 2, idx + 3);

      baseGeometry.setAttribute('position', new THREE.Float32BufferAttribute(basePos, 3));
      baseGeometry.setAttribute('color', new THREE.Float32BufferAttribute(baseColors, 3));
      baseGeometry.setIndex(baseIndices);
      baseGeometry.computeVertexNormals();

      const baseMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.8,
        metalness: 0.1,
        wireframe: showWireframe,
      });

      const baseMesh = new THREE.Mesh(baseGeometry, baseMaterial);
      baseMesh.receiveShadow = true;
      scene.add(baseMesh);
      baseWallsMeshRef.current = baseMesh;
    }

    // Shoreline-conforming water surface (only generated when showWaterPlane is true and waterMode is not 'carved-bed')
    if (showWaterPlane && waterMode !== 'carved-bed') {
      const waterLevelOffsetM = (waterLevelOffsetFt || 0) * 0.3048;
      const targetWaterElev = waterElevation + waterLevelOffsetM;
      const waterY = (targetWaterElev - minElevation) * zScale;

      const waterPositions: number[] = [];
      const waterNormals: number[] = [];
      const waterUvs: number[] = [];
      const waterIndices: number[] = [];
      const waterIndexMap: number[][] = [];

      let vIdx = 0;
      for (let r = 0; r < gridSize; r++) {
        waterIndexMap[r] = [];
        const zPos = (r / (gridSize - 1) - 0.5) * modelLength;
        for (let c = 0; c < gridSize; c++) {
          const elevM = elevations[r][c];
          // Include cell if part of lake's waterMask or submerged under current target water elevation
          const isSubmerged = waterMask[r][c] || elevM <= targetWaterElev + 0.1;
          if (isSubmerged) {
            const xPos = (c / (gridSize - 1) - 0.5) * modelWidth;
            waterPositions.push(xPos, waterY, zPos);
            waterNormals.push(0, 1, 0);
            waterUvs.push(c / (gridSize - 1), r / (gridSize - 1));
            waterIndexMap[r][c] = vIdx++;
          } else {
            waterIndexMap[r][c] = -1;
          }
        }
      }

      for (let r = 0; r < gridSize - 1; r++) {
        for (let c = 0; c < gridSize - 1; c++) {
          const i00 = waterIndexMap[r]?.[c] ?? -1;
          const i10 = waterIndexMap[r + 1]?.[c] ?? -1;
          const i01 = waterIndexMap[r]?.[c + 1] ?? -1;
          const i11 = waterIndexMap[r + 1]?.[c + 1] ?? -1;

          if (i00 !== -1 && i10 !== -1 && i11 !== -1) {
            waterIndices.push(i00, i10, i11);
          }
          if (i00 !== -1 && i11 !== -1 && i01 !== -1) {
            waterIndices.push(i00, i11, i01);
          }
        }
      }

      if (waterPositions.length > 0 && waterIndices.length > 0) {
        const waterGeo = new THREE.BufferGeometry();
        waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(waterPositions, 3));
        waterGeo.setAttribute('normal', new THREE.Float32BufferAttribute(waterNormals, 3));
        waterGeo.setAttribute('uv', new THREE.Float32BufferAttribute(waterUvs, 2));
        waterGeo.setIndex(waterIndices);

        const waterMat = new THREE.MeshPhysicalMaterial({
          color: 0x0284c7, // Vivid aquatic cyan-blue
          transparent: true,
          opacity: Math.max(0.12, Math.min(0.92, waterOpacity)),
          roughness: 0.1,
          metalness: 0.1,
          transmission: waterOpacity > 0.6 ? 0.25 : 0.7,
          ior: 1.333,
          depthWrite: false,
          side: THREE.DoubleSide,
        });

        const waterMesh = new THREE.Mesh(waterGeo, waterMat);
        scene.add(waterMesh);
        waterPlaneMeshRef.current = waterMesh;
      }
    }
  }, [
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
    waterMode,
    waterLevelOffsetFt,
    shadingStyle,
    terraceStepFt,
    flatShading,
    terrainSharpness,
  ]);

  // Raycaster interaction for hover probing
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !cameraRef.current || !terrainMeshRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(terrainMeshRef.current);

    if (intersects.length > 0) {
      const uv = intersects[0].uv;
      if (uv) {
        const { gridSize, elevations, depths, waterMask, minElevation, waterElevation } = gridData;
        const col = Math.min(gridSize - 1, Math.max(0, Math.round(uv.x * (gridSize - 1))));
        const row = Math.min(gridSize - 1, Math.max(0, Math.round(uv.y * (gridSize - 1))));

        const elevM = elevations[row][col];
        const depthM = depths[row][col];
        const isWater = waterMask[row][col];

        const elevFt = Math.round(elevM * 3.28084);
        const depthFt = Math.round(depthM * 3.28084 * 10) / 10;

        setHoverData({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          elevFt,
          depthFt,
          isWater,
        });

        if (onProbeInfo) {
          onProbeInfo({ elevationFt: elevFt, depthFt, isWater });
        }
        return;
      }
    }

    setHoverData(null);
    if (onProbeInfo) onProbeInfo(null);
  };

  const handlePointerLeave = () => {
    setHoverData(null);
    if (onProbeInfo) onProbeInfo(null);
  };

  // Camera preset view functions
  const setPresetView = (view: 'iso' | 'top' | 'south' | 'north' | 'side') => {
    if (!cameraRef.current || !controlsRef.current) return;
    const controls = controlsRef.current;
    const camera = cameraRef.current;

    controls.target.set(0, 8, 0);

    if (view === 'iso') {
      camera.position.set(0, 115, 145);
    } else if (view === 'top') {
      camera.position.set(0, 165, 0.1);
    } else if (view === 'south') {
      camera.position.set(0, 38, 145);
    } else if (view === 'north') {
      camera.position.set(0, 38, -145);
    } else if (view === 'side') {
      camera.position.set(145, 42, 0);
    }
    controls.update();
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full min-h-[460px] bg-slate-950 overflow-hidden rounded-xl select-none"
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-grab active:cursor-grabbing block"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      />

      {/* Floating View Controls & Presets */}
      <div className="absolute top-4 left-4 z-10 flex flex-wrap items-center gap-1.5 bg-slate-900/90 backdrop-blur-md px-2.5 py-1.5 rounded-lg border border-slate-700/70 shadow-lg text-xs text-slate-200">
        <span className="text-slate-400 font-medium px-1 flex items-center gap-1">
          <Eye className="w-3.5 h-3.5 text-sky-400" /> View:
        </span>
        <button
          onClick={() => setPresetView('iso')}
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer"
          title="Isometric 3D Perspective"
        >
          3D Angle
        </button>
        <button
          onClick={() => setPresetView('top')}
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer"
          title="Top-down Map View"
        >
          Top Map
        </button>
        <button
          onClick={() => setPresetView('south')}
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer"
          title="South Horizon View"
        >
          South
        </button>
        <button
          onClick={() => setPresetView('side')}
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors cursor-pointer"
          title="East Cross Profile View"
        >
          Profile
        </button>
        <button
          onClick={() => setPresetView('iso')}
          className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors ml-1 cursor-pointer"
          title="Reset Camera Position"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Floating Topo Map Sharpness & Terracing Bar */}
      <div className="absolute top-14 left-4 z-10 hidden sm:flex flex-wrap items-center gap-1.5 bg-slate-900/90 backdrop-blur-md px-2.5 py-1.5 rounded-lg border border-sky-500/30 shadow-lg text-xs text-slate-200">
        <span className="text-sky-400 font-semibold px-1 flex items-center gap-1 text-[11px]">
          <Mountain className="w-3.5 h-3.5 text-amber-400" /> Topo Style:
        </span>
        <button
          onClick={() => onUpdateShadingStyle?.('faceted-topo')}
          className={`px-2 py-1 rounded font-medium transition-all cursor-pointer ${
            shadingStyle === 'faceted-topo'
              ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
          }`}
          title="Sharp crisp polygon facets with zero blurry rounding (USGS Topo style)"
        >
          📐 Faceted Topo
        </button>
        <button
          onClick={() => onUpdateShadingStyle?.('stepped-terraces')}
          className={`px-2 py-1 rounded font-medium transition-all cursor-pointer ${
            shadingStyle === 'stepped-terraces'
              ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
          }`}
          title="Physical stepped contour tiers (like laser-cut wooden topo maps)"
        >
          ⛰️ Stepped Terraces
        </button>
        <button
          onClick={() => onUpdateShadingStyle?.('chiseled-ridges')}
          className={`px-2 py-1 rounded font-medium transition-all cursor-pointer ${
            shadingStyle === 'chiseled-ridges'
              ? 'bg-purple-500 text-white font-bold shadow-sm'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
          }`}
          title="High-relief chiseled ridges and steep breaklines"
        >
          ⚡ Chiseled
        </button>
        <button
          onClick={() => onUpdateShadingStyle?.('smooth')}
          className={`px-2 py-1 rounded font-medium transition-all cursor-pointer ${
            shadingStyle === 'smooth'
              ? 'bg-slate-600 text-white font-bold shadow-sm'
              : 'bg-slate-800/80 hover:bg-slate-700 text-slate-400'
          }`}
          title="Smooth blended normals"
        >
          Smooth
        </button>

        {shadingStyle === 'stepped-terraces' && (
          <div className="flex items-center gap-1 pl-1.5 border-l border-slate-700">
            <span className="text-[10px] text-slate-400">Step:</span>
            {[5, 10, 20].map((step) => (
              <button
                key={step}
                onClick={() => onUpdateTerraceStep?.(step)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer ${
                  terraceStepFt === step
                    ? 'bg-amber-400 text-slate-950 font-bold'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                }`}
              >
                {step}ft
              </button>
            ))}
          </div>
        )}

        {/* Lakebed / Water Surface Quick Toggle */}
        <div className="flex items-center gap-1 pl-2 border-l border-slate-700">
          <span className="text-cyan-400 font-semibold px-0.5 flex items-center gap-1 text-[11px]">
            <Waves className="w-3.5 h-3.5 text-cyan-400" /> Lake:
          </span>
          <button
            onClick={() => onUpdateWaterMode?.('carved-bed')}
            className={`px-2 py-1 rounded font-medium transition-all cursor-pointer ${
              waterMode === 'carved-bed'
                ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
            title="Exposed Carved Lakebed: Reveals 3D bathymetric relief, 30ft hole, and underwater channels (Best for 3D Topo & STL)"
          >
            🌊 Carved Bed
          </button>
          <button
            onClick={() => onUpdateWaterMode?.('translucent')}
            className={`px-2 py-1 rounded font-medium transition-all cursor-pointer ${
              waterMode === 'translucent'
                ? 'bg-cyan-400 text-slate-950 font-bold shadow-sm'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
            title="Translucent Water: Glass surface showing underwater bathymetry beneath"
          >
            💧 Water Surface
          </button>
        </div>
      </div>

      {/* 3D Navigation Guide Pill */}
      <div className="absolute bottom-4 left-4 z-10 hidden sm:flex items-center gap-2 bg-slate-900/80 backdrop-blur-md px-3 py-1.5 rounded-md border border-slate-800 text-[11px] text-slate-400">
        <span>Rotate: <strong className="text-slate-200">Left Click + Drag</strong></span>
        <span>•</span>
        <span>Pan: <strong className="text-slate-200">Right Click</strong></span>
        <span>•</span>
        <span>Zoom: <strong className="text-slate-200">Scroll</strong></span>
      </div>

      {/* Real-time Probe HUD */}
      {hoverData && (
        <div
          className="absolute pointer-events-none z-20 bg-slate-950/90 backdrop-blur-md border border-sky-500/40 px-3 py-2 rounded-lg shadow-xl text-xs text-white"
          style={{
            left: Math.min(hoverData.x + 15, (containerRef.current?.clientWidth || 600) - 170),
            top: Math.max(hoverData.y - 65, 20),
          }}
        >
          <div className="flex items-center gap-1.5 font-semibold text-sky-300">
            {hoverData.isWater ? (
              <>
                <Waves className="w-3.5 h-3.5 text-cyan-400" />
                <span>Lake Basin</span>
              </>
            ) : (
              <>
                <Compass className="w-3.5 h-3.5 text-emerald-400" />
                <span>Shore / Moraine</span>
              </>
            )}
          </div>
          <div className="mt-1 space-y-0.5 text-slate-300">
            <div>Elev: <span className="font-mono font-medium text-white">{hoverData.elevFt} ft</span></div>
            {hoverData.isWater && (
              <div>Depth: <span className="font-mono font-medium text-cyan-300">{hoverData.depthFt} ft</span></div>
            )}
          </div>
        </div>
      )}

      {/* Compass / Orientation Badge */}
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
