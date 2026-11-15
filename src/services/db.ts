/**
 * Persistence service for Vision-AI.
 *
 * Master configuration remains local to the station for now. Inspection history
 * is cloud-first and is stored in Supabase/PostgREST so every device sees the
 * same history. No service-role key is ever used in the browser.
 */

import { InspectionRecord, InspectionStats } from '../types/inspection';
import { MasterProduct } from '../types/master';
import { getSupabaseAccessToken, getVisionApiBaseUrl, supabase } from './supabase';

const VISION_API_URL = getVisionApiBaseUrl();
const VISION_STATION_ID = String(import.meta.env.VITE_VISION_STATION_ID || 'VISION-AI-AWS').trim();
const MASTER_BUCKET = 'vision-assets';

class DatabaseService {
  private getHistoryApiUrl(): string {
    if (!VISION_API_URL) {
      throw new Error('Vision backend is not configured. Set VITE_VISION_API_URL.');
    }
    return `${VISION_API_URL}/v1/inspection-history`;
  }

  private async requestEndpoint<T = unknown>(endpoint: string, init: RequestInit = {}): Promise<T> {
    if (!VISION_API_URL) throw new Error('Vision backend is not configured. Set VITE_VISION_API_URL.');
    const token = await getSupabaseAccessToken();
    const response = await fetch(VISION_API_URL + endpoint, {
      ...init,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...init.headers },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error('Vision backend error ' + response.status + ': ' + (body || response.statusText));
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private knownMasterIds = new Set<string>();
  private migrationAttempted = false;

  public getStationId(): string { return VISION_STATION_ID; }

  public async getCurrentUserRole(): Promise<'OPERATOR' | 'ENGINEER' | 'APPROVER' | 'ADMIN'> {
    const result = await this.requestEndpoint<{ role: 'OPERATOR' | 'ENGINEER' | 'APPROVER' | 'ADMIN' }>('/v1/me');
    return result.role;
  }

  private safePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'asset';
  }

  private async uploadMasterImage(masterId: string, revisionId: string, fileName: string, imageUrl: string, existingPath?: string): Promise<string> {
    if (!supabase) throw new Error('Supabase Storage is not configured.');
    const revisionPrefix = this.safePathSegment(masterId) + '/' + this.safePathSegment(revisionId) + '/';
    // New draft shells may be created before an image is selected; submission
    // validation will block them until all required Master assets are present.
    if (!imageUrl && !existingPath) return '';
    // Reuse an object only when it already belongs to this exact revision.
    // Cloned revisions must receive independent immutable asset paths.
    if (existingPath && existingPath.startsWith(revisionPrefix)) return existingPath;
    let sourceUrl = imageUrl;
    if (!sourceUrl && existingPath) sourceUrl = await this.signedAssetUrl(existingPath);
    if (!sourceUrl) throw new Error('Master image is missing. Upload or re-select the image before saving.');
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error('Unable to read the source Master image for this revision.');
    const blob = await response.blob();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) throw new Error('Master assets must be JPG, PNG, or WEBP images.');
    if (blob.size > 25 * 1024 * 1024) throw new Error('Master image exceeds the 25 MiB Storage limit.');
    const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/png' ? 'png' : 'webp';
    const objectPath = revisionPrefix + fileName + '.' + extension;
    const { error } = await supabase.storage.from(MASTER_BUCKET).upload(objectPath, blob, { contentType: blob.type, upsert: true });
    if (error) throw new Error('Master asset upload failed: ' + error.message);
    return objectPath;
  }

  private async signedAssetUrl(path?: string): Promise<string> {
    if (!path) return '';
    if (!supabase) throw new Error('Supabase Storage is not configured.');
    const { data, error } = await supabase.storage.from(MASTER_BUCKET).createSignedUrl(path, 86400);
    if (error || !data?.signedUrl) throw new Error('Unable to read approved Master asset: ' + (error?.message || 'signed URL unavailable'));
    return data.signedUrl;
  }

