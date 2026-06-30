import { encode, decodeSafe } from "../../utils/index.js";
import type { SignalMessage as WireMessage } from "../../utils/index.js";

const debugLog = (message: string, payload?: unknown) => {
  if (payload !== undefined) {
    console.log(message, payload);
  } else {
    console.log(message);
  }
  const hook = (globalThis as unknown as { __p2p_debug?: (msg: string) => void }).__p2p_debug;
  if (typeof hook === "function") {
    try {
      hook(payload === undefined ? message : `${message} ${JSON.stringify(payload)}`);
    } catch {
      hook(message);
    }
  }
};

export type SignalType = "offer" | "answer" | "ice";

export type SignalMessage = {
  from: string;
  to: string;
  type: SignalType;
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
};

type SignalingEvents = {
  signal: SignalMessage;
  registered: { peerId: string; iceServers: RTCIceServer[]; resumeToken: string };
  error: unknown;
};

type RegistrationResult = SignalingEvents["registered"];

export class SignalingClient {
  private ws: WebSocket | null = null;
  private peerId: string | null = null;
  private ready = false;
  private registeredPayload: WireMessage["payload"] | undefined;
  private readonly signalHandlers = new Set<(message: SignalMessage) => void>();
  private pendingRegistration:
    | {
        resolve: (payload: RegistrationResult) => void;
        reject: (error: Error) => void;
        timeoutId: number;
      }
    | null = null;

  public connect = (url: string) =>
    new Promise<void>((resolve, reject) => {
      this.ws?.close();
      debugLog("[signaling] ws connect", url);
      this.ws = new WebSocket(url);
      const timeout = window.setTimeout(() => {
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
        debugLog("[signaling] ws open timeout");
        reject(new Error("ws open timeout"));
      }, 5000);
      this.ws.addEventListener("open", () => {
        this.ready = true;
        this.registeredPayload = undefined;
        window.clearTimeout(timeout);
        debugLog("[signaling] ws open");
        resolve();
      });
      this.ws.addEventListener("error", (event) => {
        window.clearTimeout(timeout);
        debugLog("[signaling] ws error", event);
        reject(new Error("ws error"));
      });
      this.ws.addEventListener("close", (event) => {
        this.ready = false;
        this.peerId = null;
        this.registeredPayload = undefined;
        this.rejectPendingRegistration(new Error("ws closed"));
        window.clearTimeout(timeout);
        debugLog("[signaling] ws close", { code: event.code, reason: event.reason });
      });
      this.ws.addEventListener("message", (event) => {
        const raw = String(event.data);
        const decoded = decodeSafe<WireMessage>(raw);
        if (!decoded.ok) {
          debugLog("[signaling] ws message decode error", raw);
          this.rejectPendingRegistration(new Error("signaling decode error"));
          return;
        }
        const msg = decoded.value;
        debugLog("[signaling] ws message", msg);

        if (msg.type === "ERROR") {
          debugLog("[signaling] error", msg);
          this.rejectPendingRegistration(new Error("signaling error"));
          return;
        }

        if (msg.type === "REGISTERED" || msg.type === "RESUMED") {
          this.peerId = msg.to ?? null;
          this.registeredPayload = msg.payload;
          if (this.peerId) {
            const details = this.resolveRegisteredPayload();
            debugLog("[signaling] registered", {
              peerId: this.peerId,
              resumeToken: details.resumeToken,
            });
            this.resolvePendingRegistration({
              peerId: this.peerId,
              iceServers: details.iceServers,
              resumeToken: details.resumeToken,
            });
          }
        }

        if (msg.type === "RELAY" && msg.payload?.id) {
          const relay = msg.payload;
          this.emitSignal({
            from: msg.from ?? "",
            to: msg.to ?? "",
            type: relay.id as SignalType,
            payload: relay.data as RTCSessionDescriptionInit | RTCIceCandidateInit,
          });
        }
      });
    });

  public register = async () => {
    this.assertConnected();
    const msg: WireMessage = { type: "REGISTER" };
    debugLog("[signaling] send REGISTER");
    const pending = this.awaitRegistration("register");
    this.ws?.send(encode(msg));
    try {
      const payload = await pending;
      debugLog("[signaling] register ok", payload.peerId);
      return payload;
    } catch (error) {
      debugLog("[signaling] register error", error);
      throw error;
    }
  };

  public resume = async (session: { peerId: string; resumeToken: string }) => {
    this.assertConnected();
    const payload = { id: "resume", data: session };
    const msg: WireMessage = { type: "RESUME", payload };
    debugLog("[signaling] send RESUME", session.peerId);
    const pending = this.awaitRegistration("resume");
    this.ws?.send(encode(msg));
    try {
      const result = await pending;
      debugLog("[signaling] resume ok", result.peerId);
      return result;
    } catch (error) {
      debugLog("[signaling] resume error", error);
      throw error;
    }
  };

  public relay = (message: SignalMessage) => {
    if (!this.ws || !this.ready) {
      return;
    }
    const payload = { id: message.type, data: message.payload };
    const msg: WireMessage = {
      type: "RELAY",
      from: this.peerId ?? message.from,
      to: message.to,
      payload,
    };
    this.ws.send(encode(msg));
  };

  public onSignal(handler: (message: SignalMessage) => void) {
    this.signalHandlers.add(handler);
  }

  public offSignal(handler: (message: SignalMessage) => void) {
    this.signalHandlers.delete(handler);
  }

  public close() {
    this.rejectPendingRegistration(new Error("signaling closed"));
    this.ready = false;
    this.peerId = null;
    this.registeredPayload = undefined;
    this.ws?.close();
    this.ws = null;
  }

  private resolveRegisteredPayload() {
    let iceServers: RTCIceServer[] = [];
    let resumeToken = "";
    if (this.registeredPayload?.id === "iceServers") {
      iceServers = this.registeredPayload.data as RTCIceServer[];
    }
    if (this.registeredPayload?.id === "session") {
      const data = this.registeredPayload.data as {
        iceServers?: RTCIceServer[];
        resumeToken?: string;
      };
      iceServers = data.iceServers ?? [];
      resumeToken = data.resumeToken ?? "";
    }
    return { iceServers, resumeToken };
  }

  private assertConnected() {
    if (!this.ws || !this.ready) {
      throw new Error("not connected");
    }
  }

  private awaitRegistration(label: "register" | "resume") {
    if (this.pendingRegistration) {
      return Promise.reject(new Error("registration already pending"));
    }
    return new Promise<RegistrationResult>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pendingRegistration = null;
        debugLog(`[signaling] ${label} timeout`);
        reject(new Error(`${label} timeout`));
      }, 5000);
      this.pendingRegistration = { resolve, reject, timeoutId };
    });
  }

  private resolvePendingRegistration(payload: RegistrationResult) {
    const pending = this.pendingRegistration;
    if (!pending) {
      return;
    }
    this.pendingRegistration = null;
    window.clearTimeout(pending.timeoutId);
    pending.resolve(payload);
  }

  private rejectPendingRegistration(error: Error) {
    const pending = this.pendingRegistration;
    if (!pending) {
      return;
    }
    this.pendingRegistration = null;
    window.clearTimeout(pending.timeoutId);
    pending.reject(error);
  }

  private emitSignal(message: SignalMessage) {
    for (const handler of [...this.signalHandlers]) {
      handler(message);
    }
  }
}
