import { Capacitor, registerPlugin } from "@capacitor/core";

type ShortcutResult = { requested: boolean };

interface TmsShortcutsPlugin {
  add(options: { url: string; label: string }): Promise<ShortcutResult>;
}

const NativeShortcuts = registerPlugin<TmsShortcutsPlugin>("TmsShortcuts");

export const addNativeHomeScreenShortcut = async (url: string, label: string) => {
  if (Capacitor.getPlatform() !== "android") return false;
  const result = await NativeShortcuts.add({ url, label });
  return result.requested;
};
