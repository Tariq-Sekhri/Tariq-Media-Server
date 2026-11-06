"use client";
import MenuIcon from "./MenuIcon";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { copyNoteImage, noteHtmlWithoutImageSelection, noteImageForCopy, selectNoteImage } from "./lib/copy-note-image";
import "./notes-image-selection.css";
import { useBackLayer } from "./lib/back-layers";

interface RichTextEditorProps {
  html: string;
  saveStatus?: string;
  onRetrySave?: () => void;
  onChange: (html: string) => void;
  placeholder?: string;
}

type ActiveFormatState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  code: boolean;
  heading: string; // 'p' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre'
  bulletList: boolean;
  numberedList: boolean;
  alignLeft: boolean;
  alignCenter: boolean;
  alignRight: boolean;
  alignJustify: boolean;
};

const DEFAULT_ACTIVE_FORMATS: ActiveFormatState = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  code: false,
  heading: "p",
  bulletList: false,
  numberedList: false,
  alignLeft: true,
  alignCenter: false,
  alignRight: false,
  alignJustify: false,
};

export default function RichTextEditor({
  html,
  saveStatus,
  onRetrySave,
  onChange,
  placeholder = "Write down notes, bugs, or todos…",
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isUpdatingFromPropRef = useRef(false);

  const [activeFormats, setActiveFormats] = useState<ActiveFormatState>(DEFAULT_ACTIVE_FORMATS);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [formattingOpen, setFormattingOpen] = useState(false);
  useBackLayer(formattingOpen, () => setFormattingOpen(false));
  const [linkUrl, setLinkUrl] = useState("");
  const [linkText, setLinkText] = useState("");
  const [savedRange, setSavedRange] = useState<Range | null>(null);

  const [showColorPicker, setShowColorPicker] = useState<"text" | "highlight" | null>(null);
  const [stats, setStats] = useState({ words: 0, chars: 0 });
  const [selectedImage, setSelectedImage] = useState<HTMLImageElement | null>(null);
  const [imageCopyStatus, setImageCopyStatus] = useState("");

  const handleCopyImage = useCallback(async (image = selectedImage) => {
    if (!image) return;
    try {
      await copyNoteImage(image);
      setImageCopyStatus("Image copied");
    } catch (error) {
      setImageCopyStatus(error instanceof Error ? error.message : "Could not copy the image. Try right-clicking it and choosing Copy image.");
    }
  }, [selectedImage]);

  // Sync incoming HTML changes without resetting cursor if user is editing
  useEffect(() => {
    if (!editorRef.current) return;
    if (editorRef.current.innerHTML !== html) {
      isUpdatingFromPropRef.current = true;
      editorRef.current.innerHTML = html;
      setSelectedImage(null);
      isUpdatingFromPropRef.current = false;
      updateStats();
    }
  }, [html]);

  const updateStats = useCallback(() => {
    if (!editorRef.current) return;
    const text = editorRef.current.innerText || "";
    const trimmed = text.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const chars = text.length;
    setStats({ words, chars });
  }, []);

  const triggerChange = useCallback(() => {
    if (!editorRef.current || isUpdatingFromPropRef.current) return;
    const currentHtml = noteHtmlWithoutImageSelection(editorRef.current);
    onChange(currentHtml);
    updateStats();
  }, [onChange, updateStats]);

  // Check which formatting states are active based on cursor selection
  const updateActiveFormats = useCallback(() => {
    if (!editorRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    try {
      const isBold = document.queryCommandState("bold");
      const isItalic = document.queryCommandState("italic");
      const isUnderline = document.queryCommandState("underline");
      const isStrike = document.queryCommandState("strikeThrough");
      const isBullet = document.queryCommandState("insertUnorderedList");
      const isNumbered = document.queryCommandState("insertOrderedList");
      const isAlignLeft = document.queryCommandState("justifyLeft");
      const isAlignCenter = document.queryCommandState("justifyCenter");
      const isAlignRight = document.queryCommandState("justifyRight");
      const isAlignJustify = document.queryCommandState("justifyFull");

      // Check current block heading tag
      let currentTag = "p";
      let node: Node | null = selection.anchorNode;
      let isInCode = false;

      while (node && node !== editorRef.current) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const tagName = el.tagName.toLowerCase();
          if (["h1", "h2", "h3", "blockquote", "pre"].includes(tagName)) {
            currentTag = tagName;
          }
          if (tagName === "code" || tagName === "pre") {
            isInCode = true;
          }
        }
        node = node.parentNode;
      }

      setActiveFormats({
        bold: isBold,
        italic: isItalic,
        underline: isUnderline,
        strikethrough: isStrike,
        code: isInCode,
        heading: currentTag,
        bulletList: isBullet,
        numberedList: isNumbered,
        alignLeft: isAlignLeft,
        alignCenter: isAlignCenter,
        alignRight: isAlignRight,
        alignJustify: isAlignJustify,
      });
    } catch {
      // queryCommandState may throw in certain edge selections
    }
  }, []);

  // Save current selection range before opening modal
  const saveCurrentSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      setSavedRange(sel.getRangeAt(0).cloneRange());
    }
  }, []);

  // Restore saved selection
  const restoreSelection = useCallback(() => {
    if (savedRange) {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
    }
  }, [savedRange]);

  // Execute standard formatting command
  const execCmd = useCallback(
    (command: string, value: string | undefined = undefined) => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      document.execCommand(command, false, value);
      updateActiveFormats();
      triggerChange();
    },
    [triggerChange, updateActiveFormats]
  );

  // Set block format (e.g. H1, H2, H3, Paragraph, Blockquote, Pre)
  const setBlockFormat = useCallback(
    (tag: string) => {
      if (!editorRef.current) return;
      editorRef.current.focus();

      if (tag === "p") {
        document.execCommand("formatBlock", false, "<p>");
      } else if (["h1", "h2", "h3", "blockquote", "pre"].includes(tag)) {
        document.execCommand("formatBlock", false, `<${tag}>`);
      }
      updateActiveFormats();
      triggerChange();
    },
    [triggerChange, updateActiveFormats]
  );

  // Insert an interactive task checklist item
  const insertChecklist = useCallback(() => {
    if (!editorRef.current) return;
    editorRef.current.focus();

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const selectedText = range.toString() || "Task item";

    const taskUl = document.createElement("ul");
    taskUl.className = "notes-checklist";
    const taskLi = document.createElement("li");
    taskLi.className = "notes-check-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "notes-check-box";

    const labelSpan = document.createElement("span");
    labelSpan.className = "notes-check-text";
    labelSpan.textContent = selectedText;

    taskLi.appendChild(checkbox);
    taskLi.appendChild(document.createTextNode(" "));
    taskLi.appendChild(labelSpan);
    taskUl.appendChild(taskLi);

    range.deleteContents();
    range.insertNode(taskUl);

    // Place cursor inside labelSpan
    const newRange = document.createRange();
    newRange.selectNodeContents(labelSpan);
    newRange.collapse(false);
    sel.removeAllRanges();
    sel.addRange(newRange);

    updateActiveFormats();
    triggerChange();
  }, [triggerChange, updateActiveFormats]);

  // Insert formatted table
  const insertTable = useCallback(
    (rows = 3, cols = 3) => {
      if (!editorRef.current) return;
      editorRef.current.focus();

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const table = document.createElement("table");
      table.className = "notes-table";

      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (let c = 0; c < cols; c++) {
        const th = document.createElement("th");
        th.textContent = `Header ${c + 1}`;
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (let r = 0; r < rows - 1; r++) {
        const tr = document.createElement("tr");
        for (let c = 0; c < cols; c++) {
          const td = document.createElement("td");
          td.textContent = `Cell ${r + 1}-${c + 1}`;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      range.deleteContents();
      range.insertNode(table);

      // Add a paragraph below table for easy continuation
      const p = document.createElement("p");
      p.innerHTML = "<br/>";
      if (table.nextSibling) {
        editorRef.current.insertBefore(p, table.nextSibling);
      } else {
        editorRef.current.appendChild(p);
      }

      triggerChange();
    },
    [triggerChange]
  );

  // Insert link handler
  const handleOpenLinkModal = useCallback(() => {
    saveCurrentSelection();
    const sel = window.getSelection();
    const selectedText = sel?.toString() || "";
    setLinkText(selectedText);
    setLinkUrl("");
    setShowLinkModal(true);
  }, [saveCurrentSelection]);

  const handleApplyLink = useCallback(() => {
    if (!linkUrl.trim()) {
      setShowLinkModal(false);
      return;
    }

    restoreSelection();
    editorRef.current?.focus();

    let targetUrl = linkUrl.trim();
    if (!/^https?:\/\//i.test(targetUrl) && !targetUrl.startsWith("/") && !targetUrl.startsWith("#") && !targetUrl.startsWith("mailto:")) {
      targetUrl = `https://${targetUrl}`;
    }

    if (linkText) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const a = document.createElement("a");
        a.href = targetUrl;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        a.textContent = linkText;
        range.insertNode(a);
        range.setStartAfter(a);
        range.setEndAfter(a);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      document.execCommand("createLink", false, targetUrl);
    }

    setShowLinkModal(false);
    setLinkUrl("");
    setLinkText("");
    triggerChange();
  }, [linkText, linkUrl, restoreSelection, triggerChange]);

  // Insert Image from file
  const handleImageUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const file = files[0];
      const reader = new FileReader();
      reader.onload = (uploadEvent) => {
        const base64 = uploadEvent.target?.result as string;
        if (base64 && editorRef.current) {
          editorRef.current.focus();
          document.execCommand("insertImage", false, base64);
          triggerChange();
        }
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    },
    [triggerChange]
  );

  // Handle clicking checkboxes directly in the editor
  const handleEditorClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const image = target.tagName === "IMG" ? target as HTMLImageElement : null;
      if (editorRef.current) selectNoteImage(editorRef.current, image);
      setSelectedImage(image);
      setImageCopyStatus("");
      if (target.tagName === "IMG") e.preventDefault();
      if (target && target.tagName === "INPUT" && (target as HTMLInputElement).type === "checkbox") {
        const checkbox = target as HTMLInputElement;
        if (checkbox.checked) {
          checkbox.setAttribute("checked", "true");
          checkbox.parentElement?.classList.add("completed");
        } else {
          checkbox.removeAttribute("checked");
          checkbox.parentElement?.classList.remove("completed");
        }
        triggerChange();
      }
    },
    [triggerChange]
  );

  // Intercept keyboard shortcuts inside the editor
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Ctrl / Cmd shortcuts
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case "c": {
            const image = editorRef.current && noteImageForCopy(editorRef.current, selectedImage, window.getSelection());
            if (image) {
              e.preventDefault();
              void handleCopyImage(image);
            }
            break;
          }
          case "b":
            e.preventDefault();
            execCmd("bold");
            break;
          case "i":
            e.preventDefault();
            execCmd("italic");
            break;
          case "u":
            e.preventDefault();
            execCmd("underline");
            break;
          case "k":
            e.preventDefault();
            handleOpenLinkModal();
            break;
          case "z":
            // Let default undo or handle
            break;
          default:
            break;
        }
      }

      // Tab indentation
      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          execCmd("outdent");
        } else {
          execCmd("indent");
        }
      }
    },
    [execCmd, handleOpenLinkModal, selectedImage, handleCopyImage]
  );

  // Color palettes
  const TEXT_COLORS = [
    { label: "Default", value: "inherit" },
    { label: "Red", value: "#f85149" },
    { label: "Orange", value: "#f0883e" },
    { label: "Yellow", value: "#d29922" },
    { label: "Green", value: "#3fb950" },
    { label: "Teal", value: "#39c5bb" },
    { label: "Blue", value: "#58a6ff" },
    { label: "Purple", value: "#bc8cff" },
    { label: "Pink", value: "#f778ba" },
    { label: "Muted", value: "#8b949e" },
  ];

  const HIGHLIGHT_COLORS = [
    { label: "None", value: "transparent" },
    { label: "Yellow", value: "rgba(210, 153, 34, 0.35)" },
    { label: "Green", value: "rgba(63, 185, 80, 0.35)" },
    { label: "Blue", value: "rgba(88, 166, 255, 0.35)" },
    { label: "Purple", value: "rgba(188, 140, 255, 0.35)" },
    { label: "Red", value: "rgba(248, 81, 73, 0.35)" },
  ];

  const applyColor = useCallback(
    (type: "text" | "highlight", color: string) => {
      if (!editorRef.current) return;
      editorRef.current.focus();

      if (type === "text") {
        document.execCommand("foreColor", false, color);
      } else {
        document.execCommand("hiliteColor", false, color);
      }
      setShowColorPicker(null);
      triggerChange();
    },
    [triggerChange]
  );

  return (
    <div className={`rich-notes-container${formattingOpen ? " formatting-open" : ""}`}>
      {/* Hidden file input for image uploads */}
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleImageUpload}
      />

      <div className="mobile-notes-toolbar" role="toolbar" aria-label="Note formatting">
        <button type="button" aria-label="Bold" aria-pressed={activeFormats.bold} onMouseDown={e => e.preventDefault()} onClick={() => execCmd("bold")}><MenuIcon name="bold" /></button>
        <button type="button" aria-label="Italic" aria-pressed={activeFormats.italic} onMouseDown={e => e.preventDefault()} onClick={() => execCmd("italic")}><MenuIcon name="italic" /></button>
        <button type="button" aria-label="Bullet list" aria-pressed={activeFormats.bulletList} onMouseDown={e => e.preventDefault()} onClick={() => execCmd("insertUnorderedList")}><MenuIcon name="list" /></button>
        <button type="button" aria-label="Undo" onMouseDown={e => e.preventDefault()} onClick={() => execCmd("undo")}><MenuIcon name="undo" /></button>
        <button type="button" aria-label="More formatting" aria-expanded={formattingOpen} onMouseDown={e => e.preventDefault()} onClick={() => setFormattingOpen(!formattingOpen)}>&#8943;</button>
      </div>
      {/* Main Rich Text Toolbar */}
      <div className="rich-notes-toolbar" role="toolbar" aria-label="Rich Text Formatting">
        {selectedImage && <div className="toolbar-group" role="group" aria-label="Selected image">
          <button type="button" className="toolbar-btn" onMouseDown={(event) => event.preventDefault()} onClick={() => void handleCopyImage()}>Copy image</button>
          <button type="button" className="toolbar-btn" aria-label="Dismiss image actions" onClick={() => { if (editorRef.current) selectNoteImage(editorRef.current, null); setSelectedImage(null); setImageCopyStatus(""); }}>×</button>
        </div>}
        {/* Block / Heading Selector */}
        <div className="toolbar-group">
          <select
            className="toolbar-select"
            value={activeFormats.heading}
            onChange={(e) => setBlockFormat(e.target.value)}
            title="Text Style / Heading"
          >
            <option value="p">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="blockquote">Quote Block</option>
            <option value="pre">Code Block</option>
          </select>
        </div>

        <div className="toolbar-divider" />

        {/* Inline Formatting */}
        <div className="toolbar-group">
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.bold ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("bold");
            }}
            title="Bold (Ctrl+B)"
            aria-label="Bold"
          >
            <MenuIcon name="bold" />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.italic ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("italic");
            }}
            title="Italic (Ctrl+I)"
            aria-label="Italic"
          >
            <MenuIcon name="italic" />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.underline ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("underline");
            }}
            title="Underline (Ctrl+U)"
            aria-label="Underline"
          >
            <MenuIcon name="underline" />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.strikethrough ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("strikeThrough");
            }}
            title="Strikethrough"
            aria-label="Strikethrough"
          >
            <MenuIcon name="strike" />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.code ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              // Toggle inline code formatting
              const sel = window.getSelection();
              if (sel && sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                const codeEl = document.createElement("code");
                codeEl.textContent = range.toString() || "code";
                range.deleteContents();
                range.insertNode(codeEl);
                triggerChange();
              }
            }}
            title="Inline Code"
            aria-label="Inline Code"
          >
            <MenuIcon name="code" />
          </button>
        </div>

        <div className="toolbar-divider" />

        {/* Lists & Tasks */}
        <div className="toolbar-group">
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.bulletList ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("insertUnorderedList");
            }}
            title="Bullet List"
            aria-label="Bullet List"
          >
            <MenuIcon name="list" />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.numberedList ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("insertOrderedList");
            }}
            title="Numbered List"
            aria-label="Numbered List"
          >
            <MenuIcon name="numbers" />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              insertChecklist();
            }}
            title="Task Checklist"
            aria-label="Checklist"
          >
            <MenuIcon name="select" />
          </button>
        </div>

        <div className="toolbar-divider" />

        {/* Alignment & Indentation */}
        <div className="toolbar-group">
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.alignLeft ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("justifyLeft");
            }}
            title="Align Left"
            aria-label="Align Left"
          >
            <MenuIcon name="alignLeft" />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.alignCenter ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("justifyCenter");
            }}
            title="Align Center"
            aria-label="Align Center"
          >
            <MenuIcon name="alignCenter" />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${activeFormats.alignRight ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("justifyRight");
            }}
            title="Align Right"
            aria-label="Align Right"
          >
            <MenuIcon name="alignRight" />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("outdent");
            }}
            title="Decrease Indent (Shift+Tab)"
            aria-label="Decrease Indent"
          >
            <MenuIcon name="outdent" />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("indent");
            }}
            title="Increase Indent (Tab)"
            aria-label="Increase Indent"
          >
            <MenuIcon name="indent" />
          </button>
        </div>

        <div className="toolbar-divider" />

        {/* Colors & Highlight */}
        <div className="toolbar-group color-group-relative">
          <button
            type="button"
            className={`toolbar-btn ${showColorPicker === "text" ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              setShowColorPicker((prev) => (prev === "text" ? null : "text"));
            }}
            title="Text Color"
            aria-label="Text Color"
          >
            <MenuIcon name="textColor" />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${showColorPicker === "highlight" ? "active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              setShowColorPicker((prev) => (prev === "highlight" ? null : "highlight"));
            }}
            title="Highlight Color"
            aria-label="Highlight Color"
          >
            <MenuIcon name="highlight" />
          </button>

          {/* Color dropdown popover */}
          {showColorPicker && (
            <div className="toolbar-color-popover" onMouseDown={(e) => e.stopPropagation()}>
              <div className="color-popover-title">
                {showColorPicker === "text" ? "Text Color" : "Highlight"}
              </div>
              <div className="color-grid">
                {(showColorPicker === "text" ? TEXT_COLORS : HIGHLIGHT_COLORS).map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className="color-cell"
                    style={{
                      background: c.value === "inherit" || c.value === "transparent" ? "#21262d" : c.value,
                    }}
                    title={c.label}
                    onClick={() => applyColor(showColorPicker, c.value)}
                  >
                    {c.value === "inherit" || c.value === "transparent" ? "∅" : ""}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="toolbar-divider" />

        {/* Insert Elements: Link, Table, Image, Divider */}
        <div className="toolbar-group">
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              handleOpenLinkModal();
            }}
            title="Insert Link (Ctrl+K)"
            aria-label="Insert Link"
          >
            <MenuIcon name="link" />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              fileInputRef.current?.click();
            }}
            title="Upload / Insert Image"
            aria-label="Insert Image"
          >
            <MenuIcon name="image" />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              insertTable(3, 3);
            }}
            title="Insert Table (3x3)"
            aria-label="Insert Table"
          >
            <MenuIcon name="table" />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("insertHorizontalRule");
            }}
            title="Insert Divider"
            aria-label="Insert Divider"
          >
            <MenuIcon name="divider" />
          </button>
        </div>

        <div className="toolbar-divider" />

        {/* Utilities: Clear Formatting, Undo, Redo */}
        <div className="toolbar-group">
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("removeFormat");
            }}
            title="Clear Formatting"
            aria-label="Clear Formatting"
          >
            <MenuIcon name="clear" />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("undo");
            }}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <MenuIcon name="undo" />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              execCmd("redo");
            }}
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
          >
            <MenuIcon name="redo" />
          </button>
        </div>
      </div>

      {/* Editor Content Area */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Notes editor"
        aria-multiline="true"
        className="shared-notes-editor rich-content-editable"
        onFocus={() => setFormattingOpen(false)}
        data-placeholder={placeholder}
        onInput={triggerChange}
        onKeyUp={() => {
          updateActiveFormats();
          updateStats();
        }}
        onMouseUp={() => {
          updateActiveFormats();
        }}
        onClick={handleEditorClick}
        onCopy={(event) => {
          if (!editorRef.current) return;
          const image = noteImageForCopy(editorRef.current, selectedImage, window.getSelection());
          if (!image) return;
          event.preventDefault();
          void handleCopyImage(image);
        }}
        onContextMenu={(event) => {
          if (!(event.target instanceof HTMLImageElement)) return;
          event.preventDefault();
          if (editorRef.current) selectNoteImage(editorRef.current, event.target);
          setSelectedImage(event.target);
          void handleCopyImage(event.target);
        }}
        onKeyDown={handleKeyDown}
      />

      {/* Bottom Status Bar with word & char count */}
      <div className="rich-notes-statusbar">
        {saveStatus && <span className="statusbar-item" role="status">{saveStatus}</span>}
        {onRetrySave && <button type="button" onClick={onRetrySave}>Retry save</button>}
        <span className="statusbar-item">{stats.words} words</span>
        <span className="statusbar-dot">·</span>
        <span className="statusbar-item">{stats.chars} characters</span>
        <span className="statusbar-hint" role="status">{imageCopyStatus || (selectedImage ? "Image selected. Press Ctrl+C / Cmd+C to copy." : "Tip: Paste screenshots or images directly into the editor")}</span>
      </div>

      {/* Insert Link Modal */}
      {showLinkModal && (
        <div className="rich-link-modal-backdrop" onClick={() => setShowLinkModal(false)}>
          <div className="rich-link-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Insert Link</h3>
            <div className="link-field">
              <label>Link Text</label>
              <input
                type="text"
                placeholder="Text to display"
                value={linkText}
                onChange={(e) => setLinkText(e.target.value)}
                autoFocus
              />
            </div>
            <div className="link-field">
              <label>URL</label>
              <input
                type="url"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleApplyLink();
                  }
                }}
              />
            </div>
            <div className="link-modal-actions">
              <button
                type="button"
                className="btn-cancel"
                onClick={() => setShowLinkModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleApplyLink}
                disabled={!linkUrl.trim()}
              >
                Insert
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
