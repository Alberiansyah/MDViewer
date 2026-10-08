/* ==========================================================================
   MDView — app logic (vanilla JS, no build step)
   Pipeline: editor input -> debounce -> marked.parse -> preview HTML
             -> highlight.js -> mermaid -> outline / scroll-spy
   All state that survives a refresh lives in localStorage.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };

  var editor = $('editor');
  var preview = $('preview');
  var previewScroll = $('previewScroll');
  var emptyState = $('emptyState');
  var renderError = $('renderError');
  var editorMeta = $('editorMeta');
  var previewMeta = $('previewMeta');
  var fileNameEl = $('fileName');
  var tocList = $('tocList');
  var tocPanel = $('toc');
  var mainEl = $('main');
  var workspace = $('workspace');
  var divider = $('divider');
  var themeBtn = $('themeBtn');
  var tocBtn = $('tocBtn');
  var tocClose = $('tocClose');
  var openBtn = $('openBtn');
  var exportBtn = $('exportBtn');
  var fileInput = $('fileInput');
  var dropOverlay = $('dropOverlay');
  var scrim = $('scrim');
  var toasts = $('toasts');
  var viewToggle = $('viewToggle');
  var hljsLight = $('hljs-light');
  var hljsDark = $('hljs-dark');

  /* ---------- Keys ---------- */
  var K = {
    content: 'mdview.content',
    theme: 'mdview.theme',
    split: 'mdview.split',
    tocOpen: 'mdview.tocOpen',
    view: 'mdview.view',
    fileName: 'mdview.fileName'
  };

  var DEBOUNCE_MS = 150;
  var MAX_RENDER_BYTES = 2000000;

  /* ---------- Safe storage ---------- */
  var store = {
    get: function (key) {
      try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, value); } catch (e) { /* quota / disabled */ }
    }
  };

  /* ---------- Utilities ---------- */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/`/g, '&#96;');
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function countWords(text) {
    var m = text.trim().match(/[^\s]+/g);
    return m ? m.length : 0;
  }

  function safeUrl(href) {
    if (href == null) return null;
    var s = String(href).trim();
    if (/^\s*(?:javascript|vbscript|file):/i.test(s)) return null;
    if (/^\s*data:/i.test(s) && !/^data:image\//i.test(s)) return null;
    return s;
  }

  function slugify(text) {
    var s = String(text).toLowerCase().trim()
      .replace(/[\s\u00a0]+/g, '-')
      .replace(/[^\p{L}\p{N}\-_]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'section';
  }

  function toast(message, isError) {
    var el = document.createElement('div');
    el.className = 'toast' + (isError ? ' is-error' : '');
    el.setAttribute('role', 'status');
    var dot = document.createElement('span');
    dot.className = 'dot';
    var label = document.createElement('span');
    label.textContent = message;
    el.appendChild(dot);
    el.appendChild(label);
    toasts.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    }, 2300);
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ---------- Theme ---------- */
  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function applyTheme(theme, persist) {
    var dark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if (hljsLight) hljsLight.media = dark ? 'not all' : 'all';
    if (hljsDark) hljsDark.media = dark ? 'all' : 'not all';
    if (themeBtn) themeBtn.setAttribute('aria-pressed', String(dark));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#14120f' : '#f3efe8');
    if (persist) store.set(K.theme, dark ? 'dark' : 'light');
  }

  /* ---------- Marked setup ---------- */
  var slugCounts = Object.create(null);

  function registerMarked() {
    if (!window.marked || !window.marked.use) return false;

    window.marked.use({
      gfm: true,
      // Standard GFM behaviour: a single newline inside a paragraph is a soft
      // break and renders as a space. Only two trailing spaces (or a blank
      // line) create a line break. `breaks: true` would turn every wrapped
      // source line into a forced <br>, which looks wrong in prose.
      breaks: false,

      walkTokens: function (token) {
        if (token.type === 'heading') {
          var base = slugify(token.text);
          if (slugCounts[base]) {
            slugCounts[base] += 1;
            token.__id = base + '-' + slugCounts[base];
          } else {
            slugCounts[base] = 1;
            token.__id = base;
          }
        }
      },

      renderer: {
        heading: function (token) {
          var id = token.__id || slugify(token.text);
          var inner = this.parser.parseInline(token.tokens);
          var depth = token.depth;
          return '<h' + depth + ' id="' + escapeAttr(id) + '">' + inner +
            '<a class="anchor" href="#' + escapeAttr(id) + '" aria-hidden="true" tabindex="-1">#</a>' +
            '</h' + depth + '>\n';
        },

        code: function (token) {
          var lang = '';
          if (token.lang) {
            var m = String(token.lang).match(/^\S+/);
            if (m) lang = m[0];
          }
          var body = token.escaped ? token.text : escapeHtml(token.text);

          if (lang.toLowerCase() === 'mermaid') {
            return '<div class="mermaid-block"><pre class="mermaid">' + escapeHtml(token.text) + '</pre></div>\n';
          }

          var label = lang ? ' data-lang="' + escapeAttr(lang) + '"' : '';
          var cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : '';
          return '<div class="code-block"' + label + '>' + COPY_BUTTON +
            '<pre><code' + cls + '>' + body + '</code></pre></div>\n';
        },

        link: function (token) {
          var href = safeUrl(token.href);
          var text = this.parser.parseInline(token.tokens);
          if (href === null) return text;
          var external = /^https?:/i.test(href);
          return '<a href="' + escapeAttr(href) + '"' +
            (token.title ? ' title="' + escapeAttr(token.title) + '"' : '') +
            (external ? ' target="_blank" rel="noopener noreferrer"' : '') +
            '>' + text + '</a>';
        },

        image: function (token) {
          var src = safeUrl(token.href);
          var alt = token.text == null ? '' : token.text;
          if (src === null) return escapeHtml(alt);
          return '<img src="' + escapeAttr(src) + '" alt="' + escapeAttr(alt) + '"' +
            (token.title ? ' title="' + escapeAttr(token.title) + '"' : '') +
            ' loading="lazy">';
        },

        // Escape raw HTML so user documents can't inject markup into the page.
        html: function (token) {
          return escapeHtml(token.text);
        }
      }
    });
    return true;
  }

  var COPY_BUTTON =
    '<button class="copy-btn" type="button" aria-label="Copy code to clipboard">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
    '</svg><span>Copy</span></button>';

  /* ---------- Highlight.js ---------- */
  function highlightAll(root) {
    if (!window.hljs || !window.hljs.highlightElement) return;
    var blocks = root.querySelectorAll('pre code');
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (el.classList.contains('hljs')) continue;
      if (el.classList.contains('mermaid')) continue;
      try {
        window.hljs.highlightElement(el);
      } catch (e) { /* never let highlighting break the render */ }
    }
  }

  /* ---------- Mermaid ---------- */
  var mermaidOK = false;
  var mermaidSignature = 'default';
  var mermaidCache = new Map();
  var mermaidCounter = 0;

  function initMermaid() {
    if (!window.mermaid || typeof window.mermaid.initialize !== 'function') {
      mermaidOK = false;
      return;
    }
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDark() ? 'dark' : 'default',
        fontFamily: "'Space Grotesk', ui-sans-serif, sans-serif",
        themeVariables: isDark()
          ? { primaryColor: '#2a251e', primaryTextColor: '#ece6db', lineColor: '#fb923c', primaryBorderColor: '#453c31', tertiaryColor: '#1c1915' }
          : { primaryColor: '#faf6ef', primaryTextColor: '#211d18', lineColor: '#c2410c', primaryBorderColor: '#d2c7b2', tertiaryColor: '#f7f2ea' }
      });
      mermaidOK = true;
    } catch (e) {
      mermaidOK = false;
    }
  }

  function mermaidErrorBlock(message, code) {
    return '<div class="mermaid-error" role="alert">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" style="flex:none;margin-top:1px" aria-hidden="true">' +
      '<path d="M12 8v5m0 3.5h.01"/><circle cx="12" cy="12" r="9"/></svg>' +
      '<div><strong>Diagram could not be rendered</strong>' +
      escapeHtml(message || 'Unknown Mermaid error') +
      '<br><code>' + escapeHtml(code.slice(0, 200)) + '</code></div></div>';
  }

  function renderMermaidBlocks(root, token) {
    var nodes = root.querySelectorAll('pre.mermaid');
    if (!nodes.length) return;

    if (!mermaidOK) {
      for (var i = 0; i < nodes.length; i++) {
        var wrap = nodes[i].parentNode;
        if (wrap) wrap.innerHTML = mermaidErrorBlock('Mermaid could not be loaded (check your connection to the CDN).', nodes[i].textContent);
      }
      return;
    }

    var jobs = [];
    for (var j = 0; j < nodes.length; j++) {
      (function (node) {
        var code = node.textContent;
        var key = mermaidSignature + '\u0000' + code;
        var wrapper = node.parentNode;

        if (mermaidCache.has(key)) {
          wrapper.innerHTML = mermaidCache.get(key);
          return;
        }

        var id = 'mmd-' + (++mermaidCounter);
        jobs.push(
          window.mermaid.render(id, code).then(function (result) {
            if (token !== renderToken) return;
            var svg = result && result.svg ? result.svg : '';
            mermaidCache.set(key, svg);
            wrapper.innerHTML = svg;
          }).catch(function (err) {
            if (token !== renderToken) return;
            // Mermaid can leave a measuring node behind on failure.
            var stray = document.getElementById(id) || document.getElementById('d' + id);
            if (stray && stray.parentNode) stray.parentNode.removeChild(stray);
            wrapper.innerHTML = mermaidErrorBlock(err && err.message ? err.message : String(err), code);
          })
        );
      })(nodes[j]);
    }
    return Promise.all(jobs).catch(function () { /* handled per block */ });
  }

  /* ---------- Render pipeline ---------- */
  var renderToken = 0;

  function updateMeta(text) {
    var words = countWords(text);
    var minutes = Math.max(1, Math.round(words / 220));
    editorMeta.textContent = words + (words === 1 ? ' word' : ' words');
    previewMeta.textContent = words ? words + ' words · ' + minutes + ' min read' : '—';
  }

  function showRenderError(message) {
    if (!renderError) return;
    renderError.hidden = false;
    renderError.innerHTML = '<strong>Render error.</strong> ' + escapeHtml(message);
  }

  function clearRenderError() {
    if (!renderError) return;
    renderError.hidden = true;
    renderError.innerHTML = '';
  }

  function render() {
    var text = editor.value;
    var token = ++renderToken;
    var previousScroll = previewScroll.scrollTop;

    updateMeta(text);

    if (!text.trim()) {
      preview.innerHTML = '';
      emptyState.hidden = false;
      clearRenderError();
      buildToc();
      return;
    }
    emptyState.hidden = true;

    if (text.length > MAX_RENDER_BYTES) {
      toast('This document is very large — preview may lag.', true);
    }

    if (!window.marked || typeof window.marked.parse !== 'function') {
      preview.innerHTML = '<pre><code>' + escapeHtml(text) + '</code></pre>';
      showRenderError('The Markdown parser (marked) could not be loaded. Showing the raw source instead. Check your connection to cdn.jsdelivr.net.');
      buildToc();
      return;
    }

    var html;
    slugCounts = Object.create(null);
    try {
      html = window.marked.parse(text);
    } catch (e) {
      preview.innerHTML = '<pre><code>' + escapeHtml(text) + '</code></pre>';
      showRenderError(e && e.message ? e.message : 'The Markdown parser stopped unexpectedly.');
      buildToc();
      return;
    }

    clearRenderError();
    preview.innerHTML = html;

    highlightAll(preview);
    renderMermaidBlocks(preview, token);
    buildToc();

    // Keep the reader roughly where they were after a re-render. The container
    // uses smooth scrolling, so force an instant restore to avoid animating on
    // every keystroke.
    var prevBehavior = previewScroll.style.scrollBehavior;
    previewScroll.style.scrollBehavior = 'auto';
    previewScroll.scrollTop = previousScroll;
    previewScroll.style.scrollBehavior = prevBehavior;
    updateActiveToc();
  }

  var scheduleRender = debounce(render, DEBOUNCE_MS);

  /* ---------- Table of contents ---------- */
  var currentHeadingIds = [];

  function buildToc() {
    var headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    tocList.innerHTML = '';
    currentHeadingIds = [];

    if (!headings.length) {
      var li = document.createElement('li');
      li.className = 'toc-empty';
      li.textContent = editor.value.trim()
        ? 'No headings yet. Add a # heading to build the outline.'
        : 'The outline appears once your document has headings.';
      tocList.appendChild(li);
      return;
    }

    var counters = [0, 0, 0, 0, 0, 0];
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      var level = parseInt(h.tagName.slice(1), 10);
      counters[level - 1] += 1;
      for (var c = level; c < 6; c++) counters[c] = 0;
      var number = counters.slice(0, level).join('.');

      var item = document.createElement('li');
      item.className = 'toc-item level-' + level;

      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.dataset.target = h.id;

      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = number;
      a.appendChild(num);

      var titleText = h.textContent.replace(/#\s*$/, '').trim();
      a.appendChild(document.createTextNode(titleText || 'Untitled'));

      a.addEventListener('click', (function (id) {
        return function (ev) {
          ev.preventDefault();
          scrollToHeading(id);
          if (isMobile()) setTocOpen(false);
        };
      })(h.id));

      item.appendChild(a);
      tocList.appendChild(item);
      currentHeadingIds.push(h.id);
    }
  }

  function scrollToHeading(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var top = el.offsetTop - 14;
    try {
      previewScroll.scrollTo({ top: top, behavior: 'smooth' });
    } catch (e) {
      previewScroll.scrollTop = top;
    }
  }

  var activeTocId = null;

  function setActiveToc(id) {
    if (id === activeTocId) return;
    activeTocId = id;
    var links = tocList.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var on = links[i].dataset.target === id;
      links[i].classList.toggle('is-active', on);
      if (on && typeof links[i].scrollIntoView === 'function') {
        var li = links[i].parentNode;
        var box = tocPanel.getBoundingClientRect();
        var r = li.getBoundingClientRect();
        if (r.top < box.top + 40 || r.bottom > box.bottom - 12) {
          try { li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e2) { li.scrollIntoView(); }
        }
      }
    }
  }

  function updateActiveToc() {
    if (!currentHeadingIds.length) return;
    var threshold = previewScroll.scrollTop + 96;
    var active = currentHeadingIds[0];
    for (var i = 0; i < currentHeadingIds.length; i++) {
      var el = document.getElementById(currentHeadingIds[i]);
      if (!el) continue;
      if (el.offsetTop <= threshold) active = currentHeadingIds[i];
      else break;
    }
    // At the very bottom, highlight the final heading.
    if (previewScroll.scrollTop + previewScroll.clientHeight >= previewScroll.scrollHeight - 4) {
      active = currentHeadingIds[currentHeadingIds.length - 1];
    }
    setActiveToc(active);
  }

  var onPreviewScroll = (function () {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        updateActiveToc();
      });
    };
  })();

  /* ---------- Copy buttons ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (e) { reject(e); }
    });
  }

  preview.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.copy-btn') : null;
    if (!btn) return;
    var block = btn.closest('.code-block');
    var code = block ? block.querySelector('code') : null;
    if (!code) return;
    copyText(code.innerText).then(function () {
      var span = btn.querySelector('span');
      var previous = span ? span.textContent : '';
      btn.classList.add('is-done');
      if (span) span.textContent = 'Copied';
      setTimeout(function () {
        btn.classList.remove('is-done');
        if (span) span.textContent = previous || 'Copy';
      }, 1400);
    }).catch(function () {
      toast('Could not copy to clipboard.', true);
    });
  });

  /* ---------- Outline open/close ---------- */
  function isMobile() {
    return window.matchMedia('(max-width: 980px)').matches;
  }

  function setTocOpen(open, persist) {
    mainEl.classList.toggle('toc-closed', !open);
    if (tocBtn) tocBtn.setAttribute('aria-expanded', String(open));
    if (persist) store.set(K.tocOpen, open ? '1' : '0');
    updateScrim();
  }

  function updateScrim() {
    if (!scrim) return;
    scrim.hidden = !(isMobile() && !mainEl.classList.contains('toc-closed'));
  }

  /* ---------- Pane layout (mobile tabs) ---------- */
  function setView(view, persist) {
    workspace.setAttribute('data-view', view);
    mainEl.setAttribute('data-view', view);
    var buttons = viewToggle.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].dataset.view === view;
      buttons[i].classList.toggle('is-active', on);
      buttons[i].setAttribute('aria-pressed', String(on));
    }
    if (persist) store.set(K.view, view);
  }

  /* ---------- Divider drag ---------- */
  function setSplit(percent) {
    var clamped = Math.max(22, Math.min(78, percent));
    workspace.style.setProperty('--split', clamped + '%');
    return clamped;
  }

  function initDivider() {
    var dragging = false;

    function onMove(clientX) {
      var rect = workspace.getBoundingClientRect();
      if (!rect.width) return;
      setSplit(((clientX - rect.left) / rect.width) * 100);
    }

    divider.addEventListener('pointerdown', function (ev) {
      dragging = true;
      divider.classList.add('is-dragging');
      document.body.classList.add('is-resizing');
      try { divider.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ }
      ev.preventDefault();
    });

    divider.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      onMove(ev.clientX);
    });

    function stop(ev) {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      try { divider.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
      var current = parseFloat(workspace.style.getPropertyValue('--split')) || 50;
      store.set(K.split, String(current));
    }
    divider.addEventListener('pointerup', stop);
    divider.addEventListener('pointercancel', stop);

    divider.addEventListener('dblclick', function () {
      setSplit(50);
      store.set(K.split, '50');
    });

    divider.addEventListener('keydown', function (ev) {
      var current = parseFloat(workspace.style.getPropertyValue('--split')) || 50;
      var next = null;
      if (ev.key === 'ArrowLeft') next = current - 2;
      else if (ev.key === 'ArrowRight') next = current + 2;
      else if (ev.key === 'Home') next = 22;
      else if (ev.key === 'End') next = 78;
      if (next === null) return;
      ev.preventDefault();
      var value = setSplit(next);
      store.set(K.split, String(value));
    });
  }

  /* ---------- Files ---------- */
  function loadFile(file) {
    if (!file) return;
    var name = file.name || 'document.md';
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (['md', 'markdown', 'txt'].indexOf(ext) === -1 && !/text|markdown/.test(file.type || '')) {
      toast('Unsupported file type: ' + name, true);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('That file is larger than 8 MB — opening anyway.', true);
    }

    var reader = new FileReader();
    reader.onload = function () {
      editor.value = String(reader.result || '');
      fileNameEl.textContent = name;
      store.set(K.content, editor.value);
      store.set(K.fileName, name);
      render();
      var view = isMobile() ? 'preview' : null;
      if (view) setView(view, true);
      toast('Opened ' + name);
    };
    reader.onerror = function () {
      toast('Could not read that file.', true);
    };
    reader.readAsText(file, 'utf-8');
  }

  function initFileInput() {
    openBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
      fileInput.value = '';
    });
  }

  /* ---------- Drag & drop ---------- */
  function initDragDrop() {
    var depth = 0;
    var hasFiles = function (ev) {
      var dt = ev.dataTransfer;
      if (!dt) return false;
      if (dt.types) {
        for (var i = 0; i < dt.types.length; i++) {
          if (dt.types[i] === 'Files') return true;
        }
      }
      return false;
    };

    window.addEventListener('dragenter', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth += 1;
      dropOverlay.hidden = false;
    });

    window.addEventListener('dragover', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', function (ev) {
      if (!hasFiles(ev)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) dropOverlay.hidden = true;
    });

    window.addEventListener('drop', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      dropOverlay.hidden = true;
      if (ev.dataTransfer.files && ev.dataTransfer.files[0]) {
        loadFile(ev.dataTransfer.files[0]);
      }
    });
  }

  /* ---------- Export ---------- */
  function exportHtml() {
    var clone = preview.cloneNode(true);
    var strip = clone.querySelectorAll('.copy-btn, .anchor');
    for (var i = 0; i < strip.length; i++) {
      if (strip[i].parentNode) strip[i].parentNode.removeChild(strip[i]);
    }

    var h1 = clone.querySelector('h1');
    var title = (h1 && h1.textContent.trim()) || fileNameEl.textContent.replace(/\.[^.]+$/, '') || 'Document';
    var body = clone.innerHTML.trim() || '<p>This document is empty.</p>';
    var theme = isDark() ? 'dark' : 'light';

    var doc = '<!doctype html>\n<html lang="en" data-theme="' + theme + '">\n<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta name="generator" content="MDView">\n' +
      '<title>' + escapeHtml(title) + '</title>\n' +
      '<style>\n' + EXPORT_CSS + '\n</style>\n' +
      '</head>\n<body>\n' +
      '<button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle colour theme">Theme</button>\n' +
      '<main class="doc"><article class="markdown-body">\n' + body + '\n</article></main>\n' +
      '<script>\n' + EXPORT_SCRIPT + '\n</' + 'script>\n' +
      '</body>\n</html>\n';

    var base = (fileNameEl.textContent || 'document').replace(/\.[^.]+$/, '');
    download(base + '.html', doc);
    toast('Exported ' + base + '.html');
  }

  var EXPORT_SCRIPT = [
    "(function(){",
    "  var root=document.documentElement;",
    "  var btn=document.getElementById('themeToggle');",
    "  if(btn){btn.addEventListener('click',function(){",
    "    var dark=root.getAttribute('data-theme')==='dark';",
    "    root.setAttribute('data-theme',dark?'light':'dark');",
    "  });}",
    "})();"
  ].join('\n');

  var EXPORT_CSS = [
    ':root{color-scheme:light;--bg:#f3efe8;--surface:#fffdf9;--surface-2:#faf6ef;--ink:#211d18;--ink-soft:#4c463d;--ink-mute:#8a8173;--line:#e4dccd;--line-strong:#d2c7b2;--accent:#c2410c;--accent-ink:#9a3412;--accent-soft:rgba(194,65,12,.10);--code-bg:#f4f0e8;--code-inline-bg:#efe8db}',
    'html[data-theme="dark"]{color-scheme:dark;--bg:#14120f;--surface:#1c1915;--surface-2:#211d18;--ink:#ece6db;--ink-soft:#c3bba9;--ink-mute:#8d8574;--line:#322c24;--line-strong:#453c31;--accent:#fb923c;--accent-ink:#fdba74;--accent-soft:rgba(251,146,60,.14);--code-bg:#211d18;--code-inline-bg:#2a251e}',
    '*,*::before,*::after{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--ink-soft);font-family:"Source Serif 4",Georgia,Iowan Old Style,serif;font-size:17.5px;line-height:1.75;-webkit-font-smoothing:antialiased}',
    '.doc{max-width:820px;margin:0 auto;padding:72px 26px 96px}',
    '.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6{font-family:Fraunces,Georgia,serif;color:var(--ink);font-weight:600;line-height:1.22;letter-spacing:-.015em;margin:1.9em 0 .6em}',
    '.markdown-body h1{font-size:2.15em;margin-top:.2em}.markdown-body h2{font-size:1.6em;padding-bottom:.28em;border-bottom:1px solid var(--line)}.markdown-body h3{font-size:1.26em}.markdown-body h4{font-size:1.08em}.markdown-body h5{font-size:.96em}.markdown-body h6{font-size:.84em;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-mute)}',
    '.markdown-body p{margin:0 0 1.05em}',
    '.markdown-body a{color:var(--accent-ink);text-decoration:none;border-bottom:1px solid var(--line-strong)}',
    '.markdown-body a:hover{color:var(--accent)}',
    '.markdown-body strong{color:var(--ink);font-weight:600}',
    '.markdown-body ul,.markdown-body ol{margin:0 0 1.05em;padding-left:1.5em}.markdown-body li{margin:.3em 0}.markdown-body ol>li::marker{color:var(--accent);font-weight:600}',
    '.markdown-body li:has(>input[type=checkbox]){list-style:none;margin-left:-1.35em}',
    '.markdown-body input[type=checkbox]{appearance:none;-webkit-appearance:none;width:15px;height:15px;margin:0 .55em 0 0;vertical-align:-2px;border:1.5px solid var(--line-strong);border-radius:5px;background:var(--surface);position:relative}',
    '.markdown-body input[type=checkbox]:checked{background:var(--accent);border-color:var(--accent)}',
    '.markdown-body input[type=checkbox]:checked::after{content:"";position:absolute;left:4px;top:.5px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}',
    '.markdown-body blockquote{margin:1.3em 0;padding:.85em 1.15em;border-left:3px solid var(--accent);border-radius:0 11px 11px 0;background:var(--accent-soft);font-style:italic}',
    '.markdown-body blockquote>:last-child{margin-bottom:0}',
    '.markdown-body hr{height:1px;margin:2.4em 0;border:0;background:var(--line-strong)}',
    '.markdown-body img{max-width:100%;height:auto;border-radius:11px}',
    '.markdown-body table{width:100%;margin:1.4em 0;border-collapse:separate;border-spacing:0;font-size:.93em;font-family:"Space Grotesk",system-ui,sans-serif;border:1px solid var(--line);border-radius:11px;overflow:hidden}',
    '.markdown-body th,.markdown-body td{padding:9px 14px;text-align:left;border-bottom:1px solid var(--line)}',
    '.markdown-body th[align=center],.markdown-body td[align=center]{text-align:center}.markdown-body th[align=right],.markdown-body td[align=right]{text-align:right}',
    '.markdown-body thead th{background:var(--surface-2);color:var(--ink);font-weight:600}',
    '.markdown-body tbody tr:nth-child(even){background:var(--surface-2)}',
    '.markdown-body :not(pre)>code{font-family:"JetBrains Mono",Consolas,monospace;font-size:.845em;padding:.18em .42em;border:1px solid var(--line);border-radius:6px;background:var(--code-inline-bg);color:var(--accent-ink);white-space:nowrap}',
    '.markdown-body .code-block{position:relative;margin:1.4em 0}',
    '.markdown-body pre{margin:0;padding:18px;background:var(--code-bg);border:1px solid var(--line);border-radius:11px;overflow-x:auto;font-size:13.5px;line-height:1.65}',
    '.markdown-body .code-block[data-lang] pre{padding-top:42px}',
    '.markdown-body .code-block[data-lang]::before{content:attr(data-lang);position:absolute;top:8px;left:14px;font-family:"Space Grotesk",system-ui,sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-mute)}',
    '.markdown-body pre code{font-family:"JetBrains Mono",Consolas,monospace;background:transparent;padding:0;border:0;white-space:pre;color:var(--ink-soft)}',
    '.markdown-body .mermaid-block{margin:1.4em 0;padding:20px 16px;border:1px solid var(--line);border-radius:11px;background:var(--surface-2);overflow-x:auto;text-align:center}',
    '.markdown-body .mermaid-block svg{max-width:100%;height:auto}',
    '.markdown-body .mermaid-error{margin:1.4em 0;padding:13px 15px;border:1px solid var(--line-strong);border-left:3px solid #b91c1c;border-radius:11px;background:var(--surface-2);font-family:"Space Grotesk",system-ui,sans-serif;font-size:13px}',
    '.markdown-body .mermaid-error strong{display:block}',
    '.markdown-body .hljs{color:#24292e;background:transparent}',
    'html[data-theme="dark"] .markdown-body .hljs{color:#d6cfc2}',
    '.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-type{color:#a3182c}',
    '.hljs-string,.hljs-regexp{color:#1d6b48}',
    '.hljs-number{color:#0b5fb0}',
    '.hljs-comment,.hljs-quote{color:#8a8173;font-style:italic}',
    '.hljs-title,.hljs-section,.hljs-title.function_{color:#8a3fa0}',
    '.hljs-attr,.hljs-attribute,.hljs-built_in{color:#b45309}',
    'html[data-theme="dark"] .hljs-keyword,html[data-theme="dark"] .hljs-selector-tag,html[data-theme="dark"] .hljs-literal{color:#f0a8b4}',
    'html[data-theme="dark"] .hljs-string,html[data-theme="dark"] .hljs-regexp{color:#a5d6b0}',
    'html[data-theme="dark"] .hljs-number{color:#8fb8f0}',
    'html[data-theme="dark"] .hljs-comment,html[data-theme="dark"] .hljs-quote{color:#7d7566}',
    'html[data-theme="dark"] .hljs-title,html[data-theme="dark"] .hljs-section,html[data-theme="dark"] .hljs-title.function_{color:#d3aef2}',
    'html[data-theme="dark"] .hljs-attr,html[data-theme="dark"] .hljs-attribute,html[data-theme="dark"] .hljs-built_in{color:#f3b071}',
    '.theme-toggle{position:fixed;top:16px;right:16px;z-index:10;height:34px;padding:0 14px;border:1px solid var(--line-strong);border-radius:99px;background:var(--surface);color:var(--ink-soft);font-family:"Space Grotesk",system-ui,sans-serif;font-size:12.5px;font-weight:500;cursor:pointer}',
    '.theme-toggle:hover{color:var(--accent);border-color:var(--accent)}',
    '@media print{body{background:#fff;color:#000}.theme-toggle{display:none}.doc{max-width:none;padding:0}.markdown-body a{color:#000;border:0}.markdown-body a[href^="http"]::after{content:" (" attr(href) ")";font-size:.8em;color:#555}}'
  ].join('\n');

  /* ---------- Sample / initial content ---------- */
  function initialContent() {
    var stored = store.get(K.content);
    if (stored !== null && stored !== undefined) {
      return { text: stored, name: store.get(K.fileName) || 'sample.md' };
    }
    var fallback = document.getElementById('sample-fallback');
    var text = fallback ? fallback.textContent.replace(/^\s*\n/, '') : '# MDView\n\nStart writing…\n';
    return { text: text, name: 'sample.md' };
  }

  /* ---------- Wiring ---------- */
  function initEvents() {
    editor.addEventListener('input', function () {
      store.set(K.content, editor.value);
      scheduleRender();
    });

    // Keep tab key inside the textarea as a tab character.
    editor.addEventListener('keydown', function (ev) {
      if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        editor.value = editor.value.slice(0, start) + '  ' + editor.value.slice(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        store.set(K.content, editor.value);
        scheduleRender();
      }
    });

    previewScroll.addEventListener('scroll', onPreviewScroll, { passive: true });

    themeBtn.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      applyTheme(next, true);
      // Mermaid output is theme-dependent — drop the cache and re-render.
      mermaidSignature = next === 'dark' ? 'dark' : 'default';
      mermaidCache.clear();
      initMermaid();
      render();
    });

    tocBtn.addEventListener('click', function () {
      setTocOpen(mainEl.classList.contains('toc-closed'), true);
    });
    tocClose.addEventListener('click', function () { setTocOpen(false, true); });
    scrim.addEventListener('click', function () { setTocOpen(false, true); });

    exportBtn.addEventListener('click', exportHtml);

    viewToggle.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button[data-view]') : null;
      if (btn) setView(btn.dataset.view, true);
    });

    document.addEventListener('keydown', function (ev) {
      var mod = ev.ctrlKey || ev.metaKey;
      if (!mod) {
        if (ev.key === 'Escape') {
          if (!dropOverlay.hidden) dropOverlay.hidden = true;
          else if (isMobile() && !mainEl.classList.contains('toc-closed')) setTocOpen(false, true);
        }
        return;
      }
      var key = ev.key.toLowerCase();
      if (key === 'o') { ev.preventDefault(); fileInput.click(); }
      else if (key === 's') { ev.preventDefault(); exportHtml(); }
      else if (key === '\\') { ev.preventDefault(); setTocOpen(mainEl.classList.contains('toc-closed'), true); }
    });

    // Switch default outline state when crossing the desktop/mobile boundary.
    var wasMobile = isMobile();
    window.addEventListener('resize', debounce(function () {
      var nowMobile = isMobile();
      if (nowMobile !== wasMobile) {
        wasMobile = nowMobile;
        if (nowMobile) {
          setTocOpen(false, false);
        } else {
          setTocOpen(store.get(K.tocOpen) !== '0', false);
        }
      }
      updateScrim();
    }, 120));

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (ev) {
        // Only follow the OS when the user has not made a choice.
        if (store.get(K.theme) === null) {
          applyTheme(ev.matches ? 'dark' : 'light', false);
          mermaidSignature = ev.matches ? 'dark' : 'default';
          mermaidCache.clear();
          initMermaid();
          render();
        }
      });
    }
  }

  /* ---------- Boot ---------- */
  function boot() {
    // Theme was applied by the inline head script; read it back.
    var theme = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(theme, false);
    mermaidSignature = theme === 'dark' ? 'dark' : 'default';

    // Restore pane layout.
    var split = parseFloat(store.get(K.split));
    setSplit(isNaN(split) ? 50 : split);

    var savedView = store.get(K.view);
    setView(savedView === 'preview' ? 'preview' : 'editor', false);

    var tocPref = store.get(K.tocOpen);
    var open = tocPref === null ? !isMobile() : tocPref !== '0';
    setTocOpen(open, false);

    var markedReady = registerMarked();

    initMermaid();
    initEvents();
    initDivider();
    initFileInput();
    initDragDrop();

    var seed = initialContent();
    editor.value = seed.text;
    fileNameEl.textContent = seed.name;
    render();

    if (!markedReady) {
      toast('Markdown parser unavailable — showing source.', true);
    }
    if (!mermaidOK) {
      toast('Mermaid unavailable — diagrams will show as text.', true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
