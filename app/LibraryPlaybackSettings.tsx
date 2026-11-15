"use client";
import { useSyncExternalStore } from "react";
import { LIBRARY_PLAYBACK_EVENT, alongsideAvailable, readLibraryPlayback, writeLibraryPlayback, type LibraryPlayback, type LibraryPlaybackKey } from "./lib/library-playback";

type Snapshot = { settings: Record<string, LibraryPlayback>; alongside: boolean };
let cachedKey = "";
let cached: Snapshot | null = null;
const subscribe = (onChange: () => void) => {
  window.addEventListener(LIBRARY_PLAYBACK_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => { window.removeEventListener(LIBRARY_PLAYBACK_EVENT, onChange); window.removeEventListener("storage", onChange); };
};
const snapshot = (): Snapshot => {
  const settings = readLibraryPlayback();
  const alongside = alongsideAvailable();
  const key = JSON.stringify([settings, alongside]);
  if (!cached || key !== cachedKey) { cachedKey = key; cached = { settings, alongside }; }
  return cached;
};
const serverSnapshot = () => null;

function PlaybackSwitch({ name, checked, onChange }: { name: string; checked: boolean; onChange: () => void }) {
  return <button type="button" role="switch" aria-label={name} aria-checked={checked} onClick={onChange}
    className="group m-0! inline-flex! min-h-11! w-14! min-w-14! shrink-0! cursor-pointer! items-center! justify-center! rounded-lg! border-0! bg-transparent! p-0! shadow-none! focus-visible:outline-2! focus-visible:outline-offset-2! focus-visible:outline-[#b6a3ff]!">
    <span aria-hidden="true" className="relative block! h-6! w-11! shrink-0! rounded-full! bg-[#394353]! transition-colors group-aria-checked:bg-[#9279df]! group-hover:ring-2 group-hover:ring-[#b6a3ff]/40">
      <span className="absolute! top-1! left-1! m-0! block! h-4! w-4! rounded-full! bg-white! transition-transform group-aria-checked:translate-x-5! motion-reduce:transition-none!" />
    </span>
  </button>;
}

export default function LibraryPlaybackSettings({ libraries, displayName = (name) => name }: { libraries: string[]; displayName?: (name: string) => string }) {
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  if (!state || !libraries.length) return null;
  const { settings, alongside } = state;
  const toggle = (library: string, key: LibraryPlaybackKey, value: boolean) => writeLibraryPlayback(library, key, value);
  const columns = alongside ? "sm:grid-cols-[minmax(0,1fr)_148px_120px]" : "sm:grid-cols-[minmax(0,1fr)_148px]";
  return <fieldset className="m-0! w-full! min-w-0! border-0! p-0!">
    <legend className="mb-1! p-0! text-base! leading-6! font-semibold! text-[#e9edf4]!">Library playback</legend>
    <p className="mt-0! mb-4! text-sm! text-[#a5afbd]!">Applies on this device.</p>
    <div className={`hidden sm:grid ${columns} items-center gap-3 px-4 pb-3 text-sm text-[#a5afbd]`} aria-hidden="true">
      <span>Library</span><span className="text-center">Start from beginning</span>{alongside && <span className="text-center">Play alongside</span>}
    </div>
    <div className="overflow-hidden rounded-xl border border-solid border-[#303846] bg-[#151b24]">
    {libraries.map(library => {
      const saved = settings[library.toLowerCase()] ?? {};
      return <div key={library} className={`grid ${alongside ? "grid-cols-2" : "grid-cols-1"} ${columns} items-center gap-x-3 gap-y-1 border-0 border-b border-solid border-[#2b3340] px-4 py-3 last:border-b-0 sm:min-h-14 sm:py-1.5`}>
        <b className="col-span-full min-w-0 text-[15px] leading-6 font-medium text-[#e2e7f0] [overflow-wrap:anywhere] sm:col-span-1">{displayName(library)}</b>
        <div className="flex min-w-0 items-center justify-between gap-1 sm:justify-center">
          <span className="text-sm leading-5 text-[#aeb8c8] sm:hidden">Start from beginning</span>
          <PlaybackSwitch name={`${displayName(library)}: always start from the beginning`} checked={Boolean(saved.startFresh)} onChange={() => toggle(library, "startFresh", !saved.startFresh)} />
        </div>
        {alongside && <div className="flex min-w-0 items-center justify-between gap-1 sm:justify-center">
          <span className="text-sm leading-5 text-[#aeb8c8] sm:hidden">Play alongside</span>
          <PlaybackSwitch name={`${displayName(library)}: play alongside other media`} checked={Boolean(saved.alongside)} onChange={() => toggle(library, "alongside", !saved.alongside)} />
        </div>}
      </div>;
    })}
    </div>
  </fieldset>;
}
