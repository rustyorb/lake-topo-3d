import React, { useMemo, useRef, useState } from 'react';
import { Ruler, ArrowLeftRight, X, Download } from 'lucide-react';
import { TerrainGridData } from '../types.js';
import { sampleSection, featuresNearLine, GridPoint } from '../lib/section.js';
import { StructureFeature, STRUCTURE_STYLE } from '../lib/structure.js';
import { downloadBlob } from '../utils/stlExporter.js';
import type { ThermoclineBand } from './Lake3DViewer.js';

const FT_PER_M = 3.28084;
// Chart geometry in SVG units; everything is drawn with attributes (no CSS) so the PNG export matches.
const W = 860, H = 240, ML = 50, MR = 14, MT = 16, MB = 30;

interface SectionChartProps {
  data: TerrainGridData;
  a: GridPoint;
  b: GridPoint;
  structure: StructureFeature[];
  thermocline?: ThermoclineBand;
  onSwap: () => void;
  onClear: () => void;
}

/** A "nice" tick step (1, 2, 5 × 10^k) giving roughly `target` ticks over `range`. */
function niceStep(range: number, target = 6): number {
  const raw = Math.max(1e-9, range / target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

export const SectionChart: React.FC<SectionChartProps> = ({ data, a, b, structure, thermocline, onSwap, onClear }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const profile = useMemo(() => sampleSection(data, a, b), [data, a, b]);
  const near = useMemo(() => featuresNearLine(data, structure, a, b), [data, structure, a, b]);
  const { samples, lengthM } = profile;
  const lengthFt = lengthM * FT_PER_M;
  const useMiles = lengthFt > 5280;

  const top = Math.max(5, profile.maxRelFt) * 1.15 + 2;
  const bottom = Math.min(-5, profile.minRelFt) * 1.15 - 2;
  const x = (dM: number) => ML + (dM / Math.max(1e-6, lengthM)) * (W - ML - MR);
  const y = (relFt: number) => MT + ((top - relFt) / (top - bottom)) * (H - MT - MB);
  const y0 = y(0);
  const f1 = (v: number) => v.toFixed(1);

  const bedPath = samples.map((s, i) => `${i ? 'L' : 'M'}${f1(x(s.distanceM))},${f1(y(s.relFt))}`).join(' ');
  // Runs of water / land samples, each filled between the water line and the bed or bank.
  const runs = useMemo(() => {
    const out: Array<{ water: boolean; from: number; to: number }> = [];
    samples.forEach((s, i) => {
      const cur = out[out.length - 1];
      if (!cur || cur.water !== s.isWater) out.push({ water: s.isWater, from: i, to: i });
      else cur.to = i;
    });
    return out;
  }, [samples]);
  const runPolygon = (r: { from: number; to: number }) => {
    const pts: string[] = [`${f1(x(samples[r.from].distanceM))},${f1(y0)}`];
    for (let i = r.from; i <= r.to; i++) pts.push(`${f1(x(samples[i].distanceM))},${f1(y(samples[i].relFt))}`);
    pts.push(`${f1(x(samples[r.to].distanceM))},${f1(y0)}`);
    return pts.join(' ');
  };

  const yStep = niceStep(top - bottom, 6);
  const yTicks: number[] = [];
  for (let v = Math.ceil(bottom / yStep) * yStep; v <= top; v += yStep) yTicks.push(Math.round(v * 1e6) / 1e6);
  const xUnit = useMiles ? 5280 / FT_PER_M : 1 / FT_PER_M; // metres per axis unit
  const xStep = niceStep(lengthM / xUnit, 6);
  const xTicks: number[] = [];
  for (let v = 0; v <= lengthM / xUnit + 1e-9; v += xStep) xTicks.push(Math.round(v * 1e6) / 1e6);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const t = Math.max(0, Math.min(1, (sx - ML) / (W - ML - MR)));
    setHover(Math.round(t * (samples.length - 1)));
  };
  const hov = hover !== null ? samples[hover] : null;

  const slug = data.metadata.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const exportPng = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = W * scale;
      canvas.height = H * scale;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, W, H);
        canvas.toBlob((png) => { if (png) downloadBlob(png, `${slug}-cross-section.png`); }, 'image/png');
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const fmtDist = (m: number) => (useMiles ? `${(m * FT_PER_M / 5280).toFixed(2)} mi` : `${Math.round(m * FT_PER_M).toLocaleString()} ft`);

  return (
    <div className="bg-slate-900 border border-slate-800/90 rounded-2xl p-3 shadow-xl space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Ruler className="w-4 h-4 text-slate-200" />
        <span className="font-bold uppercase tracking-wider text-slate-200">Cross-section</span>
        <span className="font-mono text-slate-400">A → B · {fmtDist(lengthM)} · deepest {Math.round(-Math.min(0, profile.minRelFt))} ft</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={onSwap} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 cursor-pointer" title="Swap A and B"><ArrowLeftRight className="w-3.5 h-3.5" /> Swap</button>
          <button type="button" onClick={exportPng} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1 cursor-pointer" title="Download as PNG"><Download className="w-3.5 h-3.5" /> PNG</button>
          <button type="button" onClick={onClear} className="px-2 py-1 rounded bg-slate-800 hover:bg-rose-900/60 text-slate-300 flex items-center gap-1 cursor-pointer" title="Remove the section"><X className="w-3.5 h-3.5" /></button>
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="w-full h-auto block rounded-lg"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <rect x={0} y={0} width={W} height={H} fill="#0b1220" />
        {/* thermocline band */}
        {thermocline?.enabled && (
          <g>
            <rect x={ML} y={y(-thermocline.minFt)} width={W - ML - MR} height={Math.max(0, y(-thermocline.maxFt) - y(-thermocline.minFt))} fill="#f59e0b" fillOpacity={0.16} />
            <line x1={ML} x2={W - MR} y1={y(-thermocline.minFt)} y2={y(-thermocline.minFt)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" />
            <line x1={ML} x2={W - MR} y1={y(-thermocline.maxFt)} y2={y(-thermocline.maxFt)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" />
          </g>
        )}
        {/* water and land fills */}
        {runs.map((r, i) => (
          <polygon key={i} points={runPolygon(r)} fill={r.water ? '#0ea5e9' : '#a3894f'} fillOpacity={r.water ? 0.45 : 0.55} />
        ))}
        {/* grid + axes */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={ML} x2={W - MR} y1={y(v)} y2={y(v)} stroke="#334155" strokeWidth={0.6} strokeDasharray={v === 0 ? undefined : '2 3'} />
            <text x={ML - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="#94a3b8">{v === 0 ? 'water' : `${v > 0 ? '+' : ''}${v} ft`}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <g key={`x${v}`}>
            <line x1={x(v * xUnit)} x2={x(v * xUnit)} y1={MT} y2={H - MB} stroke="#1e293b" strokeWidth={0.6} />
            <text x={x(v * xUnit)} y={H - MB + 14} textAnchor="middle" fontSize={10} fill="#94a3b8">{useMiles ? `${v} mi` : `${v.toLocaleString()} ft`}</text>
          </g>
        ))}
        <line x1={ML} x2={W - MR} y1={y0} y2={y0} stroke="#7dd3fc" strokeWidth={1.2} />
        <path d={bedPath} fill="none" stroke="#f8fafc" strokeWidth={1.6} strokeLinejoin="round" />
        {/* structure near the line */}
        {near.map(({ feature: f, distanceM }, i) => (
          <g key={f.id}>
            <circle cx={x(distanceM)} cy={y(-f.depthFt)} r={4.5} fill={STRUCTURE_STYLE[f.kind].color} stroke="#0b1220" strokeWidth={1.2} />
            {/* alternate labels above and below the dot so neighbours don't collide */}
            <text x={x(distanceM)} y={y(-f.depthFt) + (i % 2 ? 16 : -8)} textAnchor="middle" fontSize={10} fill={STRUCTURE_STYLE[f.kind].color}>{f.label} {f.depthFt} ft</text>
          </g>
        ))}
        {/* end labels */}
        <text x={ML + 4} y={MT + 11} fontSize={11} fontWeight="bold" fill="#f8fafc">A</text>
        <text x={W - MR - 4} y={MT + 11} textAnchor="end" fontSize={11} fontWeight="bold" fill="#f8fafc">B</text>
        {/* hover guide */}
        {hov && (
          <g>
            <line x1={x(hov.distanceM)} x2={x(hov.distanceM)} y1={MT} y2={H - MB} stroke="#fbbf24" strokeWidth={1} />
            <circle cx={x(hov.distanceM)} cy={y(hov.relFt)} r={3.5} fill="#fbbf24" />
            <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10.5} fill="#fde68a">
              {fmtDist(hov.distanceM)} from A · {hov.isWater ? `${(-hov.relFt).toFixed(1)} ft deep` : `${hov.relFt.toFixed(1)} ft above water`} · {hov.lat.toFixed(5)}, {hov.lon.toFixed(5)}
            </text>
          </g>
        )}
      </svg>
      <p className="text-[10px] text-slate-500 leading-relaxed">
        Bottom profile between the two picked points, sampled from the same grid as the model. Blue is water, tan is bank, dots are structure within a couple of cells of the line.
      </p>
    </div>
  );
};
