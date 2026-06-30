import { describe, expect, it } from "vitest";
import {
  NetworkEndpoint,
  type EndpointRtcPeer,
  type EndpointRtcPeerFactory,
  type EndpointSignalingClient,
} from "../network/index.js";
import type { SignalMessage } from "../network/signaling/client.js";
import type { PeerState } from "../network/state/peerState.js";

declare const peerIdBrand: unique symbol;
type BrandedPeerId = string & { readonly [peerIdBrand]: "PeerId" };

class FakeSignaling implements EndpointSignalingClient {
  readonly handlers = new Set<(message: SignalMessage) => void>();
  connectCalls = 0;
  registerCalls = 0;
  closed = false;

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async register() {
    this.registerCalls += 1;
    return {
      peerId: "peer-local",
      iceServers: [{ urls: "stun:example.test" }],
      resumeToken: "resume-token",
    };
  }

  async resume(): Promise<never> {
    throw new Error("no cached session in node tests");
  }

  relay(): void {}

  onSignal(handler: (message: SignalMessage) => void): void {
    this.handlers.add(handler);
  }

  offSignal(handler: (message: SignalMessage) => void): void {
    this.handlers.delete(handler);
  }

  close(): void {
    this.closed = true;
  }

  emit(message: SignalMessage): void {
    for (const handler of [...this.handlers]) handler(message);
  }
}

class FakePeer implements EndpointRtcPeer {
  readonly receivedSignals: SignalMessage[] = [];
  readonly sent: string[] = [];
  connectCalls = 0;
  disposed = false;

  constructor(
    readonly remotePeerId: string,
    readonly onMessage: (data: string) => void,
    readonly onStateChange: (state: PeerState) => void,
  ) {}

  async connect(targetId: string): Promise<void> {
    expect(targetId).toBe(this.remotePeerId);
    this.connectCalls += 1;
    this.onStateChange("requesting");
  }

  disconnect(): void {
    this.onStateChange("passive");
  }

