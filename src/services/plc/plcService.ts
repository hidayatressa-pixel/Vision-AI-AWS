/**
 * Central PLC Manager Service
 * Orchestrates heartbeat watchdog, handshakes, interlock state,
 * event timeline logging, and fail-safe process permission.
 */

import {
  InterlockState,
  PLCConfiguration,
  PLCConnectionStatus,
  PLCEventLogItem,
  PLCHandshakeState,
  PLCInspectionPayload,
  PLCLiveSignals,
  PLCTriggerMode,
} from '../../types/plc';
import { NetworkPLCAdapter } from './networkPlcAdapter';
import { PLCAdapter } from './plcAdapter';
import { SimulatedPLCAdapter } from './simulatedPlcAdapter';

const DEFAULT_CONFIG: PLCConfiguration = {
  // MVP mode: inspection runs locally without PLC communication.
  enabled: false,
  protocol: 'SIMULATION',
  ipAddress: '192.168.1.100',
  port: 502,
  gatewayBaseUrl: '/api/plc',
  reconnectIntervalMs: 3000,
  connectionTimeoutMs: 2500,
  heartbeatIntervalMs: 500,
  heartbeatTimeoutMs: 1500,
  ackTimeoutMs: 1000,
  maxInspectionTimeoutMs: 2000,
  resultHoldTimeMs: 600,
  triggerMode: 'AUTO_CAMERA',
  tags: {
    plcReady: 'I:0/0 (PLC_READY)',
    machineReady: 'I:0/1 (MACHINE_READY)',
    partPresent: 'I:0/2 (PART_PRESENT)',
    cycleActive: 'I:0/3 (CYCLE_ACTIVE)',
    ackResult: 'I:0/4 (ACK_RESULT)',
    resetRequest: 'I:0/5 (RESET_REQUEST)',
    interlockReset: 'I:0/6 (INTERLOCK_RESET)',
    heartbeatRequest: 'I:0/7 (HEARTBEAT_REQ)',

    visionReady: 'O:0/0 (VISION_READY)',
    visionBusy: 'O:0/1 (VISION_BUSY)',
    inspectionComplete: 'O:0/2 (INSP_COMPLETE)',
    inspectionOk: 'O:0/3 (INSP_OK)',
    inspectionNg: 'O:0/4 (INSP_NG)',
    inspectionError: 'O:0/5 (INSP_ERROR)',
    visionHeartbeat: 'O:0/6 (VISION_HEARTBEAT)',
    alignmentOk: 'O:0/7 (ALIGNMENT_OK)',
    partValid: 'O:1/0 (PART_VALID)',
    processPermit: 'O:1/1 (PROCESS_PERMIT)',
  },
};

const STORAGE_KEY = 'vision_plc_config';

class PLCService {
  private config: PLCConfiguration = DEFAULT_CONFIG;
  private adapter: PLCAdapter = new SimulatedPLCAdapter();

  private handshakeState: PLCHandshakeState = {
    connectionStatus: 'DISCONNECTED',
    lastHeartbeatSendTime: 0,
    lastHeartbeatAckTime: 0,
    heartbeatHealthy: true,
    interlockState: 'WAITING_INSPECTION',
    lastInspectionId: null,
    lastSequenceNumber: 0,
    lastResultSent: null,
    ackReceived: false,
    ackPending: false,
    roundTripLatencyMs: 0,
    activeCycleTimeline: [],
    commErrorCount: 0,
  };

  private currentSignals: PLCLiveSignals = {
    plcReady: true,
    machineReady: true,
    partPresent: false,
    cycleActive: false,
    ackResult: false,
    resetRequest: false,
    interlockReset: false,
    heartbeatRequest: true,

    visionReady: true,
    visionBusy: false,
    inspectionComplete: false,
    inspectionOk: false,
    inspectionNg: false,
    inspectionError: false,
    visionHeartbeat: false,
    alignmentOk: false,
    partValid: false,
    processPermit: false,
  };

  private heartbeatTimer: number | null = null;
  private pollTimer: number | null = null;
  private currentCycleStartTime: number = 0;
  private listeners: Array<(state: PLCHandshakeState, signals: PLCLiveSignals) => void> = [];

  constructor() {
    this.loadSavedConfig();
    this.initAdapter();
  }

