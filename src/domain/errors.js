/** A failure that retrying will not fix (missing file, media rejected by the server). */
export class PermanentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

export function isPermanent(err) {
  return err instanceof PermanentError || err?.permanent === true;
}

export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
