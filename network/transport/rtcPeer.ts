import type {MediaEvent, MediaState, PeerEvent, PeerState} from "../state/peerState";
import {nextMediaState, nextState} from "../state/peerState";
import {SignalingClient, SignalMessage} from "../signaling/client";

export class RtcPeer {
    // Core state and dependencies
    private readonly id: string;
    private readonly pc: RTCPeerConnection;
    private dc: RTCDataChannel | null = null;
    private readonly pendingSends: string[] = [];
    private remoteId: string | null = null;
    private requestedId: string | null = null;
    private state: PeerState = "passive";
    private readonly signaling: SignalingClient;
    private readonly onMessageHandler?: (data: string) => void;
    private localStream: MediaStream | null = null;
    private remoteStream: MediaStream | null = null;
    private onRemoteStreamHandler: ((stream: MediaStream | null) => void) | null = null;
    private senders: RTCRtpSender[] = [];
    private mediaState: MediaState = "idle";
    private negotiating = false;
    private renegotiateQueued = false;
    private readonly onSignalHandler: (message: SignalMessage) => void;
    private readonly onStateChangeHandler: ((state: PeerState) => void) | null = null;
    private readonly onMediaChangeHandler: ((state: MediaState) => void) | null = null;
    private readonly handleConnectionStateChange = () => {
        if (this.pc.connectionState === "connected") {
            this.markConnectedIfReady();
            return;
        }
        if (
            this.pc.connectionState === "closed" ||
            this.pc.connectionState === "disconnected" ||
            this.pc.connectionState === "failed"
        ) {
            this.dispatch("DISCONNECT");
        }
    };
    private readonly handleIceCandidate = (event: RTCPeerConnectionIceEvent) => {
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
    };
    private readonly handleDataChannel = (event: RTCDataChannelEvent) => {
        this.dc = event.channel;
        this.bindDataChannel();
    };
    private readonly handleTrackEvent = (event: RTCTrackEvent) => {
        this.handleRemoteTrack(event);
    };
    private readonly handleNegotiationNeeded = () => {
        if (!this.canNegotiate()) {
            return;
        }
        this.runTask(this.negotiate(), "negotiate");
    };

