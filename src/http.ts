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

/** Marks a response as not cacheable (`Cache-Control: no-store`) unless it already sets its own caching. */
export function noStore(response: Response): Response {
  if (response.headers.has('cache-control')) {
    return response;
  }
  try {
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    // Immutable headers (e.g. a proxied fetch response): copy the response.
    const copy = new Response(response.body, response);
    copy.headers.set('cache-control', 'no-store');
    return copy;
  }
}
