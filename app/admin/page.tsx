"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { useAppConfirm } from "../AppConfirmProvider";
import { API_BASE } from "../lib/media";
import { authFetch, canAccessAdminPanel, clearSession, emptyAdminPermissions, getSessionUser, hasAdminPermission, logOut, reportClientPerformance, type AdminPermissions } from "../lib/auth";
import type { YtDlpJob } from "../ServerDownloadDialog";
import { isActiveWork, isFinishedWork, needsWorkAttention, showWork, workTitle } from "../lib/running-work";
import MenuIcon from "../MenuIcon";
import AdminTrash from "./Trash";
import LibrariesOptions, { LibrariesLayoutPicker, useLibrariesLayout } from "./LibrariesOptions";
import MobileNavigation from "../MobileNavigation";
import { mainNavigation } from "../lib/navigation";
import { RequestsPanel } from "../discover/Requests";
import "../discover/style.css";
import "../admin-mobile.css";
import { useBackLayer } from "../lib/back-layers";
import { navigateApp } from "../lib/app-shell";
import MetricsInsights from "./metrics-insights";

type LogsResponse = { files: string[]; lines: string[]; actors: string[]; total_events: number; stored_events: number; total_bytes: number; server_lines?: string[]; error_lines?: string[] };
type AdminUser = { id: number; name: string; password_set: boolean; created_at: number; last_active_at: number | null; is_admin: boolean; admin_permissions: AdminPermissions; storage_quota_bytes: number | null; used_bytes: number; reserved_bytes: number; available_bytes: number | null };
type DeviceSession = { token: string; created_at: number; device: string; user_agent: string; ip_address: string; current: boolean; expires_at: number };
type LibraryContentType = "mixed" | "movies_tv" | "music" | "files";
type LibraryMember = { name: string; can_view: boolean; can_delete: boolean; can_move: boolean; can_create_folders: boolean; can_upload: boolean; can_download: boolean; can_rename: boolean };
type LibraryConfig = { content_type: LibraryContentType; members: LibraryMember[]; title_folders: string[]; trickplay_enabled: boolean; folder_structure_static: boolean };
type LibraryLocation = { name: string; path: string; external: boolean; available: boolean; parent_library?: string; folder_path?: string };
type LibraryLocationsResponse = { main_root: string; main_root_available: boolean; locations: LibraryLocation[] };
type FolderBrowserResponse = { current_path: string | null; parent_path: string | null; folders: { name: string; path: string }[] };
type DeleteRequest = { id: string; path: string; requested_by: number; requested_by_name: string; requested_at: number };
type AdminSection = "overview" | "notifications" | "users" | "metrics" | "processes" | "locations" | "libraries" | "downloads" | "trash";
type AdminLoadTiming = {
  cacheState: "hit" | "miss";
  cacheLoadTimeMs: number;
  serverState: "loading" | "connected" | "disconnected";
  serverLoadTimeMs?: number;
  totalLoadTimeMs?: number;
};
const ADMIN_USERS_CACHE_TTL_MS = 60_000;
const adminUsersCacheKey = (userId: number) => `tms:admin-users:${userId}`;
const readCachedAdminUsers = (userId: number | undefined): AdminUser[] => {
  if (typeof window === "undefined" || !userId) return [];
  try {
    const cached = JSON.parse(sessionStorage.getItem(adminUsersCacheKey(userId)) ?? "null") as { savedAt?: number; users?: AdminUser[] } | null;
    return cached && Date.now() - (cached.savedAt ?? 0) < ADMIN_USERS_CACHE_TTL_MS && Array.isArray(cached.users) ? cached.users : [];
  } catch { return []; }
};
const cacheAdminUsers = (userId: number | undefined, users: AdminUser[]) => {
  if (typeof window === "undefined" || !userId) return;
  try { sessionStorage.setItem(adminUsersCacheKey(userId), JSON.stringify({ savedAt: Date.now(), users })); } catch { /* Private browsing or a full session store should not block administration. */ }
};
const adminSections: AdminSection[] = ["overview", "notifications", "users", "metrics", "processes", "locations", "libraries", "downloads", "trash"];
const adminSectionFromUrl = () => {
  if (typeof window === "undefined") return "users" as AdminSection;
  const candidate = new URLSearchParams(window.location.search).get("section");
  if (candidate === "activity" || candidate === "logs") return "metrics";
  return adminSections.includes(candidate as AdminSection) ? candidate as AdminSection : "users";
};
type YtDlpCookiesStatus = {
  exists: boolean;
  size_bytes: number;
  updated_at: number | null;
  line_count: number;
  sample_domains: string[];
  has_youtube_auth: boolean;
};
type AdminDownloadStatus = {
  tool: { ready: boolean; checking: boolean; version: string | null; error: string | null; updated_at: number | null };
  throttle: {
    sleep_interval_seconds: number;
    max_sleep_interval_seconds: number;
    limit_rate: string;
  };
  cookies?: YtDlpCookiesStatus;
};
const normalizeLogs = (value: Partial<LogsResponse>): LogsResponse => ({ files: value.files ?? [], lines: value.lines ?? [], actors: value.actors ?? [], total_events: value.total_events ?? value.lines?.length ?? 0, stored_events: value.stored_events ?? value.total_events ?? value.lines?.length ?? 0, total_bytes: value.total_bytes ?? 0, server_lines: value.server_lines ?? [], error_lines: value.error_lines ?? [] });
type AdminProcessTransfer = { state: string; download_speed: number; upload_speed: number; completed_bytes: number; total_bytes: number; remaining_bytes: number; eta_seconds: number; seeds: number; peers: number };
type AdminProcess = {
  id: string;
  kind: string;
  status: string;
  title: string;
  detail: string;
  user_name: string | null;
  progress: number | null;
  started_at: number;
  pid: number | null;
  eta: string | null;
  eta_seconds?: number | null;
  avg_item_seconds?: number | null;
  current_item?: string | null;
  destination_path?: string | null;
  speed?: string | null;
  error?: string | null;
  paused_until?: number | null;
  transfer: AdminProcessTransfer | null;
  actions: string[];
};

