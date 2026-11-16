const test = require('node:test');
const assert = require('node:assert/strict');
const { norm, Matcher } = require('../src/answers');
const content = require('../data/categories.json');
const elements = require('../data/elements.json');

const m = new Matcher(content.categories, elements);
const ok = (cat, input, expected) => {
  const r = m.match(cat, input);
  assert.ok(r, `${cat}: expected “${input}” to be accepted`);
  if (expected) assert.match(r.display, expected);
  return r;
};
const no = (cat, input) => assert.equal(m.match(cat, input), null, `${cat}: expected “${input}” to be rejected`);

test('content: 50+ categories, 10+ answers each, valid levels', () => {
  assert.ok(content.categories.length >= 50, `${content.categories.length} categories`);
  const levels = new Set(content.levels.map((l) => l.id));
  for (const c of content.categories) {
    assert.ok(c.answers.length >= 10, `${c.id} has ${c.answers.length} answers`);
    assert.ok(c.prompt && c.levels.length && c.levels.every((l) => levels.has(l)), c.id);
  }
});

test('content: no alternate maps to two different answers within a category', () => {
  for (const c of content.categories) {
    const seen = new Map();
    c.answers.forEach((alts, i) => alts.forEach((a) => {
      const k = norm(a);
      assert.ok(k, `${c.id}: empty key for ${a}`);
      if (seen.has(k)) assert.equal(seen.get(k), i, `${c.id}: “${a}” collides with ${c.answers[seen.get(k)][0]}`);
      seen.set(k, i);
    }));
  }
});

test('normalisation ignores case, spacing, punctuation and accents', () => {
  assert.equal(norm('  Chlorine  '), 'chlorine');
  assert.equal(norm('SO4^2-'), norm('so₄²⁻'));
  assert.equal(norm('Iron(III)'), 'ironiii');
  assert.equal(norm('Schrödinger'), 'schrodinger');
  assert.equal(norm('the nitrate ion'), 'nitrate');
});

test('element names and symbols both count', () => {
  ok('group-7-8', 'cl', /Chlorine/);
  ok('group-7-8', 'CHLORINE', /Chlorine/);
  ok('group-7-8', '  xenon ', /Xenon/);
  assert.equal(m.match('group-7-8', 'Br').index, m.match('group-7-8', 'bromine').index, 'name and symbol are the same answer');
  no('group-7-8', 'oxygen');
  ok('odd-symbol', 'Au', /Gold/);
  ok('nonmetal-metalloid', 'sulphur', /Sulfur/);
});

test('common and IUPAC names plus formulas', () => {
  ok('strong-acid-base', 'HCl', /hydrochloric/);
  ok('strong-acid-base', 'hydrochloric', /hydrochloric/);
  ok('strong-acid-base', 'Ba(OH)2', /barium/);
  no('strong-acid-base', 'acetic acid');
  ok('weak-acid', 'ethanoic acid', /acetic/);
  ok('polyatomic-anion', 'NO3-', /nitrate/);
  ok('polyatomic-anion', 'bicarbonate', /hydrogen carbonate/);
  ok('common-cation', 'ferric', /iron\(III\)/);
  ok('common-cation', 'Fe3+', /iron\(III\)/);
  ok('common-cation', 'Fe2+', /iron\(II\)/);
  ok('common-name-compound', 'sodium bicarbonate', /baking soda/);
  ok('alcohol', 'rubbing alcohol', /2-propanol/);
  ok('amino-acid', 'Trp', /tryptophan/);
  ok('straight-alkane', 'C8H18', /octane/);
});

test('one typo forgiven only on words longer than 5 letters', () => {
  const r = ok('group-7-8', 'chlorne', /Chlorine/); // missing letter
  assert.equal(r.typo, true);
  ok('polymer', 'polystyrne', /polystyrene/);
  ok('lab-equipment', 'beakre', /beaker/); // transposition, 6 letters
  no('group-7-8', 'neom'); // 4 letters: no typo allowance
  no('metric-prefix', 'gigi'); // short
  no('group-7-8', 'chlorinne'.replace('nn', 'xx')); // two edits
});

test('a typo never turns one real term into a different one', () => {
  no('polyatomic-anion', 'sulfide'); // real (but monatomic) ion: must not become “sulfite”
  no('nonpolar-molecule', 'methanol'); // polar molecule, near “methane”
  no('common-cation', 'iron(IV)');
  ok('polyatomic-anion', 'chlorite', /chlorite/);
  no('polyatomic-anion', 'chlorote'); // ambiguous: chlorate or chlorite
});
