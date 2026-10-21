// UI language layer: language choice, lookup with English fallback, plurals, and a pt-BR
// catalog that keeps every {placeholder} of its English key.
const assert = require('assert');
const i18n = require('../src/core/i18n.js');
const ptBR = require('../src/core/locales/pt-BR.js');
const { summarise } = require('../src/core/homeModel.js');

assert.strictEqual(i18n.resolveLanguage('auto', ['pt-BR', 'en-US']), 'pt-BR');
assert.strictEqual(i18n.resolveLanguage('auto', ['pt']), 'pt-BR');
assert.strictEqual(i18n.resolveLanguage('auto', ['pt_PT']), 'pt-BR');
assert.strictEqual(i18n.resolveLanguage('auto', ['en-GB', 'pt-BR']), 'en');
assert.strictEqual(i18n.resolveLanguage('auto', ['ptx']), 'en');
assert.strictEqual(i18n.resolveLanguage(undefined, []), 'en');
assert.strictEqual(i18n.resolveLanguage('en', ['pt-BR']), 'en');
assert.strictEqual(i18n.resolveLanguage('pt-BR', ['en-US']), 'pt-BR');

i18n.setLanguage('en');
assert.strictEqual(i18n.t('Stop {name}', { name: 'web' }), 'Stop web');
assert.strictEqual(i18n.t('Keep {missing}', {}), 'Keep {missing}');

i18n.setLanguage('pt-BR');
assert.strictEqual(i18n.language(), 'pt-BR');
assert.strictEqual(i18n.t('Stop {name}', { name: 'web' }), 'Parar web');
assert.strictEqual(i18n.t('Not in any catalog'), 'Not in any catalog');
assert.strictEqual(i18n.tn(1, 'Deleted {n} app', 'Deleted {n} apps'), '1 app excluído');
assert.strictEqual(i18n.tn(3, 'Deleted {n} app', 'Deleted {n} apps'), '3 apps excluídos');
assert.strictEqual(i18n.t('{n} selected', { n: 1 }), '1 selecionado');
assert.strictEqual(i18n.t('{n} selected', { n: 0 }), '0 selecionados');

i18n.setLanguage('fr');
assert.strictEqual(i18n.language(), 'en');

const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join(' ');
for (const [key, value] of Object.entries(ptBR)) {
  const forms = Array.isArray(value) ? value : [value];
  assert.ok(forms.length === (Array.isArray(value) ? 2 : 1), `[one, other] expected for ${JSON.stringify(key)}`);
  for (const form of forms) {
    assert.ok(typeof form === 'string' && form.trim(), `empty translation for ${JSON.stringify(key)}`);
    assert.strictEqual(holes(form), holes(key), `placeholders differ for ${JSON.stringify(key)}`);
  }
}

// Shared core modules stay English until the app installs the translator on globalThis.
assert.strictEqual(summarise([{ id: 'a', state: 'running' }]).headline, 'All good');
globalThis.PortPilotI18n = i18n;
i18n.setLanguage('pt-BR');
const pt = summarise([{ id: 'x', state: 'conflict' }, { id: 'y', state: 'running' }]);
assert.strictEqual(pt.headline, '1 item precisa de você');
assert.strictEqual(pt.sub, '1 em execução · 0 prontos · 1 bloqueado');
delete globalThis.PortPilotI18n;

console.log('i18n: ok');
