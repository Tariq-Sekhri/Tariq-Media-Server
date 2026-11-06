export type CaptionPreferences = {
  font_size: number;
  text_color: string;
  background_color: string;
  background_opacity: number;
  font_family: "system" | "serif" | "monospace";
  text_edge: "outline" | "shadow" | "none";
  position_x: number;
  position_y: number;
};

export const DEFAULT_CAPTION_PREFERENCES: CaptionPreferences = {
  font_size: 100,
  text_color: "#ffffff",
  background_color: "#000000",
  background_opacity: 0,
  font_family: "system",
  text_edge: "outline",
  position_x: 48.46434,
  // Tariq's saved position: low enough to clear the picture without sitting high.
  position_y: 94.269875,
};

export type PlaybackPreferences = {
  auto_skip_enabled: boolean;
  /** Per-title overrides. The account-wide setting remains the fallback for older saves. */
  auto_skip_by_show: Record<string, boolean>;
  auto_next_enabled: boolean;
  captions_enabled: boolean;
  intro_seconds: number;
  ending_seconds: number;
  buffer_size_mb: 100 | 250 | 500;
  image_seconds: number;
  load_all_items?: boolean;
  caption_preferences: CaptionPreferences;
};

export const DEFAULT_PLAYBACK_PREFERENCES: PlaybackPreferences = {
  auto_skip_enabled: false,
  auto_skip_by_show: {},
  auto_next_enabled: true,
  captions_enabled: false,
  intro_seconds: 0,
  ending_seconds: 0,
  buffer_size_mb: 500,
  image_seconds: 5,
  load_all_items: false,
  caption_preferences: DEFAULT_CAPTION_PREFERENCES,
};

export const IMAGE_SECONDS_PRESET_OPTIONS = [5, 30] as const;

export type ImageSecondsPreset = typeof IMAGE_SECONDS_PRESET_OPTIONS[number] | "custom";

export const imageSecondsPreset = (seconds: number): ImageSecondsPreset => {
  if (seconds === 5) return 5;
  if (seconds === 30) return 30;
  return "custom";
};

export const normalizeImageSeconds = (value?: number) => {
  if (!Number.isFinite(value) || !value) return DEFAULT_PLAYBACK_PREFERENCES.image_seconds;
  return Math.max(1, Math.min(300, Math.round(value)));
};

export const playbackPreferencesFromState = (preferences?: Partial<PlaybackPreferences>): PlaybackPreferences => ({
  ...DEFAULT_PLAYBACK_PREFERENCES,
  ...preferences,
  buffer_size_mb: preferences?.buffer_size_mb === 100 || preferences?.buffer_size_mb === 250 || preferences?.buffer_size_mb === 500 ? preferences.buffer_size_mb : 500,
  image_seconds: normalizeImageSeconds(preferences?.image_seconds),
  load_all_items: preferences?.load_all_items ?? false,
  auto_skip_by_show: Object.fromEntries(
    Object.entries(preferences?.auto_skip_by_show ?? {}).filter((entry): entry is [string, boolean] => (
      entry[0].length > 0 && entry[0].length <= 500 && typeof entry[1] === "boolean"
    )),
  ),
  caption_preferences: {
    ...DEFAULT_CAPTION_PREFERENCES,
    ...preferences?.caption_preferences,
    font_size: Math.max(50, Math.min(200, Math.round(preferences?.caption_preferences?.font_size ?? DEFAULT_CAPTION_PREFERENCES.font_size))),
    background_opacity: Math.max(0, Math.min(1, preferences?.caption_preferences?.background_opacity ?? DEFAULT_CAPTION_PREFERENCES.background_opacity)),
    position_x: Math.max(5, Math.min(95, preferences?.caption_preferences?.position_x ?? DEFAULT_CAPTION_PREFERENCES.position_x)),
    position_y: Math.max(5, Math.min(95, preferences?.caption_preferences?.position_y ?? DEFAULT_CAPTION_PREFERENCES.position_y)),
  },
});
