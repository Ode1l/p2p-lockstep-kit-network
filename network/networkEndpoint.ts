import { clearSession, loadSession, saveSession } from "./signaling/session.js";
import {
  SignalingClient,
  type SignalMessage,
} from "./signaling/client.js";
import type { PeerState } from "./state/peerState.js";
import {
  RtcPeer,
  type PeerSignaling,
} from "./transport/rtcPeer.js";
import { decodeSafe, encode } from "../utils/index.js";

export type PeerLinkState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export type Unsubscribe = () => void;

export interface EndpointSignalingClient extends PeerSignaling {
  connect(url: string): Promise<void>;
  register(): Promise<{
    peerId: string;
    iceServers: RTCIceServer[];
    resumeToken: string;
  }>;
  resume(session: { peerId: string; resumeToken: string }): Promise<{
    peerId: string;
    iceServers: RTCIceServer[];
    resumeToken: string;
  }>;
  close?(): void;
}

export interface EndpointRtcPeer {
  connect(targetId: string): Promise<void>;
  disconnect(): void;
  dispose(): void;
  send(data: string): void;
  receiveSignal(message: SignalMessage): void;
}

export interface EndpointRtcPeerFactoryInput {
  readonly localPeerId: string;
  readonly remotePeerId: string;
  readonly iceServers: readonly RTCIceServer[];
  readonly signaling: EndpointSignalingClient;
  readonly onMessage: (data: string) => void;
  readonly onStateChange: (state: PeerState) => void;
}

export type EndpointRtcPeerFactory = (
  input: EndpointRtcPeerFactoryInput,
) => EndpointRtcPeer;

export interface NetworkEndpointOptions {
  readonly signaling?: EndpointSignalingClient;
  readonly peerFactory?: EndpointRtcPeerFactory;
  readonly connectionTimeoutMs?: number;
}

export interface PeerLink<TPeerId extends string = string> {
  readonly remotePeerId: TPeerId;
  readonly state: PeerLinkState;
  connect(): Promise<void>;
  disconnect(): void;
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): Unsubscribe;
  onStateChange(handler: (state: PeerLinkState) => void): Unsubscribe;
  dispose(): void;
}

interface DeferredConnection {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const createDeferred = (): DeferredConnection => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const defaultPeerFactory: EndpointRtcPeerFactory = (input) => {
  const pc = new RTCPeerConnection({ iceServers: [...input.iceServers] });
  return new RtcPeer(
    input.localPeerId,
    pc,
    input.signaling,
    input.onMessage,
    undefined,
    input.onStateChange,
    undefined,
    {
      remoteId: input.remotePeerId,
      subscribeToSignaling: false,
    },
  );
};

class EndpointPeerLink<TPeerId extends string> implements PeerLink<TPeerId> {
  readonly remotePeerId: TPeerId;
  readonly #localPeerId: string;
  readonly #iceServers: readonly RTCIceServer[];
  readonly #signaling: EndpointSignalingClient;
  readonly #peerFactory: EndpointRtcPeerFactory;
  readonly #connectionTimeoutMs: number;
  readonly #release: (link: EndpointPeerLink<TPeerId>) => void;
  readonly #messageHandlers = new Set<(message: unknown) => void>();
  readonly #stateHandlers = new Set<(state: PeerLinkState) => void>();
  #peer: EndpointRtcPeer | null = null;
  #state: PeerLinkState = "disconnected";
  #pending: DeferredConnection | null = null;
  #timeout: ReturnType<typeof setTimeout> | null = null;
  #attempted = false;
  #disposed = false;

  constructor(input: {
    readonly localPeerId: string;
    readonly remotePeerId: TPeerId;
    readonly iceServers: readonly RTCIceServer[];
    readonly signaling: EndpointSignalingClient;
    readonly peerFactory: EndpointRtcPeerFactory;
    readonly connectionTimeoutMs: number;
    readonly release: (link: EndpointPeerLink<TPeerId>) => void;
  }) {
    this.#localPeerId = input.localPeerId;
    this.remotePeerId = input.remotePeerId;
    this.#iceServers = input.iceServers;
    this.#signaling = input.signaling;
    this.#peerFactory = input.peerFactory;
    this.#connectionTimeoutMs = input.connectionTimeoutMs;
    this.#release = input.release;
  }

  get state(): PeerLinkState {
    return this.#state;
  }

