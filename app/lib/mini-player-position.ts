export const MINI_PLAYER_POSITION_KEY = "tms:video-mini-player-position:v1";
export const MINI_PLAYER_MARGIN = 12;

// Offsets from the viewport's right and bottom edges keep the player in the
// same corner when the window is resized or a phone rotates.
export type MiniPlayerPosition = { right: number; bottom: number };

export const clampMiniPlayerPosition = (
  position: MiniPlayerPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = MINI_PLAYER_MARGIN,
): MiniPlayerPosition => ({
  right: Math.round(Math.max(margin, Math.min(viewport.width - size.width - margin, position.right))),
  bottom: Math.round(Math.max(margin, Math.min(viewport.height - size.height - margin, position.bottom))),
});

// Phones keep a bottom navigation bar, so the default corner sits above it.
export const defaultMiniPlayerPosition = (phone: boolean): MiniPlayerPosition => ({ right: MINI_PLAYER_MARGIN, bottom: phone ? 84 : 20 });

export const parseMiniPlayerPosition = (raw: string | null, phone: boolean): MiniPlayerPosition => {
  try {
    const saved = JSON.parse(raw ?? "null") as Partial<MiniPlayerPosition> | null;
    if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) return { right: saved.right!, bottom: saved.bottom! };
  } catch { /* An unreadable position uses the default corner. */ }
  return defaultMiniPlayerPosition(phone);
};

// Dragging the player past the left or right edge dismisses it. Returns how
// far past the edge it is, as a fraction of the player's width.
export const MINI_PLAYER_DISMISS_FRACTION = 0.35;
export const miniPlayerOverflow = (rawRight: number, clampedRight: number, width: number) => width > 0 ? Math.abs(rawRight - clampedRight) / width : 0;
