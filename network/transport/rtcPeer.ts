import type { PeerEvent, PeerState } from "../state/peerState";
import { nextState } from "../state/peerState";
import type { SignalMessage } from "../signaling/client";

type Signaling = {
  relay: (message: SignalMessage) => void;
  on: (event: "signal", handler: (message: SignalMessage) => void) => void;
};

export type RtcPeerApi = {
  connect: (targetId: string) => Promise<void>;
  disconnect: () => void;
  send: (data: string) => void;
  getPc: () => RTCPeerConnection;
  onConnectionState: (handler: (state: RTCPeerConnectionState) => void) => void;
};

export class RtcPeer {
  // Core state and dependencies
  private readonly id: string;
  private readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private remoteId: string | null = null;
  private requestedId: string | null = null;
  private state: PeerState = "passive";
  private readonly signaling: Signaling;
  private readonly onMessage?: (data: unknown) => void;
  private onConnectionState?: (state: RTCPeerConnectionState) => void;

  public constructor(
    id: string,
    pc: RTCPeerConnection,
    signaling: Signaling,
    onMessage?: (data: unknown) => void,
  ) {
    this.id = id;
    this.pc = pc;
    this.signaling = signaling;
    this.onMessage = onMessage;

    // Signal inbound messages (offer/answer/ice)
    this.signaling.on("signal", (message) => {
      void this.handleSignal(message);
    });

    // PC connection state -> state machine
    this.pc.addEventListener("connectionstatechange", () => {
      this.onConnectionState?.(this.pc.connectionState);
      if (this.pc.connectionState === "connected") {
        this.dispatch("CONNECTED");
      }
    });

    // ICE candidate forwarding
    this.pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate || !this.remoteId) {
        return;
      }
      const msg: SignalMessage = {
        from: this.id,
        to: this.remoteId,
        type: "ice",
        payload: event.candidate.toJSON(),
      };
      this.signaling.relay(msg);
    });

    // DC inbound for passive side
    this.pc.ondatachannel = (event) => {
      this.dc = event.channel;
      this.bindDataChannel();
    };
  }

  // Public API (Facade surface)
  public connect = async (targetId: string) => {
    if (this.state !== "passive") {
      this.requestedId = targetId;
      this.disconnect();
      return;
    }
    this.remoteId = targetId;
    this.requestedId = null;
    this.dispatch("CONNECT");
  };

  public disconnect = () => {
    this.dispatch("DISCONNECT");
  };

  public send = (data: string) => {
    if (!this.dc || this.dc.readyState !== "open") {
      return;
    }
    this.dc.send(data);
  };

  public getPc = () => this.pc;
  public onConnectionStateChange = (handler: (state: RTCPeerConnectionState) => void) => {
    this.onConnectionState = handler;
  };

  // DC lifecycle
  private bindDataChannel = () => {
    if (!this.dc) {
      return;
    }
    this.dc.onmessage = (event) => {
      this.onMessage?.(event.data);
    };
    this.dc.onclose = () => {
      this.dispatch("DISCONNECT");
    };
  };

  // Signal handling (offer/answer/ice)
  private handleSignal = async (message: SignalMessage) => {
    // Strategy/Command: type -> handler map.
    const handlers: Record<SignalMessage["type"], () => Promise<void>> = {
      offer: async () => {
        this.remoteId = message.from;
        await this.pc.setRemoteDescription(
          message.payload as RTCSessionDescriptionInit,
        );
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        const reply: SignalMessage = {
          from: this.id,
          to: message.from,
          type: "answer",
          payload: answer,
        };
        this.signaling.relay(reply);
        this.dispatch("CONNECTED");
      },
      answer: async () => {
        await this.pc.setRemoteDescription(
          message.payload as RTCSessionDescriptionInit,
        );
        this.dispatch("CONNECTED");
      },
      ice: async () => {
        await this.pc.addIceCandidate(message.payload as RTCIceCandidateInit);
      },
    };

    await handlers[message.type]();
  };

  // State machine transitions
  private dispatch = (event: PeerEvent) => {
    // State Machine: event-driven transition + side effects.
    const next = nextState(this.state, event);
    if (this.state === next) {
      return;
    }
    this.state = next;

    if (next === "requesting") {
      if (this.requestedId) {
        this.remoteId = this.requestedId;
        this.requestedId = null;
      }
      void this.startOffer();
      return;
    }

    if (next === "passive") {
      this.closeConnection();
      if (this.requestedId) {
        this.remoteId = this.requestedId;
        this.requestedId = null;
        this.dispatch("CONNECT");
      }
    }
  };

  // Active offer creation
  private startOffer = async () => {
    if (!this.remoteId) {
      return;
    }
    this.dc = this.pc.createDataChannel("game", { ordered: true });
    this.bindDataChannel();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const msg: SignalMessage = {
      from: this.id,
      to: this.remoteId,
      type: "offer",
      payload: offer,
    };
    this.signaling.relay(msg);
  };

  // Cleanup for passive state
  private closeConnection = () => {
    this.dc?.close();
    this.dc = null;
    this.remoteId = null;
  };
}

export const createRtcPeer = (
  id: string,
  pc: RTCPeerConnection,
  signaling: Signaling,
  onMessage?: (data: unknown) => void,
): RtcPeerApi => {
  const peer = new RtcPeer(id, pc, signaling, onMessage);
  return {
    connect: peer.connect,
    disconnect: peer.disconnect,
    send: peer.send,
    getPc: peer.getPc,
    onConnectionState: peer.onConnectionStateChange,
  };
};
