// Admin key for the map editor's server-side save.
//
// Kept in localStorage and sent as a header rather than a cookie: the browser
// would attach a cookie to cross-site requests by itself, which would make the
// save endpoint CSRF-able. localStorage is per-origin and only read by our own
// fetches. Anything that can run script on this origin can read it, so treat
// the key as an operator convenience, not a user credential.

const KEY = "c20.adminKey";

export function adminKey() {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return ""; // private mode / blocked storage
  }
}

export function setAdminKey(key) {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    /* saving is best-effort; the key still applies for this page load */
  }
}

// Headers for a privileged request; empty when no key is held.
export function adminHeaders() {
  const key = adminKey();
  return key ? { "X-Admin-Key": key } : {};
}

// `?admin=<key>` in the URL stores the key and is then stripped, so it does not
// sit in the address bar or ride along in a shared link.
export function captureAdminKeyFromUrl() {
  const url = new URL(location.href);
  const key = url.searchParams.get("admin");
  if (key === null) return;
  setAdminKey(key);
  url.searchParams.delete("admin");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

// Ask the server whether a key unlocks saving: {enabled, ok}.
export async function adminStatus() {
  try {
    const res = await fetch("/api/admin", { headers: adminHeaders() });
    if (!res.ok) return { enabled: false, ok: false };
    return await res.json();
  } catch {
    return { enabled: false, ok: false };
  }
}