  private async materializeMaster(master: MasterProduct): Promise<MasterProduct> {
    const revisions = await Promise.all(master.revisions.map(async (revision) => ({
      ...revision,
      masterImageUrl: await this.signedAssetUrl(revision.masterImagePath),
      referenceImages: await Promise.all((revision.referenceImages || []).map(async (reference) => ({
        ...reference, imageUrl: await this.signedAssetUrl(reference.storagePath),
      }))),
    })));
    return { ...master, revisions };
  }

  private async getLegacyLocalMasters(): Promise<MasterProduct[]> {
    try {
      const stored = await this.runMasterTransaction<MasterProduct[]>('readonly', (store) => store.getAll());
      if (stored.length) return stored;
    } catch { /* Fall back to localStorage for older browsers. */ }
    return this.readFallbackMasters();
  }

  public async submitMasterRevision(masterId: string, revisionId: string): Promise<void> {
    await this.requestEndpoint('/v1/masters/' + encodeURIComponent(masterId) + '/revisions/' + encodeURIComponent(revisionId) + '/submit', { method: 'POST' });
  }

  public async approveMasterRevision(masterId: string, revisionId: string): Promise<void> {
    await this.requestEndpoint('/v1/masters/' + encodeURIComponent(masterId) + '/revisions/' + encodeURIComponent(revisionId) + '/approve', { method: 'POST' });
  }

  public async rejectMasterRevision(masterId: string, revisionId: string, reason: string): Promise<void> {
    await this.requestEndpoint('/v1/masters/' + encodeURIComponent(masterId) + '/revisions/' + encodeURIComponent(revisionId) + '/reject', { method: 'POST', body: JSON.stringify({ reason }) });
  }

  public async assignMasterRevision(masterId: string, revisionId: string): Promise<void> {
    await this.requestEndpoint('/v1/masters/' + encodeURIComponent(masterId) + '/revisions/' + encodeURIComponent(revisionId) + '/assign', {
      method: 'POST', body: JSON.stringify({ station_id: VISION_STATION_ID }),
    });
  }

  public async assignUserRole(userId: string, email: string, role: 'OPERATOR' | 'ENGINEER' | 'APPROVER' | 'ADMIN'): Promise<void> {
    await this.requestEndpoint('/v1/admin/users/' + encodeURIComponent(userId) + '/role', {
      method: 'POST', body: JSON.stringify({ email, role, is_active: true }),
    });
  }

