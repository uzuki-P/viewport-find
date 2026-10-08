// Injects the find bar on demand, so pages that never use it pay nothing.

// action: "toggle" closes an open, focused bar; "show" only opens or focuses.
async function run(tab, action) {
  if (!tab?.id) return;
  const target = { tabId: tab.id };
  try {
    const [{ result: loaded }] = await chrome.scripting.executeScript({
      target,
      func: () => typeof window.__viewportFind === "object",
    });
    if (loaded) {
      await chrome.scripting.executeScript({
        target,
        func: (action) => window.__viewportFind[action](),
        args: [action],
      });
      return;
    }
    // insertCSS is exempt from the page's CSP, unlike a <style> tag.
    await chrome.scripting.insertCSS({ target, files: ["highlight.css"] });
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
  } catch (err) {
    // chrome://, the Web Store, and similar pages refuse injection.
    console.warn("Viewport Find cannot run on this page:", err.message);
  }
}

chrome.action.onClicked.addListener((tab) => run(tab, "toggle"));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-find") run(tab, "toggle");
  else if (command === "show-find") run(tab, "show");
});
