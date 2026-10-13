/**
 * Presence and Stabilization Detector
 * Uses a calibrated empty-scene baseline plus local pixel-change regions so
 * small parts do not disappear inside whole-zone averages at longer distances.
 */

import { Box2D, ToleranceConfig } from '../types/master';
import { calculateMotionDelta, getRegionStats, GrayscaleImage } from './imageUtils';

export interface PresenceState {
  isPartPresent: boolean;
  presenceScore: number; // 0 - 100
  motionDelta: number; // Frame-to-frame movement
  isStabilized: boolean;
  stabilizationProgress: number; // 0.0 - 1.0
}

type RegionStats = { mean: number; variance: number };

export class PresenceDetector {
  private baselineStats: RegionStats | null = null;
  private baselineFrame: GrayscaleImage | null = null;
  private prevFrame: GrayscaleImage | null = null;
  private stabilizationStartTime: number | null = null;
  private isCurrentlyPresent = false;
  private hasInspectedCurrentPart = false;
  private removalCandidateSince: number | null = null;

  public setBaseline(stats: RegionStats) {
    this.baselineStats = stats;
  }

  /** Store a copy of the empty-scene frame for localized change detection. */
  public setBaselineFrame(frame: GrayscaleImage) {
    this.baselineFrame = {
      width: frame.width,
      height: frame.height,
      data: new Uint8Array(frame.data),
    };
  }

  public resetPartState() {
    this.isCurrentlyPresent = false;
    this.hasInspectedCurrentPart = false;
    this.removalCandidateSince = null;
    this.stabilizationStartTime = null;
    this.prevFrame = null;
  }

  public markPartInspected() {
    this.hasInspectedCurrentPart = true;
  }

  public isAwaitingRemoval(): boolean {
    return this.hasInspectedCurrentPart;
  }

  /**
   * Check small tiles against the calibrated empty frame. Local tile scoring
   * makes a small object visible even when it changes only a small fraction
   * of the complete Detection Zone.
   */
  private detectLocalChange(
    current: GrayscaleImage,
    zone: Box2D
  ): { detected: boolean; score: number } {
    const baseline = this.baselineFrame;
    if (!baseline || baseline.width !== current.width || baseline.height !== current.height) {
      return { detected: false, score: 0 };
    }

    const x0 = Math.max(0, Math.floor(zone.x * current.width));
    const y0 = Math.max(0, Math.floor(zone.y * current.height));
    const x1 = Math.min(current.width, Math.ceil((zone.x + zone.width) * current.width));
    const y1 = Math.min(current.height, Math.ceil((zone.y + zone.height) * current.height));
    const zoneWidth = x1 - x0;
    const zoneHeight = y1 - y0;
    if (zoneWidth < 1 || zoneHeight < 1) return { detected: false, score: 0 };

    const columns = 16;
    const rows = 16;
    const tileWidth = Math.max(1, Math.ceil(zoneWidth / columns));
    const tileHeight = Math.max(1, Math.ceil(zoneHeight / rows));
    let strongestRatio = 0;
    let detected = false;

    for (let ty = y0; ty < y1; ty += tileHeight) {
      for (let tx = x0; tx < x1; tx += tileWidth) {
        const ex = Math.min(x1, tx + tileWidth);
        const ey = Math.min(y1, ty + tileHeight);
        let sampled = 0;
        let changed = 0;
        let changedMagnitude = 0;

        // Subsample every second pixel for a balance between sensitivity and CPU use.
        for (let y = ty; y < ey; y += 2) {
          const row = y * current.width;
          for (let x = tx; x < ex; x += 2) {
            const delta = Math.abs(current.data[row + x] - baseline.data[row + x]);
            sampled++;
            if (delta >= 18) {
              changed++;
              changedMagnitude += delta;
            }
          }
        }

        if (sampled === 0 || changed === 0) continue;
        const changedRatio = changed / sampled;
        strongestRatio = Math.max(strongestRatio, changedRatio);
        const meanChangedMagnitude = changedMagnitude / changed;

        // A compact cluster of meaningful pixel changes is stronger evidence
        // than scattered single-pixel noise across the whole image.
        if (changedRatio >= 0.035 && meanChangedMagnitude >= 18) {
          detected = true;
        }
      }
    }

    return { detected, score: Math.min(100, Math.round(strongestRatio * 100)) };
  }

  public processFrame(
    currentFrame: GrayscaleImage,
    detectionZone: Box2D,
    tolerance: ToleranceConfig,
    now: number = Date.now()
  ): PresenceState {
    const rx = detectionZone.x * currentFrame.width;
    const ry = detectionZone.y * currentFrame.height;
    const rw = detectionZone.width * currentFrame.width;
    const rh = detectionZone.height * currentFrame.height;
    const stats = getRegionStats(currentFrame, rx, ry, rw, rh);
    const motion = calculateMotionDelta(currentFrame, this.prevFrame, detectionZone);
    this.prevFrame = currentFrame;

    let diff = 0;
    if (this.baselineStats) {
      const meanDiff = Math.abs(stats.mean - this.baselineStats.mean);
      const varDiff = Math.abs(Math.sqrt(stats.variance) - Math.sqrt(this.baselineStats.variance));
      diff = meanDiff * 0.7 + varDiff * 0.8;
    } else {
      diff = Math.sqrt(stats.variance);
    }

    const localChange = this.detectLocalChange(currentFrame, detectionZone);
    const presenceThreshold = tolerance.detectionZonePresenceThreshold || 18.0;
    const removalThreshold = tolerance.partRemovalThreshold || 12.0;
    const presenceEvidence = diff > presenceThreshold || localChange.detected;

    if (!this.isCurrentlyPresent) {
      if (presenceEvidence) {
        this.isCurrentlyPresent = true;
        this.stabilizationStartTime = now;
        this.removalCandidateSince = null;
      }
    } else {
      // Keep the judgement latched until both aggregate and local evidence
      // indicate that the workpiece has left the zone continuously.
      const removalEvidence = diff < removalThreshold && !localChange.detected;
      if (removalEvidence) {
        const removalDebounceMs = 400;
        if (this.removalCandidateSince === null) {
          this.removalCandidateSince = now;
        } else if (now - this.removalCandidateSince >= removalDebounceMs) {
          this.isCurrentlyPresent = false;
          this.hasInspectedCurrentPart = false;
          this.removalCandidateSince = null;
          this.stabilizationStartTime = null;
        }
      } else {
        this.removalCandidateSince = null;
      }
    }

    const motionLimit = tolerance.stabilizationMotionThreshold || 8.0;
    const requiredDelay = tolerance.stabilizationDelayMs || 500;
    let isStabilized = false;
    let progress = 0;

    if (this.isCurrentlyPresent && !this.hasInspectedCurrentPart) {
      if (motion > motionLimit) {
        this.stabilizationStartTime = now;
        progress = 0;
      } else {
        if (this.stabilizationStartTime === null) this.stabilizationStartTime = now;
        const elapsed = now - this.stabilizationStartTime;
        progress = Math.min(1, elapsed / requiredDelay);
        if (elapsed >= requiredDelay) isStabilized = true;
      }
    }

    return {
      isPartPresent: this.isCurrentlyPresent,
      presenceScore: Math.min(100, Math.max(Math.round(diff * 2), localChange.detected ? 65 : localChange.score * 2)),
      motionDelta: Math.round(motion * 10) / 10,
      isStabilized,
      stabilizationProgress: progress,
    };
  }
}
