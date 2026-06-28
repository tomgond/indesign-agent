export function step(name: string, params: Record<string, unknown> = {}, io: { inputSha256?: string; outputSha256?: string } = {}) {
  return {
    name,
    at: new Date().toISOString(),
    inputSha256: io.inputSha256,
    outputSha256: io.outputSha256,
    params
  };
}
