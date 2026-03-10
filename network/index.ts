import { createSignalingClient } from "./signaling/client";
import { createRtcPeer } from "./transport/rtcPeer";
import { clearSession, loadSession, saveSession } from "./signaling/session";

export type Facade = {
  register: (url: string) => Promise<{ peerId: string }>;
  connect: (targetId: string) => Promise<void>;
  send: (data: string) => void;
  disconnect: () => void;
  onMessage: (handler: (data: unknown) => void) => void;
  onConnectionState: (handler: (state: RTCPeerConnectionState) => void) => void;
  pcState: () => {
    connectionState: RTCPeerConnectionState;
    iceConnectionState: RTCIceConnectionState;
    signalingState: RTCSignalingState;
  };
  startMedia: (stream: MediaStream) => void;
  stopMedia: () => void;
  onRemoteStream: (handler: (stream: MediaStream | null) => void) => void;
};

export const createClient = (): Facade => {
  const signaling = createSignalingClient();
  let peer: ReturnType<typeof createRtcPeer> | null = null;
  let onMessageHandler: ((data: unknown) => void) | null = null;
  let onConnectionHandler: ((state: RTCPeerConnectionState) => void) | null = null;
  let onRemoteStreamHandler: ((stream: MediaStream | null) => void) | null = null;
  let pendingMediaStream: MediaStream | null = null;

  const register = async (url: string) => {
    await signaling.connect(url);
    const cached = loadSession();
    let result: { peerId: string; iceServers: RTCIceServer[]; resumeToken: string } | null =
      null;
    if (cached) {
      try {
        result = await signaling.resume({
          peerId: cached.peerId,
          resumeToken: cached.resumeToken,
        });
      } catch {
        clearSession();
      }
    }
    if (!result) {
      result = await signaling.register();
    }
    if (result.resumeToken) {
      saveSession({
        peerId: result.peerId,
        resumeToken: result.resumeToken,
        updatedAt: Date.now(),
      });
    }
    const pc = new RTCPeerConnection({ iceServers: result.iceServers });
    peer = createRtcPeer(result.peerId, pc, signaling, {
      onMessage: (data) => {
        onMessageHandler?.(data);
      },
      onRemoteStream: (stream) => {
        onRemoteStreamHandler?.(stream);
      },
    });
    if (onConnectionHandler) {
      peer.onConnectionState(onConnectionHandler);
    }
    if (onRemoteStreamHandler) {
      peer.onRemoteStream(onRemoteStreamHandler);
    }
    if (pendingMediaStream) {
      peer.startMedia(pendingMediaStream);
    }
    return { peerId: result.peerId };
  };

  const connect = async (targetId: string) => {
    if (!peer) {
      return;
    }
    await peer.connect(targetId);
  };

  const send = (data: string) => {
    peer?.send(data);
  };

  const disconnect = () => {
    peer?.disconnect();
  };

  const onMessage = (handler: (data: unknown) => void) => {
    onMessageHandler = handler;
  };

  const onConnectionState = (handler: (state: RTCPeerConnectionState) => void) => {
    onConnectionHandler = handler;
    peer?.onConnectionState(handler);
  };

  const pcState = () => {
    const pc = peer?.getPc();
    return {
      connectionState: pc?.connectionState ?? "new",
      iceConnectionState: pc?.iceConnectionState ?? "new",
      signalingState: pc?.signalingState ?? "stable",
    };
  };

  const startMedia = (stream: MediaStream) => {
    pendingMediaStream = stream;
    peer?.startMedia(stream);
  };

  const stopMedia = () => {
    pendingMediaStream = null;
    peer?.stopMedia();
  };

  const onRemoteStream = (handler: (stream: MediaStream | null) => void) => {
    onRemoteStreamHandler = handler;
    peer?.onRemoteStream(handler);
  };

  return {
    register,
    connect,
    send,
    disconnect,
    onMessage,
    onConnectionState,
    pcState,
    startMedia,
    stopMedia,
    onRemoteStream,
  };
};
