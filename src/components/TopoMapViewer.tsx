import React, { useState, useRef, useMemo } from 'react';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Download,
  ExternalLink,
  MapPin,
  ShieldCheck,
  Compass,
  Info
} from 'lucide-react';
import { TerrainGridData, TopoFeature } from '../types.js';
import { describeGeometry } from '../lib/labels.js';
import { gridToLatLon } from '../lib/structure.js';
import { svgMapFrame, gridToSvg, svgToGrid, SVG_MAP_SIZE } from '../lib/mapFrame.js';
import type { OverlayLine, PickMode } from '../lib/overlays.js';

/** Marker overlaid on the 2D map (structure feature or waypoint). */
export interface MapMarker {
  id: string;
  row: number;
  col: number;
  color: string;
  label: string;
  detail?: string;
  shape: 'dot' | 'pin';
}

interface TopoMapViewerProps {
  gridData: TerrainGridData;
  onSelectFeature?: (feature: TopoFeature) => void;
  markers?: MapMarker[];
  selectedMarkerId?: string | null;
  pickMode?: PickMode;
  overlays?: OverlayLine[];
  onPick?: (cell: { row: number; col: number }, mode: Exclude<PickMode, 'none'>) => void;
  onSelectMarker?: (id: string) => void;
}

const FT_PER_M = 3.28084;

