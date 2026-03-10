export type PeerState = "passive" | "requesting" | "connected";

export type PeerEvent = "CONNECT" | "CONNECTED" | "DISCONNECT";

export type Transition = {
  from: PeerState;
  event: PeerEvent;
  to: PeerState;
};

const transitions: Transition[] = [
  { from: "passive", event: "CONNECT", to: "requesting" },
  { from: "requesting", event: "CONNECTED", to: "connected" },
  { from: "passive", event: "CONNECTED", to: "connected" },
  { from: "connected", event: "DISCONNECT", to: "passive" },
  { from: "requesting", event: "DISCONNECT", to: "passive" },
  { from: "connected", event: "CONNECT", to: "requesting" },
];

export const nextState = (state: PeerState, event: PeerEvent): PeerState => {
  const hit = transitions.find((t) => t.from === state && t.event === event);
  return hit ? hit.to : state;
};

export type MediaState = "idle" | "starting" | "active";

export type MediaEvent = "REQUEST" | "READY" | "STOP" | "DISCONNECT";

type MediaTransition = {
  from: MediaState;
  event: MediaEvent;
  to: MediaState;
};

const mediaTransitions: MediaTransition[] = [
  { from: "idle", event: "REQUEST", to: "starting" },
  { from: "starting", event: "READY", to: "active" },
  { from: "starting", event: "STOP", to: "idle" },
  { from: "starting", event: "DISCONNECT", to: "idle" },
  { from: "active", event: "STOP", to: "idle" },
  { from: "active", event: "DISCONNECT", to: "idle" },
  { from: "active", event: "REQUEST", to: "starting" },
  { from: "idle", event: "DISCONNECT", to: "idle" },
  { from: "idle", event: "STOP", to: "idle" },
];

export const nextMediaState = (state: MediaState, event: MediaEvent): MediaState => {
  const hit = mediaTransitions.find((t) => t.from === state && t.event === event);
  return hit ? hit.to : state;
};
