import React, { useState, useRef } from 'react';
import {
  Sparkles,
  Search,
  Upload,
  Layers,
  RefreshCw,
  ExternalLink,
  Image as ImageIcon,
  ChevronRight,
  Send
} from 'lucide-react';
import { TerrainGridData } from '../types.js';
import { describeMethod } from '../lib/labels.js';

interface GenerativeTopoPanelProps {
  gridData: TerrainGridData;
  isLoading: boolean;
  onTriggerAiRecon: (query: string, userNotes?: string) => void;
  onUploadTopoImage: (imageBase64: string, mimeType: string, lakeName?: string) => void;
}

const SAMPLE_TOPO_CHARTS = [
  {
    name: 'Deam Lake DNR Survey Chart',
    query: 'Deam Lake, Indiana',
    notes: 'Official Indiana DNR 5-ft interval bathymetric survey: 30-ft southern basin hole, winding Stone Branch creek north inlet, northwest arm, boat ramp bay, and Deam Lake Rd earthen dam.',
  },
  {
    name: 'Beals Lake USGS 7.5\' Quad',
    query: 'Beals Lake, Indiana',
    notes: 'USGS topographic quadrangle: glacial kettle depression, 47.6-ft max depth, surrounding hummocky till moraines and submerged weed edges.',
  },
  {
    name: 'Lake Monroe Reservoir Survey',
    query: 'Lake Monroe, Indiana',
    notes: 'Salt Creek impoundment: 54-ft deep cutchell hole, causeway, North Fork and South Fork arms, karst limestone bluffs.',
  },
];

