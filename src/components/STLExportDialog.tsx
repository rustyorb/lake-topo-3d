import React, { useState, useMemo } from 'react';
import { TerrainGridData, STLOptions } from '../types.js';
import {
  generateWatertightSTLMesh,
  generateSplitMeshes,
  exportToBinarySTL,
  exportToAsciiSTL,
  exportTo3MF,
  downloadBlob,
  suggestExaggeration,
} from '../utils/stlExporter.js';
import { suggestDepthBoost } from '../lib/relief.js';
import { buildLayerPack, layerPackSvg, layerPackDxf } from '../lib/layers.js';
import {
  Download,
  X,
  Printer,
  Sliders,
  CheckCircle2,
  Layers,
  Box,
  FileCode2,
  Palette,
  Scissors,
} from 'lucide-react';

export type MaterialMode = 'single' | 'split-stl' | '3mf';

const LAND_COLOR = '#D6C7A1';
const WATER_COLOR = '#3B82F6';

interface STLExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  gridData: TerrainGridData;
  currentExaggeration: number;
  currentDepthBoost?: number;
}

export const STLExportDialog: React.FC<STLExportDialogProps> = ({
  isOpen,
  onClose,
  gridData,
  currentExaggeration,
  currentDepthBoost = 1,
}) => {
  const [targetWidthMm, setTargetWidthMm] = useState<number>(120);
  const [baseThicknessMm, setBaseThicknessMm] = useState<number>(4);
  const [verticalExaggeration, setVerticalExaggeration] = useState<number>(currentExaggeration || 3);
  const [depthBoost, setDepthBoost] = useState<number>(currentDepthBoost || 1);
  const [includeWaterCap, setIncludeWaterCap] = useState<boolean>(false);
  const [terraceContours, setTerraceContours] = useState<boolean>(false);
  const [terraceStepFt, setTerraceStepFt] = useState<number>(5);
  const [format, setFormat] = useState<'binary' | 'ascii'>('binary');
  const [materialMode, setMaterialMode] = useState<MaterialMode>('single');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [downloadSuccess, setDownloadSuccess] = useState<boolean>(false);
  const [laserStepFt, setLaserStepFt] = useState<number>(5);
  const [laserIncludeLand, setLaserIncludeLand] = useState<boolean>(true);
  const [laserThicknessMm, setLaserThicknessMm] = useState<number>(3);

  // Compute live mesh statistics
  const meshPreview = useMemo(() => {
    const opts: STLOptions = {
      baseThicknessMm,
      targetWidthMm,
      verticalExaggeration,
      depthBoost,
      includeWaterCap,
      format,
      terraceContours,
      terraceStepFt,
    };
    return generateWatertightSTLMesh(gridData, opts);
  }, [gridData, targetWidthMm, baseThicknessMm, verticalExaggeration, depthBoost, includeWaterCap, terraceContours, terraceStepFt]);

  // Two mating solids (land, lake bed) for multi-material printers; only built when asked for.
  const splitPreview = useMemo(() => {
    if (materialMode === 'single') return null;
    const opts: STLOptions = { baseThicknessMm, targetWidthMm, verticalExaggeration, depthBoost, includeWaterCap, format, terraceContours, terraceStepFt };
    return generateSplitMeshes(gridData, opts);
  }, [gridData, targetWidthMm, baseThicknessMm, verticalExaggeration, depthBoost, includeWaterCap, terraceContours, terraceStepFt, materialMode]);

  // Laser-cut layer pack: contour rings per level, tiled on one page at the print width.
  const layerPack = useMemo(
    () => buildLayerPack(gridData, { stepFt: laserStepFt, widthMm: targetWidthMm, includeLand: laserIncludeLand }),
    [gridData, laserStepFt, targetWidthMm, laserIncludeLand]
  );

  const trueScale = Math.round(1000 / meshPreview.stats.mmPerMetreHorizontal);

  if (!isOpen) return null;

  const downloadLayers = (kind: 'svg' | 'dxf') => {
    const text = kind === 'svg' ? layerPackSvg(layerPack, gridData.metadata.name) : layerPackDxf(layerPack, gridData.metadata.name);
    const slug = `${gridData.metadata.name} ${gridData.metadata.state}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadBlob(new Blob([text], { type: kind === 'svg' ? 'image/svg+xml;charset=utf-8' : 'application/dxf' }), `${slug}-laser-${laserStepFt}ft-${targetWidthMm}mm.${kind}`);
  };

  const handleExport = () => {
    setIsExporting(true);
    setDownloadSuccess(false);

    setTimeout(() => {
      try {
        const lakeSlug = gridData.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const stateSlug = gridData.metadata.state.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const stem = `${lakeSlug}-${stateSlug}-${targetWidthMm}mm-${verticalExaggeration.toFixed(1)}x`;
        const encode = (tris: typeof meshPreview.triangles, name: string) =>
          format === 'binary' ? exportToBinarySTL(tris, name) : exportToAsciiSTL(tris, name);

        if (materialMode === 'single' || !splitPreview) {
          downloadBlob(encode(meshPreview.triangles, gridData.metadata.name), `${stem}.stl`);
        } else if (materialMode === 'split-stl') {
          downloadBlob(encode(splitPreview.land.triangles, `${gridData.metadata.name} land`), `${stem}-land.stl`);
          // A second download a beat later so the browser does not swallow it
          setTimeout(() => downloadBlob(encode(splitPreview.water.triangles, `${gridData.metadata.name} lake`), `${stem}-lake.stl`), 400);
        } else {
          downloadBlob(
            exportTo3MF(
              [
                { name: 'Land', triangles: splitPreview.land.triangles, colorHex: LAND_COLOR },
                { name: 'Lake bed', triangles: splitPreview.water.triangles, colorHex: WATER_COLOR },
              ],
              gridData.metadata.name
            ),
            `${stem}.3mf`
          );
        }
        setDownloadSuccess(true);
      } catch (err) {
        console.error('Failed to generate STL:', err);
      } finally {
        setIsExporting(false);
      }
    }, 120);
  };

  const estimatedFileSizeMb = (
    format === 'binary' 
      ? (84 + meshPreview.stats.triangleCount * 50) / (1024 * 1024)
      : (meshPreview.stats.triangleCount * 180) / (1024 * 1024)
  ).toFixed(2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        className="relative w-full max-w-xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-white text-base">Export 3D Printable STL</h3>
              <p className="text-xs text-slate-400">
                Watertight manifold mesh for {gridData.metadata.name}, {gridData.metadata.state}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body controls */}
        <div className="p-6 space-y-5 max-h-[78vh] overflow-y-auto">
          {/* Slicing & Bed Size Dimensions */}
          <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Box className="w-3.5 h-3.5 text-sky-400" />
                Print Bed Width (X axis):
              </label>
              <span className="font-mono text-xs font-bold text-sky-400">{targetWidthMm} mm</span>
            </div>
            <input
              type="range"
              min={60}
              max={240}
              step={5}
              value={targetWidthMm}
              onChange={(e) => setTargetWidthMm(Number(e.target.value))}
              className="w-full accent-sky-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-slate-500 mt-1">
              <span>60 mm (Mini)</span>
              <span>120 mm (Standard Display)</span>
              <span>240 mm (Large Plaque)</span>
            </div>
          </div>

          {/* Base Pedestal Thickness */}
          <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
                Base Pedestal Thickness:
              </label>
              <span className="font-mono text-xs font-bold text-emerald-400">{baseThicknessMm} mm</span>
            </div>
            <input
              type="range"
              min={2}
              max={15}
              step={1}
              value={baseThicknessMm}
              onChange={(e) => setBaseThicknessMm(Number(e.target.value))}
              className="w-full accent-emerald-500 cursor-pointer"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              Adds a solid horizontal footing underneath the lowest lake depression to ensure rigidity.
            </p>
          </div>

          {/* Vertical Exaggeration */}
          <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-amber-400" />
                Z Vertical Relief Exaggeration:
              </label>
              <span className="font-mono text-xs font-bold text-amber-400">{verticalExaggeration.toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min={1.0}
              max={25.0}
              step={0.1}
              value={verticalExaggeration}
              onChange={(e) => setVerticalExaggeration(Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer"
            />
            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
              <span>1.0x is true scale (horizontal 1:{trueScale.toLocaleString()}). This lake's relief prints at {meshPreview.stats.reliefMm} mm.</span>
              <button
                type="button"
                onClick={() => setVerticalExaggeration(suggestExaggeration(gridData, targetWidthMm, 0.14, depthBoost))}
                className="shrink-0 ml-2 text-amber-400 hover:text-amber-300 underline decoration-dotted cursor-pointer"
              >
                auto-fit
              </button>
            </div>
          </div>

          {/* Depth boost: exaggerate the lake bed more than the land */}
          <div className="bg-slate-950/60 p-4 rounded-xl border border-cyan-900/60">
            <div className="flex justify-between items-center mb-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                Lake Bed Depth Boost (on top of the relief above):
              </label>
              <span className="font-mono text-xs font-bold text-cyan-400">×{depthBoost.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={1}
              max={8}
              step={0.1}
              value={depthBoost}
              onChange={(e) => setDepthBoost(Number(e.target.value))}
              className="w-full accent-cyan-500 cursor-pointer"
            />
            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
              <span>Bed drops {(gridData.maxDepth * meshPreview.stats.mmPerMetreVertical * depthBoost).toFixed(1)} mm below the waterline; the land is untouched, so the shoreline stays put.</span>
              <button
                type="button"
                onClick={() => setDepthBoost(suggestDepthBoost(gridData))}
                className="shrink-0 ml-2 text-cyan-400 hover:text-cyan-300 underline decoration-dotted cursor-pointer"
                title="Make the lake bed as tall as the surrounding land is high"
              >
                fishing fit (×{suggestDepthBoost(gridData)})
              </button>
            </div>
          </div>

          {/* Lake Bed vs Water Cap Style */}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setIncludeWaterCap(false)}
              className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                !includeWaterCap
                  ? 'bg-sky-950/40 border-sky-500/80 text-white shadow-sm'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
              }`}
            >
              <div className="text-xs font-semibold flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${!includeWaterCap ? 'bg-sky-400' : 'bg-slate-600'}`} />
                Bathymetric Cavity (Recommended)
              </div>
              <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                Hollows out the lake basin down to measured depths and trenches so you can touch the underwater contours.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setIncludeWaterCap(true)}
              className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                includeWaterCap
                  ? 'bg-sky-950/40 border-sky-500/80 text-white shadow-sm'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
              }`}
            >
              <div className="text-xs font-semibold flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${includeWaterCap ? 'bg-sky-400' : 'bg-slate-600'}`} />
                Flat Water Surface
              </div>
              <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                Fills the lake up to water surface elevation as a flat plateau, with land rising above it.
              </p>
            </button>
          </div>

          {/* Stepped Contour Terraces for 3D Printing (Laser-cut / Layer-cake Style) */}
          <div className="p-3 bg-slate-950/50 rounded-xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-200 flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={terraceContours}
                  onChange={(e) => setTerraceContours(e.target.checked)}
                  className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
                />
                <span className="flex items-center gap-1.5 text-amber-300">
                  <Layers className="w-3.5 h-3.5" />
                  Stepped Topo Contour Terraces (Architectural / Laser-cut Style)
                </span>
              </label>
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed pl-6">
              Quantizes elevations into crisp horizontal steps and vertical walls, recreating the iconic physical layered topographic map look.
            </p>
            {terraceContours && (
              <div className="pl-6 pt-1 flex items-center gap-2">
                <span className="text-[11px] text-slate-400 font-medium">Contour Step:</span>
                {[5, 10, 20].map((step) => (
                  <button
                    key={step}
                    type="button"
                    onClick={() => setTerraceStepFt(step)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition-all cursor-pointer ${
                      terraceStepFt === step
                        ? 'bg-amber-500 text-slate-950 font-bold'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    {step} ft
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Multi-material split */}
          <div className="p-3 bg-slate-950/50 rounded-xl border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5 text-sky-400" /> Materials / colours
              </span>
              <span className="text-[10px] text-slate-500">AMS · MMU · multi-part import</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {([
                { id: 'single', label: 'One solid', desc: 'Single STL, one filament.' },
                { id: 'split-stl', label: 'Land + lake STLs', desc: 'Two mating STLs. Import together as one object, give the lake part blue.' },
                { id: '3mf', label: '3MF, 2 parts', desc: 'One object with a land part and a lake part, colours pre-set.' },
              ] as Array<{ id: MaterialMode; label: string; desc: string }>).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMaterialMode(m.id)}
                  className={`p-2.5 rounded-lg border text-left cursor-pointer transition-all ${
                    materialMode === m.id ? 'bg-sky-950/40 border-sky-500/80 text-white' : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-semibold flex items-center gap-1.5">
                    {m.id !== 'single' && <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: WATER_COLOR }} />}
                    {m.id !== 'single' && <span className="inline-block w-2.5 h-2.5 rounded-sm -ml-1" style={{ background: LAND_COLOR }} />}
                    {m.label}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">{m.desc}</p>
                </button>
              ))}
            </div>
            {materialMode !== 'single' && (
              <p className="text-[10px] text-slate-400 leading-relaxed">
                The lake part is every grid cell inside the shoreline, cut vertically from the bed down to the base, so its top face is the bathymetry.
                In Bambu Studio: drag both STLs in together and answer <em>Yes</em> to "load as a single object with multiple parts", then set the lake part's filament.
                The 3MF loads as one object with two parts already; the colours are hints and some slicers ignore them.
              </p>
            )}
          </div>

          {/* Laser-cut layer pack */}
          <div className="p-3 bg-slate-950/50 rounded-xl border border-orange-900/60 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-orange-200 flex items-center gap-1.5">
                <Scissors className="w-3.5 h-3.5 text-orange-400" /> Laser-cut layer pack
              </span>
              <span className="text-[10px] text-slate-500">SVG · DXF · {layerPack.layers.length} sheets</span>
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              Every contour level as closed cut lines, tiled on one page at the print-bed width above. Water sheets are full rectangles with the deeper lake cut out; land sheets are the hills themselves. Registration holes in the margins line the stack up on dowels. Black cuts, blue engraves.
            </p>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-slate-400">Step:</span>
              {[2, 5, 10].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setLaserStepFt(s)}
                  className={`px-2 py-0.5 rounded-lg font-mono cursor-pointer ${laserStepFt === s ? 'bg-orange-500 text-slate-950 font-bold' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  {s} ft
                </button>
              ))}
              <label className="flex items-center gap-1 text-slate-300 cursor-pointer ml-1">
                <input type="checkbox" checked={laserIncludeLand} onChange={(e) => setLaserIncludeLand(e.target.checked)} className="w-3.5 h-3.5 accent-orange-500 cursor-pointer" />
                land sheets
              </label>
              <span className="ml-auto text-slate-400">Material:</span>
              <input
                type="number"
                min={0.5}
                max={25}
                step={0.5}
                value={laserThicknessMm}
                onChange={(e) => setLaserThicknessMm(Math.max(0.5, Number(e.target.value) || 0.5))}
                className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 font-mono text-orange-300 focus:outline-none focus:border-orange-500"
              />
              <span className="text-slate-400">mm</span>
            </div>
            <div className="text-[11px] text-slate-300 font-mono">
              {layerPack.layers.length} sheets × {laserThicknessMm} mm = {(layerPack.layers.length * laserThicknessMm).toFixed(0)} mm tall · true scale is {layerPack.trueThicknessMm.toFixed(2)} mm per sheet, so this stack is {(laserThicknessMm / Math.max(1e-6, layerPack.trueThicknessMm)).toFixed(1)}× exaggerated
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => downloadLayers('svg')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 hover:bg-orange-500 text-white cursor-pointer">
                <Download className="w-3.5 h-3.5" /> SVG page
              </button>
              <button type="button" onClick={() => downloadLayers('dxf')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer">
                <Download className="w-3.5 h-3.5" /> DXF (R12, mm)
              </button>
            </div>
          </div>

          {/* STL Format Selector */}
          <div className="flex items-center justify-between p-3 bg-slate-950/40 rounded-xl border border-slate-800 text-xs">
            <span className="text-slate-300 font-medium flex items-center gap-1.5">
              <FileCode2 className="w-4 h-4 text-purple-400" /> Format:
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFormat('binary')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  format === 'binary' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Binary STL (Standard)
              </button>
              <button
                type="button"
                onClick={() => setFormat('ascii')}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  format === 'ascii' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                ASCII STL (Text)
              </button>
            </div>
          </div>

          {/* Slicer Physical Dimensions Summary */}
          <div className="bg-gradient-to-br from-slate-950 to-slate-900 p-4 rounded-xl border border-slate-800 text-xs space-y-2">
            <div className="flex items-center justify-between text-slate-300">
              <span className="text-slate-400">Dimensions (X × Y × Z):</span>
              <span className="font-mono font-semibold text-white">
                {meshPreview.stats.widthMm} × {meshPreview.stats.lengthMm} × {meshPreview.stats.heightMm} mm
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-300">
              <span className="text-slate-400">Terrain relief / scale:</span>
              <span className="font-mono font-semibold text-white">
                {meshPreview.stats.reliefMm} mm · 1:{trueScale.toLocaleString()} horiz · 1:{Math.round(1000 / meshPreview.stats.mmPerMetreVertical).toLocaleString()} vert
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-300">
              <span className="text-slate-400">Watertight Triangles:</span>
              <span className="font-mono font-semibold text-white">
                {splitPreview
                  ? `${splitPreview.land.stats.triangleCount.toLocaleString()} land + ${splitPreview.water.stats.triangleCount.toLocaleString()} lake`
                  : `${meshPreview.stats.triangleCount.toLocaleString()} facets`}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-300">
              <span className="text-slate-400">Estimated STL File Size:</span>
              <span className="font-mono font-semibold text-white">
                ~{estimatedFileSizeMb} MB
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 pt-1 border-t border-slate-800/80">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>Closed manifold, north = +Y, Z up. Drops straight into Bambu Studio, Cura or PrusaSlicer.</span>
            </div>
          </div>

          {downloadSuccess && (
            <div className="p-3 bg-emerald-950/40 border border-emerald-500/40 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{materialMode === 'split-stl' ? 'Two STL files downloaded (land and lake). Import them together.' : 'File generated and downloaded. Check your downloads folder.'}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/95 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium text-slate-300 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting}
            className="px-5 py-2.5 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors flex items-center gap-2 shadow-lg shadow-sky-500/20 cursor-pointer disabled:opacity-50"
          >
            {isExporting ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
                <span>Compiling Triangles...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>{materialMode === '3mf' ? 'Download .3MF' : materialMode === 'split-stl' ? 'Download 2 STL files' : 'Download .STL File'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
