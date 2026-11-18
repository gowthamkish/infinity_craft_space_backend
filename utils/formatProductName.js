// Normalises product names to Title Case: "pearl hairband" / "TWO layer kemp" → "Pearl Hairband" / "Two Layer Kemp".
// Short all-caps words (LED, DIY, UV) and words with digits (3D, 10mm) are left alone;
const capitalizeWord = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

function formatWord(word, isFirst) {
  if (!word) return word;
  // Hyphenated words: capitalise each part ("evil-eye" → "Evil-Eye")
  if (word.includes("-")) return word.split("-").map((p) => formatWord(p, true)).join("-");
  // Keep leading symbols/emoji/brackets: capitalise the first letter found
  const m = word.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}].*)$/u);
  if (!m) return word;
  const [, lead, core] = m;
  if (/\d/.test(core)) return word; // 3D, 10mm, 8"
  if (core.length <= 3 && core === core.toUpperCase() && /\p{L}/u.test(core)) return word; // LED, DIY
  return lead + capitalizeWord(core);
}

function formatProductName(name) {
  if (typeof name !== "string") return name;
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w, i) => formatWord(w, i === 0))
    .join(" ");
}

module.exports = { formatProductName };
