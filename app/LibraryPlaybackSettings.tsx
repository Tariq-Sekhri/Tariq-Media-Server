"use client";
import { useEffect, useState } from "react";
import { alongsideAvailable, readLibraryPlayback, writeLibraryPlayback, type LibraryPlayback, type LibraryPlaybackKey } from "./lib/library-playback";

export default function LibraryPlaybackSettings({ libraries, displayName = (name) => name }: { libraries: string[]; displayName?: (name: string) => string }) {
  const [settings, setSettings] = useState<Record<string, LibraryPlayback> | null>(null);
  const [alongside, setAlongside] = useState(false);
  useEffect(() => { setSettings(readLibraryPlayback()); setAlongside(alongsideAvailable()); }, []);
  if (!settings || !libraries.length) return null;
  const toggle = (library: string, key: LibraryPlaybackKey, value: boolean) => {
    writeLibraryPlayback(library, key, value);
    setSettings(readLibraryPlayback());
  };
  return <fieldset className="profile-library-playback"><legend>Library playback</legend>
    <p className="settings-device-note">Applies on this device.</p>
    <div className={`settings-library-columns${alongside ? " has-alongside" : ""}`} aria-hidden="true"><span>Library</span><span>Start from beginning</span>{alongside && <span>Play alongside</span>}</div>
    {libraries.map(library => {
      const saved = settings[library.toLowerCase()] ?? {};
      return <div key={library} className={`profile-library-playback-row${alongside ? " has-alongside" : ""}`}>
        <b>{displayName(library)}</b>
        <label className="settings-library-toggle"><input type="checkbox" role="switch" aria-label={`${displayName(library)}: always start from the beginning`} checked={Boolean(saved.startFresh)} onChange={e => toggle(library, "startFresh", e.target.checked)} /></label>
        {alongside && <label className="settings-library-toggle"><input type="checkbox" role="switch" aria-label={`${displayName(library)}: play alongside other media`} checked={Boolean(saved.alongside)} onChange={e => toggle(library, "alongside", e.target.checked)} /></label>}
      </div>;
    })}
  </fieldset>;
}
