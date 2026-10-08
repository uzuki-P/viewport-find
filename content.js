// Find bar injected into the page by background.js.
//
// Performance notes:
// - Highlights use the CSS Custom Highlight API, so the page DOM is never
//   modified (no <mark> wrappers, no reflow of the page's layout).
// - Matches are StaticRanges, which cost nothing on later DOM mutations.
// - The text index (all visible text nodes joined into one string) is built
//   once and reused for every keystroke until the DOM changes.

(() => {
  if (window.__viewportFind) return;

  const MAX_MATCHES = 10000;
  const HL_ALL = "viewport-find-all";
  const HL_CURRENT = "viewport-find-current";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "IFRAME", "OBJECT",
    "TEXTAREA", "SELECT", "OPTION", "CANVAS", "VIDEO", "AUDIO",
  ]);
  // Text inside these tags joins its neighbour without a separator, so
  // "foo<b>bar</b>" matches "foobar" like Chrome's own find.
  const INLINE_TAGS = new Set([
    "A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DFN", "EM", "FONT",
    "I", "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG",
    "SUB", "SUP", "TIME", "U", "VAR", "DEL", "INS",
  ]);

  const state = {
    open: false,
    query: "",
    caseSensitive: false,
    skipViewport: false,
    followScroll: true,
    animate: true, // set on the options page
    index: null, // { nodes, starts, text }
    matches: [], // StaticRange[]
    capped: false,
    current: -1,
  };

  // ---------- UI ----------

  const host = document.createElement("viewport-find");
  host.hidden = true;
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; position: fixed; top: 8px; right: 16px; z-index: 2147483647; }
    :host([hidden]) { display: none; }
    .track { position: fixed; right: 0; pointer-events: none; }
    .track[hidden] { display: none; }
    .ping {
      position: fixed; pointer-events: none; border-radius: 3px;
      outline: 2px solid #ff9632; animation: ping .45s ease-out forwards;
    }
    @keyframes ping {
      from { outline-offset: 10px; opacity: 0; }
      40% { opacity: 1; }
      to { outline-offset: 0; opacity: 0; }
    }
    .ping.big { outline-width: 3px; animation: ping-big .8s ease-out forwards; }
    @keyframes ping-big {
      from { outline-offset: 40px; opacity: 0; box-shadow: 0 0 0 0 rgba(255,150,50,0); }
      25% { opacity: 1; }
      55% { outline-offset: 0; box-shadow: 0 0 0 6px rgba(255,150,50,.45); }
      to { outline-offset: 0; opacity: 0; box-shadow: 0 0 0 14px rgba(255,150,50,0); }
    }
    @media (prefers-reduced-motion: reduce) { .ping { display: none; } }
    .bar {
      position: relative; display: flex; align-items: center; gap: 2px;
      padding: 6px 6px 6px 12px; border-radius: 10px;
      font: 13px/1.2 system-ui, sans-serif;
      background: #fff; color: #1f1f1f;
      box-shadow: 0 2px 6px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06);
    }
    input {
      width: 200px; border: 0; outline: 0; background: transparent;
      font: inherit; color: inherit; padding: 4px 0;
    }
    .bar.none input { color: #c5221f; }
    .count { min-width: 48px; text-align: right; color: #5f6368; padding-right: 6px; font-variant-numeric: tabular-nums; }
    .sep { width: 1px; height: 20px; background: #dadce0; margin: 0 4px; }
    button {
      all: unset; box-sizing: border-box; width: 28px; height: 28px; border-radius: 50%;
      display: grid; place-items: center; cursor: pointer; color: #444746;
      font-size: 12px; font-weight: 600;
    }
    button:hover { background: rgba(0,0,0,.07); }
    button:disabled { opacity: .38; cursor: default; background: none; }
    button[aria-pressed="true"] { background: #d3e3fd; color: #0842a0; }
    svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    @media (prefers-color-scheme: dark) {
      .bar { background: #35363a; color: #e8eaed; box-shadow: 0 2px 6px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
      .bar.none input { color: #f28b82; }
      .count { color: #9aa0a6; }
      .sep { background: #5f6368; }
      button { color: #c4c7c5; }
      button:hover { background: rgba(255,255,255,.1); }
      button[aria-pressed="true"] { background: #004a77; color: #c2e7ff; }
    }
  `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `
    <div class="pings"></div>
    <div class="bar" role="search">
      <input type="text" placeholder="Find in page" spellcheck="false" autocomplete="off" aria-label="Find in page">
      <span class="count" aria-live="polite"></span>
      <span class="sep"></span>
      <button class="case" aria-pressed="false" title="Match case">Aa</button>
      <button class="skip" aria-pressed="false" title="Skip viewport: Next jumps past everything on screen">
        <svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="9" rx="2"/><path d="M12 15v6M9 18l3 3 3-3"/></svg>
      </button>
      <button class="follow" aria-pressed="true" title="Follow scroll: after you scroll away, Next and Previous start from the screen">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
      </button>
      <span class="sep"></span>
      <button class="prev"><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg></button>
      <button class="next"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      <button class="close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <canvas class="track" hidden></canvas>`;

  const $ = (sel) => root.querySelector(sel);
  const bar = $(".bar");
  const input = $("input");
  const countEl = $(".count");
  const caseBtn = $(".case");
  const skipBtn = $(".skip");
  const followBtn = $(".follow");
  const prevBtn = $(".prev");
  const nextBtn = $(".next");

  // Keep the page's own keyboard shortcuts from firing while typing here.
  for (const type of ["keydown", "keyup", "keypress"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  // Buttons should not steal focus from the input.
  root.addEventListener("mousedown", (e) => {
    if (e.target !== input) e.preventDefault();
  });

  let inputTimer = 0;
  input.addEventListener("input", () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      state.query = input.value;
      runSearch({ fromViewport: true });
    }, 40);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (input.value !== state.query) {
        clearTimeout(inputTimer);
        state.query = input.value;
        runSearch({ fromViewport: true });
      }
      // Ctrl/Cmd+Enter uses the other mode for a single press.
      const flip = e.ctrlKey || e.metaKey;
      step(e.shiftKey ? -1 : 1, state.skipViewport !== flip);
    }
  });

  prevBtn.addEventListener("click", () => step(-1, state.skipViewport));
  nextBtn.addEventListener("click", () => step(1, state.skipViewport));
  $(".close").addEventListener("click", close);
  caseBtn.addEventListener("click", () => {
    setSetting("caseSensitive", !state.caseSensitive);
    runSearch({ fromViewport: false });
  });
  skipBtn.addEventListener("click", () => setSetting("skipViewport", !state.skipViewport));
  followBtn.addEventListener("click", () => setSetting("followScroll", !state.followScroll));

  function renderSettings() {
    caseBtn.setAttribute("aria-pressed", String(state.caseSensitive));
    skipBtn.setAttribute("aria-pressed", String(state.skipViewport));
    followBtn.setAttribute("aria-pressed", String(state.followScroll));
    const unit = state.skipViewport ? "viewport" : "match";
    prevBtn.title = `Previous ${unit} (Shift+Enter)`;
    nextBtn.title = `Next ${unit} (Enter)`;
  }

  function setSetting(key, value) {
    state[key] = value;
    renderSettings();
    chrome.storage?.local.set({ [key]: value });
  }

  function renderCount() {
    const n = state.matches.length;
    const hasQuery = state.query.length > 0;
    countEl.textContent = hasQuery ? `${n ? state.current + 1 : 0}/${n}${state.capped ? "+" : ""}` : "";
    bar.classList.toggle("none", hasQuery && n === 0);
    prevBtn.disabled = nextBtn.disabled = n === 0;
  }

  // ---------- Text index ----------

  function buildIndex() {
    const visible = new Map();
    const isVisible = (el) => {
      let v = visible.get(el);
      if (v === undefined) {
        v = el.checkVisibility({ visibilityProperty: true });
        // display:contents has no box, so checkVisibility reports false.
        if (!v && el.parentElement && getComputedStyle(el).display === "contents") {
          v = isVisible(el.parentElement);
        }
        visible.set(el, v);
      }
      return v;
    };

    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            return SKIP_TAGS.has(node.nodeName) || node === host
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP;
          }
          return node.data.length && isVisible(node.parentElement)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      },
    );

    const nodes = [];
    const starts = [];
    const parts = [];
    let length = 0;
    let prevParent = null;
    for (let node; (node = walker.nextNode()); ) {
      const parent = node.parentElement;
      if (
        prevParent &&
        parent !== prevParent &&
        !INLINE_TAGS.has(parent.nodeName) &&
        !INLINE_TAGS.has(prevParent.nodeName)
      ) {
        parts.push("\n"); // block boundary
        length += 1;
      }
      nodes.push(node);
      starts.push(length);
      parts.push(node.data);
      length += node.data.length;
      prevParent = parent;
    }
    return { nodes, starts, text: parts.join("") };
  }

  function buildRegExp(query, caseSensitive) {
    const source = query
      .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    return new RegExp(source, caseSensitive ? "gu" : "giu");
  }

  // ---------- Search ----------

  function runSearch({ fromViewport }) {
    const prevCurrent = state.current;
    state.matches = [];
    state.capped = false;
    state.current = -1;

    if (state.query) {
      if (!state.index) state.index = buildIndex();
      const { nodes, starts, text } = state.index;
      const re = buildRegExp(state.query, state.caseSensitive);
      let j = 0;
      for (let m; (m = re.exec(text)); ) {
        if (state.matches.length === MAX_MATCHES) {
          state.capped = true;
          break;
        }
        const start = m.index;
        const end = start + m[0].length;
        // Node holding the first character. Separators sit between nodes,
        // so a start inside one moves to the following node.
        while (j + 1 < nodes.length && starts[j + 1] <= start) j++;
        let sj = j;
        let so = start - starts[sj];
        if (so >= nodes[sj].data.length && sj + 1 < nodes.length) {
          sj++;
          so = 0;
        }
        // Node holding the last character.
        let k = sj;
        while (k + 1 < nodes.length && starts[k + 1] <= end - 1) k++;
        const eo = Math.min(end - starts[k], nodes[k].data.length);
        state.matches.push(
          new StaticRange({
            startContainer: nodes[sj],
            startOffset: so,
            endContainer: nodes[k],
            endOffset: eo,
          }),
        );
      }
    }

    const all = new Highlight(...state.matches);
    CSS.highlights.set(HL_ALL, all);
    scheduleTrack(true);

    if (state.matches.length) {
      if (fromViewport) {
        // Like Chrome: start at the first match on or after the screen top.
        let first = state.matches.findIndex((r) => {
          const rect = rectOf(r);
          return !isEmpty(rect) && rect.bottom > 0;
        });
        const i = first === -1 ? 0 : first;
        // Typing pings only when the result moved the page.
        if (select(i, "center")) ping(state.matches[i], true);
      } else {
        select(Math.min(Math.max(prevCurrent, 0), state.matches.length - 1), null);
      }
    } else {
      CSS.highlights.delete(HL_CURRENT);
      renderCount();
    }
  }

  // ---------- Navigation ----------

  const probe = document.createRange();
  const EMPTY_RECT = new DOMRect();

  function rectOf(r) {
    try {
      probe.setStart(r.startContainer, r.startOffset);
      probe.setEnd(r.endContainer, r.endOffset);
      return probe.getBoundingClientRect();
    } catch {
      return EMPTY_RECT; // range went stale after a DOM change
    }
  }

  const isEmpty = (rect) => rect.width === 0 && rect.height === 0;

  function select(i, align) {
    state.current = i;
    const current = new Highlight(state.matches[i]);
    current.priority = 1;
    CSS.highlights.set(HL_CURRENT, current);
    const scrolled = align ? reveal(state.matches[i], align) : false;
    renderCount();
    scheduleTrack(false);
    return scrolled;
  }

  function step(dir, byViewport) {
    const n = state.matches.length;
    if (!n) return;
    if (byViewport) {
      const target = findOffscreen(dir);
      if (target !== -1) {
        select(target, dir > 0 ? "start" : "end");
        ping(state.matches[target], true);
        return;
      }
      // Everything fits on screen, so fall through to a single step.
    }
    const target = (origin(dir) + dir + n) % n;
    ping(state.matches[target], select(target, "center"));
  }

  // A ring that closes in on the match and fades, so the eye finds it after
  // a jump. Highlights cannot animate, so it is an overlay, one box per line.
  // big: the page scrolled, so the eye has further to search.
  const pings = $(".pings");
  function ping(r, big) {
    pings.replaceChildren();
    if (!state.animate) return;
    try {
      probe.setStart(r.startContainer, r.startOffset);
      probe.setEnd(r.endContainer, r.endOffset);
    } catch {
      return;
    }
    for (const rect of [...probe.getClientRects()].slice(0, 8)) {
      if (!rect.width || !rect.height) continue;
      const box = document.createElement("div");
      box.className = big ? "ping big" : "ping";
      box.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      box.addEventListener("animationend", () => box.remove());
      pings.append(box);
    }
  }

  // The index Next/Previous count from. With follow scroll on and the
  // current match scrolled off screen, that is the screen position instead:
  // Next counts from the last match above it, Previous from the first below.
  function origin(dir) {
    const n = state.matches.length;
    const none = dir > 0 ? -1 : n;
    if (state.current === -1) return none;
    if (!state.followScroll) return state.current;
    const rect = rectOf(state.matches[state.current]);
    if (isEmpty(rect) || (rect.bottom > 0 && rect.top < innerHeight)) return state.current;
    let from = none;
    for (let i = 0; i < n; i++) {
      const r = rectOf(state.matches[i]);
      if (isEmpty(r)) continue;
      if (dir > 0 && r.bottom <= 0) from = i;
      else if (dir < 0 && r.top >= innerHeight) return i;
    }
    return from;
  }

  // Next viewport: the first match after the current one that is not fully
  // on screen below. Previous viewport: the same, upwards. After wrapping
  // around the page end, any off-screen match qualifies.
  function findOffscreen(dir) {
    const n = state.matches.length;
    const h = innerHeight;
    const from = origin(dir);
    for (let k = 1; k <= n; k++) {
      const raw = from + dir * k;
      const wrapped = raw < 0 || raw >= n;
      const i = ((raw % n) + n) % n;
      const rect = rectOf(state.matches[i]);
      if (isEmpty(rect)) continue;
      const below = rect.bottom > h;
      const above = rect.top < 0;
      if (dir > 0 ? below || (wrapped && above) : above || (wrapped && below)) return i;
    }
    return -1;
  }

  function scrollParent(el) {
    for (let p = el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (
        /auto|scroll|overlay/.test(cs.overflowY + cs.overflowX) &&
        (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)
      ) {
        return p;
      }
    }
    return null;
  }

  // align: "center" scrolls only when the match is off screen;
  // "start"/"end" put the match near the top/bottom edge.
  // Returns whether anything scrolled.
  function reveal(r, align) {
    let scrolled = false;
    let el = r.startContainer.parentElement;
    for (let depth = 0; el && depth < 8; depth++) {
      const scroller = scrollParent(el);
      let top = 0;
      let bottom = innerHeight;
      let left = 0;
      let right = innerWidth;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      const height = bottom - top;
      const margin = Math.min(height * 0.1, 96);
      const rect = rectOf(r);
      if (isEmpty(rect)) return scrolled;

      let dy = 0;
      // The window's top edge must also clear the find bar.
      const startTop = scroller ? top + margin : Math.max(margin, bar.getBoundingClientRect().bottom + 12);
      if (align === "start") dy = rect.top - startTop;
      else if (align === "end") dy = rect.bottom - (bottom - margin);
      else if (rect.top < top || rect.bottom > bottom) dy = rect.top - (top + (height - rect.height) / 2);
      let dx = 0;
      if (rect.left < left || rect.right > right) dx = rect.left - (left + (right - left - rect.width) / 2);

      if (dx || dy) {
        (scroller || window).scrollBy({ top: dy, left: dx, behavior: "instant" });
        scrolled = true;
      }
      if (!scroller) return scrolled;
      el = scroller.parentElement;
    }
    return scrolled;
  }

  // ---------- Scrollbar markers ----------
  // Chrome gives pages no access to its own find tickmarks, so the bar draws
  // its own on a canvas laid over the window's scrollbar. Clicks pass through.

  const track = $(".track");
  const trackCtx = track.getContext("2d");
  const TICK = 2; // CSS px
  let tickYs = null; // document y of each match, NaN when it has no box
  let trackFrame = 0;

  function measureTicks() {
    tickYs = new Float64Array(state.matches.length);
    for (let i = 0; i < state.matches.length; i++) {
      const rect = rectOf(state.matches[i]);
      tickYs[i] = isEmpty(rect) ? NaN : rect.top + scrollY;
    }
  }

  function windowScrolls() {
    const doc = document.documentElement;
    const scroller = document.scrollingElement || doc;
    if (scroller.scrollHeight <= doc.clientHeight) return false;
    // overflow on <body> applies to the window only when <html> leaves it visible.
    const htmlY = getComputedStyle(doc).overflowY;
    const y = htmlY === "visible" && document.body ? getComputedStyle(document.body).overflowY : htmlY;
    return !/hidden|clip/.test(y);
  }

  function drawTrack() {
    trackFrame = 0;
    if (!state.open || !state.matches.length || !windowScrolls()) {
      track.hidden = true;
      return;
    }
    if (!tickYs) measureTicks();

    const doc = document.documentElement;
    const barWidth = innerWidth - doc.clientWidth;
    // Overlay scrollbars take no space, so use a thin strip at the edge.
    const width = barWidth > 0 ? barWidth : 10;
    // Classic scrollbars have square arrow buttons at both ends; the thumb
    // moves between them, so the ticks do too.
    const inset = barWidth > 0 ? barWidth : 0;
    const height = Math.max(doc.clientHeight - 2 * inset, 1);
    const dpr = devicePixelRatio || 1;

    track.hidden = false;
    track.style.top = `${inset}px`;
    track.style.width = `${width}px`;
    track.style.height = `${height}px`;
    track.width = Math.round(width * dpr); // resizing also clears the canvas
    track.height = Math.round(height * dpr);
    trackCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const scale = height / (document.scrollingElement || doc).scrollHeight;
    const rowOf = (y) => Math.min(Math.max(Math.round(y * scale), 0), Math.ceil(height) - TICK);
    // One tick per pixel row, however many matches share it.
    const rows = new Uint8Array(Math.ceil(height) + 1);
    for (let i = 0; i < tickYs.length; i++) {
      if (i !== state.current && !Number.isNaN(tickYs[i])) rows[rowOf(tickYs[i])] = 1;
    }

    const paint = (row, fill) => {
      trackCtx.fillStyle = "rgba(0,0,0,.45)";
      trackCtx.fillRect(1, row - 1, width - 2, TICK + 2);
      trackCtx.fillStyle = fill;
      trackCtx.fillRect(2, row, width - 4, TICK);
    };
    for (let row = 0; row < rows.length; row++) if (rows[row]) paint(row, "#ffff00");
    const cur = tickYs[state.current];
    if (cur !== undefined && !Number.isNaN(cur)) paint(rowOf(cur), "#ff9632");
  }

  // remeasure: match positions changed, not just the current match.
  function scheduleTrack(remeasure) {
    if (remeasure) tickYs = null;
    if (!trackFrame) trackFrame = requestAnimationFrame(drawTrack);
  }

  const onLayoutChange = () => scheduleTrack(true);
  const layoutObserver = new ResizeObserver(onLayoutChange);

  // ---------- Live updates ----------

  let refreshTimer = 0;
  const observer = new MutationObserver((records) => {
    if (records.every((rec) => rec.target === host)) return;
    state.index = null;
    // Attribute changes can hide or show text, so they invalidate the index,
    // but only content changes trigger an automatic re-search.
    if (state.query && records.some((rec) => rec.type !== "attributes")) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => runSearch({ fromViewport: false }), 300);
    }
  });

  // ---------- Open / close ----------

  function open() {
    if (!host.isConnected) document.documentElement.append(host);
    const selected = String(getSelection() ?? "").trim();
    if (selected && selected.length < 200 && !selected.includes("\n")) input.value = selected;
    host.hidden = false;
    state.open = true;
    state.index = null;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open"],
    });
    layoutObserver.observe(document.documentElement);
    addEventListener("resize", onLayoutChange);
    input.focus();
    input.select();
    state.query = input.value;
    runSearch({ fromViewport: true });
  }

  function close() {
    const r = state.matches[state.current];
    observer.disconnect();
    layoutObserver.disconnect();
    removeEventListener("resize", onLayoutChange);
    cancelAnimationFrame(trackFrame);
    trackFrame = 0;
    tickYs = null;
    track.hidden = true;
    pings.replaceChildren();
    clearTimeout(inputTimer);
    clearTimeout(refreshTimer);
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CURRENT);
    state.open = false;
    state.matches = [];
    state.index = null;
    host.hidden = true;
    // Leave the current match selected, as Chrome does.
    if (r) {
      try {
        getSelection().setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset);
      } catch {}
    }
  }

  // Opens the bar, or focuses it when already open, like the browser's Ctrl+F.
  function show() {
    if (!state.open) return open();
    input.focus();
    input.select();
  }

  function toggle() {
    if (state.open && root.activeElement === input) close();
    else show();
  }

  window.__viewportFind = { toggle, show };

  renderSettings();
  open();
  chrome.storage?.local.get(["caseSensitive", "skipViewport", "followScroll", "animate"]).then((saved) => {
    const caseChanged = saved.caseSensitive !== undefined && saved.caseSensitive !== state.caseSensitive;
    if (saved.caseSensitive !== undefined) state.caseSensitive = saved.caseSensitive;
    if (saved.skipViewport !== undefined) state.skipViewport = saved.skipViewport;
    if (saved.followScroll !== undefined) state.followScroll = saved.followScroll;
    if (saved.animate !== undefined) state.animate = saved.animate;
    renderSettings();
    if (caseChanged && state.query) runSearch({ fromViewport: true });
  });
  // The options page can change this while the bar is open.
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.animate) state.animate = changes.animate.newValue !== false;
  });
})();
