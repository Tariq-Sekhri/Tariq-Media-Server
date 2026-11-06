import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

type NativePipState = {
  active: boolean;
  width: number;
  height: number;
  playing: boolean;
  hasNext: boolean;
};

type PipAction = "audio-only" | "play-pause" | "next" | "close" | "background" | "foreground";

interface TmsPipPlugin {
  setState(state: NativePipState): Promise<void>;
  enter(): Promise<{ entered: boolean; requiresSettings: boolean }>;
  exit(): Promise<void>;
  addListener(eventName: "action", listenerFunc: (event: { action: PipAction }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "state", listenerFunc: (event: { inPip: boolean }) => void): Promise<PluginListenerHandle>;
}

const TmsPip = registerPlugin<TmsPipPlugin>("TmsPip");

export const nativePipAvailable = () => Capacitor.getPlatform() === "android";

export const syncNativePipState = async (state: NativePipState) => {
  if (!nativePipAvailable()) return;
  await TmsPip.setState(state);
};

export const enterNativePip = async () => {
  if (!nativePipAvailable()) return { entered: false, requiresSettings: false };
  return TmsPip.enter();
};

export const exitNativePip = async () => {
  if (!nativePipAvailable()) return;
  await TmsPip.exit();
};

export const addNativePipActionListener = async (listener: (event: { action: PipAction }) => void) => {
  if (!nativePipAvailable()) return null;
  return TmsPip.addListener("action", listener);
};

export const addNativePipStateListener = async (listener: (event: { inPip: boolean }) => void) => {
  if (!nativePipAvailable()) return null;
  return TmsPip.addListener("state", listener);
};
