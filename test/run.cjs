// Smoke test: loads content.js into the test page with a stubbed chrome API,
// then checks counting, per-match stepping, viewport skipping, and speed.
// Usage: NODE_PATH=/path/to/node_modules [CHROME=/path/to/chrome] node test/run.cjs
const path = require("path");
const { chromium } = require("playwright-core");

const ext = path.resolve(__dirname, "..");
const assert = (cond, msg) => {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok -", msg);
};

(async () => {
  // 1. The real extension loads and its service worker starts.
  const ctx = await chromium.launchPersistentContext("", {
    headless: true,
    executablePath: process.env.CHROME || undefined,
    channel: process.env.CHROME ? undefined : "chromium",
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  assert(sw.url().endsWith("/background.js"), "extension service worker starts");

  // 2. Content script behaviour.
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto("file://" + path.join(__dirname, "page.html"));
  await page.addStyleTag({ path: path.join(ext, "highlight.css") });
  await page.evaluate(() => (window.chrome = window.chrome || {}));
  await page.addScriptTag({ path: path.join(ext, "content.js") });

  const info = () =>
    page.evaluate(() => {
      const all = [...(CSS.highlights.get("viewport-find-all") || [])];
      const cur = [...(CSS.highlights.get("viewport-find-current") || [])][0];
      const r = cur && new Range();
      if (r) {
        r.setStart(cur.startContainer, cur.startOffset);
        r.setEnd(cur.endContainer, cur.endOffset);
      }
      const rect = r?.getBoundingClientRect();
      return {
        total: all.length,
        index: all.indexOf(cur),
        text: r?.toString(),
        top: rect?.top,
        bottom: rect?.bottom,
        scrollY: Math.round(scrollY),
        h: innerHeight,
      };
    });
  const type = async (q) => {
    await page.keyboard.press("Control+A");
    await page.keyboard.type(q);
    await page.waitForTimeout(120);
  };

  await type("target");
  let s = await info();
  assert(s.total === 200 * 4, `counts visible matches only (got ${s.total})`);
  assert(s.index === 0 && s.text === "Target", "first match is current");

  await type("foobar");
  assert((await info()).total === 2, "matches across inline elements (foo<b>bar</b> plus the quoted text)");

  await type("lorem    ipsum");
  assert((await info()).total > 0, "whitespace in query matches any whitespace run");

  await type("target");
  await page.keyboard.press("Enter");
  s = await info();
  assert(s.index === 1 && s.scrollY === 0, "Enter steps one match without scrolling when visible");

  // Turn on skip-viewport via Ctrl+Enter (one-off) and check the jump.
  const before = s;
  await page.keyboard.press("Control+Enter");
  s = await info();
  assert(s.index > before.index + 1, `Ctrl+Enter skips matches on screen (${before.index} -> ${s.index})`);
  assert(s.top >= 0 && s.top < s.h * 0.2, `target lands near the top (top=${Math.round(s.top)})`);

  // Scrollbar markers. The canvas lives in a closed shadow root, which only
  // CDP can reach.
  const cdp = await ctx.newCDPSession(page);
  const callOnBarNode = async (match, functionDeclaration, session = cdp) => {
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const find = (n) => match(n) ? n : (n.children || []).concat(n.shadowRoots || []).map(find).find(Boolean);
    const { object } = await session.send("DOM.resolveNode", { backendNodeId: find(root).backendNodeId });
    const { result } = await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration,
    });
    return result.value;
  };
  const clickBarButton = (cls) =>
    callOnBarNode(
      (n) => n.localName === "button" && (n.attributes || []).join(" ").includes(cls),
      "function () { this.click(); return this.getAttribute('aria-pressed'); }",
    );
  const readTrack = async () => {
    await page.evaluate(() => new Promise(requestAnimationFrame));
    return callOnBarNode(
      (n) => n.localName === "canvas",
      `function () {
        if (this.hidden) return { hidden: true };
        const { data } = this.getContext("2d").getImageData(0, 0, this.width, this.height);
        const x = Math.floor(this.width / 2) * 4;
        let yellow = 0, orange = -1;
        for (let y = 0; y < this.height; y++) {
          const p = y * this.width * 4 + x;
          if (data[p] === 255 && data[p + 1] === 255 && data[p + 2] === 0) yellow++;
          if (data[p] === 255 && data[p + 1] === 150 && data[p + 2] === 50) orange = y / this.height;
        }
        return { hidden: false, yellow, orange };
      }`,
    );
  };
  let t = await readTrack();
  assert(!t.hidden && t.yellow > 20, `marker track shows match ticks (${t.yellow} yellow rows)`);
  assert(t.orange >= 0 && t.orange < 0.1, `current-match tick sits near the top (${t.orange.toFixed(3)})`);

  // Every match skipped over must have been on screen before the jump.
  const skippedOffscreen = await page.evaluate(
    ({ from, to, dy }) => {
      const all = [...CSS.highlights.get("viewport-find-all")];
      let bad = 0;
      for (let i = from + 1; i < to; i++) {
        const r = new Range();
        r.setStart(all[i].startContainer, all[i].startOffset);
        r.setEnd(all[i].endContainer, all[i].endOffset);
        const b = r.getBoundingClientRect().bottom + dy; // pre-jump position
        if (b > innerHeight) bad++;
      }
      return bad;
    },
    { from: before.index, to: s.index, dy: s.scrollY - before.scrollY },
  );
  assert(skippedOffscreen === 0, "no off-screen match was skipped");

  // Repeated viewport jumps reach the end and wrap to the top.
  let jumps = 0;
  let last = s.index;
  while (jumps < 200) {
    await page.keyboard.press("Control+Enter");
    s = await info();
    jumps++;
    if (s.index < last) break;
    last = s.index;
  }
  assert(s.index === 0, `wrapped to first match after ${jumps} jumps`);

  // Shift+Ctrl+Enter goes back a viewport from the top: wraps to the end.
  await page.keyboard.press("Control+Shift+Enter");
  s = await info();
  assert(s.index > 700 && s.bottom <= s.h, `previous viewport wraps to the end (index ${s.index})`);
  await page.keyboard.press("Control+Shift+Enter");
  const s2 = await info();
  assert(s2.index < s.index - 1 && s2.bottom > s2.h * 0.8, "previous viewport lands near the bottom");
  t = await readTrack();
  assert(t.orange > 0.8, `current-match tick follows the match to the end (${t.orange.toFixed(3)})`);

  // Follow scroll (on by default): after scrolling away from the current
  // match, Next starts from the screen instead of jumping back.
  await page.evaluate(() => scrollTo(0, 0));
  await page.keyboard.press("Enter");
  s = await info();
  assert(s.index === 0 && s.scrollY === 0, `follow scroll: Next after scrolling to the top picks the first match (index ${s.index})`);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight / 2));
  const mid = (await info()).scrollY;
  await page.keyboard.press("Shift+Enter");
  s = await info();
  assert(s.scrollY === mid && s.top >= 0 && s.bottom <= s.h, "follow scroll: Previous picks a match on screen without scrolling");
  const onScreen = s.index;

  // With follow scroll off, Next continues from the current match.
  assert((await clickBarButton("follow")) === "false", "follow scroll button turns off");
  await page.evaluate(() => scrollTo(0, 0));
  await page.keyboard.press("Enter");
  s = await info();
  assert(s.index === onScreen + 1 && s.scrollY > 0, `follow scroll off: Next continues from the old match (index ${s.index})`);
  assert((await clickBarButton("follow")) === "true", "follow scroll button turns back on");

  // Next draws a ring over the new match, which removes itself afterwards.
  // A move that scrolls the page gets the bigger ring.
  const pingClasses = (session) =>
    callOnBarNode(
      (n) => (n.attributes || []).includes("pings"),
      "function () { return [...this.children].map((c) => c.className).join(','); }",
      session,
    );
  await page.keyboard.press("Enter");
  assert((await pingClasses()) === "ping", "Next on screen gets the small ping");
  await page.waitForTimeout(500);
  assert((await pingClasses()) === "", "the ping removes itself after the animation");
  await page.keyboard.press("Control+Enter");
  assert((await pingClasses()) === "ping big", "a viewport jump gets the big ping");
  await page.waitForTimeout(900);
  assert((await pingClasses()) === "", "the big ping removes itself too");

  // show() refocuses an open bar instead of closing it, unlike toggle().
  await page.evaluate(() => window.__viewportFind.show());
  assert((await info()).total > 0, "show() keeps an open bar open");

  // Nested scroll container.
  await type("needle");
  for (let i = 0; i < 20; i++) await page.keyboard.press("Enter");
  const nested = await page.evaluate(() => {
    const cur = [...CSS.highlights.get("viewport-find-current")][0];
    const r = new Range();
    r.setStart(cur.startContainer, cur.startOffset);
    r.setEnd(cur.endContainer, cur.endOffset);
    const rr = r.getBoundingClientRect();
    const box = document.getElementById("scroller").getBoundingClientRect();
    return rr.top >= box.top && rr.bottom <= box.bottom && rr.top >= 0 && rr.bottom <= innerHeight;
  });
  assert(nested, "match inside a nested scroller is scrolled into view");

  // Escape closes and clears highlights.
  await page.keyboard.press("Escape");
  assert((await info()).total === 0, "Escape clears highlights");
  assert((await readTrack()).hidden, "Escape hides the marker track");

  // 3. Performance on a large page.
  await page.evaluate(() => {
    let html = "";
    for (let i = 0; i < 20000; i++) html += `<p>row ${i} <span>alpha</span> <b>beta</b> gamma delta</p>`;
    document.getElementById("paras").innerHTML = html;
    window.__viewportFind.toggle();
  });
  const t0 = Date.now();
  await type("gamma");
  const t1 = Date.now();
  await type("e");
  const t2 = Date.now();
  s = await info();
  assert(s.total === 10000, `1-letter query caps at 10000 matches`);
  console.log(`   large page: "gamma" ${t1 - t0}ms, "e" ${t2 - t1}ms (each includes 120ms wait + typing)`);
  const timing = await page.evaluate(() => {
    const t = performance.now();
    window.__viewportFind.toggle(); // input focused -> close
    window.__viewportFind.toggle(); // reopen: rebuilds index and re-searches
    return performance.now() - t;
  });
  console.log(`   large page: close + reopen with full index rebuild and search: ${timing.toFixed(1)}ms`);

  // 4. Turning the animation off on the options page.
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  assert(await opts.isChecked("#animate"), "options page: animation is on by default");
  await opts.uncheck("#animate");
  const saved = await sw.evaluate(() => chrome.storage.local.get("animate"));
  assert(saved.animate === false, "options page saves animation off");

  // The content script reads it from storage and follows live changes.
  const quiet = await ctx.newPage();
  await quiet.setViewportSize({ width: 1000, height: 700 });
  await quiet.goto("file://" + path.join(__dirname, "page.html"));
  await quiet.evaluate(() => {
    const listeners = [];
    window.chrome = {
      storage: {
        local: { get: async () => ({ animate: false }), set: async () => {} },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
    };
    window.__setAnimate = (v) => listeners.forEach((fn) => fn({ animate: { newValue: v } }, "local"));
  });
  await quiet.addScriptTag({ path: path.join(ext, "content.js") });
  const quietCdp = await ctx.newCDPSession(quiet);
  await quiet.keyboard.type("target");
  await quiet.waitForTimeout(120);
  await quiet.keyboard.press("Control+Enter");
  assert((await pingClasses(quietCdp)) === "", "no ping when animation is off");
  await quiet.evaluate(() => window.__setAnimate(true));
  await quiet.keyboard.press("Control+Enter");
  assert((await pingClasses(quietCdp)) === "ping big", "turning animation back on applies without reopening");

  await ctx.close();
  console.log("all passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
