/**
 * Inspection History & Audit Trail View
 * Displays database records, filters, thumbnails, alignment vectors, and CSV export.
 */

import React, { useEffect, useState } from 'react';
import {
  History,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Download,
  Trash2,
  Search,
  ExternalLink,
  RefreshCw,
  X,
  FileSpreadsheet,
} from 'lucide-react';
import { dbService } from '../../services/db';
import { InspectionRecord } from '../../types/inspection';

interface InspectionHistoryViewProps {
  onRefreshStats: () => void;
}

export const InspectionHistoryView: React.FC<InspectionHistoryViewProps> = ({ onRefreshStats }) => {
  const [records, setRecords] = useState<InspectionRecord[]>([]);
  const [filterJudgement, setFilterJudgement] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedRecord, setSelectedRecord] = useState<InspectionRecord | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchRecords = async () => {
    setIsLoading(true);
    try {
      const data = await dbService.getFilteredInspections({
        judgement: filterJudgement,
        search: searchQuery,
      });
      setRecords(data);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
  }, [filterJudgement, searchQuery]);

  // Export to CSV
  const handleExportCsv = () => {
    if (records.length === 0) return;

    const headers = [
      'Inspection ID',
      'Timestamp',
      'Product Code',
      'Master Revision',
      'Judgement',
      'Expected Screws',
      'Detected Screws',
      'Primary Reason',
      'Cycle Time (ms)',
      'Alignment Translation X',
      'Alignment Translation Y',
      'Alignment Rotation Deg',
      'Device ID',
    ];

    const rows = records.map((r) => [
      r.id,
      r.timestamp,
      r.productCode,
      r.masterRevisionCode,
      r.judgement,
      r.expectedCount,
      r.detectedCount,
      `"${r.primaryReason.replace(/"/g, '""')}"`,
      r.metrics?.totalCycleMs || 0,
      r.alignment?.translationX || 0,
      r.alignment?.translationY || 0,
      r.alignment?.rotationDeg || 0,
      r.deviceId,
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `inspection_log_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleClearHistory = async () => {
    if (!confirm('Clear all inspection history and reset the live Total Count, OK, NG, Yield Rate, and cycle-time statistics? This action cannot be undone.')) return;

    try {
      setIsLoading(true);
      await dbService.clearInspectionHistory();
      setRecords([]);
      setSelectedRecord(null);
      await onRefreshStats();
      await fetchRecords();
    } catch (error) {
      console.error('[Clear History]', error);
      window.alert('Could not fully clear inspection history. Check the application logs and database connection.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-cyan-400">
            <History className="w-5 h-5" />
            <h2 className="text-xl font-bold text-white">Inspection Audit History & Database</h2>
          </div>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Complete traceability of every automatic visual inspection cycle with stored defect reasons.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCsv}
            disabled={records.length === 0}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-800 text-slate-200 border border-slate-700 text-xs font-semibold hover:bg-slate-700 disabled:opacity-50"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
            <span>Export CSV</span>
          </button>

          <button
            onClick={handleClearHistory}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 text-slate-400 border border-slate-800 text-xs hover:text-red-400 hover:border-red-900/60"
          >
            <Trash2 className="w-4 h-4" />
            <span>Clear History & Counters</span>
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
        {/* Judgement filter tabs */}
        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs font-mono">
          {['ALL', 'OK', 'NG', 'INVALID', 'ERROR'].map((tab) => (
            <button
              key={tab}
              onClick={() => setFilterJudgement(tab)}
              className={`px-3 py-1.5 rounded-lg transition-colors ${
                filterJudgement === tab
                  ? 'bg-slate-800 text-cyan-400 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab === 'ALL' ? 'All Results' : tab}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by Reason, ID, Product..."
            className="w-full bg-slate-950 text-slate-200 text-xs font-mono pl-9 pr-4 py-2 rounded-xl border border-slate-800 focus:outline-none focus:border-cyan-500"
          />
        </div>
      </div>

      {/* Records Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Inspection ID</th>
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Product / Rev</th>
                <th className="py-3 px-4">Count</th>
                <th className="py-3 px-4">Primary Reason</th>
                <th className="py-3 px-4">Cycle Time</th>
                <th className="py-3 px-4 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {records.length > 0 ? (
                records.map((r) => {
                  const isOk = r.judgement === 'OK';
                  const isNg = r.judgement === 'NG';
                  const isInvalid = r.judgement === 'INVALID';

                  return (
                    <tr
                      key={r.id}
                      onClick={() => setSelectedRecord(r)}
                      className="hover:bg-slate-800/50 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded font-bold ${
                            isOk
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-700/80'
                              : isNg
                              ? 'bg-red-950 text-red-300 border border-red-700/80'
                              : isInvalid
                              ? 'bg-amber-950 text-amber-300 border border-amber-700/80'
                              : 'bg-slate-800 text-slate-300 border border-slate-700/80'
                          }`}
                        >
                          {isOk ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          ) : isNg ? (
                            <XCircle className="w-3.5 h-3.5 text-red-400" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                          )}
                          <span>{r.judgement}</span>
                        </span>
                      </td>
                      <td className="py-3 px-4 text-cyan-400 font-semibold">{r.id.split('-').slice(0, 2).join('-')}</td>
                      <td className="py-3 px-4 text-slate-400">
                        {new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-white font-medium">{r.productCode}</span>
                        <span className="text-slate-500 ml-1">({r.masterRevisionCode})</span>
                      </td>
                      <td className="py-3 px-4">
                        <span className={r.detectedCount === r.expectedCount ? 'text-emerald-400' : 'text-red-400'}>
                          {r.detectedCount} / {r.expectedCount}
                        </span>
                      </td>
                      <td className="py-3 px-4 max-w-xs truncate text-slate-200">
                        {r.primaryReason}
                      </td>
                      <td className="py-3 px-4 text-slate-400">{r.metrics?.totalCycleMs || 0} ms</td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedRecord(r);
                          }}
                          className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    No inspection records found matching the filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inspection Record Detail Modal */}
      {selectedRecord && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span
                  className={`px-3 py-1 rounded-lg font-bold font-mono text-sm ${
                    selectedRecord.judgement === 'OK'
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-500'
                      : selectedRecord.judgement === 'NG'
                      ? 'bg-red-950 text-red-300 border border-red-500'
                      : selectedRecord.judgement === 'INVALID'
                      ? 'bg-amber-950 text-amber-300 border border-amber-500'
                      : 'bg-slate-800 text-slate-200 border border-slate-500'
                  }`}
                >
                  {selectedRecord.judgement}
                </span>
                <div>
                  <h3 className="text-base font-bold text-white">{selectedRecord.id}</h3>
                  <div className="text-xs font-mono text-slate-400">
                    {selectedRecord.productName} ({selectedRecord.masterRevisionCode}) · {new Date(selectedRecord.timestamp).toLocaleString()}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setSelectedRecord(null)}
                className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Primary Judgement Reason */}
              <div
                className={`p-4 rounded-2xl border ${
                  selectedRecord.judgement === 'OK'
                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                    : selectedRecord.judgement === 'NG'
                    ? 'bg-red-950/40 border-red-500/40 text-red-200'
                    : selectedRecord.judgement === 'INVALID'
                    ? 'bg-amber-950/40 border-amber-500/40 text-amber-200'
                    : 'bg-slate-800/40 border-slate-600/40 text-slate-200'
                }`}
              >
                <div className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-1">
                  Judgement Summary
                </div>
                <div className="text-lg font-bold">{selectedRecord.primaryReason}</div>
              </div>

              {/* Thumbnail and Alignment Information */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {selectedRecord.thumbnailBase64 && (
                  <div className="bg-slate-950 rounded-2xl p-3 border border-slate-800 flex flex-col items-center justify-center">
                    <span className="text-[11px] font-mono text-slate-400 mb-2">Captured Frame Capture</span>
                    <img
                      src={selectedRecord.thumbnailBase64}
                      alt="Inspection Thumbnail"
                      className="rounded-lg max-h-40 object-contain border border-slate-800"
                    />
                  </div>
                )}

                <div className="bg-slate-950 rounded-2xl p-4 border border-slate-800 space-y-2 text-xs font-mono">
                  <span className="text-slate-400 uppercase tracking-wider text-[11px]">Alignment Vector</span>
                  <div className="space-y-1 text-slate-300">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Translation X:</span>
                      <span className="text-white">{selectedRecord.alignment?.translationX || 0} px</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Translation Y:</span>
                      <span className="text-white">{selectedRecord.alignment?.translationY || 0} px</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Rotation Angle:</span>
                      <span className="text-white">{selectedRecord.alignment?.rotationDeg || 0}°</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Scale Factor:</span>
                      <span className="text-white">{selectedRecord.alignment?.scale || 1.0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Anchor Confidence:</span>
                      <span className="text-cyan-400">{((selectedRecord.alignment?.confidence || 0) * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Per-ROI Breakdown */}
              <div className="space-y-2">
                <span className="text-xs font-mono uppercase tracking-wider text-slate-400">
                  Per-ROI Inspection Measurements
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {selectedRecord.roiResults?.map((r) => (
                    <div
                      key={r.roiId}
                      className={`p-3 rounded-xl border text-xs font-mono flex items-center justify-between ${
                        r.status === 'PASS'
                          ? 'bg-slate-950 border-emerald-900/60 text-slate-300'
                          : 'bg-red-950/30 border-red-900/60 text-red-300'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-white">{r.roiName}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Offset: +{r.positionOffsetMm}mm · Conf: {(r.confidence * 100).toFixed(0)}%
                        </div>
                      </div>

                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          r.status === 'PASS' ? 'bg-emerald-950 text-emerald-400' : 'bg-red-900 text-red-200'
                        }`}
                      >
                        {r.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* PLC Interlock & Event Timeline (Sections 54 & 55) */}
              <div className="bg-slate-950 rounded-2xl p-4 border border-slate-800 space-y-3 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 uppercase tracking-wider text-[11px]">
                    PLC Handshake & Interlock Gate
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        selectedRecord.plcInterlockState === 'PERMITTED'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-600'
                          : 'bg-red-950 text-red-300 border border-red-600'
                      }`}
                    >
                      {selectedRecord.plcInterlockState || (selectedRecord.judgement === 'OK' ? 'PERMITTED' : 'BLOCKED')}
                    </span>
                    {selectedRecord.plcCommLatencyMs !== undefined && (
                      <span className="text-[11px] text-cyan-400">ACK: {selectedRecord.plcCommLatencyMs}ms</span>
                    )}
                  </div>
                </div>

                {selectedRecord.plcTimeline && selectedRecord.plcTimeline.length > 0 && (
                  <div className="space-y-1.5 pt-2 border-t border-slate-800/80 max-h-40 overflow-y-auto pr-1">
                    {selectedRecord.plcTimeline.map((ev, idx) => (
                      <div key={idx} className="flex items-baseline justify-between text-[11px] text-slate-300">
                        <div className="flex items-center gap-2">
                          <span className="text-cyan-400 font-bold">+{ev.elapsedMs}ms</span>
                          <span
                            className={`text-[9px] px-1 py-0.2 rounded font-semibold ${
                              ev.source === 'PLC'
                                ? 'bg-blue-950 text-blue-300'
                                : ev.source === 'VISION'
                                ? 'bg-purple-950 text-purple-300'
                                : 'bg-emerald-950 text-emerald-300'
                            }`}
                          >
                            {ev.source}
                          </span>
                          <span className="text-white">{ev.eventName}</span>
                        </div>
                        <span className="text-slate-500 text-[10px]">{ev.description}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
