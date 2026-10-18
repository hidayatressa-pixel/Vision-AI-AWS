/**
 * Factory-Floor Large Industrial Status Banner
 * High contrast, visible from 5+ meters on a stand-mounted phone.
 */

import React from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Clock, RefreshCw, Eye } from 'lucide-react';
import { InspectionMachineState, InspectionRecord } from '../../types/inspection';

interface StatusDisplayProps {
  state: InspectionMachineState;
  stabilizationProgress: number;
  currentResult: InspectionRecord | null;
  expectedCount: number;
}

export const StatusDisplay: React.FC<StatusDisplayProps> = ({
  state,
  stabilizationProgress,
  currentResult,
  expectedCount,
}) => {
  // 1. OK State
  if (state === 'JUDGEMENT_OK' || (state === 'WAITING_PART_REMOVAL' && currentResult?.judgement === 'OK')) {
    return (
      <div className="bg-emerald-950 border border-emerald-500 rounded-xl p-5 text-white shadow-lg transition-all animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl bg-emerald-500/20 border-2 border-emerald-400 flex items-center justify-center text-emerald-400 shadow-inner">
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-3xl sm:text-4xl font-black tracking-wider text-emerald-300">
                  PASS (OK)
                </span>
                <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-emerald-900 border border-emerald-700 text-emerald-200">
                  Inspection Passed
                </span>
              </div>
              <p className="text-base sm:text-lg font-medium text-emerald-100 mt-0.5">
                {currentResult?.expectedCount || expectedCount} / {currentResult?.expectedCount || expectedCount} INSPECTION POINTS PASS
              </p>
            </div>
          </div>
          <div className="text-right hidden sm:block">
            <div className="text-xs uppercase tracking-widest text-emerald-400 font-mono">Cycle Time</div>
            <div className="text-2xl font-mono font-bold text-white">
              {currentResult?.metrics?.totalCycleMs || 0} ms
            </div>
          </div>
        </div>

        {state === 'WAITING_PART_REMOVAL' && (
          <div className="mt-4 pt-3 border-t border-emerald-800/80 flex items-center justify-between text-xs sm:text-sm text-emerald-300 font-mono">
            <span className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
              <span>PART INSPECTED · REMOVE PART TO INSPECT NEXT PIECE</span>
            </span>
            <span className="hidden md:inline text-emerald-400/80">Anti-Double Detection Active</span>
          </div>
        )}
      </div>
    );
  }

  // 2. NG State
  if (state === 'JUDGEMENT_NG' || (state === 'WAITING_PART_REMOVAL' && currentResult?.judgement === 'NG')) {
    const primaryDefect = currentResult?.defects?.[0];
    return (
      <div className="bg-red-950 border border-red-500 rounded-xl p-5 text-white shadow-xl transition-all animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl bg-red-500/20 border-2 border-red-400 flex items-center justify-center text-red-400 shadow-inner">
              <XCircle className="w-10 h-10 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-3xl sm:text-4xl font-black tracking-wider text-red-300">
                  REJECT (NG)
                </span>
                <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-red-900 border border-red-700 text-red-200">
                  Defect Found
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-lg sm:text-xl font-bold text-white bg-red-900/60 px-2.5 py-0.5 rounded border border-red-600/60">
                  {currentResult?.primaryReason || 'Defect detected in configured inspection area'}
                </span>
              </div>
            </div>
          </div>
          <div className="text-right hidden sm:block">
            <div className="text-xs uppercase tracking-widest text-red-300 font-mono">Points Passed</div>
            <div className="text-2xl font-mono font-bold text-white">
              {currentResult?.detectedCount || 0} / {currentResult?.expectedCount || expectedCount}
            </div>
          </div>
        </div>

        {/* Detailed Defect Listing */}
        {currentResult?.defects && currentResult.defects.length > 0 && (
          <div className="mt-4 pt-3 border-t border-red-800/80 flex flex-wrap gap-2">
            {currentResult.defects.map((d, idx) => (
              <div
                key={idx}
                className="text-xs font-mono bg-red-900/80 border border-red-700 text-red-200 px-2.5 py-1 rounded-md"
              >
                ⚠ {d.message}
              </div>
            ))}
          </div>
        )}

        {state === 'WAITING_PART_REMOVAL' && (
          <div className="mt-3 pt-3 border-t border-red-800/80 flex items-center justify-between text-xs sm:text-sm text-red-300 font-mono">
            <span className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin text-red-400" />
              <span>REMOVE REJECTED PART TO RESUME INSPECTION</span>
            </span>
            <span className="hidden md:inline text-red-400/80">Result Logged to Database</span>
          </div>
        )}
      </div>
    );
  }

  // Invalid means the system lacks trustworthy evidence; never present it as product NG or OK.
  if (state === 'INSPECTION_INVALID' || currentResult?.judgement === 'INVALID') {
    return (
      <div className="bg-amber-950 border border-amber-500 rounded-xl p-5 text-white shadow-lg">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-xl bg-amber-500/20 border-2 border-amber-400 flex items-center justify-center text-amber-400">
            <AlertTriangle className="w-10 h-10" />
          </div>
          <div>
            <div className="text-2xl sm:text-3xl font-black text-amber-300">INSPECTION INVALID</div>
            <div className="text-xs font-mono mt-1 text-amber-200">PROCESS BLOCKED · NO OK/NG CLAIM</div>
            <p className="text-sm text-amber-100 mt-2 font-mono">
              {currentResult?.primaryReason || 'Selected product revision is not ready. Verify the original master image, anchor configuration, and genuine OK/NG references before starting.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 3. Alignment or System Error
  if (state === 'ALIGNMENT_ERROR' || state === 'SYSTEM_ERROR' || (state === 'WAITING_PART_REMOVAL' && currentResult?.judgement === 'ERROR')) {
    return (
      <div className="bg-amber-950 border border-amber-500 rounded-xl p-5 text-white shadow-lg">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-xl bg-amber-500/20 border-2 border-amber-400 flex items-center justify-center text-amber-400">
            <AlertTriangle className="w-10 h-10" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl sm:text-3xl font-black text-amber-300">
                SYSTEM / ALIGNMENT FAULT
              </span>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-900 border border-amber-700 text-amber-200">
                PROCESS BLOCKED
              </span>
            </div>
            <p className="text-sm sm:text-base text-amber-100 mt-1 font-mono">
              {currentResult?.primaryReason || (state === 'ALIGNMENT_ERROR' ? 'Reference anchors not found or obstructed. Check stand position.' : 'Inspection system fault. Check diagnostics before resuming.')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 4. Stabilizing / Capturing / Inspecting
  if (state === 'PART_DETECTED' || state === 'STABILIZING' || state === 'CAPTURING' || state === 'ALIGNING' || state === 'INSPECTING') {
    const pct = Math.round(stabilizationProgress * 100);
    return (
      <div className="bg-slate-900 border border-cyan-500 rounded-xl p-5 text-white shadow-lg">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl bg-cyan-500/20 border-2 border-cyan-400 flex items-center justify-center text-cyan-400">
              <Clock className="w-9 h-9 animate-spin" />
            </div>
            <div>
              <div className="text-2xl sm:text-3xl font-black tracking-wide text-cyan-300 flex items-center gap-3">
                <span>{state === 'STABILIZING' ? 'PART DETECTED · STABILIZING' : 'INSPECTING...'}</span>
              </div>
              <p className="text-xs sm:text-sm text-slate-300 font-mono mt-1">
                {state === 'STABILIZING'
                  ? `Settle delay: (${pct}%) · Checking camera vibration & motion`
                  : 'Aligning reference anchors & evaluating configured inspection areas...'}
              </p>
            </div>
          </div>
          <div className="text-right font-mono text-cyan-400 font-bold text-xl sm:text-2xl">
            {state === 'STABILIZING' ? `${pct}%` : 'VISION'}
          </div>
        </div>

        {/* Progress Bar for 500ms stabilization */}
        <div className="mt-3 w-full bg-slate-800 rounded-full h-2 overflow-hidden">
          <div
            className="bg-cyan-400 h-full transition-all duration-75"
            style={{ width: `${state === 'STABILIZING' ? pct : 100}%` }}
          />
        </div>
      </div>
    );
  }

  // 5. Waiting for Part (Default Standby)
  return (
    <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-5 text-white">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-xl bg-slate-800 border-2 border-slate-600 flex items-center justify-center text-slate-400">
            <Eye className="w-9 h-9 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <span className="text-2xl sm:text-3xl font-black tracking-wider text-slate-100">
                WAITING FOR PART
              </span>
              <span className="flex h-3 w-3 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-400 font-mono mt-0.5">
              Place workpiece in the detection zone. Inspection starts automatically.
            </p>
          </div>
        </div>
        <div className="text-right hidden sm:block">
          <span className="text-xs font-mono px-3 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">
            AUTO-TRIGGER ACTIVE
          </span>
        </div>
      </div>
    </div>
  );
};
