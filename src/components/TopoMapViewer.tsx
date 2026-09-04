import React, { useState, useRef } from 'react';
import { 
  ZoomIn, 
  ZoomOut, 
  RotateCcw, 
  Download, 
  ExternalLink, 
  Layers, 
  MapPin, 
  ShieldCheck, 
  Compass, 
  FileText, 
  Info,
  Maximize2
} from 'lucide-react';
import { TerrainGridData, TopoFeature, GroundingSource } from '../types.js';

interface TopoMapViewerProps {
  gridData: TerrainGridData;
  onSelectFeature?: (feature: TopoFeature) => void;
}

export const TopoMapViewer: React.FC<TopoMapViewerProps> = ({ gridData, onSelectFeature }) => {
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [selectedFeature, setSelectedFeature] = useState<TopoFeature | null>(null);
  const [showSourcesPanel, setShowSourcesPanel] = useState<boolean>(true);

  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
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
                {metadata.name} Topographic & Hydrographic Survey Map
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-cyan-950 text-cyan-300 border border-cyan-800">
                USGS 7.5' & DNR Quad Standard
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Elevation {metadata.surfaceElevationFt} ft MSL | Max Depth {metadata.maxDepthFt} ft | 5-ft Bathymetric Contours
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
        onMouseLeave={handleMouseUp}
      >
        <div 
          className="transition-transform duration-75 ease-out max-w-full max-h-full flex items-center justify-center p-4"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          {gridData.svgTopoMap ? (
            <div 
              className="w-[680px] h-[680px] shadow-2xl rounded-lg overflow-hidden border border-slate-700/60"
              dangerouslySetInnerHTML={{ __html: gridData.svgTopoMap }}
            />
          ) : (
            <div className="text-slate-400 text-sm">Generating vector topographic survey map...</div>
          )}
        </div>

        {/* Floating Topo Features Quick-Select Pills (Bottom Left) */}
        {features.length > 0 && (
          <div className="absolute bottom-4 left-4 z-20 flex flex-wrap gap-1.5 max-w-md bg-slate-900/90 backdrop-blur p-2.5 rounded-xl border border-slate-800 shadow-xl">
            <span className="text-[10px] font-bold tracking-wide uppercase text-slate-400 w-full mb-1 flex items-center space-x-1">
              <MapPin className="w-3 h-3 text-cyan-400" />
              <span>Surveyed Bathymetric & Topo Landmarks</span>
            </span>
            {features.map((f, i) => (
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
                  <span>Grounding Sources & Hydrographic Data</span>
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
            <strong>Generative Limnological Synthesis:</strong> {metadata.topoAnalysisNotes}
          </span>
        </div>
      )}
    </div>
  );
};
