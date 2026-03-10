export type Serialized = string;

export const encode = (value: unknown): Serialized => JSON.stringify(value);

export const decode = <T>(raw: Serialized): T => JSON.parse(raw) as T;

export const decodeSafe = <T>(
  raw: Serialized,
): { ok: true; value: T } | { ok: false; error: unknown } => {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return { ok: false, error };
  }
};
