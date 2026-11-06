import { authFetch } from "../lib/auth";
import { API_BASE } from "../lib/media";
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(`${API_BASE}/api/discover${path}`, init);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || `Server returned ${response.status}`);
  return value as T;
}
export const jsonRequest = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
