export function formatHistoryFrontendError(error: unknown): string {
  return formatValue(error, new Set<object>());
}

function formatValue(value: unknown, seen: Set<object>): string {
  if (value instanceof Error) {
    const cause = value.cause;
    return cause === undefined
      ? value.message
      : `${value.message}; cause: ${formatValue(cause, seen)}`;
  }
  const error = value;
  if (typeof error === "object" && error !== null) {
    if (seen.has(error)) return "[circular]";
    seen.add(error);
    const candidate = error as { code?: unknown; message?: unknown };
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      return `${candidate.code}: ${candidate.message}`;
    }
    const fields = Object.entries(error).map(
      ([key, field]) => `${key}=${formatValue(field, seen)}`,
    );
    return fields.length === 0 ? String(error) : fields.join(", ");
  }
  return String(error);
}
