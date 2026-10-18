import type { MasterRevision } from '../types/master';

const CONFIG_API_URL = String(import.meta.env.VITE_VISION_CONFIG_API_URL || '').trim();

function endpointFor(path: 'analyze' | 'inspection-result'): string {
  if (!CONFIG_API_URL) {
    throw new Error('AWS API is not configured. Set VITE_VISION_CONFIG_API_URL to the deployed /Prod/config endpoint.');
  }
  const url = new URL(CONFIG_API_URL);
  if (!url.pathname.endsWith('/config')) {
    throw new Error('VITE_VISION_CONFIG_API_URL must point to the /config route of the same Vision Analyzer API.');
  }
  url.pathname = url.pathname.slice(0, -'config'.length) + path;
  return url.toString();
}

export interface VisionCloudEvent {
  status: 'OK' | 'NG' | 'INVALID' | 'ERROR' | 'STANDBY';
  confidence: number;
  mode: 'CONTINUOUS';
  jig: string;
  inspectionId?: string;
  timestamp: string;
  productCode?: string;
  revisionCode?: string;
  detectedCount?: number;
  expectedCount?: number;
  reason?: string;
}

let lastLifecycleStatus: VisionCloudEvent['status'] | null = null;

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export async function sendVisionEvent(event: VisionCloudEvent): Promise<void> {
  const response = await postJsonWithTimeout(endpointFor('inspection-result'), {
    action: 'STORE_INSPECTION_RESULT',
    decisionSource: 'browser_rule_engine',
    event,
  });
  if (!response.ok) {
    throw new Error(`AWS inspection event rejected (HTTP ${response.status}).`);
  }
  const result = await response.json().catch(() => null) as { accepted?: boolean; success?: boolean; message?: string } | null;
  if (!result || result.accepted !== true || result.success !== true) {
    throw new Error(result?.message || 'AWS did not confirm inspection event storage.');
  }
}

function loadReferencePatch(imageUrl: string, layout: { x: number; y: number; width: number; height: number }): Promise<string | null> {
  return new Promise((resolve) => {
    if (!imageUrl) return resolve(null);
    const image = new Image();
    if (!imageUrl.startsWith('data:')) image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const left = Math.max(0, Math.min(1, layout.x)) * image.naturalWidth;
        const top = Math.max(0, Math.min(1, layout.y)) * image.naturalHeight;
        const width = Math.max(0.02, Math.min(1, layout.width)) * image.naturalWidth;
        const height = Math.max(0.02, Math.min(1, layout.height)) * image.naturalHeight;
        if (left + width > image.naturalWidth || top + height > image.naturalHeight) return resolve(null);
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        if (!context) return resolve(null);
        context.drawImage(image, left, top, width, height, 0, 0, 64, 64);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
        resolve(dataUrl.substring(dataUrl.indexOf(',') + 1) || null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = imageUrl;
  });
}

async function buildAwsInspectionConfig(revision: MasterRevision): Promise<Record<string, unknown>> {
  const rois = await Promise.all(revision.inspectionROIs.map(async (roi) => {
    const width = Math.max(0.02, Math.min(1, roi.width ?? roi.radius * 2));
    const height = Math.max(0.02, Math.min(1, roi.height ?? roi.radius * 2));
    const fallback = {
      x: Math.max(0, Math.min(1 - width, roi.x - width / 2)),
      y: Math.max(0, Math.min(1 - height, roi.y - height / 2)),
      width,
      height,
    };
    const references = await Promise.all((revision.referenceImages || []).map(async (reference) => {
      const layout = reference.roiLayouts?.[roi.id] || fallback;
      const patchBase64 = await loadReferencePatch(reference.imageUrl, layout);
      return patchBase64 ? {
        kind: reference.kind || 'OK',
        label: reference.label,
        patch_base64: patchBase64,
      } : null;
    }));
    return {
      id: roi.id,
      name: roi.name,
      x: roi.x,
      y: roi.y,
      width,
      height,
      minConfidence: roi.minConfidence || 0.75,
      comparisonMode: roi.comparisonMode || 'BALANCED',
      references: references.filter((item): item is NonNullable<typeof item> => item !== null),
    };
  }));
  return { rois };
}

export async function analyzeFrameOnAws(frame: ImageData, revision: MasterRevision): Promise<Record<string, unknown>> {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1280 / frame.width, 720 / frame.height);
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare the captured frame for AWS analysis.');
  const source = document.createElement('canvas');
  source.width = frame.width;
  source.height = frame.height;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('Could not read the captured frame for AWS analysis.');
  sourceContext.putImageData(frame, 0, 0);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
  const imageBase64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
  if (!imageBase64) throw new Error('Captured frame encoding returned empty data.');

  const inspectionConfig = await buildAwsInspectionConfig(revision);
  const response = await postJsonWithTimeout(endpointFor('analyze'), {
    image_base64: imageBase64,
    inspection_config: inspectionConfig,
  });
  if (!response.ok) throw new Error(`AWS OpenCV inspection failed (HTTP ${response.status}).`);
  const analysis = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!analysis || typeof analysis.opencv_version !== 'string' ||
      !['OK', 'NG', 'INVALID', 'ERROR'].includes(String(analysis.judgement)) ||
      !Array.isArray(analysis.roi_results)) {
    throw new Error('AWS OpenCV response lacks a validated product judgement and ROI evidence.');
  }
  return analysis;
}

