import {SignalingClient} from "./signaling/client";
import {RtcPeer} from "./transport/rtcPeer";
import {clearSession, loadSession, saveSession} from "./signaling/session";
import type {MediaState, PeerState} from "./state/peerState";

export class NetworkClient {
    private readonly signaling: SignalingClient;
    private peer: RtcPeer | null = null;
    private onMessageHandler: ((data: String) => void) | null = null;
    private onRemoteStreamHandler: ((stream: MediaStream | null) => void) | null = null;
    private pendingMediaStream: MediaStream | null = null;
    private onStateChangeHandler: ((state: PeerState) => void) | null = null;
    private onMediaChangeHandler: ((state: MediaState) => void) | null = null;

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
        const pc = new RTCPeerConnection({iceServers: result.iceServers});
        this.peer = new RtcPeer(result.peerId, pc, this.signaling,
            (data) => {
                this.onMessageHandler?.(data);
            },
            (stream) => {
                this.onRemoteStreamHandler?.(stream);
            },
            (state) => {
                this.onStateChangeHandler?.(state);
            },
            (state) => {
                this.onMediaChangeHandler?.(state);
            }

        );
        if (this.onRemoteStreamHandler) {
            this.peer.onRemoteStream(this.onRemoteStreamHandler);
        }
        if (this.pendingMediaStream) {
            this.peer.startMedia(this.pendingMediaStream);
        }
        return {peerId: result.peerId};
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

    /**
     * eg：
     * client.onMessage((payload) => {
     *   const text = String(payload);
     *   console.log("peer says", text);
     * });
     */
    public onMessage(handler: (data: String) => void) {
        this.onMessageHandler = handler;
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
    }

    public onStateChange(handler: (state: PeerState) => void) {
      this.onStateChangeHandler = handler;
    }

    public onMediaChange(handler: (state: MediaState) => void) {
      this.onMediaChangeHandler = handler;
    }

    public getLocalPeerId = () => this.peer?.getPeerId() ?? null;
    public getRemotePeerId = () => this.peer?.getRemoteId() ?? null;
    public peerState = (): PeerState => this.peer?.getPeerState() ?? "passive";
    public mediaState = (): MediaState => this.peer?.getMediaState() ?? "idle";
}

export const createClient = () => new NetworkClient();
