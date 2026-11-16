// Answer normalisation and matching.
// Rules: ignore case and extra spaces; accept any listed alternate (element names,
// symbols, common / IUPAC names, formulas); allow one typo on answers longer than 5 letters.

const SUPERSCRIPTS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };

function norm(input) {
  let s = String(input || '').slice(0, 80);
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/g, (c) => SUPERSCRIPTS[c]);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // subscripts -> digits, strip accents
  s = s.toLowerCase().replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
    .replace(/δ|∆/g, 'delta').replace(/π/g, 'pi').replace(/σ/g, 'sigma').replace(/ω/g, 'ohm');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(an?|the) /, '');
  s = s.replace(/ ions?$/, '');
  // drop punctuation, charge signs and spaces: "SO4^2-" -> "so42", "iron(III)" -> "ironiii"
  s = s.replace(/[^a-z0-9]/g, '');
  return s;
}

// Optimal-string-alignment distance, early exit once it exceeds `max`.
function editDistance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let prev2 = null, prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[m];
}

// A typo is only forgiven on longer, word-like keys (no digits, so formulas and
// Roman-numeral charges like iron(II)/iron(III) must be exact).
const fuzzyEligible = (key) => key.length > 5 && !/\d/.test(key);
const hasRomanCharge = (alt) => /\([ivx]+\)/i.test(alt);

class Matcher {
  /**
   * @param {Array} categories  [{ id, answers: [[display, alt, ...], ...] }]
   * @param {Array} elements    [[symbol, name], ...] — names count as "known words"
   */
  constructor(categories, elements = []) {
    this.byCategory = new Map();
    this.known = new Set(); // every key that means something somewhere: never fuzzy-match these to a different answer
    for (const [sym, name] of elements) { this.known.add(norm(sym)); this.known.add(norm(name)); }
    for (const cat of categories) {
      const exact = new Map();
      const fuzzy = [];
      cat.answers.forEach((alts, idx) => {
        for (const alt of alts) {
          const k = norm(alt);
          if (!k) continue;
          this.known.add(k);
          if (!exact.has(k)) exact.set(k, idx);
          if (fuzzyEligible(k) && !hasRomanCharge(alt)) fuzzy.push([k, idx]);
        }
      });
      this.byCategory.set(cat.id, { exact, fuzzy, answers: cat.answers });
    }
  }

  /** @returns {null | { index, display, typo }} */
  match(categoryId, input) {
    const entry = this.byCategory.get(categoryId);
    if (!entry) return null;
    const k = norm(input);
    if (!k) return null;
    if (entry.exact.has(k)) {
      const index = entry.exact.get(k);
      return { index, display: entry.answers[index][0], typo: false };
    }
    // Typo tolerance: only if the input itself isn't a real (but wrong) term, e.g. "sulfide" must not become "sulfite".
    if (!fuzzyEligible(k) || this.known.has(k)) return null;
    const hits = new Set();
    for (const [fk, idx] of entry.fuzzy) if (editDistance(k, fk, 1) <= 1) hits.add(idx);
    if (hits.size !== 1) return null; // ambiguous typo (e.g. "chlorote") is rejected
    const index = [...hits][0];
    return { index, display: entry.answers[index][0], typo: true };
  }
}

module.exports = { norm, editDistance, Matcher };
