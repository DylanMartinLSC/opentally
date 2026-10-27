// Client for the optional local SAM 3 backend (backend/sam3_server.py).
// The backend runs on the user's own machine; nothing goes to the internet.

export const DEFAULT_SAM_URL = 'http://127.0.0.1:8770';

export async function samHealth(baseUrl = DEFAULT_SAM_URL, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${baseUrl}/health`, { method: 'GET' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, ...(await res.json()) };
  } catch (e) {
    return { ok: false, error: 'Backend not running' };
  }
}

/**
 * @param {Blob} imageBlob photo, possibly downscaled by `scale`
 * @param {{boxes?: {x,y,w,h}[], text?: string, threshold?: number, scale?: number}} prompt
 *   boxes are in original-image pixels; results come back in original pixels too.
 */
export async function samCount(baseUrl, imageBlob, prompt, fetchImpl = fetch) {
  const s = prompt.scale ?? 1;
  const form = new FormData();
  form.append('image', imageBlob, 'image.jpg');
  form.append('boxes', JSON.stringify((prompt.boxes ?? []).map((b) => [b.x * s, b.y * s, (b.x + b.w) * s, (b.y + b.h) * s])));
  if (prompt.text) form.append('text', prompt.text);
  if (prompt.threshold != null) form.append('threshold', String(prompt.threshold));
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/count`, { method: 'POST', body: form });
  } catch {
    throw new Error(`Can't reach the local AI backend at ${baseUrl}. Start it (see README) or switch to Built-in.`);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  const body = await res.json();
  const objects = body.objects.map((o) => ({ x: o.x / s, y: o.y / s, r: o.r / s, score: o.score }));
  return { count: objects.length, objects, model: body.model };
}
