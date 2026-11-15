export function redirect(location: string, setCookie?: string) {
  const headers = new Headers({ Location: location });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

export function apiError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}