  dispose(): void {
    this.disposed = true;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  receiveSignal(message: SignalMessage): void {
    this.receivedSignals.push(message);
    this.onStateChange("requesting");
  }

  setConnected(): void {
    this.onStateChange("connected");
  }

  setDisconnected(): void {
    this.onStateChange("passive");
  }

  receive(data: unknown): void {
    this.onMessage(JSON.stringify(data));
  }
}

const createHarness = () => {
  const signaling = new FakeSignaling();
  const peers = new Map<string, FakePeer[]>();
  const peerFactory: EndpointRtcPeerFactory = (input) => {
    const peer = new FakePeer(
      input.remotePeerId,
      input.onMessage,
      input.onStateChange,
    );
    const history = peers.get(input.remotePeerId) ?? [];
    history.push(peer);
    peers.set(input.remotePeerId, history);
    expect(input.localPeerId).toBe("peer-local");
    return peer;
  };
  const endpoint = new NetworkEndpoint({
    signaling,
    peerFactory,
    connectionTimeoutMs: 5_000,
  });
  const latestPeer = (peerId: string): FakePeer | undefined => {
    const history = peers.get(peerId);
    return history?.[history.length - 1];
  };
  return { endpoint, signaling, peers, latestPeer };
};

const offer = (from: string): SignalMessage => ({
  from,
  to: "peer-local",
  type: "offer",
  payload: { type: "offer", sdp: `offer-${from}` },
});

describe("NetworkEndpoint", () => {
  it("registers one identity and exposes independent one-to-one links", async () => {
    const { endpoint, signaling, latestPeer } = createHarness();
    await expect(endpoint.register("wss://signal.test")).resolves.toEqual({
      peerId: "peer-local",
    });
    const linkA = endpoint.peer("peer-a");
    const linkB = endpoint.peer("peer-b");
    const first = linkA.connect();
    const second = linkB.connect();
    expect(latestPeer("peer-a")?.connectCalls).toBe(1);
    expect(latestPeer("peer-b")?.connectCalls).toBe(1);
    latestPeer("peer-a")!.setConnected();
    latestPeer("peer-b")!.setConnected();
    await Promise.all([first, second]);

    expect(linkA.state).toBe("connected");
    expect(linkB.state).toBe("connected");
    expect(signaling.connectCalls).toBe(1);
    expect(signaling.registerCalls).toBe(1);
    expect(signaling.handlers.size).toBe(1);
    expect(endpoint).not.toHaveProperty("broadcast");
    endpoint.dispose();
  });

  it("routes an incoming offer to exactly one discovered link", async () => {
    const { endpoint, signaling, latestPeer } = createHarness();
    await endpoint.register("wss://signal.test");
    const discovered: string[] = [];
    endpoint.onPeer((link) => discovered.push(link.remotePeerId));

    signaling.emit(offer("peer-a"));
    signaling.emit(offer("peer-b"));

    expect(discovered).toEqual(["peer-a", "peer-b"]);
    expect(latestPeer("peer-a")?.receivedSignals).toEqual([offer("peer-a")]);
    expect(latestPeer("peer-b")?.receivedSignals).toEqual([offer("peer-b")]);
    expect(signaling.handlers.size).toBe(1);
    endpoint.dispose();
  });

  it("serializes messages only on their selected link", async () => {
    const { endpoint, latestPeer } = createHarness();
    await endpoint.register("wss://signal.test");
    const linkA = endpoint.peer("peer-a");
    const linkB = endpoint.peer("peer-b");
    const first = linkA.connect();
    const second = linkB.connect();
    latestPeer("peer-a")!.setConnected();
    latestPeer("peer-b")!.setConnected();
    await Promise.all([first, second]);

    const received: unknown[] = [];
    linkB.onMessage((message) => received.push(message));
    linkA.send({ direct: true });
    latestPeer("peer-b")!.receive({ from: "b" });

    expect(latestPeer("peer-a")!.sent.map((value) => JSON.parse(value))).toEqual([
      { direct: true },
    ]);
    expect(latestPeer("peer-b")!.sent).toEqual([]);
    expect(received).toEqual([{ from: "b" }]);
    endpoint.dispose();
  });

  it("rebuilds one link without resetting another link", async () => {
    const { endpoint, peers, latestPeer } = createHarness();
    await endpoint.register("wss://signal.test");
    const linkA = endpoint.peer("peer-a");
    const linkB = endpoint.peer("peer-b");
    const first = linkA.connect();
    const second = linkB.connect();
    latestPeer("peer-a")!.setConnected();
    latestPeer("peer-b")!.setConnected();
    await Promise.all([first, second]);

    const oldPeerA = latestPeer("peer-a")!;
    const peerB = latestPeer("peer-b")!;
    oldPeerA.setDisconnected();
    expect(linkA.state).toBe("disconnected");
    expect(linkB.state).toBe("connected");

    const states: string[] = [];
    linkA.onStateChange((state) => states.push(state));
    const reconnected = linkA.connect();
    expect(states[0]).toBe("reconnecting");
    expect(oldPeerA.disposed).toBe(true);
    expect(latestPeer("peer-b")).toBe(peerB);
    expect(peers.get("peer-a")).toHaveLength(2);
    latestPeer("peer-a")!.setConnected();
    await reconnected;

    expect(linkA.state).toBe("connected");
    expect(linkB.state).toBe("connected");
    endpoint.dispose();
  });

  it("preserves branded peer IDs on endpoint and link surfaces", async () => {
    const signaling = new FakeSignaling();
    const endpoint = new NetworkEndpoint<BrandedPeerId>({
      signaling,
      peerFactory: () => {
        throw new Error("not used");
      },
    });
    const registered = await endpoint.register("wss://signal.test");
    const branded: BrandedPeerId = registered.peerId;
    const remote = "peer-remote" as BrandedPeerId;
    const link = endpoint.peer(remote);
    const linked: BrandedPeerId = link.remotePeerId;
    expect(branded).toBe("peer-local");
    expect(linked).toBe("peer-remote");
    endpoint.dispose();
  });
});
