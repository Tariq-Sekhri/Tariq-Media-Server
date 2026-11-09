import { API_BASE } from "./media";

export type AdminPermissions = {
  access_admin_panel: boolean;
  view_users: boolean;
  create_users: boolean;
  edit_users: boolean;
  delete_users: boolean;
  view_logs: boolean;
  view_processes: boolean;
  manage_libraries: boolean;
  manage_downloads: boolean;
  logout_other_users: boolean;
  logout_admins: boolean;
};
export const emptyAdminPermissions = (): AdminPermissions => ({
  access_admin_panel: false,
  view_users: false,
  create_users: false,
  edit_users: false,
  delete_users: false,
  view_logs: false,
  view_processes: false,
  manage_libraries: false,
  manage_downloads: false,
  logout_other_users: false,
  logout_admins: false,
});
export type SessionUser = {
  id: number;
  name: string;
  is_admin: boolean;
  admin_permissions: AdminPermissions;
  password_set: boolean;
};
export const canAccessAdminPanel = (user: SessionUser | null | undefined) =>
  Boolean(user?.is_admin || user?.admin_permissions?.access_admin_panel);
export const hasAdminPermission = (
  user: SessionUser | null | undefined,
  permission: keyof AdminPermissions,
) => Boolean(user?.is_admin || (user?.admin_permissions?.access_admin_panel && user.admin_permissions[permission]));
export const SESSION_TOKEN_KEY = "tms:session-token";
export const SESSION_USER_KEY = "tms:session-user";
export const SESSION_REFRESH_TOKEN_KEY = "tms:device-token";
export const SESSION_EXPIRES_AT_KEY = "tms:session-expires-at";
export const DEVICE_ID_KEY = "tms:device-id";
const LEGACY_SESSION_TOKEN_KEY = "framebox:session-token";
const LEGACY_SESSION_USER_KEY = "framebox:session-user";

export type AuthSession = {
  token: string;
  refresh_token?: string;
  user: SessionUser;
};

