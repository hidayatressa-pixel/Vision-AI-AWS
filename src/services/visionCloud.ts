const VISION_API_URL =
  'https://tfu0e7nbj0.execute-api.ap-southeast-2.amazonaws.com/default/vision-ai-backend';

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
  try {
    const response = await fetch(VISION_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      throw new Error(`Vision API returned HTTP ${response.status}`);
    }
  } catch (error) {
    console.error('[VisionCloud] Event send failed:', error);
  }
}

export function sendInspectionResult(params: {
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
}): void {
  const roiValues = params.roiConfidences.filter(Number.isFinite);
  const confidenceValues = [
    clampConfidence(params.alignmentConfidence),
    ...roiValues.map(clampConfidence),
  ];
  const confidence =
    confidenceValues.length > 0
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : 0;

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

  void sendVisionEvent(event);
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
  const configUrl = String(import.meta.env.VITE_VISION_CONFIG_API_URL || '').trim();
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
