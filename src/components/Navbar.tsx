/**
 * Industrial Top Navigation Bar
 */
import React from 'react';
import { ScanLine, ClipboardCheck, Volume2, VolumeX, Wifi, RefreshCw, Settings, Cloud, Cpu } from 'lucide-react';
import { MasterProduct, MasterRevision } from '../types/master';
import { getRuntimeIdentity } from '../services/runtimeConfig';

export type ActiveTab = 'INSPECTION' | 'MASTERS' | 'CAMERA_SETUP' | 'PLC_SETUP' | 'HISTORY' | 'DIAGNOSTICS' | 'SETTINGS';
export type UserRole = 'OPERATOR' | 'ENGINEER' | 'APPROVER' | 'ADMIN';

interface NavbarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  role: UserRole;
  setRole: (role: UserRole) => void;
  activeMaster: MasterProduct | null;
  activeRevision: MasterRevision | null;
  isMuted: boolean;
  toggleMute: () => void;
  pendingSyncCount: number;
  onSync: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ activeTab, setActiveTab, activeMaster, activeRevision, isMuted, toggleMute, pendingSyncCount, onSync }) => {
  const identity = getRuntimeIdentity();
  return (
    <header className="rvi-topbar text-slate-100 select-none">
      <div className="rvi-topbar-inner max-w-[1500px] mx-auto px-3 sm:px-5 lg:px-6 flex items-center justify-between gap-4">
        <button onClick={() => setActiveTab('INSPECTION')} className="flex items-center gap-3 min-w-0 text-left">
          <div className="rvi-brand-mark shrink-0"><ScanLine className="w-5 h-5" strokeWidth={1.8} /></div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-sm sm:text-[15px] tracking-wide text-white truncate">VISION-AI AWS</span><span className="rvi-aws-badge"><Cloud className="w-3 h-3" /> AWS HACKATHON</span></div>
            {activeMaster && activeRevision ? <div className="flex items-center gap-2 text-[11px] text-slate-400 truncate"><span className="text-cyan-300 font-medium truncate">{activeMaster.productCode}</span><span className="text-slate-600">/</span><span className="font-mono text-slate-300">{activeRevision.revisionCode}</span><span className="text-slate-600">/</span><span>{activeRevision.expectedObjectCount} inspection points</span><span className="text-slate-600">/</span><span className="font-mono text-slate-500">{identity.stationId}</span><span className="rvi-aws-meta hidden sm:inline-flex items-center gap-1"><Cpu className="w-3 h-3" /> OpenCV 5 · Lambda</span></div> : <div className="text-[11px] text-amber-400">No active master</div>}
          </div>
        </button>

        <nav className="rvi-nav hidden md:flex items-center gap-1">
          <button onClick={() => setActiveTab('INSPECTION')} className={`rvi-nav-item flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-medium ${activeTab === 'INSPECTION' ? 'is-active text-cyan-300 font-semibold' : 'text-slate-400'}`}><ScanLine className="w-4 h-4" /><span>Camera</span></button>
          <button onClick={() => setActiveTab('HISTORY')} className={`rvi-nav-item flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-medium ${activeTab === 'HISTORY' ? 'is-active text-cyan-300 font-semibold' : 'text-slate-400'}`}><ClipboardCheck className="w-4 h-4" /><span>History</span></button>
        </nav>

        <div className="flex items-center gap-2">
          <button onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'} className="rvi-toolbar-pill p-2 rounded-lg text-slate-400 hover:text-slate-200">{isMuted ? <VolumeX className="w-4 h-4 text-amber-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}</button>
          <button onClick={onSync} title={pendingSyncCount > 0 ? `${pendingSyncCount} inspections queued` : 'All inspections saved'} className="rvi-toolbar-pill flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-slate-300">{pendingSyncCount > 0 ? <><RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" /><span className="font-mono text-amber-400">{pendingSyncCount}</span></> : <><Wifi className="w-3.5 h-3.5 text-emerald-400" /><span className="hidden lg:inline text-slate-400">Synced</span></>}</button>
          <button onClick={() => setActiveTab('SETTINGS')} title="Protected Engineering Settings" className={`rounded-xl p-2 border transition ${activeTab === 'SETTINGS' ? 'border-amber-400/50 bg-amber-500/10 text-amber-300' : 'border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800'}`}><Settings className="w-4 h-4" /></button>
        </div>
      </div>
    </header>
  );
};
