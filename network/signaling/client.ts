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

export type SignalingClient = {
  connect: (url: string) => Promise<void>;
  register: () => Promise<{ peerId: string; iceServers: RTCIceServer[]; resumeToken: string }>;
  resume: (session: {
    peerId: string;
    resumeToken: string;
  }) => Promise<{ peerId: string; iceServers: RTCIceServer[]; resumeToken: string }>;
  relay: (message: SignalMessage) => void;
  on: (event: "signal", handler: (message: SignalMessage) => void) => void;
  off: (event: "signal", handler: (message: SignalMessage) => void) => void;
  state: () => { peerId: string | null; ready: boolean };
};

type SignalingEvents = {
  signal: SignalMessage;
  registered: { peerId: string; iceServers: RTCIceServer[]; resumeToken: string };
  error: unknown;
};

export const createSignalingClient = (): SignalingClient => {
  let ws: WebSocket | null = null;
  let peerId: string | null = null;
  let ready = false;
  let registeredPayload: WireMessage["payload"] | undefined;
  // Observer pattern: internal event bus for signal/registered/error.
  const emitter = new Emitter<SignalingEvents>();

  const connect = (url: string) =>
    new Promise<void>((resolve, reject) => {
      ws?.close();
      debugLog("[signaling] ws connect", url);
      ws = new WebSocket(url);
      const timeout = window.setTimeout(() => {
        try {
          ws?.close();
        } catch {
          // ignore
        }
        debugLog("[signaling] ws open timeout");
        reject(new Error("ws open timeout"));
      }, 5000);
      ws.addEventListener("open", () => {
        ready = true;
        registeredPayload = undefined;
        window.clearTimeout(timeout);
        debugLog("[signaling] ws open");
        resolve();
      });
      ws.addEventListener("error", (event) => {
        window.clearTimeout(timeout);
        debugLog("[signaling] ws error", event);
        reject(new Error("ws error"));
      });
      ws.addEventListener("close", (event) => {
        ready = false;
        peerId = null;
        registeredPayload = undefined;
        window.clearTimeout(timeout);
        debugLog("[signaling] ws close", { code: event.code, reason: event.reason });
      });
      ws.addEventListener("message", (event) => {
        const raw = String(event.data);
        debugLog("[signaling] ws message", raw);
        const decoded = decodeSafe<WireMessage>(raw);
        if (!decoded.ok) {
          emitter.emit("error", decoded.error);
          return;
        }
        const msg = decoded.value;

        // Adapter: map wire protocol to internal events.
        if (msg.type === "ERROR") {
          debugLog("[signaling] error", msg);
          emitter.emit("error", msg);
          return;
        }

        if (msg.type === "REGISTERED" || msg.type === "RESUMED") {
          peerId = msg.to ?? null;
          registeredPayload = msg.payload;
          if (peerId) {
            let iceServers: RTCIceServer[] = [];
            let resumeToken = "";
            if (registeredPayload?.id === "iceServers") {
              iceServers = registeredPayload.data as RTCIceServer[];
            }
            if (registeredPayload?.id === "session") {
              const data = registeredPayload.data as {
                iceServers?: RTCIceServer[];
                resumeToken?: string;
              };
              iceServers = data.iceServers ?? [];
              resumeToken = data.resumeToken ?? "";
            }
            debugLog("[signaling] registered", { peerId, resumeToken });
            emitter.emit("registered", { peerId, iceServers, resumeToken });
          }
        }

        if (msg.type === "RELAY" && msg.payload?.id) {
          const relay = msg.payload;
          emitter.emit("signal", {
            from: msg.from ?? "",
            to: msg.to ?? "",
            type: relay.id as SignalType,
            payload: relay.data as RTCSessionDescriptionInit | RTCIceCandidateInit,
          });
        }
      });
    });

  const register = () =>
    new Promise<{ peerId: string; iceServers: RTCIceServer[]; resumeToken: string }>(
      (resolve, reject) => {
      if (!ws || !ready) {
        reject(new Error("not connected"));
        return;
      }
      const msg: WireMessage = { type: "REGISTER" };
      debugLog("[signaling] send REGISTER");
      const timeout = window.setTimeout(() => {
        emitter.off("registered", onRegistered);
        emitter.off("error", onError);
        debugLog("[signaling] register timeout");
        reject(new Error("register timeout"));
      }, 5000);
      const onRegistered = (payload: {
        peerId: string;
        iceServers: RTCIceServer[];
        resumeToken: string;
      }) => {
        emitter.off("registered", onRegistered);
        emitter.off("error", onError);
        window.clearTimeout(timeout);
        debugLog("[signaling] register ok", payload.peerId);
        resolve(payload);
      };
      const onError = (error: unknown) => {
        emitter.off("registered", onRegistered);
        emitter.off("error", onError);
        window.clearTimeout(timeout);
        debugLog("[signaling] register error", error);
        reject(error instanceof Error ? error : new Error("signaling error"));
      };
      emitter.on("registered", onRegistered);
      emitter.on("error", onError);
      ws.send(encode(msg));
    },
  );

  const resume = (session: { peerId: string; resumeToken: string }) =>
    new Promise<{ peerId: string; iceServers: RTCIceServer[]; resumeToken: string }>(
      (resolve, reject) => {
        if (!ws || !ready) {
          reject(new Error("not connected"));
          return;
        }
        const payload = { id: "resume", data: session };
        const msg: WireMessage = { type: "RESUME", payload };
        debugLog("[signaling] send RESUME", session.peerId);
        const timeout = window.setTimeout(() => {
          emitter.off("registered", onRegistered);
          emitter.off("error", onError);
          debugLog("[signaling] resume timeout");
          reject(new Error("resume timeout"));
        }, 5000);
        const onRegistered = (payload: {
          peerId: string;
          iceServers: RTCIceServer[];
          resumeToken: string;
        }) => {
          emitter.off("registered", onRegistered);
          emitter.off("error", onError);
          window.clearTimeout(timeout);
          debugLog("[signaling] resume ok", payload.peerId);
          resolve(payload);
        };
        const onError = (error: unknown) => {
          emitter.off("registered", onRegistered);
          emitter.off("error", onError);
          window.clearTimeout(timeout);
          debugLog("[signaling] resume error", error);
          reject(error instanceof Error ? error : new Error("resume failed"));
        };
        emitter.on("registered", onRegistered);
        emitter.on("error", onError);
        ws.send(encode(msg));
      },
    );

  const relay = (message: SignalMessage) => {
    if (!ws || !ready) {
      return;
    }
    // Adapter: internal signal -> wire protocol payload.
    const payload = { id: message.type, data: message.payload };
    const msg: WireMessage = {
      type: "RELAY",
      from: peerId ?? message.from,
      to: message.to,
      payload,
    };
    ws.send(encode(msg));
  };

  const on = emitter.on.bind(emitter) as SignalingClient["on"];
  const off = emitter.off.bind(emitter) as SignalingClient["off"];
  const state = () => ({ peerId, ready });

  return { connect, register, resume, relay, on, off, state };
};
