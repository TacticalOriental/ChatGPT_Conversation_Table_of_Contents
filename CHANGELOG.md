# Changelog

## 2.1.3 — 2026-10-27

Adds optional prompt search while keeping the familiar indicator and contents panel as the default. This release includes the search refinements developed in the 2.1 test builds.

- Reveal Search Prompts from the small magnifier beneath the panel.
- Search progressively from two searchable characters, including partial words and punctuation/spacing variations, with conservative spelling tolerance.
- Keep results chronological, preserve the panel's height, and highlight matches in adaptive two-line previews without duplicated introductions.
- Extend the search field leftward with immediate typing; show its placeholder after the extension finishes.
- Retract an unused empty field independently of the main panel; retain a typing session until the TOC closes.
- Make the magnifier easier to reach with a larger local hover target, preserving the visible icon's size and position.
- Preserve keyboard/IME input, focus restoration, reduced-motion preferences, wheel browsing and existing navigation.
- Keep search local to the prompt index, with no additional search requests or initialization scroll sweep.
- Expand the fixture regression suite from 44 to 92 cases and include optional search/preview development checks.
- Add the search screenshot and update installation, usage and development documentation.

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

