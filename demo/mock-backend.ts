// Fake TMS backend for the screenshot demo (`npm run demo`). Everything here is
// invented: no real media, accounts, or network calls. The normal dev server and
// production build never load this file.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type Entry = {
  path: string;
  name: string;
  kind: "folder" | "file";
  preview_path?: string | null;
  preview_kind?: "image" | "video" | null;
  item_count?: number | null;
  catalog_kind?: "movie" | "series" | "episode" | null;
  catalog_title_path?: string | null;
  size: number;
  created_at: number;
  duration?: number | null;
  thumbnail_aspect_ratio?: number | null;
};

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const MOVIES_TV = "Movies and Shows";
const MUSIC = "Music";
const PHOTOS = "Family Photos";

const user = {
  id: 1,
  name: "Demo",
  is_admin: true,
  password_set: true,
  admin_permissions: {
    access_admin_panel: true, view_users: true, create_users: true, edit_users: true, delete_users: true,
    view_logs: true, view_processes: true, manage_libraries: true, manage_downloads: true,
    logout_other_users: true, logout_admins: true,
  },
};

type Show = { title: string; year: number; seasons: number; episodes: number; genres: string[]; rating: string; blurb: string };
type Movie = { title: string; year: number; minutes: number; genres: string[]; rating: string; blurb: string };

const shows: Show[] = [
  { title: "Orbital Drift", year: 2023, seasons: 2, episodes: 8, genres: ["Sci-Fi", "Drama"], rating: "8.4", blurb: "A salvage crew stranded on a derelict station starts receiving messages from themselves." },
  { title: "The Quiet Harbor", year: 2021, seasons: 3, episodes: 6, genres: ["Mystery", "Crime"], rating: "7.9", blurb: "A small-town detective reopens the case that made her leave home." },
  { title: "Neon District", year: 2024, seasons: 1, episodes: 10, genres: ["Action", "Thriller"], rating: "7.6", blurb: "Couriers race across a rain-soaked megacity carrying data nobody is supposed to have." },
  { title: "Paper Kingdoms", year: 2022, seasons: 2, episodes: 12, genres: ["Animation", "Fantasy"], rating: "8.8", blurb: "Two rival apprentices fold living creatures out of enchanted paper." },
  { title: "Ironwood", year: 2020, seasons: 4, episodes: 8, genres: ["Western", "Drama"], rating: "8.1", blurb: "A frontier family fights to keep its timber mill as the railroad arrives." },
  { title: "Office Hours", year: 2019, seasons: 3, episodes: 10, genres: ["Comedy"], rating: "7.4", blurb: "The night-shift IT desk of a failing startup keeps the servers, and each other, alive." },
];

const movies: Movie[] = [
  { title: "Saltwater", year: 2023, minutes: 118, genres: ["Drama"], rating: "7.2", blurb: "A fisherman's daughter takes over the family boat for one last season." },
  { title: "The Cartographer", year: 2022, minutes: 131, genres: ["Adventure"], rating: "7.8", blurb: "A mapmaker discovers an island that moves every night." },
  { title: "Midnight Engine", year: 2024, minutes: 104, genres: ["Action"], rating: "6.9", blurb: "A getaway driver has one night to return a stolen prototype car." },
  { title: "Hollow Pines", year: 2021, minutes: 97, genres: ["Horror"], rating: "6.4", blurb: "Campers find the forest rearranging itself around them." },
  { title: "Signal Lost", year: 2024, minutes: 112, genres: ["Sci-Fi", "Thriller"], rating: "7.5", blurb: "A radio astronomer intercepts a broadcast from the near future." },
  { title: "Red Meridian", year: 2020, minutes: 126, genres: ["War", "Drama"], rating: "7.7", blurb: "Two codebreakers race to warn a convoy before it sails." },
  { title: "Velvet Static", year: 2023, minutes: 101, genres: ["Romance", "Music"], rating: "7.1", blurb: "A late-night DJ falls for the caller who requests the same song every night." },
  { title: "Northbound", year: 2022, minutes: 109, genres: ["Comedy", "Adventure"], rating: "6.8", blurb: "Three estranged siblings drive their grandmother's piano to Alaska." },
  { title: "Glass Garden", year: 2024, minutes: 115, genres: ["Mystery"], rating: "7.3", blurb: "A botanist inherits a greenhouse where nothing has died in a century." },
  { title: "Copperhead Run", year: 2019, minutes: 99, genres: ["Crime"], rating: "6.6", blurb: "A moonshiner's last delivery goes wrong in every possible way." },
];

