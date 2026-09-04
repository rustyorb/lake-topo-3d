import React, { useState, useEffect, useCallback } from 'react';
import { 
  Search, 
  Printer, 
  Download, 
  Sliders, 
  Layers, 
  MapPin, 
  Waves, 
  Mountain, 
  Compass, 
  Sparkles, 
  ChevronRight, 
  ChevronDown,
  ChevronUp,
  Eye, 
  Palette, 
  Info, 
  Maximize2,
  RefreshCw,
  HelpCircle,
  CheckCircle,
  ExternalLink,
  Map as MapIcon,
  Columns3,
  Box
} from 'lucide-react';
import { Lake3DViewer, WaterDisplayMode } from './components/Lake3DViewer.js';
import { STLExportDialog } from './components/STLExportDialog.js';
import { TopoMapViewer } from './components/TopoMapViewer.js';
import { GenerativeTopoPanel } from './components/GenerativeTopoPanel.js';
import { ColorSchemeMode, TerrainGridData, TopoFeature, TerrainShadingStyle } from './types.js';

const POPULAR_LAKES = [
  { label: 'Deam Lake, IN', query: 'Deam Lake, Indiana' },
  { label: 'Beals Lake, IN', query: 'Beals Lake, Indiana' },
  { label: 'Lake Wawasee, IN', query: 'Lake Wawasee, Indiana' },
  { label: 'Lake Monroe, IN', query: 'Lake Monroe, Indiana' },
  { label: 'Devils Lake, WI', query: 'Devils Lake, Wisconsin' },
  { label: 'Torch Lake, MI', query: 'Torch Lake, Michigan' },
  { label: 'Lake Mendota, WI', query: 'Lake Mendota, Wisconsin' },
  { label: 'Lake Maxinkuckee, IN', query: 'Lake Maxinkuckee, Indiana' },
  { label: 'Lake Minnetonka, MN', query: 'Lake Minnetonka, Minnesota' },
  { label: 'Lake of the Ozarks, MO', query: 'Lake of the Ozarks, Missouri' },
  { label: 'Geneva Lake, WI', query: 'Geneva Lake, Wisconsin' },
];

export type ViewDisplayMode = '3d' | 'topo' | 'split';

