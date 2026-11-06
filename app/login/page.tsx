"use client";

import { useEffect, useState, type FormEvent } from "react";
import { API_BASE } from "../lib/media";
import { getDeviceIdentity, rememberSession, reportClientPerformance, type AuthSession } from "../lib/auth";

export default function LoginPage() {
  // Password managers can add their own controls inside a field before React
  // hydrates. Keep credential inputs client-only so that injected UI (such as
  // LastPass's icon) cannot make the server markup disagree with the browser.
  const [hydrated, setHydrated] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  useEffect(() => {
    setHydrated(true);
    void fetch(`${API_BASE}/api/auth/setup`).then((response) => response.json() as Promise<{ required: boolean }>).then((result) => setSetupRequired(result.required)).catch(() => {}).finally(() => setCheckingSetup(false));
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || loading) return;
    setLoading(true);
    setError("");
    const started = performance.now();
    try {
      const response = await fetch(`${API_BASE}/api/auth/${setupRequired ? "setup" : "login"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), password, ...getDeviceIdentity() }) });
      if (!response.ok) throw new Error("That name or password is incorrect");
      const result = await response.json() as AuthSession;
      rememberSession(result.refresh_token || result.token, result.user);
      reportClientPerformance("login", performance.now() - started, { setup: setupRequired, device: getDeviceIdentity().device_name });
      window.location.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not log in");
      setLoading(false);
    }
  };
  if (!hydrated) return <main className="login-page" />;
  return <main className="login-page"><form className="login-card" onSubmit={submit}>
    <div className="login-brand"><span className="logo-badge" aria-hidden="true" /><div><strong>TMS</strong><small>Tariq’s Media Server</small></div></div>
    <p>{setupRequired ? "FIRST-RUN SETUP" : "PRIVATE MEDIA LIBRARY"}</p><h1>{checkingSetup ? "Checking server" : setupRequired ? "Create admin" : "Log in"}</h1><span>{setupRequired ? "Create the first administrator for this fresh server. A password is optional." : "Your session stays remembered until you log out or your password changes."}</span>
    {setupRequired && <div className="login-setup-warning" role="note"><b>One-time server setup</b><span>This account becomes the permanent first administrator. Choose the username carefully. To change the first account later, the server account data must be reset.</span></div>}
    <label><b>Name</b><input autoFocus autoComplete="username" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label><b>Password</b><span className="login-password-field"><input type={passwordVisible ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Leave blank if no password is set" /><button type="button" className="login-password-toggle" aria-label={passwordVisible ? "Hide password" : "Show password"} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>{passwordVisible ? "Hide" : "Show"}</button></span></label>
    {error && <div className="login-error" role="alert">{error}</div>}
    <button type="submit" disabled={!name.trim() || loading || checkingSetup}>{loading ? (setupRequired ? "Creating admin…" : "Logging in…") : setupRequired ? "Create admin" : "Log in"}</button>
  </form></main>;
}
