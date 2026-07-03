// content.js
// Runs on every page/frame. Detects editable fields, requests AI completions,
// renders inline "ghost text", and handles Tab-to-accept.

(() => {
  const DEBOUNCE_MS = 350;
  const MIN_CHARS_BEFORE_SUGGEST = 3;

  const MIRRORED_STYLE_PROPS = [
    "boxSizing", "width", "height", "overflowX", "overflowY",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderStyle", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
    "fontSizeAdjust", "lineHeight", "fontFamily", "textAlign", "textTransform",
    "textIndent", "textDecoration", "letterSpacing", "wordSpacing", "tabSize",
    "whiteSpace", "wordWrap", "wordBreak", "direction"
  ];

  /** State for the field currently showing (or fetching) a suggestion. */
  let activeField = null;
  let activeSuggestion = "";
  let debounceTimer = null;
  let requestToken = 0; // guards against stale async responses
  let overlayEl = null; // mirror overlay for textarea/input
  let hintEl = null;    // small "Tab to accept" badge
  let ghostSpan = null; // inline span for contenteditable

  function isEligibleField(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return ["text", "search", "email", "url", "tel"].includes(type);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function getFieldText(el) {
    if (el.isContentEditable) return el.innerText;
    return el.value;
  }

  function getCursorOffsets(el) {
    if (el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) return null;
      const preRange = range.cloneRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      const before = preRange.toString();
      const full = el.innerText;
      return { before, after: full.slice(before.length), collapsed: range.collapsed };
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start == null || end == null || start !== end) return null; // only suggest on collapsed caret
    const value = el.value;
    return { before: value.slice(0, start), after: value.slice(start), collapsed: true };
  }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.className = "ai-ac-overlay";
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function ensureHint() {
    if (hintEl) return hintEl;
    hintEl = document.createElement("div");
    hintEl.className = "ai-ac-hint";
    hintEl.textContent = "Tab to accept";
    document.body.appendChild(hintEl);
    return hintEl;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function positionOverlayOnField(el) {
    const rect = el.getBoundingClientRect();
    const overlay = ensureOverlay();
    const cs = getComputedStyle(el);

    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    for (const prop of MIRRORED_STYLE_PROPS) {
      overlay.style[prop] = cs[prop];
    }
    if (el.tagName === "INPUT") {
      overlay.style.whiteSpace = "pre";
    }
    overlay.scrollTop = el.scrollTop;
    overlay.scrollLeft = el.scrollLeft;
  }

  function renderTextareaOrInputGhost(el, before, suggestion, after) {
    positionOverlayOnField(el);
    overlayEl.innerHTML =
      escapeHtml(before) +
      `<span class="ai-ac-suggestion">${escapeHtml(suggestion)}</span>` +
      escapeHtml(after);
    overlayEl.style.visibility = "visible";
    positionHintNearCaret(el);
  }

  function renderContentEditableGhost(el, suggestion) {
    clearContentEditableGhost();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0).cloneRange();
    if (!range.collapsed) return;

    ghostSpan = document.createElement("span");
    ghostSpan.className = "ai-ac-inline-ghost";
    ghostSpan.textContent = suggestion;
    ghostSpan.setAttribute("data-ai-ac-ghost", "true");
    range.insertNode(ghostSpan);
    // Move the real caret back to just before the ghost span.
    range.setStartBefore(ghostSpan);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    positionHintNearElement(ghostSpan.getBoundingClientRect());
  }

  function clearContentEditableGhost() {
    if (ghostSpan && ghostSpan.parentNode) {
      ghostSpan.parentNode.removeChild(ghostSpan);
    }
    ghostSpan = null;
  }

  function positionHintNearCaret(el) {
    // Cheap approximation: place hint at the field's top-right corner.
    // (Full caret-pixel tracking is done implicitly by the overlay mirror itself;
    // the hint badge is just a discoverability nudge, not required for correctness.)
    const rect = el.getBoundingClientRect();
    positionHintNearElement({ top: rect.top, right: rect.right, bottom: rect.top, left: rect.right - 90 });
  }

  function positionHintNearElement(rect) {
    const hint = ensureHint();
    hint.style.left = `${rect.left + window.scrollX}px`;
    hint.style.top = `${rect.top + window.scrollY - 20}px`;
    hint.classList.add("visible");
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.visibility = "hidden";
    if (hintEl) hintEl.classList.remove("visible");
  }

  function clearSuggestion({ keepField = false } = {}) {
    activeSuggestion = "";
    clearContentEditableGhost();
    hideOverlay();
    if (!keepField) activeField = null;
  }

  function requestCompletion(el) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const offsets = getCursorOffsets(el);
      if (!offsets || !offsets.collapsed) return;
      const { before, after } = offsets;
      if (before.trim().length < MIN_CHARS_BEFORE_SUGGEST) return;

      const myToken = ++requestToken;
      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: "GET_COMPLETION",
          payload: { textBeforeCursor: before, textAfterCursor: after }
        });
      } catch (err) {
        return; // extension context invalidated / page navigated away, etc.
      }

      if (myToken !== requestToken) return; // a newer keystroke superseded this request
      if (document.activeElement !== el) return; // user moved on
      if (!response || response.error || !response.text) return;

      const currentOffsets = getCursorOffsets(el);
      if (!currentOffsets || currentOffsets.before !== before) return; // text changed mid-flight

      activeField = el;
      activeSuggestion = response.text;

      if (el.isContentEditable) {
        renderContentEditableGhost(el, activeSuggestion);
      } else {
        renderTextareaOrInputGhost(el, before, activeSuggestion, after);
      }
    }, DEBOUNCE_MS);
  }

  function acceptSuggestion(el) {
    if (!activeSuggestion) return false;
    const suggestion = activeSuggestion;

    if (el.isContentEditable) {
      clearContentEditableGhost();
      // insertText keeps the browser's native undo stack intact.
      document.execCommand("insertText", false, suggestion);
    } else {
      const start = el.selectionStart;
      const value = el.value;
      const newValue = value.slice(0, start) + suggestion + value.slice(start);

      // Use the native setter + execCommand-style insert so frameworks (React, etc.)
      // that listen for 'input' events still see the change.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        "value"
      ).set;
      nativeSetter.call(el, newValue);
      const newPos = start + suggestion.length;
      el.setSelectionRange(newPos, newPos);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    clearSuggestion();
    return true;
  }

  function onKeyDown(e) {
    const el = document.activeElement;
    if (!el || el !== activeField || !activeSuggestion) return;

    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      acceptSuggestion(el);
    } else if (e.key === "Escape") {
      clearSuggestion();
    } else if (
      e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown"
    ) {
      // Cursor moved away from the suggestion point — drop it rather than show a stale one.
      clearSuggestion({ keepField: true });
    }
  }

  function onInput(e) {
    const el = e.target;
    if (!isEligibleField(el)) return;
    clearSuggestion({ keepField: true });
    requestCompletion(el);
  }

  function onFocusIn(e) {
    if (!isEligibleField(e.target)) return;
    activeField = e.target;
  }

  function onFocusOut(e) {
    if (e.target === activeField) clearSuggestion();
  }

  function onScrollOrResize() {
    if (activeField && activeSuggestion && !activeField.isContentEditable) {
      positionOverlayOnField(activeField);
      positionHintNearCaret(activeField);
    }
  }

  function onSelectionChange() {
    if (!activeField || !activeSuggestion) return;
    if (activeField.isContentEditable) return; // handled via ghost span itself
    const offsets = getCursorOffsets(activeField);
    // If the caret is no longer collapsed at the original point, drop the suggestion.
    if (!offsets) clearSuggestion({ keepField: true });
  }

  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("selectionchange", onSelectionChange, true);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize, true);
})();
