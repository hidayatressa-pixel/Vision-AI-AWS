/**
 * Alignment Engine
 *
 * Calculates a similarity transform:
 *   Target = Scale * Rotation * Source + Translation
 *
 * Coordinates used by the alignment system are absolute frame pixels.
 */

import { AlignmentResult } from '../types/inspection';
import { Position2D, ReferenceAnchor, ToleranceConfig } from '../types/master';
import { GrayscaleImage, sobelEdges } from './imageUtils';

export class AlignmentEngine {
  public calculateAlignment(
    frame: GrayscaleImage,
    masterWidth: number,
    masterHeight: number,
    anchors: ReferenceAnchor[],
    tolerance: ToleranceConfig
  ): AlignmentResult {
    const startTime = performance.now();

    if (frame.width <= 0 || frame.height <= 0) {
      return {
        success: false, translationX: 0, translationY: 0, rotationDeg: 0,
        scale: 1, confidence: 0, matchedAnchorCount: 0,
        totalAnchorCount: anchors.length, anchorPositions: [],
        errorMessage: 'Invalid camera frame dimensions',
      };
    }

    // For production safety, every configured fiducial must be confirmed.
    // A 3-of-4 transform can still be mathematically valid while one anchor
    // is wrong or missing, which could shift every downstream ROI incorrectly.
    if (anchors.length < 3) {
      return {
        success: false, translationX: 0, translationY: 0, rotationDeg: 0,
        scale: 1, confidence: 0, matchedAnchorCount: 0,
        totalAnchorCount: anchors.length, anchorPositions: [],
        errorMessage: `At least 3 reference anchors are required (${anchors.length} configured)`,
      };
    }

    if (!Number.isFinite(masterWidth) || !Number.isFinite(masterHeight) || masterWidth <= 0 || masterHeight <= 0) {
      return {
        success: false, translationX: 0, translationY: 0, rotationDeg: 0,
        scale: 1, confidence: 0, matchedAnchorCount: 0,
        totalAnchorCount: anchors.length, anchorPositions: [],
        errorMessage: 'Invalid master dimensions',
      };
    }

    const anchorIds = new Set(anchors.map((anchor) => anchor.id));
    const anchorsWellFormed = anchorIds.size === anchors.length && anchors.every((anchor) =>
      Boolean(anchor.id?.trim()) &&
      Number.isFinite(anchor.x) && anchor.x >= 0 && anchor.x <= 1 &&
      Number.isFinite(anchor.y) && anchor.y >= 0 && anchor.y <= 1 &&
      Number.isFinite(anchor.searchRadius) && anchor.searchRadius > 0 &&
      Number.isFinite(anchor.patchRadius) && anchor.patchRadius > 0
    );
    const nonCollinear = anchors.some((a, i) =>
      anchors.some((b, j) => j > i && anchors.some((d, k) => k > j &&
        Math.abs((b.x - a.x) * (d.y - a.y) - (d.x - a.x) * (b.y - a.y)) > 0.0005))
    );
    if (!anchorsWellFormed || !nonCollinear) {
      return {
        success: false, translationX: 0, translationY: 0, rotationDeg: 0,
        scale: 1, confidence: 0, matchedAnchorCount: 0,
        totalAnchorCount: anchors.length, anchorPositions: [],
        errorMessage: 'Reference anchors must be unique, valid, and non-collinear',
      };
    }

    const edges = sobelEdges(frame);

    type AnchorMatch = {
      id: string;
      expected: Position2D;
      found: Position2D;
      confidence: number;
    };

    const findMatches = (
      centers?: Map<string, Position2D>,
      radiusMultiplier = 1
    ): AnchorMatch[] => {
      const matches: AnchorMatch[] = [];

      for (const anchor of anchors) {
        const expected = this.mapMasterPointToFrame({ x: anchor.x, y: anchor.y }, frame.width, frame.height, masterWidth, masterHeight);

        // First pass uses the configured master location. After a provisional
        // transform exists, a second pass searches around the transformed
        // location. This is important when a new part is placed off-center:
        // the first coarse match only needs to find the fiducials, then the
        // refinement follows the actual part position.
        const center = centers?.get(anchor.id) || expected;
        const radius = Math.max(
          15,
          anchor.searchRadius * Math.min(frame.width, frame.height) * radiusMultiplier
        );

        const x0 = Math.max(0, Math.floor(center.x - radius));
        const y0 = Math.max(0, Math.floor(center.y - radius));
        const x1 = Math.min(frame.width - 1, Math.ceil(center.x + radius));
        const y1 = Math.min(frame.height - 1, Math.ceil(center.y + radius));

        const found = this.locateAnchorFeature(
          frame, edges, center.x, center.y, x0, y0, x1, y1, anchor.patchRadius
        );

        if (found.confidence >= 0.35) {
          matches.push({
            id: anchor.id,
            expected,
            found: { x: found.x, y: found.y },
            confidence: found.confidence,
          });
        }
      }

      return matches;
    };

    let matchedAnchors = findMatches();

    // Coarse alignment is followed by a tighter, transform-guided search.
    // This prevents the detector from remaining biased toward the old camera
    // position when the previous product was removed and another one is placed
    // at a different position in the fixture. All configured anchors must
    // survive refinement; losing one is an alignment failure, not a best-effort fit.
    if (matchedAnchors.length >= 3) {
      const provisional = this.fitSimilarityTransform(matchedAnchors);
      if (provisional) {
        const predictedCenters = new Map<string, Position2D>();
        for (const anchor of anchors) {
          const expected = this.mapMasterPointToFrame({ x: anchor.x, y: anchor.y }, frame.width, frame.height, masterWidth, masterHeight)
          predictedCenters.set(anchor.id, this.applyTransform(expected, provisional));
        }

        const refined = findMatches(predictedCenters, 0.55);
        if (refined.length >= 3) {
          matchedAnchors = refined;
        }
      }
    }

    if (matchedAnchors.length < anchors.length) {
      return {
        success: false, translationX: 0, translationY: 0, rotationDeg: 0,
        scale: 1,
        confidence: matchedAnchors.length > 0 ? matchedAnchors[0].confidence : 0,
        matchedAnchorCount: matchedAnchors.length,
        totalAnchorCount: anchors.length,
        anchorPositions: matchedAnchors,
        errorMessage: `Reference anchors not detected (${matchedAnchors.length}/${anchors.length} found)`,
      };
    }

    const fitted = this.fitSimilarityTransform(matchedAnchors);
    if (!fitted) {
      return {
        success: false, translationX: 0, translationY: 0, rotationDeg: 0,
        scale: 1, confidence: 0,
        matchedAnchorCount: matchedAnchors.length,
        totalAnchorCount: anchors.length,
        anchorPositions: matchedAnchors,
        errorMessage: 'Reference anchors are geometrically degenerate',
      };
    }

    const {
      rotationDeg,
      scale,
      translationX,
      translationY,
    } = fitted;

    let squaredResidual = 0;

    for (const match of matchedAnchors) {
      const predicted = this.applyTransform(match.expected, fitted);
      squaredResidual += Math.hypot(
        predicted.x - match.found.x,
        predicted.y - match.found.y
      ) ** 2;
    }

    const rmsResidual = Math.sqrt(
      squaredResidual / matchedAnchors.length
    );

    const meanConfidence =
      matchedAnchors.reduce((sum, anchor) => sum + anchor.confidence, 0) /
      matchedAnchors.length;

    const maxRotation = tolerance.maxRotationToleranceDeg ?? 15;
    const minConfidence = tolerance.minAlignmentConfidence ?? 0.55;

    const minScale = tolerance.minScale ?? 0.80;
    const maxScale = tolerance.maxScale ?? 1.20;
    const maxResidualPx = tolerance.maxAlignmentResidualPx ??
      Math.max(tolerance.maxPositionOffsetPx * 2, 10);

    const rotationOk = toleranceConfigValid && Math.abs(rotationDeg) <= maxRotation;
    const confidenceOk = toleranceConfigValid && meanConfidence >= minConfidence;
    const scaleOk = toleranceConfigValid && scale >= minScale && scale <= maxScale;
    const toleranceConfigValid = Number.isFinite(maxRotation) && maxRotation >= 0 && maxRotation <= 45 &&
      Number.isFinite(minConfidence) && minConfidence >= 0 && minConfidence <= 1 &&
      Number.isFinite(minScale) && minScale > 0 && Number.isFinite(maxScale) && maxScale >= minScale &&
      Number.isFinite(maxResidualPx) && maxResidualPx > 0;
    const residualOk = toleranceConfigValid && rmsResidual <= maxResidualPx;
    const success = rotationOk && confidenceOk && scaleOk && residualOk;

    let errorMessage: string | undefined;

    if (!toleranceConfigValid) {
      errorMessage = 'Alignment tolerance configuration is invalid';
    } else if (!rotationOk) {
      errorMessage =
        `Product rotation (${rotationDeg.toFixed(1)}°) exceeds tolerance (±${maxRotation}°)`;
    } else if (!scaleOk) {
      errorMessage =
        `Alignment scale (${scale.toFixed(3)}) is outside allowed range (${minScale.toFixed(2)} - ${maxScale.toFixed(2)})`;
    } else if (!confidenceOk) {
      errorMessage =
        `Alignment confidence (${(meanConfidence * 100).toFixed(0)}%) below threshold (${(minConfidence * 100).toFixed(0)}%)`;
    } else if (!residualOk) {
      errorMessage =
        `Anchor residual error (${rmsResidual.toFixed(1)}px) exceeds limit (${maxResidualPx.toFixed(1)}px)`;
    }

    void (performance.now() - startTime);

    return {
      success,
      translationX: Math.round(translationX * 100) / 100,
      translationY: Math.round(translationY * 100) / 100,
      rotationDeg: Math.round(rotationDeg * 100) / 100,
      scale: Math.round(scale * 1000) / 1000,
      confidence: Math.round(meanConfidence * 100) / 100,
      matchedAnchorCount: matchedAnchors.length,
      totalAnchorCount: anchors.length,
      anchorPositions: matchedAnchors,
      errorMessage,
    };
  }

