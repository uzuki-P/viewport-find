# Viewport Find

A Chrome extension (Manifest V3) for find in page. It works like Chrome's find bar, plus an optional mode where Next jumps past every match already on screen.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click "Load unpacked" and pick this folder.
3. Press `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS) or click the toolbar icon. Change the shortcut at `chrome://extensions/shortcuts`.

### Use Ctrl+F

The extension has a second command, "Open or focus the find bar", with no default key. Chrome won't let an extension claim a browser shortcut by default, so you assign it yourself. In Brave, open `brave://extensions/shortcuts` and set that command to `Ctrl+F`. Pressing it again while the bar is open selects the query text, as the browser's find does. It never closes the bar.

The browser's own find stays reachable from the menu. Pages that refuse injection, such as `brave://` pages, the Web Store, and the PDF viewer, won't open any find bar on `Ctrl+F`.

## Keys

| Key | Action |
| --- | --- |
| `Enter` / `Shift+Enter` | Next / previous, in the current mode |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` | Next / previous in the other mode, once |
| `Esc` | Close and leave the current match selected |

The bar has three toggles, and all of them persist:

- `Aa` turns on match case.
- The screen-with-arrow button turns on skip viewport.
- The crosshair button turns on follow scroll, which is on by default. If you scroll so the current match leaves the screen, Next starts from the first match on or below the screen, and Previous from the last match on or above it. Turn it off to make Next always continue from the current match and scroll back to it, as Chrome's find does.

When Next or Previous moves to a match, an orange ring closes in on it and fades. A move that stays on screen gets a thin ring over 0.45 s. A move that scrolls the page, including a skip viewport jump, gets a thicker ring that starts wider, glows, and lasts 0.8 s. Typing shows the large ring only when the new result scrolls the page. No ring shows when the system asks for reduced motion. To turn it off yourself, right-click the toolbar icon, choose Options, and clear "Animate the current match". The change applies to open find bars too.

## Scrollbar markers

Chrome doesn't let pages or extensions draw on its find tickmarks, so the bar draws its own. A canvas sits over the window's scrollbar, with a yellow tick for each match and an orange tick for the current one. Clicks pass through it to the scrollbar. With overlay scrollbars, which take no space, it draws a 10px strip at the right edge.

The markers track window scrolling only. A match inside a nested scroll container gets a tick at that container's place on the page.

## Skip viewport mode

Next selects the first match after the current one whose bottom edge is below the screen, then scrolls it to about 10% from the top, and always below the find bar. Every match you skip was fully visible, so a cut-off match at the bottom edge becomes the next target. Previous does the reverse and places the match near the bottom. If all matches fit on screen, the buttons step one match at a time.

## Performance

- The bar is injected only when you open it (`activeTab` + `scripting`), so other pages run no code.
- Highlights use the CSS Custom Highlight API. The extension never inserts `<mark>` elements or changes page layout.
- Matches are `StaticRange` objects, which add no cost to the page's DOM mutations.
- Visible text is indexed once and reused for every keystroke. DOM changes clear the index, and content changes trigger a re-search after 300 ms.
- Results stop at 10,000 matches.
- Scrollbar markers measure each match once per search and again when the page resizes. At 10,000 matches that takes about 65 ms. Changing the current match only repaints the canvas.

## Limits

It searches only the top frame. Open shadow roots, form field values, and closed `<details>` stay unsearched. It cannot run on `chrome://` pages or the Chrome Web Store.

## Test

```sh
NODE_PATH=/path/to/node_modules CHROME=/path/to/chromium node test/run.cjs
```

`test/page.html` also works for manual testing.

## License

[MIT](LICENSE)
