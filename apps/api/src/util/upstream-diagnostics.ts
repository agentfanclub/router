// Upstream messages can echo prompts or credentials. Only retain short machine
// identifiers, never error messages, response bodies, or arbitrary headers.
export function diagnosticIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

export function upstreamErrorFields(value: unknown) {
  const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    errorCode: diagnosticIdentifier(error.code),
    errorType: diagnosticIdentifier(error.type),
  };
}
