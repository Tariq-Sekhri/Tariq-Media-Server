export function AdminSpinner() {
  return <svg className="admin-loading-spinner" viewBox="0 0 32 32" width="32" height="32" fill="none" aria-hidden="true">
    <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="3" opacity=".18" />
    <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="3" strokeLinecap="round" pathLength="100" strokeDasharray="28 72" />
  </svg>;
}

export default function AdminLoading({ label, inline = false }: { label: string; inline?: boolean }) {
  return <span className={`admin-loading${inline ? " is-inline" : ""}`} role="status" aria-live="polite" aria-atomic="true">
    <AdminSpinner />
    <span>{label}</span>
  </span>;
}