export const GenerativeTopoPanel: React.FC<GenerativeTopoPanelProps> = ({
  gridData,
  isLoading,
  onTriggerAiRecon,
  onUploadTopoImage,
}) => {
  const [activeTab, setActiveTab] = useState<'recon' | 'upload' | 'features'>('recon');
  const [userPrompt, setUserPrompt] = useState<string>('');
  const [isProcessingImage, setIsProcessingImage] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const metadata = gridData.metadata;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingImage(true);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      onUploadTopoImage(base64, file.type, metadata.name);
      setIsProcessingImage(false);
    };
    reader.onerror = () => {
      setIsProcessingImage(false);
    };
    reader.readAsDataURL(file);
  };

  const handleRunRecon = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    onTriggerAiRecon(metadata.name, userPrompt);
  };

  return (
    <div className="bg-slate-900/95 border border-slate-800 rounded-xl p-4 shadow-xl text-slate-200">
      {/* Header with Generation Badge */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">Depth & Survey Enrichment</h3>
            <p className="text-[11px] text-slate-400">
              Gemini recon for max depth, geology and landmarks (optional)
            </p>
          </div>
        </div>

        {/* Method Badge */}
        <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-[11px]">
          <span className={`w-2 h-2 rounded-full ${metadata.generationMethod === 'heuristic' || metadata.generationMethod === 'ai-synthesis' ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
          <span className="font-medium text-slate-300">{describeMethod(metadata.generationMethod)}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 mb-3 text-xs font-medium">
        <button
          onClick={() => setActiveTab('recon')}
          className={`pb-2 px-3 transition border-b-2 flex items-center space-x-1.5 ${
            activeTab === 'recon'
              ? 'border-cyan-400 text-cyan-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Search className="w-3.5 h-3.5" />
          <span>Web Search Recon</span>
        </button>
        <button
          onClick={() => setActiveTab('upload')}
          className={`pb-2 px-3 transition border-b-2 flex items-center space-x-1.5 ${
            activeTab === 'upload'
              ? 'border-cyan-400 text-cyan-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Upload Topo Map Image</span>
        </button>
        <button
          onClick={() => setActiveTab('features')}
          className={`pb-2 px-3 transition border-b-2 flex items-center space-x-1.5 ${
            activeTab === 'features'
              ? 'border-cyan-400 text-cyan-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Extracted Contours</span>
        </button>
      </div>

      {/* Tab 1: AI Web Search Recon */}
      {activeTab === 'recon' && (
        <div className="space-y-3">
          <p className="text-xs text-slate-300 leading-relaxed">
            Shoreline and land elevation already come from real map data. AI recon asks Gemini (with Google Search when available) for the
            lake's surveyed max depth, mean depth, geology and named landmarks, then rescales the bathymetry to that depth. Results without
            search grounding are flagged as unverified.
          </p>

          <form onSubmit={handleRunRecon} className="space-y-2">
            <div className="relative">
              <input
                type="text"
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
                placeholder="Optional notes, e.g. 'Deepen south hole to 30ft', 'Add Knobstone bluffs'..."
                className="w-full pl-3 pr-9 py-2 bg-slate-800/80 border border-slate-700 focus:border-cyan-400 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none transition"
              />
              <button
                type="submit"
                disabled={isLoading}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-cyan-400 hover:text-cyan-300 disabled:opacity-40"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => handleRunRecon()}
              disabled={isLoading}
              className="w-full flex items-center justify-center space-x-2 py-2 px-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-50 text-white font-medium text-xs rounded-lg shadow-md transition cursor-pointer"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Searching USGS & DNR Topo Records...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Run AI depth & survey recon</span>
                </>
              )}
            </button>
          </form>

          {/* Survey Grounding Sources */}
          {metadata.sources && metadata.sources.length > 0 && (
            <div className="pt-2 border-t border-slate-800/80">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1.5">
                Data sources ({metadata.sources.length})
              </span>
              <div className="space-y-1">
                {metadata.sources.map((src, i) => (
                  <div key={i} className="flex items-center justify-between text-xs p-1.5 rounded bg-slate-800/60 border border-slate-700/60">
                    <span className="truncate text-slate-300">{src.title}</span>
                    {src.uri && (
                      <a
                        href={src.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-cyan-400 hover:text-cyan-300 ml-2"
                        title="View Source"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Upload Topo Map */}
      {activeTab === 'upload' && (
        <div className="space-y-3">
          <p className="text-xs text-slate-300">
            Upload a DNR bathymetric chart or USGS quad image. Gemini Vision reads the depth markings and metadata; the shoreline still comes
            from OpenStreetMap when the lake name can be matched. Requires a server-side GEMINI_API_KEY.
          </p>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/png,image/jpeg,image/webp,image/jpg"
            className="hidden"
          />

          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-slate-700 hover:border-cyan-500/80 bg-slate-800/40 hover:bg-slate-800/70 rounded-xl p-5 text-center cursor-pointer transition flex flex-col items-center justify-center space-y-2"
          >
            <div className="p-2.5 rounded-full bg-cyan-500/10 text-cyan-400">
              <ImageIcon className="w-5 h-5" />
            </div>
            <div>
              <span className="text-xs font-semibold text-white block">Click to Upload Topo Map / Depth Chart</span>
              <span className="text-[11px] text-slate-400">Supports PNG, JPG, or WebP charts up to 10MB</span>
            </div>
          </div>

          {/* Preset Sample Topo Charts */}
          <div>
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1.5">
              Or run recon with survey notes for a curated lake:
            </span>
            <div className="space-y-1.5">
              {SAMPLE_TOPO_CHARTS.map((sample, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onTriggerAiRecon(sample.query, sample.notes)}
                  className="w-full text-left p-2 rounded-lg bg-slate-800/60 hover:bg-slate-800 border border-slate-700 text-xs transition flex items-center justify-between group"
                >
                  <div>
                    <span className="font-medium text-slate-200 group-hover:text-cyan-400 block">
                      {sample.name}
                    </span>
                    <span className="text-[10px] text-slate-400 line-clamp-1">
                      {sample.notes}
                    </span>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-500 group-hover:text-cyan-400 shrink-0 ml-2" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Extracted Contours & Features */}
      {activeTab === 'features' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-2 rounded-lg bg-slate-800/70 border border-slate-700">
              <span className="text-[10px] text-slate-400 block">Surface Elevation</span>
              <span className="font-bold text-slate-200">{metadata.surfaceElevationFt} ft MSL</span>
            </div>
            <div className="p-2 rounded-lg bg-slate-800/70 border border-slate-700">
              <span className="text-[10px] text-slate-400 block">Max Basin Sounding</span>
              <span className="font-bold text-cyan-400">{metadata.maxDepthFt} ft depth</span>
            </div>
            <div className="p-2 rounded-lg bg-slate-800/70 border border-slate-700">
              <span className="text-[10px] text-slate-400 block">Contour Step</span>
              <span className="font-bold text-slate-200">{metadata.contourIntervalFt || 5} ft intervals</span>
            </div>
            <div className="p-2 rounded-lg bg-slate-800/70 border border-slate-700">
              <span className="text-[10px] text-slate-400 block">Surface Area</span>
              <span className="font-bold text-slate-200">{metadata.areaAcres} acres</span>
            </div>
          </div>

          {metadata.topoFeatures && metadata.topoFeatures.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                Landmarks ({metadata.topoFeatures.length})
              </span>
              <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
                {metadata.topoFeatures.map((feat, i) => (
                  <div key={i} className="p-1.5 rounded bg-slate-800/50 border border-slate-700/60 text-xs flex items-center justify-between">
                    <div>
                      <span className="font-medium text-slate-200 block">{feat.label}</span>
                      {feat.description && (
                        <span className="text-[10px] text-slate-400 block">{feat.description}</span>
                      )}
                    </div>
                    {feat.depthOrElevFt !== undefined && (
                      <span className="text-[11px] font-mono font-bold text-cyan-400 shrink-0 ml-2">
                        {feat.depthOrElevFt} ft
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
