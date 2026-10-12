/**
 * Master Setup & Calibration Modal
 * Simple rectangular ROI editor with approved OK reference comparison.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Save,
  Crosshair,
  Images,
  Upload,
  CheckCircle2,
  AlertCircle,
  Plus,
  Trash2,
} from 'lucide-react';
import { InspectionROI, MasterProduct, MasterRevision } from '../../types/master';
import { dbService } from '../../services/db';
import { getMasterValidationChecks } from '../../services/setupValidation';

interface MasterSetupModalProps {
  master: MasterProduct;
  revision: MasterRevision;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const MasterSetupModal: React.FC<MasterSetupModalProps> = ({
  master,
  revision,
  isOpen,
  onClose,
  onSaved,
}) => {
  const [activeTab, setActiveTab] = useState<'VISUAL' | 'TOLERANCES'>('VISUAL');
  const [editedRevision, setEditedRevision] = useState<MasterRevision>({ ...revision });
  const [selectedItemType, setSelectedItemType] = useState<'ANCHOR' | 'ROI'>('ROI');
  const [selectedId, setSelectedId] = useState<string>('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string>('');
  const [saveError, setSaveError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const activePointerIdRef = useRef<number | null>(null);
  const pointerModeRef = useRef<'MOVE' | 'RESIZE'>('MOVE');
  const pointerStartRef = useRef<{ x: number; y: number; width: number; height: number; pointerX: number; pointerY: number } | null>(null);

  useEffect(() => {
    setEditedRevision({ ...revision });
    setSelectedReferenceId(revision.referenceImages?.[0]?.id || '');
    setSelectedId(revision.inspectionROIs?.[0]?.id || '');
  }, [revision]);

  // Redraw master image with interactive rectangular ROIs
  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = editedRevision.masterWidth || 800;
    const height = editedRevision.masterHeight || 600;
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);

    const drawOverlay = () => {
      const w = canvas.width;
      const h = canvas.height;
      const dz = editedRevision.detectionZone;

      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(dz.x * w, dz.y * h, dz.width * w, dz.height * h);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(6, 182, 212, 0.04)';
      ctx.fillRect(dz.x * w, dz.y * h, dz.width * w, dz.height * h);
      ctx.font = '10px monospace';
      ctx.fillStyle = '#06b6d4';
      ctx.fillText('DETECTION ZONE', dz.x * w + 8, dz.y * h + 16);

      for (const roi of editedRevision.inspectionROIs) {
        const x = roi.x * w;
        const y = roi.y * h;
        const rw = (roi.width ?? roi.radius * 2) * w;
        const rh = (roi.height ?? roi.radius * 2) * h;
        const left = x - rw / 2;
        const top = y - rh / 2;
        const selected = selectedItemType === 'ROI' && selectedId === roi.id;
        ctx.strokeStyle = selected ? '#f59e0b' : '#22c55e';
        ctx.lineWidth = selected ? 3 : 2;
        ctx.setLineDash(selected ? [] : [6, 4]);
        ctx.strokeRect(left, top, rw, rh);
        ctx.setLineDash([]);
        ctx.fillStyle = selected ? 'rgba(245, 158, 11, 0.08)' : 'rgba(34, 197, 94, 0.05)';
        ctx.fillRect(left, top, rw, rh);
        ctx.font = 'bold 12px monospace';
        ctx.fillStyle = selected ? '#fbbf24' : '#4ade80';
        ctx.textAlign = 'start';
        ctx.fillText(roi.name, left + 4, Math.max(12, top - 5));
        if (selected) {
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(left + rw - 7, top + rh - 7, 14, 14);
        }
      }
      ctx.textAlign = 'start';
    };

    const imageUrl = editedRevision.masterImageUrl?.trim();
    if (!imageUrl) return;

    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) return;

      // The master image is the calibration coordinate system. Never distort it
      // into the legacy 800x600 canvas. If an older master still carries 800x600
      // metadata, migrate the dimensions to the actual uploaded image once it is
      // loaded; normalized ROIs/anchors remain unchanged.
      if (editedRevision.masterWidth !== img.naturalWidth || editedRevision.masterHeight !== img.naturalHeight) {
        setEditedRevision((prev) => ({
          ...prev,
          masterWidth: img.naturalWidth,
          masterHeight: img.naturalHeight,
        }));
        return;
      }

      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      drawOverlay();
    };
    img.onerror = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Master image could not be rendered', width / 2, height / 2);
      ctx.textAlign = 'start';
      console.warn('[MasterSetup] Failed to render master image');
    };
    img.src = imageUrl;
  }, [editedRevision, isOpen, selectedId, selectedItemType]);

  // Pointer events make the editor work with both mouse and touchscreen.
  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();

    // The canvas uses object-contain. Its CSS box can be wider/taller than the
    // actual rendered image, so mapping directly from rect -> canvas pixels
    // introduces a coordinate drift whenever master and editor aspect ratios
    // differ. Convert through the real contained image rectangle instead.
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const renderedWidth = canvas.width * scale;
    const renderedHeight = canvas.height * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;

    return {
      x: (e.clientX - rect.left - offsetX) / scale,
      y: (e.clientY - rect.top - offsetY) / scale,
    };
  };

  // Select and move a rectangular ROI, or drag its bottom-right handle to resize.
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x: clickX, y: clickY } = getCanvasPoint(e);
    canvas.setPointerCapture(e.pointerId);
    activePointerIdRef.current = e.pointerId;

    for (const roi of [...editedRevision.inspectionROIs].reverse()) {
      const rw = (roi.width ?? roi.radius * 2) * canvas.width;
      const rh = (roi.height ?? roi.radius * 2) * canvas.height;
      const left = roi.x * canvas.width - rw / 2;
      const top = roi.y * canvas.height - rh / 2;
      const right = left + rw;
      const bottom = top + rh;
      if (clickX >= left - 6 && clickX <= right + 6 && clickY >= top - 6 && clickY <= bottom + 6) {
        setSelectedItemType('ROI');
        setSelectedId(roi.id);
        pointerModeRef.current = clickX >= right - 14 && clickY >= bottom - 14 ? 'RESIZE' : 'MOVE';
        pointerStartRef.current = {
          x: roi.x, y: roi.y,
          width: roi.width ?? roi.radius * 2,
          height: roi.height ?? roi.radius * 2,
          pointerX: clickX, pointerY: clickY,
        };
        isDraggingRef.current = true;
        return;
      }
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current || activePointerIdRef.current !== e.pointerId) return;
    const canvas = canvasRef.current;
    const start = pointerStartRef.current;
    if (!canvas || !start || !selectedId) return;
    const { x: clickX, y: clickY } = getCanvasPoint(e);
    const dx = (clickX - start.pointerX) / canvas.width;
    const dy = (clickY - start.pointerY) / canvas.height;

    setEditedRevision((prev) => ({
      ...prev,
      inspectionROIs: prev.inspectionROIs.map((roi) => {
        if (roi.id !== selectedId) return roi;
        if (pointerModeRef.current === 'RESIZE') {
          const width = Math.max(0.03, Math.min(0.96, start.width + dx));
          const height = Math.max(0.03, Math.min(0.96, start.height + dy));
          const left = start.x - start.width / 2;
          const top = start.y - start.height / 2;
          return {
            ...roi,
            width,
            height,
            x: Math.max(width / 2, Math.min(1 - width / 2, left + width / 2)),
            y: Math.max(height / 2, Math.min(1 - height / 2, top + height / 2)),
          };
        }
        const width = start.width;
        const height = start.height;
        return {
          ...roi,
          x: Math.max(width / 2, Math.min(1 - width / 2, start.x + dx)),
          y: Math.max(height / 2, Math.min(1 - height / 2, start.y + dy)),
          width,
          height,
        };
      }),
    }));
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = false;
    activePointerIdRef.current = null;
    pointerStartRef.current = null;
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
  };

  const handleReplaceMasterImage = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const img = new Image();
      img.onload = () => {
        if (!img.naturalWidth || !img.naturalHeight) return;
        setEditedRevision((prev) => ({
          ...prev,
          masterImageUrl: dataUrl,
          masterWidth: img.naturalWidth,
          masterHeight: img.naturalHeight,
        }));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const selectedReference = editedRevision.referenceImages?.find((reference) => reference.id === selectedReferenceId);
  const selectedRoi = editedRevision.inspectionROIs.find((roi) => roi.id === selectedId) || editedRevision.inspectionROIs[0];

  const handleReplaceReferenceImage = (referenceId: string, file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setEditedRevision((prev) => ({
        ...prev,
        referenceImages: (prev.referenceImages || []).map((reference) =>
          reference.id === referenceId ? { ...reference, imageUrl: dataUrl } : reference
        ),
      }));
    };
    reader.readAsDataURL(file);
  };

  const validationChecks = getMasterValidationChecks(editedRevision);

  const isConfigurationValid = validationChecks.every((check) => check.valid);

  useEffect(() => {
    if (saveError) setSaveError(null);
  }, [editedRevision]);

    // Save changes to database
  const handleSave = async () => {
    setSaveError(null);

    if (!isConfigurationValid) {
      const errors = validationChecks.filter((check) => !check.valid).map((check) => check.error);
      setSaveError(errors.join(' '));
      return;
    }

    const normalizedRevision: MasterRevision = {
      ...editedRevision,
      anchors: [],
      expectedObjectCount: editedRevision.inspectionROIs.length,
      inspectionROIs: editedRevision.inspectionROIs.map((roi) => ({
        ...roi,
        objectType: 'component',
        width: roi.width ?? roi.radius * 2,
        height: roi.height ?? roi.radius * 2,
      })),
    };
    const normalizedRevisions = master.revisions.map((r) => r.id === normalizedRevision.id ? normalizedRevision : r);
    const updatedMaster: MasterProduct = {
      ...master,
      revisions: normalizedRevisions,
      updatedAt: new Date().toISOString(),
    };

    try {
      await dbService.saveMaster(updatedMaster);
      onSaved();
      onClose();
    } catch (error) {
      console.error('[MasterSetup] Save failed:', error);
      setSaveError('Master could not be saved. Please retry. Check the browser console for technical details.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center">
              <Crosshair className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                Simple ROI Setup · {master.productName} ({editedRevision.revisionCode})
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                Draw rectangular inspection areas and compare them with approved OK reference images.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-white font-bold text-xs transition-colors shadow-lg ${
                isConfigurationValid
                  ? 'bg-emerald-600 hover:bg-emerald-500'
                  : 'bg-slate-700 hover:bg-slate-600'
              }`}
            >
              <Save className="w-4 h-4" />
              <span>{isConfigurationValid ? 'Save & Update' : 'Fix Validation'}</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {saveError && (
          <div className="border-b border-red-500/30 bg-red-950/40 px-6 py-3">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <div className="min-w-0">
                <div className="text-xs font-bold text-red-200">Master cannot be saved</div>
                <div className="mt-1 text-[11px] leading-5 text-red-300">{saveError}</div>
              </div>
            </div>
          </div>
        )}

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Interactive Canvas Area */}
          <div className="lg:col-span-2 space-y-3">
            <div className="relative aspect-[4/3] bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden flex items-center justify-center select-none">
              <div className="absolute left-3 top-3 z-10 rounded-lg border border-cyan-500/30 bg-slate-950/85 px-2 py-1 text-[10px] font-mono text-cyan-300 backdrop-blur-sm">MASTER IMAGE · {editedRevision.revisionCode}</div>
              {editedRevision.masterImageUrl ? (
                <canvas
                  ref={canvasRef}
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={handleCanvasPointerUp}
                  onPointerCancel={handleCanvasPointerUp}
                  style={{ touchAction: 'none' }}
                  className="w-full h-full object-contain cursor-crosshair"
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <Images className="h-10 w-10 text-slate-600" />
                  <div>
                    <div className="text-sm font-semibold text-white">Master image not configured</div>
                    <div className="mt-1 text-xs text-slate-500">Upload the approved full-view image to define the alignment reference.</div>
                  </div>
                  <label className="cursor-pointer rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/20">
                    Upload Master Image
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => handleReplaceMasterImage(e.target.files?.[0] || null)} />
                  </label>
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-bold text-white">
                    <Images className="w-4 h-4 text-cyan-400" />
                    Reference Image Set
                    <span className="text-[10px] font-mono text-slate-500">({editedRevision.referenceImages?.length || 0} images)</span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-mono mt-0.5">Upload one approved OK reference image for each rectangular inspection area.</p>
                </div>
                {selectedReference && (
                  <div className="hidden sm:block text-right text-[10px] font-mono">
                    <div className="text-cyan-300">Selected: {selectedReference.label}</div>
                    <div className="text-slate-500">Linked ROI: {selectedReference.roiId || '—'}</div>
                  </div>
                )}
              </div>

              <div className="flex gap-3 overflow-x-auto pb-1">
                {(editedRevision.referenceImages || []).map((reference) => {
                  const isSelected = reference.id === selectedReferenceId;
                  return (
                    <div
                      key={reference.id}
                      onClick={() => {
                        setSelectedReferenceId(reference.id);
                        if (reference.roiId) {
                          setSelectedId(reference.roiId);
                          setSelectedItemType('ROI');
                        }
                      }}
                      className={`group shrink-0 w-28 rounded-xl border p-1.5 cursor-pointer transition-all ${
                        isSelected ? 'border-cyan-400 bg-cyan-500/10 shadow-lg shadow-cyan-950/30' : 'border-slate-800 bg-slate-900 hover:border-slate-600'
                      }`}
                    >
                      <div className="aspect-square rounded-lg overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center">
                        {reference.imageUrl ? (
                          <img src={reference.imageUrl} alt={reference.label} className="h-full w-full object-cover" />
                        ) : (
                          <div className="px-2 text-center text-[9px] font-mono font-bold text-amber-400">
                            UPLOAD REQUIRED
                          </div>
                        )}
                      </div>
                      <div className="px-1 pt-1.5">
                        <div className={`text-[10px] font-mono font-bold truncate ${isSelected ? 'text-cyan-300' : 'text-slate-200'}`}>{reference.label}</div>
                        <label className="mt-1 flex items-center gap-1 text-[9px] font-mono text-slate-500 hover:text-cyan-300 cursor-pointer">
                          <Upload className="w-3 h-3" /> Replace
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => handleReplaceReferenceImage(reference.id, e.target.files?.[0] || null)}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3">
              <div>
                <div className="text-xs font-semibold text-white">Master Image</div>
                <div className="text-[10px] font-mono text-slate-500">Full-view image used as the layout and alignment reference.</div>
              </div>
              <label className="shrink-0 cursor-pointer rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[10px] font-semibold text-cyan-300 hover:border-cyan-500/50">
                {editedRevision.masterImageUrl ? 'Replace' : 'Upload'}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => handleReplaceMasterImage(e.target.files?.[0] || null)} />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-300">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-blue-500"></span>
                GREEN = rectangular ROI
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-300">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-yellow-400 border-dashed"></span>
                AMBER handle = resize selected ROI
              </div>
              <div className="text-[10px] font-mono text-cyan-300">Drag a rectangle to move it; drag its bottom-right handle to resize.</div>
            </div>
            <div className="text-xs font-mono text-slate-400 flex items-center justify-between">
              <span>The camera ROI is compared with its approved OK reference. Alignment anchors and screw detection are not used.</span>
              <span className="text-cyan-400">Master Res: {editedRevision.masterWidth}x{editedRevision.masterHeight}</span>
            </div>
          </div>

          {/* Right Control Panels */}
          <div className="space-y-4">
            {/* Save Validation Status */}
            <div className={`rounded-2xl border p-3 ${
              isConfigurationValid
                ? 'border-emerald-500/30 bg-emerald-500/5'
                : 'border-amber-500/30 bg-amber-500/5'
            }`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Master Validation</div>
                  <div className={`mt-1 text-sm font-bold ${
                    isConfigurationValid ? 'text-emerald-300' : 'text-amber-300'
                  }`}>
                    {isConfigurationValid ? 'READY TO SAVE' : 'CHECK REQUIRED ITEMS'}
                  </div>
                </div>
                {isConfigurationValid ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-amber-400" />
                )}
              </div>

              <div className="mt-3 space-y-1.5">
                {validationChecks.map((check) => (
                  <div key={check.label} className="flex items-center justify-between gap-3 rounded-lg bg-slate-950/50 px-2.5 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      {check.valid ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      ) : (
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                      )}
                      <span className={`truncate text-[10px] font-mono ${
                        check.valid ? 'text-slate-300' : 'text-red-300'
                      }`}>{check.label}</span>
                    </div>
                    <span className={`shrink-0 text-[10px] font-mono ${
                      check.valid ? 'text-emerald-300' : 'text-red-300'
                    }`}>{check.detail}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
              <button
                onClick={() => setActiveTab('VISUAL')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium text-center transition-colors ${
                  activeTab === 'VISUAL' ? 'bg-slate-800 text-cyan-400 font-bold' : 'text-slate-400'
                }`}
              >
                ROIs ({editedRevision.inspectionROIs.length})
              </button>
              <button
                onClick={() => setActiveTab('TOLERANCES')}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium text-center transition-colors ${
                  activeTab === 'TOLERANCES' ? 'bg-slate-800 text-cyan-400 font-bold' : 'text-slate-400'
                }`}
              >
                Tolerances
              </button>
            </div>

            {activeTab === 'VISUAL' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="text-xs font-mono uppercase tracking-wider text-slate-400">Rectangular Inspection Areas</span>
                    <div className="text-[10px] text-slate-500 mt-1">Add, move, resize, and assign an OK reference.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const id = 'roi-' + Date.now();
                      const referenceId = 'ref-' + Date.now();
                      const newRoi: InspectionROI = {
                        id, name: 'ROI ' + (editedRevision.inspectionROIs.length + 1),
                        objectType: 'component', x: 0.5, y: 0.5, radius: 0.1,
                        width: 0.2, height: 0.2, toleranceRadius: 0.05,
                        minConfidence: 0.75, isRequired: true, expectedPolarity: 'contrast',
                      };
                      setEditedRevision((prev) => ({
                        ...prev,
                        expectedObjectCount: prev.inspectionROIs.length + 1,
                        inspectionROIs: [...prev.inspectionROIs, newRoi],
                        referenceImages: [...(prev.referenceImages || []), {
                          id: referenceId, label: newRoi.name + ' OK', imageUrl: '', roiId: id,
                          description: 'Approved OK image for this rectangular ROI',
                        }],
                      }));
                      setSelectedId(id);
                      setSelectedReferenceId(referenceId);
                      setSelectedItemType('ROI');
                    }}
                    className="flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2 text-[10px] font-bold text-emerald-300"
                  ><Plus className="h-3.5 w-3.5" /> Add ROI</button>
                </div>

                {selectedReference && (
                  <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-3">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-400 mb-2">Selected Golden Reference</div>
                    <div className="flex items-center gap-3">
                      <div className="w-20 h-20 rounded-lg border border-slate-700 bg-slate-950 flex items-center justify-center shrink-0">
                        {selectedReference.imageUrl ? (
                          <img src={selectedReference.imageUrl} alt={selectedReference.label} className="w-full h-full rounded-lg object-cover" />
                        ) : (
                          <span className="text-[8px] font-mono font-bold text-amber-400 text-center">UPLOAD</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-white">{selectedReference.label}</div>
                        <div className="text-[10px] font-mono text-slate-500 mt-1">{selectedReference.description || 'Approved OK reference for the selected rectangle.'}</div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
                  {editedRevision.inspectionROIs.map((roi) => {
                    const isSelected = selectedId === roi.id && selectedItemType === 'ROI';

                    return (
                      <div
                        key={roi.id}
                        onClick={() => {
                          setSelectedId(roi.id);
                          setSelectedItemType('ROI');
                          const matchingReference = editedRevision.referenceImages?.find((reference) => reference.roiId === roi.id);
                          if (matchingReference) setSelectedReferenceId(matchingReference.id);
                        }}
                        className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-slate-800 border-cyan-500 shadow-md'
                            : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <input
                            type="text"
                            value={roi.name}
                            onChange={(e) => {
                              const val = e.target.value;
                              setEditedRevision((prev) => ({
                                ...prev,
                                inspectionROIs: prev.inspectionROIs.map((r) =>
                                  r.id === roi.id ? { ...r, name: val } : r
                                ),
                              }));
                            }}
                            className="bg-transparent font-bold text-white font-mono focus:outline-none focus:border-b border-cyan-400"
                          />

                          <button
                            type="button"
                            title="Remove ROI"
                            onClick={(e) => {
                              e.stopPropagation();
                              const remaining = editedRevision.inspectionROIs.filter((item) => item.id !== roi.id);
                              setEditedRevision((prev) => ({
                                ...prev,
                                expectedObjectCount: remaining.length,
                                inspectionROIs: remaining,
                                referenceImages: (prev.referenceImages || []).filter((reference) => reference.roiId !== roi.id),
                              }));
                              if (selectedId === roi.id) {
                                setSelectedId(remaining[0]?.id || '');
                                setSelectedReferenceId(editedRevision.referenceImages?.find((reference) => reference.roiId === remaining[0]?.id)?.id || '');
                              }
                            }}
                            className="rounded-md p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-300"
                          ><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-400">
                          <div>Width: {((roi.width ?? roi.radius * 2) * 100).toFixed(1)}%</div>
                          <div>Height: {((roi.height ?? roi.radius * 2) * 100).toFixed(1)}%</div>
                          <div>Match: {(roi.minConfidence * 100).toFixed(0)}%</div>
                          <div>Reference: {editedRevision.referenceImages?.some((reference) => reference.roiId === roi.id && reference.imageUrl) ? "Ready" : "Missing"}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === 'TOLERANCES' && (
              <div className="space-y-4">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-4">
                  <div>
                    <div className="flex justify-between text-xs font-mono mb-1">
                      <span className="text-slate-300">Selected ROI Similarity Threshold:</span>
                      <span className="text-cyan-400 font-bold">
                        {selectedRoi ? (selectedRoi.minConfidence * 100).toFixed(0) + '%' : 'Select ROI'}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="0.98"
                      step="0.02"
                      disabled={!selectedRoi}
                      value={selectedRoi?.minConfidence ?? 0.75}
                      onChange={(e) => {
                        const threshold = parseFloat(e.target.value);
                        if (!selectedRoi) return;
                        setEditedRevision((prev) => ({
                          ...prev,
                          inspectionROIs: prev.inspectionROIs.map((roi) =>
                            roi.id === selectedRoi.id ? { ...roi, minConfidence: threshold } : roi
                          ),
                        }));
                      }}
                      className="w-full accent-cyan-500"
                    />
                    <p className="text-[10px] text-slate-500 font-mono mt-1">
                      A higher threshold requires a closer visual match to the approved OK reference.
                    </p>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs font-mono mb-1">
                      <span className="text-slate-300">Stabilization Delay:</span>
                      <span className="text-cyan-400 font-bold">{editedRevision.tolerance.stabilizationDelayMs} ms</span>
                    </div>
                    <input
                      type="range"
                      min="200"
                      max="1500"
                      step="50"
                      value={editedRevision.tolerance.stabilizationDelayMs}
                      onChange={(e) => {
                        const value = parseInt(e.target.value, 10);
                        setEditedRevision((prev) => ({
                          ...prev,
                          tolerance: { ...prev.tolerance, stabilizationDelayMs: value },
                        }));
                      }}
                      className="w-full accent-cyan-500"
                    />
                    <p className="text-[10px] text-slate-500 font-mono mt-1">
                      Wait time after the product enters the camera zone before comparison.
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-[10px] leading-5 text-slate-400">
                  Position, screw-count, and rotation tolerances are not used by Simple ROI comparison. Each rectangle is compared directly with its own approved OK reference image.
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};