  private fitSimilarityTransform(
    matches: Array<{ expected: Position2D; found: Position2D }>
  ): {
    rotationDeg: number;
    scale: number;
    translationX: number;
    translationY: number;
  } | null {
    if (matches.length < 2) return null;

    const n = matches.length;
    const sourceMean = matches.reduce(
      (acc, m) => ({ x: acc.x + m.expected.x / n, y: acc.y + m.expected.y / n }),
      { x: 0, y: 0 }
    );
    const targetMean = matches.reduce(
      (acc, m) => ({ x: acc.x + m.found.x / n, y: acc.y + m.found.y / n }),
      { x: 0, y: 0 }
    );

    let num = 0;
    let den = 0;
    let variance = 0;

    for (const match of matches) {
      const sx = match.expected.x - sourceMean.x;
      const sy = match.expected.y - sourceMean.y;
      const dx = match.found.x - targetMean.x;
      const dy = match.found.y - targetMean.y;
      num += sx * dy - sy * dx;
      den += sx * dx + sy * dy;
      variance += sx * sx + sy * sy;
    }

    if (variance <= 1e-6) return null;

    const angle = Math.atan2(num, den);
    const scale = Math.sqrt(den * den + num * num) / variance;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    return {
      rotationDeg: (angle * 180) / Math.PI,
      scale,
      translationX: targetMean.x - scale * (cosA * sourceMean.x - sinA * sourceMean.y),
      translationY: targetMean.y - scale * (sinA * sourceMean.x + cosA * sourceMean.y),
    };
  }