  private async request<T = unknown>(path = '', init: RequestInit = {}): Promise<T> {
    const token = await getSupabaseAccessToken();
    const method = (init.method || 'GET').toUpperCase();
    const url = new URL(this.getHistoryApiUrl());
    if (method === 'GET' && path.startsWith('?')) {
      const requestedLimit = new URLSearchParams(path.slice(1)).get('limit');
      if (requestedLimit) url.searchParams.set('limit', requestedLimit);
    }

    const response = await fetch(url.toString(), {
      ...init,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Vision backend error ${response.status}: ${body || response.statusText}`);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // --- Master Operations ---
  // Master configuration is intentionally kept station-local until the
  // approved source-controlled master asset package is bundled.
  private masterCache = new Map<string, MasterProduct>();
  private readonly masterStorageKey = 'vision-ai-masters-v1';
  private readonly masterDbName = 'vision-ai-master-db';
  private readonly masterStoreName = 'masters';
  private masterDbPromise: Promise<IDBDatabase | null> | null = null;
  private readonly localHistoryKey = 'vision-ai-inspection-history';

  private openMasterDb(): Promise<IDBDatabase | null> {
    if (this.masterDbPromise) return this.masterDbPromise;
    this.masterDbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      try {
        const request = indexedDB.open(this.masterDbName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.masterStoreName)) {
            db.createObjectStore(this.masterStoreName, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.masterDbPromise;
  }

  private readFallbackMasters(): MasterProduct[] {
    try {
      const raw = localStorage.getItem(this.masterStorageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed as MasterProduct[] : [];
    } catch {
      return [];
    }
  }

  private writeFallbackMasters(): void {
    try {
      localStorage.setItem(this.masterStorageKey, JSON.stringify(Array.from(this.masterCache.values())));
    } catch (error) {
      throw new Error('Unable to persist master configuration in this browser. The master image or reference images may exceed local storage limits.', { cause: error });
    }
  }

  private async runMasterTransaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.openMasterDb();
    if (!db) throw new Error('IndexedDB is unavailable');
    return new Promise<T>((resolve, reject) => {
      try {
        const transaction = db.transaction(this.masterStoreName, mode);
        const request = operation(transaction.objectStore(this.masterStoreName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Master storage request failed'));
        transaction.onabort = () => reject(transaction.error || new Error('Master storage transaction aborted'));
      } catch (error) {
        reject(error);
      }
    });
  }

  public async getAllMasters(): Promise<MasterProduct[]> {
    const role = await this.getCurrentUserRole();
    const query = '?station_id=' + encodeURIComponent(VISION_STATION_ID);
    let cloud = await this.requestEndpoint<MasterProduct[]>('/v1/masters' + query);
    if (!this.migrationAttempted && (role === 'ENGINEER' || role === 'ADMIN')) {
      const legacy = await this.getLegacyLocalMasters();
      if (legacy.length) {
        this.migrationAttempted = true;
        this.knownMasterIds = new Set(cloud.map((master) => master.id));
        this.masterCache = new Map(cloud.map((master) => [master.id, master]));
        for (const localMaster of legacy) {
          const cloudMaster = cloud.find((master) => master.id === localMaster.id);
          if (!cloudMaster && cloud.some((master) => master.productCode === localMaster.productCode)) continue;
          for (const revision of localMaster.revisions) {
            if (cloudMaster?.revisions.some((item) => item.id === revision.id || item.revisionCode === revision.revisionCode)) continue;
            await this.saveMaster({ ...localMaster, revisions: [revision] });
          }
        }
        cloud = await this.requestEndpoint<MasterProduct[]>('/v1/masters' + query);
      }
    }
    const materialized = await Promise.all(cloud.map((master) => this.materializeMaster(master)));
    this.masterCache = new Map(materialized.map((master) => [master.id, master]));
    this.knownMasterIds = new Set(materialized.map((master) => master.id));
    return materialized;
  }

  public async getMasterById(id: string): Promise<MasterProduct | null> {
    const all = await this.getAllMasters();
    return all.find((master) => master.id === id) || null;
  }

  public async deleteMaster(_id: string): Promise<void> {
    throw new Error('Master deletion is disabled to preserve revision and inspection history.');
  }

  public async saveMaster(master: MasterProduct): Promise<void> {
    const previous = this.masterCache.get(master.id);
    const changed = master.revisions.filter((revision) =>
      !previous || !previous.revisions.some((old) => old.id === revision.id && JSON.stringify(old) === JSON.stringify(revision))
    );
    if (changed.length === 0 && this.knownMasterIds.has(master.id)) {
      await this.requestEndpoint('/v1/masters/' + encodeURIComponent(master.id), {
        method: 'PATCH',
        body: JSON.stringify({
          product_code: master.productCode,
          product_name: master.productName,
          description: master.description,
        }),
      });
      this.masterCache.set(master.id, master);
      return;
    }
    const revisionsToSave = changed;

    let isNew = !this.knownMasterIds.has(master.id);
    for (const revision of revisionsToSave) {
      const masterImagePath = await this.uploadMasterImage(
        master.id, revision.id, 'master-image', revision.masterImageUrl, revision.masterImagePath
      );
      const referenceImages = await Promise.all((revision.referenceImages || []).map(async (reference, index) => ({
        ...reference,
        storagePath: await this.uploadMasterImage(
          master.id, revision.id, 'reference-' + this.safePathSegment(reference.id || String(index + 1)),
          reference.imageUrl, reference.storagePath
        ),
        imageUrl: '',
      })));
      const storedRevision = {
        ...revision,
        masterImagePath,
        masterImageUrl: '',
        referenceImages,
        status: 'DRAFT' as const,
      };
      const body = JSON.stringify({
        master: {
          id: master.id, productCode: master.productCode, productName: master.productName,
          description: master.description, isActive: master.isActive,
        },
        revision: storedRevision,
      });
      if (isNew) {
        await this.requestEndpoint('/v1/masters', { method: 'POST', body });
        isNew = false;
        this.knownMasterIds.add(master.id);
      } else {
        await this.requestEndpoint(
          '/v1/masters/' + encodeURIComponent(master.id) + '/revisions/' + encodeURIComponent(revision.id),
          { method: 'PUT', body }
        );
      }
    }
    this.masterCache.set(master.id, {
      ...master,
      revisions: master.revisions.map((revision) => ({ ...revision, status: revision.status || 'DRAFT' })),
    });
  }

  // --- Cloud Inspection History ---
  private getLocalHistory(): InspectionRecord[] {
    try {
      const raw = localStorage.getItem(this.localHistoryKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveLocalHistory(record: InspectionRecord): void {
    try {
      const existing = this.getLocalHistory().filter((item) => item.id !== record.id);
      localStorage.setItem(this.localHistoryKey, JSON.stringify([record, ...existing].slice(0, 5000)));
    } catch (error) {
      console.warn('[DatabaseService] Local history save failed:', error);
    }
  }

  private removeLocalHistoryRecord(id: string): void {
    try {
      localStorage.setItem(this.localHistoryKey, JSON.stringify(this.getLocalHistory().filter((item) => item.id !== id)));
    } catch {}
  }

  private removeAllLocalHistory(): void {
    try { localStorage.removeItem(this.localHistoryKey); } catch {}
  }

  private mergeHistory(cloud: InspectionRecord[], local: InspectionRecord[]): InspectionRecord[] {
    const merged = new Map<string, InspectionRecord>();
    [...local, ...cloud].forEach((record) => merged.set(record.id, record));
    return Array.from(merged.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  private toCloudRecord(record: InspectionRecord) {
    return {
      id: record.id,
      timestamp: record.timestamp,
      product_id: record.productId,
      product_code: record.productCode,
      product_name: record.productName,
      master_id: record.masterId,
      master_revision_id: record.masterRevisionId,
      master_revision_code: record.masterRevisionCode,
      master_revision_checksum: record.masterRevisionChecksum,
      judgement: record.judgement,
      expected_count: record.expectedCount,
      detected_count: record.detectedCount,
      defects: record.defects,
      primary_reason: record.primaryReason,
      metrics: record.metrics,
      alignment: record.alignment,
      roi_results: record.roiResults,
      extra_objects: record.extraObjects,
      thumbnail_base64: record.thumbnailBase64 || null,
      device_id: record.deviceId,
      station_id: VISION_STATION_ID,
      operator_id: record.operatorId || null,
      sequence_number: record.sequenceNumber ?? null,
      plc_interlock_state: record.plcInterlockState || null,
      plc_comm_latency_ms: record.plcCommLatencyMs ?? null,
      plc_timeline: record.plcTimeline || null,
    };
  }

  private fromCloudRecord(row: any): InspectionRecord {
    return {
      id: row.id,
      timestamp: row.timestamp,
      productId: row.product_id,
      productCode: row.product_code,
      productName: row.product_name,
      masterId: row.master_id,
      masterRevisionId: row.master_revision_id,
      masterRevisionCode: row.master_revision_code,
      masterRevisionChecksum: row.master_revision_checksum || '',
      judgement: row.judgement,
      expectedCount: row.expected_count,
      detectedCount: row.detected_count,
      defects: row.defects || [],
      primaryReason: row.primary_reason || '',
      metrics: row.metrics || {},
      alignment: row.alignment || {},
      roiResults: row.roi_results || [],
      extraObjects: row.extra_objects || [],
      thumbnailBase64: row.thumbnail_base64 || undefined,
      deviceId: row.device_id,
      operatorId: row.operator_id || undefined,
      syncedToCloud: true,
      sequenceNumber: row.sequence_number ?? undefined,
      plcInterlockState: row.plc_interlock_state || undefined,
      plcCommLatencyMs: row.plc_comm_latency_ms ?? undefined,
      plcTimeline: row.plc_timeline || undefined,
    };
  }

  public async saveInspectionRecord(record: InspectionRecord): Promise<void> {
    try {
      await this.request('', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(this.toCloudRecord(record)),
      });
      this.removeLocalHistoryRecord(record.id);
    } catch (error) {
      this.saveLocalHistory({ ...record, syncedToCloud: false });
      console.warn('[DatabaseService] Cloud history unavailable; saved locally:', error);
    }
  }

  public async getRecentInspections(limit = 500): Promise<InspectionRecord[]> {
    const local = this.getLocalHistory();
    if (!VISION_API_URL) {
      return local.slice(0, Math.max(1, Math.min(limit, 5000)));
    }

    try {
      const rows = await this.request<any[]>(`?limit=${Math.max(1, Math.min(limit, 5000))}`);
      return this.mergeHistory(rows.map((row) => this.fromCloudRecord(row)), local).slice(0, Math.max(1, Math.min(limit, 5000)));
    } catch (error) {
      console.warn('[DatabaseService] Cloud history read failed; using local history:', error);
      return local.slice(0, Math.max(1, Math.min(limit, 5000)));
    }
  }

  public async getFilteredInspections(filters: {
    productId?: string;
    judgement?: string;
    search?: string;
    limit?: number;
  }): Promise<InspectionRecord[]> {
    const records = await this.getRecentInspections(filters.limit || 1000);
    return records.filter((item) => {
      if (filters.productId && item.productId !== filters.productId) return false;
      if (filters.judgement && filters.judgement !== 'ALL' && item.judgement !== filters.judgement) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        return (
          item.productName.toLowerCase().includes(q) ||
          item.productCode.toLowerCase().includes(q) ||
          item.primaryReason.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }

  public async getStats(): Promise<InspectionStats> {
    const records = await this.getRecentInspections(5000);
    let totalOk = 0;
    let totalNg = 0;
    let totalInvalid = 0;
    let totalErrors = 0;
    let totalCycleSum = 0;

    for (const record of records) {
      if (record.judgement === 'OK') totalOk++;
      else if (record.judgement === 'NG') totalNg++;
      else if (record.judgement === 'INVALID') totalInvalid++;
      else totalErrors++;
      totalCycleSum += record.metrics?.totalCycleMs || 0;
    }

    const totalInspected = records.length;
    return {
      totalInspected,
      totalOk,
      totalNg,
      totalInvalid,
      totalErrors,
      yieldRate: totalInspected > 0 ? (totalOk / totalInspected) * 100 : 100,
      lastCycleTimeMs: records[0]?.metrics?.totalCycleMs || 0,
      averageCycleTimeMs: totalInspected > 0 ? Math.round(totalCycleSum / totalInspected) : 0,
    };
  }

  public async clearInspectionHistory(): Promise<void> {
    if (!VISION_API_URL) {
      throw new Error('Vision backend is not configured; cloud history was not cleared.');
    }
    await this.request('', { method: 'DELETE' });
    this.removeAllLocalHistory();
  }

  public async getPendingSyncCount(): Promise<number> {
    return 0;
  }

  public async flushSyncQueue(): Promise<{ synced: number }> {
    return { synced: 0 };
  }
}

export const dbService = new DatabaseService();
