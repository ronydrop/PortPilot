/**
 * PortPilot UI language layer.
 *
 * English source text is the key: t('Stop {name}', { name }) looks the string
 * up in the active locale's catalog and falls back to the English text, so a
 * missing entry never breaks the UI. Loaded as window.PortPilotI18n (with the
 * t / tn shortcuts) in the renderer and required by the main process, which
 * also installs it on globalThis so the shared core modules translate there.
 * Consumers that never install it (MCP server, VS Code, plugin, tests) keep
 * English.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    api.register('pt-BR', require('./locales/pt-BR'));
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.PortPilotI18n = api;
    window.t = api.t;
    window.tn = api.tn;
    const bridge = window.portpilot && window.portpilot.i18n;
    api.setLanguage(bridge ? bridge.language() : api.resolveLanguage('auto', navigator.languages));
    document.documentElement.lang = api.language();
    document.addEventListener('DOMContentLoaded', () => api.translateDom(document.body));
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LANGUAGES = [
    { id: 'en', label: 'English' },
    { id: 'pt-BR', label: 'Português (Brasil)' },
  ];
  const catalogs = {};
  let current = 'en';

  const known = (id) => LANGUAGES.some((l) => l.id === id);

  /** 'en' | 'pt-BR' from a stored choice ('auto' | 'en' | 'pt-BR') and the system locales, most preferred first. */
  function resolveLanguage(choice, locales) {
    if (known(choice)) return choice;
    const first = String((locales || [])[0] || '');
    return /^pt([-_]|$)/i.test(first) ? 'pt-BR' : 'en';
  }

  function register(lang, table) {
    catalogs[lang] = Object.assign(catalogs[lang] || {}, table);
  }

  function setLanguage(lang) {
    current = known(lang) ? lang : 'en';
  }

  const language = () => current;

  const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);

  /** A catalog value may be [one, other] when only the translation inflects by {n}. */
  function t(key, vars) {
    const table = catalogs[current];
    const text = (table && table[key]) || key;
    return fill(Array.isArray(text) ? text[vars && vars.n === 1 ? 0 : 1] : text, vars);
  }

  /** Singular or plural by count; {n} in either form is the count. */
  function tn(count, one, other, vars) {
    return t(count === 1 ? one : other, Object.assign({ n: count }, vars));
  }

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  /** Translate the static text nodes and labelling attributes under `el` in place. */
  function translateDom(el) {
    const table = catalogs[current];
    if (!table || !el) return;
    const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const hit = table[norm(n.nodeValue)];
      if (typeof hit === 'string') n.nodeValue = n.nodeValue.replace(/\S[\s\S]*\S|\S/, () => hit);
    }
    el.querySelectorAll('[title],[placeholder],[aria-label],[alt]').forEach((node) => {
      for (const a of ATTRS) {
        const hit = node.hasAttribute(a) && table[norm(node.getAttribute(a))];
        if (typeof hit === 'string') node.setAttribute(a, hit);
      }
    });
  }

  return { LANGUAGES, resolveLanguage, register, setLanguage, language, t, tn, translateDom };
});
