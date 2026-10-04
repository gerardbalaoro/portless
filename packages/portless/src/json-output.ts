/** Versioned, single-document output for the read-only CLI commands. */
export type JsonCommand = "list" | "get" | "doctor" | "service status";

export class JsonArgumentError extends Error {}

export function writeJson(command: JsonCommand, data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, command, ...data }, null, 2) + "\n");
}

export function writeJsonError(
  command: JsonCommand,
  message: string,
  code = "COMMAND_FAILED"
): void {
  writeJson(command, { error: { code, message } });
}