export const TopoMapViewer: React.FC<TopoMapViewerProps> = ({ gridData, onSelectFeature, markers = [], selectedMarkerId = null, pickMode = 'none' as PickMode, overlays = [] as OverlayLine[], onPick, onSelectMarker }) => {
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedFeature, setSelectedFeature] = useState<TopoFeature | null>(null);
  const [showSourcesPanel, setShowSourcesPanel] = useState<boolean>(false);
  const [cursor, setCursor] = useState<{ depthFt: number; elevFt: number; isWater: boolean; lat: number; lon: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);

  const frame = useMemo(() => svgMapFrame(gridData.physicalWidthKm, gridData.physicalHeightKm), [gridData.physicalWidthKm, gridData.physicalHeightKm]);

  /** Mouse event → fractional grid cell, using the rendered sheet's rect (which includes zoom/pan). */
  const cellUnderMouse = (e: React.MouseEvent): { row: number; col: number } | null => {
    const sheet = sheetRef.current;
    if (!sheet) return null;
    const rect = sheet.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const sx = ((e.clientX - rect.left) / rect.width) * SVG_MAP_SIZE;
    const sy = ((e.clientY - rect.top) / rect.height) * SVG_MAP_SIZE;
    return svgToGrid(frame, gridData.gridSize, sx, sy);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    downRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const cell = cellUnderMouse(e);
    if (cell) {
      const r = Math.round(cell.row), c = Math.round(cell.col);
      const { lat, lon } = gridToLatLon(gridData, cell.row, cell.col);
      setCursor({
        depthFt: Math.round(gridData.depths[r][c] * FT_PER_M * 10) / 10,
        elevFt: Math.round(gridData.elevations[r][c] * FT_PER_M),
        isWater: gridData.waterMask[r][c],
        lat, lon,
      });
    } else setCursor(null);
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    setIsDragging(false);
    const down = downRef.current;
    downRef.current = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a drag, not a click
    let mode: PickMode = pickMode;
    if (e.shiftKey) mode = 'pin';
    if (mode === 'none') return;
    const cell = cellUnderMouse(e);
    if (cell) onPick?.(cell, mode);
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
    setCursor(null);
  };

  const handleReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSelectedFeature(null);
  };

  const handleDownloadSvg = () => {
    if (!gridData.svgTopoMap) return;
    const blob = new Blob([gridData.svgTopoMap], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${gridData.metadata.id}-topo-survey-map.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const metadata = gridData.metadata;
  const sources = metadata.sources || [];
  const features = metadata.topoFeatures || [];

  return (
    <div className="relative w-full h-full flex flex-col bg-slate-950 overflow-hidden select-none border border-slate-800/80 rounded-xl shadow-2xl">
      {/* Top Header Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900/90 backdrop-blur border-b border-slate-800 z-10">
        <div className="flex items-center space-x-3">
          <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Compass className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-sm font-semibold text-slate-200">
                {metadata.name} — topographic & bathymetric map
              </span>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${metadata.geometrySource === 'osm-dem' ? 'bg-emerald-950 text-emerald-300 border-emerald-800' : 'bg-amber-950 text-amber-300 border-amber-800'}`}>
                {describeGeometry(metadata.geometrySource)}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Pool {metadata.surfaceElevationFt} ft MSL | Max depth {metadata.maxDepthFt} ft{metadata.depthIsEstimated ? ' (est.)' : ''} | {metadata.contourIntervalFt || 5}-ft depth contours{metadata.bathymetrySource === 'idnr-sonar' ? ` | IDNR sonar survey${metadata.surveyDate ? ' ' + metadata.surveyDate : ''}` : ''}
            </p>
          </div>
        </div>

        {/* Map Controls */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setZoom((z) => Math.min(3.0, z + 0.25))}
            className="p-1.5 text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 rounded-lg transition"
            title="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(0.6, z - 0.25))}
            className="p-1.5 text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 rounded-lg transition"
            title="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={handleReset}
            className="p-1.5 text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 rounded-lg transition"
            title="Reset View"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            onClick={handleDownloadSvg}
            className="flex items-center space-x-1.5 px-2.5 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-950/60 hover:bg-cyan-900 border border-cyan-800/80 rounded-lg transition shadow-sm"
            title="Download Vector SVG Map"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export SVG</span>
          </button>
        </div>
      </div>

      {/* Main Map Stage */}
      <div 
        ref={containerRef}
        className="relative flex-1 w-full h-full cursor-grab active:cursor-grabbing overflow-hidden flex items-center justify-center"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        style={pickMode !== 'none' ? { cursor: 'crosshair' } : undefined}
      >
        <div 
          className="transition-transform duration-75 ease-out max-w-full max-h-full flex items-center justify-center p-4"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          {gridData.svgTopoMap ? (
            <div ref={sheetRef} className="relative w-[680px] h-[680px] shadow-2xl rounded-lg overflow-hidden border border-slate-700/60 bg-[#f7f3ea]">
              <div className="w-full h-full" dangerouslySetInnerHTML={{ __html: gridData.svgTopoMap }} />
              {/* Overlay lines in SVG page space; stroke widths counter-scaled so they stay constant at any zoom */}
              {overlays.length > 0 && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${SVG_MAP_SIZE} ${SVG_MAP_SIZE}`}>
                  {overlays.map((o) => {
                    const pts = o.points.map(([c, r]) => gridToSvg(frame, gridData.gridSize, c, r));
                    const d = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
                    return (
                      <g key={o.id}>
                        <polyline points={d} fill="none" stroke="#0f172a" strokeWidth={3.2 / zoom} strokeOpacity={0.55} strokeLinejoin="round" strokeLinecap="round" />
                        <polyline points={d} fill="none" stroke={o.color} strokeWidth={1.8 / zoom} strokeDasharray={o.dashed ? `${6 / zoom} ${4 / zoom}` : undefined} strokeLinejoin="round" strokeLinecap="round" />
                        {o.endpoints && [pts[0], pts[pts.length - 1]].map((p, i) => (
                          <circle key={i} cx={p.x} cy={p.y} r={4 / zoom} fill={o.color} stroke="#0f172a" strokeWidth={1 / zoom} />
                        ))}
                      </g>
                    );
                  })}
                </svg>
              )}
              {/* Overlay markers positioned in SVG page space; counter-scaled so they stay the same size at any zoom */}
              {markers.map((m) => {
                const p = gridToSvg(frame, gridData.gridSize, m.col, m.row);
                const selected = m.id === selectedMarkerId;
                return (
                  <button
                    key={m.id}
                    type="button"
                    title={m.detail ? `${m.label} — ${m.detail}` : m.label}
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseUp={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onSelectMarker?.(m.id); }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer"
                    style={{ left: `${(p.x / SVG_MAP_SIZE) * 100}%`, top: `${(p.y / SVG_MAP_SIZE) * 100}%`, transform: `translate(-50%, ${m.shape === 'pin' ? '-100%' : '-50%'}) scale(${1 / zoom})`, transformOrigin: m.shape === 'pin' ? '50% 100%' : '50% 50%' }}
                  >
                    {m.shape === 'pin' ? (
                      <span className="block" style={{ width: 14, height: 20 }}>
                        <svg viewBox="0 0 14 20" width="14" height="20"><path d="M7 0C3.1 0 0 3.1 0 7c0 5 7 13 7 13s7-8 7-13c0-3.9-3.1-7-7-7z" fill={m.color} stroke="#1e293b" strokeWidth="1.2"/><circle cx="7" cy="7" r="2.6" fill="#fff"/></svg>
                      </span>
                    ) : (
                      <span className="block rounded-full border-2 border-slate-900 shadow" style={{ width: selected ? 14 : 10, height: selected ? 14 : 10, background: m.color, boxShadow: selected ? `0 0 0 3px ${m.color}66` : undefined }} />
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-slate-400 text-sm">Generating vector topographic survey map...</div>
          )}
        </div>

        {/* Cursor readout */}
        {cursor && (
          <div className="absolute top-3 right-3 z-20 bg-slate-900/95 backdrop-blur border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono shadow-xl pointer-events-none">
            <span className={cursor.isWater ? 'text-cyan-300' : 'text-emerald-300'}>{cursor.isWater ? `${cursor.depthFt} ft deep` : `${cursor.elevFt} ft elev`}</span>
            <span className="text-slate-500"> · </span>
            <span className="text-slate-300">{cursor.lat.toFixed(5)}, {cursor.lon.toFixed(5)}</span>
            {pickMode === 'pin' && <span className="text-yellow-300"> · click to pin</span>}
            {pickMode === 'section' && <span className="text-white"> · click to set the section</span>}
          </div>
        )}

        {/* Floating Topo Features Quick-Select Pills (Bottom Left) */}
        {features.length > 0 && (
          <div className="absolute bottom-4 left-4 z-20 flex flex-wrap gap-1.5 max-w-md bg-slate-900/90 backdrop-blur p-2.5 rounded-xl border border-slate-800 shadow-xl">
            <span className="text-[10px] font-bold tracking-wide uppercase text-slate-400 w-full mb-1 flex items-center space-x-1">
              <MapPin className="w-3 h-3 text-cyan-400" />
              <span>Landmarks</span>
            </span>
            {features.filter((f) => Number.isFinite(f.normX)).map((f, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedFeature(f);
                  onSelectFeature?.(f);
                }}
                className={`text-[11px] px-2 py-1 rounded-md border font-medium transition flex items-center space-x-1 ${
                  selectedFeature?.label === f.label
                    ? 'bg-cyan-600 text-white border-cyan-400'
                    : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-700'
                }`}
              >
                <span>{f.label}</span>
                {f.depthOrElevFt !== undefined && (
                  <span className="text-[9px] opacity-75 font-mono">
                    {f.type === 'deep_hole' ? `(${f.depthOrElevFt}ft)` : `(${f.depthOrElevFt}')`}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Selected Feature Detail Card */}
        {selectedFeature && (
          <div className="absolute top-4 left-4 z-20 max-w-xs bg-slate-900/95 backdrop-blur-md p-3 rounded-xl border border-cyan-500/50 shadow-2xl text-slate-200 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-1.5">
              <span className="font-semibold text-xs text-cyan-300">{selectedFeature.label}</span>
              <button 
                onClick={() => setSelectedFeature(null)}
                className="text-slate-400 hover:text-white text-xs px-1"
              >
                ✕
              </button>
            </div>
            <p className="text-[11px] text-slate-300 mb-1">{selectedFeature.description || 'Survey station mark.'}</p>
            {selectedFeature.depthOrElevFt !== undefined && (
              <div className="text-[10px] text-cyan-400 font-mono">
                {selectedFeature.type === 'deep_hole' ? 'Underwater Depth: ' : 'Elevation: '}
                <strong className="text-white">{selectedFeature.depthOrElevFt} ft</strong>
              </div>
            )}
          </div>
        )}

        {/* Verified Web Search Citations & Grounding Box (Bottom Right) */}
        {sources.length > 0 && (
          <div className="absolute bottom-4 right-4 z-20 max-w-sm">
            <div className="bg-slate-900/95 backdrop-blur-md rounded-xl border border-slate-800 p-3 shadow-xl text-xs">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-1.5 text-emerald-400 font-semibold text-[11px]">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Data sources</span>
                </div>
                <button
                  onClick={() => setShowSourcesPanel(!showSourcesPanel)}
                  className="text-[10px] text-slate-400 hover:text-slate-200"
                >
                  {showSourcesPanel ? 'Hide' : 'Show'}
                </button>
              </div>

              {showSourcesPanel && (
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {sources.map((src, idx) => (
                    <div key={idx} className="p-1.5 rounded-lg bg-slate-800/60 border border-slate-700/60 text-[11px]">
                      <div className="flex items-start justify-between">
                        <span className="font-medium text-slate-200">{src.title}</span>
                        {src.uri && (
                          <a
                            href={src.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-cyan-400 hover:text-cyan-300 ml-1.5 p-0.5"
                            title="Open Survey Source"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      {src.snippet && (
                        <p className="text-[10px] text-slate-400 mt-0.5 line-clamp-2 leading-relaxed">
                          {src.snippet}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer Topo Notes Banner */}
      {metadata.topoAnalysisNotes && (
        <div className="px-4 py-2 bg-slate-900/90 border-t border-slate-800/80 text-[11px] text-slate-400 flex items-center space-x-2">
          <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="truncate">
            <strong>Notes:</strong> {metadata.topoAnalysisNotes}
          </span>
        </div>
      )}
    </div>
  );
};