const songs = [
  ["Aurora Lanes", "Northern Lights"], ["Static Bloom", "Paper Moons"], ["The Lowtides", "Harbor Lights"],
  ["Mira Vale", "Glass Hearts"], ["Kite Theory", "Rooftop Summer"], ["Aurora Lanes", "Afterglow"],
  ["Neon Pilots", "Midnight Drive"], ["Cedar & Smoke", "Slow River"], ["Mira Vale", "Satellites"],
  ["The Lowtides", "Driftwood"], ["Kite Theory", "Paper Planes"], ["Static Bloom", "Velvet Hour"],
  ["Neon Pilots", "Overdrive"], ["Cedar & Smoke", "Wildfire"], ["Juno Park", "Echoes"],
  ["Juno Park", "Cloud Atlas"], ["Aurora Lanes", "Silver Coast"], ["Mira Vale", "Lighthouse"],
  ["The Lowtides", "Undertow"], ["Kite Theory", "Golden Hour"], ["Neon Pilots", "City Pulse"],
  ["Static Bloom", "Sunday Static"], ["Cedar & Smoke", "Ember"], ["Juno Park", "Long Way Home"],
];

const photoAlbums = ["Beach Trip 2024", "Birthday Party", "Hiking Weekend", "Winter Cabin"];

const EPISODE_WORDS = ["Arrival", "The Signal", "Low Tide", "Old Debts", "Glass Walls", "Static", "The Long Night", "Undertow", "Crossing", "Second Light", "Fault Lines", "Homecoming"];
const pad = (value: number) => String(value).padStart(2, "0");
const hash = (value: string) => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
};
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function buildTree(): Entry[] {
  const entries: Entry[] = [];
  const folder = (path: string, extra: Partial<Entry> = {}) => entries.push({ path, name: path.split("/").at(-1)!, kind: "folder", size: 0, created_at: NOW - (hash(path) % 200) * DAY, ...extra });
  const file = (path: string, size: number, extra: Partial<Entry> = {}) => entries.push({ path, name: path.split("/").at(-1)!, kind: "file", size, created_at: NOW - (hash(path) % 200) * DAY, ...extra });

  folder(MOVIES_TV);
  shows.forEach((show) => {
    const root = `${MOVIES_TV}/${show.title}`;
    const firstEpisode = `${root}/Season 1/${show.title} S01E01.mkv`;
    folder(root, { preview_path: firstEpisode, preview_kind: "video", item_count: show.seasons, catalog_kind: "series", catalog_title_path: root });
    for (let s = 1; s <= show.seasons; s++) {
      const season = `${root}/Season ${s}`;
      folder(season, { preview_path: `${season}/${show.title} S${pad(s)}E01.mkv`, preview_kind: "video", item_count: show.episodes, catalog_kind: "episode", catalog_title_path: root });
      for (let e = 1; e <= show.episodes; e++) {
        file(`${season}/${show.title} S${pad(s)}E${pad(e)}.mkv`, 900_000_000 + (hash(`${s}${e}${show.title}`) % 600_000_000), { duration: episodeDurationFor(show, e), thumbnail_aspect_ratio: 16 / 9, catalog_kind: "episode", catalog_title_path: root });
      }
    }
  });
  movies.forEach((movie) => {
    const root = `${MOVIES_TV}/${movie.title}`;
    const video = `${root}/${movie.title} (${movie.year}).mkv`;
    folder(root, { preview_path: video, preview_kind: "video", item_count: 1, catalog_kind: "movie", catalog_title_path: root });
    file(video, 4_000_000_000 + (hash(movie.title) % 3_000_000_000), { duration: movie.minutes * 60, thumbnail_aspect_ratio: 16 / 9, catalog_kind: "movie", catalog_title_path: root });
  });

  folder(MUSIC);
  songs.forEach(([artist, title]) => file(`${MUSIC}/${artist} - ${title}.mp3`, 6_000_000 + (hash(title) % 5_000_000), { duration: 150 + (hash(artist + title) % 240) }));

  folder(PHOTOS);
  photoAlbums.forEach((album) => {
    const root = `${PHOTOS}/${album}`;
    folder(root, { preview_path: `${root}/IMG_0001.jpg`, preview_kind: "image", item_count: 12 });
    for (let i = 1; i <= 12; i++) file(`${root}/IMG_${String(i).padStart(4, "0")}.jpg`, 3_000_000 + (hash(`${album}${i}`) % 2_000_000), { thumbnail_aspect_ratio: i % 3 === 0 ? 3 / 4 : 4 / 3 });
  });
  return entries;
}

