/**
 * Master Management Module
 * Manages production masters, revisions, inspection ROIs, and activation state.
 */

import React, { useState } from 'react';
import { Layers, Plus, Check, Edit3, Copy, ShieldCheck, Images } from 'lucide-react';
import { MasterProduct, MasterRevision } from '../../types/master';
import { dbService } from '../../services/db';
import { getMasterValidationChecks } from '../../services/setupValidation';

interface MasterManagerProps {
  masters: MasterProduct[];
  activeMaster: MasterProduct | null;
  activeRevision: MasterRevision | null;
  onSelectMaster: (master: MasterProduct, revisionId?: string) => void;
  onRefreshMasters: () => void;
  onOpenSetupModal: (master: MasterProduct, revision: MasterRevision) => void;
  onCreateNewMaster: () => void;
  onBackSetup: () => void;
  onContinueSetup: () => void;
}

export const MasterManager: React.FC<MasterManagerProps> = ({
  masters,
  activeMaster,
  activeRevision,
  onSelectMaster,
  onRefreshMasters,
  onOpenSetupModal,
  onCreateNewMaster,
  onBackSetup,
  onContinueSetup,
}) => {
  const [selectedMasterId, setSelectedMasterId] = useState<string>(activeMaster?.id || masters[0]?.id || '');

  const currentMaster = masters.find((m) => m.id === selectedMasterId) || masters[0];
  const previewRevision = currentMaster?.revisions.find((r) => r.id === currentMaster.activeRevisionId) || currentMaster?.revisions[0];
  const previewRevisionChecks = previewRevision ? getMasterValidationChecks(previewRevision) : [];
  const previewRevisionReady = Boolean(previewRevision) && previewRevisionChecks.every((check) => check.valid);

  const handleActivateRevision = async (master: MasterProduct, revisionId: string) => {
    const revisionToActivate = master.revisions.find((revision) => revision.id === revisionId);
    if (!revisionToActivate || !getMasterValidationChecks(revisionToActivate).every((check) => check.valid)) return;

    const updated: MasterProduct = {
      ...master,
      activeRevisionId: revisionId,
      updatedAt: new Date().toISOString(),
    };
    await dbService.saveMaster(updated);
    onRefreshMasters();
    onSelectMaster(updated, revisionId);
  };

  const handleCloneRevision = async (master: MasterProduct, rev: MasterRevision) => {
    const newRevNum = master.revisions.length + 1;
    const newRevCode = `REV-0${newRevNum}`;
    const newRevId = `rev-0${newRevNum}-${Date.now()}`;

    const clonedRev: MasterRevision = {
      ...rev,
      id: newRevId,
      revisionCode: newRevCode,
      revisionNote: `Cloned from ${rev.revisionCode}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'Quality Engineer',
    };

    const updated: MasterProduct = {
      ...master,
      revisions: [...master.revisions, clonedRev],
      activeRevisionId: newRevId,
      updatedAt: new Date().toISOString(),
    };

    await dbService.saveMaster(updated);
    onRefreshMasters();
    onSelectMaster(updated, newRevId);
  };

  return (
    <div className="space-y-6">
      {/* Step 2: master part setup gate. */}
      <div className="bg-slate-950 border border-cyan-500/30 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-400">Setup 02 / 05</div>
          <h2 className="text-xl font-bold text-white mt-1">MASTER PART SETUP</h2>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Select the approved master and complete its validation before saving the station configuration.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBackSetup} className="px-4 py-2 rounded-xl border border-slate-700 bg-slate-900 text-slate-300 text-xs font-bold hover:text-white hover:bg-slate-800">
            ← BACK: CAMERA
          </button>
          <button
            type="button"
            onClick={onContinueSetup}
            disabled={!activeMaster}
            className="px-5 py-2.5 rounded-xl bg-cyan-500 text-slate-950 text-xs font-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cyan-400"
          >
            NEXT: VALIDATE SETUP →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Product List */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400">Registered Masters</h3>

          <div className="space-y-2">
            {masters.map((m) => {
              const isSelected = m.id === currentMaster?.id;
              const isActiveOverall = m.id === activeMaster?.id;

              return (
                <div
                  key={m.id}
                  onClick={() => {
                    setSelectedMasterId(m.id);
                    const revision = m.revisions.find((r) => r.id === m.activeRevisionId) || m.revisions[0];
                    if (revision) onSelectMaster(m, revision.id);
                  }}
                  className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-slate-800/90 border-cyan-500/80 shadow-md'
                      : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-white">{m.productName}</span>
                        {isActiveOverall && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-500 text-emerald-300">
                            ACTIVE
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-cyan-400 mt-0.5">{m.productCode}</div>
                    </div>
                    <span className="text-xs font-mono text-slate-400">
                      {m.revisions.length} {m.revisions.length === 1 ? 'Rev' : 'Revs'}
                    </span>
                  </div>

                  <p className="text-xs text-slate-400 mt-2 line-clamp-2">{m.description}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Center & Right: Revisions and Configuration Detail */}
        {currentMaster && (
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              {/* Master image preview: the actual reference image used by the revision. */}
              <div className="mb-5 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4 rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
                <div className="aspect-[4/3] overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
                  {previewRevision ? (
                    previewRevision.masterImageUrl ? (
                      <img
                        src={previewRevision.masterImageUrl}
                        alt={`${currentMaster.productName} ${previewRevision.revisionCode} master reference`}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
                        <Images className="h-7 w-7 text-slate-600" />
                        <span className="text-xs font-semibold text-slate-400">Master image required</span>
                        <span className="text-[10px] font-mono text-slate-600">Open Edit / Calibrate to upload.</span>
                      </div>
                    )
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs font-mono text-slate-500">
                      Select the active revision to preview
                    </div>
                  )}
                </div>
                <div className="flex flex-col justify-center">
                  <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-400">Master Image</div>
                  <div className="mt-1 text-sm font-bold text-white">Reference for vision alignment & inspection</div>
                  <p className="mt-2 text-xs leading-5 text-slate-400">
                    The master image defines the approved layout and alignment reference. The configured inspection areas define the required inspection locations for this product.
                  </p>
                  {previewRevision && (
                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-mono">
                      <span className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-cyan-300">
                        {previewRevision.revisionCode}
                      </span>
                      <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                        {previewRevision.inspectionROIs.length} INSPECTION POINTS
                      </span>
                      <span className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-300">
                        {previewRevision.anchors?.length ?? 0} ANCHORS
                      </span>
                      <span className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-300">
                        {previewRevision.masterWidth}×{previewRevision.masterHeight}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {previewRevision?.referenceImages?.length > 0 && (
                <div className="mb-5 rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Images className="w-4 h-4 text-cyan-400" />
                      <span className="text-sm font-bold text-white">Reference Images</span>
                      <span className="text-[10px] font-mono text-slate-500">{previewRevision.referenceImages.length} evidence images</span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-500">Golden reference set for inspection points</span>
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {previewRevision.referenceImages.map((reference) => (
                      <div key={reference.id} className="shrink-0 w-24">
                        <div className="aspect-square rounded-lg overflow-hidden border border-slate-800 bg-slate-900">
                          {reference.imageUrl ? (
                        <img src={reference.imageUrl} alt={reference.label} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-[9px] font-mono text-slate-600">NOT CONFIGURED</div>
                      )}
                        </div>
                        <div className="mt-1 text-[10px] font-mono text-slate-300 text-center truncate">{reference.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-mono uppercase tracking-wider text-slate-400">Current master configuration</span>
                  <span className={previewRevisionReady ? 'text-emerald-300 text-[10px] font-black' : 'text-rose-300 text-[10px] font-black'}>
                    {previewRevisionReady ? 'VALID' : 'INVALID'}
                  </span>
                </div>
                <div className="mt-2 text-[10px] font-mono text-slate-500">
                  {previewRevisionChecks.filter((check) => !check.valid).length === 0
                    ? 'Selected product revision passes all setup checks.'
                    : previewRevisionChecks.filter((check) => !check.valid).length + ' setup item(s) must be corrected before activation.'}
                </div>
              </div>

              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-white">{currentMaster.productName}</h3>
                  <div className="flex items-center gap-3 text-xs font-mono text-slate-400 mt-1">
                    <span>Code: {currentMaster.productCode}</span>
                    <span>·</span>
                    <span>Created by: {currentMaster.createdBy}</span>
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-xs font-mono text-slate-400">Active Revision:</span>
                  <div className="text-sm font-mono font-bold text-emerald-400">
                    {currentMaster.revisions.find((r) => r.id === currentMaster.activeRevisionId)?.revisionCode || 'N/A'}
                  </div>
                </div>
              </div>

              {/* Revision Cards */}
              <div className="space-y-3 mt-4">
                <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400">
                  Revision History & Rules
                </h4>

                {currentMaster.revisions.map((rev) => {
                  const isActiveRev = rev.id === currentMaster.activeRevisionId;

                  return (
                    <div
                      key={rev.id}
                      className={`p-4 rounded-xl border transition-all ${
                        isActiveRev
                          ? 'bg-slate-950 border-emerald-500/60 shadow-lg'
                          : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-10 h-10 rounded-lg flex items-center justify-center font-mono font-bold text-sm ${
                              isActiveRev
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {rev.revisionCode}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-white">{rev.revisionCode}</span>
                              {isActiveRev && (
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 border border-emerald-600 text-emerald-300 flex items-center gap-1">
                                  <ShieldCheck className="w-3 h-3" />
                                  ACTIVE ON LINE
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-300 mt-0.5">{rev.revisionNote}</p>
                          </div>
                        </div>

                        {/* Revision Action Buttons */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => onOpenSetupModal(currentMaster, rev)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 text-xs font-medium"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>Edit / Calibrate</span>
                          </button>

                          <button
                            onClick={() => handleCloneRevision(currentMaster, rev)}
                            title="Clone Revision for Engineering Change"
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>

                          {!isActiveRev && (
                            <button
                              onClick={() => handleActivateRevision(currentMaster, rev.id)}
                              disabled={!getMasterValidationChecks(rev).every((check) => check.valid)}
                              title={!getMasterValidationChecks(rev).every((check) => check.valid) ? 'Complete master, anchors, and real OK/NG references before activation' : 'Activate this validated revision'}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Activate</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Specs Badge Strip */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 pt-3 border-t border-slate-800/80 text-xs font-mono">
                        <div>
                          <span className="text-slate-500 text-[11px]">Inspection Points:</span>
                          <div className="font-bold text-cyan-300">{rev.inspectionROIs.length} points</div>
                        </div>
                        <div>
                          <span className="text-slate-500 text-[11px]">Tolerance:</span>
                          <div className="text-slate-200">±{rev.tolerance.maxPositionOffsetMm} mm</div>
                        </div>
                        <div>
                          <span className="text-slate-500 text-[11px]">Min Conf:</span>
                          <div className="text-slate-200">{(rev.tolerance.minScrewConfidence * 100).toFixed(0)}%</div>
                        </div>
                        <div>
                          <span className="text-slate-500 text-[11px]">Stabilization:</span>
                          <div className="text-slate-200">{rev.tolerance.stabilizationDelayMs} ms</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
