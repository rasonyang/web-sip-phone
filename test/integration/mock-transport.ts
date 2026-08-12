import { TransportState } from "sip.js";
import type { Transport } from "sip.js/lib/api/transport.js";
import type { Emitter } from "sip.js/lib/api/emitter.js";

type StateListener = (state: TransportState) => void;

class SimpleEmitter implements Emitter<TransportState> {
  private listeners: StateListener[] = [];
  addListener(l: StateListener): void {
    this.listeners.push(l);
  }
  removeListener(l: StateListener): void {
    this.listeners = this.listeners.filter((x) => x !== l);
  }
  on(l: StateListener): void {
    this.addListener(l);
  }
  off(l: StateListener): void {
    this.removeListener(l);
  }
  once(l: StateListener): void {
    const wrap: StateListener = (s) => {
      this.removeListener(wrap);
      l(s);
    };
    this.addListener(wrap);
  }
  emit(s: TransportState): void {
    for (const l of [...this.listeners]) l(s);
  }
}

/**
 * In-memory Transport. The test acts as the server: read client messages from `sent`,
 * inject server messages with `deliver()`, kill the link with `fail()`.
 */
export class MockTransport implements Transport {
  static instances: MockTransport[] = [];
  static latest(): MockTransport {
    return MockTransport.instances[MockTransport.instances.length - 1];
  }
  /** Set by tests to make connect() reject (reconnect-failure simulation). */
  static failConnects = 0;

  private _state: TransportState = TransportState.Disconnected;
  private _stateChange = new SimpleEmitter();
  sent: string[] = [];
  onConnect: (() => void) | undefined;
  onDisconnect: ((error?: Error) => void) | undefined;
  onMessage: ((message: string) => void) | undefined;

  // Signature required by UserAgent: (logger, options)
  constructor(_logger: unknown, _options: unknown) {
    MockTransport.instances.push(this);
  }

  get state(): TransportState {
    return this._state;
  }
  get stateChange(): Emitter<TransportState> {
    return this._stateChange;
  }
  get protocol(): string {
    return "WSS";
  }

  private setState(s: TransportState): void {
    this._state = s;
    this._stateChange.emit(s);
  }

  connect(): Promise<void> {
    if (MockTransport.failConnects > 0) {
      MockTransport.failConnects--;
      return Promise.reject(new Error("mock connect failure"));
    }
    this.setState(TransportState.Connecting);
    this.setState(TransportState.Connected);
    this.onConnect?.();
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.setState(TransportState.Disconnecting);
    this.setState(TransportState.Disconnected);
    this.onDisconnect?.();
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return this.disconnect();
  }

  isConnected(): boolean {
    return this._state === TransportState.Connected;
  }

  send(message: string): Promise<void> {
    if (!this.isConnected()) {
      return Promise.reject(new Error("not connected"));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  /** Server → client. */
  deliver(message: string): void {
    this.onMessage?.(message);
  }

  /** Simulate an unexpected WSS drop. */
  fail(): void {
    this.setState(TransportState.Disconnected);
    this.onDisconnect?.(new Error("mock wss dropped"));
  }
}
