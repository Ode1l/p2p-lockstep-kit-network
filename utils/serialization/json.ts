export const encode = (value: unknown): string => JSON.stringify(value);

export const decode = <T>(raw: string): T => {
  if (typeof raw !== "string") {
    throw new TypeError("decode expects a serialized string");
  }
  return JSON.parse(raw) as T;
};

export const decodeSafe = <T>(
  raw: unknown,
): { ok: true; value: T } | { ok: false; error: unknown } => {
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: new TypeError("decodeSafe expects a serialized string"),
    };
  }

  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return { ok: false, error };
  }
};
