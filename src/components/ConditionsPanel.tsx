import React from 'react';
import { Sun, Wind, Clock } from 'lucide-react';
import { SunPosition, compassName, localIsoDate } from '../lib/sun.js';

export interface SunSettings {
  enabled: boolean;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
}

export interface WindSettings {
  enabled: boolean;
  /** Compass direction the wind blows from, degrees clockwise from north. */
  fromDeg: number;
}

interface ConditionsPanelProps {
  sun: SunSettings;
  onSunChange: (s: SunSettings) => void;
  sunPos: SunPosition | null;
  wind: WindSettings;
  onWindChange: (w: WindSettings) => void;
  /** Number of windblown shore stretches currently highlighted. */
  windblownRuns: number;
}

const COMPASS = [0, 45, 90, 135, 180, 225, 270, 315];

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
}

export const ConditionsPanel: React.FC<ConditionsPanelProps> = ({ sun, onSunChange, sunPos, wind, onWindChange, windblownRuns }) => {
  const setNow = () => {
    const d = new Date();
    onSunChange({ enabled: true, date: localIsoDate(d), minutes: d.getHours() * 60 + d.getMinutes() });
  };
  const up = !!sunPos && sunPos.elevationDeg > 0;

  return (
    <div className="bg-slate-900 border border-amber-900/50 rounded-2xl p-4 shadow-xl space-y-3">
      <div className="flex items-center gap-2">
        <Sun className="w-4 h-4 text-amber-400" />
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">Sun & wind</h3>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
          <input type="checkbox" checked={sun.enabled} onChange={(e) => onSunChange({ ...sun, enabled: e.target.checked })} className="w-3.5 h-3.5 accent-amber-500 cursor-pointer" />
          Light the model from the sun's real position
        </label>
        <div className={`space-y-1.5 ${sun.enabled ? '' : 'opacity-50'}`}>
          <div className="flex items-center gap-2 text-[11px]">
            <input
              type="date"
              value={sun.date}
              onChange={(e) => onSunChange({ ...sun, enabled: true, date: e.target.value || sun.date })}
              className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 font-mono focus:outline-none focus:border-amber-500"
            />
            <span className="font-mono text-amber-300">{hhmm(sun.minutes)}</span>
            <button type="button" onClick={setNow} className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] cursor-pointer" title="This moment, in this device's time zone">
              <Clock className="w-3 h-3" /> Now
            </button>
          </div>
          <input type="range" min={0} max={1425} step={15} value={sun.minutes} onChange={(e) => onSunChange({ ...sun, enabled: true, minutes: Number(e.target.value) })} className="w-full accent-amber-500 cursor-pointer" />
          <div className="text-[11px] text-slate-300 font-mono">
            {sunPos
              ? up
                ? <>Sun {compassName(sunPos.azimuthDeg)} at {Math.round(sunPos.azimuthDeg)}°, {Math.round(sunPos.elevationDeg)}° above the horizon</>
                : <span className="text-slate-400">Sun below the horizon at this time</span>
              : <span className="text-slate-500">Turn on to see shaded banks</span>}
          </div>
        </div>
        <p className="text-[10px] text-slate-500 leading-relaxed">
          Shadows are cast on the exaggerated terrain with a corrected sun angle, so their length on the ground is true to life. Times use this device's time zone.
        </p>
      </div>

      <div className="space-y-2 pt-2 border-t border-slate-800/80">
        <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
          <input type="checkbox" checked={wind.enabled} onChange={(e) => onWindChange({ ...wind, enabled: e.target.checked })} className="w-3.5 h-3.5 accent-orange-500 cursor-pointer" />
          <Wind className="w-3.5 h-3.5 text-orange-400" /> Highlight windblown shore
        </label>
        <div className={`space-y-1.5 ${wind.enabled ? '' : 'opacity-50'}`}>
          <div className="flex justify-between text-[11px] text-slate-300">
            <span>Wind from</span>
            <span className="font-mono text-orange-300">{compassName(wind.fromDeg)} · {Math.round(wind.fromDeg)}°</span>
          </div>
          <input type="range" min={0} max={359} step={1} value={wind.fromDeg} onChange={(e) => onWindChange({ enabled: true, fromDeg: Number(e.target.value) })} className="w-full accent-orange-500 cursor-pointer" />
          <div className="grid grid-cols-8 gap-1">
            {COMPASS.map((d) => (
              <button key={d} type="button" onClick={() => onWindChange({ enabled: true, fromDeg: d })} className={`py-0.5 rounded text-[10px] font-mono cursor-pointer ${wind.enabled && wind.fromDeg === d ? 'bg-orange-500 text-slate-950 font-bold' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>{compassName(d)}</button>
            ))}
          </div>
          {wind.enabled && (
            <div className="text-[11px] text-slate-300">
              <span className="font-semibold text-orange-300">{windblownRuns}</span> stretch{windblownRuns === 1 ? '' : 'es'} of bank face the wind (orange on the model and the map)
            </div>
          )}
        </div>
        <p className="text-[10px] text-slate-500 leading-relaxed">
          Wind pushes warm surface water, plankton and baitfish onto the banks that face it. The arrow on the model shows the direction it blows.
        </p>
      </div>
    </div>
  );
};