const tree = buildTree().map(entry => /\.(mkv|mp4|webm)$/i.test(entry.path) ? { ...entry, duration: 15, size: readFileSync(new URL("./synthetic-motion.webm", import.meta.url)).length } : entry);
const childrenOf = (folder: string) => tree.filter((entry) => entry.path.slice(0, entry.path.lastIndexOf("/")) === folder);
const libraryRoots = new Set([MOVIES_TV, MUSIC, PHOTOS]);
// Top-level library folders carry their child count, like the real scan.
tree.filter((entry) => libraryRoots.has(entry.path)).forEach((entry) => { entry.item_count = childrenOf(entry.path).length; });

const member = (name: string) => ({ name, can_view: true, can_delete: true, can_move: true, can_create_folders: true, can_upload: true, can_download: true, can_rename: true });
const libraries = {
  [MOVIES_TV]: { content_type: "movies_tv", members: [member("Demo"), member("Sam")], title_folders: [], trickplay_enabled: true, folder_structure_static: false },
  [MUSIC]: { content_type: "music", members: [member("Demo")], title_folders: [], trickplay_enabled: false, folder_structure_static: false },
  [PHOTOS]: { content_type: "mixed", members: [member("Demo"), member("Sam")], title_folders: [], trickplay_enabled: false, folder_structure_static: false },
};

function episodeDurationFor(show: Show, e: number) { return 2400 + (hash(`${e}${show.title}`) % 900); }
const episodePath = (show: Show, s: number, e: number) => `${MOVIES_TV}/${show.title}/Season ${s}/${show.title} S${pad(s)}E${pad(e)}.mkv`;
const userState = {
  favorites: [`${MOVIES_TV}/Orbital Drift`, `${MOVIES_TV}/The Cartographer`, `${MUSIC}/Mira Vale - Glass Hearts.mp3`, `${MUSIC}/Neon Pilots - Midnight Drive.mp3`],
  playback: {
    [episodePath(shows[0], 1, 1)]: { position: episodeDurationFor(shows[0], 1), duration: episodeDurationFor(shows[0], 1), updated: NOW - 3 * DAY, completed: true },
    [episodePath(shows[0], 1, 2)]: { position: episodeDurationFor(shows[0], 2), duration: episodeDurationFor(shows[0], 2), updated: NOW - 2 * DAY, completed: true },
    [episodePath(shows[0], 1, 3)]: { position: 1100, duration: episodeDurationFor(shows[0], 3), updated: NOW - 3600 },
    [episodePath(shows[3], 1, 1)]: { position: episodeDurationFor(shows[3], 1), duration: episodeDurationFor(shows[3], 1), updated: NOW - 5 * DAY, completed: true },
    [episodePath(shows[3], 1, 2)]: { position: 400, duration: episodeDurationFor(shows[3], 2), updated: NOW - DAY },
  } as Record<string, unknown>,
  last_accessed: Object.fromEntries([...shows.map((show, i) => [`${MOVIES_TV}/${show.title}`, NOW - i * 7200]), ...movies.map((movie, i) => [`${MOVIES_TV}/${movie.title}`, NOW - (i + 3) * 9000])]),
  tags: { [`${MOVIES_TV}/Orbital Drift`]: ["Weekend"], [`${MOVIES_TV}/Paper Kingdoms`]: ["Family"], [`${PHOTOS}/Beach Trip 2024`]: ["Family"] },
  tag_catalog: { Weekend: { name: "Weekend", created_at: NOW - 40 * DAY }, Family: { name: "Family", created_at: NOW - 60 * DAY } },
  playlists: {
    "road-trip": { id: "road-trip", name: "Road Trip", paths: songs.slice(0, 8).map(([a, t]) => `${MUSIC}/${a} - ${t}.mp3`), created_at: NOW - 30 * DAY },
    "focus": { id: "focus", name: "Focus", paths: songs.slice(8, 14).map(([a, t]) => `${MUSIC}/${a} - ${t}.mp3`), created_at: NOW - 20 * DAY },
  },
};