  private applyTransform(
    point: Position2D,
    transform: { rotationDeg: number; scale: number; translationX: number; translationY: number }
  ): Position2D {
    const rad = (transform.rotationDeg * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);

    return {
      x: transform.scale * (cosA * point.x - sinA * point.y) + transform.translationX,
      y: transform.scale * (sinA * point.x + cosA * point.y) + transform.translationY,
    };
  }

  private locateAnchorFeature(
    frame: GrayscaleImage,
    edges: GrayscaleImage,
    expX: number,
    expY: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    configuredPatchRadius?: number
  ): { x: number; y: number; confidence: number } {
    let bestX = expX;
    let bestY = expY;
    let maxScore = -1;

    const step = 2;
    const patchRadius = Math.max(
      4,
      Math.min(20, Math.round(configuredPatchRadius || 10))
    );

    const safeX0 = Math.max(x0, patchRadius);
    const safeY0 = Math.max(y0, patchRadius);
    const safeX1 = Math.min(x1, frame.width - patchRadius - 1);
    const safeY1 = Math.min(y1, frame.height - patchRadius - 1);

    for (let y = safeY0; y <= safeY1; y += step) {
      const row = y * frame.width;

      for (let x = safeX0; x <= safeX1; x += step) {
        let horizontalGradient = 0;
        let verticalGradient = 0;

        for (let d = -patchRadius; d <= patchRadius; d++) {
          verticalGradient += edges.data[(y + d) * frame.width + x];
          horizontalGradient += edges.data[row + x + d];
        }

        const totalGradient = horizontalGradient + verticalGradient;
        if (totalGradient <= 0) continue;

        const crossStrength =
          (Math.min(horizontalGradient, verticalGradient) * 2) /
          (totalGradient + 1e-4);

        const distanceFromExpected = Math.hypot(x - expX, y - expY);
        const searchWidth = Math.max(1, x1 - x0);
        const distancePenalty = Math.max(
          0,
          1 - distanceFromExpected / (searchWidth + 1)
        );

        const score = totalGradient * crossStrength * distancePenalty;

        if (score > maxScore) {
          maxScore = score;
          bestX = x;
          bestY = y;
        }
      }
    }

    const confidence =
      maxScore > 200
        ? Math.min(0.98, 0.4 + maxScore / 2500)
        : 0.3;

    return { x: bestX, y: bestY, confidence };
  }