  connect(): Promise<void> {
    this.#assertActive();
    if (this.#state === "connected") return Promise.resolve();
    if (this.#pending) return this.#pending.promise;

    this.#pending = createDeferred();
    if (
      this.#peer &&
      (this.#state === "connecting" || this.#state === "reconnecting")
    ) {
      return this.#pending.promise;
    }

    this.#startAttempt();
    const peer = this.#peer;
    void peer?.connect(this.remotePeerId).catch((error: unknown) => {
      this.#fail(
        peer,
        error instanceof Error ? error : new Error("connection failed"),
      );
    });
    return this.#pending.promise;
  }

  disconnect(): void {
    if (this.#disposed) return;
    this.#clearPeer(new Error(`connection to ${this.remotePeerId} was cancelled`));
    this.#setState("disconnected");
  }

  send(message: unknown): void {
    this.#assertActive();
    if (!this.#peer || this.#state !== "connected") {
      throw new Error(`peer is not connected: ${this.remotePeerId}`);
    }
    this.#peer.send(encode(message));
  }

  onMessage(handler: (message: unknown) => void): Unsubscribe {
    this.#assertActive();
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onStateChange(handler: (state: PeerLinkState) => void): Unsubscribe {
    this.#assertActive();
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearPeer(new Error(`peer link disposed: ${this.remotePeerId}`));
    this.#setState("disconnected");
    this.#messageHandlers.clear();
    this.#stateHandlers.clear();
    this.#release(this);
  }

  receiveSignal(message: SignalMessage): void {
    if (this.#disposed) return;
    if (!this.#peer) {
      if (message.type !== "offer") return;
      this.#startAttempt();
    }
    this.#peer?.receiveSignal(message);
  }

  #startAttempt(): void {
    this.#clearPeer(new Error(`connection replaced: ${this.remotePeerId}`), false);
    const state: PeerLinkState = this.#attempted
      ? "reconnecting"
      : "connecting";
    this.#attempted = true;
    let peer!: EndpointRtcPeer;
    peer = this.#peerFactory({
      localPeerId: this.#localPeerId,
      remotePeerId: this.remotePeerId,
      iceServers: this.#iceServers,
      signaling: this.#signaling,
      onMessage: (raw) => this.#emitMessage(raw),
      onStateChange: (next) => this.#handlePeerState(peer, next),
    });
    this.#peer = peer;
    this.#setState(state);
    this.#timeout = setTimeout(() => {
      this.#fail(
        peer,
        new Error(`connection timeout: ${this.remotePeerId}`),
      );
    }, this.#connectionTimeoutMs);
  }

  #handlePeerState(peer: EndpointRtcPeer, state: PeerState): void {
    if (this.#peer !== peer) return;
    if (state === "connected") {
      this.#clearTimeout();
      this.#setState("connected");
      this.#pending?.resolve();
      this.#pending = null;
      return;
    }
    if (state === "requesting") return;
    if (this.#state === "connecting" || this.#state === "reconnecting") {
      this.#fail(peer, new Error(`connection failed: ${this.remotePeerId}`));
      return;
    }
    this.#clearPeer(undefined, false);
    this.#setState("disconnected");
  }

  #fail(peer: EndpointRtcPeer | null, error: Error): void {
    if (!peer || this.#peer !== peer) return;
    this.#clearPeer(error);
    this.#setState("failed");
  }

  #clearPeer(error?: Error, rejectPending = true): void {
    this.#clearTimeout();
    const peer = this.#peer;
    this.#peer = null;
    peer?.dispose();
    if (this.#pending && rejectPending) {
      this.#pending.reject(error ?? new Error("connection closed"));
      this.#pending = null;
    }
  }

  #clearTimeout(): void {
    if (!this.#timeout) return;
    clearTimeout(this.#timeout);
    this.#timeout = null;
  }

  #emitMessage(raw: string): void {
    const decoded = decodeSafe<unknown>(raw);
    const message = decoded.ok ? decoded.value : raw;
    for (const handler of [...this.#messageHandlers]) {
      try {
        handler(message);
      } catch {
        // One consumer must not break other link subscribers.
      }
    }
  }

  #setState(state: PeerLinkState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const handler of [...this.#stateHandlers]) {
      try {
        handler(state);
      } catch {
        // One consumer must not break other link subscribers.
      }
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("peer link is disposed");
  }
}

