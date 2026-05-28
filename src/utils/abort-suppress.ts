export function isAbortErrorName(name: string | undefined): boolean {
  return name === 'MessageAbortedError' || name === 'AbortError';
}

export function createAbortSuppressor(suppressAfterMs: number) {
  let suppressUntil = 0;

  return {
    suppress() {
      suppressUntil = Date.now() + suppressAfterMs;
    },
    isSuppressed() {
      return Date.now() < suppressUntil;
    },
  };
}
