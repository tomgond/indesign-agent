export function ok<T>(value: T) {
  return { success: true as const, ...value };
}

export function fail(code: string, message: string, details?: Record<string, unknown>) {
  return { success: false as const, error: { code, message, ...details } };
}

export function toContentJson(value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }];
}