  private mapMasterPointToFrame(
    masterPoint: Position2D,
    frameWidth: number,
    frameHeight: number,
    masterWidth: number,
    masterHeight: number
  ): Position2D {
    const safeMasterWidth = Math.max(1, masterWidth);
    const safeMasterHeight = Math.max(1, masterHeight);
    const containScale = Math.min(frameWidth / safeMasterWidth, frameHeight / safeMasterHeight);
    const renderedWidth = safeMasterWidth * containScale;
    const renderedHeight = safeMasterHeight * containScale;
    const offsetX = (frameWidth - renderedWidth) / 2;
    const offsetY = (frameHeight - renderedHeight) / 2;

    return {
      x: offsetX + masterPoint.x * renderedWidth,
      y: offsetY + masterPoint.y * renderedHeight,
    };
  }

  public transformMasterPoint(
    masterPoint: Position2D,
    frameWidth: number,
    frameHeight: number,
    alignment: AlignmentResult,
    masterWidth = frameWidth,
    masterHeight = frameHeight
  ): Position2D {
    // Map the normalized master point through the actual master aspect ratio
    // before applying alignment. This is the key guard against the legacy
    // 800x600 stretch: a 16:9 master is never treated as a 4:3 image.
    const { x: sourceX, y: sourceY } = this.mapMasterPointToFrame(
      masterPoint,
      frameWidth,
      frameHeight,
      masterWidth,
      masterHeight
    );

    if (!alignment.success) {
      return { x: sourceX, y: sourceY };
    }

    const rad = (alignment.rotationDeg * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);

    const transformedX =
      alignment.scale * (cosA * sourceX - sinA * sourceY) +
      alignment.translationX;

    const transformedY =
      alignment.scale * (sinA * sourceX + cosA * sourceY) +
      alignment.translationY;

    return { x: transformedX, y: transformedY };
  }
}

export const alignmentEngine = new AlignmentEngine();