const sectionCopy: Record<AdminSection, { title: string }> = {
  overview: { title: "Admin access" },
  notifications: { title: "Requests" },
  users: { title: "Users" },
  metrics: { title: "Metrics" },
  processes: { title: "Running work" },
  locations: { title: "Library locations" },
  libraries: { title: "Libraries" },
  downloads: { title: "Server downloads" },
  trash: { title: "Trash" },
};
const libraryTypes: { value: LibraryContentType; label: string }[] = [
  { value: "mixed", label: "Mixed media" },
  { value: "movies_tv", label: "Movies & TV shows" },
  { value: "music", label: "Music" },
  { value: "files", label: "Any files" },
];
const isLocalHost = () => typeof window !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
const libraryMemberPreset = (member: LibraryMember | undefined): "none" | "viewer" | "user" | "editor" | "manager" => {
  if (!member?.can_view) return "none";
  if (member.can_delete) return "manager";
  if (member.can_upload && member.can_download && !member.can_move && !member.can_create_folders && !member.can_rename) return "user";
  if (member.can_move || member.can_create_folders || member.can_upload || member.can_download || member.can_rename) return "editor";
  return "viewer";
};
const libraryPresetLabel = (preset: ReturnType<typeof libraryMemberPreset>) => ({ none: "No access", viewer: "Viewer", user: "User", editor: "Editor", manager: "Manager" })[preset];
const libraryPermissions: { key: keyof Omit<LibraryMember, "name">; label: string; description: string }[] = [
  { key: "can_view", label: "View media", description: "Browse and play" },
  { key: "can_delete", label: "Delete", description: "Remove files" },
  { key: "can_move", label: "Move", description: "Organize files" },
  { key: "can_create_folders", label: "Create folders", description: "Add folders" },
  { key: "can_upload", label: "Upload files", description: "Add files from a computer" },
  { key: "can_download", label: "Server downloads", description: "Add yt-dlp and magnet downloads" },
  { key: "can_rename", label: "Rename", description: "Change names" },
];
const accountPermissions: { key: keyof AdminPermissions; label: string; description: string }[] = [
  { key: "access_admin_panel", label: "Access admin panel", description: "Open the dashboard and its permitted sections" },
  { key: "view_users", label: "View users", description: "See accounts, password status, and storage usage" },
  { key: "create_users", label: "Create users", description: "Add standard user accounts" },
  { key: "edit_users", label: "Edit users", description: "Change passwords, quotas, and standard accounts" },
  { key: "delete_users", label: "Delete users", description: "Remove standard accounts and revoke their sessions" },
  { key: "view_logs", label: "View metrics", description: "See client performance and load-time metrics" },
  { key: "view_processes", label: "View running work", description: "See active downloads, FFmpeg work, and server jobs across users" },
  { key: "manage_libraries", label: "Manage libraries", description: "Create, configure, and remove libraries" },
  { key: "manage_downloads", label: "Manage server downloads", description: "Manage yt-dlp and download pacing" },
  { key: "logout_other_users", label: "Log out other users", description: "View and revoke remembered devices for non-admin accounts" },
  { key: "logout_admins", label: "Log out administrators", description: "View and revoke devices for any account, including administrators" },
];
const accountPreset = (preset: "users" | "auditor" | "libraries") => ({
  ...emptyAdminPermissions(),
  access_admin_panel: true,
  ...(preset === "users" ? { view_users: true, create_users: true, edit_users: true, delete_users: true } : {}),
  ...(preset === "auditor" ? { view_logs: true } : {}),
  ...(preset === "libraries" ? { manage_libraries: true } : {}),
});
const DEFAULT_QUOTA_GB = 100;
const formatBytes = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return "Unlimited";
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
};
const performanceDetails = (line: string): Record<string, unknown> | null => {
  const quoted = line.match(/details="({.*?})"/)?.[1].replace(/\\"/g, '"');
  const raw = quoted ?? line.match(/details=({.*?})(?:\s|$)/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
};
const formatRate = (bytes: number) => bytes > 0 ? `${formatBytes(bytes)}/s` : "Waiting";
const formatEta = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 8_640_000) return "Calculating";
  const rounded = Math.ceil(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
};
const estimateEtaFromProgress = (progress: number | null, startedAt: number, now: number): number | null => {
  if (progress == null || progress <= 0 || progress >= 1) return null;
  const elapsedSeconds = Math.max(0, now / 1000 - startedAt);
  if (elapsedSeconds < 5) return null;
  const estimate = Math.ceil(elapsedSeconds * (1 - progress) / progress);
  return Number.isFinite(estimate) && estimate > 0 && estimate < 8_640_000 ? estimate : null;
};
const parseEtaSeconds = (eta: string): number | null => {
  if (!eta || typeof eta !== "string") return null;
  const str = eta.trim().toLowerCase();
  let total = 0;
  let matched = false;
  const dMatch = /(\d+)\s*d/.exec(str);
  if (dMatch) { total += parseInt(dMatch[1], 10) * 86400; matched = true; }
  const hMatch = /(\d+)\s*h/.exec(str);
  if (hMatch) { total += parseInt(hMatch[1], 10) * 3600; matched = true; }
  const mMatch = /(\d+)\s*m/.exec(str);
  if (mMatch) { total += parseInt(mMatch[1], 10) * 60; matched = true; }
  const sMatch = /(\d+)\s*s/.exec(str);
  if (sMatch) { total += parseInt(sMatch[1], 10); matched = true; }
  if (matched) return total;

  const colonParts = str.split(":").map((p) => parseInt(p, 10));
  if (colonParts.length === 3 && colonParts.every((n) => !isNaN(n))) {
    return colonParts[0] * 3600 + colonParts[1] * 60 + colonParts[2];
  }
  if (colonParts.length === 2 && colonParts.every((n) => !isNaN(n))) {
    return colonParts[0] * 60 + colonParts[1];
  }
  return null;
};
const formatEstimatedCompletion = (etaSeconds: number | null | undefined, etaString: string | null | undefined): string | null => {
  let seconds = etaSeconds;
  if (seconds == null && etaString) {
    seconds = parseEtaSeconds(etaString);
  }
  if (seconds == null || seconds <= 0 || !Number.isFinite(seconds)) return null;
  const completionDate = new Date(Date.now() + seconds * 1000);
  return completionDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};
const formatAvgDownloadTime = (seconds: number | null | undefined): string | null => {
  if (seconds == null || seconds <= 0 || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s/item`;
  const mins = Math.floor(seconds / 60);
  const remSecs = Math.round(seconds % 60);
  if (seconds < 3600) return remSecs > 0 ? `${mins}m ${remSecs}s/item` : `${mins}m/item`;
  const hours = Math.floor(seconds / 3600);
  const remMins = Math.floor((seconds % 3600) / 60);
  return remMins > 0 ? `${hours}h ${remMins}m/item` : `${hours}h/item`;
};
const formatDownloadSpeed = (speed: string | null | undefined): string | null => {
  if (!speed || speed === "NA") return null;
  const num = parseFloat(speed);
  if (!isNaN(num) && num > 0) return formatRate(num);
  return speed;
};
const quotaBytes = (value: string) => Math.max(0, Math.round((Number(value) || 0) * 1024 ** 3));
const libraryFingerprint = (library: LibraryConfig) => JSON.stringify({ content_type: library.content_type, members: library.members, trickplay_enabled: library.trickplay_enabled, folder_structure_static: library.folder_structure_static });
const formatCreatedDate = (timestamp: number) => timestamp
  ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(timestamp * 1000))
  : "Unknown";
const logValue = (line: string, key: string) => line.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))?.[1];

export default function AdminDashboard({ embedded = false }: { embedded?: boolean } = {}) {
  const appConfirm = useAppConfirm();
  const currentUser = useMemo(() => getSessionUser(), []);
  const canViewUsers = hasAdminPermission(currentUser, "view_users");
  const canCreateUsers = hasAdminPermission(currentUser, "create_users");
  const canEditUsers = hasAdminPermission(currentUser, "edit_users");
  const canDeleteUsers = hasAdminPermission(currentUser, "delete_users");
  const canViewLogs = hasAdminPermission(currentUser, "view_logs");
  const canViewProcesses = hasAdminPermission(currentUser, "view_processes");
  const canManageLibraries = hasAdminPermission(currentUser, "manage_libraries");
  const canManageDownloads = hasAdminPermission(currentUser, "manage_downloads");
  const canLogOutOtherUsers = hasAdminPermission(currentUser, "logout_other_users");
  const canLogOutAdmins = hasAdminPermission(currentUser, "logout_admins");
  const [section, setSelectedSection] = useState<AdminSection>("users");
  const [metricsLogs, setMetricsLogs] = useState<LogsResponse>({ files: [], lines: [], actors: [], total_events: 0, stored_events: 0, total_bytes: 0 });
  const [metricDeviceFilter, setMetricDeviceFilter] = useState("all");
  const [clearingMetrics, setClearingMetrics] = useState(false);
  const [metricsClearMessage, setMetricsClearMessage] = useState("");
  const [processes, setProcesses] = useState<AdminProcess[]>([]);
  const [processUpdatedAt, setProcessUpdatedAt] = useState<number | null>(null);
  const [processRefreshError, setProcessRefreshError] = useState("");
  const [processClock, setProcessClock] = useState(Date.now());
  const [torrentUpdatedAt, setTorrentUpdatedAt] = useState<Record<string, number>>({});
  const [showFinishedWork, setShowFinishedWork] = useState(false);
  const processRefreshInFlight = useRef(false);
  const acceptProcesses = useCallback((items: AdminProcess[]) => {
    setProcesses(items);
    setProcessUpdatedAt(Date.now());
    setProcessRefreshError("");
    setTorrentUpdatedAt((previous) => {
      const next = { ...previous };
      for (const item of items) if (item.id.startsWith("magnet:") && item.transfer) next[item.id] = Date.now();
      return next;
    });
  }, []);
  const [processAction, setProcessAction] = useState("");
  const [users, setUsers] = useState<AdminUser[]>(() => readCachedAdminUsers(currentUser?.id));
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  useBackLayer(accountMenuOpen, () => setAccountMenuOpen(false));
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const activeAppNavRef = useRef<HTMLAnchorElement>(null);
  const [deleteRequests, setDeleteRequests] = useState<DeleteRequest[]>([]);
  const [discoverRequestRefresh, setDiscoverRequestRefresh] = useState(0);
  const [pendingDiscoverRequests, setPendingDiscoverRequests] = useState(0);
  const pendingAdminNotifications = deleteRequests.length + pendingDiscoverRequests;
  const [resolvingDeleteRequest, setResolvingDeleteRequest] = useState("");
  const [libraries, setLibraries] = useState<Record<string, LibraryConfig>>({});
  const [libraryLocations, setLibraryLocations] = useState<LibraryLocationsResponse | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<AdminDownloadStatus | null>(null);
  const [refreshingJobs, setRefreshingJobs] = useState(false);
  const [cookieContent, setCookieContent] = useState("");
  const [cookieBrowser, setCookieBrowser] = useState("auto");
  const [savingCookies, setSavingCookies] = useState(false);
  const [extractingCookies, setExtractingCookies] = useState(false);
  const [testingCookies, setTestingCookies] = useState(false);
  const [cookieTestResult, setCookieTestResult] = useState<{ valid: boolean; message: string } | null>(null);
  const [cookieExtractResult, setCookieExtractResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showCookieEditor, setShowCookieEditor] = useState(false);
  const [showCookieGuide, setShowCookieGuide] = useState(false);
  const [sleepInterval, setSleepInterval] = useState("0");
  const [maxSleepInterval, setMaxSleepInterval] = useState("0");
  const [limitRate, setLimitRate] = useState("");
  const [throttleSaveState, setThrottleSaveState] = useState<"" | "saving" | "saved">("");
  const throttleSnapshotRef = useRef("");
  const throttleSaveTimerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(() => users.length === 0);
  const [error, setError] = useState("");
  const [, setLoadTiming] = useState<AdminLoadTiming>({ cacheState: "miss", cacheLoadTimeMs: 0, serverState: "loading" });
  const [showAddUser, setShowAddUser] = useState(false);
  const [userName, setUserName] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [userIsAdmin, setUserIsAdmin] = useState(false);
  const [userAdminPermissions, setUserAdminPermissions] = useState<AdminPermissions>(emptyAdminPermissions);
  const [userQuotaGb, setUserQuotaGb] = useState(DEFAULT_QUOTA_GB.toString());
  const [userQuotaUnlimited, setUserQuotaUnlimited] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editUserIsAdmin, setEditUserIsAdmin] = useState(false);
  const [editAdminPermissions, setEditAdminPermissions] = useState<AdminPermissions>(emptyAdminPermissions);
  const [editQuotaGb, setEditQuotaGb] = useState(DEFAULT_QUOTA_GB.toString());
  const [editQuotaUnlimited, setEditQuotaUnlimited] = useState(false);
  const [changePassword, setChangePassword] = useState(false);
  const [editPassword, setEditPassword] = useState("");
  const [savingUser, setSavingUser] = useState(false);
  const [deletingUser, setDeletingUser] = useState(false);
  const [sessionUser, setSessionUser] = useState<AdminUser | null>(null);
  const [userSessions, setUserSessions] = useState<DeviceSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [revokingSession, setRevokingSession] = useState("");
  const [savingLibrary, setSavingLibrary] = useState("");
  const [savedLibrary, setSavedLibrary] = useState("");
  const [trickplayAction, setTrickplayAction] = useState("");
  const [librariesLayout, setLibrariesLayout] = useLibrariesLayout();
  const [showCreateLibrary, setShowCreateLibrary] = useState(false);
  const [libraryName, setLibraryName] = useState("");
  const [libraryContentType, setLibraryContentType] = useState<LibraryContentType>("mixed");
  const [creatingLibrary, setCreatingLibrary] = useState(false);
  const [showAddLocation, setShowAddLocation] = useState(false);
  const [locationName, setLocationName] = useState("");
  const [locationPath, setLocationPath] = useState("");
  const [locationContentType, setLocationContentType] = useState<LibraryContentType>("mixed");
  const [locationMode, setLocationMode] = useState<"library" | "folder">("library");
  const [destinationLibrary, setDestinationLibrary] = useState("");
  const [destinationFolder, setDestinationFolder] = useState("");
  const [folderBrowser, setFolderBrowser] = useState<FolderBrowserResponse | null>(null);
  const [browsingFolders, setBrowsingFolders] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [creatingLocation, setCreatingLocation] = useState(false);
  const [detachingLocation, setDetachingLocation] = useState("");
  const librarySnapshotsRef = useRef<Record<string, string>>({});
  const pendingLibrarySavesRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const savingLibrariesRef = useRef<Set<string>>(new Set());
  const loadedSectionsRef = useRef<Set<AdminSection>>(users.length ? new Set<AdminSection>(["users"]) : new Set());
  const activeLoadRef = useRef(0);
  const availableSections = useMemo(() => [
    ...(currentUser?.is_admin ? ["notifications" as const] : []),
    ...(!(canViewUsers || canCreateUsers || canEditUsers || canDeleteUsers || canLogOutOtherUsers || canLogOutAdmins || canViewLogs || canViewProcesses || canManageLibraries || canManageDownloads) ? ["overview" as const] : []),
    ...(canViewUsers || canCreateUsers || canEditUsers || canDeleteUsers || canLogOutOtherUsers || canLogOutAdmins ? ["users" as const] : []),
    ...(canViewLogs ? ["metrics" as const] : []),
    ...(canViewProcesses ? ["processes" as const] : []),
    ...(canManageLibraries ? ["locations" as const] : []),
    ...(canManageLibraries ? ["libraries" as const] : []),
    ...(canManageDownloads ? ["downloads" as const] : []),
    ...(currentUser?.is_admin ? ["trash" as const] : []),
  ], [canCreateUsers, canDeleteUsers, canEditUsers, canLogOutAdmins, canLogOutOtherUsers, canManageDownloads, canManageLibraries, canViewLogs, canViewProcesses, canViewUsers, currentUser?.is_admin]);

  const loadDeleteRequests = useCallback(async () => {
    if (!currentUser?.is_admin) return;
    const response = await authFetch(`${API_BASE}/api/admin/delete-requests`);
    if (!response.ok) throw new Error(`Could not load deletion requests (${response.status})`);
    setDeleteRequests(await response.json() as DeleteRequest[]);
  }, [currentUser?.is_admin]);

  useEffect(() => {
    if (!currentUser?.is_admin) return;
    let active = true;
    const loadRequests = async () => {
      await Promise.allSettled([loadDeleteRequests(), (async () => {
        const response = await authFetch(`${API_BASE}/api/discover/requests`);
        if (!response.ok) return;
        const result = await response.json() as { requests: { id: string }[] };
        if (active) setPendingDiscoverRequests(result.requests.length);
      })()]);
    };
    const initial = window.setTimeout(() => void loadRequests(), 0);
    const timer = window.setInterval(() => void loadRequests(), 30_000);
    return () => { active = false; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [currentUser?.id, currentUser?.is_admin, loadDeleteRequests]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOnOutsideClick); document.removeEventListener("keydown", closeOnEscape); };
  }, [accountMenuOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => activeAppNavRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" }), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const resolveDeleteRequest = async (entry: DeleteRequest, action: "trash" | "dismiss") => {
    if (action === "trash" && !await appConfirm({ title: "Move to Trash?", description: `Move ${entry.path} to recoverable Trash?`, action: "Move to Trash", danger: true })) return;
    setResolvingDeleteRequest(entry.id);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/delete-requests/${encodeURIComponent(entry.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(response.status === 404 ? "This item is no longer available. Dismiss the stale request." : `Could not resolve request (${response.status})`);
      await loadDeleteRequests();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not resolve the request");
    } finally {
      setResolvingDeleteRequest("");
    }
  };

  const selectSection = useCallback((nextSection: AdminSection) => {
    if (nextSection === section) return;
    const params = new URLSearchParams(window.location.search);
    params.set("section", nextSection);
    window.history.pushState(null, "", `${window.location.pathname}?${params}`);
    setSelectedSection(nextSection);
  }, [section]);
  const setSection = selectSection;

  const clearMetrics = async () => {
    if (!currentUser?.is_admin || !await appConfirm({ title: "Clear performance metrics?", description: "Permanently delete recorded client performance metrics across all users? This cannot be undone.", action: "Clear metrics", danger: true })) return;
    setClearingMetrics(true);
    setMetricsClearMessage("");
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/performance/clear`, { method: "POST" });
      if (!response.ok) throw new Error(`Could not clear metrics (${response.status})`);
      const result = await response.json() as { removed: number };
      setMetricsLogs({ files: [], lines: [], actors: [], total_events: 0, stored_events: 0, total_bytes: 0 });
      setMetricDeviceFilter("all");
      setMetricsClearMessage(`${result.removed} performance ${result.removed === 1 ? "event" : "events"} cleared.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not clear metrics");
    } finally {
      setClearingMetrics(false);
    }
  };

  const refresh = useCallback(async () => {
    if (section === "metrics") setMetricsClearMessage("");
    const loadId = ++activeLoadRef.current;
    const started = performance.now();
    const hasCachedSection = loadedSectionsRef.current.has(section);
    const cacheState = hasCachedSection ? "hit" : "miss";
    const cacheLoadTimeMs = performance.now() - started;
    setLoadTiming({ cacheState, cacheLoadTimeMs, serverState: "loading" });
    setLoading(!hasCachedSection);
    try {
      if (section === "notifications" && currentUser?.is_admin) {
        setDiscoverRequestRefresh(value => value + 1);
        await loadDeleteRequests();
      }
      const needsUsers = canViewUsers || canCreateUsers || canEditUsers || canDeleteUsers || canLogOutOtherUsers || canLogOutAdmins || canManageLibraries || canManageDownloads;
      const [metricsLogsResponse, processesResponse, usersResponse, librariesResponse, locationsResponse, downloadsResponse] = await Promise.all([
        section === "metrics" && canViewLogs ? authFetch(`${API_BASE}/api/admin/performance`) : null,
        section === "processes" && canViewProcesses ? authFetch(`${API_BASE}/api/admin/processes`, { signal: AbortSignal.timeout(12_000) }) : null,
        (section === "users" || section === "downloads") && needsUsers ? authFetch(`${API_BASE}/api/admin/users`) : null,
        (section === "libraries" || section === "locations") && canManageLibraries ? authFetch(`${API_BASE}/api/libraries`) : null,
        section === "locations" && canManageLibraries ? authFetch(`${API_BASE}/api/admin/library-locations`) : null,
        section === "downloads" && canManageDownloads ? authFetch(`${API_BASE}/api/admin/downloads`) : null,
      ]);
      if (activeLoadRef.current !== loadId) return;
      const responses = [metricsLogsResponse, processesResponse, usersResponse, librariesResponse, locationsResponse, downloadsResponse].filter((response): response is Response => Boolean(response));
      if (responses.some((response) => !response.ok)) throw new Error("One or more permitted admin requests failed");
      if (metricsLogsResponse) setMetricsLogs(normalizeLogs(await metricsLogsResponse.json() as Partial<LogsResponse>));
      if (activeLoadRef.current !== loadId) return;
      if (processesResponse) acceptProcesses((await processesResponse.json() as { processes: AdminProcess[] }).processes);
      if (activeLoadRef.current !== loadId) return;
      if (usersResponse) {
        const nextUsers = await usersResponse.json() as AdminUser[];
        if (activeLoadRef.current !== loadId) return;
        setUsers(nextUsers);
        cacheAdminUsers(currentUser?.id, nextUsers);
      }
      if (librariesResponse) {
        const nextLibraries = await librariesResponse.json() as Record<string, LibraryConfig>;
        if (activeLoadRef.current !== loadId) return;
        librarySnapshotsRef.current = Object.fromEntries(Object.entries(nextLibraries).map(([path, library]) => [path, libraryFingerprint(library)]));
        setLibraries(nextLibraries);
      }
      if (locationsResponse) {
        const nextLocations = await locationsResponse.json() as LibraryLocationsResponse;
        if (activeLoadRef.current !== loadId) return;
        setLibraryLocations(nextLocations);
      }
      if (downloadsResponse) {
        const nextDownloadStatus = await downloadsResponse.json() as AdminDownloadStatus;
        if (activeLoadRef.current !== loadId) return;
        setDownloadStatus(nextDownloadStatus);
        const snapshot = JSON.stringify(nextDownloadStatus.throttle);
        throttleSnapshotRef.current = snapshot;
        setSleepInterval(String(nextDownloadStatus.throttle.sleep_interval_seconds ?? 0));
        setMaxSleepInterval(String(nextDownloadStatus.throttle.max_sleep_interval_seconds ?? 0));
        setLimitRate(nextDownloadStatus.throttle.limit_rate ?? "");
        setThrottleSaveState("");
      }
      if (activeLoadRef.current !== loadId) return;
      loadedSectionsRef.current.add(section);
      const serverLoadTimeMs = performance.now() - started;
      setError("");
      const totalLoadTimeMs = performance.now() - started;
      setLoadTiming({ cacheState, cacheLoadTimeMs, serverState: "connected", serverLoadTimeMs, totalLoadTimeMs });
      reportClientPerformance("admin_section_load_complete", totalLoadTimeMs, {
        section,
        cache_hit: cacheState === "hit",
        cache_state: cacheState,
        cache_read_ms: Math.round(cacheLoadTimeMs),
        server_connected: true,
        api_wait_ms: Math.round(serverLoadTimeMs),
        total_wait_ms: Math.round(totalLoadTimeMs),
      });
    } catch (reason) {
      if (activeLoadRef.current !== loadId) return;
      if (section === "processes") setProcessRefreshError(reason instanceof Error ? reason.message : "Could not refresh live work status");
      else setError(reason instanceof Error ? reason.message : "Could not reach the server");
      const serverLoadTimeMs = performance.now() - started;
      setLoadTiming({ cacheState, cacheLoadTimeMs, serverState: "disconnected", serverLoadTimeMs, totalLoadTimeMs: serverLoadTimeMs });
      reportClientPerformance("admin_section_load_failed", serverLoadTimeMs, {
        section,
        cache_hit: cacheState === "hit",
        cache_state: cacheState,
        cache_read_ms: Math.round(cacheLoadTimeMs),
        server_connected: false,
      });
    } finally {
      if (activeLoadRef.current === loadId) setLoading(false);
    }
  }, [acceptProcesses, canCreateUsers, canDeleteUsers, canEditUsers, canLogOutAdmins, canLogOutOtherUsers, canManageDownloads, canManageLibraries, canViewLogs, canViewProcesses, canViewUsers, currentUser?.id, currentUser?.is_admin, loadDeleteRequests, section]);

  useEffect(() => {
    cacheAdminUsers(currentUser?.id, users);
  }, [currentUser?.id, users]);

  const refreshAdminJobs = async () => {
    if (processRefreshInFlight.current) return;
    processRefreshInFlight.current = true;
    setRefreshingJobs(true);
    try {
      const response = await authFetch(`${API_BASE}/api/admin/processes`, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`Live work status request failed (${response.status})`);
      acceptProcesses((await response.json() as { processes: AdminProcess[] }).processes);
    } catch (reason) {
      setProcessRefreshError(reason instanceof Error ? reason.message : "Could not refresh live work status");
    } finally {
      processRefreshInFlight.current = false;
      setRefreshingJobs(false);
    }
  };

  const saveCookies = async (content: string) => {
    if (!content.trim()) return;
    setSavingCookies(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/downloads/cookies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.trim() }),
      });
      if (!response.ok) throw new Error("Could not save cookies file.");
      const updatedCookies = await response.json() as YtDlpCookiesStatus;
      setDownloadStatus((current) => current ? { ...current, cookies: updatedCookies } : current);
      setShowCookieEditor(false);
      setCookieContent("");
      setCookieExtractResult(null);
      setCookieTestResult({ valid: true, message: "Cookies saved successfully!" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to save cookies.");
    } finally {
      setSavingCookies(false);
    }
  };

  const handleCookieFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setCookieContent(text);
      setShowCookieEditor(true);
    };
    reader.readAsText(file);
  };

  const extractCookiesFromBrowser = async () => {
    setExtractingCookies(true);
    setCookieExtractResult(null);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/downloads/cookies/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browser: cookieBrowser }),
      });
      const result = await response.json() as { success: boolean; message: string; status: YtDlpCookiesStatus };
      if (result.status) {
        setDownloadStatus((current) => current ? { ...current, cookies: result.status } : current);
      }
      setCookieExtractResult({ success: result.success, message: result.message });
      if (!result.success) {
        setShowCookieEditor(true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not extract cookies.");
    } finally {
      setExtractingCookies(false);
    }
  };

  const testCookies = async () => {
    setTestingCookies(true);
    setCookieTestResult(null);
    try {
      const response = await authFetch(`${API_BASE}/api/admin/downloads/cookies/test`, { method: "POST" });
      const result = await response.json() as { valid: boolean; message: string };
      setCookieTestResult(result);
    } catch (reason) {
      setCookieTestResult({ valid: false, message: reason instanceof Error ? reason.message : "Failed to test cookies." });
    } finally {
      setTestingCookies(false);
    }
  };

  const deleteCookies = async () => {
    if (!await appConfirm({ title: "Remove saved cookies?", description: "Remove the server?s cookies.txt file? Downloads requiring those cookies may need you to import them again.", action: "Remove cookies", danger: true })) return;
    try {
      const response = await authFetch(`${API_BASE}/api/admin/downloads/cookies`, { method: "DELETE" });
      if (response.ok) {
        const updatedCookies = await response.json() as YtDlpCookiesStatus;
        setDownloadStatus((current) => current ? { ...current, cookies: updatedCookies } : current);
        setCookieTestResult(null);
        setCookieExtractResult(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete cookies.");
    }
  };

  const controlProcess = async (process: AdminProcess, action: string) => {
    const key = `${process.id}:${action}`;
    if (processAction) return;
    setProcessAction(key);
    setError("");
    try {
      const isMagnet = process.id.startsWith("magnet:");
      const endpoint = isMagnet ? `${API_BASE}/api/downloads/magnet/control` : `${API_BASE}/api/admin/processes/${encodeURIComponent(process.id)}/control`;
      const response = await authFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(isMagnet ? { hash: process.id.slice("magnet:".length), action: action === "kill" ? "cancel" : action } : { action }), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message || `Could not ${action} ${process.kind}`);
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not control this work");
    } finally {
      setProcessAction("");
    }
  };

  useEffect(() => {
    if (!canAccessAdminPanel(currentUser) || availableSections.length === 0) { window.location.replace("/"); return; }
    if (!availableSections.includes(section)) {
      const fallback = availableSections[0];
      const params = new URLSearchParams(window.location.search);
      params.set("section", fallback);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
      setSelectedSection(fallback);
    }
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [availableSections, currentUser, refresh, section]);

  useEffect(() => {
    // Leaving Admin for the library also fires popstate; ignore it there.
    const restoreSectionFromUrl = () => { if (window.location.pathname === "/admin") setSelectedSection(adminSectionFromUrl()); };
    restoreSectionFromUrl();
    window.addEventListener("popstate", restoreSectionFromUrl);
    return () => window.removeEventListener("popstate", restoreSectionFromUrl);
  }, []);

  useEffect(() => {
    if (section !== "processes" || !canViewProcesses) return;
    let disposed = false;
    const refreshProcesses = async () => {
      if (processRefreshInFlight.current) return;
      processRefreshInFlight.current = true;
      try {
        const response = await authFetch(`${API_BASE}/api/admin/processes`, { signal: AbortSignal.timeout(12_000) });
        if (!response.ok) throw new Error(`Live work status request failed (${response.status})`);
        const data = await response.json() as { processes: AdminProcess[] };
        if (!disposed) acceptProcesses(data.processes);
      } catch (reason) {
        if (!disposed) setProcessRefreshError(reason instanceof Error ? reason.message : "Could not refresh live work status");
      } finally {
        processRefreshInFlight.current = false;
      }
    };
    const timer = window.setInterval(() => void refreshProcesses(), 5_000);
    const clock = window.setInterval(() => setProcessClock(Date.now()), 1_000);
    return () => { disposed = true; window.clearInterval(timer); window.clearInterval(clock); };
  }, [acceptProcesses, canViewProcesses, section]);

  const closeAddUser = () => {
    if (creatingUser) return;
    setShowAddUser(false);
    setUserName("");
    setUserPassword("");
    setUserIsAdmin(false);
    setUserAdminPermissions(emptyAdminPermissions());
    setUserQuotaGb(DEFAULT_QUOTA_GB.toString());
    setUserQuotaUnlimited(false);
  };
  const closeCreateLibrary = () => {
    if (creatingLibrary) return;
    setShowCreateLibrary(false);
    setLibraryName("");
    setLibraryContentType("mixed");
  };
  const createLibrary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = libraryName.trim();
    if (!name || creatingLibrary) return;
    setCreatingLibrary(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/libraries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, content_type: libraryContentType }) });
      if (response.status === 409) throw new Error("A folder or library with that name already exists");
      if (response.status === 403) throw new Error("You do not have permission to create libraries");
      if (!response.ok) throw new Error(`Could not create library (server returned ${response.status})`);
      const config: LibraryConfig = { content_type: libraryContentType, members: [{ name: currentUser?.name ?? "", can_view: true, can_delete: true, can_move: true, can_create_folders: true, can_upload: true, can_download: true, can_rename: true }], title_folders: [], trickplay_enabled: false, folder_structure_static: false };
      librarySnapshotsRef.current = { ...librarySnapshotsRef.current, [name]: libraryFingerprint(config) };
      setLibraries((current) => ({ ...current, [name]: config }));
      setShowCreateLibrary(false);
      setLibraryName("");
      setLibraryContentType("mixed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create library");
    } finally {
      setCreatingLibrary(false);
    }
  };
  const browseLocation = async (path?: string) => {
    if (browsingFolders) return;
    setBrowsingFolders(true);
    setError("");
    try {
      const query = path?.trim() ? `?path=${encodeURIComponent(path.trim())}` : "";
      const response = await authFetch(`${API_BASE}/api/admin/library-locations/browse${query}`);
      if (!response.ok) throw new Error((await response.text()) || "Could not browse that server folder");
      const result = await response.json() as FolderBrowserResponse;
      setFolderBrowser(result);
      if (result.current_path) {
        setLocationPath(result.current_path);
        setLocationName((current) => current || result.current_path!.split(/[\\/]/).filter(Boolean).at(-1) || "Library");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not browse server folders");
    } finally {
      setBrowsingFolders(false);
    }
  };
  const pickLocalFolder = async () => {
    if (pickingFolder || browsingFolders) return;
    setPickingFolder(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/library-locations/pick-folder`, { method: "POST" });
      if (!response.ok) throw new Error((await response.text()) || "Could not open the folder picker");
      const result = await response.json() as { path: string | null };
      if (!result.path) return;
      setLocationPath(result.path);
      setLocationName((current) => current || result.path!.split(/[\\/]/).filter(Boolean).at(-1) || "Library");
      await browseLocation(result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open the folder picker");
    } finally {
      setPickingFolder(false);
    }
  };
  const openAddLocation = () => {
    setShowAddLocation(true);
    setLocationName("");
    setLocationPath("");
    setLocationContentType("mixed");
    setLocationMode("library");
    setDestinationLibrary("");
    setDestinationFolder("");
    setFolderBrowser(null);
    void browseLocation();
  };
  const closeAddLocation = () => {
    if (creatingLocation) return;
    setShowAddLocation(false);
    setFolderBrowser(null);
  };
  useBackLayer(showCreateLibrary, closeCreateLibrary);
  useBackLayer(showAddLocation, closeAddLocation);
  useBackLayer(showAddUser, closeAddUser);
  useBackLayer(Boolean(editingUser), () => { if (!savingUser && !deletingUser) setEditingUser(null); });
  useBackLayer(Boolean(sessionUser), () => { if (!revokingSession) setSessionUser(null); });
  const createLibraryLocation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!locationName.trim() || !locationPath.trim() || creatingLocation) return;
    const name = locationName.trim();
    const destinationFolderPath = destinationFolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const shortcutPath = destinationFolderPath ? `${destinationFolderPath}/${name}` : name;
    const nameAlreadyAttached = locationMode === "library"
      ? Object.keys(libraries).some((library) => library.toLowerCase() === name.toLowerCase())
      : libraryLocations?.locations.some((location) => location.parent_library?.toLowerCase() === destinationLibrary.toLowerCase() && location.folder_path?.toLowerCase() === shortcutPath.toLowerCase());
    if (nameAlreadyAttached) {
      setError(locationMode === "library" ? "A library with that name is already attached to TMS." : "A folder shortcut with that name is already attached at this library location.");
      return;
    }
    setCreatingLocation(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/library-locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          path: locationPath.trim(),
          content_type: locationContentType,
          ...(locationMode === "folder" ? { destination_library: destinationLibrary, destination_folder: destinationFolder } : {}),
        }),
      });
      if (!response.ok) throw new Error((await response.text()) || `Could not add library location (server returned ${response.status})`);
      const location = await response.json() as LibraryLocation;
      if (!location.parent_library) {
        const config: LibraryConfig = { content_type: locationContentType, members: [{ name: currentUser?.name ?? "", can_view: true, can_delete: true, can_move: true, can_create_folders: true, can_upload: true, can_download: true, can_rename: true }], title_folders: [], trickplay_enabled: false, folder_structure_static: false };
        librarySnapshotsRef.current = { ...librarySnapshotsRef.current, [location.name]: libraryFingerprint(config) };
        setLibraries((current) => ({ ...current, [location.name]: config }));
      }
      setLibraryLocations((current) => current ? { ...current, locations: [...current.locations, location] } : current);
      setShowAddLocation(false);
      setFolderBrowser(null);
      // Re-read the centralized location list after the optimistic update so
      // externally mounted libraries and in-library shortcuts stay visible
      // after any server-side normalization.
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add library location");
    } finally {
      setCreatingLocation(false);
    }
  };
  const detachLibraryLocation = async (location: LibraryLocation) => {
    if (!location.external || detachingLocation) return;
    const locationLabel = location.parent_library ? `${location.parent_library} / ${location.folder_path}` : location.name;
    if (!await appConfirm({ title: "Remove library location?", description: `Remove ${locationLabel} from TMS?\n\nThe folder and its files will stay at:\n${location.path}`, action: "Remove location", danger: true })) return;
    const key = `${location.parent_library ?? "library"}:${location.folder_path ?? location.name}`;
    setDetachingLocation(key);
    setError("");
    try {
      const response = location.parent_library
        ? await authFetch(`${API_BASE}/api/admin/library-locations/folder`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ library: location.parent_library, folder_path: location.folder_path }) })
        : await authFetch(`${API_BASE}/api/libraries/${encodeURIComponent(location.name)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Could not detach ${locationLabel} (server returned ${response.status})`);
      if (!location.parent_library) setLibraries((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== location.name)));
      setLibraryLocations((current) => current ? { ...current, locations: current.locations.filter((item) => item.parent_library !== location.parent_library || item.folder_path !== location.folder_path || (!location.parent_library && item.name !== location.name)) } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not detach library location");
    } finally {
      setDetachingLocation("");
    }
  };
  const addUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = userName.trim();
    if (!name || creatingUser) return;
    setCreatingUser(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          password: userPassword,
          storage_quota_bytes: userIsAdmin || userQuotaUnlimited ? null : quotaBytes(userQuotaGb),
          ...(currentUser?.is_admin ? { is_admin: userIsAdmin, admin_permissions: userIsAdmin ? emptyAdminPermissions() : userAdminPermissions } : {}),
        }),
      });
      if (response.status === 409) throw new Error("A user with that name already exists");
      if (!response.ok) throw new Error(`Could not create user (server returned ${response.status})`);
      const createdUser = await response.json() as AdminUser;
      setUsers((current) => [...current, createdUser]);
      setShowAddUser(false);
      setUserName("");
      setUserPassword("");
      setUserIsAdmin(false);
      setUserAdminPermissions(emptyAdminPermissions());
      setUserQuotaGb(DEFAULT_QUOTA_GB.toString());
      setUserQuotaUnlimited(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create user");
    } finally {
      setCreatingUser(false);
    }
  };
  const updateLibraryDraft = (path: string, update: (library: LibraryConfig) => LibraryConfig) => {
    setLibraries((current) => ({ ...current, [path]: update(current[path]) }));
    setSavedLibrary("");
  };
  const toggleLibraryMember = (path: string, name: string, allowed: boolean) => updateLibraryDraft(path, (library) => ({
    ...library,
    members: allowed
      ? library.members.some((member) => member.name.toLowerCase() === name.toLowerCase()) ? library.members : [...library.members, { name, can_view: true, can_delete: false, can_move: false, can_create_folders: false, can_upload: false, can_download: false, can_rename: false }]
      : library.members.filter((member) => member.name.toLowerCase() !== name.toLowerCase()),
  }));
  const setLibraryPermission = (path: string, name: string, permission: keyof Omit<LibraryMember, "name">, enabled: boolean) => updateLibraryDraft(path, (library) => ({
    ...library,
    members: library.members.map((member) => member.name.toLowerCase() === name.toLowerCase() ? {
      ...member,
      [permission]: enabled,
      ...(permission !== "can_view" && enabled ? { can_view: true } : {}),
      ...(permission === "can_view" && !enabled ? { can_delete: false, can_move: false, can_create_folders: false, can_upload: false, can_download: false, can_rename: false } : {}),
    } : member),
  }));
  const applyLibraryPreset = (path: string, name: string, preset: "viewer" | "user" | "editor" | "manager") => updateLibraryDraft(path, (library) => {
    const permissions = preset === "viewer"
      ? { can_view: true, can_delete: false, can_move: false, can_create_folders: false, can_upload: false, can_download: false, can_rename: false }
      : preset === "user"
        ? { can_view: true, can_delete: false, can_move: false, can_create_folders: false, can_upload: true, can_download: true, can_rename: false }
        : preset === "editor"
        ? { can_view: true, can_delete: false, can_move: true, can_create_folders: true, can_upload: true, can_download: true, can_rename: true }
        : { can_view: true, can_delete: true, can_move: true, can_create_folders: true, can_upload: true, can_download: true, can_rename: true };
    const nextMember = { name, ...permissions };
    return { ...library, members: library.members.some((member) => member.name.toLowerCase() === name.toLowerCase()) ? library.members.map((member) => member.name.toLowerCase() === name.toLowerCase() ? nextMember : member) : [...library.members, nextMember] };
  });
  const saveLibrary = useCallback(async (path: string, library: LibraryConfig) => {
    if (savingLibrariesRef.current.has(path)) return;
    savingLibrariesRef.current.add(path);
    setSavingLibrary(path);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/libraries`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content_type: library.content_type, members: library.members, trickplay_enabled: library.trickplay_enabled, folder_structure_static: library.folder_structure_static }) });
      if (!response.ok) throw new Error(`Could not save ${path} (server returned ${response.status})`);
      setSavedLibrary(path);
      setTimeout(() => setSavedLibrary((current) => current === path ? "" : current), 3000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save library");
    } finally {
      savingLibrariesRef.current.delete(path);
      setSavingLibrary("");
    }
  }, []);
  const runTrickplayNow = async (path: string) => {
    if (trickplayAction) return;
    setTrickplayAction(path);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/libraries/${encodeURIComponent(path)}/trickplay`, { method: "POST" });
      if (!response.ok) throw new Error(`Could not queue timeline previews for ${path} (server returned ${response.status})`);
      setSavedLibrary(path);
      setTimeout(() => setSavedLibrary((current) => current === path ? "" : current), 4000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not queue timeline previews");
    } finally {
      setTrickplayAction("");
    }
  };
  useEffect(() => {
    const nextSnapshots = Object.fromEntries(Object.entries(libraries).map(([path, library]) => [path, libraryFingerprint(library)]));
    const changed = Object.entries(libraries).filter(([path, library]) => librarySnapshotsRef.current[path] !== libraryFingerprint(library));
    librarySnapshotsRef.current = nextSnapshots;
    changed.forEach(([path, library]) => {
      const pending = pendingLibrarySavesRef.current.get(path);
      if (pending) clearTimeout(pending);
      pendingLibrarySavesRef.current.set(path, setTimeout(() => {
        pendingLibrarySavesRef.current.delete(path);
        void saveLibrary(path, library);
      }, 450));
    });
  }, [libraries, saveLibrary]);
  useEffect(() => {
    const pendingSaves = pendingLibrarySavesRef.current;
    return () => {
      pendingSaves.forEach((timeout) => clearTimeout(timeout));
      pendingSaves.clear();
    };
  }, []);
  const openUserEditor = (user: AdminUser) => {
    setEditingUser(user);
    setEditUserIsAdmin(user.is_admin);
    setEditAdminPermissions(user.is_admin ? emptyAdminPermissions() : (user.admin_permissions ?? emptyAdminPermissions()));
    setEditQuotaUnlimited(user.storage_quota_bytes === null);
    setEditQuotaGb(user.storage_quota_bytes === null ? DEFAULT_QUOTA_GB.toString() : (user.storage_quota_bytes / 1024 ** 3).toString());
    setChangePassword(false);
    setEditPassword("");
  };
  const saveUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingUser || savingUser) return;
    setSavingUser(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/users/${editingUser.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage_quota_bytes: editUserIsAdmin || editQuotaUnlimited ? null : quotaBytes(editQuotaGb),
          ...(currentUser?.is_admin ? { is_admin: editUserIsAdmin, admin_permissions: editUserIsAdmin ? emptyAdminPermissions() : editAdminPermissions } : {}),
          ...(changePassword ? { password: editPassword } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Could not update ${editingUser.name} (server returned ${response.status})`);
      const updated = await response.json() as AdminUser;
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      setEditingUser(null);
      if (changePassword && currentUser?.id === updated.id) { clearSession(); window.location.replace("/login"); }
      else if (currentUser?.id === updated.id && currentUser.is_admin !== updated.is_admin) window.location.replace("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update user");
    } finally {
      setSavingUser(false);
    }
  };
  const deleteUser = async () => {
    if (!editingUser || deletingUser || editingUser.id === currentUser?.id) return;
    if (!await appConfirm({ title: "Delete user?", description: `Delete ${editingUser.name}? Their sessions and library assignments will be removed. Their media will stay on the server.`, action: "Delete user", danger: true })) return;
    setDeletingUser(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/users/${editingUser.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(response.status === 400 ? "The current or last full administrator cannot be deleted." : `Could not delete ${editingUser.name} (server returned ${response.status})`);
      setUsers((current) => current.filter((user) => user.id !== editingUser.id));
      setLibraries((current) => Object.fromEntries(Object.entries(current).map(([path, library]) => [path, { ...library, members: library.members.filter((member) => member.name.toLowerCase() !== editingUser.name.toLowerCase()) }])));
      setEditingUser(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete user");
    } finally {
      setDeletingUser(false);
    }
  };
  const canManageSessionsFor = (user: AdminUser) => user.is_admin ? canLogOutAdmins : (canLogOutOtherUsers || canLogOutAdmins);
  const openUserSessions = async (user: AdminUser) => {
    setSessionUser(user);
    setUserSessions([]);
    setLoadingSessions(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/admin/users/${user.id}/sessions`);
      if (!response.ok) throw new Error(`Could not load ${user.name}'s devices`);
      setUserSessions(await response.json() as DeviceSession[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load devices");
      setSessionUser(null);
    } finally { setLoadingSessions(false); }
  };
  const revokeUserSession = async (session: DeviceSession) => {
    if (!sessionUser || revokingSession) return;
    if (!await appConfirm({ title: "Log out device?", description: `Log ${sessionUser.name} out of ${session.device}?`, action: "Log out", danger: true })) return;
    setRevokingSession(session.token);
    try {
      const response = await authFetch(`${API_BASE}/api/admin/users/${sessionUser.id}/sessions/${encodeURIComponent(session.token)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not log out that device");
      setUserSessions((current) => current.filter((item) => item.token !== session.token));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not log out device"); }
    finally { setRevokingSession(""); }
  };
  const setPermission = (
    setter: Dispatch<SetStateAction<AdminPermissions>>,
    key: keyof AdminPermissions,
    enabled: boolean,
  ) => setter((current) => {
    if (key === "access_admin_panel" && !enabled) return emptyAdminPermissions();
    const next = { ...current, [key]: enabled };
    if (enabled) next.access_admin_panel = true;
    if (enabled && (key === "create_users" || key === "edit_users" || key === "delete_users")) next.view_users = true;
    return next;
  });

  const saveThrottleSettings = useCallback(async (snapshot: string) => {
    setThrottleSaveState("saving");
    setError("");
    try {
      const payload = JSON.parse(snapshot) as AdminDownloadStatus["throttle"];
      const response = await authFetch(`${API_BASE}/api/admin/downloads/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleep_interval_seconds: Math.max(0, Number(payload.sleep_interval_seconds) || 0),
          max_sleep_interval_seconds: Math.max(0, Number(payload.max_sleep_interval_seconds) || 0),
          limit_rate: String(payload.limit_rate ?? "").trim(),
        }),
      });
      const result = await response.json() as AdminDownloadStatus & { message?: string };
      if (!response.ok) throw new Error(result.message || "Could not save download pacing settings.");
      const nextSnapshot = JSON.stringify(result.throttle);
      throttleSnapshotRef.current = nextSnapshot;
      setDownloadStatus(result);
      setSleepInterval(String(result.throttle.sleep_interval_seconds ?? 0));
      setMaxSleepInterval(String(result.throttle.max_sleep_interval_seconds ?? 0));
      setLimitRate(result.throttle.limit_rate ?? "");
      setThrottleSaveState("saved");
    } catch (reason) {
      setThrottleSaveState("");
      setError(reason instanceof Error ? reason.message : "Could not save download pacing settings");
    }
  }, []);

  useEffect(() => {
    if (section !== "downloads" || !downloadStatus) return;
    const snapshot = JSON.stringify({
      sleep_interval_seconds: Math.max(0, Number(sleepInterval) || 0),
      max_sleep_interval_seconds: Math.max(0, Number(maxSleepInterval) || 0),
      limit_rate: limitRate.trim(),
    });
    if (snapshot === throttleSnapshotRef.current) return;
    if (throttleSaveTimerRef.current) window.clearTimeout(throttleSaveTimerRef.current);
    throttleSaveTimerRef.current = window.setTimeout(() => {
      void saveThrottleSettings(snapshot);
    }, 700) as unknown as number;
    return () => {
      if (throttleSaveTimerRef.current) window.clearTimeout(throttleSaveTimerRef.current);
    };
  }, [downloadStatus, limitRate, maxSleepInterval, saveThrottleSettings, section, sleepInterval]);

  const canManageUser = (user: AdminUser) =>
    (canEditUsers || canDeleteUsers) && (Boolean(currentUser?.is_admin) || !user.is_admin);
  const accountType = (user: AdminUser) =>
    user.is_admin ? "Full administrator" : user.admin_permissions?.access_admin_panel ? "Limited admin" : "Library access";
  const permissionEditor = (
    permissions: AdminPermissions,
    setter: Dispatch<SetStateAction<AdminPermissions>>,
  ) => <section className="admin-account-permissions">
    <header>
      <div><b>Granular administration</b></div>
      <div className="admin-permission-presets">
        <button type="button" onClick={() => setter(accountPreset("users"))}>User manager</button>
        <button type="button" onClick={() => setter(accountPreset("auditor"))}>Metrics viewer</button>
        <button type="button" onClick={() => setter(accountPreset("libraries"))}>Library manager</button>
        <button type="button" onClick={() => setter(emptyAdminPermissions())}>Clear</button>
      </div>
    </header>
    <details className="admin-permission-details">
      <summary>Individual permissions</summary>
      <div className="admin-account-permission-grid">
      {accountPermissions.map((permission) => <label key={permission.key} className={`admin-checkbox-field ${permission.key === "access_admin_panel" ? "admin-panel-master-permission" : ""}`}>
        <input type="checkbox" checked={permissions[permission.key]} onChange={(event) => setPermission(setter, permission.key, event.target.checked)} />
        <span><b>{permission.label}</b><small>{permission.description}</small></span>
      </label>)}
      </div>
    </details>
  </section>;
  const metricDeviceClasses = section === "metrics" ? [...new Set(metricsLogs.lines.map((line) => performanceDetails(line)?.device_class).filter((value): value is string => typeof value === "string"))].sort() : [];
  const headerActions = <>
            {section === "processes" && <button type="button" className="admin-primary-action" disabled={refreshingJobs} onClick={() => void refreshAdminJobs()}>
              {refreshingJobs ? "Refreshing…" : "Refresh work"}
            </button>}
            {section === "metrics" && <select className="admin-metrics-device" aria-label="Device" value={metricDeviceFilter} onChange={(event) => setMetricDeviceFilter(event.target.value)}><option value="all">All devices</option>{metricDeviceClasses.map((device) => <option value={device} key={device}>{device[0].toUpperCase() + device.slice(1)}</option>)}</select>}
            {section === "users" && canCreateUsers && <button className="admin-primary-action" type="button" onClick={() => setShowAddUser(true)}>＋ Add user</button>}
            {section === "metrics" && currentUser?.is_admin && <button type="button" className="admin-clear-metrics-action" disabled={loading || clearingMetrics} onClick={() => void clearMetrics()}>{clearingMetrics ? "Wiping…" : "Wipe all metrics"}</button>}
            {section === "locations" && canManageLibraries && <button className="admin-primary-action" type="button" onClick={openAddLocation}>Add folder</button>}
            {section === "libraries" && <LibrariesLayoutPicker layout={librariesLayout} onChange={setLibrariesLayout} />}
            {section === "libraries" && canManageLibraries && <button className="admin-primary-action" type="button" onClick={() => setShowCreateLibrary(true)}>Create library</button>}
            {section !== "processes" && section !== "trash" && <button type="button" aria-label={loading ? "Refreshing" : "Refresh"} onClick={() => void refresh()} disabled={loading || clearingMetrics}><MenuIcon name="restore" />{loading ? "Refreshing" : "Refresh"}</button>}
  </>;
  const Root = embedded ? "div" : "main";
  return <Root className={`admin-shell${embedded ? " admin-embedded" : ""}`}>
    {!embedded && <MobileNavigation active="admin" admin={true} />}
    {!embedded && <header className="admin-app-header">
      <a className="admin-brand" href="/?section=library" aria-label="TMS Libraries"><span className="logo-badge" aria-hidden="true" /><strong>TMS</strong></a><b className="admin-app-title">Admin</b>
      <nav className="admin-app-nav" aria-label="Main navigation">
        {mainNavigation.map((item) => <a key={item.id} href={`/?section=${item.id}`}><i aria-hidden="true">{item.icon}</i>{item.label}</a>)}
        <a className="active" href={`/admin?section=${section}`} aria-current="page" ref={activeAppNavRef}><i aria-hidden="true">▦</i>Admin{currentUser?.is_admin && pendingAdminNotifications > 0 && <em>{pendingAdminNotifications}</em>}</a>
      </nav>
      <div className="admin-account-menu" ref={accountMenuRef}>
        <button type="button" className="admin-account-avatar" aria-label="Account menu" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((open) => !open)}>{currentUser?.name.slice(0, 2).toUpperCase() ?? "?"}</button>
        {accountMenuOpen && <div className="admin-account-popover">
          <div><b>{currentUser?.name ?? "User"}</b><small>{currentUser?.is_admin ? "Full administrator" : "Limited administrator"}</small></div>
          <a href="/?section=library">Libraries</a>
          <a href="/?section=library&settings=1">Settings</a>
          <button type="button" onClick={() => void logOut().then(() => window.location.replace("/login"))}>Log out</button>
        </div>}
      </div>
    </header>}
    <aside className="admin-sidebar">
      <nav aria-label="Administration sections">
        {currentUser?.is_admin && (
          <div style={{ display: "contents" }}>
            <button className={section === "notifications" ? "active" : ""} aria-current={section === "notifications" ? "page" : undefined} onClick={() => setSection("notifications")}><span aria-hidden="true">◉</span>Requests{pendingAdminNotifications > 0 && <em className="admin-nav-count">{pendingAdminNotifications}</em>}</button>
          </div>
        )}
        {availableSections.includes("overview") && (
          <div style={{ display: "contents" }}>
            <button className={section === "overview" ? "active" : ""} aria-current={section === "overview" ? "page" : undefined} onClick={() => setSection("overview")}><span aria-hidden="true">◇</span>Overview</button>
          </div>
        )}
        {(canViewUsers || canCreateUsers || canEditUsers || canDeleteUsers || canLogOutOtherUsers || canLogOutAdmins) && (
          <div style={{ display: "contents" }}>
            <button className={section === "users" ? "active" : ""} aria-current={section === "users" ? "page" : undefined} onClick={() => setSection("users")}><span aria-hidden="true">♙</span>Users</button>
          </div>
        )}
        {canViewLogs && (
          <div style={{ display: "contents" }}>
            <button className={section === "metrics" ? "active" : ""} aria-current={section === "metrics" ? "page" : undefined} onClick={() => setSection("metrics")}><span aria-hidden="true">◷</span>Metrics</button>
          </div>
        )}
        {canViewProcesses && (
          <div style={{ display: "contents" }}>
            <button className={section === "processes" ? "active" : ""} aria-current={section === "processes" ? "page" : undefined} onClick={() => setSection("processes")}><span aria-hidden="true">◉</span>Running work</button>
          </div>
        )}
        {canManageLibraries && (
          <div style={{ display: "contents" }}>
            <button className={section === "locations" ? "active" : ""} aria-current={section === "locations" ? "page" : undefined} onClick={() => setSection("locations")}><span aria-hidden="true">⌑</span>Library locations</button>
          </div>
        )}
        {canManageLibraries && (
          <div style={{ display: "contents" }}>
            <button className={section === "libraries" ? "active" : ""} aria-current={section === "libraries" ? "page" : undefined} onClick={() => setSection("libraries")}><span aria-hidden="true">▣</span>Libraries</button>
          </div>
        )}
        {canManageDownloads && (
          <div style={{ display: "contents" }}>
            <button className={section === "downloads" ? "active" : ""} aria-current={section === "downloads" ? "page" : undefined} onClick={() => setSection("downloads")}><span aria-hidden="true">↓</span>Server downloads</button>
          </div>
        )}
        {currentUser?.is_admin && <button className={section === "trash" ? "active" : ""} aria-current={section === "trash" ? "page" : undefined} onClick={() => setSection("trash")}><span aria-hidden="true">♲</span>Trash</button>}
      </nav>
      <div className="admin-page-header-actions admin-sidebar-actions">{headerActions}</div>
    </aside>

    <section className="admin-workspace">

      <div className="admin-page-header-bar">
      <label className="admin-category-selector"><span>Admin</span><select aria-label="Admin category" value={section} onChange={event => setSection(event.target.value as AdminSection)}>{availableSections.map(value => <option key={value} value={value}>{sectionCopy[value].title}</option>)}</select></label>
        <header className="admin-page-header">
          <div className="admin-page-header-actions">{headerActions}</div>
        </header>
      </div>
      {error && <div className="admin-page-error">{error}</div>}



      {section === "trash" && currentUser?.is_admin && <AdminTrash />}

      {section === "notifications" && currentUser?.is_admin && <div className="admin-requests-columns">
        <section className="discover-panel">
          <RequestsPanel canManage refreshKey={discoverRequestRefresh} title="Discover requests" onCountChange={setPendingDiscoverRequests} />
        </section>
        <section className="admin-requests-deletions">
        <h2>Deletion requests</h2>
        {loading ? <p className="admin-requests-empty">Loading requests…</p> : deleteRequests.length ? <div className="admin-delete-requests">
          {deleteRequests.map((entry) => <div className="admin-delete-request" key={entry.id}>
            <div><b>{entry.path.split("/").pop()}</b><small>{entry.path}</small><span>Requested by {entry.requested_by_name} · {new Date(entry.requested_at * 1000).toLocaleString()}</span></div>
            <div className="admin-delete-request-actions">
              <button type="button" disabled={Boolean(resolvingDeleteRequest)} onClick={() => void resolveDeleteRequest(entry, "dismiss")}>Dismiss</button>
              <button type="button" className="admin-primary-action" disabled={Boolean(resolvingDeleteRequest)} onClick={() => void resolveDeleteRequest(entry, "trash")}>{resolvingDeleteRequest === entry.id ? "Working…" : "Move to Trash"}</button>
            </div>
          </div>)}
        </div> : <p className="admin-requests-empty">New deletion requests will appear here.</p>}
        </section>
      </div>}

      {section === "overview" && <article className="admin-surface admin-section-surface">
        <header><div><p>LIMITED ADMIN</p><h2>No tools assigned</h2><span>A full administrator can grant user, metrics, library, or server-download permissions from the Users section.</span></div><a href="/" onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}><button className="admin-primary-action" onClick={() => window.location.assign("/")}>Back to libraries</button></a></header>
      </article>}

      {section === "users" && <article className="admin-surface admin-users-surface admin-section-surface">
        <div className="admin-user-table-head"><span>User</span><span>Access</span><span>Password</span><span>Created</span><span>Last active</span><span /></div>
        {loading ? <div className="admin-panel-empty"><span className="admin-loader">↻</span><b>Loading users</b></div> : users.length ? <div className="admin-user-table">{users.map((user) => <div className="admin-user-row" key={user.id}><div className="admin-user-identity"><span>{user.name.slice(0, 2).toUpperCase()}</span><div><b>{user.name}</b><small>{formatBytes(user.used_bytes)} used · {formatBytes(user.storage_quota_bytes)}</small></div></div><span className={`admin-account-type ${user.is_admin ? "admin" : user.admin_permissions?.access_admin_panel ? "limited" : ""}`}>{accountType(user)}</span><span className={`admin-password-state ${user.password_set ? "set" : "open"}`}><i />{user.password_set ? "Protected" : "No password"}</span><time>{formatCreatedDate(user.created_at)}</time><time>{user.last_active_at ? formatCreatedDate(user.last_active_at) : "Never"}</time><span className="admin-row-actions">{canManageSessionsFor(user) && <button className="admin-row-action" onClick={() => void openUserSessions(user)}>Devices</button>}{canManageUser(user) && <button className="admin-row-action" onClick={() => openUserEditor(user)}>Manage</button>}</span></div>)}</div> : <div className="admin-panel-empty"><span>♙</span><b>No users yet</b>{canCreateUsers && <button onClick={() => setShowAddUser(true)}>Add your first user</button>}</div>}
      </article>}

                  {section === "metrics" && (
        <article className="admin-surface admin-section-surface admin-metrics-surface">
          {metricsClearMessage && <p className="admin-metrics-clear-message" role="status">{metricsClearMessage}</p>}
          {loading ? (
            <div className="admin-panel-empty"><span className="admin-loader">↻</span><b>Loading metrics</b></div>
          ) : (
            (() => {
              let totalCacheHit = 0;
              let totalCount = 0;
              let sumCacheTime = 0;
              let sumServerLoadTime = 0;

              const cacheTimes: number[] = [];
              const apiTimes: number[] = [];
              const videoTimes: number[] = [];
              const imageTimes: number[] = [];
              const totalTimes: number[] = [];
              const mediaActions: { phase: string; durationMs: number; outcome: "success" | "error" }[] = [];
              const timeSeriesData: { time: number; cache?: number; server?: number; video?: number; image?: number; total?: number }[] = [];

              metricsLogs.lines.forEach(line => {
                const details = performanceDetails(line);
                if (details && (metricDeviceFilter === "all" || details.device_class === metricDeviceFilter)) {
                    const phase = logValue(line, "phase");
                    const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/);
                    const time = timeMatch ? new Date(timeMatch[1]).getTime() : 0;
                    if (["media_delete", "media_move", "media_rename", "trash_empty"].includes(phase) && typeof details.outcome === "string") {
                      const duration = Number(logValue(line, "duration_ms"));
                      if (Number.isFinite(duration)) mediaActions.push({ phase, durationMs: duration, outcome: details.outcome === "error" ? "error" : "success" });
                    }
                    
                    if (phase === "library_load_complete") {
                      totalCount++;
                      if (details.cache_hit) totalCacheHit++;
                      const cacheVal = typeof details.cache_read_ms === "number" ? details.cache_read_ms : undefined;
                      const serverVal = typeof details.api_wait_ms === "number" ? details.api_wait_ms : undefined;
                      const imageVal = typeof details.image_load_ms === "number" ? details.image_load_ms : undefined;
                      const totalVal = typeof details.total_wait_ms === "number" ? details.total_wait_ms : undefined;
                      if (cacheVal !== undefined) { sumCacheTime += cacheVal; cacheTimes.push(cacheVal); }
                      if (imageVal !== undefined) imageTimes.push(imageVal);
                      if (totalVal !== undefined) totalTimes.push(totalVal);
                      if (time > 0) {
                        timeSeriesData.push({ time, cache: cacheVal, server: serverVal, image: imageVal, total: totalVal });
                      }
                    } else if (phase === "library_server_load") {
                      const serverVal = typeof details.api_wait_ms === "number" ? details.api_wait_ms : undefined;
                      if (serverVal !== undefined) { sumServerLoadTime += serverVal; apiTimes.push(serverVal); }
                      if (time > 0 && serverVal !== undefined) timeSeriesData.push({ time, server: serverVal });
                    } else if (details.video_load_ms !== undefined) {
                      if (typeof details.video_load_ms === "number") {
                        videoTimes.push(details.video_load_ms);
                        if (time > 0) {
                          timeSeriesData.push({ time, video: details.video_load_ms });
                        }
                      }
                    } else if (details.image_load_ms !== undefined) {
                      if (typeof details.image_load_ms === "number") {
                        imageTimes.push(details.image_load_ms);
                        if (time > 0) {
                          timeSeriesData.push({ time, image: details.image_load_ms });
                        }
                      }
                    }
                }
              });

              if (totalCount === 0 && videoTimes.length === 0 && imageTimes.length === 0 && mediaActions.length === 0) {
                return (
                  <div className="admin-panel-empty">
                    <b>No metrics available yet</b>
                    <span>Library load performance logs will appear here once users navigate the app.</span>
                  </div>
                );
              }

              const hitRate = totalCount > 0 ? (totalCacheHit / totalCount) * 100 : 0;
              const avgCacheTime = cacheTimes.length > 0 ? sumCacheTime / cacheTimes.length : 0;
              const avgServerTime = apiTimes.length > 0 ? sumServerLoadTime / apiTimes.length : 0;

              cacheTimes.sort((a, b) => a - b);
              apiTimes.sort((a, b) => a - b);
              videoTimes.sort((a, b) => a - b);
              imageTimes.sort((a, b) => a - b);

              const p99Cache = cacheTimes.length > 0 ? cacheTimes[Math.floor(cacheTimes.length * 0.99)] : 0;
              const p99Api = apiTimes.length > 0 ? apiTimes[Math.floor(apiTimes.length * 0.99)] : 0;
              const p99Video = videoTimes.length > 0 ? videoTimes[Math.floor(videoTimes.length * 0.99)] : 0;
              const p99Image = imageTimes.length > 0 ? imageTimes[Math.floor(imageTimes.length * 0.99)] : 0;
              totalTimes.sort((a, b) => a - b);
              const p99Total = totalTimes.length > 0 ? totalTimes[Math.floor(totalTimes.length * 0.99)] : 0;
              const avgVideo = videoTimes.length > 0 ? videoTimes.reduce((a, b) => a + b, 0) / videoTimes.length : 0;
              const avgImage = imageTimes.length > 0 ? imageTimes.reduce((a, b) => a + b, 0) / imageTimes.length : 0;
              const avgTotal = totalTimes.length > 0 ? totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length : 0;
              const actionSummaries = ["media_delete", "media_move", "media_rename", "trash_empty"].map((phase) => {
                const events = mediaActions.filter((event) => event.phase === phase);
                const durations = events.map((event) => event.durationMs).sort((a, b) => a - b);
                const errors = events.filter((event) => event.outcome === "error").length;
                return {
                  phase,
                  count: events.length,
                  errors,
                  errorRate: events.length ? (errors / events.length) * 100 : 0,
                  average: durations.length ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length : 0,
                  p95: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0,
                };
              }).filter((summary) => summary.count > 0);

              const minTime = Math.min(...timeSeriesData.map(d => d.time));
              const maxTime = Math.max(...timeSeriesData.map(d => d.time));
              const timeRange = maxTime - minTime || 1;
              const BUCKETS = 40;
              const buckets = Array.from({ length: BUCKETS }, () => ({ sumCache: 0, countCache: 0, sumServer: 0, countServer: 0, sumVideo: 0, countVideo: 0, sumImage: 0, countImage: 0, sumTotal: 0, countTotal: 0 }));
              
              timeSeriesData.forEach(d => {
                let bucketIdx = Math.floor(((d.time - minTime) / timeRange) * BUCKETS);
                if (bucketIdx >= BUCKETS) bucketIdx = BUCKETS - 1;
                if (d.cache !== undefined) { buckets[bucketIdx].sumCache += d.cache; buckets[bucketIdx].countCache++; }
                if (d.server !== undefined) { buckets[bucketIdx].sumServer += d.server; buckets[bucketIdx].countServer++; }
                if (d.video !== undefined) { buckets[bucketIdx].sumVideo += d.video; buckets[bucketIdx].countVideo++; }
                if (d.image !== undefined) { buckets[bucketIdx].sumImage += d.image; buckets[bucketIdx].countImage++; }
                if (d.total !== undefined) { buckets[bucketIdx].sumTotal += d.total; buckets[bucketIdx].countTotal++; }
              });
              
              const points = buckets.map(b => ({
                cache: b.countCache > 0 ? b.sumCache / b.countCache : null,
                server: b.countServer > 0 ? b.sumServer / b.countServer : null,
                video: b.countVideo > 0 ? b.sumVideo / b.countVideo : null,
                image: b.countImage > 0 ? b.sumImage / b.countImage : null,
                total: b.countTotal > 0 ? b.sumTotal / b.countTotal : null
              }));

              const Sparkline = ({ dataKey, color, p99 }: { dataKey: 'cache' | 'server' | 'video' | 'image' | 'total', color: string, p99: number }) => {
                if (points.every(p => p[dataKey] === null)) return null;
                const validPoints = points.map(p => p[dataKey]).filter(v => v !== null) as number[];
                const visualMax = Math.max(0.1, Math.min(Math.max(...validPoints), p99 * 1.5));
                const width = 300;
                const height = 40;
                let path = "";
                let started = false;
                
                points.forEach((p, i) => {
                  if (p[dataKey] !== null) {
                    const val = Math.min(p[dataKey] as number, visualMax);
                    const x = (i / (BUCKETS - 1)) * width;
                    const y = height - ((val / visualMax) * height);
                    if (!started) {
                      path += `M ${x} ${y} `;
                      started = true;
                    } else {
                      path += `L ${x} ${y} `;
                    }
                  }
                });
                
                return (
                  <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.4rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', opacity: 0.5, marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      <span>Timeline</span>
                      <span style={{ color }}>Lower is better ↓</span>
                    </div>
                    <svg width="100%" height="40" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
                      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                  </div>
                );
              };

              return (
                <>
                  {actionSummaries.length > 0 && (
                    <div style={{ margin: "0.5rem 0 0" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "0.5rem" }}>
                        {actionSummaries.map((summary) => <div key={summary.phase} style={{ padding: "0.5rem 0.75rem", border: "1px solid var(--border)", borderRadius: "6px" }}>
                          <b style={{ display: "block", textTransform: "capitalize" }}>{summary.phase.replace("media_", "").replace("trash_", "trash ").replaceAll("_", " ")}</b>
                          <span style={{ display: "block", fontSize: "1.1rem", marginTop: "0.1rem" }}>{summary.average.toFixed(0)}ms</span>
                          <small>{summary.count} attempts · p95 {summary.p95.toFixed(0)}ms</small>
                          <small style={{ display: "block", color: summary.errors ? "#ef4444" : "var(--muted)", marginTop: "0.1rem" }}>{summary.errorRate.toFixed(1)}% errors ({summary.errors})</small>
                        </div>)}
                      </div>
                    </div>
                  )}
                <div className="admin-metrics-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '0.5rem', padding: '0.5rem 0 0' }}>
                  
                  <div className="admin-metric-card" style={{ background: 'var(--surface-sunken)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: '0.85rem', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.15rem' }}>Cache Read Time</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 600, lineHeight: 1.15 }}>{avgCacheTime.toFixed(1)}<span style={{ fontSize: '1rem', opacity: 0.5 }}>ms</span></div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--brand)', marginTop: '0.1rem' }}>99th Percentile: {p99Cache.toFixed(1)}ms</div>
                    <div style={{ fontSize: '0.85rem', opacity: 0.5, marginTop: '0.2rem', flex: 1 }}>Client IndexedDB read time (Network-free)</div>
                    <Sparkline dataKey="cache" color="#3b82f6" p99={p99Cache} />
                  </div>

                  <div className="admin-metric-card" style={{ background: 'var(--surface-sunken)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: '0.85rem', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.15rem' }}>Server API Load</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 600, lineHeight: 1.15 }}>{avgServerTime.toFixed(1)}<span style={{ fontSize: '1rem', opacity: 0.5 }}>ms</span></div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--brand)', marginTop: '0.1rem' }}>99th Percentile: {p99Api.toFixed(1)}ms</div>
                    <div style={{ fontSize: '0.85rem', opacity: 0.5, marginTop: '0.2rem', flex: 1 }}>Time for /api/library to respond over network</div>
                    <Sparkline dataKey="server" color="#ef4444" p99={p99Api} />
                  </div>

                  <div className="admin-metric-card" style={{ background: 'var(--surface-sunken)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: '0.85rem', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.15rem' }}>Image Load Time</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 600, lineHeight: 1.15 }}>{avgImage.toFixed(1)}<span style={{ fontSize: '1rem', opacity: 0.5 }}>ms</span></div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--brand)', marginTop: '0.1rem' }}>99th Percentile: {p99Image.toFixed(1)}ms</div>
                    <div style={{ fontSize: '0.85rem', opacity: 0.5, marginTop: '0.2rem', flex: 1 }}>Actual completed image loads, including cache, server, and invisible preloads</div>
                    <Sparkline dataKey="image" color="#8b5cf6" p99={p99Image} />
                  </div>

                  <div className="admin-metric-card" style={{ background: 'var(--surface-sunken)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: '0.85rem', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.15rem' }}>Completed Library Load</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 600, lineHeight: 1.15 }}>{avgTotal.toFixed(1)}<span style={{ fontSize: '1rem', opacity: 0.5 }}>ms</span></div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--brand)', marginTop: '0.1rem' }}>99th Percentile: {p99Total.toFixed(1)}ms</div>
                    <div style={{ fontSize: '0.85rem', opacity: 0.5, marginTop: '0.2rem', flex: 1 }}>End-to-end time until visible images are decoded and painted</div>
                    <Sparkline dataKey="total" color="#f59e0b" p99={p99Total} />
                  </div>

                  <div className="admin-metric-card" style={{ background: 'var(--surface-sunken)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: '0.85rem', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.15rem' }}>Video Start Time</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 600, lineHeight: 1.15 }}>{avgVideo.toFixed(1)}<span style={{ fontSize: '1rem', opacity: 0.5 }}>ms</span></div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--brand)', marginTop: '0.1rem' }}>99th Percentile: {p99Video.toFixed(1)}ms</div>
                    <div style={{ fontSize: '0.85rem', opacity: 0.5, marginTop: '0.2rem', flex: 1 }}>Time from clicking a video until playback begins</div>
                    <Sparkline dataKey="video" color="#10b981" p99={p99Video} />
                  </div>

                  <div className="admin-metric-card" style={{ background: 'var(--surface-sunken)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.85rem', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Global Cache Hit Rate</div>
                    
                    <div style={{ position: 'relative', width: '84px', height: '84px', marginBottom: '0.5rem' }}>
                      <svg viewBox="0 0 36 36" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
                        <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--border)" strokeWidth="3" />
                        <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--brand)" strokeWidth="3" strokeDasharray={`${hitRate}, 100`} />
                      </svg>
                      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 600 }}>
                        {hitRate.toFixed(0)}%
                      </div>
                    </div>
                    
                    <div style={{ fontSize: '0.85rem', opacity: 0.5 }}>Based on {totalCount.toLocaleString()} library loads</div>
                  </div>

                </div>
                </>
              );
            })()
          )}
          {!loading && <MetricsInsights lines={metricsLogs.lines} serverLines={metricsLogs.server_lines ?? []} errorLines={metricsLogs.error_lines ?? []} device={metricDeviceFilter} />}
        </article>
      )}

      {section === "processes" && <div className="admin-processes-workspace">
        <article className="admin-surface admin-section-surface admin-processes-surface">
          <header>
            <div>
              <p>LIVE QUEUE</p>
              <h2>{processes.filter((process) => isActiveWork(process.status)).length} active · {processes.filter((process) => !isActiveWork(process.status) && !isFinishedWork(process.status)).length} waiting / inactive · {processes.filter((process) => needsWorkAttention(process.status)).length} need attention</h2>
            </div>
            <button type="button" className="admin-finished-work-toggle" aria-pressed={showFinishedWork} onClick={() => setShowFinishedWork((shown) => !shown)}>
              <span>Finished work ({processes.filter((process) => isFinishedWork(process.status)).length})</span>
            </button>
          </header>
          {(processRefreshError || (processUpdatedAt !== null && processClock - processUpdatedAt > 15_000)) && <div className="admin-work-feedback" aria-live="polite">
            <strong role="status">{processRefreshError || "Live status is delayed"}. Displayed work may be outdated.</strong>
          </div>}
          {loading ? <div className="admin-panel-empty"><span className="admin-loader">↻</span><b>Loading running work</b></div> : processes.some((process) => showWork(process.status, showFinishedWork)) ? <div className="admin-process-list">{processes.filter((process) => showWork(process.status, showFinishedWork)).map((process) => {
            const isYtDlp = process.id.startsWith("ytdlp:");
            const isFailed = needsWorkAttention(process.status);
            const isLive = isActiveWork(process.status);
            const isScanning = process.status === "scanning library";
            const progress = process.progress;
            const detail = process.detail;
            const isComplete = isFinishedWork(process.status);
            const statusIndicator = isFailed ? "failed" : isLive ? "live" : isComplete ? "complete" : "queued";
            const progressEta = isLive && !isScanning && !process.eta && process.eta_seconds == null
              ? estimateEtaFromProgress(progress, process.started_at, processClock)
              : null;
            const etaSeconds = isScanning ? null : process.eta_seconds ?? progressEta;
            const estCompletion = isScanning ? null : formatEstimatedCompletion(etaSeconds, process.eta);
            const etaHeading = process.id.startsWith("trickplay:") && process.eta_seconds != null ? "Item ETA" : "ETA";
            const etaLabel = process.transfer || isScanning ? null : process.eta ?? (etaSeconds != null
              ? formatEta(etaSeconds)
              : isLive ? (process.kind === "FFmpeg transcode" ? "Ongoing" : "Calculating") : null);
            const avgDownloadTime = formatAvgDownloadTime(process.avg_item_seconds);
            const speedText = formatDownloadSpeed(process.speed);

            return (
              <div className={`admin-process-row${isYtDlp ? " is-ytdlp" : ""}${process.transfer ? " has-transfer" : ""}${isFailed ? " is-failed" : ""}`} key={process.id}>
                <div className="admin-process-kind"><i className={statusIndicator} />{process.kind}</div>
                <div className="admin-process-main">
                  <b className="admin-process-title" title={process.title}>{workTitle(process.title, process.kind, process.destination_path)}</b>
                  {isYtDlp ? (
                    <div className="admin-ytdlp-info">
                      {process.destination_path ? (
                        <div className="admin-ytdlp-location">
                          <span className="admin-ytdlp-label">Folder</span>
                          <a
                            href={`/?folder=${encodeURIComponent(process.destination_path)}`}
                            onClick={(e) => e.preventDefault()}
                            style={{ display: 'contents' }}
                          >
                            <button
                              type="button"
                              onClick={() => navigateApp(`/?folder=${encodeURIComponent(process.destination_path!)}`)}
                              className="admin-ytdlp-folder-link"
                            >
                              {process.destination_path}
                            </button>
                          </a>
                        </div>
                      ) : null}
                      {process.current_item ? (
                        <div className="admin-ytdlp-current">
                          <span className="admin-ytdlp-label">Current</span>
                          <span className="admin-ytdlp-current-title">{process.current_item}</span>
                        </div>
                      ) : null}
                      <div className="admin-ytdlp-stats">
                        {etaLabel ? (
                          <span className="admin-ytdlp-stat">
                            <b>{etaHeading}</b> {etaLabel}
                          </span>
                        ) : null}
                        {estCompletion ? (
                          <span className="admin-ytdlp-stat">
                            <b>Est. complete</b> {estCompletion}
                          </span>
                        ) : null}
                        {avgDownloadTime ? (
                          <span className="admin-ytdlp-stat">
                            <b>Avg item</b> {avgDownloadTime}
                          </span>
                        ) : null}
                        {speedText ? (
                          <span className="admin-ytdlp-stat">
                            <b>Speed</b> {speedText}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <small title={detail}>
                      {detail}
                      {etaLabel ? ` · ${etaHeading} ${etaLabel}` : ""}
                      {estCompletion ? ` · Est. ${etaHeading === "Item ETA" ? "item done" : "complete"} ${estCompletion}` : ""}
                    </small>
                  )}
                  {process.id.startsWith("magnet:") && <small>Magnet {process.id.slice("magnet:".length, "magnet:".length + 12)}</small>}
                  {process.error && <small className="yt-dlp-failure-note">{process.error}</small>}
                  {process.id.startsWith("magnet:") && !process.transfer && <small>{torrentUpdatedAt[process.id] ? `Last live torrent update: ${new Date(torrentUpdatedAt[process.id]).toLocaleTimeString()}` : "No live torrent status received in this session"}</small>}
                  {process.transfer && <div className="admin-process-transfer">
                    <span><b>↓ {formatRate(process.transfer.download_speed)}</b><small>Download</small></span>
                    <span><b>↑ {formatRate(process.transfer.upload_speed)}</b><small>Upload</small></span>
                    <span><b>{formatEta(process.transfer.eta_seconds)}</b><small>ETA</small></span>
                    <span><b>{process.transfer.seeds} / {process.transfer.peers}</b><small>Seeds / peers</small></span>
                  </div>}
                  {process.transfer && <small className="admin-process-bytes">{formatBytes(process.transfer.completed_bytes)} of {formatBytes(process.transfer.total_bytes)} · {formatBytes(process.transfer.remaining_bytes)} remaining · {process.transfer.state}</small>}
                </div>
                <div className="admin-process-owner"><span>{process.user_name ? process.user_name.slice(0, 2).toUpperCase() : "SV"}</span><small>{process.user_name ?? "Server"}</small></div>
                <div className="admin-process-state">
                  <b>{process.paused_until && process.paused_until * 1000 > processClock ? `Paused until ${new Date(process.paused_until * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : process.status}{progress !== null ? ` · ${Math.round(progress * 100)}%` : ""}</b>
                  {isLive && process.started_at ? <small>Started {new Date(process.started_at * 1000).toLocaleString()}</small> : null}
                  {process.pid !== null && <strong className="admin-process-pid">PID {process.pid}</strong>}
                  {progress !== null && <progress max="1" value={progress} />}
                  {process.actions.length > 0 && <span className="admin-row-actions">
                    {process.actions.map((action) => {
                      const isBusy = processAction === `${process.id}:${action}`;
                      let actionLabel = action[0].toUpperCase() + action.slice(1);
                      let busyLabel = `${actionLabel}ing…`;
                      if (action === "max") { actionLabel = "Max speed"; busyLabel = "Setting max speed…"; }
                      else if (action === "low") { actionLabel = "Use low priority"; busyLabel = "Lowering priority…"; }
                      else if (action === "cancel") { if (process.status === "cancelling") actionLabel = "Retry cleanup"; busyLabel = "Cancelling…"; }
                      else if (action === "cap") { actionLabel = "Cap speed"; busyLabel = "Applying cap..."; }
                      else if (action === "uncap") { actionLabel = "Uncap speed"; busyLabel = "Removing cap..."; }
                      else if (action === "resume") { busyLabel = "Resuming\u2026"; }
                      else if (action === "stop") { busyLabel = "Stopping…"; }
                      else if (action === "interrupt") { busyLabel = "Stopping…"; }
                      else if (action === "retry") { if (process.id.startsWith("trickplay-finished:")) actionLabel = "Retry failed"; busyLabel = "Retrying…"; }
                      return (
                        <button
                          type="button"
                          className={`admin-row-action ${action === "cancel" || action === "kill" ? "danger" : ""}`}
                          title={action === "cap" ? "Share the 5 MiB/s cap while the PC is unlocked; full speed while locked" : action === "uncap" ? "Remove this download's speed cap" : undefined}
                          key={action}
                          disabled={Boolean(processAction)}
                          onClick={() => void controlProcess(process, action)}
                        >
                          {isBusy ? busyLabel : actionLabel}
                        </button>
                      );
                    })}
                  </span>}
                </div>
              </div>
            );
          })}</div> : <div className="admin-activity-empty"><b>{processUpdatedAt === null ? "Live work status unavailable" : "Nothing is running"}</b><span>{processUpdatedAt === null ? "Refresh to check server work. No live snapshot has arrived yet." : "Active downloads, FFmpeg transcodes, and timeline-preview generation will appear here."}</span></div>}
        </article>
      </div>}

      {section === "locations" && <div className="admin-library-list admin-location-list">
        <article className="admin-surface admin-location-card is-main-location">
          <div className="admin-location-icon">TMS</div>
          <div className="admin-location-copy">
            <p>MAIN STORAGE</p>
            <h2>
              <a href="/?section=library" onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}>
                <button type="button" onClick={() => navigateApp("/?section=library")} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                  Main TMS folder
                </button>
              </a>
            </h2>
            <code>{libraryLocations?.main_root ?? "Loading…"}</code>
            <span>New libraries created in TMS live here by default.</span>
          </div>
          <span className={`admin-location-status ${libraryLocations?.main_root_available ? "online" : "offline"}`}><i />{libraryLocations?.main_root_available ? "Available" : "Unavailable"}</span>
          {currentUser?.is_admin && <details className="admin-location-move">
            <summary>Move TMS</summary>
            <p>Move the installation and its data together from an administrator PowerShell window on the server. Choose a new, empty destination.</p>
            <code>{".\\scripts\\move-tms.ps1 -Destination 'D:\\TMS'"}</code>
            <p>This previews the move. Stop TMS, exit its tray icon and disable its scheduled tasks before running the same command with <code>-Apply</code>. The tool verifies the copy before switching locations, rolls back a failed switch, and keeps the originals as backups. External media folders stay in place.</p>
            <p>TMS stays offline during the move. An interrupted switch must be recovered with <code>-Recover</code> before starting it again. See <code>docs/relocating-tms.md</code> for the full procedure.</p>
          </details>}
        </article>
        {loading && !libraryLocations ? <article className="admin-surface admin-section-surface"><div className="admin-panel-empty"><span className="admin-loader">↻</span><b>Loading library locations</b></div></article> : libraryLocations?.locations.filter((location) => location.external).map((location) => {
          const targetFolder = location.parent_library
            ? (location.folder_path ? `${location.parent_library}/${location.folder_path}` : location.parent_library)
            : location.name;
          const targetUrl = `/?folder=${encodeURIComponent(targetFolder)}`;
          const displayName = location.parent_library ? `${location.parent_library} / ${location.folder_path}` : location.name;
          return (
            <article className="admin-surface admin-location-card" key={`${location.parent_library ?? "library"}:${location.folder_path ?? location.name}`}>
              <div className="admin-location-icon">↗</div>
              <div className="admin-location-copy">
                <p>{location.parent_library ? "LIBRARY FOLDER SHORTCUT" : "EXTERNAL LIBRARY"}</p>
                <h2>
                  <a href={targetUrl} onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}>
                    <button type="button" onClick={() => navigateApp(targetUrl)} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                      {displayName}
                    </button>
                  </a>
                </h2>
                <code>{location.path}</code>
                <span>Attached without moving the source folder.</span>
              </div>
              <div className="admin-location-actions">
                <span className={`admin-location-status ${location.available ? "online" : "offline"}`}><i />{location.available ? "Available" : "Offline"}</span>
                <button type="button" className="admin-location-remove" disabled={detachingLocation === `${location.parent_library ?? "library"}:${location.folder_path ?? location.name}`} onClick={() => void detachLibraryLocation(location)}>{detachingLocation === `${location.parent_library ?? "library"}:${location.folder_path ?? location.name}` ? "Removing…" : "Remove"}</button>
              </div>
            </article>
          );
        })}
      </div>}

      {section === "downloads" && <div className="admin-library-list">
        <article className="admin-surface admin-library-card">
          <header><div><p>QUOTA OVERVIEW</p><h2>Per-user server storage</h2></div></header>
          <div className="admin-quota-list">{users.length ? users.map((user) => <div key={user.id}><div><b>{user.name}</b><span>{formatBytes(user.used_bytes)} used · {formatBytes(user.reserved_bytes)} reserved · {formatBytes(user.storage_quota_bytes)}</span></div><progress max={Math.max(1, user.storage_quota_bytes ?? Math.max(1, user.used_bytes + user.reserved_bytes))} value={user.used_bytes + user.reserved_bytes} /></div>) : <p role="status">{loading ? "Loading storage usage…" : "No user storage usage available."}</p>}</div>
        </article>
        <article className="admin-surface admin-library-card">
          <header><div><p>DOWNLOAD PACING</p><h2>yt-dlp throttling</h2></div>{throttleSaveState && <span className="admin-library-save-status" role="status">{throttleSaveState === "saving" ? "Saving…" : "Saved"}</span>}</header>
          <div className="admin-library-settings admin-ytdlp-throttle">
            <label><span>Sleep interval</span><input type="number" min="0" max="3600" step="1" value={sleepInterval} onChange={(event) => setSleepInterval(event.target.value)} /><small>Seconds to wait between playlist items. 0 disables.</small></label>
            <label><span>Max sleep</span><input type="number" min="0" max="3600" step="1" value={maxSleepInterval} onChange={(event) => setMaxSleepInterval(event.target.value)} /><small>Random extra delay up to this many seconds.</small></label>
            <label><span>Rate limit</span><input type="text" value={limitRate} onChange={(event) => setLimitRate(event.target.value)} placeholder="2M" /><small>Optional cap such as 500K or 2M. Leave blank for no limit.</small></label>
          </div>
        </article>
        <article className="admin-surface admin-library-card admin-cookies-card">
          <header>
            <div>
              <p>AUTHENTICATION & ACCESS</p>
              <h2>YouTube & Media Cookies</h2>
            </div>
            <div className="admin-cookie-header-actions">
              <button
                type="button"
                className="admin-primary-action"
                disabled={testingCookies}
                onClick={() => void testCookies()}
              >
                {testingCookies ? "Testing with YouTube…" : "↻ Test Cookies"}
              </button>
            </div>
          </header>

          <div className="admin-cookie-body">
            <div className="admin-cookie-status-bar">
              <div className={`cookie-status-item ${downloadStatus?.cookies?.exists ? "is-ok" : "is-missing"}`}>
                <span className="cookie-status-label">Status</span>
                <strong>{downloadStatus?.cookies?.exists ? "Cookies Installed" : "No Cookies File"}</strong>
                {downloadStatus?.cookies?.exists && (
                  <small>{formatBytes(downloadStatus.cookies.size_bytes)} · {downloadStatus.cookies.line_count} entries</small>
                )}
              </div>

              <div className={`cookie-status-item ${downloadStatus?.cookies?.has_youtube_auth ? "is-ok" : "is-warn"}`}>
                <span className="cookie-status-label">YouTube Auth</span>
                <strong>{downloadStatus?.cookies?.has_youtube_auth ? "✓ Credentials Active" : "⚠ No YouTube Credentials"}</strong>
                <small>{downloadStatus?.cookies?.has_youtube_auth ? "SID / LOGIN_INFO found" : "Log in to YouTube & export"}</small>
              </div>

              <div className="cookie-status-item">
                <span className="cookie-status-label">Last Updated</span>
                <strong>
                  {downloadStatus?.cookies?.updated_at
                    ? new Date(downloadStatus.cookies.updated_at * 1000).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "Never"}
                </strong>
                <small>{downloadStatus?.cookies?.sample_domains?.length ? `${downloadStatus.cookies.sample_domains.slice(0, 3).join(", ")}…` : "No domains"}</small>
              </div>
            </div>

            {cookieTestResult && (
              <div className={`admin-cookie-alert ${cookieTestResult.valid ? "is-success" : "is-error"}`}>
                <p>{cookieTestResult.message}</p>
              </div>
            )}

            {cookieExtractResult && (
              <div className={`admin-cookie-alert ${cookieExtractResult.success ? "is-success" : "is-error"}`}>
                <p>{cookieExtractResult.message}</p>
              </div>
            )}

            <div className="admin-cookie-controls">
              <div className="admin-cookie-extract-group">
                <label>
                  <span>Extract from server browser</span>
                  <div className="admin-cookie-extract-inputs">
                    <select
                      aria-label="Server browser for cookies"
                      value={cookieBrowser}
                      onChange={(e) => setCookieBrowser(e.target.value)}
                      disabled={extractingCookies}
                    >
                      <option value="auto">Auto-detect browser (Edge / Chrome / Firefox / Brave)</option>
                      <option value="edge">Microsoft Edge</option>
                      <option value="chrome">Google Chrome</option>
                      <option value="firefox">Mozilla Firefox</option>
                      <option value="brave">Brave Browser</option>
                      <option value="opera">Opera</option>
                      <option value="vivaldi">Vivaldi</option>
                    </select>
                    <button
                      type="button"
                      disabled={extractingCookies}
                      onClick={() => void extractCookiesFromBrowser()}
                    >
                      {extractingCookies ? "Refreshing…" : "Refresh from Browser"}
                    </button>
                  </div>
                </label>
              </div>

              <div className="admin-cookie-manual-group">
                <label className="admin-cookie-file-upload">
                  <input
                    type="file"
                    accept=".txt,text/plain"
                    onChange={handleCookieFileUpload}
                    style={{ display: "none" }}
                    id="cookie-file-input"
                  />
                  <button
                    type="button"
                    onClick={() => document.getElementById("cookie-file-input")?.click()}
                  >
                    📁 Upload cookies.txt
                  </button>
                </label>

                <button
                  type="button"
                  className="admin-cookie-toggle-btn"
                  onClick={() => setShowCookieEditor((prev) => !prev)}
                >
                  {showCookieEditor ? "Hide Paste Area" : "📋 Paste New Cookies"}
                </button>

                {downloadStatus?.cookies?.exists && (
                  <button
                    type="button"
                    className="admin-row-action danger"
                    onClick={() => void deleteCookies()}
                  >
                    Delete Cookies
                  </button>
                )}
              </div>
            </div>

            {showCookieEditor && (
              <div className="admin-cookie-editor-container">
                <label>
                  <span>Paste Netscape-format cookies (cookies.txt)</span>
                  <textarea
                    rows={7}
                    value={cookieContent}
                    onChange={(e) => setCookieContent(e.target.value)}
                    placeholder={"# Netscape HTTP Cookie File\n# Exported from browser\n.youtube.com\tTRUE\t/\tTRUE\t1787265432\tLOGIN_INFO\t..."}
                  />
                </label>
                <div className="admin-cookie-editor-actions">
                  <button
                    type="button"
                    className="admin-primary-action"
                    disabled={savingCookies || !cookieContent.trim()}
                    onClick={() => void saveCookies(cookieContent)}
                  >
                    {savingCookies ? "Saving Cookies…" : "Save Cookies"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCookieEditor(false);
                      setCookieContent("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="admin-cookie-guide-card">
              <div
                className="admin-cookie-guide-head"
                onClick={() => setShowCookieGuide((prev) => !prev)}
              >
                <b>💡 How to get YouTube cookies in 30 seconds</b>
                <span>{showCookieGuide ? "▲ Hide steps" : "▼ Show steps"}</span>
              </div>
              {showCookieGuide && (
                <ol className="admin-cookie-guide-steps">
                  <li>
                    Install the free <strong>Get cookies.txt LOCALLY</strong> extension in Chrome, Edge, or Firefox.
                  </li>
                  <li>
                    Open <strong>YouTube.com</strong> in your browser and ensure you are logged into your account.
                  </li>
                  <li>
                    Click the extension icon in your browser toolbar and click <strong>"Export"</strong> or copy the text.
                  </li>
                  <li>
                    Click <strong>"📁 Upload cookies.txt"</strong> above or click <strong>"📋 Paste New Cookies"</strong>, paste the text, and click <strong>"Save Cookies"</strong>.
                  </li>
                </ol>
              )}
            </div>
          </div>
        </article>
      </div>}

      {section === "libraries" && (loading || !Object.keys(libraries).length ? <article className="admin-surface admin-section-surface">
        {loading ? <div className="admin-panel-empty"><span className="admin-loader">↻</span><b>Loading libraries</b></div> : <div className="admin-panel-empty"><span>▣</span><b>No libraries yet</b>{canManageLibraries && <button type="button" onClick={() => setShowCreateLibrary(true)}>Create your first library</button>}</div>}
      </article> : <LibrariesOptions layout={librariesLayout} libraries={libraries} users={users} types={libraryTypes} permissions={libraryPermissions} presetOf={libraryMemberPreset} presetLabel={libraryPresetLabel} update={updateLibraryDraft} setPreset={(path, name, preset) => preset === "none" ? toggleLibraryMember(path, name, false) : applyLibraryPreset(path, name, preset)} setPermission={setLibraryPermission} runTrickplay={(path) => void runTrickplayNow(path)} trickplayAction={trickplayAction} savingLibrary={savingLibrary} savedLibrary={savedLibrary} />)}
    </section>

    {showCreateLibrary && <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreateLibrary(); }}>
      <form className="admin-user-modal" role="dialog" aria-modal="true" aria-label="Create library" onSubmit={createLibrary}>
        <div className="admin-user-modal-head"><div><p>NEW LIBRARY</p><h2>Create library</h2></div><button type="button" aria-label="Close create library" onClick={closeCreateLibrary}>×</button></div>
        <p>Add a new media library to the server.</p>
        <label><span>Name</span><input autoFocus required maxLength={80} value={libraryName} onChange={(event) => setLibraryName(event.target.value)} placeholder="e.g. Family videos" /></label>
        <label><span>Library type</span><select value={libraryContentType} onChange={(event) => setLibraryContentType(event.target.value as LibraryContentType)}>{libraryTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
        <div className="admin-user-modal-actions"><button type="button" onClick={closeCreateLibrary}>Cancel</button><button className="primary" type="submit" disabled={!libraryName.trim() || creatingLibrary}>{creatingLibrary ? "Creating…" : "Create library"}</button></div>
      </form>
    </div>}
    {showAddLocation && <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeAddLocation(); }}>
      <form className="admin-user-modal admin-user-modal-wide admin-location-modal" role="dialog" aria-modal="true" aria-label="Add server folder" onSubmit={createLibraryLocation}>
        <div className="admin-user-modal-head"><div><p>ATTACH SERVER FOLDER</p><h2>Add folder</h2></div><button type="button" aria-label="Close add library location" onClick={closeAddLocation}>×</button></div>
        <p>Browse folders on the TMS server. This works from your phone because the picker runs on the server, not on your device.</p>
        <div className="admin-location-mode" role="radiogroup" aria-label="How to add this folder"><button type="button" role="radio" aria-checked={locationMode === "library"} className={locationMode === "library" ? "active" : ""} onClick={() => setLocationMode("library")}><b>New library</b><small>Add this folder as its own library and choose its type.</small></button><button type="button" role="radio" aria-checked={locationMode === "folder"} className={locationMode === "folder" ? "active" : ""} onClick={() => setLocationMode("folder")}><b>Inside a library</b><small>Add it as a shortcut under an existing library.</small></button></div>
        <div className="admin-location-path-row"><label><span>Folder path</span><input autoFocus required value={locationPath} onChange={(event) => setLocationPath(event.target.value)} placeholder="Choose a drive and folder below, or enter an absolute path" /></label>{isLocalHost() && <button type="button" disabled={pickingFolder || browsingFolders} onClick={() => void pickLocalFolder()}>{pickingFolder ? "Opening…" : "Pick folder"}</button>}</div>
        <section className="admin-folder-browser" aria-label="Server folder picker">
          <header><button type="button" disabled={browsingFolders || (!folderBrowser?.parent_path && folderBrowser?.current_path === null)} onClick={() => void browseLocation(folderBrowser?.parent_path ?? undefined)}>{folderBrowser?.current_path ? <><MenuIcon name="folderUp" />Up</> : "Drives"}</button><code>{folderBrowser?.current_path ?? "Available drives"}</code><button type="button" disabled={browsingFolders} onClick={() => void browseLocation()}>All drives</button></header>
          <div>{browsingFolders && !folderBrowser ? <span className="admin-folder-browser-empty">Loading folders…</span> : folderBrowser?.folders.length ? folderBrowser.folders.map((folder) => <button type="button" key={folder.path} onClick={() => void browseLocation(folder.path)}><span>▰</span><b>{folder.name}</b><small>{folder.path}</small></button>) : <span className="admin-folder-browser-empty">No folders inside this location.</span>}</div>
        </section>
        {locationMode === "library" ? <div className="admin-location-form-grid"><label><span>Library name</span><input required maxLength={80} value={locationName} onChange={(event) => setLocationName(event.target.value)} placeholder="How this appears in TMS" /></label><label><span>Library type</span><select value={locationContentType} onChange={(event) => setLocationContentType(event.target.value as LibraryContentType)}>{libraryTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label></div> : <div className="admin-location-form-grid"><label><span>Shortcut folder name</span><input required maxLength={80} value={locationName} onChange={(event) => setLocationName(event.target.value)} placeholder="How it appears inside the library" /></label><label><span>Destination library</span><select required value={destinationLibrary} onChange={(event) => setDestinationLibrary(event.target.value)}><option value="">Choose a library…</option>{Object.keys(libraries).map((library) => <option key={library} value={library}>{library}</option>)}</select></label><label className="admin-location-folder-target"><span>Inside folder <small>Optional</small></span><input value={destinationFolder} onChange={(event) => setDestinationFolder(event.target.value)} placeholder="e.g. Shows/Comedy (must already exist)" /><small>Leave blank to add it at the top of the selected library.</small></label></div>}
        <div className="admin-user-modal-actions"><button type="button" onClick={closeAddLocation}>Cancel</button><button className="primary" type="submit" disabled={!locationName.trim() || !locationPath.trim() || (locationMode === "folder" && !destinationLibrary) || creatingLocation}>{creatingLocation ? "Adding…" : locationMode === "library" ? "Add as library" : "Add folder shortcut"}</button></div>
      </form>
    </div>}
    {showAddUser && <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeAddUser(); }}>
      <form className="admin-user-modal admin-user-modal-wide" role="dialog" aria-modal="true" aria-label="Add user" onSubmit={addUser}>
        <div className="admin-user-modal-head"><div><p>NEW USER</p><h2>Add user</h2></div><button type="button" aria-label="Close add user" onClick={closeAddUser}>×</button></div>
        <p>Create a TMS user. A password is optional for now.</p>
        <label><span>Name</span><input autoFocus required maxLength={80} value={userName} onChange={(event) => setUserName(event.target.value)} placeholder="Person name" /></label>
        <label><span>Password <small>Optional</small></span><input type="password" maxLength={256} value={userPassword} onChange={(event) => setUserPassword(event.target.value)} placeholder="Leave blank for no password" autoComplete="new-password" /></label>
        <label><span>Storage quota <small>GB</small></span><input type="number" min="0" step="1" disabled={userQuotaUnlimited || userIsAdmin} value={userQuotaGb} onChange={(event) => setUserQuotaGb(event.target.value)} /></label>
        <label className="admin-checkbox-field"><input type="checkbox" checked={userQuotaUnlimited || userIsAdmin} disabled={userIsAdmin} onChange={(event) => setUserQuotaUnlimited(event.target.checked)} /><span><b>Unlimited storage</b><small>{userIsAdmin ? "Administrators always have unlimited server storage." : "Do not apply a storage ceiling to this account."}</small></span></label>
        {currentUser?.is_admin && <label className="admin-checkbox-field"><input type="checkbox" checked={userIsAdmin} onChange={(event) => { setUserIsAdmin(event.target.checked); if (event.target.checked) setUserQuotaUnlimited(true); }} /><span><b>Full administrator</b><small>Unrestricted access to all libraries, administration, and storage.</small></span></label>}
        {currentUser?.is_admin && !userIsAdmin && permissionEditor(userAdminPermissions, setUserAdminPermissions)}
        <div className="admin-user-modal-actions"><button type="button" onClick={closeAddUser}>Cancel</button><button className="primary" type="submit" disabled={!userName.trim() || creatingUser}>{creatingUser ? "Adding…" : "Add user"}</button></div>
      </form>
    </div>}
    {editingUser && <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingUser && !deletingUser) setEditingUser(null); }}><form className="admin-user-modal admin-user-modal-wide" role="dialog" aria-modal="true" aria-label={`Manage ${editingUser.name}`} onSubmit={saveUser}>
      <div className="admin-user-modal-head"><div><p>MANAGE USER</p><h2>{editingUser.name}</h2></div><button type="button" aria-label="Close manage user" onClick={() => setEditingUser(null)}>×</button></div>
      <p>Administrators always have every permission and unlimited storage. Changing a password signs that user out everywhere.</p>
      <label><span>Storage quota <small>GB · {formatBytes(editingUser.used_bytes)} currently used</small></span><input type="number" min="0" step="1" disabled={!canEditUsers || editQuotaUnlimited || editUserIsAdmin} value={editQuotaGb} onChange={(event) => setEditQuotaGb(event.target.value)} /></label>
      <label className="admin-checkbox-field"><input type="checkbox" checked={editQuotaUnlimited || editUserIsAdmin} disabled={!canEditUsers || editUserIsAdmin} onChange={(event) => setEditQuotaUnlimited(event.target.checked)} /><span><b>Unlimited storage</b><small>{editUserIsAdmin ? "Full administrators always have unlimited server storage." : "Lowering a quota below usage blocks new allocations but never deletes media."}</small></span></label>
      {currentUser?.is_admin && <label className="admin-checkbox-field"><input type="checkbox" checked={editUserIsAdmin} onChange={(event) => { setEditUserIsAdmin(event.target.checked); if (event.target.checked) setEditQuotaUnlimited(true); }} /><span><b>Full administrator</b><small>Unrestricted access to all libraries, administration, and storage.</small></span></label>}
      {currentUser?.is_admin && !editUserIsAdmin && permissionEditor(editAdminPermissions, setEditAdminPermissions)}
      {canEditUsers && <label className="admin-checkbox-field"><input type="checkbox" checked={changePassword} onChange={(event) => setChangePassword(event.target.checked)} /><span><b>Change password</b><small>Enabling this invalidates every remembered session.</small></span></label>}
      {canEditUsers && changePassword && <label><span>New password <small>Blank means no password</small></span><input type="password" value={editPassword} onChange={(event) => setEditPassword(event.target.value)} autoComplete="new-password" /></label>}
      <div className="admin-user-modal-actions">
        {canDeleteUsers && editingUser.id !== currentUser?.id && (currentUser?.is_admin || !editingUser.is_admin) && <button className="admin-delete-user" type="button" disabled={deletingUser || savingUser} onClick={() => void deleteUser()}>{deletingUser ? "Deleting…" : "Delete user"}</button>}
        <span className="admin-modal-action-spacer" />
        <button type="button" onClick={() => setEditingUser(null)}>Cancel</button>
        {canEditUsers && <button className="primary" type="submit" disabled={savingUser || deletingUser}>{savingUser ? "Saving…" : "Save user"}</button>}
      </div>
    </form></div>}
    {sessionUser && <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !revokingSession) setSessionUser(null); }}><section className="admin-user-modal admin-user-modal-wide admin-device-modal" role="dialog" aria-modal="true" aria-label={`Devices for ${sessionUser.name}`}>
      <div className="admin-user-modal-head"><div><p>REMEMBERED DEVICES</p><h2>{sessionUser.name}</h2></div><button type="button" aria-label="Close remembered devices" onClick={() => setSessionUser(null)}>×</button></div>
      <p>Removing a device ends that session immediately. {sessionUser.is_admin ? "This account is an administrator." : ""}</p>
      {loadingSessions ? <div className="admin-panel-empty"><span className="admin-loader">↻</span><b>Loading devices</b></div> : <div className="settings-session-list admin-session-list">{userSessions.length ? userSessions.map((session) => <div className="settings-session-row" key={session.token}><div className="settings-session-icon">◉</div><div><b>{session.device}</b><small>Signed in {formatCreatedDate(session.created_at)}{session.ip_address ? ` · ${session.ip_address}` : ""}</small><small className="settings-user-agent">{session.user_agent || "Device details unavailable"}</small></div><button className="danger" disabled={Boolean(revokingSession)} onClick={() => void revokeUserSession(session)}>{revokingSession === session.token ? "Logging out…" : "Log out device"}</button></div>) : <div className="admin-panel-empty"><b>No active devices</b></div>}</div>}
    </section></div>}
  </Root>;
}
