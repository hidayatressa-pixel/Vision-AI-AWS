/**
 * Zero-Touch Operator Live Inspection View
 * Primary view designed for a smartphone mounted on a fixed stand.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Layers,
  Maximize2,
  Minimize2,
  CheckCircle,
  XCircle,
  Crosshair,
} from 'lucide-react';
import {
  AlignmentResult,
  ExtraDetectedObject,
  InspectionMachineState,
  InspectionRecord,
  InspectionStats,
  ROIInspectionResult,
  SystemMetrics,
} from '../../types/inspection';
import { MasterProduct, MasterRevision } from '../../types/master';
import type { UserRole } from '../Navbar';
import { PLCHandshakeState, PLCLiveSignals } from '../../types/plc';
import { TestScenarioType } from '../../vision/testGenerator';
import { MetricsBar } from './MetricsBar';
import { StatusDisplay } from './StatusDisplay';

interface LiveInspectionViewProps {
  videoRef: React.Ref<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  cameraState: string;
  errorMessage: string;
  fps: number;
  processingFps: number;
  setProcessingFps: (fps: number) => void;
  videoDimensions: { width: number; height: number };
  state: InspectionMachineState;
  stabilizationProgress: number;
  motionDelta: number;
  currentResult: InspectionRecord | null;
  latestAlignment: AlignmentResult | null;
  latestRoiResults: ROIInspectionResult[];
  latestExtraObjects: ExtraDetectedObject[];
  stats: InspectionStats;
  liveMetrics: SystemMetrics;
  plcHandshake: PLCHandshakeState;
  plcSignals: PLCLiveSignals;
  activeMaster: MasterProduct | null;
  activeRevision: MasterRevision | null;
  role: UserRole;
  isVirtualMode: boolean;
  virtualScenario: TestScenarioType;
  setVirtualScenario: (s: TestScenarioType) => void;
  enableVirtualMode: (s: TestScenarioType) => void;
  enablePhysicalCamera: () => void;
  onOpenHistory: () => void;
  onOpenPlcConfig?: () => void;
  onEndSession?: () => void;
  onStartSession?: () => void;
  sessionActive?: boolean;
  sessionStarting?: boolean;
}

export const LiveInspectionView: React.FC<LiveInspectionViewProps> = ({
  videoRef,
  canvasRef,
  cameraState,
  errorMessage,
  fps,
  processingFps,
  setProcessingFps,
  videoDimensions,
  state,
  stabilizationProgress,
  motionDelta,
  currentResult,
  latestAlignment,
  latestRoiResults,
  latestExtraObjects,
  stats,
  liveMetrics,
  activeMaster,
  activeRevision,
  role,
  isVirtualMode,
  virtualScenario,
  setVirtualScenario,
  enableVirtualMode,
  enablePhysicalCamera,
  onOpenHistory,
  onEndSession,
  onStartSession,
  sessionActive = false,
  sessionStarting = false,
}) => {
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showOverlays, setShowOverlays] = useState(true);

  // Fullscreen toggle for stand mount
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  // Render the detection zone and rectangular ROI comparison overlays
  useEffect(() => {
    let animId: number;

    const render = () => {
      const canvas = overlayCanvasRef.current;
      if (!canvas || !activeRevision) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (!showOverlays) return;

      // 1. Draw Detection Zone
      const dz = activeRevision.detectionZone;
      const dzX = dz.x * w;
      const dzY = dz.y * h;
      const dzW = dz.width * w;
      const dzH = dz.height * h;

      const isPartPresent =
        state !== 'WAITING_FOR_PART' &&
        state !== 'CAMERA_INITIALIZING' &&
        state !== 'CAMERA_ERROR';

      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);

      if (state === 'JUDGEMENT_OK' || (state === 'WAITING_PART_REMOVAL' && currentResult?.judgement === 'OK')) {
        ctx.strokeStyle = '#10b981'; // Green
        ctx.fillStyle = 'rgba(16, 185, 129, 0.05)';
      } else if (state === 'JUDGEMENT_NG' || (state === 'WAITING_PART_REMOVAL' && currentResult?.judgement === 'NG')) {
        ctx.strokeStyle = '#ef4444'; // Red
        ctx.fillStyle = 'rgba(239, 68, 68, 0.05)';
      } else if (isPartPresent) {
        ctx.strokeStyle = '#06b6d4'; // Cyan
        ctx.fillStyle = 'rgba(6, 182, 212, 0.05)';
      } else {
        ctx.strokeStyle = '#64748b'; // Slate
        ctx.fillStyle = 'rgba(100, 116, 139, 0.02)';
      }

      ctx.strokeRect(dzX, dzY, dzW, dzH);
      ctx.fillRect(dzX, dzY, dzW, dzH);
      ctx.setLineDash([]);

      // Detection Zone Label
      ctx.font = '10px monospace';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText('DETECTION ZONE', dzX + 8, dzY + 16);

      // 2. Draw each configured rectangular comparison region.
      if (latestRoiResults.length > 0) {
        for (const result of latestRoiResults) {
          const config = activeRevision.inspectionROIs.find((roi) => roi.id === result.roiId);
          if (!config) continue;
          const rw = (config.width ?? config.radius * 2) * w;
          const rh = (config.height ?? config.radius * 2) * h;
          const centerX = result.expectedTransformedPosition.x * w;
          const centerY = result.expectedTransformedPosition.y * h;
          const left = centerX - rw / 2;
          const top = centerY - rh / 2;
          const color = result.status === 'PASS' ? '#10b981' : result.status === 'FAIL' ? '#ef4444' : '#f59e0b';
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.strokeRect(left, top, rw, rh);
          ctx.font = 'bold 10px monospace';
          ctx.fillStyle = color;
          ctx.textAlign = 'start';
          ctx.fillText(`${result.roiName} ${Math.round(result.confidence * 100)}%`, left + 3, Math.max(12, top - 4));
        }
      } else {
        for (const roi of activeRevision.inspectionROIs) {
          const rw = (roi.width ?? roi.radius * 2) * w;
          const rh = (roi.height ?? roi.radius * 2) * h;
          ctx.strokeStyle = '#64748b';
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(roi.x * w - rw / 2, roi.y * h - rh / 2, rw, rh);
          ctx.setLineDash([]);
        }
      }

      // 4. Draw Extra Detected Objects if any
      for (const extra of latestExtraObjects) {
        const exX = extra.position.x * w;
        const exY = extra.position.y * h;
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(exX, exY, 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = 'bold 10px monospace';
        ctx.fillStyle = '#f43f5e';
        ctx.textAlign = 'center';
        ctx.fillText('EXTRA!', exX, exY - 30);
      }

      ctx.restore();
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [
    activeRevision,
    currentResult,
    latestAlignment,
    latestExtraObjects,
    latestRoiResults,
    showOverlays,
    videoDimensions,
    state,
  ]);

  return (
    <div ref={containerRef} className="space-y-3">
      {/* 1. Giant Industrial Status Banner */}
      <StatusDisplay
        state={state}
        stabilizationProgress={stabilizationProgress}
        currentResult={currentResult}
        expectedCount={activeRevision?.expectedObjectCount || 8}
      />

      {/* 2. Main Live Inspection Stage */}
      <div className="relative rvi-inspection-stage">
        {/* Top Camera Status & Info Bar */}
        <div className="rvi-camera-strip absolute top-0 left-0 right-0 z-20 px-4 py-3 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-2 pointer-events-auto">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-900/90 border border-slate-700/80 text-xs font-mono text-slate-200 backdrop-blur-sm">
              <span
                className={`w-2 h-2 rounded-full ${
                  cameraState === 'streaming'
                    ? 'bg-emerald-400 animate-pulse'
                    : cameraState === 'virtual_mode'
                    ? 'bg-cyan-400'
                    : 'bg-red-400'
                }`}
              />
              {cameraState === 'virtual_mode' ? 'STAND SIMULATOR' : 'LIVE CAMERA'}
              <span className="text-slate-400">·</span>
              <span className="text-cyan-400">CAM {fps} FPS</span>
              <span className="text-slate-400">·</span>
              <span className="text-amber-300">DET {processingFps} FPS</span>
            </span>

            <span className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-md bg-slate-900/90 border border-emerald-500/30 text-[11px] font-mono text-emerald-300 backdrop-blur-sm">
              SIMPLE ROI · REFERENCE COMPARISON · FIXED CAMERA
            </span>
          </div>

          {!sessionActive && onStartSession && (
            <button
              type="button"
              onClick={onStartSession}
              disabled={sessionStarting || cameraState !== 'streaming' || !activeMaster || !activeRevision}
              className="pointer-events-auto px-3 py-1.5 rounded-lg bg-emerald-400 border border-emerald-300 text-[10px] font-mono font-black text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
              title="Start the inspection session and request AWS session activation"
            >
              {sessionStarting ? 'STARTING...' : 'START SESSION'}
            </button>
          )}

          {sessionActive && onEndSession && (
            <button
              type="button"
              onClick={onEndSession}
              disabled={state !== 'WAITING_FOR_PART'}
              className="pointer-events-auto px-2.5 py-1.5 rounded-lg bg-slate-900/90 border border-amber-500/30 text-[10px] font-mono text-amber-300 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-40"
              title={state === 'WAITING_FOR_PART' ? 'End inspection session and return to setup' : 'Remove the inspected part before ending the session'}
            >
              END SESSION
            </button>
          )}

          {role === 'ENGINEER' && (
            <div className="flex items-center gap-2 pointer-events-auto">
              <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-[10px] font-mono text-slate-400">
                DET FPS
                <select value={processingFps} onChange={(e) => setProcessingFps(Number(e.target.value))}
                  className="bg-transparent text-amber-300 outline-none">
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={15}>15</option>
                </select>
              </label>

              <button
                onClick={() => setShowOverlays(!showOverlays)}
                title={showOverlays ? 'Hide Inspection Overlays' : 'Show Inspection Overlays'}
                className={`p-2 rounded-lg text-xs font-mono border transition-all ${
                  showOverlays
                    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                    : 'bg-slate-900 text-slate-400 border-slate-800'
                }`}
              >
                <Crosshair className="w-4 h-4" />
              </button>

              <button
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen Stand Mode'}
                className="p-2 rounded-lg bg-slate-900/90 text-slate-300 hover:text-white border border-slate-800"
              >
                {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
            </div>
          )}
        </div>

        {/* Camera Video / Synthetic Frame Canvas */}
        <div className="relative aspect-[4/3] sm:aspect-[16/10] max-h-[65vh] w-full flex items-center justify-center bg-slate-950">
          {/* Real video stream element */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={`w-full h-full object-contain ${isVirtualMode ? 'hidden' : 'block'}`}
          />

          {/* Internal canvas buffer for frame processing */}
          <canvas
            ref={canvasRef}
            width={videoDimensions.width}
            height={videoDimensions.height}
            className={`w-full h-full object-contain ${isVirtualMode ? 'block' : 'hidden'}`}
          />

          {/* Transparent Overlay HUD Canvas */}
          <canvas
            ref={overlayCanvasRef}
            width={videoDimensions.width}
            height={videoDimensions.height}
            className="absolute inset-0 w-full h-full object-contain pointer-events-none z-10"
          />

          {/* Error Banner when camera access is blocked */}
          {cameraState === 'error' || cameraState === 'permission_denied' ? (
            <div className="absolute inset-0 bg-slate-950/95 flex flex-col items-center justify-center p-6 text-center z-30">
              <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-3">
                <Camera className="w-7 h-7" />
              </div>
              <h3 className="text-lg font-bold text-white mb-1">
                {cameraState === 'permission_denied' ? 'Camera Permission Required' : 'Camera Feed Offline'}
              </h3>
              <p className="text-xs text-slate-400 max-w-md mb-4 font-mono">
                {errorMessage || 'Smartphone camera hardware is unavailable in this environment.'}
              </p>
              {role === 'ENGINEER' ? (
                <div className="flex flex-wrap gap-2 justify-center">
                  <button
                    onClick={() => enableVirtualMode('PERFECT_PASS')}
                    className="px-4 py-2 rounded-lg bg-cyan-500 text-slate-950 font-bold text-xs hover:bg-cyan-400 transition-colors shadow-lg"
                  >
                    Switch to Stand Simulator
                  </button>
                  <button
                    onClick={enablePhysicalCamera}
                    className="px-4 py-2 rounded-lg bg-slate-800 text-slate-200 border border-slate-700 text-xs hover:bg-slate-700 transition-colors"
                  >
                    Retry Camera Connection
                  </button>
                </div>
              ) : (
                <p className="text-xs font-mono text-amber-300">Engineering intervention required.</p>
              )}
            </div>
          ) : null}
        </div>

        {role === 'ENGINEER' && (
          <div className="p-3 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400">Input Source:</span>
            <div className="flex items-center bg-slate-950 p-0.5 rounded-lg border border-slate-800">
              <button
                onClick={enablePhysicalCamera}
                className={`px-3 py-1 rounded-md transition-all ${
                  !isVirtualMode
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Physical Stand Camera
              </button>
              <button
                onClick={() => enableVirtualMode(virtualScenario)}
                className={`px-3 py-1 rounded-md transition-all ${
                  isVirtualMode
                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Stand Workpiece Simulator
              </button>
            </div>
          </div>

          {/* Test Part Scenarios */}
          {isVirtualMode && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-mono text-slate-400">Place Workpiece:</span>
              <select
                value={virtualScenario}
                onChange={(e) => enableVirtualMode(e.target.value as TestScenarioType)}
                className="bg-slate-950 text-cyan-300 font-mono text-xs border border-slate-700 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-cyan-500"
              >
                <option value="PERFECT_PASS">🟢 Approved Reference Match (OK)</option>
                <option value="SHIFTED_VIBRATION">🔄 Shifted Image Pattern (visual test)</option>
                <option value="MISSING_SCREW_4">🔴 Visual Mismatch A (NG)</option>
                <option value="MISSING_SCREW_2">🔴 Visual Mismatch B (NG)</option>
                <option value="OUT_OF_TOLERANCE_SCREW_2">🔴 Visual Difference (NG)</option>
                <option value="EXTRA_SCREW">🔴 Unexpected Visual Pattern (NG)</option>
                <option value="ALIGNMENT_FAILURE">⚠️ Camera Comparison Unavailable</option>
                <option value="EMPTY_STAND">⏳ Empty Stand (Part Removed)</option>
              </select>
            </div>
          )}

          </div>
        )}
      </div>

      {/* 3. Real-Time Production Metrics Bar */}
      <MetricsBar stats={stats} liveMetrics={liveMetrics} motionDelta={motionDelta} />

      {/* 4. Industrial PLC Interlock & Handshake Status Panel (Section 46) */}
      <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs font-mono text-amber-200">
        <span className="h-2 w-2 rounded-full bg-amber-400" />
        PLC DISABLED · MVP LOCAL INSPECTION MODE · NO MACHINE INTERLOCK
      </div>

      {/* 5. Per-ROI Realtime Status Breakdown (Explainable Visual Inspector) */}
      {activeRevision && latestRoiResults.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-cyan-400" />
              <span className="font-bold text-sm text-white">ROI DETAILED VALIDATION MATRIX</span>
              <span className="text-xs text-slate-400 font-mono">
                ({latestRoiResults.filter((r) => r.status === 'PASS').length}/{latestRoiResults.length} ROIs Matched)
              </span>
            </div>
            <span className="text-xs font-mono text-slate-400">Reference-image similarity</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {latestRoiResults.map((roi) => (
              <div
                key={roi.roiId}
                className={`p-3 rounded-xl border transition-all ${
                  roi.status === 'PASS'
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                    : 'bg-red-950/60 border-red-500/60 text-red-200'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold font-mono text-xs">{roi.roiName}</span>
                  {roi.status === 'PASS' ? (
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-400" />
                  )}
                </div>

                <div className="text-[11px] font-mono space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Presence:</span>
                    <span className={roi.isPresent ? 'text-emerald-400' : 'text-red-400'}>
                      {roi.isPresent ? 'OK' : 'MISSING'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Confidence:</span>
                    <span>{(roi.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Offset:</span>
                    <span className={roi.isWithinTolerance ? 'text-slate-200' : 'text-red-400 font-bold'}>
                      +{roi.positionOffsetMm}mm
                    </span>
                  </div>
                </div>

                {roi.failureReason && (
                  <div className="mt-1.5 pt-1.5 border-t border-red-500/30 text-[10px] text-red-300 font-semibold truncate">
                    {roi.failureReason}
                  </div>
                )}

                {activeRevision.referenceImages?.find((reference) => reference.roiId === roi.roiId) && (
                  <div className="mt-2 pt-2 border-t border-slate-800">
                    <div className="text-[9px] uppercase tracking-wider font-mono text-slate-500 mb-1">Golden Reference</div>
                    <div className="h-16 rounded-lg overflow-hidden border border-slate-800 bg-slate-950">
                      <img
                        src={activeRevision.referenceImages.find((reference) => reference.roiId === roi.roiId)?.imageUrl}
                        alt={`Golden reference for ${roi.roiName}`}
                        className="h-full w-full object-contain"
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
