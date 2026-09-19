// Thin API client. Token persisted in localStorage; base path proxied to the
// backend by Vite in dev (see vite.config.js).
const TOKEN_KEY = 'ub_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function api(method, path, body) {
  const resp = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : null;
  if (!resp.ok) throw Object.assign(new Error(data?.error || resp.statusText), { status: resp.status, data });
  return data;
}

/**
 * Download a file from an authenticated endpoint. The token rides in a header,
 * so a plain <a href> would come back 401 — fetch it, then hand the browser a
 * blob URL with the filename the server chose.
 */
export async function download(path) {
  const resp = await fetch(`/api${path}`, {
    headers: { ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
  });
  if (!resp.ok) {
    let message = resp.statusText;
    try { message = (await resp.json())?.error || message; } catch { /* not JSON */ }
    throw Object.assign(new Error(message), { status: resp.status });
  }
  const disposition = resp.headers.get('content-disposition') || '';
  const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] || 'download';
  const url = URL.createObjectURL(await resp.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/**
 * Fetch a file from an authenticated endpoint to show it inline: a blob URL
 * and the file's type. The caller revokes the URL once the preview closes.
 */
export async function fetchBlobUrl(path) {
  const resp = await fetch(`/api${path}`, {
    headers: { ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
  });
  if (!resp.ok) {
    let message = resp.statusText;
    try { message = (await resp.json())?.error || message; } catch { /* not JSON */ }
    throw Object.assign(new Error(message), { status: resp.status });
  }
  const blob = await resp.blob();
  return { url: URL.createObjectURL(blob), mime: blob.type || resp.headers.get('content-type') || '' };
}