export async function sendInspectionResult(params: {
  status: 'OK' | 'NG' | 'INVALID' | 'ERROR';
  alignmentConfidence: number;
  roiConfidences: number[];
  jig: string;
  inspectionId: string;
  productCode: string;
  revisionCode: string;
  detectedCount: number;
  expectedCount: number;
  reason: string;
  browserJudgement: 'OK' | 'NG' | 'INVALID' | 'ERROR';
  browserReason: string;
  opencvAnalysis: Record<string, unknown> | null;
  analysisError?: string;
}): Promise<{ evidenceKey: string }> {
  const roiValues = params.roiConfidences.filter(Number.isFinite);
  const confidenceValues = [clampConfidence(params.alignmentConfidence), ...roiValues.map(clampConfidence)];
  const confidence = confidenceValues.reduce((sum, value) => sum + value, 0) /
    Math.max(1, confidenceValues.length);
  const event: VisionCloudEvent = {
    status: params.status,
    confidence: Number(confidence.toFixed(3)),
    mode: 'CONTINUOUS',
    jig: params.jig,
    inspectionId: params.inspectionId,
    timestamp: new Date().toISOString(),
    productCode: params.productCode,
    revisionCode: params.revisionCode,
    detectedCount: params.detectedCount,
    expectedCount: params.expectedCount,
    reason: params.reason,
  };
  const response = await postJsonWithTimeout(endpointFor('inspection-result'), {
    action: 'STORE_INSPECTION_RESULT',
    decisionSource: params.opencvAnalysis ? 'aws_opencv_roi_reference_crosschecked_with_browser' : 'aws_analysis_failed_fail_safe',
    event,
    browserDecision: { judgement: params.browserJudgement, reason: params.browserReason },
    opencvAnalysis: params.opencvAnalysis,
    analysisError: params.analysisError || null,
  });
  if (!response.ok) throw new Error(`AWS evidence storage failed (HTTP ${response.status}).`);
  const stored = await response.json().catch(() => null) as {
    accepted?: boolean; success?: boolean; key?: string; message?: string;
  } | null;
  if (!stored || stored.accepted !== true || stored.success !== true || !stored.key) {
    throw new Error(stored?.message || 'AWS did not confirm inspection evidence storage.');
  }
  return { evidenceKey: stored.key };
}

export function sendStandbyEvent(jig: string): void {
  if (lastLifecycleStatus === 'STANDBY') return;

  lastLifecycleStatus = 'STANDBY';

  void sendVisionEvent({
    status: 'STANDBY',
    confidence: 1,
    mode: 'CONTINUOUS',
    jig,
    timestamp: new Date().toISOString(),
  }).catch((error) => {
    console.error('[VisionCloud] Standby event was not confirmed:', error);
  });
}

export function markInspectionLifecycleComplete(status: 'OK' | 'NG' | 'INVALID' | 'ERROR'): void {
  lastLifecycleStatus = status;
}


export interface AwsSessionContext {
  productCode: string;
  revisionCode: string;
}

const REQUEST_TIMEOUT_MS = 8000;
const SESSION_API_URL = String(import.meta.env.VITE_VISION_SESSION_API_URL || '').trim();

async function postJsonWithTimeout(url: string, payload: unknown): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('AWS request timed out after 8 seconds.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/**
 * Sends an explicit lifecycle event to the currently configured Vision API.
 * HTTP success confirms that the endpoint accepted the event; it does not
 * claim that a separate cloud worker is running unless the backend says so.
 */
export async function activateAwsSession(context: AwsSessionContext): Promise<void> {
  if (!SESSION_API_URL) {
    throw new Error('AWS session API is not configured. Set VITE_VISION_SESSION_API_URL to the deployed /Prod/session endpoint.');
  }
  const response = await postJsonWithTimeout(SESSION_API_URL, {
    action: 'START_SESSION',
    context: { ...context, stationId: 'VISION-AI-AWS' },
    timestamp: new Date().toISOString(),
  });
  if (!response.ok) {
    throw new Error(`AWS session activation request rejected (HTTP ${response.status}).`);
  }
  const result = await response.json().catch(() => null) as { accepted?: boolean; success?: boolean; message?: string } | null;
  if (!result || result.accepted !== true || result.success !== true) {
    throw new Error(result?.message || 'AWS did not confirm session activation.');
  }
}

export async function endAwsSession(context: AwsSessionContext): Promise<void> {
  if (!SESSION_API_URL) {
    throw new Error('AWS session API is not configured. Set VITE_VISION_SESSION_API_URL to the deployed /Prod/session endpoint.');
  }
  const response = await postJsonWithTimeout(SESSION_API_URL, {
    action: 'END_SESSION',
    context: { ...context, stationId: 'VISION-AI-AWS' },
    timestamp: new Date().toISOString(),
  });
  if (!response.ok) {
    throw new Error(`AWS session end request rejected (HTTP ${response.status}).`);
  }
  const result = await response.json().catch(() => null) as { accepted?: boolean; success?: boolean; message?: string } | null;
  if (!result || result.accepted !== true || result.success !== true) {
    throw new Error(result?.message || 'AWS did not confirm session end.');
  }
}

export async function saveConfigurationToAws(configuration: {
  setupStep: number;
  camera: { sourceMode: string; selectedDeviceId: string };
  master: unknown;
  revision: unknown;
  savedAt: string;
}): Promise<void> {
  const configUrl = CONFIG_API_URL;
  if (!configUrl) {
    throw new Error(
      'AWS configuration storage is not configured. Set VITE_VISION_CONFIG_API_URL to the deployed configuration API endpoint.'
    );
  }

  const response = await postJsonWithTimeout(configUrl, {
    action: 'SAVE_CONFIGURATION',
    configuration,
  });
  if (!response.ok) {
    throw new Error(`AWS configuration save failed (HTTP ${response.status}).`);
  }

  const result = await response.json().catch(() => null) as { saved?: boolean; success?: boolean; message?: string } | null;
  if (!result || result.saved !== true || result.success !== true) {
    throw new Error(result?.message || 'AWS configuration API did not confirm the save.');
  }
}
