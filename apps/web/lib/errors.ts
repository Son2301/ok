/**
 * Platform `AppError` code of a thrown error, or null. Duck-typed rather than
 * `instanceof`, because bundlers may load @minh/shared more than once.
 */
export function appErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AppError') {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
