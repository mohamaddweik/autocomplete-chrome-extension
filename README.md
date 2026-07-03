# AI Autocomplete — Inline Text Copilot for Chrome

A Chrome Extension (Manifest V3) that brings AI-powered inline text autocomplete — like Cursor/Copilot, but for prose — to **any** text field on the web: blog editors, forms, comment boxes, email composers, and `contenteditable` rich-text areas.

<p align="center">
  <em>Type in any textarea → see a gray "ghost" suggestion → press Tab to accept, Esc to dismiss.</em>
</p>

---

## Features

- **Inline ghost-text completions** while typing, rendered in-place at the cursor
- **Tab to accept**, **Esc to dismiss**
- Works on `<textarea>`, text-like `<input>` (`text`, `search`, `email`, `url`, `tel`), and `contenteditable` elements
- Debounced requests (350ms) + response caching to minimize latency and API cost
- Handles scrolling, resizing, focus changes, and stale/out-of-order responses safely
- Dispatches native `input` events so frameworks (React, Vue, etc.) still see accepted text
- Provider-agnostic backend: works with OpenAI or Anthropic — switch in the popup

## Demo flow

1. Click the extension icon → paste your API key → Save
2. Go to any site with a text box (a blog editor, Gmail, a comment field)
3. Start typing at least a few characters
4. A gray suggestion appears after a short pause — press **Tab** to accept it inline

---

## Installation (local / unpacked)

1. Clone this repo:
   ```bash
   git clone https://github.com/<your-username>/ai-autocomplete-extension.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the cloned project folder
5. Click the extension icon in the toolbar, choose a provider, paste your API key, and **Save**

No build step required — this is plain JS/HTML/CSS, so "load unpacked" works directly.

---

## Architecture

```
manifest.json     Manifest V3 config: permissions, content script, background worker
background.js     Service worker — owns the API key, calls OpenAI/Anthropic, caches responses
content.js        Injected into every page/frame — detects fields, renders ghost text,
                   handles Tab/Esc, syncs scroll/position
content.css       Styling for the ghost-text overlay and "Tab to accept" hint badge
popup.html/js/css Settings UI for provider, model, and API key (stored via chrome.storage.sync)
```

### Why a background service worker?

Content scripts run in the context of the visited web page. Anything they hold — including
an API key — is closer to page-controlled JavaScript than we'd like. The background service
worker is isolated from the page, so `content.js` only ever sends `{ textBeforeCursor, textAfterCursor }`
via `chrome.runtime.sendMessage` and gets back plain suggestion text. The API key never enters
the page's execution context.

### Rendering ghost text: two different techniques

**`<textarea>` / `<input>` (native form controls) can't render mixed-color inline text** — they're
plain-text controls. So the extension uses the classic **mirror-div technique**:

- An absolutely-positioned `<div>` is layered exactly on top of the real field (same
  `left/top/width/height`, and every layout-relevant computed style — font, padding, border,
  line-height, letter-spacing, white-space, box-sizing — copied 1:1).
- The mirror renders the *already-typed* text in `transparent` (so it lines up invisibly with
  the real text underneath) followed by the AI suggestion in gray.
- Because font metrics are identical, the gray suggestion appears to continue exactly from the
  real cursor position, even though it's technically a separate DOM node.
- The mirror's `scrollTop`/`scrollLeft` are kept in sync with the real field on every scroll/resize.

**`contenteditable` elements can hold rich, styled child nodes**, so there we take a simpler and
more precise approach: insert an actual `<span class="ai-ac-inline-ghost">` node at the caret
via the `Range`/`Selection` API, styled gray and `pointer-events: none`. It's removed the moment
the suggestion is accepted, dismissed, or the caret moves.

### Accepting a suggestion without breaking undo/redo or frameworks

- For `contenteditable`, we use `document.execCommand("insertText", …)`, which — despite being
  a legacy API — is still the most reliable way to insert text while preserving the browser's
  native undo stack.
- For `<textarea>`/`<input>`, we call the value setter through
  `Object.getOwnPropertyDescriptor(...).set` (the *native* prototype setter) rather than
  `el.value = …` directly. Many frameworks (React in particular) override the `value` property
  with their own setter that doesn't always propagate correctly; calling the native setter and
  then manually dispatching an `input` event ensures both native pages and framework-driven
  pages see the change and update their own state.

### Avoiding breakage on existing sites

- All listeners are added at the `document` level with `capture: true`, so we don't have to
  mutate individual page elements.
- `Tab`/`Escape` are only intercepted (`preventDefault`) when a suggestion is actively showing
  for the focused field — otherwise all native keyboard behavior (including a site's own Tab
  navigation) passes through untouched.
- The overlay/ghost nodes are `pointer-events: none`, so they never intercept clicks or block
  scrolling/selection on the underlying page.
- Suggestions only trigger on a **collapsed** caret (no active text selection), so we never
  interfere with select-and-replace or select-and-copy flows.

### Latency mitigation

- 350ms debounce so we don't fire a request per keystroke
- An in-memory LRU-ish cache (last 200 prefixes) in the background worker, so retyping/backspacing
  over the same prefix reuses a prior response instead of re-calling the API
- A monotonically increasing request token discards any API response that arrives after a newer
  keystroke has already superseded it (prevents "flickering" stale suggestions)
- Small `max_tokens` cap (default 40) keeps model latency low, since we only need short-phrase
  completions, not full paragraphs

---

## Skills used

- Chrome Extensions (Manifest V3): service workers, content scripts, `chrome.storage`,
  message passing (`chrome.runtime.sendMessage`/`onMessage`)
- Vanilla JavaScript DOM APIs: `Range`/`Selection`, `MutationObserver`-adjacent event handling,
  native property descriptors for framework-safe input simulation
- CSS layout replication (the mirror-div caret technique)
- LLM prompt design for short, low-latency, non-repeating completions
- REST integration with both the OpenAI and Anthropic Messages APIs
- Debouncing, caching, and race-condition handling in async UI code

## Challenges overcome

- **Cursor-accurate ghost text in native inputs**: `<textarea>`/`<input>` have no concept of
  inline-styled text, so pixel-perfect suggestion placement required precisely mirroring every
  layout-relevant CSS property rather than just font-size.
- **Stale suggestions**: fast typists could trigger multiple in-flight requests; solved with a
  request-token guard and a "does the current caret prefix still match what we asked about"
  check before ever rendering a response.
- **Framework compatibility**: naively setting `.value` silently fails to notify React-controlled
  inputs. Using the native setter + manually dispatched `input` event fixed this without needing
  per-site special-casing.
- **Not breaking existing site behavior**: solved by scoping all key interception to only fire
  when a suggestion is visible, and keeping all injected DOM `pointer-events: none`.

## Future iterations

- Multi-line/paragraph-aware completions with a "keep expanding" gesture (hold Tab)
- Streaming completions token-by-token instead of waiting for the full response
- Per-site enable/disable toggle and a keyboard shortcut to force-trigger a suggestion
- Local/on-device small model fallback for zero-latency, offline suggestions
- Smarter context gathering (e.g., page title, surrounding form labels) for more relevant completions
- Visual diffing so multi-word suggestions can be partially accepted word-by-word (like Cursor's `Ctrl+→`)

---

## Tech stack

Plain JavaScript, HTML, CSS — Manifest V3 Chrome Extension APIs — OpenAI / Anthropic REST APIs. No build tooling required.
