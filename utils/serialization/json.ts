export const encode = <T>(value: T): string => JSON.stringify(value);

export const decode = <T>(raw: string): T => JSON.parse(raw) as T;

export const decodeSafe = <T>(
  raw: string,
): { ok: true; value: T } | { ok: false; error: unknown } => {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return { ok: false, error };
  }
};
