import React, { useMemo, useState } from 'react';
import { Fish, MapPin, Thermometer, Crosshair, Download, Trash2, LocateFixed, Plus, Layers, Route as RouteIcon, Anchor, Upload } from 'lucide-react';
import { parseSoundings, ParsedSoundings, DepthUnit, Sounding } from '../lib/soundings.js';
import { TerrainGridData } from '../types.js';
import { STRUCTURE_KINDS, STRUCTURE_STYLE, StructureFeature, StructureKind, inDepthBand } from '../lib/structure.js';
import { Waypoint } from '../lib/waypoints.js';
import { buildGpx, buildGpxTracks, downloadText } from '../lib/gpx.js';
import { Route, routeLatLon, formatLength } from '../lib/routes.js';
import type { ThermoclineBand } from './Lake3DViewer.js';
import type { PickMode } from '../lib/overlays.js';

const FT_PER_M = 3.28084;

interface FishingPanelProps {
  gridData: TerrainGridData;
  structure: StructureFeature[];
  hiddenKinds: StructureKind[];
  onToggleKind: (kind: StructureKind) => void;
  showStructure: boolean;
  onToggleStructure: (on: boolean) => void;
  thermocline: ThermoclineBand;
  onThermoclineChange: (band: ThermoclineBand) => void;
  waypoints: Waypoint[];
  onUpdateWaypoints: (next: Waypoint[]) => void;
  onAddWaypointFromFeature: (f: StructureFeature) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFocus: (row: number, col: number) => void;
  pickMode: PickMode;
  onSetPickMode: (mode: PickMode) => void;
  useSurveyContours: boolean;
  onToggleSurveyContours: (on: boolean) => void;
  routeDepthFt: number;
  onRouteDepthChange: (ft: number) => void;
  routes: Route[];
  selectedRouteIds: string[];
  onToggleRoute: (id: string) => void;
  soundings: Sounding[] | null;
  onApplySoundings: (points: Sounding[]) => void;
  onClearSoundings: () => void;
  isLoading: boolean;
}

const PRESETS: Array<{ label: string; min: number; max: number; note: string }> = [
  { label: 'Early summer', min: 12, max: 20, note: 'Stratification just setting up' },
  { label: 'Midsummer', min: 18, max: 28, note: 'Typical natural-lake band in Indiana' },
  { label: 'Late summer', min: 22, max: 32, note: 'Band pushed deep before turnover' },
];

