// Apply the saved/system theme before first paint.
(function () {
  var t = null;
  try {
    t = localStorage.getItem("rl-theme");
  } catch (e) {}
  if (t !== "light" && t !== "dark") {
    t = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", t);
})();
