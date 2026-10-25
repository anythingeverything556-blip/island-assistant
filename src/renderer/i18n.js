// Island's interface in another language, without touching the code that draws it: every piece
// of interface text (and title, placeholder, aria-label) that matches an entry in
// window.I18N[lang] is swapped as it appears, including text added later. Entries with {0},
// {1}… match text with numbers or names in it. What people wrote (chat messages, memories,
// file names, edits) is never translated.
window.I18n = (() => {
  // User content and code: never translated.
  const SKIP = '.md, .bubble, .msg-edit, pre, code, textarea, input, select option[value]:not([value=""]), .lv-you, .lv-ai, .mem-t, .pc-paths, .srv-tool, .srv-err, .chat-t, .act-t, .note.mem, .chip span, [data-no-tr], .ts, .tool-detail, .sources, .qrec span';
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  // A text box's own hint (placeholder, title) is interface text even though what's typed isn't.
  const SKIP_ATTR = SKIP.split(', ').filter((s) => s !== 'textarea' && s !== 'input').join(', ');
  let lang = 'en';
  let exact = new Map();
  let patterns = [];
  let observer = null;
  let busy = false;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function compile(dict) {
    exact = new Map();
    patterns = [];
    for (const [k, v] of Object.entries(dict || {})) {
      if (!/\{\d+\}/.test(k)) { exact.set(k, v); continue; }
      const order = [...k.matchAll(/\{(\d+)\}/g)].map((m) => m[1]);
      const re = new RegExp(`^${esc(k).replace(/\\\{\d+\\\}/g, '([\\s\\S]+?)')}$`);
      patterns.push({ re, order, v, fixed: k.replace(/\{\d+\}/g, '').length });
    }
    // Longer fixed text first, so specific patterns beat general ones like "{0} left".
    patterns.sort((a, b) => b.fixed - a.fixed);
  }

  // The translation of one string, keeping its surrounding spaces; null when there is none.
  function tr(s) {
    const t = s.trim();
    if (!t || lang === 'en') return null;
    const hit = exact.get(t);
    if (hit) return s.replace(t, hit);
    if (t.length > 400) return null;
    for (const p of patterns) {
      const m = p.re.exec(t);
      if (m) return s.replace(t, p.v.replace(/\{(\d+)\}/g, (_, n) => m[p.order.indexOf(n) + 1] ?? ''));
    }
    return null;
  }

  const skipped = (el) => !!el?.closest?.(SKIP);
  const skippedAttr = (el) => !!el?.closest?.(SKIP_ATTR);

  function translateNode(node) {
    if (node.nodeType === 3) {
      if (skipped(node.parentElement)) return;
      const t = tr(node.nodeValue);
      if (t !== null && t !== node.nodeValue) node.nodeValue = t;
      return;
    }
    if (node.nodeType !== 1) return;
    if (skipped(node)) {
      if (!skippedAttr(node)) for (const a of ATTRS) { const v = node.getAttribute(a); if (v) { const t = tr(v); if (t !== null && t !== v) node.setAttribute(a, t); } }
      return;
    }
    for (const a of ATTRS) {
      const v = node.getAttribute(a);
      if (v) { const t = tr(v); if (t !== null && t !== v) node.setAttribute(a, t); }
    }
    for (const el of node.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
      if (skippedAttr(el)) continue;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v) { const t = tr(v); if (t !== null && t !== v) el.setAttribute(a, t); }
      }
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (skipped(n.parentElement)) continue;
      const t = tr(n.nodeValue);
      if (t !== null && t !== n.nodeValue) n.nodeValue = t;
    }
  }

  function start() {
    observer?.disconnect();
    if (lang === 'en') return;
    translateNode(document.body);
    observer = new MutationObserver((records) => {
      if (busy) return;
      busy = true;
      try {
        for (const r of records) {
          if (r.type === 'characterData') translateNode(r.target);
          else if (r.type === 'attributes') translateNode(r.target);
          else r.addedNodes.forEach(translateNode);
        }
      } finally {
        busy = false;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  return {
    // Switch the interface language ('en' = as written). Going back to English needs a reload.
    set(l) {
      lang = window.I18N?.[l] ? l : 'en';
      document.documentElement.lang = lang === 'en' ? 'en' : lang;
      compile(window.I18N?.[lang]);
      start();
    },
    get: () => lang,
    tr: (s) => tr(String(s)) ?? String(s),
  };
})();
