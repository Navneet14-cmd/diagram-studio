// Runs before first paint so the saved theme never flashes. External file: the CSP forbids inline scripts.
(function () {
  try {
    var t = localStorage.getItem("ds-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) { /* storage blocked: follow the system theme */ }
})();
