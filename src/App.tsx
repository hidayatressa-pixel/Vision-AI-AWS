/**
 * Realtime Vision Inspection System
 * Manufacturing zero-touch automated visual inspection platform.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActiveTab, Navbar, UserRole } from './components/Navbar';
import { CameraCalibrationView } from './components/engineer/CameraCalibrationView';
import { MasterManager } from './components/engineer/MasterManager';
import { MasterSetupModal } from './components/engineer/MasterSetupModal';
import { PLCConfigurationView } from './components/engineer/PLCConfigurationView';
import { InspectionHistoryView } from './components/history/InspectionHistoryView';
import { DiagnosticsModal } from './components/diagnostics/DiagnosticsModal';
import { LiveInspectionView } from './components/operator/LiveInspectionView';
import './components/SystemMessageTicker.css';
import { SettingsView } from './components/settings/SettingsView';
import { useCamera } from './hooks/useCamera';
import { useInspectionPipeline } from './hooks/useInspectionPipeline';
import { soundService } from './services/audio';
import { dbService } from './services/db';
import { initSeedDataIfEmpty, SEED_PRODUCT_A } from './services/sampleData';
import { MasterProduct, MasterRevision } from './types/master';
import { CameraSourceMode } from './types/device';
import { createRemoteCameraSession } from './services/remoteCamera';
import { PhoneCameraView } from './components/camera/PhoneCameraView';
import { getMasterValidationChecks } from './services/setupValidation';
import { activateAwsSession, endAwsSession, saveConfigurationToAws } from './services/visionCloud';
import { LockKeyhole, ScanLine, ShieldCheck } from 'lucide-react';

function isPhoneCameraRoute() {
  const params = new URLSearchParams(window.location.search);
  return params.get('camera') === 'phone' && Boolean(params.get('session'));
}

export default function App() {
  if (isPhoneCameraRoute()) {
    return <PhoneCameraView />;
  }
  const [entryScreen, setEntryScreen] = useState<'welcome' | 'pin' | 'app'>('welcome');
  const [entryPin, setEntryPin] = useState('');
  const [entryPinError, setEntryPinError] = useState('');
  const [activeTab, setActiveTab] = useState<ActiveTab>('CAMERA_SETUP');
  const [role] = useState<UserRole>('OPERATOR');
  const [isMuted, setIsMuted] = useState(false);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [masters, setMasters] = useState<MasterProduct[]>([]);
  const [activeMaster, setActiveMaster] = useState<MasterProduct | null>(null);
  const [activeRevision, setActiveRevision] = useState<MasterRevision | null>(null);
  const [isSetupModalOpen, setIsSetupModalOpen] = useState(false);
  const [setupMaster, setSetupMaster] = useState<MasterProduct | null>(null);
  const [setupRevision, setSetupRevision] = useState<MasterRevision | null>(null);
  const [cameraSourceMode, setCameraSourceMode] = useState<CameraSourceMode>('LOCAL_CAMERA');
  const [remotePeerId, setRemotePeerId] = useState('');
  const [remoteStatus, setRemoteStatus] = useState<'idle' | 'starting' | 'waiting' | 'connected' | 'error'>('idle');
  const [processingFps, setProcessingFps] = useState(5);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionRecoveryRequired, setSessionRecoveryRequired] = useState(() => localStorage.getItem('vision-ai-session-active') === '1');
  const [setupStep, setSetupStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [setupValidated, setSetupValidated] = useState(false);
  const [setupValidationAttempted, setSetupValidationAttempted] = useState(false);
  const [systemMessage, setSystemMessage] = useState('SYSTEM READY — COMPLETE SETUP TO BEGIN INSPECTION');
  const [systemMessageLevel, setSystemMessageLevel] = useState<'info' | 'success' | 'warning' | 'error'>('info');
  const [sessionStarting, setSessionStarting] = useState(false);
  const [sessionEnding, setSessionEnding] = useState(false);
  const [showEndSessionDialog, setShowEndSessionDialog] = useState(false);
  const [saveError, setSaveError] = useState('');
  const remoteSession = useMemo(() => createRemoteCameraSession(), []);

  const cameraOptions = React.useMemo(() => ({ preferredFacingMode: 'environment' as const, preferredResolution: { width: 800, height: 600 } }), []);
  const camera = useCamera({ ...cameraOptions, sourceMode: cameraSourceMode });
  const pipeline = useInspectionPipeline({ activeMaster, activeRevision, captureFrame: camera.captureFrame, cameraState: camera.cameraState, fps: camera.fps, processingFps, sessionActive });

  useEffect(() => {
    if (cameraSourceMode !== 'PHONE_REMOTE') {
      remoteSession.stop();
      setRemotePeerId('');
      setRemoteStatus('idle');
      return;
    }

    let cancelled = false;
    setRemoteStatus('starting');

    remoteSession
      .startController((stream) => {
        if (cancelled) return;
        camera.attachRemoteStream(stream);
        setRemoteStatus('connected');
      })
      .then((peerId) => {
        if (cancelled) return;
        setRemotePeerId(peerId);
        setRemoteStatus('waiting');
      })
      .catch((error) => {
        console.error('Remote camera controller error:', error);
        if (!cancelled) setRemoteStatus('error');
      });

    return () => {
      cancelled = true;
      remoteSession.stop();
    };
  }, [cameraSourceMode, remoteSession, camera.attachRemoteStream]);

  const phoneCameraUrl = remotePeerId
    ? `${window.location.origin}${import.meta.env.BASE_URL}?camera=phone&session=${encodeURIComponent(remotePeerId)}`
    : '';

  const loadMasters = async () => {
    await initSeedDataIfEmpty();
    const allMasters = await dbService.getAllMasters();
    setMasters(allMasters);
    if (allMasters.length > 0) {
      const current = activeMaster ? allMasters.find((m) => m.id === activeMaster.id) || allMasters[0] : allMasters[0];
      setActiveMaster(current);
      setActiveRevision(current.revisions.find((r) => r.id === current.activeRevisionId) || current.revisions[0]);
    }
  };

  useEffect(() => {
    loadMasters();
    dbService.getPendingSyncCount().then(setPendingSyncCount).catch(console.error);
  }, []);

  const handleSelectMaster = (master: MasterProduct, revisionId?: string) => {
    // Do not allow master/revision changes during an active inspection cycle.
    // This keeps the selected configuration aligned with the physical part
    // and prevents an operator action from bypassing the inspection latch.
    if (sessionActive || pipeline.state !== 'WAITING_FOR_PART') {
      return;
    }

    setActiveMaster(master);
    const revId = revisionId || master.activeRevisionId;
    setActiveRevision(master.revisions.find((r) => r.id === revId) || master.revisions[0]);
    pipeline.resetPipeline();
  };

  const handleOpenSetupModal = (master: MasterProduct, revision: MasterRevision) => {
    if (sessionActive) return;
    setSetupMaster(master); setSetupRevision(revision); setIsSetupModalOpen(true);
  };

  const handleCreateNewMaster = async () => {
    if (sessionActive) return;
    const newIdx = masters.length + 1;
    const now = new Date().toISOString();
    const productId = `prd-${newIdx}-${Date.now()}`;
    const revisionId = `rev-01-${Date.now()}`;
    const baseRevision = activeRevision || masters[0]?.revisions[0] || SEED_PRODUCT_A.revisions[0];
    const newProduct: MasterProduct = {
      id: productId,
      productCode: `PRD-NEW-${String(newIdx).padStart(3, '0')}`,
      productName: `New Product ${newIdx}`,
      description: 'New independent inspection profile. Upload a master image, define ROIs, and add product-specific OK/NG references.',
      activeRevisionId: revisionId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'System Engineer',
      revisions: [{
        ...baseRevision,
        id: revisionId,
        masterId: productId,
        revisionCode: 'REV-01',
        revisionNote: 'New product inspection profile',
        masterImageUrl: '',
        masterWidth: 0,
        masterHeight: 0,
        anchors: [],
        inspectionROIs: [],
        expectedObjectCount: 0,
        referenceImages: [],
        detectionZone: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        roiBoundaryPolicy: 'WARNING',
        createdAt: now,
        updatedAt: now,
      }],
    };
    await dbService.saveMaster(newProduct); await loadMasters(); handleSelectMaster(newProduct, revisionId);
  };

  // Production inspection requires a verified physical or remote camera stream.
  // The virtual simulator is useful for demos but must not satisfy device readiness.
  const cameraReady = camera.cameraState === 'streaming';
  const masterValidationChecks = activeRevision ? getMasterValidationChecks(activeRevision) : [];
  const masterReady = Boolean(activeMaster && activeRevision) && masterValidationChecks.every((check) => check.valid);

  const handleNavigate = (tab: ActiveTab) => {
    // Initial setup behaves like an authentication gate. Until setup is
    // validated, navigation cannot bypass the required sequence.
    if (sessionRecoveryRequired && tab !== 'INSPECTION' && tab !== 'HISTORY') return;
    if (setupStep < 5) return;
    if (sessionActive && tab !== 'INSPECTION' && tab !== 'HISTORY') return;
    setActiveTab(tab);
  };

  const handleNextCameraSetup = () => {
    if (!cameraReady) return;
    setSetupStep(2);
    setActiveTab('MASTERS');
  };

  const handleBackToCameraSetup = () => {
    if (sessionActive) return;
    setSetupStep(1);
    setSetupValidated(false);
    setActiveTab('CAMERA_SETUP');
  };

  const handleNextMasterSetup = () => {
    // Step 3 is the validation center. Do not block the user here just
    // because the master is incomplete; let the validation center explain
    // exactly what is INVALID and how to fix it.
    if (!activeMaster || !activeRevision) return;
    setSetupStep(3);
    setSetupValidated(false);
    setSetupValidationAttempted(false);
    setActiveTab('MASTERS');
  };

  const handleSaveConfiguration = () => {
    setSetupValidationAttempted(true);

    if (!cameraReady || !activeMaster || !activeRevision) {
      setSetupValidated(false);
      return;
    }

    const invalidChecks = getMasterValidationChecks(activeRevision).filter((check) => !check.valid);
    if (invalidChecks.length > 0) {
      setSetupValidated(false);
      return;
    }

    setSetupValidated(true);
    setSetupValidationAttempted(false);
    setSetupStep(4);
  };

  const handleBackToMasterSetup = () => {
    if (sessionActive) return;
    setSetupValidated(false);
    setSetupValidationAttempted(false);
    setSetupStep(2);
    setActiveTab('MASTERS');
  };

  const handleContinueToInspection = () => {
    if (!setupValidated || !cameraReady || !masterReady || sessionActive) {
      setSystemMessage('SETUP NOT READY — REVIEW CAMERA AND MASTER VALIDATION');
      setSystemMessageLevel('warning');
      return;
    }
    setSetupStep(5);
    setActiveTab('INSPECTION');
    setSystemMessage('SETUP VALIDATED — READY TO START INSPECTION SESSION');
    setSystemMessageLevel('success');
  };

  const handleStartSession = async () => {
    if (sessionActive || sessionStarting || !setupValidated || !cameraReady || !masterReady) return;
    setSessionStarting(true);
    setSystemMessage('INITIALIZING INSPECTION SESSION...');
    setSystemMessageLevel('info');
    try {
      const started = await pipeline.startSession();
      if (!started) {
        setSystemMessage('SESSION START FAILED — CAMERA FRAME OR BASELINE IS NOT READY');
        setSystemMessageLevel('error');
        return;
      }
      setSessionActive(true);
      localStorage.setItem('vision-ai-session-active', '1');
      setSystemMessage('INSPECTION SESSION STARTED — CONNECTING TO AWS...');
      setSystemMessageLevel('info');
      void activateAwsSession({
        productCode: activeMaster?.productCode || 'UNKNOWN',
        revisionCode: activeRevision?.revisionCode || 'UNKNOWN',
      }).then(() => {
        setSystemMessage('AWS SESSION EVENT ACCEPTED — LIVE INSPECTION IS RUNNING');
        setSystemMessageLevel('success');
      }).catch((error) => {
        console.error('[AWS session activation]', error);
        setSystemMessage('AWS ACTIVATION FAILED — LOCAL INSPECTION IS RUNNING; CLOUD EVENT WAS NOT CONFIRMED');
        setSystemMessageLevel('warning');
      });
    } catch (error) {
      console.error('[Inspection session start]', error);
      setSystemMessage('SESSION START FAILED — PLEASE CHECK CAMERA AND TRY AGAIN');
      setSystemMessageLevel('error');
    } finally {
      setSessionStarting(false);
    }
  };

  const handleEndSessionRequest = () => {
    if (!sessionActive || pipeline.state !== 'WAITING_FOR_PART' || sessionEnding) return;
    setSaveError('');
    setShowEndSessionDialog(true);
  };

  const finalizeEndSession = (message: string, level: 'success' | 'warning' | 'error' = 'success') => {
    pipeline.resetPipeline();
    setSessionActive(false);
    localStorage.removeItem('vision-ai-session-active');
    setSessionRecoveryRequired(false);
    setSetupValidated(false);
    setSetupValidationAttempted(false);
    setSetupStep(1);
    setActiveTab('CAMERA_SETUP');
    setShowEndSessionDialog(false);
    setSystemMessage(message);
    setSystemMessageLevel(level);
  };

  const handleEndWithoutSaving = async () => {
    if (sessionEnding) return;
    setSessionEnding(true);
    finalizeEndSession('LIVE INSPECTION ENDED — CONFIGURATION WAS NOT SAVED', 'warning');
    setSessionEnding(false);
    void endAwsSession({
      productCode: activeMaster?.productCode || 'UNKNOWN',
      revisionCode: activeRevision?.revisionCode || 'UNKNOWN',
    }).catch((error) => {
      console.error('[AWS session end]', error);
      setSystemMessage('LIVE INSPECTION ENDED — AWS END EVENT COULD NOT BE CONFIRMED');
      setSystemMessageLevel('warning');
    });
  };

  const handleSaveAndEndSession = async () => {
    if (sessionEnding) return;
    setSessionEnding(true);
    setSaveError('');
    setSystemMessage('SAVING CONFIGURATION TO AWS...');
    setSystemMessageLevel('info');
    try {
      await saveConfigurationToAws({
        setupStep,
        camera: { sourceMode: cameraSourceMode, selectedDeviceId: camera.selectedDeviceId },
        master: activeMaster,
        revision: activeRevision,
        savedAt: new Date().toISOString(),
      });
      finalizeEndSession('CONFIGURATION SAVED — LIVE INSPECTION SESSION ENDED', 'success');
      void endAwsSession({ productCode: activeMaster?.productCode || 'UNKNOWN', revisionCode: activeRevision?.revisionCode || 'UNKNOWN' }).catch((error) => {
        console.error('[AWS session end]', error);
        setSystemMessage('CONFIGURATION SAVE CONFIRMED — AWS END EVENT COULD NOT BE CONFIRMED');
        setSystemMessageLevel('warning');
      });
    } catch (error) {
      console.error('[AWS configuration save]', error);
      const message = error instanceof Error ? error.message : 'Unknown cloud storage error';
      setSaveError(message);
      setSystemMessage('CONFIGURATION SAVE FAILED — SESSION IS STILL ACTIVE; RETRY OR END WITHOUT SAVING');
      setSystemMessageLevel('error');
    } finally {
      setSessionEnding(false);
    }
  };

  const handlePinUnlock = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const configuredPin = String(import.meta.env.VITE_ENGINEERING_PIN ?? '').trim();
    if (!configuredPin) {
      setEntryPinError('Engineering PIN belum dikonfigurasi. Set VITE_ENGINEERING_PIN pada environment build.');
      setEntryPin('');
      return;
    }
    if (entryPin !== configuredPin) {
      setEntryPinError('PIN tidak sesuai. Silakan coba lagi.');
      setEntryPin('');
      return;
    }
    setEntryPin('');
    setEntryPinError('');
    setEntryScreen('app');
  };

  const handleEntryLock = () => {
    if (sessionActive) return;
    sessionStorage.removeItem('vision-ai-engineering-unlocked');
    setEntryScreen('welcome');
  };

  const handleSync = async () => { await dbService.flushSyncQueue(); setPendingSyncCount(await dbService.getPendingSyncCount()); };
  const toggleMute = () => { const next = !isMuted; setIsMuted(next); soundService.setMuted(next); };

  if (entryScreen === 'app' && sessionRecoveryRequired) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <section className="w-full max-w-xl rounded-3xl border border-amber-500/30 bg-slate-900 p-7 sm:p-10 shadow-2xl">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-400/30 bg-amber-400/10 text-amber-300">
            <LockKeyhole size={32} />
          </div>
          <p className="text-center text-xs font-mono uppercase tracking-[0.25em] text-amber-300">Session recovery lock</p>
          <h1 className="mt-3 text-center text-2xl font-black">Previous inspection session detected</h1>
          <p className="mt-4 text-sm leading-6 text-slate-300">The application was closed or refreshed while a session was marked active. Setup and master changes remain locked until the station is checked.</p>
          <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-100">
            Confirm that the part has been removed from the jig and the machine is in a safe state before ending the recovered session.
          </div>
          <button type="button" onClick={() => finalizeEndSession('RECOVERED SESSION ENDED — VERIFY STATION BEFORE RESTARTING', 'warning')} disabled={pipeline.state !== 'WAITING_FOR_PART'} className="mt-6 w-full rounded-xl bg-amber-400 px-5 py-4 text-sm font-black text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40">CONFIRM SAFE STATE & END SESSION</button>
          <p className="mt-3 text-center text-[10px] font-mono text-slate-500">If the system is not safe, do not continue.</p>
        </section>
      </div>
    );
  }

  if (entryScreen !== 'app') {
    return (
      <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="pointer-events-none absolute -top-32 -left-24 h-96 w-96 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -right-24 h-96 w-96 rounded-full bg-blue-600/10 blur-3xl" />
        <section className="relative w-full max-w-xl rounded-3xl border border-slate-800 bg-slate-900/90 p-7 sm:p-10 shadow-2xl">
          <div className="flex items-center gap-3 mb-10">
            <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-3 text-cyan-300"><ScanLine size={28} /></div>
            <div><div className="text-xs font-mono tracking-[0.25em] text-cyan-300">INTELLIGENT VISUAL INSPECTION</div><div className="text-lg font-black tracking-wide">VISION-AI AWS</div></div>
          </div>
          {entryScreen === 'welcome' ? (
            <div className="text-center">
              <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-3xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300"><ShieldCheck size={42} strokeWidth={1.5} /></div>
              <div className="text-[10px] font-mono uppercase tracking-[0.3em] text-slate-500">Inspection station</div>
              <h1 className="mt-3 text-3xl sm:text-4xl font-black tracking-tight text-white">Precision in every inspection.</h1>
              <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-slate-400">Quality in every part. Complete the protected setup and verify every prerequisite before starting an inspection session.</p>
              <button onClick={() => setEntryScreen('pin')} className="w-full rounded-xl bg-cyan-400 px-5 py-4 text-sm font-black text-slate-950 transition hover:bg-cyan-300">BEGIN INITIAL SETUP <span aria-hidden="true">→</span></button>
              <p className="mt-4 text-[10px] font-mono text-slate-600">ENGINEERING ACCESS REQUIRED</p>
            </div>
          ) : (
            <form onSubmit={handlePinUnlock} className="mx-auto max-w-sm">
              <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-400/30 bg-amber-400/10 text-amber-300"><LockKeyhole size={32} /></div>
              <h1 className="text-center text-2xl font-black">Engineering PIN</h1>
              <p className="mt-2 text-center text-sm text-slate-400">Masukkan PIN sebelum membuka konfigurasi kamera dan master inspeksi.</p>
              <label className="mt-7 block text-xs font-bold uppercase tracking-wider text-slate-400" htmlFor="engineering-pin">PIN</label>
              <input id="engineering-pin" autoFocus inputMode="numeric" type="password" autoComplete="current-password" value={entryPin} onChange={(event) => { setEntryPin(event.target.value); setEntryPinError(''); }} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-4 text-center text-xl tracking-[0.5em] text-white outline-none focus:border-cyan-400" placeholder="••••••" required />
              {entryPinError && <p role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{entryPinError}</p>}
              <button type="submit" className="mt-5 w-full rounded-xl bg-cyan-400 px-5 py-4 text-sm font-black text-slate-950 hover:bg-cyan-300">UNLOCK SETUP</button>
              <button type="button" onClick={() => { setEntryPin(''); setEntryPinError(''); setEntryScreen('welcome'); }} className="mt-3 w-full rounded-xl border border-slate-700 px-5 py-3 text-sm font-semibold text-slate-400 hover:text-white">Back</button>
            </form>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen rvi-app text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-slate-950">
      <Navbar activeTab={activeTab} setActiveTab={handleNavigate} role={role} setRole={() => undefined} activeMaster={activeMaster} activeRevision={activeRevision} isMuted={isMuted} toggleMute={toggleMute} pendingSyncCount={pendingSyncCount} onSync={handleSync} />
      <div className={`rvi-system-ticker is-${systemMessageLevel}`} role="status" aria-live="polite">
        <span className="rvi-system-ticker-label">SYSTEM MESSAGE</span>
        <div className="rvi-system-ticker-window"><div className="rvi-system-ticker-track"><span>{systemMessage}</span><span aria-hidden="true">{systemMessage}</span></div></div>
      </div>
      {!sessionActive && <div className="mx-auto flex w-full max-w-[1500px] justify-end px-3 pt-2"><button type="button" onClick={handleEntryLock} className="rounded-lg border border-slate-800 px-3 py-1.5 text-[10px] font-mono text-slate-500 hover:border-amber-400/40 hover:text-amber-300">LOCK ENGINEERING ACCESS</button></div>}
      <main className="rvi-main flex-1 max-w-[1500px] w-full mx-auto p-3 sm:p-5 lg:p-6">
        {setupStep === 1 && (
          <CameraCalibrationView
            devices={camera.devices}
            selectedDeviceId={camera.selectedDeviceId}
            setSelectedDeviceId={camera.setSelectedDeviceId}
            sourceMode={cameraSourceMode}
            setSourceMode={setCameraSourceMode}
            cameraState={camera.cameraState}
            remotePeerId={remotePeerId}
            remoteStatus={remoteStatus}
            phoneCameraUrl={phoneCameraUrl}
            videoRef={camera.videoRef}
            fps={camera.fps}
            videoDimensions={camera.videoDimensions}
            captureFrame={camera.captureFrame}
            onNextSetup={handleNextCameraSetup}
            onSwitchToStandSimulator={() => camera.enableVirtualMode('PERFECT_PASS')}
          />
        )}

        {setupStep === 2 && (
          <MasterManager
            masters={masters}
            activeMaster={activeMaster}
            activeRevision={activeRevision}
            onSelectMaster={handleSelectMaster}
            onRefreshMasters={loadMasters}
            onOpenSetupModal={handleOpenSetupModal}
            onCreateNewMaster={handleCreateNewMaster}
            onBackSetup={handleBackToCameraSetup}
            onContinueSetup={handleNextMasterSetup}
          />
        )}

        {setupStep === 3 && (
          <section className="space-y-5">
            <div className="rounded-2xl border border-cyan-500/30 bg-slate-950 p-5">
              <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-400">Setup 03 / 05</div>
              <h1 className="mt-1 text-xl font-bold text-white">SAVE CONFIGURATION + VALIDATE SETUP</h1>
              <p className="mt-1 text-xs font-mono text-slate-500">Validation Center — every required item is shown explicitly as PASS or INVALID before operation is unlocked.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <div className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">Device / Camera</div>
                <div className="flex items-center justify-between rounded-xl bg-slate-950 px-4 py-3">
                  <span className="text-sm text-white">Camera stream</span>
                  <span className={cameraReady ? "text-emerald-300 text-xs font-bold" : "text-red-300 text-xs font-bold"}>{cameraReady ? 'READY' : 'NOT READY'}</span>
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <div className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">Master Part</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between rounded-xl bg-slate-950 px-4 py-3">
                    <span className="text-sm text-white truncate">{activeMaster?.productCode || 'No master selected'}</span>
                    <span className={masterReady ? "text-emerald-300 text-xs font-bold" : "text-red-300 text-xs font-bold"}>{masterReady ? 'VALID' : 'INVALID'}</span>
                  </div>
                  <div className="space-y-1">
                    {masterValidationChecks.map((check) => (
                      <div key={check.label} className="space-y-1">
                        <div className="flex items-center justify-between gap-3 text-[10px] font-mono">
                          <span className={check.valid ? 'text-slate-400' : 'text-red-300'}>{check.label}</span>
                          <span className={check.valid ? 'text-emerald-300' : 'text-rose-300'}>{check.valid ? 'PASS' : 'INVALID'}</span>
                        </div>
                        {!check.valid && <div className="pl-1 text-[10px] font-mono text-rose-200">→ {check.error}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {setupValidationAttempted && (!cameraReady || !masterReady) && (
              <div className="rounded-2xl border border-rose-500/40 bg-rose-950/20 p-4">
                <div className="text-sm font-black text-rose-200">SETUP VALIDATION — INVALID</div>
                <div className="mt-1 text-xs text-rose-200/80">
                  {[
                    !cameraReady ? 'Camera is NOT READY.' : null,
                    !activeMaster ? 'No master part is selected.' : null,
                    ...masterValidationChecks.filter((check) => !check.valid).map((check) => check.label + ': ' + check.error),
                  ].filter(Boolean).map((message, index) => (
                    <div key={String(message) + index} className="mt-1">• {message}</div>
                  ))}
                </div>
                <button type="button" onClick={handleBackToMasterSetup} className="mt-3 px-4 py-2 rounded-xl border border-rose-500/30 bg-rose-950/30 text-rose-200 text-xs font-bold hover:bg-rose-950/50">
                  FIX MASTER CONFIGURATION
                </button>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <button type="button" onClick={handleBackToMasterSetup} className="px-4 py-2 rounded-xl border border-slate-700 bg-slate-950 text-slate-300 text-xs font-bold hover:text-white">← BACK: MASTER PART</button>
              <button
                type="button"
                onClick={handleSaveConfiguration}
                className="px-5 py-2.5 rounded-xl bg-emerald-500 text-slate-950 text-xs font-black hover:bg-emerald-400"
              >
                SAVE CONFIGURATION + VALIDATE
              </button>
            </div>
          </section>
        )}

        {setupStep === 4 && (
          <section className="space-y-5">
            <div className="rounded-2xl border border-emerald-500/30 bg-slate-950 p-6 text-center">
              <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-400">Setup 04 / 05</div>
              <h1 className="mt-2 text-2xl font-black text-white">SETUP VALIDATED ✓</h1>
              <p className="mt-2 text-xs font-mono text-slate-400">All prerequisites are valid. Configuration will lock only after START begins the operation session.</p>
            </div>
            <div className="mx-auto max-w-2xl rounded-3xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                <div className="rounded-xl bg-slate-950 p-4"><div className="text-[10px] font-mono text-slate-500">CAMERA</div><div className="mt-1 font-bold text-emerald-300">READY</div></div>
                <div className="rounded-xl bg-slate-950 p-4"><div className="text-[10px] font-mono text-slate-500">MASTER</div><div className="mt-1 font-bold text-emerald-300">VALID</div></div>
                <div className="rounded-xl bg-slate-950 p-4"><div className="text-[10px] font-mono text-slate-500">CONFIG</div><div className="mt-1 font-bold text-cyan-300">READY</div></div>
              </div>
              <button type="button" onClick={handleContinueToInspection} className="w-full rounded-2xl bg-emerald-500 py-4 text-sm font-black text-slate-950 hover:bg-emerald-400">
                START
              </button>
              <button type="button" onClick={handleBackToMasterSetup} className="mt-3 w-full rounded-xl border border-slate-800 py-2.5 text-xs font-bold text-slate-400 hover:text-white">
                ← BACK TO CONFIGURATION
              </button>
            </div>
          </section>
        )}

        {setupStep === 5 && activeTab === 'INSPECTION' && (
          <LiveInspectionView videoRef={camera.videoRef} canvasRef={camera.canvasRef} cameraState={camera.cameraState} errorMessage={camera.errorMessage} fps={camera.fps} videoDimensions={camera.videoDimensions} state={pipeline.state} stabilizationProgress={pipeline.stabilizationProgress} motionDelta={pipeline.motionDelta} currentResult={pipeline.currentResult} latestAlignment={pipeline.latestAlignment} latestRoiResults={pipeline.latestRoiResults} latestExtraObjects={pipeline.latestExtraObjects} stats={pipeline.stats} liveMetrics={pipeline.liveMetrics} plcHandshake={pipeline.plcHandshake} plcSignals={pipeline.plcSignals} activeMaster={activeMaster} activeRevision={activeRevision} role={role} processingFps={processingFps} setProcessingFps={setProcessingFps} isVirtualMode={camera.isVirtualMode} virtualScenario={camera.virtualScenario} setVirtualScenario={camera.setVirtualScenario} enableVirtualMode={camera.enableVirtualMode} enablePhysicalCamera={camera.enablePhysicalCamera} onOpenHistory={() => setActiveTab('HISTORY')} onOpenPlcConfig={() => handleNavigate('SETTINGS')} onEndSession={handleEndSessionRequest} onStartSession={handleStartSession} sessionActive={sessionActive} sessionStarting={sessionStarting} />)}
        {setupStep === 5 && activeTab === 'HISTORY' && <InspectionHistoryView onRefreshStats={pipeline.refreshStats} />}
        {setupStep === 5 && activeTab === 'SETTINGS' && <SettingsView onNavigate={handleNavigate} onClose={() => setActiveTab('INSPECTION')} />}
        {setupStep === 5 && activeTab === 'MASTERS' && <MasterManager masters={masters} activeMaster={activeMaster} activeRevision={activeRevision} onSelectMaster={handleSelectMaster} onRefreshMasters={loadMasters} onOpenSetupModal={handleOpenSetupModal} onCreateNewMaster={handleCreateNewMaster} onBackSetup={handleBackToCameraSetup} onContinueSetup={handleNextMasterSetup} />}
        {setupStep === 5 && activeTab === 'PLC_SETUP' && <PLCConfigurationView />}
        {setupStep === 5 && activeTab === 'DIAGNOSTICS' && <DiagnosticsModal metrics={pipeline.liveMetrics} />}
      </main>
      {setupStep === 2 && isSetupModalOpen && setupMaster && setupRevision && <MasterSetupModal master={setupMaster} revision={setupRevision} isOpen={isSetupModalOpen} onClose={() => setIsSetupModalOpen(false)} onSaved={loadMasters} />}
      {showEndSessionDialog && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="end-session-title" className="w-full max-w-lg rounded-2xl border border-amber-500/40 bg-slate-950 p-6 shadow-2xl">
            <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-amber-300">Session control</div>
            <h2 id="end-session-title" className="mt-2 text-xl font-black text-white">END LIVE INSPECTION</h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">Are you sure you want to end Live Inspection? Would you like to save your setup configuration, master configuration, and camera settings to AWS before ending the session?</p>
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">The session will end with either choice. Saving is confirmed only after AWS acknowledges the configuration write.</div>
            {saveError && <div role="alert" className="mt-3 rounded-lg border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-200">SAVE FAILED: {saveError}</div>}
            <div className="mt-5 grid grid-cols-1 gap-2">
              <button type="button" onClick={handleSaveAndEndSession} disabled={sessionEnding} className="rounded-xl bg-emerald-400 px-4 py-3 text-xs font-black text-slate-950 hover:bg-emerald-300 disabled:opacity-50">{sessionEnding ? 'SAVING...' : 'SAVE & END SESSION'}</button>
              <button type="button" onClick={handleEndWithoutSaving} disabled={sessionEnding} className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs font-black text-amber-200 hover:bg-amber-500/20 disabled:opacity-50">END WITHOUT SAVING</button>
              <button type="button" onClick={() => { setShowEndSessionDialog(false); setSaveError(''); setSystemMessage('LIVE INSPECTION CONTINUES'); setSystemMessageLevel('info'); }} disabled={sessionEnding} className="rounded-xl border border-slate-700 px-4 py-3 text-xs font-bold text-slate-300 hover:bg-slate-900 disabled:opacity-50">CANCEL</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
