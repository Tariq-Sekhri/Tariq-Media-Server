"use client";
import { useEffect, useState } from "react";
import { alongsideAvailable, readLibraryPlayback, writeLibraryPlayback, type LibraryPlayback, type LibraryPlaybackKey } from "./lib/library-playback";

export default function LibraryPlaybackSettings({ libraries }: { libraries: string[] }) {
  const [settings, setSettings] = useState<Record<string, LibraryPlayback> | null>(null);
  const [alongside, setAlongside] = useState(false);
  useEffect(() => { setSettings(readLibraryPlayback()); setAlongside(alongsideAvailable()); }, []);
  if (!settings || !libraries.length) return null;
  const toggle = (library: string, key: LibraryPlaybackKey, value: boolean) => {
    writeLibraryPlayback(library, key, value);
    setSettings(readLibraryPlayback());
  };
  return <fieldset className="profile-library-playback"><legend>Library playback on this device</legend>
    {libraries.map(library => {
      const saved = settings[library.toLowerCase()] ?? {};
      return <div key={library} className="profile-library-playback-row">
        <b>{library}</b>
        <label className="profile-device-path-option"><input type="checkbox" checked={Boolean(saved.startFresh)} onChange={e => toggle(library, "startFresh", e.target.checked)} /><span>Always start from the beginning</span></label>
        {alongside && <label className="profile-device-path-option"><input type="checkbox" checked={Boolean(saved.alongside)} onChange={e => toggle(library, "alongside", e.target.checked)} /><span>Play alongside other media</span></label>}
      </div>;
    })}
  </fieldset>;
}
