# Paper

A local-first notepad. Open it, start writing. No accounts, no server, no build step —
three files and the browser.

## Run it

Any static server works:

    npx serve paper        # or: python3 -m http.server --directory paper

Opening `index.html` directly off disk works in Safari, but Chrome restricts
`localStorage` on `file://` URLs, so notes may not persist there. Use a server.

## Where notes live

Everything is one JSON blob in `localStorage` under the key `paper.v1` — notes, folders,
which tabs are open, which one is active. It never leaves the machine, and it is scoped
to the origin you serve from, so keep the port stable if you want to keep your notes.

`Export` writes that blob to a file; `Import` replaces everything with one. That is the
backup story, and it is also the escape hatch — the format is plain readable JSON.

localStorage caps out around 5 MB, which is a few hundred pages of text. If you ever hit
it, saving fails loudly in the word-count line rather than silently losing work.

## How it works

- **Titles are not a thing you type.** The first line of a note is its title, everywhere
  it appears — sidebar, tab. No naming dialogs, no `Untitled (3)`.
- **Tabs** hold what you have open. Closing a tab does not delete the note; the `×` in
  the sidebar does, and asks first.
- **Folders** are one level deep, on purpose. Drag a note onto a folder to move it.
  Double-click a folder to rename it.
- **Autosave** runs 400 ms after you stop typing, and on blur, tab switch, and close.

## Formatting

Bold, italic, underline, strikethrough, heading, bulleted and numbered lists, blockquote.
`⌘B` / `⌘I` / `⌘U` work as you'd expect. Paste is always stripped to plain text, which
keeps the stored HTML clean.

| Shortcut | |
|---|---|
| `⌘⇧N` | New note (in the current folder) |
| `⌘⇧W` | Close tab |
| `⌘\` | Show/hide sidebar |
| `⌘S` | Force a save — unnecessary, but the fingers want it |

## Layout

The format buttons sit top right, the word count is centred along the bottom, and the
sidebar toggle is the stack-of-rules button in the top left corner — it stays put whether
the sidebar is open or closed, so there is always a way back.

New note and new folder are the two icons beside the wordmark, top of the sidebar.
Export and import are the arrows at the very bottom.

Four controls sit at the foot of the sidebar, and all of them persist:

| | |
|---|---|
| `Theme` | `Auto / Light / Dark`. Auto follows the OS and switches live if the OS does. |
| `Color` | `Paper` warm cream and clay · `Mono` greyscale, zero hue · `White` clean white with one blue. |
| `Width` | Writing column: `Narrow` 620px, `Normal` 720px, `Wide` 880px. |
| `Size` | Body text: `Small` 16px, `Medium` 18px, `Large` 20px. |

Colour and theme are **independent axes** — each of the three palettes has its own light
and dark pair, so all six combinations are real. In CSS that's `data-palette` and
`data-theme` on `:root`; every dark rule is scoped to its palette so the two selectors
can't tie on specificity and fall through to source order.

Width and size are just the `--measure` and `--text-size` custom properties on `:root`,
so if you want values other than the three presets, edit the `WIDTHS` and `SIZES` maps at
the top of the appearance section in `app.js`. Headings and the note title are sized in
`em`, so they scale with whatever you pick rather than drifting out of proportion.

The theme is resolved by a short inline script in `<head>` before first paint, so opening
a dark-themed Paper never flashes white.

## Files

    index.html   structure
    style.css    the whole design system, light and dark
    app.js       ~460 lines, no dependencies
