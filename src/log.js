/** Tiny logger: "2026-01-01 12:00:00,000 [INFO] message" */

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`;
}

module.exports = {
  info: (msg) => console.log(`${stamp()} [INFO] ${msg}`),
  warning: (msg) => console.warn(`${stamp()} [WARNING] ${msg}`),
  error: (msg) => console.error(`${stamp()} [ERROR] ${msg}`),
};
