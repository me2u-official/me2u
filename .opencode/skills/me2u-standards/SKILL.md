---
name: me2u-standards
description: >
  Use when working on me2u (WebRTC P2P file sharing app) or any project
  requiring professional code quality and UI/UX standards. Covers the
  pre-deploy checklist, code review standards, and design principles the
  user taught through direct feedback.
---

# me2u — Professional Standards and Workflow

## Core Lesson: Never Push Without Validation

The user's #1 rule: **Before deploying, pushing, or committing code, check for bugs first.** Do not write code, assume it works, and push. Every change must be verified.

### Pre-commit / Pre-deploy Checklist (in order)

1. **Read your own code.** Open every changed file and re-read it carefully. Do not skip this step.
2. **Trace the logic.** Walk through every code path as if you were the computer. Follow the data flow for at least 2-3 scenarios (e.g., single file, 3 files, connection drop and reconnect).
3. **Verify element IDs.** Every `getEl()`, `setText()`, `document.getElementById()` ID must exist in the HTML. Grep both sides and cross-reference.
4. **Check bracket/brace balance.** Verify `{ }`, `( )`, `[ ]` are balanced.
5. **Review for race conditions.** Look for:
   - Async functions with `await` — what happens if another event fires during the await?
   - setTimeout callbacks that might conflict with later code
   - Event handlers that could fire in unexpected order
6. **Review state resets.** When transitioning between states (file 1 → file 2, send → receive), are all state variables properly reset? A stale value from a previous state is a bug.
7. **Check error paths.** What happens when a connection drops, a file read fails, or a write fails? Is the user informed?
8. **Run the test suite.** If tests exist, run them. If not, the code is untested.

## Professional Code Standards

### Code must not have "stupid" bugs

- No `classList.remove()` without arguments (does nothing)
- No variables used after they should have been reset
- No element ID mismatches between JS and HTML
- No dead code that runs but has no effect
- No race conditions in async flows

### Defensive coding

- Validate inputs at boundaries (sanitise filenames, check file sizes)
- Handle missing DOM elements gracefully (`if (el) ...`)
- Use `try/catch` around async operations (file reads, disk writes, network sends)
- Provide fallback paths when modern APIs aren't available

### Code clarity

- Use `'use strict'`
- Meaningful function and variable names
- Comments explaining _why_ (not what — the code shows what)
- Group related functions together with section comments
- Consistent formatting and naming

## Professional UI/UX Standards

### The UI must appeal to a new generation AND be understandable to an older generation

- **New generation expects:** smooth animations, dark mode, gradient colors, particle effects, clean typography, emoji icons, PWA (installable), native share API, QR codes
- **Older generation expects:** clear labels, visible buttons with recognizable text, obvious next steps, status messages that explain what's happening

### UI principles

- **Progressive disclosure:** Show only what's needed at each step. Don't overwhelm.
  - Select files → generate link → wait for receiver → show progress → show success
  - Enter code → connect → accept file → show progress → show success
- **Clear status at every step:** Never leave the user wondering "what's happening?" Show status messages (ℹ️, ✅, ⚠️, ❌) at every stage.
- **Responsive:** Works on mobile and desktop. Larger touch targets on mobile. Desktop gets more detail.
- **Accessible:** ARIA labels, semantic HTML, proper focus management, role attributes.
- **Visual feedback:** Progress bars animate, status dots change color, buttons disable during active transfers.
- **Error recovery:** If something goes wrong, tell the user what happened AND what to do next. "Connection lost. Keep this tab open; the receiver can reconnect to resume the transfer."

### Design language (me2u-specific)

- Dark theme: background `#07080f`, gradient accents (purple `#6c63ff`, cyan `#00d4ff`, pink `#ff2d78`, green `#00ff9d`)
- Animated particle mesh background
- Card-based layout with subtle glassmorphism
- Gradient text for brand name
- Emoji + text for file type icons (not just text, not just emoji — both)
- Security badges as trust signals

## me2u Architecture Reference

### File structure

- `index.html` — Single-page app with send/receive panels and ad slots
- `app.js` — Core logic: PeerJS WebRTC, chunked transfer, multi-file queue, PWA registration
- `styles.css` — Dark theme CSS with animations
- `manifest.json` — PWA manifest (standalone display, SVG icon)
- `sw.js` — Service worker (cache-first for static assets)
- `icon.svg` — SVG app icon and favicon
- `server/server.js` — PeerJS signaling server (Render)
- `server/package.json` — `peer` dependency
- `.github/workflows/deploy.yml` — CI: `npm install` + `npm test` in `server/`
- `vercel.json` — Static site config for Vercel
- `render.yaml` — Render web service definition

### Data flow (multi-file send)

```
startSending(conn)
  → sendNextFileMeta(conn)        // send metadata for file[currentFileIndex]
    → conn.send({type: 'meta', ...})
  → sender waits for 'ack-accept'
  → beginChunking(conn, offset)   // read file in 64KB chunks
    → conn.send({type: 'chunk', data: ...})
  → receiver sends 'ack-done'
  → markSendComplete(conn)
    → currentFileIndex++
    → if more: sendNextFileMeta(conn)
    → if done: allFilesSent(conn)
```

### Key state variables

- `state.files[]` — selected files (sender)
- `state.currentFileIndex` — which file is being sent
- `state.receivedBytes / state.sentBytes` — progress tracking
- `state.totalBytes` — current file size
- `state.writableStream` — File System Access API handle
- `state.fallbackChunks[]` — in-memory buffer when FSA is unavailable
- `state.isPausedByReceiver` — backpressure from receiver
- `state.pendingWritesCount` — disk write queue depth

### Critical gotchas (learned the hard way)

- `state.receivedBytes` must be reset to 0 after each file completes, or the next file's meta handler enters the reconnection path instead of the new-file path
- Auto-hide timeouts must account for the next message arriving before the timer fires
- Service worker cache list must include ALL static assets (including icons)
- The `classList.remove()` method requires an argument — calling it without one silently does nothing
- When showing sequential status messages, don't overwrite a detailed message with a generic one
