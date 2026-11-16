// Small wrappers around localStorage: a desktop webview may refuse storage
// (private mode, quota), and a failed read must never break the UI.

/** Reads a JSON value, falling back when the key is missing or corrupted. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/** Writes a JSON value, ignoring storage failures. */
export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/** Reads a string value, falling back when the key is missing. */
export function readString(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Writes a string value, ignoring storage failures. */
export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
