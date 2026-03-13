import type { PeerEvent, PeerState, MediaEvent, MediaState } from "../state/peerState";
import { nextState, nextMediaState } from "../state/peerState";
import {SignalingClient, SignalMessage} from "../signaling/client";

type RtcPeerOptions = {
  onMessage?: (data: unknown) => void;
  onRemoteStream?: (stream: MediaStream | null) => void;
};

export class RtcPeer {
  // Core state and dependencies
  private readonly id: string;
  private readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private remoteId: string | null = null;
  private requestedId: string | null = null;
  private state: PeerState = "passive";
  private readonly signaling: SignalingClient;
  private readonly onMessage?: (data: unknown) => void;
  private onConnectionStateHandler?: (state: RTCPeerConnectionState) => void;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private onRemoteStreamHandler: ((stream: MediaStream | null) => void) | null = null;
  private senders: RTCRtpSender[] = [];
  private mediaState: MediaState = "idle";
  private negotiating = false;
  private renegotiateQueued = false;
  private readonly onSignalHandler: (message: SignalMessage) => void;

  public constructor(
      id: string,
      pc: RTCPeerConnection,
      signaling: SignalingClient,
      options: RtcPeerOptions = {},
  ) {
    this.id = id;
    this.pc = pc;
    this.signaling = signaling;
    this.onMessage = options.onMessage;
    if (options.onRemoteStream) {
      this.onRemoteStreamHandler = options.onRemoteStream;
    }
    this.onSignalHandler = (message) => {
      void this.handleSignal(message);
    };

    // Signal inbound messages (offer/answer/ice)
    this.signaling.onSignal(this.onSignalHandler);

    // PC connection state -> state machine
    this.pc.addEventListener("connectionstatechange", () => {
      this.onConnectionStateHandler?.(this.pc.connectionState);
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

    this.pc.addEventListener("track", (event) => {
      this.handleRemoteTrack(event);
    });

    this.pc.addEventListener("negotiationneeded", () => {
      if (!this.canNegotiate()) {
        return;
      }
      void this.negotiate();
    });
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
  public onConnectionState = (handler: (state: RTCPeerConnectionState) => void) => {
    this.onConnectionStateHandler = handler;
  };

  public startMedia = (stream: MediaStream) => {
    this.localStream = stream;
    this.dispatchMedia("REQUEST");
  };

  public stopMedia = () => {
    this.localStream = null;
    this.dispatchMedia("STOP");
  };

  public onRemoteStream = (handler: (stream: MediaStream | null) => void) => {
    this.onRemoteStreamHandler = handler;
    handler?.(this.remoteStream);
  };

  // DC lifecycle
  private bindDataChannel = () => {
    if (!this.dc) {
      return;
    }
    this.dc.onmessage = (event) => {
      this.onMessage?.(event.data);
    };
    this.dc.onopen = () => {
      this.attemptActivateMedia();
    };
    this.dc.onclose = () => {
      this.dispatchMedia("DISCONNECT");
      this.dispatch("DISCONNECT");
    };
    if (this.dc.readyState === "open") {
      this.attemptActivateMedia();
    }
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
    this.dispatchMedia("DISCONNECT");
    this.remoteId = null;
  };
  
  private detachLocalMedia = () => {
    if (!this.senders.length) {
      return;
    }
    for (const sender of this.senders) {
      try {
        this.pc.removeTrack(sender);
      } catch {
        // ignore
      }
    }
    this.senders = [];
  };

  private ensureRemoteStream = () => {
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    return this.remoteStream;
  };

  private handleRemoteTrack = (event: RTCTrackEvent) => {
    const [stream] = event.streams;
    if (stream) {
      this.remoteStream = stream;
    } else {
      const target = this.ensureRemoteStream();
      target.addTrack(event.track);
      this.remoteStream = target;
    }
    event.track.addEventListener("ended", () => {
      this.handleRemoteTrackEnded();
    });
    if (this.onRemoteStreamHandler && this.remoteStream) {
      this.onRemoteStreamHandler(this.remoteStream);
    }
  };

  private handleRemoteTrackEnded = () => {
    if (!this.remoteStream) {
      return;
    }
    const hasLiveTracks = this.remoteStream.getTracks().some((track) => track.readyState !== "ended");
    if (!hasLiveTracks) {
      this.clearRemoteStream();
    }
  };

  private clearRemoteStream = () => {
    if (!this.remoteStream) {
      return;
    }
    for (const track of this.remoteStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
    this.remoteStream = null;
    this.onRemoteStreamHandler?.(null);
  };

  private isMediaReady = () => this.dc?.readyState === "open";

  private dispatchMedia = (event: MediaEvent) => {
    const next = nextMediaState(this.mediaState, event);
    if (next === this.mediaState) {
      if (event === "REQUEST" && next === "starting") {
        this.attemptActivateMedia();
      }
      return;
    }
    this.mediaState = next;
    if (next === "starting") {
      this.detachLocalMedia();
      this.attemptActivateMedia();
      return;
    }
    if (next === "idle") {
      this.detachLocalMedia();
      this.clearRemoteStream();
    }
  };

  private attemptActivateMedia = () => {
    if (this.mediaState !== "starting") {
      return;
    }
    if (!this.localStream || !this.isMediaReady()) {
      return;
    }
    for (const track of this.localStream.getTracks()) {
      const sender = this.pc.addTrack(track, this.localStream);
      this.senders.push(sender);
    }
    this.dispatchMedia("READY");
  };

  private canNegotiate = () => Boolean(this.remoteId && this.isMediaReady());

  private negotiate = async () => {
    if (!this.remoteId) {
      return;
    }
    if (this.negotiating) {
      this.renegotiateQueued = true;
      return;
    }
    this.negotiating = true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const msg: SignalMessage = {
        from: this.id,
        to: this.remoteId,
        type: "offer",
        payload: offer,
      };
      this.signaling.relay(msg);
    } finally {
      this.negotiating = false;
      if (this.renegotiateQueued) {
        this.renegotiateQueued = false;
        void this.negotiate();
      }
    }
  };
}