export const FishingPanel: React.FC<FishingPanelProps> = ({
  gridData, structure, hiddenKinds, onToggleKind, showStructure, onToggleStructure,
  thermocline, onThermoclineChange, waypoints, onUpdateWaypoints, onAddWaypointFromFeature,
  selectedId, onSelect, onFocus, pickMode, onSetPickMode, useSurveyContours, onToggleSurveyContours,
  routeDepthFt, onRouteDepthChange, routes, selectedRouteIds, onToggleRoute,
  soundings, onApplySoundings, onClearSoundings, isLoading,
}) => {
  const [section, setSection] = useState<'structure' | 'thermocline' | 'waypoints' | 'routes' | 'soundings'>('structure');
  const [unit, setUnit] = useState<DepthUnit>('ft');
  const [raw, setRaw] = useState<{ text: string; name: string } | null>(null);
  const [parsed, setParsed] = useState<ParsedSoundings | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const parseFile = (text: string, name: string, u: DepthUnit) => {
    const result = parseSoundings(text, name, u);
    setParsed(result);
    setParseError(result.points.length ? null : result.note || 'No usable points found.');
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setRaw({ text, name: file.name });
      parseFile(text, file.name, unit);
    } catch (err: any) {
      setParsed(null);
      setParseError(err?.message || 'Could not read the file.');
    }
  };
  const changeUnit = (u: DepthUnit) => { setUnit(u); if (raw) parseFile(raw.text, raw.name, u); };
  const deepestParsedFt = parsed ? parsed.points.reduce((m, p) => Math.max(m, p.depthM), 0) * FT_PER_M : 0;
  const maxDepthFt = Math.max(5, Math.ceil(gridData.maxDepth * FT_PER_M));
  const hasSurvey = !!gridData.surveyContours?.length;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of structure) c[f.kind] = (c[f.kind] || 0) + 1;
    return c;
  }, [structure]);

  const visible = useMemo(
    () => structure.filter((f) => !hiddenKinds.includes(f.kind)).sort((a, b) => b.score - a.score),
    [structure, hiddenKinds]
  );
  const inBand = useMemo(
    () => (thermocline.enabled ? structure.filter((f) => inDepthBand(f, thermocline.minFt, thermocline.maxFt)) : []),
    [structure, thermocline]
  );

  const bedElevationM = (f: StructureFeature) => {
    const r = Math.round(f.row), c = Math.round(f.col);
    return gridData.elevations[r]?.[c] ?? null;
  };
  const slug = gridData.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const exportGpx = (withStructure: boolean) => {
    const gpx = buildGpx({ lakeName: gridData.metadata.name, waypoints, structure: withStructure ? visible : [], bedElevationM });
    downloadText(`${slug}-${withStructure ? 'waypoints-structure' : 'waypoints'}.gpx`, gpx);
  };
  const exportRoutes = () => {
    const picked = routes.filter((r) => selectedRouteIds.includes(r.id));
    if (!picked.length) return;
    const bedM = gridData.waterElevation - routeDepthFt / FT_PER_M;
    const gpx = buildGpxTracks(gridData.metadata.name, picked.map((r, i) => ({
      name: `${gridData.metadata.name} ${r.depthFt} ft line ${i + 1}`,
      desc: `${r.depthFt} ft contour, ${formatLength(r.lengthM)}${r.closed ? ', closed loop' : ''} (${r.source === 'survey' ? 'IDNR survey line' : 'grid contour'})`,
      points: routeLatLon(gridData, r).map((p) => ({ ...p, elevM: bedM })),
    })));
    downloadText(`${slug}-${routeDepthFt}ft-routes.gpx`, gpx);
  };
  const interval = gridData.metadata.contourIntervalFt || 5;
  const quickDepths = Array.from({ length: 6 }, (_, i) => interval * (i + 1)).filter((d) => d <= maxDepthFt);
  const rename = (id: string, name: string) => onUpdateWaypoints(waypoints.map((w) => (w.id === id ? { ...w, name } : w)));
  const remove = (id: string) => { onUpdateWaypoints(waypoints.filter((w) => w.id !== id)); if (selectedId === id) onSelect(null); };

  const tab = (id: typeof section, label: string, icon: React.ReactNode, badge?: number) => (
    <button
      type="button"
      onClick={() => setSection(id)}
      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition cursor-pointer ${section === id ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/50' : 'text-slate-400 hover:text-slate-200 border border-transparent'}`}
    >
      {icon}<span>{label}</span>
      {badge !== undefined && <span className="ml-0.5 px-1.5 rounded-full bg-slate-800 text-[10px] font-mono text-slate-300">{badge}</span>}
    </button>
  );

  return (
    <div className="bg-slate-900 border border-emerald-900/60 rounded-2xl p-4 shadow-xl space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Fish className="w-4 h-4 text-emerald-400" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">Fishing layer</h3>
        </div>
        <button
          type="button"
          onClick={() => onSetPickMode(pickMode === 'pin' ? 'none' : 'pin')}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold transition cursor-pointer ${pickMode === 'pin' ? 'bg-yellow-400 text-slate-950' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          title="Click the 3D model or the map to drop a waypoint. Shift-click works any time."
        >
          <MapPin className="w-3.5 h-3.5" /> {pickMode === 'pin' ? 'Pin mode on' : 'Drop pin'}
        </button>
      </div>

      <div className="flex gap-1 p-1 bg-slate-950 rounded-xl border border-slate-800">
        {tab('structure', 'Structure', <Crosshair className="w-3.5 h-3.5" />, structure.length)}
        {tab('thermocline', 'Thermocline', <Thermometer className="w-3.5 h-3.5" />, thermocline.enabled ? inBand.length : undefined)}
        {tab('waypoints', 'Waypoints', <MapPin className="w-3.5 h-3.5" />, waypoints.length)}
        {tab('routes', 'Routes', <RouteIcon className="w-3.5 h-3.5" />, selectedRouteIds.length || undefined)}
        {tab('soundings', 'Soundings', <Anchor className="w-3.5 h-3.5" />, soundings ? soundings.length : undefined)}
      </div>

      {section === 'structure' && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between text-[11px]">
            <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input type="checkbox" checked={showStructure} onChange={(e) => onToggleStructure(e.target.checked)} className="w-3.5 h-3.5 accent-emerald-500 cursor-pointer" />
              Show markers on the model and map
            </label>
            {hasSurvey && (
              <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer" title="Drape the DNR survey lines themselves on the 3D bed instead of re-contouring the grid">
                <input type="checkbox" checked={useSurveyContours} onChange={(e) => onToggleSurveyContours(e.target.checked)} className="w-3.5 h-3.5 accent-sky-500 cursor-pointer" />
                <Layers className="w-3 h-3" /> DNR lines
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {STRUCTURE_KINDS.map((k) => {
              const st = STRUCTURE_STYLE[k];
              const hidden = hiddenKinds.includes(k);
              const n = counts[k] || 0;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => onToggleKind(k)}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition cursor-pointer ${hidden ? 'bg-slate-950 text-slate-500 border-slate-800 line-through' : 'bg-slate-800 text-slate-200 border-slate-700'}`}
                  style={hidden ? undefined : { borderColor: st.color }}
                >
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: st.color }} />
                  {st.plural} <span className="font-mono text-slate-400">{n}</span>
                </button>
              );
            })}
          </div>
          {visible.length === 0 ? (
            <p className="text-[11px] text-slate-500">
              {structure.length === 0 ? 'Nothing detected. Flat modelled bowls rarely have structure; try a surveyed lake.' : 'All types hidden.'}
            </p>
          ) : (
            <ul className="space-y-1 max-h-72 overflow-y-auto pr-1">
              {visible.map((f) => {
                const st = STRUCTURE_STYLE[f.kind];
                const selected = f.id === selectedId;
                const band = thermocline.enabled && inDepthBand(f, thermocline.minFt, thermocline.maxFt);
                return (
                  <li
                    key={f.id}
                    className={`rounded-lg border px-2 py-1.5 text-[11px] cursor-pointer transition ${selected ? 'bg-slate-800 border-emerald-500/60' : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'}`}
                    onClick={() => { onSelect(f.id); onFocus(f.row, f.col); }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: st.color }} />
                      <span className="font-semibold text-slate-100">{f.label}</span>
                      <span className="font-mono text-cyan-300">{f.depthFt} ft</span>
                      {band && <span className="px-1 rounded bg-amber-500/20 text-amber-300 text-[9px] font-semibold">in band</span>}
                      <span className="ml-auto flex items-center gap-1">
                        <button type="button" title="Fly to it" onClick={(e) => { e.stopPropagation(); onSelect(f.id); onFocus(f.row, f.col); }} className="p-1 rounded hover:bg-slate-700 text-slate-300 cursor-pointer"><LocateFixed className="w-3 h-3" /></button>
                        <button type="button" title="Save as waypoint" onClick={(e) => { e.stopPropagation(); onAddWaypointFromFeature(f); }} className="p-1 rounded hover:bg-slate-700 text-yellow-300 cursor-pointer"><Plus className="w-3 h-3" /></button>
                      </span>
                    </div>
                    <div className="text-slate-400 leading-snug mt-0.5">{f.detail}</div>
                    <div className="font-mono text-[10px] text-slate-500">{f.lat.toFixed(5)}, {f.lon.toFixed(5)}</div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Detected from the depth grid: slope for breaks, local extremes for holes and humps, shoreline shape for points. Positions are as good as the survey underneath them.
          </p>
        </div>
      )}

      {section === 'thermocline' && (
        <div className="space-y-2.5">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
            <input type="checkbox" checked={thermocline.enabled} onChange={(e) => onThermoclineChange({ ...thermocline, enabled: e.target.checked })} className="w-3.5 h-3.5 accent-amber-500 cursor-pointer" />
            Shade the bottom that sits inside a depth band
          </label>
          <div className="grid grid-cols-3 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onThermoclineChange({ enabled: true, minFt: p.min, maxFt: Math.min(p.max, maxDepthFt) })}
                title={p.note}
                className={`p-2 rounded-lg border text-left cursor-pointer transition ${thermocline.enabled && thermocline.minFt === p.min && thermocline.maxFt === Math.min(p.max, maxDepthFt) ? 'bg-amber-500/20 border-amber-500/70 text-amber-100' : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700'}`}
              >
                <div className="text-[11px] font-semibold">{p.label}</div>
                <div className="text-[10px] font-mono text-slate-400">{p.min}–{p.max} ft</div>
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-slate-300"><span>Top of band</span><span className="font-mono text-amber-300">{thermocline.minFt} ft</span></div>
            <input type="range" min={1} max={maxDepthFt} step={1} value={thermocline.minFt} onChange={(e) => { const v = Number(e.target.value); onThermoclineChange({ ...thermocline, enabled: true, minFt: v, maxFt: Math.max(v + 1, thermocline.maxFt) }); }} className="w-full accent-amber-500 cursor-pointer" />
            <div className="flex justify-between text-[11px] text-slate-300"><span>Bottom of band</span><span className="font-mono text-amber-300">{thermocline.maxFt} ft</span></div>
            <input type="range" min={2} max={maxDepthFt} step={1} value={thermocline.maxFt} onChange={(e) => { const v = Number(e.target.value); onThermoclineChange({ ...thermocline, enabled: true, maxFt: v, minFt: Math.min(v - 1, thermocline.minFt) }); }} className="w-full accent-amber-500 cursor-pointer" />
          </div>
          {thermocline.enabled && (
            <div className="text-[11px] text-slate-300">
              <span className="font-semibold text-amber-300">{inBand.length}</span> structure feature{inBand.length === 1 ? '' : 's'} touch the {thermocline.minFt}–{thermocline.maxFt} ft band
              {inBand.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {inBand.slice(0, 8).map((f) => (
                    <li key={f.id} className="flex items-center gap-1.5 cursor-pointer hover:text-white" onClick={() => { onSelect(f.id); onFocus(f.row, f.col); }}>
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: STRUCTURE_STYLE[f.kind].color }} />
                      {f.label} <span className="font-mono text-cyan-300">{f.depthFt} ft</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Where the thermocline actually sits changes week to week; these presets are starting points, not measurements. Check a temp probe on the water and drag the sliders to match.
          </p>
        </div>
      )}

      {section === 'routes' && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-[11px] text-slate-300">
            <span>Follow the</span>
            <input
              type="number"
              min={1}
              max={maxDepthFt}
              step={1}
              value={routeDepthFt}
              onChange={(e) => onRouteDepthChange(Math.max(1, Math.min(maxDepthFt, Number(e.target.value) || 1)))}
              className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 font-mono text-amber-300 focus:outline-none focus:border-amber-500"
            />
            <span>ft line</span>
            <span className="ml-auto text-[10px] text-slate-500">{routes[0]?.source === 'survey' ? 'DNR survey line' : 'grid contour'}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {quickDepths.map((d) => (
              <button key={d} type="button" onClick={() => onRouteDepthChange(d)} className={`px-2 py-0.5 rounded-full text-[10px] font-mono border cursor-pointer ${routeDepthFt === d ? 'bg-amber-500/20 text-amber-200 border-amber-500/60' : 'bg-slate-800 text-slate-300 border-slate-700 hover:border-slate-600'}`}>{d} ft</button>
            ))}
          </div>
          {routes.length === 0 ? (
            <p className="text-[11px] text-slate-500">No {routeDepthFt} ft contour in this lake. Try a shallower depth.</p>
          ) : (
            <ul className="space-y-1 max-h-60 overflow-y-auto pr-1">
              {routes.slice(0, 12).map((r, i) => {
                const on = selectedRouteIds.includes(r.id);
                return (
                  <li key={r.id} className={`rounded-lg border px-2 py-1.5 text-[11px] flex items-center gap-2 transition ${on ? 'bg-slate-800 border-amber-500/60' : 'bg-slate-950/60 border-slate-800'}`}>
                    <input type="checkbox" checked={on} onChange={() => onToggleRoute(r.id)} className="w-3.5 h-3.5 accent-amber-500 cursor-pointer" />
                    <span className="font-semibold text-slate-100">Loop {i + 1}</span>
                    <span className="font-mono text-amber-300">{formatLength(r.lengthM)}</span>
                    <span className="text-[10px] text-slate-500">{r.closed ? 'closed' : 'open'} · {r.points.length} pts</span>
                    <button type="button" title="Fly to it" onClick={() => onFocus(r.points[0][1], r.points[0][0])} className="ml-auto p-1 rounded hover:bg-slate-700 text-slate-300 cursor-pointer"><LocateFixed className="w-3 h-3" /></button>
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" disabled={!selectedRouteIds.length} onClick={exportRoutes} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-amber-600 hover:bg-amber-500 text-white cursor-pointer disabled:opacity-40">
            <Download className="w-3.5 h-3.5" /> GPX track{selectedRouteIds.length > 1 ? 's' : ''} ({selectedRouteIds.length})
          </button>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Checked loops are drawn in amber on the model and the map. The GPX holds one track per loop; Humminbird, Lowrance and Garmin import tracks as trails you can steer along.
          </p>
        </div>
      )}

      {section === 'soundings' && (
        <div className="space-y-2.5">
          <p className="text-[11px] text-slate-300 leading-snug">
            Bring your own bathymetry. Depth soundings from your sonar unit, a chart app or a notebook rebuild the lake bed, so outside Indiana the modelled bowl becomes what you actually measured.
          </p>
          {soundings && (
            <div className="p-2 rounded-lg bg-emerald-950/40 border border-emerald-700/50 text-[11px] text-emerald-200 flex items-center gap-2">
              <Anchor className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1">
                {gridData.metadata.bathymetrySource === 'user-soundings'
                  ? <>Lake built from <strong>{gridData.metadata.soundingCount ?? soundings.length}</strong> of your {soundings.length.toLocaleString()} soundings.</>
                  : <>{soundings.length.toLocaleString()} soundings loaded, but fewer than 3 fell inside this lake's shoreline, so the bed is unchanged.</>}
              </span>
              <button type="button" onClick={onClearSoundings} disabled={isLoading} className="px-2 py-1 rounded bg-slate-800 hover:bg-rose-900/60 text-slate-200 cursor-pointer disabled:opacity-40">Remove</button>
            </div>
          )}
          <div className="flex items-center gap-2 text-[11px]">
            <label className="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer">
              <Upload className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{raw?.name || 'Choose a CSV, TSV or GPX file'}</span>
              <input type="file" accept=".csv,.txt,.tsv,.gpx" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <span className="text-slate-400">Depths in</span>
            {(['ft', 'm'] as DepthUnit[]).map((u) => (
              <button key={u} type="button" onClick={() => changeUnit(u)} className={`px-2 py-1 rounded font-mono cursor-pointer ${unit === u ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>{u}</button>
            ))}
          </div>
          {parseError && <p className="text-[11px] text-rose-300">{parseError}</p>}
          {parsed && parsed.points.length > 0 && (
            <div className="space-y-1.5 text-[11px] text-slate-300">
              <div>
                <strong className="text-white">{parsed.points.length.toLocaleString()}</strong> points parsed{parsed.skipped ? `, ${parsed.skipped} skipped` : ''} · depths read as {parsed.unitUsed} · deepest <span className="font-mono text-cyan-300">{deepestParsedFt.toFixed(1)} ft</span>
                {parsed.note ? <span className="text-slate-500"> · {parsed.note}</span> : null}
              </div>
              <button type="button" onClick={() => onApplySoundings(parsed.points)} disabled={isLoading} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-semibold bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-40">
                <Anchor className="w-3.5 h-3.5" /> Rebuild {gridData.metadata.name} from these soundings
              </button>
            </div>
          )}
          <p className="text-[10px] text-slate-500 leading-relaxed">
            CSV needs latitude, longitude and depth columns; a header row is optional (lat, lon, depth order without one). GPX waypoints or track points use a &lt;depth&gt; tag, &lt;ele&gt;, or the first number in the name or description. Up to 50,000 points. The shoreline is held at zero depth and everything between soundings is interpolated, so the result is only as good as your coverage.
          </p>
        </div>
      )}

      {section === 'waypoints' && (
        <div className="space-y-2.5">
          {waypoints.length === 0 ? (
            <p className="text-[11px] text-slate-500">No waypoints yet. Turn on <strong className="text-slate-300">Drop pin</strong> or shift-click the model or the map. The + on any structure feature saves it as a waypoint too.</p>
          ) : (
            <ul className="space-y-1 max-h-72 overflow-y-auto pr-1">
              {waypoints.map((w) => (
                <li key={w.id} className={`rounded-lg border px-2 py-1.5 text-[11px] transition ${w.id === selectedId ? 'bg-slate-800 border-yellow-500/60' : 'bg-slate-950/60 border-slate-800'}`}>
                  <div className="flex items-center gap-1.5">
                    <MapPin className="w-3 h-3 text-yellow-300 shrink-0" />
                    <input
                      value={w.name}
                      onChange={(e) => rename(w.id, e.target.value)}
                      onFocus={() => onSelect(w.id)}
                      className="flex-1 min-w-0 bg-transparent border-b border-transparent focus:border-slate-600 focus:outline-none text-slate-100 font-semibold"
                    />
                    <span className="font-mono text-cyan-300 shrink-0">{w.depthFt > 0 ? `${w.depthFt} ft` : 'land'}</span>
                    <button type="button" title="Fly to it" onClick={() => { onSelect(w.id); onFocus(w.row, w.col); }} className="p-1 rounded hover:bg-slate-700 text-slate-300 cursor-pointer"><LocateFixed className="w-3 h-3" /></button>
                    <button type="button" title="Delete" onClick={() => remove(w.id)} className="p-1 rounded hover:bg-rose-900/60 text-rose-300 cursor-pointer"><Trash2 className="w-3 h-3" /></button>
                  </div>
                  <div className="font-mono text-[10px] text-slate-500 pl-4.5">{w.lat.toFixed(5)}, {w.lon.toFixed(5)}{w.kind ? ` · ${STRUCTURE_STYLE[w.kind].name}` : ''}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" disabled={!waypoints.length} onClick={() => exportGpx(false)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-40">
              <Download className="w-3.5 h-3.5" /> GPX (waypoints)
            </button>
            <button type="button" disabled={!waypoints.length && !visible.length} onClick={() => exportGpx(true)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer disabled:opacity-40">
              <Download className="w-3.5 h-3.5" /> GPX + structure
            </button>
            {waypoints.length > 0 && (
              <button type="button" onClick={() => { if (window.confirm(`Delete all ${waypoints.length} waypoints for ${gridData.metadata.name}?`)) onUpdateWaypoints([]); }} className="ml-auto flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] text-rose-300 hover:bg-rose-950/60 cursor-pointer">
                <Trash2 className="w-3.5 h-3.5" /> Clear
              </button>
            )}
          </div>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Saved in this browser per lake. GPX imports into Humminbird, Lowrance, Garmin and Navionics as waypoints; depth goes in the description.
          </p>
        </div>
      )}
    </div>
  );
};
