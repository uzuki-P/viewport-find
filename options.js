// Settings that rarely change live here instead of on the find bar.
const animate = document.getElementById("animate");

chrome.storage.local.get("animate").then(({ animate: saved }) => {
  animate.checked = saved !== false;
});
animate.addEventListener("change", () => chrome.storage.local.set({ animate: animate.checked }));
