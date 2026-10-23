# Changelog

## 2.0.0 — 2026-10-23

First public release.

- Restores a compact prompt-based table of contents at ChatGPT's right edge.
- Supports conversations from the first submitted text prompt, with a bounded, independently scrollable contents panel.
- Tracks the current section with a discrete active pill.
- Indexes the active conversation's user prompts without an initialization scroll sweep.
- Navigates mounted turns directly and uses ChatGPT's native target route for unmounted history.
- Retains complete prompt text while keeping previews compact.
- Validates paginated data, preserves confirmed progress, and supports bounded transient recovery and cancellation.
- Handles SPA route changes, repeated initialization, keyboard focus, and Unicode joiners.
- Includes the standalone installer, a matching text mirror, MIT license, and 44 regression tests.