// ---------- artwork ----------
const PALETTES = [
  ["#1b2a49", "#e2725b"], ["#0f3443", "#34e89e"], ["#2b1055", "#d53369"], ["#16222a", "#3a6073"],
  ["#41295a", "#2f0743"], ["#3a1c71", "#ffaf7b"], ["#0b486b", "#f56217"], ["#1f1c2c", "#928dab"],
  ["#134e5e", "#71b280"], ["#4b134f", "#c94b4b"], ["#232526", "#fdc830"], ["#0f2027", "#2c5364"],
];
const escapeXml = (value: string) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function wrap(text: string, max: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if ((line + " " + word).trim().length > max && line) { lines.push(line); line = word; } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines;
}

function artSvg(seed: string, width: number, height: number, label = "", sub = "") {
  const h = hash(seed);
  const [a, b] = PALETTES[h % PALETTES.length];
  const circles = Array.from({ length: 5 }, (_, i) => {
    const v = hash(`${seed}:${i}`);
    return `<circle cx="${v % width}" cy="${(v >> 8) % height}" r="${(Math.min(width, height) / 6) + (v % (Math.min(width, height) / 2))}" fill="#fff" opacity="${0.04 + (v % 7) / 100}"/>`;
  }).join("");
  const lines = wrap(label.toUpperCase(), 11);
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const size = Math.round(Math.min(width * 0.86 / (longest * 0.78), width / 7, height / 7));
  const text = lines.map((line, i) => `<text x="50%" y="${height * 0.72 + i * size * 1.1}" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="${size}" letter-spacing="2" fill="#fff">${escapeXml(line)}</text>`).join("");
  const subText = sub ? `<text x="50%" y="${height * 0.72 + lines.length * size * 1.1 + size * 0.3}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.round(size * 0.45)}" letter-spacing="4" fill="#ffffffaa">${escapeXml(sub.toUpperCase())}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.65"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${circles}<rect width="100%" height="100%" fill="url(#s)"/>${text}${subText}</svg>`;
}

const posterUrl = (title: string) => `/demo-art/poster/${encodeURIComponent(title)}.svg`;
const backdropUrl = (title: string) => `/demo-art/backdrop/${encodeURIComponent(title)}.svg`;

// ---------- title metadata ----------
const normalize = (value: string) => value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
function titleMetadata(query: URLSearchParams) {
  const wanted = normalize(query.get("title") ?? "");
  const show = shows.find((item) => normalize(item.title) === wanted);
  if (show) {
    const videos = [];
    for (let s = 1; s <= show.seasons; s++) for (let e = 1; e <= show.episodes; e++) {
      videos.push({ id: `demo-${slug(show.title)}:${s}:${e}`, name: EPISODE_WORDS[(e + s * 5 + show.title.length) % EPISODE_WORDS.length], season: s, episode: e, thumbnail: `/demo-art/frame/${encodeURIComponent(`${show.title} ${s}x${e}`)}.svg`, released: new Date((NOW - (show.seasons - s) * 365 * DAY - (show.episodes - e) * 7 * DAY) * 1000).toISOString() });
    }
    return { id: `demo-${slug(show.title)}`, name: show.title, type: "series", releaseInfo: `${show.year}–`, imdbRating: show.rating, genres: show.genres, description: show.blurb, poster: posterUrl(show.title), background: backdropUrl(show.title), trailers: [{ source: "aqz-KE-bpKQ", type: "Trailer" }], videos };
  }
  const movie = movies.find((item) => normalize(item.title) === wanted);
  if (movie) return { id: `demo-${slug(movie.title)}`, name: movie.title, type: "movie", releaseInfo: String(movie.year), imdbRating: movie.rating, runtime: `${movie.minutes} min`, genres: movie.genres, description: movie.blurb, poster: posterUrl(movie.title), background: backdropUrl(movie.title), trailers: [{ source: "aqz-KE-bpKQ", type: "Trailer" }] };
  return null;
}

