import { SignalingClient } from "./signaling/client";
import { RtcPeer } from "./transport/rtcPeer";
import { clearSession, loadSession, saveSession } from "./signaling/session";

export class NetworkClient {
  private readonly signaling: SignalingClient;
  private peer: RtcPeer | null = null;
  private onMessageHandler: ((data: unknown) => void) | null = null;
  private onConnectionHandler: ((state: RTCPeerConnectionState) => void) | null = null;
  private onRemoteStreamHandler: ((stream: MediaStream | null) => void) | null = null;
  private pendingMediaStream: MediaStream | null = null;

  public constructor(signaling = new SignalingClient()) {
    this.signaling = signaling;
  }

  public async register(url: string) {
    await this.signaling.connect(url);
    const cached = loadSession();
    let result: { peerId: string; iceServers: RTCIceServer[]; resumeToken: string } | null =
      null;
    if (cached) {
      try {
        result = await this.signaling.resume({
          peerId: cached.peerId,
          resumeToken: cached.resumeToken,
        });
      } catch {
        clearSession();
      }
    }
    if (!result) {
      result = await this.signaling.register();
    }
    if (result.resumeToken) {
      saveSession({
        peerId: result.peerId,
        resumeToken: result.resumeToken,
        updatedAt: Date.now(),
      });
    }
    const pc = new RTCPeerConnection({ iceServers: result.iceServers });
    this.peer = new RtcPeer(result.peerId, pc, this.signaling, {
      onMessage: (data) => {
        this.onMessageHandler?.(data);
      },
      onRemoteStream: (stream) => {
        this.onRemoteStreamHandler?.(stream);
      },
    });
    if (this.onConnectionHandler) {
      this.peer.onConnectionState(this.onConnectionHandler);
    }
    if (this.onRemoteStreamHandler) {
      this.peer.onRemoteStream(this.onRemoteStreamHandler);
    }
    if (this.pendingMediaStream) {
      this.peer.startMedia(this.pendingMediaStream);
    }
    return { peerId: result.peerId };
  }

  public async connect(targetId: string) {
    if (!this.peer) {
      return;
    }
    await this.peer.connect(targetId);
  }

  public send(data: string) {
    this.peer?.send(data);
  }

  public disconnect() {
    this.peer?.disconnect();
  }

  public onMessage(handler: (data: unknown) => void) {
    this.onMessageHandler = handler;
  }

  public onConnectionState(handler: (state: RTCPeerConnectionState) => void) {
    this.onConnectionHandler = handler;
    this.peer?.onConnectionState(handler);
  }

  public pcState() {
    const pc = this.peer?.getPc();
    return {
      connectionState: pc?.connectionState ?? "new",
      iceConnectionState: pc?.iceConnectionState ?? "new",
      signalingState: pc?.signalingState ?? "stable",
    };
  }

  public startMedia(stream: MediaStream) {
    this.pendingMediaStream = stream;
    this.peer?.startMedia(stream);
  }

  public stopMedia() {
    this.pendingMediaStream = null;
    this.peer?.stopMedia();
  }

  public onRemoteStream(handler: (stream: MediaStream | null) => void) {
    this.onRemoteStreamHandler = handler;
    this.peer?.onRemoteStream(handler);
  }
}

export const createClient = () => new NetworkClient();
