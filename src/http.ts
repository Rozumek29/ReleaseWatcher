/** RFC 7807-style error response, consumed by the UI. */
export function problem(
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { status, title, ...extra },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

export const validationProblem = (field: string, message: string) =>
  problem(400, 'One or more validation errors occurred.', { errors: { [field]: [message] } });

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