// ---------- discover ----------
const discoverTitles = [
  "Starfall Academy", "The Long Winter", "Echo Valley", "Brass Lanterns", "Night Market", "Coral Throne",
  "Atlas Protocol", "Wild Orchard", "Ghost Frequency", "Summit", "The Ninth Door", "Riverbend",
  "Lantern Bay", "Crimson Tide Line", "Moth & Flame", "Polaris", "Dust Runners", "Silent Choir",
].map((title, i) => ({
  id: 9000 + i,
  media_type: i % 3 === 1 ? "tv" : "movie",
  title: i % 3 === 1 ? undefined : title,
  name: i % 3 === 1 ? title : undefined,
  poster_path: `/demo/${encodeURIComponent(title)}.svg`,
  backdrop_path: `/demo-backdrop/${encodeURIComponent(title)}.svg`,
  overview: "A completely made-up title used for the TMS demo.",
  release_date: i % 3 === 1 ? undefined : `${2026 - (i % 4)}-0${(i % 9) + 1}-12`,
  first_air_date: i % 3 === 1 ? `${2026 - (i % 3)}-0${(i % 9) + 1}-04` : undefined,
  vote_average: 5.8 + ((i * 37) % 30) / 10,
  genres: [{ id: 1, name: ["Drama", "Sci-Fi", "Comedy", "Thriller", "Fantasy"][i % 5] }],
  seasons: i % 3 === 1 ? [1, 2].map((n) => ({ season_number: n, episode_count: 8, name: `Season ${n}` })) : undefined,
  credits: { cast: [{ id: 1, name: "Alex Rivers" }, { id: 2, name: "Jordan Lee" }, { id: 3, name: "Casey Moreno" }] },
  videos: { results: [] },
}));

const discoverRequests = [
  { kind: "tv", tmdb_id: 9001, id: "req-1", title: "The Long Winter", season: 1, library: MOVIES_TV, status: "downloading", error: null, progress: 0.62, subscribers: [1], created_at: NOW - 3600, monitor_future: false, service_id: null, hash: "demo", submitted: true, requested_by_name: "Demo" },
  { kind: "movie", tmdb_id: 9003, id: "req-2", title: "Brass Lanterns", season: null, library: MOVIES_TV, status: "ready", error: null, progress: 1, subscribers: [1], created_at: NOW - 2 * DAY, monitor_future: false, service_id: null, hash: "demo", submitted: true, requested_by_name: "Sam" },
  { kind: "movie", tmdb_id: 9006, id: "req-3", title: "Atlas Protocol", season: null, library: MOVIES_TV, status: "pending", error: null, progress: 0, subscribers: [2], created_at: NOW - 600, monitor_future: false, service_id: null, hash: null, submitted: false, requested_by_name: "Sam" },
];

// ---------- request handling ----------
const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const svg = (res: ServerResponse, body: string) => {
  res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
  res.end(body);
};
const stem = (path: string) => decodeURIComponent(path.split("/").at(-1) ?? "").replace(/\.[a-z0-9]+$/i, "");

