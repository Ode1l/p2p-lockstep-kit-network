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
};

export const createClient = (): Facade => {
  const signaling = createSignalingClient();
  let peer: ReturnType<typeof createRtcPeer> | null = null;
  let onMessageHandler: ((data: unknown) => void) | null = null;
  let onConnectionHandler: ((state: RTCPeerConnectionState) => void) | null = null;

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
    peer = createRtcPeer(result.peerId, pc, signaling, (data) => {
      onMessageHandler?.(data);
    });
    if (onConnectionHandler) {
      peer.onConnectionState(onConnectionHandler);
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

  return { register, connect, send, disconnect, onMessage, onConnectionState, pcState };
};
