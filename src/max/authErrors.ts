/** A server-side prerequisite for a new device, distinct from an incorrect SMS/password. */
export class MaxPasswordSetupRequiredError extends Error {
  constructor() {
    super('MAX requires a login password to be set on an already authenticated device.');
    this.name = 'MaxPasswordSetupRequiredError';
  }
}

export function requiresPasswordSetup(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return [p.localizedMessage, p.message, p.error].some(value => typeof value === 'string' && (
    /установ(?:ить|ите).*?(?:2fa|парол)/i.test(value) ||
    /(?:set|setup)[._\s-]*(?:a[._\s-]*)?(?:2fa|password)|2fa[._\s-]*(?:setup|required)/i.test(value)
  ));
}