  private loadSavedConfig() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<PLCConfiguration>;
        this.config = { ...DEFAULT_CONFIG, ...parsed, enabled: false, triggerMode: 'AUTO_CAMERA', tags: { ...DEFAULT_CONFIG.tags, ...(parsed.tags || {}) } };
      }
    } catch {
      // Use defaults
    }
  }

  public saveConfig(newConfig: PLCConfiguration) {
    this.config = { ...DEFAULT_CONFIG, ...newConfig, enabled: false, triggerMode: 'AUTO_CAMERA', tags: { ...DEFAULT_CONFIG.tags, ...newConfig.tags } };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
    } catch {
      // Storage unavailable
    }
    this.initAdapter();
  }

  public getConfig(): PLCConfiguration {
    return { ...this.config };
  }

  public getHandshakeState(): PLCHandshakeState {
    return { ...this.handshakeState };
  }

  public getSignals(): PLCLiveSignals {
    return { ...this.currentSignals };
  }

  public getAdapter(): PLCAdapter {
    return this.adapter;
  }

  public subscribe(cb: (state: PLCHandshakeState, signals: PLCLiveSignals) => void): () => void {
    this.listeners.push(cb);
    cb(this.handshakeState, this.currentSignals);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.handshakeState, this.currentSignals);
    }
  }

  private initAdapter() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);

    if (this.config.protocol === 'SIMULATION') {
      this.adapter = new SimulatedPLCAdapter();
    } else {
      this.adapter = new NetworkPLCAdapter(this.config.protocol);
    }

    if (this.config.enabled) {
      this.connect();
    } else {
      this.disconnect();
    }
  }

  public async connect(): Promise<boolean> {
    this.handshakeState.connectionStatus = 'CONNECTING';
    this.handshakeState.lastErrorMessage = undefined;
    this.notify();

    const ok = await this.adapter.connect(this.config);
    if (ok) {
      this.handshakeState.connectionStatus =
        this.config.protocol === 'SIMULATION' ? 'SIMULATING' : 'CONNECTED';
      this.handshakeState.heartbeatHealthy = true;
      this.startHeartbeat();
      this.startPoll();
    } else {
      this.handshakeState.connectionStatus = 'DISCONNECTED';
      this.handshakeState.interlockState = 'COMMUNICATION_FAULT';
      this.handshakeState.heartbeatHealthy = false;
      this.currentSignals.processPermit = false;
      this.handshakeState.lastErrorMessage = `Unable to connect to ${this.config.protocol}`;
    }
    this.notify();
    return ok;
  }

  public async disconnect(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.adapter.disconnect();
    this.handshakeState.connectionStatus = 'DISCONNECTED';
    this.handshakeState.interlockState = 'COMMUNICATION_FAULT';
    this.currentSignals.processPermit = false;
    this.notify();
  }

  public async testConnection(): Promise<{ success: boolean; latencyMs: number; message: string }> {
    return this.adapter.testConnection(this.config);
  }

  // Watchdog Heartbeat
  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = window.setInterval(async () => {
      if (!this.config.enabled || !this.adapter.isConnected) return;

      const nextBeat = !this.currentSignals.visionHeartbeat;
      this.currentSignals.visionHeartbeat = nextBeat;
      this.handshakeState.lastHeartbeatSendTime = Date.now();

      const ok = await this.adapter.sendHeartbeat(nextBeat);

      if (!ok) {
        this.handshakeState.commErrorCount++;
        // Watchdog timeout check
        if (Date.now() - this.handshakeState.lastHeartbeatAckTime > this.config.heartbeatTimeoutMs) {
          this.handshakeState.heartbeatHealthy = false;
          this.handshakeState.lastErrorMessage = 'PLC heartbeat timeout';
          this.handshakeState.interlockState = 'COMMUNICATION_FAULT';
          this.currentSignals.processPermit = false;
          this.notify();
        }
      } else {
        this.handshakeState.lastHeartbeatAckTime = Date.now();
        this.handshakeState.heartbeatHealthy = true;
      }
    }, this.config.heartbeatIntervalMs);
  }

  // Periodic signal scan poll (reads PLC inputs e.g. PLC Ready, Machine Ready, Part Trigger)
  private startPoll() {
    if (this.pollTimer) clearInterval(this.pollTimer);

    this.pollTimer = window.setInterval(async () => {
      if (!this.config.enabled || !this.adapter.isConnected) return;

      try {
        const live = await this.adapter.readSignals();
        this.currentSignals.plcReady = live.plcReady;
        this.currentSignals.machineReady = live.machineReady;
        this.currentSignals.partPresent = live.partPresent;
        this.currentSignals.ackResult = live.ackResult;
        this.currentSignals.processPermit = live.processPermit;

        // Auto interlock update based on machine readiness
        if (!live.plcReady || !live.machineReady) {
          if (this.handshakeState.interlockState === 'PERMITTED') {
            this.handshakeState.interlockState = 'BLOCKED';
          }
        }
        this.notify();
      } catch (error) {
        this.handshakeState.commErrorCount++;
        this.handshakeState.heartbeatHealthy = false;
        this.handshakeState.interlockState = 'COMMUNICATION_FAULT';
        this.currentSignals.processPermit = false;
        this.handshakeState.lastErrorMessage = error instanceof Error ? error.message : 'PLC signal read failed';
      }
    }, 50);
  }

  // Timeline Event Logging
  public logTimelineEvent(
    eventName: string,
    source: 'PLC' | 'VISION' | 'INTERLOCK',
    description: string,
    payload?: Record<string, unknown>
  ) {
    const now = performance.now();
    const elapsed = this.currentCycleStartTime > 0 ? Math.round(now - this.currentCycleStartTime) : 0;

    const item: PLCEventLogItem = {
      timestamp: new Date().toISOString(),
      elapsedMs: elapsed,
      eventName,
      source,
      description,
      payload,
    };

    this.handshakeState.activeCycleTimeline.push(item);
    this.notify();
  }

  // Cycle Start (Invalidate Previous Results - Stale Result Prevention)
  public startNewCycle(triggerSource: 'VISION_AUTO' | 'PLC_TRIGGER' | 'HYBRID') {
    this.currentCycleStartTime = performance.now();
    this.handshakeState.lastSequenceNumber++;
    this.handshakeState.lastResultSent = null;
    this.handshakeState.ackReceived = false;
    this.handshakeState.ackPending = false;
    this.handshakeState.interlockState = 'WAITING_INSPECTION';
    this.handshakeState.activeCycleTimeline = [];

    // Reset vision outputs on PLC
    this.currentSignals.visionBusy = true;
    this.currentSignals.inspectionComplete = false;
    this.currentSignals.inspectionOk = false;
    this.currentSignals.inspectionNg = false;
    this.currentSignals.inspectionError = false;
    this.currentSignals.processPermit = false;

    this.adapter.clearResultSignals();

    this.logTimelineEvent(
      'CYCLE_STARTED',
      'VISION',
      `New cycle #${this.handshakeState.lastSequenceNumber} initiated via ${triggerSource}`,
      { sequence: this.handshakeState.lastSequenceNumber }
    );
  }

  // Send inspection result and execute explicit ACK handshake with PLC
  public async sendResultAndHandshake(payload: PLCInspectionPayload): Promise<{
    interlockGranted: boolean;
    ackReceived: boolean;
    commLatencyMs: number;
  }> {
    // PLC-disabled MVP: retain the vision judgement without transmitting
    // outputs or waiting for a hardware/simulator ACK. This is not a safety
    // interlock and must not be used to control production machinery.
    if (!this.config.enabled) {
      this.handshakeState.lastInspectionId = payload.inspectionId;
      this.handshakeState.lastResultSent = payload.judgement;
      this.handshakeState.ackPending = false;
      this.handshakeState.ackReceived = false;
      this.handshakeState.interlockState = 'WAITING_INSPECTION';
      this.currentSignals.processPermit = false;
      this.logTimelineEvent(
        'PLC_BYPASSED_MVP',
        'VISION',
        `PLC disabled for MVP; vision judgement retained: ${payload.judgement}`,
        { judgement: payload.judgement, detected: payload.detectedCount, expected: payload.expectedCount }
      );
      this.notify();
      return { interlockGranted: false, ackReceived: true, commLatencyMs: 0 };
    }

    const sendTime = performance.now();
    this.handshakeState.lastInspectionId = payload.inspectionId;
    this.handshakeState.lastResultSent = payload.judgement;
    this.handshakeState.ackPending = true;

    this.logTimelineEvent(
      `RESULT_${payload.judgement}_SENT`,
      'VISION',
      `Inspection result asserted to PLC (Judgement: ${payload.judgement})`,
      { judgement: payload.judgement, detected: payload.detectedCount, expected: payload.expectedCount }
    );

    // 1. Send outputs to PLC
    const sendOk = await this.adapter.sendInspectionResult(payload);
    if (!sendOk) {
      this.handshakeState.interlockState = 'COMMUNICATION_FAULT';
      this.handshakeState.ackPending = false;
      this.handshakeState.lastErrorMessage = 'Failed to transmit inspection result to PLC';
      this.logTimelineEvent('COMM_FAILURE', 'INTERLOCK', 'Failed to transmit result to PLC');
      this.notify();
      return { interlockGranted: false, ackReceived: false, commLatencyMs: 0 };
    }

    // 2. Wait for PLC to acknowledge (ACK_RESULT)
    const ackOk = await this.adapter.waitForAck(this.config.ackTimeoutMs);
    const commLatencyMs = Math.round(performance.now() - sendTime);
    this.handshakeState.roundTripLatencyMs = commLatencyMs;
    this.handshakeState.ackPending = false;
    this.handshakeState.ackReceived = ackOk;

    if (!ackOk) {
      // Timeout waiting for PLC ACK!
      this.handshakeState.interlockState = 'COMMUNICATION_FAULT';
      this.handshakeState.lastErrorMessage = `PLC ACK timeout after ${this.config.ackTimeoutMs}ms`;
      this.logTimelineEvent('PLC_ACK_TIMEOUT', 'INTERLOCK', `PLC failed to ACK within ${this.config.ackTimeoutMs}ms`);
      this.notify();
      return { interlockGranted: false, ackReceived: false, commLatencyMs };
    }

    this.logTimelineEvent('PLC_ACK_RECEIVED', 'PLC', `PLC acknowledged result in ${commLatencyMs}ms`);

    // 3. Interlock Decision (Section 39)
    // Quality Interlock: Process permitted ONLY IF inspection is OK AND machine is ready
    let plcReady = false;
    let machineReady = false;
    try {
      const machineState = await this.adapter.readMachineState();
      plcReady = machineState.plcReady;
      machineReady = machineState.machineReady;
    } catch (error) {
      this.handshakeState.interlockState = 'COMMUNICATION_FAULT';
      this.handshakeState.lastErrorMessage =
        error instanceof Error ? error.message : 'Failed to read PLC machine state';
      this.currentSignals.processPermit = false;
      this.logTimelineEvent('PLC_STATE_READ_FAILED', 'INTERLOCK', this.handshakeState.lastErrorMessage);
      this.notify();
      return { interlockGranted: false, ackReceived: ackOk, commLatencyMs };
    }

    let interlockGranted = false;

    if (payload.judgement === 'OK' && plcReady && machineReady) {
      interlockGranted = true;
      this.handshakeState.interlockState = 'PERMITTED';
      this.currentSignals.processPermit = true;
      this.logTimelineEvent('PROCESS_PERMIT_GRANTED', 'INTERLOCK', 'PLC granted PROCESS_PERMIT (OK & Machine Ready)');
    } else {
      interlockGranted = false;
      this.handshakeState.interlockState = 'BLOCKED';
      this.currentSignals.processPermit = false;
      this.logTimelineEvent(
        'PROCESS_BLOCKED',
        'INTERLOCK',
        payload.judgement !== 'OK'
          ? payload.judgement === 'NG'
            ? `Process blocked: Product NG (${payload.failureReason || 'Defect detected'})`
            : `Process blocked: ${payload.judgement} — ${payload.failureReason || 'Inspection did not produce a valid product judgement'}`
          : 'Process blocked: Machine not ready'
      );
    }

    this.notify();

    // 4. Hold signals for configured hold duration before releasing
    setTimeout(async () => {
      this.currentSignals.visionBusy = false;
      await this.adapter.clearResultSignals();
      this.notify();
    }, this.config.resultHoldTimeMs);

    return { interlockGranted, ackReceived: ackOk, commLatencyMs };
  }

  // Clear interlock for next part. The local state may only become
  // WAITING_INSPECTION after the PLC confirms the reset. If the reset fails,
  // keep the station blocked and surface a communication fault.
  public async clearInterlock(): Promise<boolean> {
    this.currentSignals.processPermit = false;

    if (!this.config.enabled) {
      this.handshakeState.interlockState = 'WAITING_INSPECTION';
      this.handshakeState.ackPending = false;
      this.logTimelineEvent('PART_REMOVED', 'VISION', 'PLC disabled; local inspection is ready for the next part');
      this.notify();
      return true;
    }

    const resetOk = await this.adapter.resetInterlock();

    if (resetOk) {
      this.handshakeState.interlockState = 'WAITING_INSPECTION';
      this.logTimelineEvent('PART_REMOVED', 'PLC', 'Part removed from station · Ready for next product');
    } else {
      this.handshakeState.interlockState = 'COMMUNICATION_FAULT';
      this.logTimelineEvent(
        'INTERLOCK_RESET_FAILED',
        'INTERLOCK',
        'Part was removed, but PLC interlock reset was not confirmed; station remains blocked'
      );
    }

    this.notify();
    return resetOk;
  }
}

export const plcService = new PLCService();
