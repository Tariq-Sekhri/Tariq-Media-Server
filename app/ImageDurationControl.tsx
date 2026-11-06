"use client";

import { useEffect, useState } from "react";
import { imageSecondsPreset, normalizeImageSeconds } from "./lib/playback";

type ImageDurationControlProps = {
  value: number;
  onChange: (seconds: number) => void;
  idPrefix: string;
  disabled?: boolean;
  className?: string;
  onClick?: (event: React.MouseEvent) => void;
};

export default function ImageDurationControl({ value, onChange, idPrefix, disabled, className, onClick }: ImageDurationControlProps) {
  const [forceCustom, setForceCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const preset = imageSecondsPreset(value);
  const showCustom = forceCustom || preset === "custom";

  useEffect(() => {
    if (preset === "custom") setForceCustom(false);
  }, [preset, value]);

  return <div className={className ?? "image-duration-control"} onClick={onClick}>
    <select
      id={`${idPrefix}-preset`}
      className="watch-image-duration-select"
      value={showCustom ? "custom" : String(value)}
      disabled={disabled}
      aria-label="Time per image"
      onChange={(event) => {
        const next = event.target.value;
        if (next === "custom") {
          setForceCustom(true);
          return;
        }
        setForceCustom(false);
        setCustomDraft("");
        onChange(Number(next));
      }}
    >
      <option value="5">5s</option>
      <option value="30">30s</option>
      <option value="custom">Custom</option>
    </select>
    {showCustom ? <input
      id={`${idPrefix}-custom`}
      type="number"
      min={1}
      max={300}
      step={1}
      className="watch-image-duration-custom"
      value={customDraft || String(value)}
      disabled={disabled}
      aria-label="Custom seconds per image"
      onChange={(event) => setCustomDraft(event.target.value)}
      onBlur={() => {
        onChange(normalizeImageSeconds(Number(customDraft || value)));
        setCustomDraft("");
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    /> : null}
  </div>;
}