// Media elements and stream segments cannot send an Authorization header.
// The server accepts this same-site cookie for file requests instead.
const SESSION_COOKIE = "tms_session";
const syncSessionCookie = (token: string) => {
  if (typeof document === "undefined") return;
  try {
    const current = document.cookie.split("; ").find((pair) => pair.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? "";
    if (current === token) return;
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = token
      ? `${SESSION_COOKIE}=${token}; Path=/; Max-Age=34560000; SameSite=Lax${secure}`
      : `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  } catch {
    // Cookies can be unavailable in some embedded contexts.
  }
};

export const getSessionToken = () => {
  if (typeof window === "undefined") return "";
  const token = readSessionToken();
  syncSessionCookie(token);
  return token;
};
const readSessionToken = () => {
  // Older installs kept the permanent device credential separately from an
  // expiring access token. Promote it locally without contacting the server.
  const deviceToken = localStorage.getItem(SESSION_REFRESH_TOKEN_KEY);
  if (deviceToken) {
    localStorage.setItem(SESSION_TOKEN_KEY, deviceToken);
    localStorage.removeItem(SESSION_REFRESH_TOKEN_KEY);
    localStorage.removeItem(SESSION_EXPIRES_AT_KEY);
    return deviceToken;
  }
  return localStorage.getItem(SESSION_TOKEN_KEY) ?? localStorage.getItem(LEGACY_SESSION_TOKEN_KEY) ?? "";
};
export const getSessionUser = (): SessionUser | null => {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(localStorage.getItem(SESSION_USER_KEY) ?? localStorage.getItem(LEGACY_SESSION_USER_KEY) ?? "null") as SessionUser | null; } catch { return null; }
};
export const hasActiveCachedSession = () => Boolean(getSessionToken() && getSessionUser());
export const rememberSession = (token: string, user: SessionUser) => {
  localStorage.setItem(SESSION_TOKEN_KEY, token);
  syncSessionCookie(token);
  localStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
  localStorage.removeItem(SESSION_EXPIRES_AT_KEY);
  localStorage.removeItem(SESSION_REFRESH_TOKEN_KEY);
  localStorage.removeItem(LEGACY_SESSION_TOKEN_KEY);
  localStorage.removeItem(LEGACY_SESSION_USER_KEY);
};
export const clearSession = () => {
  localStorage.removeItem(SESSION_TOKEN_KEY);
  syncSessionCookie("");
  localStorage.removeItem(SESSION_USER_KEY);
  localStorage.removeItem(SESSION_REFRESH_TOKEN_KEY);
  localStorage.removeItem(SESSION_EXPIRES_AT_KEY);
  localStorage.removeItem(LEGACY_SESSION_TOKEN_KEY);
  localStorage.removeItem(LEGACY_SESSION_USER_KEY);
};

const browserName = () => {
  const agent = navigator.userAgent;
  if (/Edg\//.test(agent)) return "Edge";
  if (/OPR\//.test(agent)) return "Opera";
  if (/Chrome\//.test(agent)) return "Chrome";
  if (/Firefox\//.test(agent)) return "Firefox";
  if (/Safari\//.test(agent)) return "Safari";
  return "Browser";
};

export const getDeviceIdentity = () => {
  let id = localStorage.getItem(DEVICE_ID_KEY) ?? "";
  if (!id) {
    id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  const platform = navigator.userAgentData?.platform || navigator.platform || "Unknown device";
  return { device_id: id, device_name: `${browserName()} on ${platform}`.slice(0, 160) };
};

export const getDeviceClass = (): "mobile" | "tablet" | "desktop" => {
  const agent = navigator.userAgent;
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(agent)) return "tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(agent)) return "mobile";
  return "desktop";
};

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
    || (error instanceof Error && error.name === "AbortError");
}

export type ClientErrorDetails = {
  kind?: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
};

const recentReports = new Map<string, number>();
let lastActivityHeartbeatAt = 0;
const describeError = (error: unknown) => error instanceof Error
  ? { message: error.message || error.name, stack: error.stack ?? "" }
  : { message: typeof error === "string" ? error : safeStringify(error), stack: "" };
const safeStringify = (value: unknown) => {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
};
const sendTelemetry = (path: string, body: Record<string, unknown>, token = getSessionToken()) => {
  // Extensions can replace window.fetch and surface their own rejected Promise
  // after our catch handler runs. XHR has no Promise chain, so telemetry stays
  // genuinely best-effort instead of becoming an application error overlay.
  try {
    const request = new XMLHttpRequest();
    request.open("POST", `${API_BASE}${path}`, true);
    request.setRequestHeader("Content-Type", "application/json");
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.send(JSON.stringify(body));
  } catch {
    // Telemetry must never affect the feature that triggered it.
  }
};

export const reportClientError = (error: unknown, details: ClientErrorDetails = {}) => {
  if (typeof window === "undefined" || !getSessionToken()) return;
  if (isAbortError(error)) return;
  const description = describeError(error);
  const message = description.message.slice(0, 4_000);
  if (!message) return;
  const route = `${window.location.pathname}${window.location.hash}`.slice(0, 1_000);
  const signature = `${details.kind ?? "client"}|${route}|${message}`;
  const now = Date.now();
  if ((recentReports.get(signature) ?? 0) > now - 5_000) return;
  recentReports.set(signature, now);
  if (recentReports.size > 100) recentReports.clear();
  sendTelemetry("/api/client-errors", {
    message,
    kind: details.kind ?? "client-error",
    stack: (details.stack ?? description.stack).slice(0, 8_000),
    route,
    source: (details.source ?? "").slice(0, 1_000),
    line: details.line ?? 0,
    column: details.column ?? 0,
    user_agent: navigator.userAgent.slice(0, 1_000),
  });
};

export const reportClientPerformance = (event: string, durationMs: number, details: Record<string, unknown> = {}) => {
  if (typeof window === "undefined" || !getSessionToken()) return;
  sendTelemetry("/api/client-performance", {
    event: event.slice(0, 120),
    duration_ms: Math.max(0, Math.round(durationMs)),
    route: `${window.location.pathname}${window.location.search}`.slice(0, 1_000),
    // Keep the device dimension on every metric, rather than relying on
    // a device name or user-agent that may change between sessions.
    details: { device_class: getDeviceClass(), ...details },
  });
};

const reportSessionActivity = () => {
  if (typeof window === "undefined") return;
  const token = getSessionToken();
  const now = Date.now();
  if (!token || now - lastActivityHeartbeatAt < 30_000) return;
  lastActivityHeartbeatAt = now;
  sendTelemetry("/api/auth/activity", {}, token);
};

export const authFetch = async (input: string | URL, init: RequestInit = {}) => {
  const token = getSessionToken();
  const send = () => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const request = String(input);
  return send().then((response) => {
    if (response.status === 401 && typeof window !== "undefined") {
      if (getSessionToken() === token) {
        clearSession();
        if (window.location.pathname !== "/login") window.location.replace("/login");
      }
    }
    if (response.status >= 500 && !request.endsWith("/api/client-errors")) {
      reportClientError(new Error(`API request failed with ${response.status}`), { kind: "api-server-error", source: request });
    }
    if (response.ok && !request.endsWith("/api/auth/activity")) reportSessionActivity();
    return response;
  }).catch((error: unknown) => {
    if (isAbortError(error)) throw error;
    if (!request.endsWith("/api/client-errors")) {
      reportClientError(error, { kind: "api-network-error", source: request });
    }
    throw error;
  });
};
export const logOut = async () => {
  try {
    await authFetch(`${API_BASE}/api/auth/logout`, { method: "POST", signal: AbortSignal.timeout(3_000) });
  } catch {
    // The local logout must finish even if the server cannot be reached.
  } finally {
    clearSession();
  }
};

// Restore the media cookie for sessions saved before it existed.
if (typeof window !== "undefined") getSessionToken();
