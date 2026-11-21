/**
 * Master Management Module
 * Manages production masters, revisions, inspection ROIs, and activation state.
 */

import React, { useState } from 'react';
import { Layers, Plus, Check, Edit3, Copy, ShieldCheck, Images } from 'lucide-react';
import { MasterProduct, MasterRevision } from '../../types/master';
import { UserRole } from '../Navbar';
import { dbService } from '../../services/db';
import { getMasterValidationChecks } from '../../services/setupValidation';

interface MasterManagerProps {
  role: UserRole;
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
  role,
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
  const activeMasterChecks = activeRevision ? getMasterValidationChecks(activeRevision) : [];
  const activeMasterReady = Boolean(
    activeMaster &&
    activeRevision &&
    activeRevision.masterId === activeMaster.id &&
    activeRevision.status === 'APPROVED' &&
    activeMaster.activeRevisionId === activeRevision.id &&
    activeMasterChecks.length > 0 &&
    activeMasterChecks.every((check) => check.valid)
  );

  const handleActivateRevision = async (master: MasterProduct, revisionId: string) => {
    const candidate = master.revisions.find((revision) => revision.id === revisionId);
    if (!candidate || candidate.status !== 'APPROVED') return;
    const failedChecks = getMasterValidationChecks(candidate).filter((check) => !check.valid);
    if (failedChecks.length > 0) {
      window.alert('Activation blocked. Master validation failed: ' + failedChecks.map((check) => check.label).join(', '));
      return;
    }
    try {
      await dbService.assignMasterRevision(master.id, revisionId);
      const updated = { ...master, activeRevisionId: revisionId, isActive: true, updatedAt: new Date().toISOString() };
      await onRefreshMasters();
      onSelectMaster(updated, revisionId);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Master assignment failed.');
    }
  };

  const handleEditRevision = async (master: MasterProduct, revision: MasterRevision) => {
    if (revision.status === 'PENDING_APPROVAL') {
      window.alert('This revision is locked while approval is pending.');
      return;
    }
    if (revision.status === 'APPROVED') {
      await handleCloneRevision(master, revision);
      return;
    }
    onOpenSetupModal(master, revision);
  };

  const handleSubmitRevision = async (master: MasterProduct, revision: MasterRevision) => {
    try {
      await dbService.submitMasterRevision(master.id, revision.id);
      await onRefreshMasters();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Revision submission failed.');
    }
  };

  const handleApproveRevision = async (master: MasterProduct, revision: MasterRevision) => {
    try {
      await dbService.approveMasterRevision(master.id, revision.id);
      await onRefreshMasters();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Revision approval failed.');
    }
  };

  const handleRejectRevision = async (master: MasterProduct, revision: MasterRevision) => {
    const reason = window.prompt('Enter the rejection reason (required):')?.trim();
    if (!reason) return;
    try {
      await dbService.rejectMasterRevision(master.id, revision.id, reason);
      await onRefreshMasters();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Revision rejection failed.');
    }
  };

