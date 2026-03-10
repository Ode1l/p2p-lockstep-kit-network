export type SignalType =
  | "REGISTER"
  | "REGISTERED"
  | "RESUME"
  | "RESUMED"
  | "ERROR"
  | "RELAY";

export type SignalMessage = {
  type: SignalType;
  from?: string;
  to?: string;
  payload?: SignalPayload;
};

export type SignalPayload = {
  id: string;
  data: unknown;
};
