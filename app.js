/* Paper — a local-first notepad.
   Everything lives in localStorage under one key. No server, no account. */

(function () {
  'use strict';

  var KEY = 'paper.v1';
  var EMPTY_DOC = '<p><br></p>';

  var $ = function (id) { return document.getElementById(id); };
  var tree = $('tree'), tabsEl = $('tabs'), editor = $('editor'),
      wrap = $('editor-wrap'), emptyEl = $('empty'), metaEl = $('meta'),
      toolbar = $('toolbar');

  /* ------------------------------------------------------------- state */

  var db = load();

  function blank() {
    return {
      folders: [], notes: [], tabs: [], active: null,
      collapsed: {}, sideHidden: false,
      theme: 'auto', palette: 'paper', width: 'normal', size: 'medium'
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      var d = JSON.parse(raw);
      var base = blank();
      for (var k in base) if (!(k in d)) d[k] = base[k];
      return d;
    } catch (e) {
      console.warn('Could not read saved notes, starting fresh.', e);
      return blank();
    }
  }

  var saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    var write = function () {
      try {
        localStorage.setItem(KEY, JSON.stringify(db));
      } catch (e) {
        // Was written into the status bar, where updateMeta() promptly wiped it.
        toast('Could not save — browser storage is full.');
        console.error(e);
      }
    };
    if (now) write(); else saveTimer = setTimeout(write, 400);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ------------------------------------------------- dialog + toast (no native)

     Replaces prompt()/confirm()/alert(). The only OS-level UI left is the file
     picker behind Import, which a page can't draw for itself. */

  var scrim = $('scrim'), pendingConfirm = null, focusBeforeDialog = null;

  function ask(opts, onConfirm) {
    $('dlg-title').textContent = opts.title;
    $('dlg-body').textContent = opts.body || '';
    $('dlg-body').hidden = !opts.body;
    $('dlg-ok').textContent = opts.confirm || 'OK';

    pendingConfirm = onConfirm;
    focusBeforeDialog = document.activeElement;
    scrim.hidden = false;
    // Cancel takes focus: these actions are destructive and nothing here is undoable.
    $('dlg-cancel').focus();
  }

  function closeDialog(proceed) {
    if (scrim.hidden) return;
    scrim.hidden = true;
    var fn = pendingConfirm;
    pendingConfirm = null;
    if (focusBeforeDialog && focusBeforeDialog.focus) focusBeforeDialog.focus();
    focusBeforeDialog = null;
    if (proceed && fn) fn();
  }

  $('dlg-cancel').onclick = function () { closeDialog(false); };
  $('dlg-ok').onclick     = function () { closeDialog(true); };
  scrim.onclick = function (e) { if (e.target === scrim) closeDialog(false); };

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3400);
  }

  function note(id) {
    for (var i = 0; i < db.notes.length; i++) if (db.notes[i].id === id) return db.notes[i];
    return null;
  }

  function folder(id) {
    for (var i = 0; i < db.folders.length; i++) if (db.folders[i].id === id) return db.folders[i];
    return null;
  }

  /* ------------------------------------------------------------ titles */

  // The title is just the first line of the note. No naming dialogs.
  function titleOf(n) {
    if (!n) return 'Untitled';
    var tmp = document.createElement('div');
    tmp.innerHTML = n.html || '';
    // Each top-level node is one visual line; take the first one with text in it.
    var first = '';
    for (var i = 0; i < tmp.childNodes.length && !first; i++) {
      first = (tmp.childNodes[i].textContent || '').replace(/\s+/g, ' ').trim();
    }
    return first ? first.slice(0, 60) : 'Untitled';
  }

  /* ------------------------------------------------------------ actions */

  function createNote(folderId) {
    var n = {
      id: uid(),
      folderId: folderId || null,
      html: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    db.notes.unshift(n);
    if (folderId) db.collapsed[folderId] = false;
    openNote(n.id);
    save();
    editor.focus();
    return n;
  }

  // No naming dialog: the folder appears immediately and its name is already
  // selected in the sidebar, the same way a new note is just a blank page.
  function createFolder() {
    var f = { id: uid(), name: 'New folder', createdAt: Date.now() };
    db.folders.push(f);
    save();
    renderTree();

    var row = tree.querySelector('[data-folder="' + f.id + '"]');
    if (row) beginRename(f, row.querySelector('.name'), true);
  }

  function deleteNote(id) {
    var n = note(id);
    if (!n) return;
    ask({
      title: 'Delete “' + titleOf(n) + '”?',
      body: 'This cannot be undone.',
      confirm: 'Delete'
    }, function () {
      db.notes = db.notes.filter(function (x) { return x.id !== id; });
      closeTab(id, true);
      save();
      render();
      // closeTab was silent, so the editor is still showing the note we just
      // deleted. Without this the next keystroke flushes that stale text into
      // whichever note the tab bar switched to.
      loadIntoEditor();
    });
  }

  function deleteFolder(id) {
    var f = folder(id);
    if (!f) return;
    var inside = db.notes.filter(function (n) { return n.folderId === id; });
    ask({
      title: 'Delete “' + f.name + '”?',
      body: inside.length
        ? 'The ' + inside.length + ' note' + (inside.length > 1 ? 's' : '') +
          ' inside will be deleted too. This cannot be undone.'
        : 'This cannot be undone.',
      confirm: 'Delete'
    }, function () {
      inside.forEach(function (n) { closeTab(n.id, true); });
      db.notes = db.notes.filter(function (n) { return n.folderId !== id; });
      db.folders = db.folders.filter(function (x) { return x.id !== id; });
      save();
      render();
      loadIntoEditor();   // same stale-editor hazard as deleteNote
    });
  }

  // Rename happens in place in the sidebar rather than through a dialog, to
  // match the way note titles are just the first line you type.
  var renaming = null;

  // `isNew` means the folder was created by this rename; abandoning it (Escape,
  // or leaving the name blank) removes it rather than leaving "New folder".
  function beginRename(f, nameEl, isNew) {
    if (renaming) return;
    renaming = f.id;

    var original = f.name, settled = false;
    nameEl.contentEditable = 'true';
    nameEl.spellcheck = false;
    nameEl.classList.add('editing');
    nameEl.focus();

    var r = document.createRange();
    r.selectNodeContents(nameEl);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    function settle(commit) {
      if (settled) return;
      settled = true;
      renaming = null;
      nameEl.contentEditable = 'false';
      nameEl.classList.remove('editing');

      var next = (nameEl.textContent || '').replace(/\s+/g, ' ').trim();
      var keep = commit && next;

      if (keep && next !== original) {
        f.name = next;
        save();
      } else if (!keep && isNew) {
        db.folders = db.folders.filter(function (x) { return x.id !== f.id; });
        save();
      }
      renderTree();   // redraws from state, so a cancel puts the old name back
    }

    // Swallow keys so the app's ⌘-shortcuts don't fire while typing a name.
    nameEl.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter')       { e.preventDefault(); settle(true); }
      else if (e.key === 'Escape') { e.preventDefault(); settle(false); }
    });
    nameEl.addEventListener('blur', function () { settle(true); });
  }

  /* --------------------------------------------------------------- tabs */

  function openNote(id) {
    if (db.tabs.indexOf(id) === -1) db.tabs.push(id);
    setActive(id);
  }

  function setActive(id) {
    if (db.active === id) { render(); return; }
    flush();                       // persist whatever is in the editor now
    db.active = id;
    save();
    render();
    loadIntoEditor();
  }

  function closeTab(id, silent) {
    var i = db.tabs.indexOf(id);
    if (i === -1) return;
    if (db.active === id) flush();
    db.tabs.splice(i, 1);
    if (db.active === id) {
      db.active = db.tabs[Math.min(i, db.tabs.length - 1)] || null;
      if (!silent) { render(); loadIntoEditor(); }
    }
    save();
    if (!silent) render();
  }

  /* ------------------------------------------------------------- editor */

  var loading = false;

  function loadIntoEditor() {
    var n = note(db.active);
    loading = true;
    // Start with a real block so the first line is a paragraph, not loose text.
    editor.innerHTML = n ? (n.html || EMPTY_DOC) : '';
    loading = false;
    updateBlankClass();
    countDoc();
    updateMeta();
    if (n) editor.focus();
    syncToolbar();   // otherwise the previous note's active marks stay lit
  }

  // Persist the editor's current contents into the active note.
  function flush() {
    var n = note(db.active);
    if (!n) return;
    var html = editor.innerHTML;
    if (!editor.textContent.trim() && !editor.querySelector('img, hr')) html = '';
    if (html === n.html) return;
    n.html = html;
    n.updatedAt = Date.now();
  }

  // Typing into a fresh contenteditable produces a bare text node rather than a
  // block, which throws off both the title styling and the one-node-per-line
  // assumption in titleOf(). Wrap any stray top-level text back into a <p>.
  function normalizeBlocks() {
    for (var i = 0; i < editor.childNodes.length; i++) {
      if (editor.childNodes[i].nodeType === 3 && editor.childNodes[i].textContent.trim()) {
        document.execCommand('formatBlock', false, 'p');
        return;
      }
    }
  }

  // execCommand's list commands wrap the list in the paragraph it replaced,
  // giving <p><ul>…</ul></p>. That's invalid, and innerHTML re-parses it as a
  // stray empty <p> plus the list on reload, which shifts every block down one.
  function unwrapLists() {
    var lists = editor.querySelectorAll('p > ul, p > ol');
    for (var i = 0; i < lists.length; i++) {
      var list = lists[i], p = list.parentNode;
      if (p.textContent.trim() === list.textContent.trim()) {
        p.parentNode.replaceChild(list, p);
      }
    }
  }

  function onInput() {
    if (loading) return;
    normalizeBlocks();
    unwrapLists();
    flush();
    updateBlankClass();
    countDoc();
    updateMeta();
    renderTabs();
    renderTree();
    save();
  }

  function updateBlankClass() {
    var empty = !editor.textContent.trim() && !editor.querySelector('img, hr');
    editor.classList.toggle('blank', empty);
  }

  /* --------------------------------------------------------------- counts */

  // Blocks that render on their own line. A block containing another block (a
  // <ul>, or a <blockquote> wrapping a <p>) isn't a line itself — its children
  // are — so only the innermost ones count.
  var BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div';

  function leafBlocks(root) {
    return Array.prototype.filter.call(root.querySelectorAll(BLOCKS), function (el) {
      return !el.querySelector(BLOCKS);
    });
  }

  function lineTexts(root) {
    var out = leafBlocks(root).map(function (el) { return el.textContent; });
    // A note with no block markup at all is still one line.
    if (!out.length) out.push(root.textContent);
    return out;
  }

  // `text` keeps its newlines so words can't fuse across a line break; they are
  // stripped for the character count so line breaks aren't counted as typing.
  function statsOf(text, lineCount) {
    return {
      words: (text.trim().match(/\S+/g) || []).length,
      chars: text.replace(/\r?\n/g, '').length,
      lines: lineCount
    };
  }

  function plural(n, noun) { return n + ' ' + noun + (n === 1 ? '' : 's'); }

  function phrase(s) {
    return plural(s.words, 'word') + ' · ' +
           plural(s.chars, 'character') + ' · ' +
           plural(s.lines, 'line');
  }

  // Recomputed only when the text changes; a caret move shouldn't re-walk the
  // whole document.
  var docStats = { words: 0, chars: 0, lines: 0 };

  function countDoc() {
    var lines = lineTexts(editor);
    docStats = statsOf(lines.join('\n'), lines.length);
  }

  // Stats for the current selection, or null if there isn't one in the editor.
  // Lines are counted by which blocks the range touches rather than by splitting
  // the selected string, so "select all" agrees with the document's own count.
  function selectionStats() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    if (!editor.contains(sel.anchorNode) || !editor.contains(sel.focusNode)) return null;

    var text = sel.toString();
    if (!text) return null;

    var range = sel.getRangeAt(0);
    // Blank lines count here exactly as they do in the document total.
    var touched = leafBlocks(editor).filter(function (el) {
      return range.intersectsNode(el);
    }).length;

    return statsOf(text, Math.max(touched, 1));
  }

  function updateMeta() {
    var n = note(db.active);
    if (!n) { metaEl.textContent = ''; return; }

    var picked = selectionStats();
    if (picked) {
      metaEl.textContent = phrase(picked) + ' selected';
    } else {
      metaEl.textContent = phrase(docStats) + ' · ' + when(n.updatedAt);
    }
  }

  function when(ts) {
    var d = new Date(ts), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  /* ---------------------------------------------------------- rendering */

  function render() {
    renderTree();
    renderTabs();
    var has = !!note(db.active);
    wrap.hidden = !has;
    emptyEl.hidden = has;
    document.body.classList.toggle('side-hidden', !!db.sideHidden);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var GLYPHS = {
    plus:   ['M8 3.75v8.5', 'M3.75 8h8.5'],
    pencil: ['M11.3 2.7l2 2-7.15 7.15-2.6.6.6-2.6z', 'M10.1 3.9l2 2'],
    times:  ['M4.2 4.2l7.6 7.6', 'M11.8 4.2l-7.6 7.6']
  };

  // A hover action on a tree row: small stroked icon, click handler, tooltip.
  function rowAction(glyph, label, onClick) {
    var span = el('span', 'act');
    span.title = label;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    GLYPHS[glyph].forEach(function (d) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    span.appendChild(svg);
    span.onclick = function (e) { e.stopPropagation(); onClick(); };
    return span;
  }

  function noteRow(n, nested) {
    var row = el('div', 'row note' + (nested ? ' nested' : '') + (n.id === db.active ? ' active' : ''));
    row.draggable = true;
    row.appendChild(el('span', 'name', titleOf(n)));
    row.appendChild(rowAction('times', 'Delete note', function () { deleteNote(n.id); }));
    row.onclick = function () { openNote(n.id); };
    row.ondragstart = function (e) {
      e.dataTransfer.setData('text/plain', n.id);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    };
    row.ondragend = function () { row.classList.remove('dragging'); };
    return row;
  }

  function renderTree() {
    tree.innerHTML = '';

    db.folders.forEach(function (f) {
      var open = !db.collapsed[f.id];
      var row = el('div', 'row folder' + (open ? ' open' : ''));
      row.setAttribute('data-folder', f.id);
      row.appendChild(el('span', 'caret', '▶'));

      var nameEl = el('span', 'name folder-name', f.name);
      row.appendChild(nameEl);

      row.appendChild(rowAction('plus', 'New note in ' + f.name, function () {
        createNote(f.id);
      }));
      row.appendChild(rowAction('pencil', 'Rename folder', function () {
        beginRename(f, nameEl);
      }));
      row.appendChild(rowAction('times', 'Delete folder', function () {
        deleteFolder(f.id);
      }));

      row.onclick = function () {
        if (renaming) return;   // don't collapse out from under the field
        db.collapsed[f.id] = open;
        save();
        renderTree();
      };
      row.ondblclick = function () { beginRename(f, nameEl); };

      row.ondragover = function (e) { e.preventDefault(); row.classList.add('drop-target'); };
      row.ondragleave = function () { row.classList.remove('drop-target'); };
      row.ondrop = function (e) {
        e.preventDefault();
        row.classList.remove('drop-target');
        var n = note(e.dataTransfer.getData('text/plain'));
        if (!n) return;
        n.folderId = f.id;
        db.collapsed[f.id] = false;
        save();
        renderTree();
      };

      tree.appendChild(row);

      if (open) {
        db.notes.filter(function (n) { return n.folderId === f.id; })
                .forEach(function (n) { tree.appendChild(noteRow(n, true)); });
      }
    });

    var loose = db.notes.filter(function (n) {
      return !n.folderId || !folder(n.folderId);
    });
    loose.forEach(function (n) { tree.appendChild(noteRow(n, false)); });

    if (!db.notes.length && !db.folders.length) {
      tree.appendChild(el('div', 'empty-hint', 'No notes yet.'));
    }
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    db.tabs.forEach(function (id) {
      var n = note(id);
      if (!n) return;
      var t = el('div', 'tab' + (id === db.active ? ' active' : ''));
      t.appendChild(el('span', 'label', titleOf(n)));
      var x = el('span', 'x', '×');
      x.onclick = function (e) { e.stopPropagation(); closeTab(id); };
      t.appendChild(x);
      t.onclick = function () { setActive(id); };
      t.onauxclick = function (e) { if (e.button === 1) { e.preventDefault(); closeTab(id); } };
      tabsEl.appendChild(t);
    });
  }

  /* ----------------------------------------------------- formatting bar */

  function exec(cmd, arg) {
    editor.focus();
    document.execCommand(cmd, false, arg || null);
    onInput();
    syncToolbar();
  }

  toolbar.addEventListener('mousedown', function (e) {
    // keep the selection alive while the button is pressed
    if (e.target.closest('button')) e.preventDefault();
  });

  toolbar.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.cmd) return exec(btn.dataset.cmd);
    if (btn.dataset.block) {
      var cur = currentBlock();
      var want = btn.dataset.block.toUpperCase();
      exec('formatBlock', cur === want ? 'P' : want);
    }
  });

  function currentBlock() {
    try { return (document.queryCommandValue('formatBlock') || '').toUpperCase(); }
    catch (e) { return ''; }
  }

  // Inline tags that each command produces. queryCommandState() can't be used
  // here: it reports the *computed* font-weight, so it claims "bold" anywhere
  // the stylesheet sets one — every title and heading — and the button would
  // sit lit on lines the user never bolded.
  var MARKS = {
    bold:          ['B', 'STRONG'],
    italic:        ['I', 'EM'],
    underline:     ['U'],
    strikeThrough: ['S', 'STRIKE', 'DEL'],
    insertUnorderedList: ['UL'],
    insertOrderedList:   ['OL']
  };

  function inMark(tags) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return false;
    var n = sel.getRangeAt(0).startContainer;
    while (n && n !== editor) {
      if (n.nodeType === 1 && tags.indexOf(n.nodeName) > -1) return true;
      n = n.parentNode;
    }
    return false;
  }

  function syncToolbar() {
    var block = currentBlock();
    Array.prototype.forEach.call(toolbar.querySelectorAll('button'), function (b) {
      var on = false;
      if (b.dataset.cmd && MARKS[b.dataset.cmd]) on = inMark(MARKS[b.dataset.cmd]);
      if (b.dataset.block) on = block === b.dataset.block.toUpperCase();
      b.classList.toggle('on', on);
    });
  }

  document.addEventListener('selectionchange', function () {
    if (document.activeElement === editor) syncToolbar();
    updateMeta();   // counts follow the selection
  });

  /* -------------------------------------------------------------- paste */

  editor.addEventListener('paste', function (e) {
    // Paste as plain text — keeps the document clean of foreign markup.
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  editor.addEventListener('input', onInput);
  editor.addEventListener('blur', function () { flush(); save(true); });

  /* ---------------------------------------------------------- shortcuts */

  document.addEventListener('keydown', function (e) {
    if (!scrim.hidden) {
      // The dialog owns the keyboard while it's up.
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(false); }
      return;
    }

    var mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    var k = e.key.toLowerCase();

    if (k === 'n' && e.shiftKey) { e.preventDefault(); createNote(activeFolder()); return; }
    if (k === 's')               { e.preventDefault(); flush(); save(true); return; }
    if (k === '\\')              { e.preventDefault(); toggleSidebar(); return; }
    if (k === 'w' && e.shiftKey) { e.preventDefault(); if (db.active) closeTab(db.active); return; }
  });

  function activeFolder() {
    var n = note(db.active);
    return n ? n.folderId : null;
  }

  function toggleSidebar() {
    db.sideHidden = !db.sideHidden;
    save();
    document.body.classList.toggle('side-hidden', db.sideHidden);
  }

  /* -------------------------------------------- appearance: theme/width/size */

  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  var WIDTHS   = { narrow: '620px', normal: '720px', wide: '880px' };
  var SIZES    = { small:  '16px',  medium: '18px',  large: '20px' };
  var PALETTES = { paper: 1, mono: 1, white: 1 };

  // Light up the chosen segment in one of the sidebar's little control rows.
  function markSegs(rowId, dataKey, value) {
    Array.prototype.forEach.call($(rowId).querySelectorAll('.seg'), function (b) {
      b.classList.toggle('on', b.dataset[dataKey] === value);
    });
  }

  // Point a control row at a state field; re-applies and saves on click.
  function wireSegs(rowId, dataKey, field) {
    $(rowId).addEventListener('click', function (e) {
      var b = e.target.closest('.seg');
      if (!b) return;
      db[field] = b.dataset[dataKey];
      save();
      applyAppearance();
    });
  }

  function applyAppearance() {
    var theme   = db.theme || 'auto';
    var palette = PALETTES[db.palette] ? db.palette : 'paper';
    var width   = WIDTHS[db.width]     ? db.width   : 'normal';
    var size    = SIZES[db.size]       ? db.size    : 'medium';

    // Colour is two independent axes: palette picks the hue, theme picks light
    // or dark within it. The stylesheet pairs them.
    var dark = theme === 'dark' || (theme === 'auto' && systemDark.matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.palette = palette;

    root.style.setProperty('--measure', WIDTHS[width]);
    root.style.setProperty('--text-size', SIZES[size]);

    markSegs('theme',   'themePref', theme);
    markSegs('palette', 'palette',   palette);
    markSegs('width',   'width',     width);
    markSegs('size',    'size',      size);
  }

  wireSegs('theme',   'themePref', 'theme');
  wireSegs('palette', 'palette',   'palette');
  wireSegs('width',   'width',     'width');
  wireSegs('size',    'size',      'size');

  // Only matters while the preference is "auto".
  var onSystemChange = function () { if ((db.theme || 'auto') === 'auto') applyAppearance(); };
  if (systemDark.addEventListener) systemDark.addEventListener('change', onSystemChange);
  else systemDark.addListener(onSystemChange);

  /* ------------------------------------------------------ export/import */

  function exportJSON() {
    var blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'paper-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  $('import-file').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var d;
      try {
        d = JSON.parse(reader.result);
        if (!Array.isArray(d.notes)) throw new Error('Not a Paper backup');
      } catch (err) {
        toast('That file doesn’t look like a Paper backup.');
        return;
      }
      ask({
        title: 'Replace everything with this backup?',
        body: 'Your current ' + db.notes.length + ' note' + (db.notes.length === 1 ? '' : 's') +
              ' will be discarded and ' + d.notes.length + ' restored. This cannot be undone.',
        confirm: 'Replace'
      }, function () {
        db = Object.assign(blank(), d);
        save(true);
        applyAppearance();
        render();
        loadIntoEditor();
        toast('Restored ' + d.notes.length + ' note' + (d.notes.length === 1 ? '' : 's') + '.');
      });
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  /* --------------------------------------------------------------- wire */

  $('new-note').onclick    = function () { createNote(activeFolder()); };
  $('new-folder').onclick  = createFolder;
  $('empty-new').onclick   = function () { createNote(null); };
  $('toggle-side').onclick = toggleSidebar;
  $('export').onclick      = exportJSON;
  $('import').onclick      = function () { $('import-file').click(); };

  window.addEventListener('beforeunload', function () { flush(); save(true); });

  /* --------------------------------------------------------------- boot */

  // Prune tabs pointing at deleted notes.
  db.tabs = db.tabs.filter(function (id) { return !!note(id); });
  if (!note(db.active)) db.active = db.tabs[db.tabs.length - 1] || null;

  if (!db.notes.length) {
    // First run: just put a cursor on a blank page.
    createNote(null);
  } else if (!db.active) {
    openNote(db.notes[0].id);
  }

  applyAppearance();
  render();
  loadIntoEditor();
})();
