/**
 * Realtime Vision Inspection Pipeline Hook
 * Implements the zero-touch automated state machine integrated with PLC Interlock:
 * WAITING -> PART_DETECTED -> STABILIZING (500ms) -> CAPTURE -> ALIGNMENT -> INSPECTION -> PLC HANDSHAKE -> INTERLOCK -> WAIT_PART_REMOVAL
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { soundService } from '../services/audio';
import { dbService } from '../services/db';
import { plcService } from '../services/plc/plcService';
import { getRuntimeIdentity, getRuntimeIdentity as getVisionRuntimeIdentity } from '../services/runtimeConfig';
import {
  AlignmentResult,
  ExtraDetectedObject,
  InspectionMachineState,
  InspectionRecord,
  InspectionStats,
  JudgementResult,
  ROIInspectionResult,
  SystemMetrics,
} from '../types/inspection';
import { MasterProduct, MasterRevision } from '../types/master';
import { PLCHandshakeState, PLCLiveSignals } from '../types/plc';
import { getRegionStats, toGrayscale } from '../vision/imageUtils';
import { PresenceDetector } from '../vision/presenceDetector';
import { roiInspector } from '../vision/roiInspector';
import { ruleEngine } from '../vision/ruleEngine';
import { preprocessInspectionFrame } from '../vision/opencvEngine';
import { markInspectionLifecycleComplete, sendInspectionResult, sendStandbyEvent } from '../services/visionCloud';

export interface UseInspectionPipelineProps {
  activeMaster: MasterProduct | null;
  activeRevision: MasterRevision | null;
  captureFrame: () => ImageData | null;
  cameraState: string;
  fps: number;
  processingFps: number;
  sessionActive: boolean;
}

export function useInspectionPipeline({
  activeMaster,
  activeRevision,
  captureFrame,
  cameraState,
  fps,
  processingFps,
  sessionActive,
}: UseInspectionPipelineProps) {
  const [state, setState] = useState<InspectionMachineState>('WAITING_FOR_PART');
  const [stabilizationProgress, setStabilizationProgress] = useState<number>(0);
  const [motionDelta, setMotionDelta] = useState<number>(0);

  // Latest inspection data
  const [currentResult, setCurrentResult] = useState<InspectionRecord | null>(null);
  const [latestAlignment, setLatestAlignment] = useState<AlignmentResult | null>(null);
  const [latestRoiResults, setLatestRoiResults] = useState<ROIInspectionResult[]>([]);
  const [latestExtraObjects, setLatestExtraObjects] = useState<ExtraDetectedObject[]>([]);
  const [stats, setStats] = useState<InspectionStats>({
    totalInspected: 0,
    totalOk: 0,
    totalNg: 0,
    totalInvalid: 0,
    totalErrors: 0,
    yieldRate: 100,
    lastCycleTimeMs: 0,
    averageCycleTimeMs: 0,
  });

  // Diagnostics breakdown
  const [liveMetrics, setLiveMetrics] = useState<SystemMetrics>({
    cameraFps: 0,
    partDetectionMs: 0,
    stabilizationMs: 500,
    alignmentMs: 0,
    roiDetectionMs: 0,
    ruleValidationMs: 0,
    dbSaveMs: 0,
    totalCycleMs: 0,
    frameResolution: { width: 800, height: 600 },
  });

  // PLC Live State
  const [plcHandshake, setPlcHandshake] = useState<PLCHandshakeState>(plcService.getHandshakeState());
  const [plcSignals, setPlcSignals] = useState<PLCLiveSignals>(plcService.getSignals());

  // Internal state tracking
  const presenceDetectorRef = useRef<PresenceDetector>(new PresenceDetector());
  const isProcessingRef = useRef<boolean>(false);
  const isResettingPlcRef = useRef<boolean>(false);
  const detectionStartTimeRef = useRef<number>(0);
  const cycleStartTimeRef = useRef<number>(0);
  const activeMasterRef = useRef<MasterProduct | null>(activeMaster);
  const activeRevisionRef = useRef<MasterRevision | null>(activeRevision);
  const lastStabProgressRef = useRef<number>(0);
  const lastMotionDeltaRef = useRef<number>(0);
  const lastUiTickRef = useRef<number>(0);

  useEffect(() => {
    activeMasterRef.current = activeMaster;
    activeRevisionRef.current = activeRevision;
  }, [activeMaster, activeRevision]);

  // Refresh dashboard counters from the same source used by Inspection History.
  // Clear History calls this after the records are removed, so the live counters
  // cannot keep showing stale totals from the previous inspection run.
  const refreshStats = useCallback(async () => {
    const nextStats = await dbService.getStats();
    setStats(nextStats);
    return nextStats;
  }, []);

  // Load initial stats and subscribe to PLC state
  useEffect(() => {
    refreshStats().catch(console.error);

    const unsubscribe = plcService.subscribe((hs, sigs) => {
      setPlcHandshake(hs);
      setPlcSignals(sigs);
    });

    return () => unsubscribe();
  }, [refreshStats]);

  // Reset state when master/revision changes
  const resetPipeline = useCallback(() => {
    // SAFETY: once a physical part has received a judgement, changing the
    // selected master/revision must never clear the removal latch or PLC
    // interlock. The part must leave the jig before a new inspection cycle
    // can be started.
    if (isProcessingRef.current || presenceDetectorRef.current.isAwaitingRemoval()) {
      return;
    }

    presenceDetectorRef.current.resetPartState();
    setState('WAITING_FOR_PART');
    setStabilizationProgress(0);
    setMotionDelta(0);
    setCurrentResult(null);
    setLatestAlignment(null);
    setLatestRoiResults([]);
    setLatestExtraObjects([]);
    detectionStartTimeRef.current = 0;
    cycleStartTimeRef.current = 0;
    isProcessingRef.current = false;
    plcService.clearInterlock();
  }, []);

  // Calibrate current empty background
  const calibrateBackground = useCallback(() => {
    const frame = captureFrame();
    if (!frame || !activeRevisionRef.current) return;
    const gray = toGrayscale(frame);
    const dz = activeRevisionRef.current.detectionZone;
    const rx = dz.x * gray.width;
    const ry = dz.y * gray.height;
    const rw = dz.width * gray.width;
    const rh = dz.height * gray.height;

    const regionStats = getRegionStats(gray, rx, ry, rw, rh);
    presenceDetectorRef.current.setBaseline(regionStats);
  }, [captureFrame]);

  // Start a controlled inspection session. Baseline is captured only after
  // the operator explicitly starts the cycle and the camera is already live.
  const startSession = useCallback(async () => {
    if (sessionActive || !activeRevisionRef.current) return false;

    const samples: { mean: number; variance: number }[] = [];
    const revision = activeRevisionRef.current;

    for (let i = 0; i < 5; i += 1) {
      const frame = captureFrame();
      if (frame) {
        const gray = toGrayscale(frame);
        const dz = revision.detectionZone;
        const stats = getRegionStats(
          gray,
          dz.x * gray.width,
          dz.y * gray.height,
          dz.width * gray.width,
          dz.height * gray.height
        );
        samples.push(stats);
      }
      if (i < 4) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
      }
    }

    if (samples.length < 3) return false;

    const baseline = {
      mean: samples.reduce((sum, sample) => sum + sample.mean, 0) / samples.length,
      variance: samples.reduce((sum, sample) => sum + sample.variance, 0) / samples.length,
    };

    presenceDetectorRef.current.resetPartState();
    presenceDetectorRef.current.setBaseline(baseline);
    setState('WAITING_FOR_PART');
    setStabilizationProgress(0);
    setMotionDelta(0);
    setCurrentResult(null);
    setLatestAlignment(null);
    setLatestRoiResults([]);
    setLatestExtraObjects([]);
    detectionStartTimeRef.current = 0;
    cycleStartTimeRef.current = 0;
    isProcessingRef.current = false;
    return true;
  }, [captureFrame, sessionActive]);

  // Execute actual inspection on settled frame
  const executeInspection = useCallback(
    async (frameData: ImageData, partDetectTime: number, stabTime: number) => {
      const master = activeMasterRef.current;
      const revision = activeRevisionRef.current;
      if (!master || !revision) return;

      const cycleStart = performance.now();

      try {
        // Vision validation uses multiple frames inside a hard 500 ms window.
      // A single noisy frame must not decide the product. Two matching
      // consecutive judgements are enough to finalize early; otherwise the
      // strongest consensus available at the deadline becomes the result.
      const validationStartedAt = performance.now();
      const validationDeadlineMs = 500;
      const maxValidationFrames = 3;

      type VisionSample = {
        frame: ImageData;
        alignment: AlignmentResult;
        roiResults: ROIInspectionResult[];
        extraObjects: ExtraDetectedObject[];
        evaluation: ReturnType<typeof ruleEngine.evaluate>;
        alignmentMs: number;
        roiMs: number;
        ruleMs: number;
      };

      const samples: VisionSample[] = [];

      const inspectVisionFrame = async (candidateFrame: ImageData): Promise<VisionSample> => {
        setState('INSPECTING');
        plcService.logTimelineEvent(
          'ROI_COMPARISON_STARTED',
          'VISION',
          'Comparing rectangular camera ROIs with approved OK reference images'
        );

        const opencvFrame = await preprocessInspectionFrame(candidateFrame);
        const gray = opencvFrame.gray;

        const alignStart = performance.now();
        // Simple ROI MVP uses fixed normalized camera coordinates; no
        // screw/fiducial alignment is required for this inspection mode.
        const alignment: AlignmentResult = {
          success: true,
          translationX: 0,
          translationY: 0,
          rotationDeg: 0,
          scale: 1,
          confidence: 1,
          matchedAnchorCount: 0,
          totalAnchorCount: 0,
          anchorPositions: [],
        };
        const alignmentMs = performance.now() - alignStart;

        plcService.logTimelineEvent(
          'ROI_COORDINATES_READY',
          'VISION',
          'Fixed-camera normalized coordinates active; fiducial alignment bypassed'
        );

        let roiResults: ROIInspectionResult[] = [];
        let extraObjects: ExtraDetectedObject[] = [];
        let roiMs = 0;

        if (alignment.success) {
          setState('INSPECTING');
          const roiStart = performance.now();
          const inspection = await roiInspector.inspectROIs(
            gray,
            revision.inspectionROIs,
            alignment,
            revision.tolerance,
            revision.masterWidth,
            revision.masterHeight,
            revision.referenceImages || [],
            candidateFrame
          );
          roiResults = inspection.roiResults;
          extraObjects = inspection.extraObjects;
          roiMs = performance.now() - roiStart;
        }

        const ruleStart = performance.now();
        const evaluation = ruleEngine.evaluate(
          revision,
          alignment,
          roiResults,
          extraObjects
        );
        const ruleMs = performance.now() - ruleStart;

        return {
          frame: candidateFrame,
          alignment,
          roiResults,
          extraObjects,
          evaluation,
          alignmentMs,
          roiMs,
          ruleMs,
        };
      };

      let candidateFrame = frameData;

      while (
        samples.length < maxValidationFrames &&
        performance.now() - validationStartedAt < validationDeadlineMs
      ) {
        const sample = await inspectVisionFrame(candidateFrame);
        samples.push(sample);

        const lastTwo = samples.slice(-2);
        if (lastTwo.length === 2) {
          const [previous, current] = lastTwo;

          // Early-finalization must obey the same evidence rules as the
          // deadline consensus. Repeated labels alone are never enough for NG.
          const concreteNgCodes = new Set([
            'MISSING_PART',
            'POSITION_OUT_OF_TOLERANCE',
            'EXTRA_OBJECT_DETECTED',
            'INCORRECT_COUNT',
            'VISUAL_MISMATCH',
          ]);

          const ngFingerprint = (sample: VisionSample) =>
            sample.evaluation.defects
              .filter((defect) => concreteNgCodes.has(defect.code))
              .map((defect) => defect.code + ':' + (defect.roiId || 'GLOBAL'))
              .sort()
              .join('|');

          const sameStrongNg =
            previous.evaluation.judgement === 'NG' &&
            current.evaluation.judgement === 'NG' &&
            ngFingerprint(previous).length > 0 &&
            ngFingerprint(previous) === ngFingerprint(current);

          const sameStrongOk =
            previous.evaluation.judgement === 'OK' &&
            current.evaluation.judgement === 'OK';

          if (sameStrongOk || sameStrongNg) {
            break;
          }
        }

        if (samples.length >= maxValidationFrames) break;

        const remaining = validationDeadlineMs - (performance.now() - validationStartedAt);
        if (remaining <= 0) break;

        // Give the camera a chance to provide a genuinely different frame.
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, Math.min(60, remaining))
        );

        const nextFrame = captureFrame();
        if (!nextFrame) break;
        candidateFrame = nextFrame;
      }

      if (samples.length === 0) {
        throw new Error('No vision validation sample was produced');
      }

      // Conservative consensus: a product NG must be proven by repeated,
      // concrete defect evidence. Repeated labels alone are not evidence.
      // Mixed OK/NG or differing defect evidence is INVALID, never OK.
      const okSamples = samples.filter((sample) => sample.evaluation.judgement === 'OK');
      const ngSamples = samples.filter((sample) => sample.evaluation.judgement === 'NG');
      const invalidSamples = samples.filter((sample) => sample.evaluation.judgement === 'INVALID');
      const errorSamples = samples.filter((sample) => sample.evaluation.judgement === 'ERROR');

      const concreteNgCodes = new Set([
        'MISSING_PART',
        'POSITION_OUT_OF_TOLERANCE',
        'EXTRA_OBJECT_DETECTED',
        'INCORRECT_COUNT',
        'VISUAL_MISMATCH',
      ]);

      const ngFingerprint = (sample: VisionSample) =>
        sample.evaluation.defects
          .filter((defect) => concreteNgCodes.has(defect.code))
          .map((defect) => defect.code + ':' + (defect.roiId || 'GLOBAL'))
          .sort()
          .join('|');

      const strongNgSamples = ngSamples.filter((sample) => ngFingerprint(sample).length > 0);
      const strongNgFingerprints = new Set(strongNgSamples.map(ngFingerprint));

      let selected = samples[samples.length - 1];

      if (errorSamples.length > 0) {
        selected = errorSamples[errorSamples.length - 1];
      } else if (strongNgSamples.length >= 2 && strongNgFingerprints.size === 1) {
        // NG is allowed only when at least two frames independently prove the
        // same concrete product defect. This prevents repeated weak vision
        // failures from becoming a false product NG.
        selected = strongNgSamples[strongNgSamples.length - 1];
      } else if (okSamples.length === samples.length) {
        // Every validation frame agrees that all required checks passed.
        selected = okSamples[okSamples.length - 1];
      } else {
        // Any disagreement (OK vs NG, different NG defects, or uncertainty)
        // means the vision system cannot prove a product judgement safely.
        const invalidEvaluation = {
          ...samples[samples.length - 1].evaluation,
          judgement: 'INVALID' as const,
          primaryReason:
            invalidSamples.length > 0
              ? 'Inspection Invalid: one or more validation frames contained insufficient vision evidence'
              : 'Inspection Invalid: multi-frame evidence was inconsistent; product NG was not proven',
          defects: [
            ...samples[samples.length - 1].evaluation.defects,
            {
              code: 'LOW_CONFIDENCE' as const,
              message: 'Multi-frame evidence was not consistent enough to prove OK or NG',
              expected: 'Consistent validation evidence across inspection frames',
              actual: samples.length + ' validation frame(s) with mixed or insufficient evidence',
            },
          ],
        };
        selected = {
          ...samples[samples.length - 1],
          evaluation: invalidEvaluation,
        };
      }
      const alignment = selected.alignment;
      const roiResults = selected.roiResults;
      const extraObjects = selected.extraObjects;
      const evaluation = selected.evaluation;
      const alignTime = Math.max(...samples.map((sample) => sample.alignmentMs));
      const roiTime = Math.max(...samples.map((sample) => sample.roiMs));
      const ruleTime = Math.max(...samples.map((sample) => sample.ruleMs));
      const validationElapsedMs = Math.round(performance.now() - validationStartedAt);

      setLatestAlignment(alignment);
      setLatestRoiResults(roiResults);
      setLatestExtraObjects(extraObjects);

      plcService.logTimelineEvent(
        'MULTI_FRAME_VALIDATION_COMPLETE',
        'VISION',
        `${samples.length} frame(s), ${validationElapsedMs}ms validation, final ${evaluation.judgement}`
      );

      // Use the frame belonging to the selected consensus sample for traceability.
      frameData = selected.frame;

      // 3. Rule Engine Judgement
      // The selected consensus evaluation is authoritative for this cycle.
      plcService.logTimelineEvent(
        'INSPECTION_COMPLETE',
        'VISION',
        `Judgement: ${evaluation.judgement} - ${evaluation.primaryReason}`
      );

      // 4. Create thumbnail for traceability
      let thumbnailBase64 = '';
      try {
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 160;
        thumbCanvas.height = 120;
        const thumbCtx = thumbCanvas.getContext('2d');
        if (thumbCtx) {
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = frameData.width;
          tempCanvas.height = frameData.height;
          tempCanvas.getContext('2d')?.putImageData(frameData, 0, 0);
          thumbCtx.drawImage(tempCanvas, 0, 0, 160, 120);
          thumbnailBase64 = thumbCanvas.toDataURL('image/jpeg', 0.6);
        }
      } catch {
        // Thumbnail generation failure is non-fatal
      }

      const totalInspectionMs = Math.round(performance.now() - cycleStart);
      const totalCycleMs = Math.round(partDetectTime + stabTime + totalInspectionMs);

      // 5. Processing time is a deterministic budget, not a new product state.
      // A vision cycle that takes longer than the preferred budget must still
      // produce a product judgement; only infrastructure/runtime failures are ERROR.
      let resultJudgement: JudgementResult = evaluation.judgement;
      let resultReason = evaluation.primaryReason;
      if (totalInspectionMs > plcService.getConfig().maxInspectionTimeoutMs) {
        resultReason = `${evaluation.primaryReason} — inspection exceeded the preferred processing budget`;
        plcService.logTimelineEvent('INSPECTION_BUDGET_EXCEEDED', 'VISION', resultReason);
      }

      // Explicitly separate Product NG from genuine infrastructure failure.
      const isProductNg = resultJudgement === 'NG';
      const isSystemError = resultJudgement === 'ERROR';

      const inspectionId = `INSP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const plcSequenceNumber = plcService.getHandshakeState().lastSequenceNumber;
      const plcHandshakeResult = await plcService.sendResultAndHandshake({
        sequenceNumber: plcSequenceNumber,
        inspectionId,
        timestamp: new Date().toISOString(),
        productCode: master.productCode,
        revisionCode: revision.revisionCode,
        judgement: resultJudgement,
        isProductNg,
        isSystemError,
        failureReason: resultReason,
        detectedCount: evaluation.detectedCount,
        expectedCount: evaluation.expectedCount,
        alignmentOk: alignment.success,
        cycleTimeMs: totalCycleMs,
      });

      // Keep product quality judgement separate from PLC communication status.
      // A missing ACK must keep the machine interlocked, but must not erase a
      // valid vision OK/NG result from production counters and inspection history.
      if (plcService.getConfig().enabled && !plcHandshakeResult.ackReceived) {
        const handshakeFault = 'PLC result ACK was not received; process remains blocked';
        resultReason = resultReason
          ? `${resultReason} — ${handshakeFault}`
          : handshakeFault;
        plcService.logTimelineEvent('HANDSHAKE_FAILED', 'INTERLOCK', handshakeFault);
      }

      const identity = getRuntimeIdentity();

      // 6. Metrics collection
      const metrics: SystemMetrics = {
        cameraFps: fps,
        partDetectionMs: Math.round(partDetectTime),
        stabilizationMs: Math.round(stabTime),
        alignmentMs: Math.round(alignTime),
        roiDetectionMs: Math.round(roiTime),
        ruleValidationMs: Math.round(ruleTime),
        dbSaveMs: 0,
        plcHandshakeMs: plcHandshakeResult.commLatencyMs,
        totalCycleMs: totalCycleMs + plcHandshakeResult.commLatencyMs,
        frameResolution: {
          width: frameData.width,
          height: frameData.height,
        },
      };

      const record: InspectionRecord = {
        id: inspectionId,
        timestamp: new Date().toISOString(),
        productId: master.id,
        productCode: master.productCode,
        productName: master.productName,
        masterId: master.id,
        masterRevisionId: revision.id,
        masterRevisionCode: revision.revisionCode,
        judgement: resultJudgement,
        expectedCount: evaluation.expectedCount,
        detectedCount: evaluation.detectedCount,
        defects: evaluation.defects,
        primaryReason: resultReason,
        metrics,
        alignment,
        roiResults,
        extraObjects,
        thumbnailBase64,
        deviceId: identity.stationId,
        operatorId: identity.operatorId,
        syncedToCloud: false,
        sequenceNumber: plcSequenceNumber,
        plcInterlockState: plcService.getHandshakeState().interlockState,
        plcCommLatencyMs: plcHandshakeResult.commLatencyMs,
        plcTimeline: [...plcService.getHandshakeState().activeCycleTimeline],
      };

      setCurrentResult(record);

      // 7. Send the completed inspection event to AWS without blocking the
      // local vision/PLC lifecycle. OpenCV remains local; AWS receives the event.
      const cloudIdentity = getVisionRuntimeIdentity();
      void sendInspectionResult({
        status: resultJudgement,
        alignmentConfidence: alignment.confidence,
        roiConfidences: roiResults.map((roi) => roi.confidence),
        jig: cloudIdentity.stationId,
        inspectionId,
        productCode: master.productCode,
        revisionCode: revision.revisionCode,
        detectedCount: evaluation.detectedCount,
        expectedCount: evaluation.expectedCount,
        reason: resultReason,
        frame: frameData,
      }).then(({ analysis, evidenceKey }) => {
        const version = String(analysis.opencv_version || 'unknown');
        const candidates = Array.isArray(analysis.circle_candidates) ? analysis.circle_candidates.length : 0;
        plcService.logTimelineEvent(
          'AWS_EVIDENCE_CONFIRMED',
          'VISION',
          `AWS OpenCV ${version} analyzed frame; ${candidates} circle candidate(s); evidence stored at ${evidenceKey}. Product judgement source remains browser rule engine.`
        );
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[AWS inspection evidence]', error);
        plcService.logTimelineEvent(
          'AWS_EVIDENCE_FAILED',
          'VISION',
          `AWS analysis/evidence was not confirmed: ${message}`
        );
      });
      markInspectionLifecycleComplete(resultJudgement);

      // 8. Audio Feedback and State Display
      if (resultJudgement === 'OK') {
        setState('JUDGEMENT_OK');
        soundService.playPassChime();
      } else if (resultJudgement === 'NG') {
        setState('JUDGEMENT_NG');
        soundService.playFailBuzzer();
      } else if (resultJudgement === 'INVALID') {
        setState('INSPECTION_INVALID');
        soundService.playFailBuzzer();
      } else {
        setState('SYSTEM_ERROR');
        soundService.playFailBuzzer();
      }

      // 9. Asynchronous Database Persistence (Non-blocking)
      const dbSaveStart = performance.now();
      dbService
        .saveInspectionRecord(record)
        .then(async () => {
          metrics.dbSaveMs = Math.round(performance.now() - dbSaveStart);
          setLiveMetrics(metrics);
          const newStats = await dbService.getStats();
          setStats(newStats);
        })
        .catch(console.error);

      // 10. Freeze the completed judgement. The live loop owns the lifecycle.
      // This result remains locked until the presence detector confirms that
      // the physical part has been removed from the jig. There is no timeout,
      // operator reset, or reposition-based reinspection path.
      presenceDetectorRef.current.markPartInspected();
      isProcessingRef.current = false;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      console.error('[InspectionPipeline] Inspection cycle failed:', error);

      plcService.logTimelineEvent(
        'INSPECTION_ERROR',
        'VISION',
        `Inspection cycle aborted: ${message}`
      );

      // Never allow an exception to leave the pipeline permanently locked.
      setState('SYSTEM_ERROR');
      soundService.playFailBuzzer();

      // SAFETY: an inspection exception is a system fault. Do NOT clear
      // the PLC interlock here. Clearing it could release the machine after
      // an incomplete/unknown inspection. The interlock is released only by
      // the normal part-removal lifecycle after the cycle is safely contained.
      try {
        plcService.logTimelineEvent(
          'INTERLOCK_HELD_AFTER_ERROR',
          'INTERLOCK',
          'PLC interlock remains blocked because inspection ended with a system error'
        );
      } catch (timelineError) {
        console.error(
          '[InspectionPipeline] Failed to log held interlock state:',
          timelineError
        );
      }

      presenceDetectorRef.current.markPartInspected();
      isProcessingRef.current = false;
    }
  }, [captureFrame, fps]);

  // Main real-time pipeline tick loop. Presence/inspection sampling follows the operator-configured processing FPS.
  useEffect(() => {
    if (!sessionActive) return;
    if (cameraState === 'error' || cameraState === 'permission_denied') return;
    if (!activeRevision) return;

    const interval = setInterval(() => {
      if (isProcessingRef.current) return;

      const frameData = captureFrame();
      if (!frameData) return;

      const gray = toGrayscale(frameData);
      const now = Date.now();

      // Process presence through detection zone
      const presence = presenceDetectorRef.current.processFrame(
        gray,
        activeRevision.detectionZone,
        activeRevision.tolerance,
        now
      );

      // Throttle UI progress updates so React doesn't re-render 20 times/sec
      if (
        Math.abs(presence.stabilizationProgress - lastStabProgressRef.current) >= 0.08 ||
        presence.stabilizationProgress === 1 ||
        presence.stabilizationProgress === 0
      ) {
        lastStabProgressRef.current = presence.stabilizationProgress;
        setStabilizationProgress(presence.stabilizationProgress);
      }

      if (now - lastUiTickRef.current >= 400 || Math.abs(presence.motionDelta - lastMotionDeltaRef.current) >= 1.5) {
        lastUiTickRef.current = now;
        lastMotionDeltaRef.current = presence.motionDelta;
        setMotionDelta(presence.motionDelta);
      }

      const awaitingRemoval = presenceDetectorRef.current.isAwaitingRemoval();

      // Post-judgement lifecycle is deliberately one-way:
      // once a physical part has received a judgement, the result is latched.
      // Motion, repositioning, or changing the screw condition must NOT trigger
      // another inspection while the part is still physically present.
      // The only reset condition is confirmed part removal from the detection zone.
      if (awaitingRemoval) {
        if (!presence.isPartPresent && !isResettingPlcRef.current) {
          // The physical part is gone, but the inspection latch stays active
          // until the PLC confirms that its interlock was actually reset.
          // This prevents a failed reset from opening a new inspection cycle.
          isResettingPlcRef.current = true;
          void plcService.clearInterlock().then((resetOk) => {
            if (resetOk) {
              presenceDetectorRef.current.resetPartState();
              setState('WAITING_FOR_PART');
              setCurrentResult(null);
              setLatestAlignment(null);
              setLatestRoiResults([]);
              setLatestExtraObjects([]);
              setStabilizationProgress(0);
              setMotionDelta(0);
              detectionStartTimeRef.current = 0;
              cycleStartTimeRef.current = 0;
              const standbyIdentity = getVisionRuntimeIdentity();
              sendStandbyEvent(standbyIdentity.stationId);
            } else {
              setState('SYSTEM_ERROR');
            }
          }).catch((error) => {
            console.error('[InspectionPipeline] PLC interlock reset failed:', error);
            setState('SYSTEM_ERROR');
          }).finally(() => {
            isResettingPlcRef.current = false;
          });
        }

        // IMPORTANT: while awaiting removal or PLC reset confirmation,
        // presence detection is the only active vision task. Screw/ROI
        // judgement is completely suspended.
        return;
      }

      // Check configured Trigger Mode (AUTO_CAMERA vs PLC vs HYBRID)
      const plcCfg = plcService.getConfig();
      const plcLive = plcService.getSignals();

      let isTriggered = false;
      let triggerSource: 'VISION_AUTO' | 'PLC_TRIGGER' | 'HYBRID' = 'VISION_AUTO';

      if (plcCfg.triggerMode === 'AUTO_CAMERA') {
        isTriggered = presence.isPartPresent;
        triggerSource = 'VISION_AUTO';
      } else if (plcCfg.triggerMode === 'PLC') {
        isTriggered = plcLive.partPresent;
        triggerSource = 'PLC_TRIGGER';
      } else {
        // HYBRID MODE: PLC part present sensor + Vision presence confirmation
        isTriggered = plcLive.partPresent && presence.isPartPresent;
        triggerSource = 'HYBRID';
      }

      // Normal flow: Part has not been triggered yet
      if (!isTriggered) {
        if (state !== 'WAITING_FOR_PART') {
          setState('WAITING_FOR_PART');
        }
        detectionStartTimeRef.current = 0;
        return;
      }

      // Part is present in detection area / triggered by PLC
      if (detectionStartTimeRef.current === 0) {
        detectionStartTimeRef.current = now;
        cycleStartTimeRef.current = now;
        soundService.playDetectPip();
        // Start cycle in PLC service (invalidates previous results for stale result prevention)
        plcService.startNewCycle(triggerSource);
        plcService.logTimelineEvent('PART_DETECTED', 'VISION', 'Part entered station detection area');
      }

      if (!presence.isStabilized) {
        if (state !== 'STABILIZING') {
          setState('STABILIZING');
        }
        return;
      }

      // Part has stabilized for 500 ms! Trigger Capture & Inspect
      isProcessingRef.current = true;
      setState('CAPTURING');
      plcService.logTimelineEvent('STABILIZATION_COMPLETE', 'VISION', '500 ms stabilization settlement complete');

      const partDetectDuration = 45; // Approx detection latency
      const stabDuration = activeRevision.tolerance.stabilizationDelayMs || 500;

      // Run inspection asynchronously
      requestAnimationFrame(() => {
        executeInspection(frameData, partDetectDuration, stabDuration);
      });
    }, Math.max(50, Math.round(1000 / Math.max(1, processingFps))));

    return () => clearInterval(interval);
  }, [activeRevision, cameraState, captureFrame, executeInspection, state, processingFps, sessionActive]);

  return {
    state,
    stabilizationProgress,
    motionDelta,
    currentResult,
    latestAlignment,
    latestRoiResults,
    latestExtraObjects,
    stats,
    liveMetrics,
    plcHandshake,
    plcSignals,
    resetPipeline,
    refreshStats,
    calibrateBackground,
    startSession,
  };
}