  const handleAssignUserRole = async () => {
    const userId = window.prompt('Paste the Supabase Auth User UUID:')?.trim();
    if (!userId) return;
    const email = window.prompt('Enter the user email:')?.trim();
    if (!email) return;
    const requestedRole = window.prompt('Role: OPERATOR, ENGINEER, APPROVER, or ADMIN', 'OPERATOR')?.trim().toUpperCase();
    if (!requestedRole || !['OPERATOR', 'ENGINEER', 'APPROVER', 'ADMIN'].includes(requestedRole)) {
      window.alert('Unsupported role. No changes were made.');
      return;
    }
    let stationIds: string[] | null = null;
    if (requestedRole === 'OPERATOR') {
      try {
        const currentStations = await dbService.getUserStations(userId);
        const stationInput = window.prompt(
          'Comma-separated station IDs for this Operator (empty revokes all station access):',
          currentStations.join(', ') || 'VISION-AI-AWS'
        );
        if (stationInput === null) return;
        stationIds = [...new Set(stationInput.split(',').map((value) => value.trim()).filter(Boolean))];
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Could not read current station assignments.');
        return;
      }
    }
    try {
      await dbService.assignUserRole(userId, email, requestedRole as 'OPERATOR' | 'ENGINEER' | 'APPROVER' | 'ADMIN');
      if (stationIds !== null) await dbService.assignUserStations(userId, stationIds);
      window.alert('User role and station access updated. Ask the user to refresh the application.');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'User role update failed.');
    }
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
      status: 'DRAFT',
      checksum: undefined,
      approvedBy: null,
      submittedAt: null,
      approvedAt: null,
    };

    // A clone is an engineering draft, never a production activation.
    // Keep the previous active revision untouched while the draft is calibrated
    // and validated. The engineer can edit the draft immediately.
    const updated: MasterProduct = {
      ...master,
      revisions: [...master.revisions, clonedRev],
      activeRevisionId: master.activeRevisionId,
      updatedAt: new Date().toISOString(),
    };

    await dbService.saveMaster(updated);
    onRefreshMasters();
    onOpenSetupModal(updated, clonedRev);
  };

  return (
    <div className="space-y-6">
      {/* Step 2: master part setup gate. */}
      <div className="bg-slate-950 border border-cyan-500/30 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-400">Setup 02 / 05</div>
          <h2 className="text-xl font-bold text-white mt-1">MASTER PART SETUP</h2>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Select a valid master configuration. An unreadable or incomplete Master must never enter Live Inspection.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBackSetup} className="px-4 py-2 rounded-xl border border-slate-700 bg-slate-900 text-slate-300 text-xs font-bold hover:text-white hover:bg-slate-800">
            ← BACK: CAMERA
          </button>
          <button
            type="button"
            onClick={onContinueSetup}
            disabled={!activeMasterReady}
            className="px-5 py-2.5 rounded-xl bg-cyan-500 text-slate-950 text-xs font-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cyan-400"
          >
            NEXT: VALIDATE SETUP →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Product List */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-mono uppercase tracking-wider text-slate-400">Registered Masters</h3><div className="flex items-center gap-2">{role === 'ADMIN' && <button type="button" onClick={() => void handleAssignUserRole()} className="rounded-lg border border-amber-500/40 px-2.5 py-1.5 text-[10px] font-bold text-amber-200 hover:bg-amber-950/40">USER ROLES</button>}{(role === 'ENGINEER' || role === 'ADMIN') && <button type="button" onClick={onCreateNewMaster} className="rounded-lg bg-cyan-600 px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-cyan-500">+ NEW MASTER</button>}</div></div>

          <div className="space-y-2">
            {masters.map((m) => {
              const isSelected = m.id === currentMaster?.id;
              const isActiveOverall = m.id === activeMaster?.id;

              return (
                <div
                  key={m.id}
                  onClick={() => {
                    setSelectedMasterId(m.id);
                    const revision = m.revisions.find((r) => r.id === m.activeRevisionId && r.status === 'APPROVED');
                    if (revision && m.isActive) onSelectMaster(m, revision.id);
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
                    The master image defines the approved layout and alignment reference. Anchors define alignment; screw ROIs define the eight required inspection locations.
                  </p>
                  {previewRevision && (
                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-mono">
                      <span className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-cyan-300">
                        {previewRevision.revisionCode}
                      </span>
                      <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                        {previewRevision.expectedObjectCount} SCREWS
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
                  <span className={activeMasterReady ? 'text-emerald-300 text-[10px] font-black' : 'text-rose-300 text-[10px] font-black'}>
                    {activeMasterReady ? 'VALID' : 'INVALID'}
                  </span>
                </div>
                <div className="mt-2 text-[10px] font-mono text-slate-500">
                  {activeMasterChecks.filter((check) => !check.valid).length === 0
                    ? 'All validation checks are currently PASS.'
                    : activeMasterChecks.filter((check) => !check.valid).length + ' validation item(s) will be shown in the Validation Center.'}
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
                            <span className={rev.status === 'APPROVED' ? 'mt-1 inline-flex rounded bg-emerald-950 px-2 py-0.5 text-[9px] font-bold text-emerald-300' : rev.status === 'PENDING_APPROVAL' ? 'mt-1 inline-flex rounded bg-amber-950 px-2 py-0.5 text-[9px] font-bold text-amber-300' : rev.status === 'REJECTED' ? 'mt-1 inline-flex rounded bg-rose-950 px-2 py-0.5 text-[9px] font-bold text-rose-300' : 'mt-1 inline-flex rounded bg-slate-800 px-2 py-0.5 text-[9px] font-bold text-slate-300'}>{rev.status || 'DRAFT'}</span>
                          </div>
                        </div>

                        {/* Revision Action Buttons */}
                        <div className="flex items-center gap-2">
                          {(role === 'ENGINEER' || role === 'ADMIN') && rev.status !== 'PENDING_APPROVAL' && (
                            <button
                              onClick={() => void handleEditRevision(currentMaster, rev)}
                              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-slate-700"
                            >
                              <Edit3 className="h-3.5 w-3.5" /><span>Edit / Calibrate</span>
                            </button>
                          )}
                          {(role === 'ENGINEER' || role === 'ADMIN') && (
                            <button
                              onClick={() => void handleCloneRevision(currentMaster, rev)}
                              title="Clone Revision for Engineering Change"
                              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          )}

                          {(role === 'ENGINEER' || role === 'ADMIN') && (rev.status === 'DRAFT' || rev.status === 'REJECTED') && (
                            <button onClick={() => void handleSubmitRevision(currentMaster, rev)} className="rounded-lg border border-cyan-500/40 bg-cyan-950/40 px-3 py-1.5 text-xs font-semibold text-cyan-200">Submit</button>
                          )}
                          {(role === 'APPROVER' || role === 'ADMIN') && rev.status === 'PENDING_APPROVAL' && (
                            <>
                              <button onClick={() => void handleApproveRevision(currentMaster, rev)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white">Approve</button>
                              <button onClick={() => void handleRejectRevision(currentMaster, rev)} className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-200">Reject</button>
                            </>
                          )}
                          {(role === 'ENGINEER' || role === 'ADMIN') && !isActiveRev && rev.status === 'APPROVED' && (
                            <button onClick={() => void handleActivateRevision(currentMaster, rev.id)} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm">
                              <Check className="h-3.5 w-3.5" /><span>Assign to station</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Specs Badge Strip */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 pt-3 border-t border-slate-800/80 text-xs font-mono">
                        <div>
                          <span className="text-slate-500 text-[11px]">Screws Required:</span>
                          <div className="font-bold text-cyan-300">{rev.expectedObjectCount} pcs</div>
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