function sortEntries(entries: Entry[], sort: string, direction: string) {
  const key = (entry: Entry): number | string => sort === "name" ? entry.name.toLowerCase()
    : sort === "size" ? entry.size
      : sort === "length" ? entry.duration ?? 0
        : sort === "date" ? entry.created_at
          : (userState.last_accessed as Record<string, number>)[entry.path] ?? entry.created_at - 400 * DAY;
  const sorted = [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return direction === "asc" ? sorted : sorted.reverse();
}

// Synthetic video frames are scenes without burned-in titles, like real stills.
function frameFor(path: string) {
  return artSvg(path, 640, 360);
}

function handle(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://demo.local");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/demo") {
    // Signs the browser into the fake account and opens the app.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<script>localStorage.setItem("tms:session-token","demo-token");localStorage.setItem("tms:session-user",${JSON.stringify(JSON.stringify(user))});location.replace("/");</script>`);
    return true;
  }
  if (path.startsWith("/demo-art/")) {
    const [, , type] = path.split("/");
    const title = stem(path);
    if (type === "poster") return svg(res, artSvg(title, 500, 750, title, "A TMS Demo")), true;
    if (type === "backdrop") return svg(res, artSvg(`${title}:bg`, 1280, 720)), true;
    // Episode stills are scenes, not title cards.
    return svg(res, artSvg(title, 640, 360)), true;
  }
  if (path === "/artwork-image") {
    const source = decodeURIComponent((url.searchParams.get("url") ?? "").split("/").at(-1) ?? "").replace(/\.svg$/, "");
    if ((url.searchParams.get("url") ?? "").includes("demo-backdrop")) return svg(res, artSvg(`${source}:bg`, 1280, 720)), true;
    return svg(res, artSvg(source, 342, 513, source)), true;
  }
  if (path.startsWith("/media/")) {
    const mediaPath = decodeURIComponent(path.slice("/media/".length));
    if (/\.(jpg|jpeg|png)$/i.test(mediaPath)) return svg(res, artSvg(mediaPath, 800, 600)), true;
    const clip = readFileSync(new URL("./synthetic-motion.webm", import.meta.url));
    const range = req.headers.range;
    const match = range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = match?.[1] ? Number(match[1]) : 0;
    let end = match?.[2] ? Number(match[2]) : clip.length - 1;
    if (match && !match[1] && match[2]) { start = Math.max(0, clip.length - Number(match[2])); end = clip.length - 1; }
    if (range && (!match || start >= clip.length || end < start)) { res.writeHead(416, { "Content-Range": `bytes */${clip.length}` }).end(); return true; }
    end = Math.min(end, clip.length - 1);
    res.writeHead(range ? 206 : 200, { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${clip.length}` } : {}) });
    res.end(method === "HEAD" ? undefined : clip.subarray(start, end + 1));
    return true;
  }
  if (path.startsWith("/folder-covers/") || path.startsWith("/profile-avatars/")) {
    return svg(res, artSvg(path, 500, 750)), true;
  }
  if (!path.startsWith("/api/")) return false;

  const api = path.slice(4);
  if (api === "/health") return json(res, { status: "ok", library_root: "D:/TMS Demo", library_available: true }), true;
  if (api === "/auth/login" || api === "/auth/session") return json(res, { token: "demo-token", user }), true;
  if (api === "/auth/setup") return json(res, { setup_required: false }), true;
  if (api === "/library") {
    const folder = url.searchParams.get("folder");
    const sort = url.searchParams.get("sort") ?? "opened";
    const direction = url.searchParams.get("direction") ?? "desc";
    if (!folder) return json(res, sortEntries(tree, sort, direction)), true;
    const page = sortEntries(childrenOf(folder), sort, direction);
    return json(res, page, 200, { "x-tms-total": String(page.length), "x-tms-has-more": "false", "x-tms-consumed": String(page.length) }), true;
  }
  if (api === "/libraries") return json(res, libraries), true;
  if (api === "/user-state") return json(res, userState), true;
  if (api === "/folder-covers") return json(res, {}), true;
  if (api === "/favorites" && method === "GET") return json(res, userState.favorites), true;
  if (api === "/title-metadata") {
    const metadata = titleMetadata(url.searchParams);
    return metadata ? json(res, metadata) : json(res, { message: "Not found" }, 404), true;
  }
  if (api === "/grid-thumb" || api === "/preview-frame") {
    const target = url.searchParams.get("path") ?? url.searchParams.get("video_path") ?? "";
    if (/\.(jpg|jpeg|png)$/i.test(target)) return svg(res, artSvg(target, 480, 360)), true;
    return svg(res, frameFor(target)), true;
  }
  if (api === "/storage/quota") return json(res, { used_bytes: 1_840_000_000_000, quota_bytes: 4_000_000_000_000, total_bytes: 4_000_000_000_000, free_bytes: 2_160_000_000_000 }), true;
  if (api === "/profile/sessions") {
    const onAndroid = /Android/i.test(String(req.headers["user-agent"] ?? ""));
    return json(res, [
      { token: "demo-token", device: onAndroid ? "TMS on Android" : "Chrome on Windows", created_at: NOW - 9 * DAY, last_seen_at: NOW, current: true },
      { token: "other", device: onAndroid ? "Chrome on Windows" : "TMS on Android", created_at: NOW - 30 * DAY, last_seen_at: NOW - 3600, current: false },
    ]), true;
  }
  if (api === "/discover/policy") return json(res, { members: [], users: [{ id: 1, name: "Demo" }, { id: 2, name: "Sam" }] }), true;
  if (api === "/discover/bootstrap") return json(res, { configured: true, is_admin: true, can_manage: true, libraries: [MOVIES_TV], availability: [], request_access: [{ user_id: 1, library: MOVIES_TV, can_request: true, auto_approve_requests: true, weekly_limit: 0 }], searches: ["space", "heist"] }), true;
  if (api === "/discover") {
    const kind = url.searchParams.get("kind") ?? url.searchParams.get("media_type");
    const query = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").toLowerCase();
    const results = discoverTitles.filter((title) => (!kind || kind === "all" || title.media_type === kind || (kind === "movies" && title.media_type === "movie") || (kind === "series" && title.media_type === "tv"))
      && (!query || (title.title ?? title.name ?? "").toLowerCase().includes(query)));
    return json(res, { results, total_pages: 1 }), true;
  }
  const discoverTitle = api.match(/^\/discover\/title\/(\w+)\/(\d+)$/);
  if (discoverTitle) {
    const title = discoverTitles.find((item) => item.id === Number(discoverTitle[2]));
    return title ? json(res, { ...title, recommendations: { results: discoverTitles.slice(0, 6) } }) : json(res, { message: "Not found" }, 404), true;
  }
  if (api === "/discover/requests") return json(res, { requests: discoverRequests }), true;
  if (api === "/discover/subscriptions") return json(res, { subscriptions: [] }), true;
  if (api === "/discover/history") return json(res, { searches: ["space", "heist"] }), true;
  if (api === "/admin/users") return json(res, [{ ...user, created_at: NOW - 100 * DAY, last_active_at: NOW - DAY / 24, storage_quota_bytes: null, used_bytes: 182 * 1024 ** 3, reserved_bytes: 0, available_bytes: null }, { id: 2, name: "Sam", is_admin: false, password_set: true, admin_permissions: {}, created_at: NOW - 50 * DAY, last_active_at: NOW - 2 * DAY, storage_quota_bytes: 500 * 1024 ** 3, used_bytes: 64 * 1024 ** 3, reserved_bytes: 0, available_bytes: 436 * 1024 ** 3 }]), true;
  if (api === "/admin/processes") return json(res, { processes: [] }), true;
  if (api === "/admin/library-locations") return json(res, {
    main_root: "D:/TMS Demo", main_root_available: true, locations: [],
  }), true;
  if (api === "/admin/downloads") return json(res, {
    tool: { ready: true, checking: false, version: "demo", error: null, updated_at: NOW },
    throttle: { sleep_interval_seconds: 0, max_sleep_interval_seconds: 0, limit_rate: "" },
    cookies: { exists: false, size_bytes: 0, updated_at: null, line_count: 0, sample_domains: [], has_youtube_auth: false },
  }), true;
  if (api.startsWith("/admin/")) return json(res, []), true;
  if (api === "/trash" || api === "/delete-requests") return json(res, []), true;
  if (api === "/qualities") return json(res, { source_height: 1080, levels: [1080, 720, 480], audio_compatible: true, audio_tracks: [] }), true;
  if (api === "/subtitles") return json(res, []), true;
  if (api === "/skip-segments") return json(res, { identity: { video_path: url.searchParams.get("video_path") ?? "", imdb_id: "", duration: 0, file_size: 0, modified_at: NOW }, providers: [], segments: [], fetched_at: NOW, cache_status: "fresh" }), true;
  if (api === "/downloads/magnet") return json(res, { connected: true, downloads: [], qbittorrent_checked: true }), true;
  if (api === "/downloads/yt-dlp") return json(res, { downloads: [] }), true;
  if (api === "/uploads/sessions") return json(res, []), true;
  if (api === "/shared-todo") return json(res, { text: "<p>Movie night list: Signal Lost, The Cartographer</p>" }), true;

  // Writes and telemetry succeed without changing anything.
  if (method !== "GET") return json(res, { ok: true }), true;
  return json(res, { message: "Not available in the demo" }, 404), true;
}

export function demoBackend(): Plugin {
  return {
    name: "tms-demo-backend",
    configureServer(server) {
      console.info("[tms-demo] Synthetic backend middleware ready");
      server.middlewares.use((req, res, next) => {
        if (req.url === "/demo") console.info("[tms-demo] Serving synthetic sign-in");
        try {
          if (!handle(req, res)) next();
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
