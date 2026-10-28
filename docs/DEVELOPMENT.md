# Development and release checks

`ChatGPT_Conversation_Table_of_Contents.user.js` is the authoritative standalone
source. The `.txt` fallback is an identical copy attached to each GitHub release,
not a separately maintained implementation. Keep the existing userscript name
and namespace when updating, so installations retain their identity.

## Required checks

Use Node.js 20 or newer. The main suite requires only built-in Node modules and
uses isolated DOM/network/focus fixtures; it does not contact ChatGPT.

```sh
node --check ChatGPT_Conversation_Table_of_Contents.user.js
node --test tests/toc.test.cjs
cp ChatGPT_Conversation_Table_of_Contents.user.js ChatGPT_Conversation_Table_of_Contents.txt
cmp ChatGPT_Conversation_Table_of_Contents.user.js ChatGPT_Conversation_Table_of_Contents.txt
```

The 2.1.3 release passed all 92 fixture tests and source syntax checks. Its source
and attached `.txt` installer were checked for byte equality. Fixtures cover
matching, extraction, pagination/recovery, active-section mapping, navigation,
search cancellation, Unicode ranges, preview selection, input/focus lifecycle,
route switching and teardown.

These checks do not establish live browser layout, pointer hit testing,
transition timing or compatibility with every browser/userscript manager.
Inspect the installed script in dark/light themes and representative desktop
sizes before changing presentation. Use a read-only conversation for navigation
checks; appending/editing behavior can be exercised separately in the fixture.

## Optional UI fixture

```sh
node tests/build-browser-fixture.cjs
```

This generates `tests/browser-fixture.html` from the current userscript, replacing
only its application bootstrap with sample data. Open it in a local browser to
inspect dark/light themes, search, long lists, clearing, appending and editing
fixture prompts. It makes no account/network calls. Its selection callback
reports a message ID; it does not simulate live ChatGPT mounting or routing.
Do not commit the generated HTML as another copy of the userscript source.

## Optional performance and font checks

```sh
node tests/search-benchmark.cjs
```

This measures local search work and cancellation under synthetic workloads.
It excludes browser DOM construction, layout and paint.

`tests/preview-metrics.cjs` needs `@napi-rs/canvas` **0.1.100** and regular/bold
DejaVu Sans/Serif font files. These are development-only dependencies; the
userscript has none. Supply the module/font directories explicitly if needed:

```sh
TOC_CANVAS_MODULE=/absolute/path/to/node_modules/@napi-rs/canvas \
TOC_FONT_DIR=/absolute/path/to/dejavu \
node tests/preview-metrics.cjs
```

It performs 48 native-font layout checks and generates a typography proof plus
measurement results. Those samples inspect the actual excerpt planner with an
independent word/glyph placement pass. They are not browser screenshots or a
replacement for live installation checks. The static-font harness maps normal
weight 440 to 400 because this canvas version misparses non-hundred weights;
production browser typography is unchanged. The 48 samples passed during the
2.1.2 preview rework; the 2.1.3 changes do not modify that planner.

## Change ownership

- `CONFIG`: existing panel/rail geometry and conversation-load policy.
- `SEARCH`: matching thresholds, local hover width, coalescing and presentation timing.
- `PromptSearch`: local indexing, normalization, prefix/typo matching and cancellation.
- `searchPreview`: continuous context selection for compact search results.
- `TocView`: namespaced shadow DOM, native-font measurements, focus/search sessions,
  rendering and owned resources.
- Conversation, DOM and navigation adapters: host-specific endpoints, IDs,
  semantic selectors, active branch and mounted/native targeting.

Retain the default collapsed view, independent panel scrolling, immediate typing
and no initialization scroll traversal. Use shared values for field-extension
and placeholder timing; reduced motion must remove both. Regenerate the release
text copy and optional fixture after editing the source, then tag the exact
checked commit and attach the matching installers. Avoid committing generated
test images, timing output or the complete fixture HTML unless a particular
diagnostic artifact is needed for a change.
