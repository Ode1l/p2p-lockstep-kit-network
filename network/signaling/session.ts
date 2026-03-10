export type SignalingSession = {
  peerId: string;
  resumeToken: string;
  updatedAt: number;
};

const STORAGE_KEY = "p2p-lockstep-kit:signal-session";
const RESUME_TTL_MS = 10 * 60 * 1000;

const getStorage = () => {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const loadSession = (): SignalingSession | null => {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const data = JSON.parse(raw) as SignalingSession;
    if (!data?.peerId || !data?.resumeToken) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
};

export const saveSession = (session: SignalingSession | null) => {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  if (!session) {
    storage.removeItem(STORAGE_KEY);
    return;
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(session));
};

export const clearSession = () => {
  saveSession(null);
};

export const isExpired = (session: SignalingSession, ttlMs = RESUME_TTL_MS) =>
  Date.now() - session.updatedAt > ttlMs;
