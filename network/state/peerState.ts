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
