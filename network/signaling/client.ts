import { encode, decodeSafe } from "../../utils";
import type { SignalMessage as WireMessage } from "../../utils";
import { Emitter } from "./emitter";

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
export class SignalingClient {
  private ws: WebSocket | null = null;
  private peerId: string | null = null;
  private ready = false;
  private registeredPayload: WireMessage["payload"] | undefined;
  private readonly emitter = new Emitter<SignalingEvents>();

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
        window.clearTimeout(timeout);
        debugLog("[signaling] ws close", { code: event.code, reason: event.reason });
      });
      this.ws.addEventListener("message", (event) => {
        const raw = String(event.data);
        debugLog("[signaling] ws message", raw);
        const decoded = decodeSafe<WireMessage>(raw);
        if (!decoded.ok) {
          this.emitter.emit("error", decoded.error);
          return;
        }
        const msg = decoded.value;

        if (msg.type === "ERROR") {
          debugLog("[signaling] error", msg);
          this.emitter.emit("error", msg);
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
            this.emitter.emit("registered", {
              peerId: this.peerId,
              iceServers: details.iceServers,
              resumeToken: details.resumeToken,
            });
          }
        }

        if (msg.type === "RELAY" && msg.payload?.id) {
          const relay = msg.payload;
          this.emitter.emit("signal", {
            from: msg.from ?? "",
            to: msg.to ?? "",
            type: relay.id as SignalType,
            payload: relay.data as RTCSessionDescriptionInit | RTCIceCandidateInit,
          });
        }
      });
    });

  public register = () =>
    new Promise<{ peerId: string; iceServers: RTCIceServer[]; resumeToken: string }>(
      (resolve, reject) => {
        if (!this.ws || !this.ready) {
          reject(new Error("not connected"));
          return;
        }
        const msg: WireMessage = { type: "REGISTER" };
        debugLog("[signaling] send REGISTER");
        const timeout = window.setTimeout(() => {
          this.emitter.off("registered", onRegistered);
          this.emitter.off("error", onError);
          debugLog("[signaling] register timeout");
          reject(new Error("register timeout"));
        }, 5000);
        const onRegistered = (payload: {
          peerId: string;
          iceServers: RTCIceServer[];
          resumeToken: string;
        }) => {
          this.emitter.off("registered", onRegistered);
          this.emitter.off("error", onError);
          window.clearTimeout(timeout);
          debugLog("[signaling] register ok", payload.peerId);
          resolve(payload);
        };
        const onError = (error: unknown) => {
          this.emitter.off("registered", onRegistered);
          this.emitter.off("error", onError);
          window.clearTimeout(timeout);
          debugLog("[signaling] register error", error);
          reject(error instanceof Error ? error : new Error("signaling error"));
        };
        this.emitter.on("registered", onRegistered);
        this.emitter.on("error", onError);
        this.ws.send(encode(msg));
      },
    );

  public resume = (session: { peerId: string; resumeToken: string }) =>
    new Promise<{ peerId: string; iceServers: RTCIceServer[]; resumeToken: string }>(
      (resolve, reject) => {
        if (!this.ws || !this.ready) {
          reject(new Error("not connected"));
          return;
        }
        const payload = { id: "resume", data: session };
        const msg: WireMessage = { type: "RESUME", payload };
        debugLog("[signaling] send RESUME", session.peerId);
        const timeout = window.setTimeout(() => {
          this.emitter.off("registered", onRegistered);
          this.emitter.off("error", onError);
          debugLog("[signaling] resume timeout");
          reject(new Error("resume timeout"));
        }, 5000);
        const onRegistered = (payload: {
          peerId: string;
          iceServers: RTCIceServer[];
          resumeToken: string;
        }) => {
          this.emitter.off("registered", onRegistered);
          this.emitter.off("error", onError);
          window.clearTimeout(timeout);
          debugLog("[signaling] resume ok", payload.peerId);
          resolve(payload);
        };
        const onError = (error: unknown) => {
          this.emitter.off("registered", onRegistered);
          this.emitter.off("error", onError);
          window.clearTimeout(timeout);
          debugLog("[signaling] resume error", error);
          reject(error instanceof Error ? error : new Error("resume failed"));
        };
        this.emitter.on("registered", onRegistered);
        this.emitter.on("error", onError);
        this.ws.send(encode(msg));
      },
    );

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
    this.emitter.on("signal", handler);
  }

  public offSignal(handler: (message: SignalMessage) => void) {
    this.emitter.off("signal", handler);
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
}