    public constructor(
        id: string,
        pc: RTCPeerConnection,
        signaling: SignalingClient,
        onMessage?: (data: string) => void,
        onRemoteStream?: (stream: MediaStream | null) => void,
        onStateChange?: (state: PeerState) => void,
        onMediaChange?: (state: MediaState) => void,
    ) {
        this.id = id;
        this.pc = pc;
        this.signaling = signaling;
        if (onMessage)
            this.onMessageHandler = onMessage;
        if (onRemoteStream)
            this.onRemoteStreamHandler = onRemoteStream;
        if (onStateChange)
            this.onStateChangeHandler = onStateChange;
        if (onMediaChange)
            this.onMediaChangeHandler = onMediaChange;
        this.onSignalHandler = (message) => {
            this.runTask(this.handleSignal(message), `signal:${message.type}`);
        };

        // Signal inbound messages (offer/answer/ice)
        this.signaling.onSignal(this.onSignalHandler);

        // PC connection state -> state machine
        this.pc.addEventListener("connectionstatechange", this.handleConnectionStateChange);
        this.pc.addEventListener("icecandidate", this.handleIceCandidate);
        this.pc.ondatachannel = this.handleDataChannel;
        this.pc.addEventListener("track", this.handleTrackEvent);
        this.pc.addEventListener("negotiationneeded", this.handleNegotiationNeeded);
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

    public dispose = () => {
        this.signaling.offSignal(this.onSignalHandler);
        this.pc.removeEventListener("connectionstatechange", this.handleConnectionStateChange);
        this.pc.removeEventListener("icecandidate", this.handleIceCandidate);
        this.pc.removeEventListener("track", this.handleTrackEvent);
        this.pc.removeEventListener("negotiationneeded", this.handleNegotiationNeeded);
        this.pc.ondatachannel = null;
        this.requestedId = null;
        this.closeConnection();
        this.setPeerState("passive");
        if (this.pc.signalingState !== "closed") {
            this.pc.close();
        }
    };

    public send = (data: string) => {
        if (!this.dc || this.dc.readyState !== "open") {
            if (this.state === "requesting") {
                this.pendingSends.push(data);
            }
            return;
        }
        this.dc.send(data);
    };

    public getPeerId = () => this.id;
    public getRemoteId = () => this.remoteId;
    public getPeerState = () => this.state;
    public getMediaState = () => this.mediaState;

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
            this.onMessageHandler?.(String(event.data));
        };
        this.dc.onopen = () => {
            this.flushPendingSends();
            this.markConnectedIfReady();
            this.attemptActivateMedia();
        };
        this.dc.onclose = () => {
            this.dispatchMedia("DISCONNECT");
            this.dispatch("DISCONNECT");
        };
        if (this.dc.readyState === "open") {
            this.flushPendingSends();
            this.markConnectedIfReady();
            this.attemptActivateMedia();
        }
    };

    private markConnectedIfReady = () => {
        if (!this.dc || this.dc.readyState !== "open") {
            return;
        }
        this.dispatch("CONNECTED");
    };

    private flushPendingSends = () => {
        if (!this.dc || this.dc.readyState !== "open") {
            return;
        }
        while (this.pendingSends.length > 0) {
            const data = this.pendingSends.shift();
            if (data !== undefined) {
                this.dc.send(data);
            }
        }
    };

    // Signal handling (offer/answer/ice)
    private handleSignal = async (message: SignalMessage) => {
        if (!this.shouldHandleSignal(message)) {
            return;
        }
        // Strategy/Command: type -> handler map.
        const handlers: Record<SignalMessage["type"], () => Promise<void>> = {
            offer: async () => {
                this.remoteId = message.from;
                if (this.state === "passive") {
                    this.dispatch("REMOTE_CONNECT");
                }
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
            },
            answer: async () => {
                await this.pc.setRemoteDescription(
                    message.payload as RTCSessionDescriptionInit,
                );
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
        if (!this.setPeerState(next)) {
            return;
        }

        if (next === "requesting" && event === "CONNECT") {
            if (this.requestedId) {
                this.remoteId = this.requestedId;
                this.requestedId = null;
            }
            this.runTask(this.startOffer(), "startOffer");
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
        this.dc = this.pc.createDataChannel("game", {ordered: true});
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
        const dataChannel = this.dc;
        this.dc = null;
        this.pendingSends.length = 0;
        this.negotiating = false;
        this.renegotiateQueued = false;
        if (dataChannel) {
            dataChannel.onmessage = null;
            dataChannel.onopen = null;
            dataChannel.onclose = null;
            if (dataChannel.readyState !== "closed") {
                dataChannel.close();
            }
        }
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
        if (!this.setMediaState(next)) {
            if (event === "REQUEST" && next === "starting") {
                this.attemptActivateMedia();
            }
            return;
        }
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

    private shouldHandleSignal = (message: SignalMessage) => {
        if (message.type === "offer") {
            return this.state === "passive" || this.remoteId === message.from;
        }
        return this.remoteId === message.from;
    };

    private setPeerState = (next: PeerState) => {
        if (this.state === next) {
            return false;
        }
        this.state = next;
        this.onStateChangeHandler?.(this.state);
        return true;
    };

    private setMediaState = (next: MediaState) => {
        if (this.mediaState === next) {
            return false;
        }
        this.mediaState = next;
        this.onMediaChangeHandler?.(this.mediaState);
        return true;
    };

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
                this.runTask(this.negotiate(), "negotiate");
            }
        }
    };

    private runTask(task: Promise<void>, context: string) {
        void task.catch((error) => {
            console.error(`[rtc-peer] ${context} failed`, error);
            this.dispatchMedia("DISCONNECT");
            this.dispatch("DISCONNECT");
        });
    }
}
