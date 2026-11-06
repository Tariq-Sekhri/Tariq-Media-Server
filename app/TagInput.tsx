"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export default function TagInput({
  value,
  onChange,
  allTags,
  autoFocus,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  allTags: string[];
  autoFocus?: boolean;
}) {
  const [input, setInput] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const lowerInput = input.trim().toLowerCase();
    return allTags.filter((t) => !value.includes(t) && t.toLowerCase().includes(lowerInput));
  }, [input, value, allTags]);

  const hasExactMatch = options.some((t) => t.toLowerCase() === input.trim().toLowerCase());
  const showAdd =
    input.trim() !== "" &&
    !hasExactMatch &&
    !value.some((t) => t.toLowerCase() === input.trim().toLowerCase());

  useEffect(() => {
    setHighlightedIndex(0);
  }, [input, options.length]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const addTag = (tag: string) => {
    const next = tag.trim();
    if (next && !value.some((t) => t.toLowerCase() === next.toLowerCase())) onChange([...value, next]);
    setInput("");
    setIsOpen(true);
    setHighlightedIndex(0);
  };

  const removeTag = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && input === "") {
      e.preventDefault();
      if (value.length > 0) removeTag(value.length - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIsOpen(true);
      setHighlightedIndex((prev) => Math.min(prev + 1, options.length + (showAdd ? 0 : -1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIsOpen(true);
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (input.trim() === "" && options.length === 0) return;
      if (isOpen) {
        if (highlightedIndex < options.length) {
          addTag(options[highlightedIndex]);
        } else if (showAdd) {
          addTag(input.trim());
        }
      } else if (showAdd) {
        addTag(input.trim());
      }
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <div className="tag-input-container" ref={containerRef}>
      <div className="tag-input-box" onClick={() => setIsOpen(true)}>
        {value.map((tag, i) => (
          <span key={`${tag}-${i}`} className="tag-chip">
            {tag}
            <span
              role="button"
              tabIndex={0}
              aria-label={`Remove tag ${tag}`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                removeTag(i);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                removeTag(i);
              }}
            >
              ×
            </span>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          placeholder={value.length === 0 ? "Add tags..." : ""}
        />
      </div>
      {isOpen && (options.length > 0 || showAdd) && (
        <div className="tag-dropdown">
          {options.map((tag, i) => (
            <div
              key={tag}
              className={`tag-option ${i === highlightedIndex ? "highlighted" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                addTag(tag);
              }}
              onMouseEnter={() => setHighlightedIndex(i)}
            >
              {tag}
            </div>
          ))}
          {showAdd && (
            <div
              className={`tag-option add-option ${highlightedIndex === options.length ? "highlighted" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                addTag(input.trim());
              }}
              onMouseEnter={() => setHighlightedIndex(options.length)}
            >
              Add "{input.trim()}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}