export class NetworkEndpoint<TPeerId extends string = string> {
  readonly #signaling: EndpointSignalingClient;
  readonly #peerFactory: EndpointRtcPeerFactory;
  readonly #connectionTimeoutMs: number;
  readonly #links = new Map<string, EndpointPeerLink<TPeerId>>();
  readonly #peerHandlers = new Set<
    (link: PeerLink<TPeerId>) => void
  >();
  readonly #signalHandler: (message: SignalMessage) => void;
  #localPeerId: TPeerId | null = null;
  #iceServers: RTCIceServer[] = [];
  #disposed = false;

  public constructor(options: NetworkEndpointOptions = {}) {
    this.#signaling = options.signaling ?? new SignalingClient();
    this.#peerFactory = options.peerFactory ?? defaultPeerFactory;
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? 20_000;
    if (
      !Number.isFinite(this.#connectionTimeoutMs) ||
      this.#connectionTimeoutMs <= 0
    ) {
      throw new RangeError("connectionTimeoutMs must be positive");
    }
    this.#signalHandler = (message) => this.#routeSignal(message);
    this.#signaling.onSignal(this.#signalHandler);
  }

  public get localPeerId(): TPeerId | null {
    return this.#localPeerId;
  }

  public async register(url: string): Promise<{ peerId: TPeerId }> {
    this.#assertActive();
    this.#disposeLinks();
    this.#localPeerId = null;
    await this.#signaling.connect(url);
    const cached = loadSession();
    let result: {
      peerId: string;
      iceServers: RTCIceServer[];
      resumeToken: string;
    } | null = null;
    if (cached) {
      try {
        result = await this.#signaling.resume({
          peerId: cached.peerId,
          resumeToken: cached.resumeToken,
        });
      } catch {
        clearSession();
      }
    }
    const registration = result ?? await this.#signaling.register();
    this.#localPeerId = registration.peerId as TPeerId;
    this.#iceServers = [...registration.iceServers];
    if (registration.resumeToken) {
      saveSession({
        peerId: registration.peerId,
        resumeToken: registration.resumeToken,
        updatedAt: Date.now(),
      });
    }
    return { peerId: registration.peerId as TPeerId };
  }

  public peer(remotePeerId: TPeerId): PeerLink<TPeerId> {
    const localPeerId = this.#requireLocalPeerId();
    if (remotePeerId === localPeerId) {
      throw new Error("cannot create a link to the local PeerId");
    }
    const existing = this.#links.get(remotePeerId);
    if (existing) return existing;

    const link = new EndpointPeerLink<TPeerId>({
      localPeerId,
      remotePeerId,
      iceServers: this.#iceServers,
      signaling: this.#signaling,
      peerFactory: this.#peerFactory,
      connectionTimeoutMs: this.#connectionTimeoutMs,
      release: (released) => {
        if (this.#links.get(remotePeerId) === released) {
          this.#links.delete(remotePeerId);
        }
      },
    });
    this.#links.set(remotePeerId, link);
    for (const handler of [...this.#peerHandlers]) {
      try {
        handler(link);
      } catch {
        // One consumer must not break endpoint peer discovery.
      }
    }
    return link;
  }

  public onPeer(handler: (link: PeerLink<TPeerId>) => void): Unsubscribe {
    this.#assertActive();
    this.#peerHandlers.add(handler);
    for (const link of this.#links.values()) handler(link);
    return () => this.#peerHandlers.delete(handler);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#signaling.offSignal(this.#signalHandler);
    this.#disposeLinks();
    this.#signaling.close?.();
    this.#peerHandlers.clear();
    this.#localPeerId = null;
    this.#iceServers = [];
  }

  #routeSignal(message: SignalMessage): void {
    if (!this.#localPeerId || message.to !== this.#localPeerId) return;
    const existing = this.#links.get(message.from);
    if (!existing && message.type !== "offer") return;
    const link = existing ?? this.peer(message.from as TPeerId);
    link instanceof EndpointPeerLink && link.receiveSignal(message);
  }

  #disposeLinks(): void {
    const links = [...this.#links.values()];
    this.#links.clear();
    for (const link of links) link.dispose();
  }

  #requireLocalPeerId(): TPeerId {
    this.#assertActive();
    if (!this.#localPeerId) throw new Error("register must complete first");
    return this.#localPeerId;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("network endpoint is disposed");
  }
}
