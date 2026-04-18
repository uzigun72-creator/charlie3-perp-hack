/** Relative `/api` when using Vite proxy; set `VITE_API_URL` for static hosting. */
export function api(path: string, init?: RequestInit): Promise<Response> {
  const base = import.meta.env.VITE_API_URL || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const demo = import.meta.env.VITE_BIP39_MNEMONIC;
  if (demo) headers["X-Demo-Mnemonic"] = demo;
  return fetch(`${base}${path}`, { ...init, headers });
}

/**
 * Parse response as JSON after reading text. Use when the server might return HTML (wrong base URL,
 * proxy miss) so `response.json()` would throw an opaque JSON.parse error.
 */
export async function readJsonBody<T>(
  r: Response,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const text = await r.text();
  if (!text.trim()) {
    return { ok: false, error: `Empty response (HTTP ${r.status})` };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return {
      ok: false,
      error: `Not JSON (HTTP ${r.status}). Check Vite proxy / VITE_API_URL. Body: ${snippet}`,
    };
  }
}
