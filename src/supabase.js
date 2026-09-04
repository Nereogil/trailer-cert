// A small, hand-written Supabase client: sign in, keep a session alive, read
// and write rows, put and fetch files. That is everything this app asks of the
// server.
//
// supabase-js would do the same and more, but the "more" is realtime,
// websockets, and a good hundred kilobytes that would go into the offline shell
// and be carried by a phone that never uses any of it. The surface below is
// small enough to read in one sitting, which matters more here than breadth.
//
// Everything throws on failure, including when there is simply no signal. That
// is deliberate: the app works offline by treating a failed sync as "not now",
// never as "the row is gone".

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const SESSION_KEY = 'trailer-cert:session';

// Refresh a minute before the token actually expires. A request that sets off
// valid and arrives expired is a confusing failure to chase down.
const REFRESH_MARGIN_S = 60;

let session = loadSession();
let refreshing = null;
const listeners = new Set();

// ------------------------------------------------------------------ session

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Stored in localStorage for now. Once the passkey work lands this becomes an
// encrypted blob in IndexedDB whose key comes from the fingerprint, so a
// stolen unlocked device does not hand over a working refresh token.
function saveSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // A browser refusing storage should not stop the app; the session simply
    // lasts as long as the tab.
  }
  for (const fn of listeners) {
    try { fn(next); } catch (err) { console.error('auth listener failed', err); }
  }
}

export const currentSession = () => session;
export const currentUserId = () => session?.user?.id ?? null;
export const currentEmail = () => session?.user?.email ?? null;
export const isSignedIn = () => Boolean(session?.refresh_token);

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Supabase returns expires_in; expires_at is more useful once stored, because
// a session read back from disk hours later needs an absolute answer.
function withExpiry(raw) {
  const expiresAt = raw.expires_at ?? Math.floor(Date.now() / 1000) + (raw.expires_in ?? 3600);
  return { ...raw, expires_at: expiresAt };
}

const expired = (s, margin = REFRESH_MARGIN_S) =>
  !s?.expires_at || s.expires_at - margin <= Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ requests

async function call(path, { method = 'GET', headers = {}, body, raw = false } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { apikey: SUPABASE_ANON_KEY, ...headers },
    body,
  });

  if (raw) return response;

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    // The two halves of Supabase report failure differently, and neither uses
    // the field the other does. Auth (GoTrue) says {msg, error_code}; the REST
    // layer (PostgREST) says {message, code, hint}. Reading only one of them
    // turns "Invalid login credentials" into a bare "HTTP 400", which tells the
    // person typing their password nothing at all.
    const message =
      json?.msg ??
      json?.message ??
      json?.error_description ??
      json?.error ??
      `HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    error.code = json?.error_code ?? json?.code;
    error.hint = json?.hint ?? null;
    throw error;
  }

  return json;
}

// ------------------------------------------------------------------ auth

export async function signIn(email, password) {
  const raw = await call('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  saveSession(withExpiry(raw));
  return session;
}

export async function signOut() {
  const token = session?.access_token;
  saveSession(null);
  if (!token) return;
  try {
    await call('/auth/v1/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      raw: true,
    });
  } catch {
    // The local session is already gone, which is what signing out means to
    // this device. A server that cannot be reached does not change that.
  }
}

// One refresh at a time. Without this, five queued syncs waking together each
// start their own, four of them spend a refresh token that the first has
// already rotated away, and the session dies for no reason.
async function refresh() {
  if (refreshing) return refreshing;
  if (!session?.refresh_token) throw new Error('Not signed in.');

  refreshing = (async () => {
    try {
      const raw = await call('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      saveSession(withExpiry(raw));
      return session;
    } catch (err) {
      // A refresh token the server rejects is finished - signing out locally is
      // the honest response. A network failure is not: the token is probably
      // fine and the session should survive being out of signal.
      if (err.status >= 400 && err.status < 500) saveSession(null);
      throw err;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

export async function accessToken() {
  if (!session) throw new Error('Not signed in.');
  if (expired(session)) await refresh();
  return session.access_token;
}

async function authed(path, options = {}) {
  const token = await accessToken();
  return call(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
}

// ------------------------------------------------------------------ rows

export function selectRows(table, { query = '', limit } = {}) {
  const parts = [query, limit ? `limit=${limit}` : ''].filter(Boolean);
  return authed(`/rest/v1/${table}?${parts.join('&')}`);
}

// Prefer: return=representation so the server hands back what it stored,
// including the server_updated_at stamp the sync cursor is built from. Without
// it the client would have to guess, and a guessed cursor skips rows.
export function upsertRows(table, rows) {
  if (!rows.length) return Promise.resolve([]);
  return authed(`/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(rows),
  });
}

// ------------------------------------------------------------------ files

export async function uploadObject(bucket, path, blob, contentType = 'image/jpeg') {
  const token = await accessToken();
  return call(`/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      // Retry of an interrupted upload lands on the same path rather than
      // leaving an orphan beside it.
      'x-upsert': 'true',
    },
    body: blob,
  });
}

export async function downloadObject(bucket, path) {
  const token = await accessToken();
  const response = await call(`/storage/v1/object/${bucket}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    raw: true,
  });
  if (!response.ok) {
    const error = new Error(`Could not fetch ${path}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.blob();
}

export async function updateUser(changes) {
  const updated = await authed('/auth/v1/user', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (session) saveSession({ ...session, user: updated });
  return updated;
}
