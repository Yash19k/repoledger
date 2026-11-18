// Apply the saved theme before first paint. Light is the default.
(function () {
  var t = null;
  try {
    t = localStorage.getItem("rl-theme");
  } catch (e) {}
  if (t !== "light" && t !== "dark") t = "light";
  document.documentElement.setAttribute("data-theme", t);
})();