export default function App() {
  const [searchQuery, setSearchQuery] = useState<string>('Deam Lake, Indiana');
  const [currentQuery, setCurrentQuery] = useState<string>('Deam Lake, Indiana');
  const [gridData, setGridData] = useState<TerrainGridData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewDisplayMode>('3d');

  // 3D Visual Controls
  const [verticalExaggeration, setVerticalExaggeration] = useState<number>(2.2);
  const [baseThicknessRatio, setBaseThicknessRatio] = useState<number>(1.0);
  const [colorScheme, setColorScheme] = useState<ColorSchemeMode>('hypsometric');
  const [waterMode, setWaterMode] = useState<WaterDisplayMode>('carved-bed');
  const [showWaterPlane, setShowWaterPlane] = useState<boolean>(false);
  const [waterOpacity, setWaterOpacity] = useState<number>(0.28);
  const [waterLevelOffsetFt, setWaterLevelOffsetFt] = useState<number>(0);
  const [showSolidBase, setShowSolidBase] = useState<boolean>(true);
  const [showWireframe, setShowWireframe] = useState<boolean>(false);
  const [showContours, setShowContours] = useState<boolean>(true);
  const [contourIntervalFt, setContourIntervalFt] = useState<number>(10);
  const [shadingStyle, setShadingStyle] = useState<TerrainShadingStyle>('faceted-topo');
  const [terraceStepFt, setTerraceStepFt] = useState<number>(5);
  const [flatShading, setFlatShading] = useState<boolean>(true);
  const [terrainSharpness, setTerrainSharpness] = useState<number>(1.8);

  const handleWaterModeChange = (mode: WaterDisplayMode) => {
    setWaterMode(mode);
    if (mode === 'carved-bed') {
      setShowWaterPlane(false);
    } else if (mode === 'translucent') {
      setShowWaterPlane(true);
      setWaterOpacity(0.28);
    } else if (mode === 'filled') {
      setShowWaterPlane(true);
      setWaterOpacity(0.85);
    }
  };

  // STL Dialog state
  const [isExportDialogOpen, setIsExportDialogOpen] = useState<boolean>(false);
  const [isOverviewExpanded, setIsOverviewExpanded] = useState<boolean>(false);

  // Live cursor probe
  const [probeInfo, setProbeInfo] = useState<{ elevationFt: number; depthFt: number; isWater: boolean } | null>(null);

  // Fetch lake data with optional AI recon and user notes
  const fetchLakeData = useCallback(async (query: string, options?: { forceAiRecon?: boolean; userNotes?: string }) => {
    setIsLoading(true);
    setError(null);
    try {
      let url = `/api/lake-terrain?q=${encodeURIComponent(query)}&gridSize=72`;
      if (options?.forceAiRecon) {
        url += `&forceAiRecon=true`;
      }
      if (options?.userNotes) {
        url += `&userNotes=${encodeURIComponent(options.userNotes)}`;
      }
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to load lake terrain (${res.status})`);
      }
      const data: TerrainGridData = await res.json();
      setGridData(data);
      setCurrentQuery(query);
    } catch (err: any) {
      console.error('Error fetching lake:', err);
      setError(err.message || 'Could not fetch lake data. Please check connection.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Handle upload of topo map image via Gemini Vision
  const handleUploadTopoImage = async (imageBase64: string, mimeType: string, lakeName?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analyze-topo-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64,
          mimeType,
          query: lakeName || currentQuery,
          gridSize: 72,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to analyze topo image (${res.status})`);
      }
      const data: TerrainGridData = await res.json();
      setGridData(data);
      setCurrentQuery(data.metadata.name);
      setSearchQuery(data.metadata.name);
    } catch (err: any) {
      console.error('Error uploading topo image:', err);
      setError(err.message || 'Failed to analyze topo image.');
    } finally {
      setIsLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchLakeData('Deam Lake, Indiana');
  }, [fetchLakeData]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      fetchLakeData(searchQuery.trim());
    }
  };

  const selectLakePreset = (lakeQuery: string) => {
    setSearchQuery(lakeQuery);
    fetchLakeData(lakeQuery);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 bg-slate-900/90 backdrop-blur-md border-b border-slate-800/80 px-4 py-3 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
          {/* Brand Logo & Tagline */}
          <div className="flex items-center gap-3 w-full md:w-auto justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-400 p-0.5 shadow-md shadow-sky-500/20">
                <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center text-sky-400">
                  <Mountain className="w-5 h-5" />
                </div>
              </div>
              <div>
                <h1 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
                  Midwestern Lake 3D
                  <span className="text-[10px] uppercase font-semibold tracking-wider px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20">
                    Topo & STL
                  </span>
                </h1>
                <p className="text-[11px] text-slate-400">
                  Topographical & Bathymetric Modeling for 3D Printing
                </p>
              </div>
            </div>

            {/* Mobile Export Button */}
            <button
              onClick={() => setIsExportDialogOpen(true)}
              disabled={isLoading || !gridData}
              className="md:hidden px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Export STL</span>
            </button>
          </div>

          {/* Search Input */}
          <form
            onSubmit={handleSearchSubmit}
            className="w-full md:max-w-md flex items-center relative"
          >
            <div className="relative w-full">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Enter any Midwestern lake (e.g. Deam Lake, Indiana)..."
                className="w-full bg-slate-950 border border-slate-700/80 hover:border-slate-600 focus:border-sky-500 pl-9 pr-20 py-2 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all shadow-inner"
              />
              <button
                type="submit"
                disabled={isLoading}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
              >
                {isLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : 'Generate'}
              </button>
            </div>
          </form>

          {/* Desktop Export Button */}
          <div className="hidden md:flex items-center gap-3">
            <button
              onClick={() => setIsExportDialogOpen(true)}
              disabled={isLoading || !gridData}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 flex items-center gap-2 transition-all shadow-lg shadow-sky-500/25 hover:shadow-sky-500/40 cursor-pointer disabled:opacity-50"
            >
              <Printer className="w-4 h-4" />
              <span>Export to STL (3D Print)</span>
            </button>
          </div>
        </div>

        {/* Quick Lake Chips */}
        <div className="max-w-7xl mx-auto mt-2.5 pt-2 border-t border-slate-800/60 flex items-center gap-1.5 overflow-x-auto no-scrollbar text-xs">
          <span className="text-[11px] text-slate-500 font-medium shrink-0 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-amber-400" /> Examples:
          </span>
          {POPULAR_LAKES.map((item) => (
            <button
              key={item.label}
              onClick={() => selectLakePreset(item.query)}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] transition-all cursor-pointer ${
                currentQuery.toLowerCase() === item.query.toLowerCase()
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 font-medium'
                  : 'bg-slate-800/70 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border border-slate-800'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main Content Layout */}
      <main className="flex-1 max-w-7xl mx-auto w-full p-4 sm:p-6 flex flex-col gap-5">
        {/* View Mode Bar & Header Subline */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/80 border border-slate-800/80 px-4 py-2.5 rounded-2xl shadow-lg backdrop-blur">
          <div className="flex items-center space-x-2">
            <span className="text-xs font-semibold text-slate-300">Active View:</span>
            <div className="inline-flex p-1 bg-slate-950 rounded-xl border border-slate-800">
              <button
                onClick={() => setViewMode('3d')}
                className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                  viewMode === '3d'
                    ? 'bg-sky-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Box className="w-3.5 h-3.5" />
                <span>3D Terrain & Bathymetry</span>
              </button>
              <button
                onClick={() => setViewMode('topo')}
                className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                  viewMode === 'topo'
                    ? 'bg-sky-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <MapIcon className="w-3.5 h-3.5" />
                <span>2D Topo Survey Map</span>
              </button>
              <button
                onClick={() => setViewMode('split')}
                className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-medium transition cursor-pointer ${
                  viewMode === 'split'
                    ? 'bg-sky-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Columns3 className="w-3.5 h-3.5" />
                <span>Split Dual View</span>
              </button>
            </div>
          </div>

          {/* Quick status on probe or lake metadata */}
          {probeInfo && (
            <div className="hidden md:flex items-center space-x-3 text-xs font-mono bg-slate-950/60 px-3 py-1 rounded-lg border border-slate-800">
              <span className="text-slate-400">Cursor Probe:</span>
              <span className={probeInfo.isWater ? 'text-cyan-400' : 'text-emerald-400'}>
                {probeInfo.isWater ? `Water Depth: ${probeInfo.depthFt} ft` : `Land Elev: ${probeInfo.elevationFt} ft`}
              </span>
            </div>
          )}
        </div>

        {/* Dynamic Display Grid based on View Mode */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Main Visual Stage (Columns span depends on viewMode) */}
          <div className="lg:col-span-8 flex flex-col gap-4">
            {/* Viewport Container */}
            <div className="relative bg-slate-900 border border-slate-800/90 rounded-2xl p-2 shadow-2xl flex flex-col min-h-[540px] sm:min-h-[620px]">
              {isLoading ? (
                <div className="w-full h-full flex-1 flex flex-col items-center justify-center gap-3 text-slate-400 p-8">
                  <div className="w-10 h-10 border-3 border-sky-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs font-medium animate-pulse text-sky-300">
                    Determining Topography & Depth Contours from Survey Records...
                  </p>
                  <p className="text-[11px] text-slate-500 text-center max-w-sm">
                    Synthesizing USGS 7.5-minute quadrangles, DNR bathymetric charts, and surrounding glacial moraines
                  </p>
                </div>
              ) : error ? (
                <div className="w-full h-full flex-1 flex flex-col items-center justify-center p-6 text-center">
                  <p className="text-rose-400 text-sm font-semibold mb-2">Error Generating Lake Terrain</p>
                  <p className="text-xs text-slate-400 max-w-sm mb-4">{error}</p>
                  <button
                    onClick={() => fetchLakeData('Deam Lake, Indiana')}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs rounded-lg text-white cursor-pointer"
                  >
                    Load Deam Lake, Indiana
                  </button>
                </div>
              ) : gridData ? (
                <div className="w-full h-full flex-1 flex flex-col">
                  {/* Mode 1: 3D Only */}
                  {viewMode === '3d' && (
                    <div className="w-full h-full flex-1 min-h-[520px]">
                      <Lake3DViewer
                        gridData={gridData}
                        verticalExaggeration={verticalExaggeration}
                        baseThicknessRatio={baseThicknessRatio}
                        colorScheme={colorScheme}
                        waterMode={waterMode}
                        showWaterPlane={showWaterPlane}
                        waterLevelOffsetFt={waterLevelOffsetFt}
                        showWireframe={showWireframe}
                        showSolidBase={showSolidBase}
                        showContours={showContours}
                        contourIntervalFt={contourIntervalFt}
                        waterOpacity={waterOpacity}
                        shadingStyle={shadingStyle}
                        terraceStepFt={terraceStepFt}
                        flatShading={flatShading}
                        terrainSharpness={terrainSharpness}
                        onUpdateShadingStyle={setShadingStyle}
                        onUpdateTerraceStep={setTerraceStepFt}
                        onUpdateFlatShading={setFlatShading}
                        onUpdateWaterMode={handleWaterModeChange}
                        onUpdateWaterLevelOffsetFt={setWaterLevelOffsetFt}
                        onProbeInfo={setProbeInfo}
                      />
                    </div>
                  )}

                  {/* Mode 2: 2D Topo Map Only */}
                  {viewMode === 'topo' && (
                    <div className="w-full h-full flex-1 min-h-[520px]">
                      <TopoMapViewer gridData={gridData} />
                    </div>
                  )}

                  {/* Mode 3: Split Dual View */}
                  {viewMode === 'split' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full h-full flex-1 min-h-[520px]">
                      <div className="h-[520px] rounded-xl overflow-hidden border border-slate-800">
                        <Lake3DViewer
                          gridData={gridData}
                          verticalExaggeration={verticalExaggeration}
                          baseThicknessRatio={baseThicknessRatio}
                          colorScheme={colorScheme}
                          waterMode={waterMode}
                          showWaterPlane={showWaterPlane}
                          waterLevelOffsetFt={waterLevelOffsetFt}
                          showWireframe={showWireframe}
                          showSolidBase={showSolidBase}
                          showContours={showContours}
                          contourIntervalFt={contourIntervalFt}
                          waterOpacity={waterOpacity}
                          shadingStyle={shadingStyle}
                          terraceStepFt={terraceStepFt}
                          flatShading={flatShading}
                          terrainSharpness={terrainSharpness}
                          onUpdateShadingStyle={setShadingStyle}
                          onUpdateTerraceStep={setTerraceStepFt}
                          onUpdateFlatShading={setFlatShading}
                          onUpdateWaterMode={handleWaterModeChange}
                          onUpdateWaterLevelOffsetFt={setWaterLevelOffsetFt}
                          onProbeInfo={setProbeInfo}
                        />
                      </div>
                      <div className="h-[520px] rounded-xl overflow-hidden border border-slate-800">
                        <TopoMapViewer gridData={gridData} />
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            {/* Quick Stats Bar Under Map */}
            {gridData && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-slate-900/90 border border-slate-800/80 p-3 rounded-xl">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-mono">Max Depth</span>
                  <span className="text-base font-bold text-sky-400 font-mono">
                    {gridData.metadata.maxDepthFt} ft
                  </span>
                  <span className="text-[10px] text-slate-500 block">({gridData.metadata.maxDepthM} m)</span>
                </div>

                <div className="bg-slate-900/90 border border-slate-800/80 p-3 rounded-xl">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-mono">Surface Elevation</span>
                  <span className="text-base font-bold text-emerald-400 font-mono">
                    {gridData.metadata.surfaceElevationFt} ft
                  </span>
                  <span className="text-[10px] text-slate-500 block">({gridData.metadata.surfaceElevationM} m MSL)</span>
                </div>

                <div className="bg-slate-900/90 border border-slate-800/80 p-3 rounded-xl">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-mono">Surface Area</span>
                  <span className="text-base font-bold text-amber-400 font-mono">
                    {gridData.metadata.areaAcres.toLocaleString()} ac
                  </span>
                  <span className="text-[10px] text-slate-500 block">
                    ({(gridData.metadata.areaAcres * 0.0015625).toFixed(2)} sq mi)
                  </span>
                </div>

                <div className="bg-slate-900/90 border border-slate-800/80 p-3 rounded-xl">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-mono">Topographic Relief</span>
                  <span className="text-base font-bold text-purple-400 font-mono">
                    {Math.round((gridData.maxElevation - gridData.minElevation) * 3.28084)} ft
                  </span>
                  <span className="text-[10px] text-slate-500 block">
                    Shoreline to deep basin
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: 3D Manipulation Panel FIRST, then Overview & Generative Recon */}
          <div className="lg:col-span-4 flex flex-col gap-4 lg:sticky lg:top-4 self-start">
            {/* 3D Manipulation Controls Panel - At the very top so it's always visible alongside the 3D object */}
            <div className="bg-slate-900 border border-slate-800/90 rounded-2xl p-5 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-sky-400" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    3D Model Manipulator
                  </h3>
                </div>
                <span className="text-[10px] bg-sky-500/10 text-sky-400 font-mono px-2 py-0.5 rounded-full border border-sky-500/20">
                  Live View
                </span>
              </div>

              {/* Vertical Exaggeration Slider */}
              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-slate-400">Vertical Relief Exaggeration:</span>
                  <span className="font-mono font-bold text-sky-400">{verticalExaggeration.toFixed(1)}x</span>
                </div>
                <input
                  type="range"
                  min={1.0}
                  max={4.0}
                  step={0.1}
                  value={verticalExaggeration}
                  onChange={(e) => setVerticalExaggeration(Number(e.target.value))}
                  className="w-full accent-sky-500 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
                  <span>1.0x (True scale)</span>
                  <span>2.2x (Optimal)</span>
                  <span>4.0x (Dramatic)</span>
                </div>
              </div>

              {/* Topo Map Sharpness & Contours Style */}
              <div className="p-3 bg-slate-950/60 rounded-xl border border-sky-500/25 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-sky-300 flex items-center gap-1.5">
                    <Mountain className="w-3.5 h-3.5 text-amber-400" />
                    Topo Sharpness & Style:
                  </label>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {shadingStyle === 'faceted-topo' ? 'Crisp Facets' : shadingStyle === 'stepped-terraces' ? 'Stepped' : shadingStyle === 'chiseled-ridges' ? 'Chiseled' : 'Smooth'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { id: 'faceted-topo', label: '📐 Faceted Topo', desc: 'Crisp facets, zero rounding' },
                    { id: 'stepped-terraces', label: '⛰️ Stepped Terraces', desc: 'Layered contour tiers' },
                    { id: 'chiseled-ridges', label: '⚡ Chiseled Ridges', desc: 'Sharp breaklines & crests' },
                    { id: 'smooth', label: 'Smooth Blend', desc: 'Soft gradient lighting' },
                  ].map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      onClick={() => setShadingStyle(style.id as TerrainShadingStyle)}
                      className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                        shadingStyle === style.id
                          ? 'bg-sky-500/20 text-sky-200 border-sky-500/80 shadow-sm font-semibold'
                          : 'bg-slate-900/60 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-300'
                      }`}
                    >
                      <div className="text-xs font-medium">{style.label}</div>
                      <div className="text-[9px] text-slate-400 leading-tight mt-0.5">{style.desc}</div>
                    </button>
                  ))}
                </div>

                {shadingStyle === 'stepped-terraces' && (
                  <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                    <div className="flex justify-between text-[11px] text-slate-300">
                      <span>Terrace Contour Step:</span>
                      <span className="font-mono text-amber-400 font-bold">{terraceStepFt} ft</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[5, 10, 20].map((step) => (
                        <button
                          key={step}
                          type="button"
                          onClick={() => setTerraceStepFt(step)}
                          className={`py-1 rounded text-xs font-mono font-medium transition-colors cursor-pointer ${
                            terraceStepFt === step
                              ? 'bg-amber-500 text-slate-950 font-bold'
                              : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                          }`}
                        >
                          {step} ft
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {shadingStyle === 'chiseled-ridges' && (
                  <div className="pt-2 border-t border-slate-800/80 space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-300">
                      <span>Ridge & Shelf Sharpness:</span>
                      <span className="font-mono text-purple-400 font-bold">{terrainSharpness.toFixed(1)}x</span>
                    </div>
                    <input
                      type="range"
                      min={1.2}
                      max={2.8}
                      step={0.1}
                      value={terrainSharpness}
                      onChange={(e) => setTerrainSharpness(Number(e.target.value))}
                      className="w-full accent-purple-500 cursor-pointer"
                    />
                  </div>
                )}

                {/* Flat Facet Normals Toggle */}
                <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                  <label className="text-xs text-slate-300 flex items-center gap-1.5 cursor-pointer">
                    <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                    <span>Crisp Polygon Faceting</span>
                  </label>
                  <input
                    type="checkbox"
                    checked={flatShading}
                    onChange={(e) => setFlatShading(e.target.checked)}
                    className="w-4 h-4 accent-sky-400 cursor-pointer rounded"
                  />
                </div>
              </div>

              {/* Color Palette Selector */}
              <div>
                <label className="text-xs text-slate-400 flex items-center gap-1.5 mb-2">
                  <Palette className="w-3.5 h-3.5 text-purple-400" />
                  Hypsometric Color Mapping:
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { id: 'hypsometric', label: 'Cartographic' },
                    { id: 'bathymetric', label: 'Deep Blue' },
                    { id: 'topographic', label: 'USGS Topo' },
                    { id: 'satellite', label: 'Natural Earth' },
                    { id: 'print-resin', label: '3D Print PLA' },
                    { id: 'slate', label: 'Architect' },
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      onClick={() => setColorScheme(mode.id as ColorSchemeMode)}
                      className={`py-1.5 px-2 rounded-lg text-[11px] font-medium border text-center transition-all cursor-pointer ${
                        colorScheme === mode.id
                          ? 'bg-sky-500/20 text-sky-300 border-sky-500/60 font-semibold'
                          : 'bg-slate-950/60 text-slate-400 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Lakebed & Water Display Mode */}
              <div className="space-y-2 p-3 rounded-xl bg-slate-900/80 border border-slate-800">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-slate-300 flex items-center gap-1.5 font-semibold">
                    <Waves className="w-3.5 h-3.5 text-cyan-400" />
                    Lakebed & Water Surface
                  </label>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300">
                    {waterMode === 'carved-bed' ? 'Exposed Bathymetry' : waterMode === 'translucent' ? 'Translucent Water' : 'Full Pool'}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleWaterModeChange('carved-bed')}
                    className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                      waterMode === 'carved-bed'
                        ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/80 shadow-sm font-semibold'
                        : 'bg-slate-950/60 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-300'
                    }`}
                  >
                    <div className="text-xs font-medium">🌊 Carved Bed</div>
                    <div className="text-[9px] text-slate-400 leading-tight mt-0.5">3D bathymetry & deep holes (Best for 3D Topo)</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleWaterModeChange('translucent')}
                    className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                      waterMode === 'translucent'
                        ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/80 shadow-sm font-semibold'
                        : 'bg-slate-950/60 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-300'
                    }`}
                  >
                    <div className="text-xs font-medium">💧 Glass Water</div>
                    <div className="text-[9px] text-slate-400 leading-tight mt-0.5">See underwater relief through crystal water</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleWaterModeChange('filled')}
                    className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                      waterMode === 'filled'
                        ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/80 shadow-sm font-semibold'
                        : 'bg-slate-950/60 text-slate-400 border-slate-800 hover:border-slate-700 hover:text-slate-300'
                    }`}
                  >
                    <div className="text-xs font-medium">🌊 Full Pool</div>
                    <div className="text-[9px] text-slate-400 leading-tight mt-0.5">Normal pool waterline level</div>
                  </button>
                </div>

                {/* When water is visible: Interactive Pool Elevation & Transparency */}
                {waterMode !== 'carved-bed' && (
                  <div className="pt-2 border-t border-slate-800/80 space-y-2.5">
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-300 mb-1">
                        <span>Water Level Elevation:</span>
                        <span className={`font-mono font-bold ${waterLevelOffsetFt < 0 ? 'text-amber-400' : waterLevelOffsetFt > 0 ? 'text-cyan-400' : 'text-emerald-400'}`}>
                          {waterLevelOffsetFt === 0 ? 'Normal Pool (0 ft)' : `${waterLevelOffsetFt > 0 ? '+' : ''}${waterLevelOffsetFt} ft`}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={-25}
                        max={10}
                        step={1}
                        value={waterLevelOffsetFt}
                        onChange={(e) => setWaterLevelOffsetFt(Number(e.target.value))}
                        className="w-full accent-cyan-400 cursor-pointer"
                      />
                      <div className="flex justify-between text-[9px] text-slate-500 mt-0.5">
                        <button
                          type="button"
                          onClick={() => setWaterLevelOffsetFt(-20)}
                          className="hover:text-amber-400 cursor-pointer underline decoration-dotted"
                        >
                          -20ft Drawdown
                        </button>
                        <button
                          type="button"
                          onClick={() => setWaterLevelOffsetFt(0)}
                          className="hover:text-emerald-400 cursor-pointer underline decoration-dotted"
                        >
                          Normal Pool
                        </button>
                        <button
                          type="button"
                          onClick={() => setWaterLevelOffsetFt(5)}
                          className="hover:text-cyan-400 cursor-pointer underline decoration-dotted"
                        >
                          +5ft Spring Flood
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between text-[11px] text-slate-300 mb-1">
                        <span>Water Transparency:</span>
                        <span className="font-mono text-cyan-400">{Math.round(waterOpacity * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min={0.1}
                        max={0.95}
                        step={0.05}
                        value={waterOpacity}
                        onChange={(e) => setWaterOpacity(Number(e.target.value))}
                        className="w-full accent-cyan-400 cursor-pointer"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Layer Toggles */}
              <div className="space-y-2.5 pt-2 border-t border-slate-800/70">

                {/* Solid 3D Printable Pedestal Base */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-300 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-emerald-400" />
                    Solid Pedestal (3D Print Block)
                  </span>
                  <input
                    type="checkbox"
                    checked={showSolidBase}
                    onChange={(e) => setShowSolidBase(e.target.checked)}
                    className="w-4 h-4 accent-emerald-500 cursor-pointer rounded"
                  />
                </div>

                {/* Contour Elevation Lines */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-300 flex items-center gap-1.5">
                    <Compass className="w-3.5 h-3.5 text-amber-400" />
                    Contour Elevation Bands
                  </span>
                  <input
                    type="checkbox"
                    checked={showContours}
                    onChange={(e) => setShowContours(e.target.checked)}
                    className="w-4 h-4 accent-amber-500 cursor-pointer rounded"
                  />
                </div>

                {/* Wireframe Mesh Toggle */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-300 flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5 text-slate-400" />
                    Wireframe Triangulation
                  </span>
                  <input
                    type="checkbox"
                    checked={showWireframe}
                    onChange={(e) => setShowWireframe(e.target.checked)}
                    className="w-4 h-4 accent-slate-400 cursor-pointer rounded"
                  />
                </div>
              </div>

              {/* Quick Export Button */}
              <div className="pt-3 border-t border-slate-800/80">
                <button
                  onClick={() => setIsExportDialogOpen(true)}
                  disabled={isLoading || !gridData}
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-gradient-to-r from-sky-500 to-cyan-500 hover:from-sky-400 hover:to-cyan-400 text-slate-950 flex items-center justify-center gap-2 shadow-lg shadow-sky-500/20 cursor-pointer transition-all disabled:opacity-50"
                >
                  <Download className="w-4 h-4" />
                  <span>Configure & Export STL</span>
                </button>
              </div>
            </div>

            {/* Lake Geological Overview Card - Below manipulator with collapsible features */}
            {gridData && (
              <div className="bg-slate-900 border border-slate-800/90 rounded-2xl p-4 shadow-xl">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs text-sky-400 font-medium mb-0.5">
                      <MapPin className="w-3.5 h-3.5" />
                      <span>{gridData.metadata.county ? `${gridData.metadata.county}, ` : ''}{gridData.metadata.state}</span>
                    </div>
                    <h2 className="text-base font-bold text-white tracking-tight">
                      {gridData.metadata.name}
                    </h2>
                  </div>
                  <div className="text-right text-[10px] font-mono text-slate-500">
                    <div>{gridData.metadata.lat.toFixed(3)}°N</div>
                    <div>{Math.abs(gridData.metadata.lon).toFixed(3)}°W</div>
                  </div>
                </div>

                <div className="mt-2 text-xs text-slate-300 leading-relaxed">
                  {gridData.metadata.description}
                </div>

                {/* Collapsible toggle for deep survey details & geology */}
                <div className="mt-3 pt-2.5 border-t border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => setIsOverviewExpanded(!isOverviewExpanded)}
                    className="w-full flex items-center justify-between text-xs text-sky-400 hover:text-sky-300 font-medium py-1 cursor-pointer transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      {isOverviewExpanded ? 'Hide Survey & Geological Details' : 'View DNR Hydrographic Survey & Geology'}
                    </span>
                    {isOverviewExpanded ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </button>

                  {isOverviewExpanded && (
                    <div className="mt-2.5 space-y-2.5">
                      {gridData.metadata.id === 'deam-lake-in' && (
                        <div className="p-2.5 rounded-xl bg-sky-950/40 border border-sky-500/30 text-[11px] text-sky-200/90 space-y-1">
                          <div className="flex items-center gap-1.5 font-semibold text-sky-300">
                            <span>DNR Hydrographic Survey Mapped:</span>
                          </div>
                          <ul className="list-disc list-inside space-y-0.5 text-slate-300 text-[10px]">
                            <li><strong>30-ft Hole:</strong> Deepest depression in south basin (30.0 ft / 9.1 m)</li>
                            <li><strong>Stone Branch North Arm:</strong> Long winding inlet channel from north hills</li>
                            <li><strong>Northwest Arm & West Boat Ramp:</strong> Winding feeder cove & launch basin</li>
                            <li><strong>East Antler Bays:</strong> Distinct dual-prong coves along east shore</li>
                            <li><strong>South Dam:</strong> Earthen impoundment wall along Deam Lake Road</li>
                          </ul>
                        </div>
                      )}

                      <div className="text-[11px] text-slate-400 flex items-start gap-1.5 p-2 bg-slate-950/50 rounded-lg">
                        <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
                        <span>
                          <strong className="text-slate-300">Geology:</strong> {gridData.metadata.geologicalOrigin}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Generative Topo Map Recon Panel */}
            {gridData && (
              <GenerativeTopoPanel
                gridData={gridData}
                isLoading={isLoading}
                onTriggerAiRecon={(query, notes) => fetchLakeData(query, { forceAiRecon: true, userNotes: notes })}
                onUploadTopoImage={handleUploadTopoImage}
              />
            )}
          </div>
        </div>
      </main>

      {/* STL Export Modal Dialog */}
      {gridData && (
        <STLExportDialog
          isOpen={isExportDialogOpen}
          onClose={() => setIsExportDialogOpen(false)}
          gridData={gridData}
          currentExaggeration={verticalExaggeration}
        />
      )}
    </div>
  );
}
