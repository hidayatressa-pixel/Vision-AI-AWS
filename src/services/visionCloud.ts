import { getSupabaseAccessToken, getVisionApiBaseUrl } from './supabase';

const VISION_API_URL = getVisionApiBaseUrl();
const VISION_STATION_ID = String(import.meta.env.VITE_VISION_STATION_ID || 'VISION-AI-AWS').trim();
const REQUEST_TIMEOUT_MS = 8000;

export interface VisionCloudEvent {
  status: 'OK' | 'NG' | 'INVALID' | 'ERROR' | 'STANDBY';
  confidence: number;
  mode: 'CONTINUOUS';
  jig: string;
  stationId?: string;
  masterId?: string;
  masterRevisionId?: string;
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

async function postAuthenticated(path: string, payload: unknown): Promise<Response> {
  if (!VISION_API_URL) {
    throw new Error('Vision backend is not configured. Set VITE_VISION_API_URL.');
  }

  const token = await getSupabaseAccessToken();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${VISION_API_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Vision backend request timed out after 8 seconds.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function sendVisionEvent(event: VisionCloudEvent): Promise<void> {
  if (!VISION_API_URL) return;
  try {
    const response = await postAuthenticated('/v1/events', event);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Vision backend rejected event (HTTP ${response.status}): ${body}`);
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
  masterId: string;
  masterRevisionId: string;
  inspectionId: string;
  productCode: string;
  revisionCode: string;
  detectedCount: number;
  expectedCount: number;
  reason: string;
}): void {
  const confidenceValues = [
    clampConfidence(params.alignmentConfidence),
    ...params.roiConfidences.filter(Number.isFinite).map(clampConfidence),
  ];
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : 0;

  void sendVisionEvent({
    status: params.status,
    confidence: Number(confidence.toFixed(3)),
    mode: 'CONTINUOUS',
    jig: params.jig,
    stationId: VISION_STATION_ID,
    masterId: params.masterId,
    masterRevisionId: params.masterRevisionId,
    inspectionId: params.inspectionId,
    timestamp: new Date().toISOString(),
    productCode: params.productCode,
    revisionCode: params.revisionCode,
    detectedCount: params.detectedCount,
    expectedCount: params.expectedCount,
    reason: params.reason,
  });
}

export function sendStandbyEvent(jig: string): void {
  if (lastLifecycleStatus === 'STANDBY') return;
  lastLifecycleStatus = 'STANDBY';
  void sendVisionEvent({
    status: 'STANDBY',
    confidence: 1,
    mode: 'CONTINUOUS',
    jig,
    stationId: VISION_STATION_ID,
    timestamp: new Date().toISOString(),
  });
}

export function markInspectionLifecycleComplete(status: 'OK' | 'NG' | 'INVALID' | 'ERROR'): void {
  lastLifecycleStatus = status;
}

export interface VisionSessionContext {
  productCode: string;
  revisionCode: string;
  masterId: string;
  masterRevisionId: string;
}

export async function activateVisionSession(context: VisionSessionContext): Promise<void> {
  const response = await postAuthenticated('/v1/sessions', {
    action: 'START_SESSION',
    context: { ...context, stationId: VISION_STATION_ID },
    timestamp: new Date().toISOString(),
  });
  if (!response.ok) {
    throw new Error(`Vision backend session activation rejected (HTTP ${response.status}).`);
  }
  const result = await response.json().catch(() => null) as { accepted?: boolean; success?: boolean; message?: string } | null;
  if (!result || result.accepted !== true || result.success !== true) {
    throw new Error(result?.message || 'Vision backend did not confirm session activation.');
  }
}

export async function endVisionSession(context: VisionSessionContext): Promise<void> {
  const response = await postAuthenticated('/v1/sessions', {
    action: 'END_SESSION',
    context: { ...context, stationId: VISION_STATION_ID },
    timestamp: new Date().toISOString(),
  });
  if (!response.ok) {
    throw new Error(`Vision backend session end rejected (HTTP ${response.status}).`);
  }
  const result = await response.json().catch(() => null) as { accepted?: boolean; success?: boolean; message?: string } | null;
  if (!result || result.accepted !== true || result.success !== true) {
    throw new Error(result?.message || 'Vision backend did not confirm session end.');
  }
}

export async function saveConfigurationToVisionBackend(configuration: {
  setupStep: number;
  camera: { sourceMode: string; selectedDeviceId: string };
  master: unknown;
  revision: unknown;
  savedAt: string;
}): Promise<void> {
  const response = await postAuthenticated('/v1/configurations', {
    action: 'SAVE_CONFIGURATION',
    configuration: { ...configuration, stationId: VISION_STATION_ID },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Vision configuration save failed (HTTP ${response.status}): ${body}`);
  }
  const result = await response.json().catch(() => null) as { saved?: boolean; success?: boolean; message?: string } | null;
  if (!result || result.saved !== true || result.success !== true) {
    throw new Error(result?.message || 'Vision backend did not confirm configuration save.');
  }
}
