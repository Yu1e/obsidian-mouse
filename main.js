'use strict';

/*
 * Yule Link Menu — собственное контекстное меню для ссылок.
 * Работает в Live Preview и в режиме исходного кода.
 * Shift + правый щелчок — родное меню Obsidian.
 *
 * Этап 1 (каркас): распознавание всех типов ссылок, меню с подменю,
 * настройки размещения пунктов, базовые действия.
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Menu, Notice, MarkdownView } = obsidian;

/* ------------------------------------------------------------------ */
/*  Знаки типов (как в таблице отбора)                                 */
/* ------------------------------------------------------------------ */

const T = {
  WIKI: '[[',
  HTTP: 'http',
  A: '<a',
  FILE: 'file:/',
  EWIKI: '![[',
  EHTTP: '!http',
  EFILE: '![](file:/',
  IFRAME: '<iframe',
  SUB: '#',
  NEW: '[[нов'
};

/* ------------------------------------------------------------------ */
/*  Разбор ссылок в строке                                             */
/* ------------------------------------------------------------------ */

function isEscaped(s, i) {
  let n = 0;
  for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

function parseWiki(line) {
  const out = [];
  const re = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
  let m;
  while ((m = re.exec(line))) {
    if (isEscaped(line, m.index)) continue;
    const embed = m[1] === '!';
    const innerFrom = m.index + m[1].length + 2;
    const inner = m[2];
    const pipe = inner.indexOf('|');
    let destLen = pipe < 0 ? inner.length : pipe;
    let escapedPipe = false;
    if (pipe > 0 && inner[pipe - 1] === '\\') {
      escapedPipe = true;
      destLen = pipe - 1;
    }
    const dest = inner.slice(0, destLen);
    const hash = dest.indexOf('#');
    out.push({
      kind: 'wiki',
      embed: embed,
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      dest: dest,
      destFrom: innerFrom,
      destTo: innerFrom + destLen,
      text: pipe < 0 ? null : inner.slice(pipe + 1),
      textFrom: pipe < 0 ? null : innerFrom + pipe + 1,
      textTo: pipe < 0 ? null : innerFrom + inner.length,
      insertTextAt: innerFrom + inner.length,
      escapedPipe: escapedPipe,
      linkpath: hash < 0 ? dest : dest.slice(0, hash),
      subpath: hash < 0 ? '' : dest.slice(hash),
      destType: 'vault'
    });
  }
  return out;
}

function parseMd(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '[' || isEscaped(line, i)) continue;
    if (line[i + 1] === '[' || line[i - 1] === '[') continue;

    // закрывающая ] с учётом вложенных скобок
    let depth = 0;
    let j = i;
    for (; j < line.length; j++) {
      const c = line[j];
      if (c === '\\') { j++; continue; }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) break; }
    }
    if (j >= line.length || line[j + 1] !== '(') continue;

    // адрес
    let k = j + 2;
    let destFrom, destTo;
    let angle = false;
    if (line[k] === '<') {
      const e = line.indexOf('>', k + 1);
      if (e < 0) continue;
      angle = true;
      destFrom = k + 1;
      destTo = e;
      k = e + 1;
    } else {
      let pd = 0;
      destFrom = k;
      for (; k < line.length; k++) {
        const c = line[k];
        if (c === '\\') { k++; continue; }
        if (c === '(') pd++;
        else if (c === ')') { if (pd === 0) break; pd--; }
        else if (c === ' ') break;
      }
      destTo = k;
    }

    // необязательный title в кавычках
    while (line[k] === ' ') k++;
    if (line[k] === '"' || line[k] === "'") {
      const q = line[k];
      const e = line.indexOf(q, k + 1);
      if (e < 0) continue;
      k = e + 1;
      while (line[k] === ' ') k++;
    }
    if (line[k] !== ')') continue;

    const embed = i > 0 && line[i - 1] === '!' && !isEscaped(line, i - 1);
    const from = embed ? i - 1 : i;
    const to = k + 1;
    out.push({
      kind: 'md',
      embed: embed,
      from: from,
      to: to,
      raw: line.slice(from, to),
      dest: line.slice(destFrom, destTo),
      destFrom: destFrom,
      destTo: destTo,
      angle: angle,
      text: line.slice(i + 1, j),
      textFrom: i + 1,
      textTo: j
    });
    i = k;
  }
  return out;
}

function parseHtmlA(line) {
  const out = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(line))) {
    const raw = m[0];
    const q = m[1] + m[2] + m[1];
    const qi = raw.indexOf(q);
    const destFrom = m.index + qi + 1;
    const openEnd = m.index + raw.indexOf('>', qi + q.length) + 1;
    out.push({
      kind: 'html',
      embed: false,
      from: m.index,
      to: m.index + raw.length,
      raw: raw,
      dest: m[2],
      destFrom: destFrom,
      destTo: destFrom + m[2].length,
      text: m[3],
      textFrom: openEnd,
      textTo: openEnd + m[3].length
    });
  }
  return out;
}

function parseIframe(line) {
  const out = [];
  const re = /<iframe\b[^>]*?\bsrc\s*=\s*(["'])([^"']*)\1[^>]*>(?:[\s\S]*?<\/iframe\s*>)?/gi;
  let m;
  while ((m = re.exec(line))) {
    const raw = m[0];
    const q = m[1] + m[2] + m[1];
    const destFrom = m.index + raw.indexOf(q) + 1;
    out.push({
      kind: 'iframe',
      embed: true,
      from: m.index,
      to: m.index + raw.length,
      raw: raw,
      dest: m[2],
      destFrom: destFrom,
      destTo: destFrom + m[2].length,
      text: null,
      textFrom: null,
      textTo: null
    });
  }
  return out;
}

function parseAuto(line) {
  const out = [];
  const re = /<((?:https?|file):\/\/[^\s<>]+)>/gi;
  let m;
  while ((m = re.exec(line))) {
    out.push({
      kind: 'auto',
      embed: false,
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      dest: m[1],
      destFrom: m.index + 1,
      destTo: m.index + 1 + m[1].length,
      text: null,
      textFrom: null,
      textTo: null
    });
  }
  return out;
}

function trimUrlTail(u) {
  let s = u;
  for (;;) {
    const last = s[s.length - 1];
    if ('.,;:!?»"\'”’'.indexOf(last) >= 0) { s = s.slice(0, -1); continue; }
    if (last === ')') {
      const open = (s.match(/\(/g) || []).length;
      const close = (s.match(/\)/g) || []).length;
      if (close > open) { s = s.slice(0, -1); continue; }
    }
    break;
  }
  return s;
}

function parseBare(line) {
  const out = [];
  const re = /(?:https?:\/\/|file:\/\/\/?)[^\s<>"'`\[\]]+/gi;
  let m;
  while ((m = re.exec(line))) {
    const url = trimUrlTail(m[0]);
    if (!url) continue;
    out.push({
      kind: 'bare',
      embed: false,
      from: m.index,
      to: m.index + url.length,
      raw: url,
      dest: url,
      destFrom: m.index,
      destTo: m.index + url.length,
      text: null,
      textFrom: null,
      textTo: null
    });
  }
  return out;
}

function findLinks(line) {
  const spans = [];
  const push = function (l) {
    for (const s of spans) if (l.from < s.to && s.from < l.to) return;
    spans.push(l);
  };
  parseWiki(line).forEach(push);
  parseMd(line).forEach(push);
  parseHtmlA(line).forEach(push);
  parseIframe(line).forEach(push);
  parseAuto(line).forEach(push);
  parseBare(line).forEach(push);
  return spans;
}

function classifyDest(dest) {
  const d = (dest || '').trim();
  if (/^https?:/i.test(d)) return 'http';
  if (/^file:/i.test(d)) return 'file';
  if (/^[a-z][a-z0-9+.\-]*:/i.test(d)) return 'url';
  return 'vault';
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/* Дополняет ссылку сведениями о цели и знаками типов */
function enrichLink(app, l, sourcePath) {
  if (l.kind !== 'wiki') l.destType = classifyDest(l.dest);

  if (l.kind === 'md' && l.destType === 'vault') {
    const h = l.dest.indexOf('#');
    l.linkpath = safeDecode(h < 0 ? l.dest : l.dest.slice(0, h));
    l.subpath = h < 0 ? '' : safeDecode(l.dest.slice(h));
  }

  if (l.destType === 'vault') {
    if (l.linkpath) {
      l.file = app.metadataCache.getFirstLinkpathDest(l.linkpath, sourcePath);
    } else {
      l.file = app.vault.getAbstractFileByPath(sourcePath);
    }
    l.unresolved = !l.file;
  }

  const t = new Set();
  if (l.destType === 'vault' && (l.kind === 'wiki' || l.kind === 'md')) {
    t.add(l.embed ? T.EWIKI : T.WIKI);
    if (l.subpath) t.add(T.SUB);
    if (l.unresolved) t.add(T.NEW);
  } else if (l.kind === 'html') {
    t.add(T.A);
  } else if (l.kind === 'iframe') {
    t.add(T.IFRAME);
  } else if (l.destType === 'file') {
    t.add(l.embed ? T.EFILE : T.FILE);
  } else {
    t.add(l.embed ? T.EHTTP : T.HTTP);
  }
  l.tags = t;
  return l;
}

/* ------------------------------------------------------------------ */
/*  Пути, адреса, буфер обмена                                         */
/* ------------------------------------------------------------------ */

function fileUrlToPath(u) {
  let s = (u || '').trim().replace(/^<|>$/g, '');
  const unc = /^file:\/\/[^\/]/i.test(s);
  s = s.replace(/^file:\/\/\/?/i, '');
  s = safeDecode(s);
  s = s.replace(/\//g, '\\');
  if (unc) s = '\\\\' + s;
  return s;
}

function destForCopy(l) {
  if (l.kind === 'wiki') return l.dest;
  return (l.dest || '').replace(/^<|>$/g, '');
}

function copyText(s, msg) {
  navigator.clipboard.writeText(s).then(
    function () { new Notice(msg || 'Скопировано'); },
    function () { new Notice('Не удалось скопировать в буфер'); }
  );
}

function electronShell() {
  try { return require('electron').shell; } catch (e) { return null; }
}

function vaultFullPath(app, file) {
  const ad = app.vault.adapter;
  return ad && typeof ad.getFullPath === 'function' ? ad.getFullPath(file.path) : null;
}

/* ------------------------------------------------------------------ */
/*  Текст ссылки: имя, заголовок, блок, чистка мусора (п. 30)          */
/* ------------------------------------------------------------------ */

function stripMarkup(s) {
  return s
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, function (m0, p) { const h = p.split('#'); return h[h.length - 1] || h[0]; })
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/==(.+?)==/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(^|\s)#[^\s#]+(?=\s*$)/g, '$1');
}

function cleanText(str, opt, isHeading) {
  const orig = str;
  let s = str;
  if (isHeading && opt.markup) s = stripMarkup(s);
  if (opt.emoji) s = s.replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\p{Emoji_Modifier}|\s)+/u, '');
  if (opt.underscores) s = s.replace(/_+/g, ' ');
  if (opt.edges) s = s.replace(/\s{2,}/g, ' ').replace(/^[\s.,;:–—-]+|[\s.,;:–—-]+$/g, '');
  s = s.replace(/[|\[\]]/g, '').trim();
  return s || orig.trim();
}

function nameOf(link, opt) {
  if (link.file) {
    if (link.file.extension === 'md' || opt.attachmentExt) return link.file.basename;
    return link.file.name;
  }
  const p = link.linkpath || '';
  let n = p.slice(p.lastIndexOf('/') + 1);
  if (/\.md$/i.test(n)) n = n.slice(0, -3);
  else if (opt.attachmentExt) n = n.replace(/\.[a-z0-9]{1,5}$/i, '');
  return n;
}

function headingOf(app, link) {
  const sp = link.subpath || '';
  if (!sp || sp.indexOf('#^') === 0) return null;
  if (link.file && typeof obsidian.resolveSubpath === 'function') {
    const cache = app.metadataCache.getFileCache(link.file);
    if (cache) {
      const r = obsidian.resolveSubpath(cache, sp);
      if (r && r.type === 'heading' && r.current) return r.current.heading;
    }
  }
  const parts = sp.split('#').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

async function blockTextOf(app, link, max) {
  const sp = link.subpath || '';
  if (sp.indexOf('#^') !== 0 || !link.file || typeof obsidian.resolveSubpath !== 'function') return null;
  const cache = app.metadataCache.getFileCache(link.file);
  const r = cache && obsidian.resolveSubpath(cache, sp);
  if (!r || r.type !== 'block' || !r.block) return null;
  const content = await app.vault.cachedRead(link.file);
  const p = r.block.position;
  let t = content.slice(p.start.offset, p.end.offset).split('\n')[0];
  t = t.replace(/\s*\^[\w-]+\s*$/, '');
  t = t.replace(/^\s*(?:[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+|>\s*|#{1,6}\s+)/, '');
  t = stripMarkup(t).trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return t || null;
}

async function autoTextOf(plugin, link) {
  const st = plugin.settings;
  const opt = st.clean;
  const sp = link.subpath || '';
  if (sp.indexOf('#^') === 0) {
    if (st.blockMode === 'text') {
      const bt = await blockTextOf(plugin.app, link, st.blockTextLength);
      if (bt) return cleanText(bt, opt, true);
    }
    return cleanText(nameOf(link, opt), opt, false);
  }
  if (sp) {
    const h = headingOf(plugin.app, link);
    if (h) return cleanText(h, opt, true);
  }
  return cleanText(nameOf(link, opt), opt, false);
}

function aliasesOf(app, link) {
  if (!link.file || link.file.extension !== 'md') return [];
  const cache = app.metadataCache.getFileCache(link.file);
  const fm = cache && cache.frontmatter;
  if (!fm) return [];
  if (typeof obsidian.parseFrontMatterAliases === 'function') {
    return obsidian.parseFrontMatterAliases(fm) || [];
  }
  const a = fm.aliases || fm.alias;
  return Array.isArray(a) ? a.map(String) : (a ? [String(a)] : []);
}

/* ------------------------------------------------------------------ */
/*  Правка ссылки в редакторе                                          */
/* ------------------------------------------------------------------ */

function P(ctx, ch) { return { line: ctx.line, ch: ch }; }

function verify(ctx) {
  const cur = ctx.editor.getLine(ctx.line);
  if (cur.slice(ctx.link.from, ctx.link.to) !== ctx.link.raw) {
    new Notice('Строка изменилась — щёлкни по ссылке ещё раз');
    return false;
  }
  return true;
}

function replaceSpan(ctx, from, to, text) {
  ctx.editor.replaceRange(text, P(ctx, from), P(ctx, to));
}

function isTableLine(s) { return /^\s*\|/.test(s); }

function escMdText(s) { return String(s).replace(/([\[\]])/g, '\\$1'); }

function unbalanced(s) {
  let d = 0;
  for (const c of s) { if (c === '(') d++; else if (c === ')') { d--; if (d < 0) return true; } }
  return d !== 0;
}

/* Адрес для []() — в угловых скобках, если в нём пробелы или непарные скобки */
function mdDest(d) {
  return (/[\s<>]/.test(d) || unbalanced(d)) ? '<' + d + '>' : d;
}

/* Путь внутри хранилища для []() */
function mdVaultPath(p) { return encodeURI(p).replace(/\(/g, '%28').replace(/\)/g, '%29'); }

/*
 * Собирает новую разметку ссылки.
 * newText: null — не трогать; '' — убрать текст (для [[ ]]).
 * newDest: null — не трогать.
 */
function composeRaw(ctx, newText, newDest) {
  const l = ctx.link;
  const base = l.from;
  const lineText = ctx.editor.getLine(ctx.line);

  if (l.kind === 'bare' || l.kind === 'auto') {
    const d = newDest != null ? newDest : l.dest;
    if (newText != null && newText !== '') return '[' + escMdText(newText) + '](' + mdDest(d) + ')';
    if (l.kind === 'auto') return '<' + d + '>';
    return d.replace(/ /g, '%20');
  }

  const edits = [];
  if (newDest != null) {
    if (l.kind === 'md') {
      const a = l.angle ? l.destFrom - 1 : l.destFrom;
      const b = l.angle ? l.destTo + 1 : l.destTo;
      edits.push([a, b, mdDest(newDest)]);
    } else if (l.kind === 'html' || l.kind === 'iframe') {
      edits.push([l.destFrom, l.destTo, newDest.replace(/"/g, '%22')]);
    } else {
      edits.push([l.destFrom, l.destTo, newDest]);
    }
  }
  if (newText != null) {
    if (l.kind === 'wiki') {
      const t = newText.replace(/[|\[\]]/g, '').trim();
      const bar = (l.escapedPipe || isTableLine(lineText)) ? '\\|' : '|';
      if (l.text == null) { if (t) edits.push([l.insertTextAt, l.insertTextAt, bar + t]); }
      else if (t) edits.push([l.textFrom, l.textTo, t]);
      else edits.push([l.destTo, l.textTo, '']);
    } else if (l.textFrom != null) {
      edits.push([l.textFrom, l.textTo, l.kind === 'md' ? escMdText(newText) : newText]);
    }
  }
  edits.sort(function (x, y) { return y[0] - x[0]; });
  let r = l.raw;
  edits.forEach(function (e) { r = r.slice(0, e[0] - base) + e[2] + r.slice(e[1] - base); });
  return r;
}

function applyEdit(ctx, newText, newDest) {
  if (!verify(ctx)) return;
  const r = composeRaw(ctx, newText, newDest);
  if (r !== ctx.link.raw) replaceSpan(ctx, ctx.link.from, ctx.link.to, r);
  ctx.editor.focus();
}

function replaceWhole(ctx, newRaw) {
  if (!verify(ctx)) return;
  replaceSpan(ctx, ctx.link.from, ctx.link.to, newRaw);
  ctx.editor.focus();
}

function setWikiText(ctx, t) { applyEdit(ctx, t, null); }
function removeWikiText(ctx) { applyEdit(ctx, '', null); }

/* ------------------------------------------------------------------ */
/*  Окна ввода и выбора                                                */
/* ------------------------------------------------------------------ */

class FileInputSuggest extends (obsidian.AbstractInputSuggest || class {}) {
  constructor(app, inputEl, sourcePath) {
    super(app, inputEl);
    this.appRef = app;
    this.sourcePath = sourcePath;
  }
  getSuggestions(q) {
    const s = (q || '').toLowerCase();
    return this.appRef.vault.getFiles().filter(function (f) { return f.path.toLowerCase().indexOf(s) >= 0; }).slice(0, 50);
  }
  renderSuggestion(f, el) { el.setText(f.path); }
  selectSuggestion(f) {
    this.setValue(this.appRef.metadataCache.fileToLinktext(f, this.sourcePath, true));
    this.close();
  }
}

class FolderInputSuggest extends (obsidian.AbstractInputSuggest || class {}) {
  constructor(app, inputEl) {
    super(app, inputEl);
    this.appRef = app;
  }
  getSuggestions(q) {
    const s = (q || '').toLowerCase();
    return this.appRef.vault.getAllLoadedFiles().filter(function (f) {
      return f instanceof obsidian.TFolder && f.path.toLowerCase().indexOf(s) >= 0;
    }).slice(0, 50);
  }
  renderSuggestion(f, el) { el.setText(f.path === '/' ? '/ (корень)' : f.path); }
  selectSuggestion(f) {
    this.setValue(f.path === '/' ? '' : f.path);
    this.close();
  }
}

/*
 * Окно с полями и кнопками.
 * opts: { title, message, fields: [...], buttons: [{ text, value, cta, warning }] }
 * Поле: { key, label, value, desc, placeholder, type: 'text' | 'dropdown', options: [[значение, подпись]],
 *         suggestFiles: sourcePath, suggestFolders: true, onInput(value, inputs) }
 * Результат: значения полей и _button — value нажатой кнопки; null — окно закрыто без выбора.
 */
class FieldsModal extends obsidian.Modal {
  constructor(app, opts, done) {
    super(app);
    this.opts = opts;
    this.done = done;
    this.inputs = {};
    this.result = null;
  }
  onOpen() {
    const self = this;
    const o = this.opts;
    this.titleEl.setText(o.title || '');
    if (o.message) this.contentEl.createEl('p', { text: o.message }).style.whiteSpace = 'pre-wrap';
    let focused = false;
    (o.fields || []).forEach(function (f) {
      const s = new Setting(self.contentEl).setName(f.label);
      if (f.desc) s.setDesc(f.desc);
      if (f.type === 'dropdown') {
        s.addDropdown(function (d) {
          (f.options || []).forEach(function (op) { d.addOption(op[0], op[1]); });
          d.setValue(f.value != null ? String(f.value) : '');
          self.inputs[f.key] = d;
        });
        return;
      }
      s.addText(function (t) {
        t.setValue(f.value != null ? String(f.value) : '');
        if (f.placeholder) t.setPlaceholder(f.placeholder);
        t.inputEl.style.width = '100%';
        self.inputs[f.key] = t;
        const hasSuggest = (f.suggestFiles != null || f.suggestFolders) && obsidian.AbstractInputSuggest;
        if (hasSuggest && f.suggestFiles != null) new FileInputSuggest(self.app, t.inputEl, f.suggestFiles);
        if (hasSuggest && f.suggestFolders) new FolderInputSuggest(self.app, t.inputEl);
        t.inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.isComposing && (!hasSuggest || e.ctrlKey)) { e.preventDefault(); self.submit(self.defaultButton()); }
        });
        if (f.onInput) t.inputEl.addEventListener('input', function () { f.onInput(t.getValue(), self.inputs); });
        if (!focused) {
          focused = true;
          setTimeout(function () { t.inputEl.focus(); t.inputEl.select(); }, 20);
        }
      });
    });
    const buttons = o.buttons || [{ text: 'Отмена' }, { text: 'Готово', value: 'ok', cta: true }];
    const bs = new Setting(this.contentEl);
    buttons.forEach(function (b) {
      bs.addButton(function (btn) {
        btn.setButtonText(b.text);
        if (b.cta) btn.setCta();
        if (b.warning) btn.setWarning();
        btn.onClick(function () { if (b.value) self.submit(b.value); else self.close(); });
      });
    });
  }
  defaultButton() {
    const bs = this.opts.buttons || [{ value: 'ok', cta: true }];
    const c = bs.filter(function (b) { return b.cta && b.value; })[0] || bs.filter(function (b) { return b.value; })[0];
    return c ? c.value : 'ok';
  }
  submit(button) {
    const r = { _button: button };
    for (const k in this.inputs) r[k] = this.inputs[k].getValue();
    this.result = r;
    this.close();
  }
  onClose() {
    this.contentEl.empty();
    this.done(this.result);
  }
}

function askDialog(app, opts) {
  return new Promise(function (res) { new FieldsModal(app, opts, res).open(); });
}

function askFields(app, title, fields) {
  return askDialog(app, { title: title, fields: fields });
}

class ListPicker extends obsidian.FuzzySuggestModal {
  constructor(app, items, placeholder, done) {
    super(app);
    this.items = items;
    this.doneCb = done;
    this.finished = false;
    this.setPlaceholder(placeholder);
  }
  getItems() { return this.items; }
  getItemText(i) { return i.label; }
  onChooseItem(i) { if (!this.finished) { this.finished = true; this.doneCb(i); } }
  onClose() {
    super.onClose();
    const self = this;
    setTimeout(function () { if (!self.finished) { self.finished = true; self.doneCb(null); } }, 0);
  }
}

function pickFrom(app, items, placeholder) {
  return new Promise(function (res) { new ListPicker(app, items, placeholder, res).open(); });
}

/* ------------------------------------------------------------------ */
/*  Вспомогательное для действий                                       */
/* ------------------------------------------------------------------ */

function isVault(l) { return l.destType === 'vault' && (l.kind === 'wiki' || l.kind === 'md'); }
function isFileUrl(l) { return l.destType === 'file'; }
function isExternal(l) { return l.destType === 'http' || l.destType === 'url'; }
function isWeb(l) { return l.destType === 'http'; }
function hasVaultFile(l) { return isVault(l) && !!l.file; }
function isMdFile(l) { return hasVaultFile(l) && l.file.extension === 'md'; }
/* Файл хранилища, отличный от текущей заметки */
function otherFile(l, c) { return hasVaultFile(l) && !!c && l.file.path !== c.sourcePath; }

const IMG_RE = /\.(png|jpe?g|gif|bmp|webp|svg|avif)(?:[?#].*)?$/i;
function isImage(l) {
  if (hasVaultFile(l)) return IMG_RE.test(l.file.path);
  if (isFileUrl(l)) return IMG_RE.test(l.dest);
  return l.tags.has(T.EHTTP);
}
function isPdf(l) {
  if (hasVaultFile(l)) return l.file.extension === 'pdf';
  return /\.pdf(?:[#?].*)?$/i.test(l.dest || '') && (isFileUrl(l) || isWeb(l));
}

const GH_RE = /^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/(?:pull|issues)\/(\d+)/i;
function ghInfo(l) {
  if (!isWeb(l)) return null;
  const m = destForCopy(l).match(GH_RE);
  return m ? { owner: m[1], repo: m[2], num: m[3] } : null;
}

function short(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function electronMod() {
  try { return require('electron'); } catch (e) { return null; }
}

function runExe(exe, argsStr) {
  const fs = require('fs');
  const cp = require('child_process');
  if (!exe || !fs.existsSync(exe)) { new Notice('Не найден файл: ' + (exe || '(путь не задан)')); return; }
  try {
    const ch = cp.spawn(exe, [argsStr], {
      argv0: '"' + exe + '"',
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore'
    });
    ch.on('error', function (e) { new Notice('Ошибка запуска: ' + e.message); });
    ch.unref();
  } catch (e) {
    new Notice('Ошибка запуска: ' + e.message);
  }
}

function targetPathForFs(ctx) {
  const l = ctx.link;
  if (isFileUrl(l)) return fileUrlToPath(l.dest);
  if (hasVaultFile(l)) return vaultFullPath(ctx.plugin.app, l.file);
  return null;
}

function parseBrowsers(text) {
  return String(text || '').split('\n').map(function (row) {
    const p = row.split('|').map(function (x) { return x.trim(); });
    if (p.length < 2 || !p[0] || !p[1]) return null;
    return { name: p[0], path: p[1], args: p[2] || '{url}' };
  }).filter(Boolean);
}

function parseTracking(text) {
  return String(text || '').split(/[\s,;]+/).filter(Boolean).map(function (p) {
    const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + esc + '$', 'i');
  });
}

/* Убирает трекинг-параметры, не трогая остальной адрес */
function cleanTracking(url, patterns) {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const noHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const q = noHash.indexOf('?');
  if (q < 0) return url;
  const base = noHash.slice(0, q);
  const kept = noHash.slice(q + 1).split('&').filter(function (pair) {
    if (!pair) return false;
    const key = safeDecode(pair.split('=')[0]);
    return !patterns.some(function (re) { return re.test(key); });
  });
  return base + (kept.length ? '?' + kept.join('&') : '') + hash;
}

function hasPct(d) { return /%[0-9a-f]{2}/i.test(d); }
function decodePct(d) { try { return decodeURI(d); } catch (e) { return d; } }
function encodeNonAscii(d) { return d.replace(/[^\x00-\x7F]+/g, function (s) { return encodeURIComponent(s); }); }

function subParams(sp) {
  const o = {};
  String(sp || '').replace(/^#/, '').split('&').forEach(function (kv) {
    if (!kv) return;
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
  });
  return o;
}
function joinParams(o) {
  const s = Object.keys(o).filter(function (k) { return o[k] !== '' && o[k] != null; })
    .map(function (k) { return k + '=' + o[k]; }).join('&');
  return s ? '#' + s : '';
}

function headingForLink(h) {
  return String(h).replace(/[#|^:%\[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Новый адрес для ссылки на хранилище: путь + раздел */
function vaultDest(l, linkpath, sub) {
  if (l.kind === 'wiki') return linkpath + (sub || '');
  let p = linkpath;
  if (l.file && l.file.extension === 'md' && !/\.md$/i.test(p)) p += '.md';
  return mdVaultPath(p) + (sub ? '#' + encodeURI(sub.replace(/^#/, '')) : '');
}

async function openAt(app, file, line) {
  const leaf = app.workspace.getLeaf('tab');
  await leaf.openFile(file, { active: true, eState: { line: line } });
}

/* ------------------------------------------------------------------ */
/*  Действия: открытие                                                 */
/* ------------------------------------------------------------------ */

function openLink(ctx, pane) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  if (isVault(l)) {
    const linktext = l.kind === 'wiki' ? l.dest : (l.linkpath + l.subpath);
    app.workspace.openLinkText(linktext, ctx.sourcePath, pane);
    return;
  }
  if (isFileUrl(l)) {
    const sh = electronShell();
    if (sh) sh.openPath(fileUrlToPath(l.dest)).then(function (err) { if (err) new Notice(err); });
    return;
  }
  window.open(destForCopy(l));
}

function openInSystemBrowser(ctx) {
  const sh = electronShell();
  if (sh) sh.openExternal(destForCopy(ctx.link));
}

function openWithItems(ctx) {
  const l = ctx.link;
  const url = isFileUrl(l) ? destForCopy(l) : destForCopy(l);
  return parseBrowsers(ctx.plugin.settings.browsers).map(function (b) {
    return {
      title: 'Открыть в: ' + b.name, icon: 'globe',
      run: function () { runExe(b.path, b.args.replace(/\{url\}/g, '"' + url.replace(/"/g, '%22') + '"')); }
    };
  });
}

function openArchive(ctx) {
  window.open('https://web.archive.org/web/2/' + destForCopy(ctx.link));
}

function openDefault(ctx) {
  const sh = electronShell();
  const p = targetPathForFs(ctx);
  if (sh && p) sh.openPath(p).then(function (err) { if (err) new Notice(err); });
}

function showInFolder(ctx) {
  const sh = electronShell();
  const p = targetPathForFs(ctx);
  if (sh && p) sh.showItemInFolder(p);
}

function openInTC(ctx) {
  const st = ctx.plugin.settings;
  const p = targetPathForFs(ctx);
  if (!p) return;
  runExe(st.tcPath, st.tcArgs.replace(/\{path\}/g, p));
}

function revealInNav(ctx) {
  const app = ctx.plugin.app;
  const ip = app.internalPlugins;
  const fe = ip && ip.getPluginById && ip.getPluginById('file-explorer');
  if (fe && fe.enabled && fe.instance && typeof fe.instance.revealInFolder === 'function') {
    fe.instance.revealInFolder(ctx.link.file);
  } else {
    new Notice('Панель файлов недоступна');
  }
}

/* ------------------------------------------------------------------ */
/*  Действия: поиск                                                    */
/* ------------------------------------------------------------------ */

async function collectRefs(plugin, l) {
  const app = plugin.app;
  const out = [];

  if (hasVaultFile(l)) {
    const target = l.file.path;
    const rl = app.metadataCache.resolvedLinks;
    for (const src in rl) {
      if (!rl[src][target]) continue;
      const f = app.vault.getAbstractFileByPath(src);
      if (!f) continue;
      const cache = app.metadataCache.getFileCache(f) || {};
      const refs = [].concat(cache.links || [], cache.embeds || []);
      const lines = (await app.vault.cachedRead(f)).split('\n');
      refs.forEach(function (r) {
        const d = app.metadataCache.getFirstLinkpathDest(obsidian.getLinkpath(r.link), src);
        if (d && d.path === target) {
          const n = r.position.start.line;
          out.push({ file: f, line: n, text: lines[n] || '' });
        }
      });
      (cache.frontmatterLinks || []).forEach(function (r) {
        const d = app.metadataCache.getFirstLinkpathDest(obsidian.getLinkpath(r.link), src);
        if (d && d.path === target) out.push({ file: f, line: 0, text: 'в свойствах: ' + r.key });
      });
    }
    return out;
  }

  const needles = [];
  if (isVault(l)) {
    needles.push('[[' + l.linkpath);
  } else {
    const d = destForCopy(l);
    needles.push(d);
    if (hasPct(d)) needles.push(decodePct(d));
    else if (/[^\x00-\x7F]/.test(d)) needles.push(encodeNonAscii(d));
  }
  const files = app.vault.getMarkdownFiles();
  for (const f of files) {
    const content = await app.vault.cachedRead(f);
    if (!needles.some(function (n) { return content.indexOf(n) >= 0; })) continue;
    content.split('\n').forEach(function (line, n) {
      if (needles.some(function (x) { return line.indexOf(x) >= 0; })) out.push({ file: f, line: n, text: line });
    });
  }
  return out;
}

async function findRefs(ctx) {
  const app = ctx.plugin.app;
  new Notice('Ищу…', 1200);
  const refs = await collectRefs(ctx.plugin, ctx.link);
  if (!refs.length) { new Notice('Ничего не найдено'); return; }
  const items = refs.map(function (r) {
    return { label: r.file.path.replace(/\.md$/, '') + ':  ' + short(r.text.trim(), 90), ref: r };
  });
  const pick = await pickFrom(app, items, 'Найдено мест: ' + refs.length + '. Введи текст для фильтра');
  if (pick) openAt(app, pick.ref.file, pick.ref.line);
}

const TWO_PART_TLD = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp',
  'co.kr', 'com.br', 'com.cn', 'com.tr', 'com.ua', 'org.ua', 'co.il', 'co.in', 'co.nz', 'co.za', 'com.mx',
  'com.ru', 'net.ru', 'org.ru', 'pp.ru', 'msk.ru', 'spb.ru', 'msk.su', 'com.by', 'com.kz', 'github.io', 'narod.ru'];

/* Домен второго уровня: news.ya.ru → ya.ru, bbc.co.uk → bbc.co.uk */
function siteOf(url) {
  const m = String(url || '').match(/^https?:\/\/(?:[^@\/\s]*@)?([^\/:?#\s]+)/i);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/\.$/, '');
  if (/^\d+(?:\.\d+){3}$/.test(host)) return host;
  const p = host.split('.');
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join('.');
  return TWO_PART_TLD.indexOf(last2) >= 0 ? p.slice(-3).join('.') : last2;
}

async function findSite(ctx) {
  const app = ctx.plugin.app;
  const site = siteOf(destForCopy(ctx.link));
  if (!site) return;
  new Notice('Ищу ссылки на ' + site + '…', 1200);
  const re = /https?:\/\/[^\s<>"'`\])]+/gi;
  const out = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const content = await app.vault.cachedRead(f);
    if (content.toLowerCase().indexOf(site) < 0) continue;
    content.split('\n').forEach(function (line, n) {
      const urls = line.match(re);
      if (urls && urls.some(function (u) { return siteOf(u) === site; })) out.push({ file: f, line: n, text: line });
    });
  }
  if (!out.length) { new Notice('Ничего не найдено'); return; }
  const items = out.map(function (r) {
    return { label: r.file.path.replace(/\.md$/, '') + ':  ' + short(r.text.trim(), 90), ref: r };
  });
  const pick = await pickFrom(app, items, site + ': найдено строк ' + out.length + '. Введи текст для фильтра');
  if (pick) openAt(app, pick.ref.file, pick.ref.line);
}

async function openBacklinks(ctx) {
  const app = ctx.plugin.app;
  const ip = app.internalPlugins;
  const bl = ip && ip.getPluginById && ip.getPluginById('backlink');
  if (bl && bl.enabled) {
    try {
      const leaf = app.workspace.getRightLeaf(true);
      await leaf.setViewState({ type: 'backlink', state: { file: ctx.link.file.path }, active: true });
      app.workspace.revealLeaf(leaf);
      return;
    } catch (e) { console.error(e); }
  }
  findRefs(ctx);
}

/* ------------------------------------------------------------------ */
/*  Действия: копирование                                              */
/* ------------------------------------------------------------------ */

function obsidianUrl(app, file) {
  const p = file.extension === 'md' ? file.path.replace(/\.md$/, '') : file.path;
  return 'obsidian://open?vault=' + encodeURIComponent(app.vault.getName()) + '&file=' + encodeURIComponent(p);
}

function copyPathItems(ctx) {
  const app = ctx.plugin.app;
  const f = ctx.link.file;
  const full = vaultFullPath(app, f);
  const items = [{ title: 'Копировать путь в хранилище', icon: 'folder-tree', run: function () { copyText(f.path, 'Путь скопирован'); } }];
  if (full) items.push({ title: 'Копировать полный путь', icon: 'hard-drive', run: function () { copyText(full, 'Путь скопирован'); } });
  return items;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };

function rasterize(bytes, mime) {
  return new Promise(function (resolve) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'image/png' }));
    const img = new Image();
    img.onload = function () {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 800;
        c.height = img.naturalHeight || 600;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch (e) { resolve(null); }
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function copyImage(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  const el = electronMod();
  if (!el) return;
  try {
    let bytes, name;
    if (hasVaultFile(l)) { bytes = await app.vault.readBinary(l.file); name = l.file.path; }
    else if (isFileUrl(l)) { const p = fileUrlToPath(l.dest); bytes = require('fs').readFileSync(p); name = p; }
    else { const r = await obsidian.requestUrl({ url: destForCopy(l) }); bytes = r.arrayBuffer; name = destForCopy(l); }
    const buf = Buffer.from(bytes);
    let img = el.nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) {
      const m = String(name).match(IMG_RE);
      const dataUrl = await rasterize(buf, m ? MIME[m[1].toLowerCase()] : null);
      if (dataUrl) img = el.nativeImage.createFromDataURL(dataUrl);
    }
    if (img.isEmpty()) { new Notice('Не удалось прочитать картинку'); return; }
    el.clipboard.writeImage(img);
    new Notice('Картинка скопирована');
  } catch (e) {
    console.error(e);
    new Notice('Не удалось скопировать картинку: ' + e.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Действия: правка                                                   */
/* ------------------------------------------------------------------ */

function editText(ctx) {
  if (!verify(ctx)) return;
  const l = ctx.link;
  if (l.kind === 'wiki' && l.text == null) {
    autoTextOf(ctx.plugin, l).then(function (t) {
      if (!verify(ctx)) return;
      const bar = (l.escapedPipe || isTableLine(ctx.editor.getLine(ctx.line))) ? '\\|' : '|';
      replaceSpan(ctx, l.insertTextAt, l.insertTextAt, bar + t);
      const s = l.insertTextAt + bar.length;
      ctx.editor.setSelection(P(ctx, s), P(ctx, s + t.length));
      ctx.editor.focus();
    });
    return;
  }
  ctx.editor.setSelection(P(ctx, l.textFrom), P(ctx, l.textTo));
  ctx.editor.focus();
}

function editDest(ctx) {
  if (!verify(ctx)) return;
  ctx.editor.setSelection(P(ctx, ctx.link.destFrom), P(ctx, ctx.link.destTo));
  ctx.editor.focus();
}

async function editForm(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  let text = l.text != null ? l.text : '';
  const dest = l.kind === 'wiki' ? l.dest : destForCopy(l);
  const r = await askFields(app, 'Ссылка', [
    { key: 'text', label: 'Текст', value: text },
    { key: 'dest', label: 'Адрес', value: dest, suggestFiles: l.kind === 'wiki' ? ctx.sourcePath : null,
      desc: l.kind === 'wiki' ? 'Подсказки заметок; Ctrl+Enter — готово' : null }
  ]);
  if (!r) return;
  const nt = r.text === text ? null : r.text;
  const nd = r.dest === dest ? null : r.dest.trim();
  if (nt == null && nd == null) return;
  applyEdit(ctx, nt, nd);
}

function autoText(ctx) {
  autoTextOf(ctx.plugin, ctx.link).then(function (t) { setWikiText(ctx, t); });
}

function fileNameText(ctx) {
  const p = fileUrlToPath(ctx.link.dest);
  const name = p.slice(p.lastIndexOf('\\') + 1);
  applyEdit(ctx, name, null);
}

function textFromClipboard(ctx) {
  navigator.clipboard.readText().then(function (s) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    if (!s) { new Notice('Буфер пуст'); return; }
    applyEdit(ctx, s, null);
  });
}

function destFromClipboard(ctx) {
  navigator.clipboard.readText().then(function (s) {
    s = (s || '').trim();
    if (!s) { new Notice('Буфер пуст'); return; }
    applyEdit(ctx, null, s);
  });
}

async function saveAlias(ctx) {
  const l = ctx.link;
  const t = l.text.trim();
  await ctx.plugin.app.fileManager.processFrontMatter(l.file, function (fm) {
    let a = fm.aliases;
    if (a == null) a = [];
    else if (!Array.isArray(a)) a = [String(a)];
    if (a.indexOf(t) < 0) a.push(t);
    fm.aliases = a;
  });
  new Notice('Алиас «' + t + '» сохранён в ' + l.file.basename);
}

async function pickHeading(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  const cache = app.metadataCache.getFileCache(l.file) || {};
  const items = [{ label: '(вся заметка, без раздела)', sub: '' }];
  (cache.headings || []).forEach(function (h) {
    items.push({ label: '#'.repeat(h.level) + ' ' + h.heading, sub: '#' + headingForLink(h.heading) });
  });
  const blocks = cache.blocks || {};
  const ids = Object.keys(blocks);
  if (ids.length) {
    const lines = (await app.vault.cachedRead(l.file)).split('\n');
    ids.forEach(function (id) {
      const n = blocks[id].position.start.line;
      const txt = stripMarkup((lines[n] || '').replace(/\s*\^[\w-]+\s*$/, '')).trim();
      items.push({ label: '^' + id + '   ' + short(txt, 70), sub: '#^' + id });
    });
  }
  const pick = await pickFrom(app, items, 'Раздел или блок');
  if (!pick) return;
  applyEdit(ctx, null, vaultDest(l, l.linkpath, pick.sub));
}

async function redirect(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  const items = app.vault.getFiles().map(function (f) { return { label: f.path, file: f }; });
  const pick = await pickFrom(app, items, 'Новая цель ссылки');
  if (!pick) return;
  const lt = app.metadataCache.fileToLinktext(pick.file, ctx.sourcePath, true);
  const fake = Object.assign({}, l, { file: pick.file });
  applyEdit(ctx, null, vaultDest(fake, lt, ''));
}

function sizeOf(s) {
  const m = String(s || '').match(/^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/i);
  return m ? { w: m[1], h: m[2] || '' } : { w: '', h: '' };
}

function setIframeAttr(raw, name, val) {
  const re = new RegExp('\\s' + name + '\\s*=\\s*(["\'])[^"\']*\\1', 'i');
  if (!val) return raw.replace(re, '');
  if (re.test(raw)) return raw.replace(re, ' ' + name + '="' + val + '"');
  return raw.replace(/<iframe\b/i, '<iframe ' + name + '="' + val + '"');
}

async function embedSize(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;

  if (l.kind === 'iframe') {
    const w0 = (l.raw.match(/\swidth\s*=\s*["']([^"']*)/i) || [])[1] || '';
    const h0 = (l.raw.match(/\sheight\s*=\s*["']([^"']*)/i) || [])[1] || '';
    const r = await askFields(app, 'Размер окна страницы', [
      { key: 'w', label: 'Ширина', value: w0, placeholder: '100% или 800' },
      { key: 'h', label: 'Высота', value: h0, placeholder: '500' }
    ]);
    if (!r) return;
    let raw = setIframeAttr(l.raw, 'width', r.w.trim());
    raw = setIframeAttr(raw, 'height', r.h.trim());
    replaceWhole(ctx, raw);
    return;
  }

  if (isPdf(l) && l.kind === 'wiki') {
    const prm = subParams(l.subpath);
    const r = await askFields(app, 'Высота встроенного PDF', [
      { key: 'h', label: 'Высота, px', value: prm.height || '', placeholder: '600' }
    ]);
    if (!r) return;
    prm.height = r.h.trim();
    applyEdit(ctx, null, l.linkpath + joinParams(prm));
    return;
  }

  let alt = '';
  let cur;
  if (l.kind === 'wiki') cur = sizeOf(l.text);
  else {
    const parts = (l.text || '').split('|');
    cur = sizeOf(parts.length > 1 ? parts[parts.length - 1] : '');
    alt = parts.length > 1 && cur.w ? parts.slice(0, -1).join('|') : (l.text || '');
  }

  const nat = await naturalSize(ctx);
  const ratio = nat ? nat.h / nat.w : null;
  if (ratio && cur.w && !cur.h) cur.h = String(Math.round(cur.w * ratio));

  const r = await askFields(app, 'Размер картинки', [
    { key: 'w', label: 'Ширина, px', value: cur.w,
      desc: nat ? 'Исходный размер: ' + nat.w + '×' + nat.h + '. Вторая величина подставляется по пропорциям.' : 'Исходный размер определить не удалось.',
      placeholder: 'пусто — исходный размер',
      onInput: function (v, inp) {
        const n = parseInt(v, 10);
        if (ratio && inp.h) inp.h.setValue(n > 0 ? String(Math.round(n * ratio)) : '');
      } },
    { key: 'h', label: 'Высота, px', value: cur.h,
      placeholder: 'пусто — по пропорциям',
      onInput: function (v, inp) {
        const n = parseInt(v, 10);
        if (ratio && inp.w) inp.w.setValue(n > 0 ? String(Math.round(n / ratio)) : '');
      } }
  ]);
  if (!r) return;
  let w = parseInt(r.w, 10) || 0;
  let h = parseInt(r.h, 10) || 0;
  if (!w && h) {
    if (ratio) w = Math.round(h / ratio);
    else { new Notice('Укажи ширину: одну высоту Obsidian не понимает'); return; }
  }
  // пропорциональный размер записывается одной шириной
  const proportional = !h || (ratio && Math.abs(Math.round(w * ratio) - h) <= 1);
  const val = w ? (proportional ? String(w) : w + 'x' + h) : '';
  const before = ctx.editor.getLine(ctx.line);
  if (l.kind === 'wiki') applyEdit(ctx, val, null);
  else applyEdit(ctx, alt + (val ? '|' + val : ''), null);
  const after = ctx.editor.getLine(ctx.line);
  if (after === before) new Notice('Размер в тексте не изменился: ' + (val ? '|' + val : 'без размера'));
  else new Notice('Размер записан: ' + (val ? '|' + val : 'исходный'));
}

/* Исходные размеры картинки */
async function naturalSize(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  let src = null;
  let revoke = false;
  try {
    if (hasVaultFile(l)) {
      src = app.vault.getResourcePath(l.file);
    } else if (isFileUrl(l)) {
      const p = fileUrlToPath(l.dest);
      const m = p.match(IMG_RE);
      const buf = require('fs').readFileSync(p);
      src = URL.createObjectURL(new Blob([buf], { type: m ? MIME[m[1].toLowerCase()] : 'image/png' }));
      revoke = true;
    } else {
      src = destForCopy(l);
    }
  } catch (e) { return null; }
  return new Promise(function (resolve) {
    const img = new Image();
    const done = function (v) { if (revoke) URL.revokeObjectURL(src); resolve(v); };
    const timer = setTimeout(function () { done(null); }, 5000);
    img.onload = function () {
      clearTimeout(timer);
      done(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    };
    img.onerror = function () { clearTimeout(timer); done(null); };
    img.src = src;
  });
}

async function pdfPage(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  let base, sp;
  if (isVault(l)) { base = null; sp = l.subpath; }
  else { const d = destForCopy(l); const i = d.indexOf('#'); base = i < 0 ? d : d.slice(0, i); sp = i < 0 ? '' : d.slice(i); }
  const prm = subParams(sp);
  const r = await askFields(app, 'Страница PDF', [
    { key: 'p', label: 'Номер страницы', value: prm.page || '', placeholder: 'пусто — с начала' }
  ]);
  if (!r) return;
  prm.page = r.p.replace(/\D/g, '');
  if (isVault(l)) applyEdit(ctx, null, vaultDest(l, l.linkpath, joinParams(prm)));
  else applyEdit(ctx, null, base + joinParams(prm));
}

/* ------------------------------------------------------------------ */
/*  Действия: преобразование                                           */
/* ------------------------------------------------------------------ */

function toggleEmbed(ctx) {
  if (!verify(ctx)) return;
  const l = ctx.link;
  if (l.embed) replaceSpan(ctx, l.from, l.from + 1, '');
  else replaceSpan(ctx, l.from, l.from, '!');
  ctx.editor.focus();
}

function mdToBare(ctx) {
  replaceWhole(ctx, destForCopy(ctx.link).replace(/ /g, '%20'));
}

function htmlToMd(ctx) {
  const l = ctx.link;
  const t = (l.text || '').replace(/<[^>]+>/g, '').trim();
  replaceWhole(ctx, '[' + escMdText(t) + '](' + mdDest(l.dest) + ')');
}

function toIframe(ctx) {
  const h = ctx.plugin.settings.iframeHeight || 500;
  const url = destForCopy(ctx.link).replace(/"/g, '%22');
  replaceWhole(ctx, '<iframe src="' + url + '" width="100%" height="' + h + '"></iframe>');
}

function pathForms(app, l, sourcePath) {
  if (!hasVaultFile(l)) return null;
  const shortP = app.metadataCache.fileToLinktext(l.file, sourcePath, true);
  const full = l.file.extension === 'md' ? l.file.path.replace(/\.md$/, '') : l.file.path;
  return { short: shortP, full: full };
}

function pathIsFull(l, pf) {
  const lp = l.linkpath.replace(/\.md$/i, '');
  return lp === pf.full;
}

function togglePath(ctx) {
  const l = ctx.link;
  const pf = pathForms(ctx.plugin.app, l, ctx.sourcePath);
  if (!pf) return;
  const next = pathIsFull(l, pf) ? pf.short : pf.full;
  applyEdit(ctx, null, vaultDest(l, next, l.subpath));
}

function pctDecode(ctx) {
  applyEdit(ctx, null, decodePct(destForCopy(ctx.link)));
}

function pctEncode(ctx) {
  applyEdit(ctx, null, encodeNonAscii(destForCopy(ctx.link)));
}

function ghPrefix(ctx) {
  const g = ghInfo(ctx.link);
  applyEdit(ctx, g.owner + '/' + g.repo + '#' + g.num, null);
}

function trackingCleaned(ctx) {
  const d = destForCopy(ctx.link);
  return cleanTracking(d, parseTracking(ctx.plugin.settings.trackingParams));
}

function cleanTrackingAction(ctx) {
  applyEdit(ctx, null, trackingCleaned(ctx));
}

/* ------------------------------------------------------------------ */
/*  Действия: удаление                                                 */
/* ------------------------------------------------------------------ */

function deleteLink(ctx) {
  if (!verify(ctx)) return;
  const line = ctx.editor.getLine(ctx.line);
  const from = ctx.link.from;
  let to = ctx.link.to;
  if (line[from - 1] === ' ' && line[to] === ' ') to++;
  replaceSpan(ctx, from, to, '');
  ctx.editor.focus();
}

function cutLink(ctx) {
  if (!verify(ctx)) return;
  navigator.clipboard.writeText(ctx.link.raw).then(function () {
    deleteLink(ctx);
    new Notice('Ссылка вырезана');
  });
}

function unlink(ctx) {
  const l = ctx.link;
  let t;
  if (l.kind === 'wiki') {
    const opt = ctx.plugin.settings.clean;
    t = l.text != null ? l.text : cleanText(headingOf(ctx.plugin.app, l) || nameOf(l, opt), opt, !!l.subpath);
  } else if (l.kind === 'html') {
    t = l.text.replace(/<[^>]+>/g, '');
  } else {
    t = l.text || '';
  }
  replaceWhole(ctx, t);
}

/* ------------------------------------------------------------------ */
/*  Этап 2: файлы                                                      */
/* ------------------------------------------------------------------ */

function sanitizeName(n) {
  return String(n || '').replace(/[\\/:*?"<>|#^\[\]]/g, '-').replace(/\s+/g, ' ').trim();
}

function sizeFromText(t) {
  if (!t) return '';
  const parts = String(t).split('|');
  const last = parts[parts.length - 1].trim();
  return /^\d+(?:x\d+)?$/.test(last) ? last : '';
}

function altFromText(t) {
  if (!t) return '';
  const parts = String(t).split('|');
  return sizeFromText(t) ? parts.slice(0, -1).join('|') : String(t);
}

async function attachmentPath(app, name, sourcePath) {
  if (typeof app.fileManager.getAvailablePathForAttachment === 'function') {
    return await app.fileManager.getAvailablePathForAttachment(name, sourcePath);
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let p = name;
  for (let i = 1; app.vault.getAbstractFileByPath(p); i++) p = base + ' ' + i + ext;
  return p;
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function fileUrlFromPath(p) {
  return 'file:///' + String(p).replace(/\\/g, '/').replace(/ /g, '%20');
}

/* Сколько ссылок в хранилище ведут на файл */
function refCount(app, path) {
  const rl = app.metadataCache.resolvedLinks;
  let n = 0;
  for (const src in rl) if (rl[src][path]) n += rl[src][path];
  return n;
}

function moveOnDisk(from, to) {
  const fs = require('fs');
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/* Заменяет адрес файла на диске во всех заметках: в открытой — через редактор, в остальных — в файле */
async function relinkDisk(ctx, oldPath, newPath) {
  const app = ctx.plugin.app;
  const fwd = function (p) { return String(p).replace(/\\/g, '/'); };
  const pairs = [
    ['file:///' + fwd(oldPath), 'file:///' + fwd(newPath)],
    ['file:///' + fwd(oldPath).replace(/ /g, '%20'), 'file:///' + fwd(newPath).replace(/ /g, '%20')],
    ['file:///' + encodeURI(fwd(oldPath)), 'file:///' + encodeURI(fwd(newPath))]
  ].filter(function (pr, i, arr) { return arr.findIndex(function (x) { return x[0] === pr[0]; }) === i; });
  const swap = function (text) {
    let n = 0;
    pairs.forEach(function (pr) {
      const parts = text.split(pr[0]);
      n += parts.length - 1;
      text = parts.join(pr[1]);
    });
    return { text: text, n: n };
  };

  let total = 0;
  const ed = ctx.editor;
  for (let i = 0; i < ed.lineCount(); i++) {
    const line = ed.getLine(i);
    const r = swap(line);
    if (r.n) { ed.replaceRange(r.text, { line: i, ch: 0 }, { line: i, ch: line.length }); total += r.n; }
  }
  const current = ctx.view.file ? ctx.view.file.path : null;
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path === current) continue;
    const content = await app.vault.cachedRead(f);
    if (!pairs.some(function (pr) { return content.indexOf(pr[0]) >= 0; })) continue;
    await app.vault.process(f, function (data) { const r = swap(data); total += r.n; return r.text; });
  }
  return total;
}

/* 50 — веб-картинку скачать в хранилище */
async function downloadImage(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  const url = destForCopy(l);
  new Notice('Скачиваю картинку…', 1500);
  const res = await obsidian.requestUrl({ url: url });
  const headers = res.headers || {};
  const ct = String(headers['content-type'] || headers['Content-Type'] || '').split(';')[0].trim().toLowerCase();
  const byCt = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp' }[ct];
  let name = sanitizeName(safeDecode(url.split(/[?#]/)[0].split('/').pop() || ''));
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    name = (name || 'image-' + window.moment().format('YYYYMMDDHHmmss')) + '.' + (byCt || 'png');
  }
  const path = await attachmentPath(app, name, ctx.sourcePath);
  const file = await app.vault.createBinary(path, res.arrayBuffer);
  const lt = app.metadataCache.fileToLinktext(file, ctx.sourcePath, true);
  const size = sizeFromText(l.text);
  replaceWhole(ctx, '![[' + lt + (size ? '|' + size : '') + ']]');
  new Notice('Картинка сохранена: ' + file.path);
}

/* 51 — файл с диска скопировать в хранилище */
async function fileToVault(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  const fs = require('fs');
  const p = fileUrlToPath(l.dest);
  if (!fs.existsSync(p)) { new Notice('Файл не найден: ' + p); return; }
  const name = p.slice(p.lastIndexOf('\\') + 1);
  const path = await attachmentPath(app, name, ctx.sourcePath);
  const file = await app.vault.createBinary(path, toArrayBuffer(fs.readFileSync(p)));
  const lt = app.metadataCache.fileToLinktext(file, ctx.sourcePath, true);
  let raw;
  if (l.embed) {
    const size = sizeFromText(l.text);
    raw = '![[' + lt + (size ? '|' + size : '') + ']]';
  } else {
    const t = l.text && l.text !== name ? l.text.replace(/[|\[\]]/g, '') : '';
    raw = '[[' + lt + (t ? '|' + t : '') + ']]';
  }
  replaceWhole(ctx, raw);
  new Notice('Файл скопирован в хранилище: ' + file.path);
}

/* 52 — вложение вынести из хранилища на диск */
function uniqueDiskPath(dir, name) {
  const fs = require('fs');
  const pathMod = require('path');
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let p = pathMod.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = pathMod.join(dir, base + ' ' + i + ext);
  return p;
}

async function vaultToDisk(ctx, choose) {
  const l = ctx.link;
  const plugin = ctx.plugin;
  const app = plugin.app;
  const fs = require('fs');
  const pathMod = require('path');
  const f = l.file;
  const full = vaultFullPath(app, f);
  if (!full) return;

  let dir = (plugin.settings.heavyFolder || '').trim();
  if (choose || !dir) {
    const r = await askDialog(app, {
      title: 'Вынести файл на диск',
      message: f.path,
      fields: [{ key: 'dir', label: 'Папка на диске', value: plugin.settings.exportFolder || dir, placeholder: 'E:\\Файлы' }],
      buttons: [{ text: 'Отмена' }, { text: 'Перенести', value: 'go', cta: true }]
    });
    if (!r) return;
    dir = r.dir.trim();
    if (dir) { plugin.settings.exportFolder = dir.replace(/[\\\/]+$/, ''); await plugin.saveSettings(); }
  }
  dir = dir.replace(/[\\\/]+$/, '');
  if (!dir) { new Notice('Не указана папка'); return; }
  fs.mkdirSync(dir, { recursive: true });
  const dest = uniqueDiskPath(dir, f.name);
  fs.copyFileSync(full, dest);

  const url = fileUrlFromPath(dest);
  let raw;
  if (l.embed) {
    const size = sizeFromText(l.text);
    const alt = size ? altFromText(l.text) : (l.text || '');
    raw = '![' + escMdText(alt) + (size ? '|' + size : '') + '](' + url + ')';
  } else {
    raw = '[' + escMdText(l.text || f.name) + '](' + url + ')';
  }
  const others = refCount(app, f.path) - 1;
  replaceWhole(ctx, raw);
  if (others > 0) {
    new Notice('Файл скопирован в ' + dir + '. В хранилище оставлен: на него ссылаются ещё ' + others);
  } else {
    await app.fileManager.trashFile(f);
    new Notice('Файл перенесён: ' + dest);
  }
}

/* Перетаскивание тяжёлых файлов в заметку */
const EMBED_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|avif|pdf|mp3|wav|m4a|ogg|flac|webm|mp4|mov|mkv)$/i;

function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';
  return Math.round(n / 1024) + ' КБ';
}

function diskLink(dest, name) {
  const url = fileUrlFromPath(dest);
  return EMBED_EXT.test(name) ? '![](' + url + ')' : '[' + escMdText(name) + '](' + url + ')';
}

function vaultLink(app, file, sourcePath) {
  const md = app.fileManager.generateMarkdownLink(file, sourcePath);
  return EMBED_EXT.test(file.name) ? '!' + md : md;
}

/* Путь файла на диске; пусто — файл без пути (например, скриншот из буфера) */
function diskPathOf(file) {
  try {
    const eu = require('electron').webUtils;
    if (eu && typeof eu.getPathForFile === 'function') return eu.getPathForFile(file) || '';
  } catch (e) { /* нет webUtils */ }
  return file.path || '';
}

/* offset: место вставки; null — вместо выделения (при вставке из буфера) */
async function handleHeavyDrop(plugin, files, heavy, editor, sourcePath, offset) {
  const app = plugin.app;
  const st = plugin.settings;
  const fs = require('fs');
  const dir = st.heavyFolder.trim().replace(/[\\\/]+$/, '');
  const list = heavy.map(function (f) { return '• ' + f.name + ' — ' + fmtSize(f.size); }).join('\n');
  const r = await askDialog(app, {
    title: heavy.length === 1 ? 'Тяжёлый файл' : 'Тяжёлые файлы',
    message: (heavy.length === 1 ? 'Файл больше ' : 'Файлы больше ') + st.heavyThresholdKB + ' КБ:\n' + list +
             '\n\nПоложить в папку тяжёлых файлов?\n' + dir,
    buttons: [{ text: 'Отмена' }, { text: 'Нет, в хранилище', value: 'no' }, { text: 'Да, в тяжёлые', value: 'yes', cta: true }]
  });
  if (!r) return;
  const parts = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    if (r._button === 'yes' && heavy.indexOf(f) >= 0) {
      fs.mkdirSync(dir, { recursive: true });
      const name = f.name.replace(/[\\/:*?"<>|]/g, '-');
      const dest = uniqueDiskPath(dir, name);
      fs.writeFileSync(dest, Buffer.from(buf));
      parts.push(diskLink(dest, require('path').basename(dest)));
    } else {
      const path = await attachmentPath(app, f.name, sourcePath);
      const tf = await app.vault.createBinary(path, buf);
      parts.push(vaultLink(app, tf, sourcePath));
    }
  }
  const text = parts.join('\n');
  if (offset == null) {
    editor.replaceSelection(text);
  } else {
    editor.replaceRange(text, editor.offsetToPos(offset));
    editor.setCursor(editor.offsetToPos(offset + text.length));
  }
  if (r._button === 'yes') new Notice('Сохранено в ' + dir);
}

/* 57 — удалить ссылку и предложить удалить цель */
async function deleteWithTarget(ctx) {
  const app = ctx.plugin.app;
  const f = ctx.link.file;
  const count = refCount(app, f.path);
  if (!verify(ctx)) return;
  deleteLink(ctx);
  if (count > 1) {
    new Notice('Ссылка удалена. На файл ссылаются ещё ' + (count - 1) + ' — файл оставлен');
    return;
  }
  const r = await askDialog(app, {
    title: 'Удалить и файл?',
    message: 'На «' + f.path + '» больше никто не ссылается.',
    buttons: [{ text: 'Оставить файл' }, { text: 'Удалить файл', value: 'del', warning: true }]
  });
  if (r && r._button === 'del') {
    await app.fileManager.trashFile(f);
    new Notice('Файл удалён: ' + f.path);
  }
}

/* 62 — создать заметку: папка, шаблон, подтверждение */
function templaterApi(app) {
  const t = app.plugins && app.plugins.plugins && app.plugins.plugins['templater-obsidian'];
  return t && t.templater && typeof t.templater.create_new_note_from_template === 'function' ? t.templater : null;
}

function templatesFolder(plugin) {
  const app = plugin.app;
  if (plugin.settings.templatesFolder) return plugin.settings.templatesFolder.replace(/\/+$/, '');
  const t = app.plugins && app.plugins.plugins && app.plugins.plugins['templater-obsidian'];
  if (t && t.settings && t.settings.templates_folder) return String(t.settings.templates_folder).replace(/\/+$/, '');
  const ip = app.internalPlugins;
  const core = ip && ip.getPluginById && ip.getPluginById('templates');
  if (core && core.enabled && core.instance && core.instance.options && core.instance.options.folder) {
    return String(core.instance.options.folder).replace(/\/+$/, '');
  }
  return '';
}

function applyCoreTemplate(text, title) {
  const m = window.moment;
  return text
    .replace(/\{\{title\}\}/gi, title)
    .replace(/\{\{date(?::([^}]+))?\}\}/gi, function (x, f) { return m().format(f || 'YYYY-MM-DD'); })
    .replace(/\{\{time(?::([^}]+))?\}\}/gi, function (x, f) { return m().format(f || 'HH:mm'); });
}

async function createNote(ctx) {
  const l = ctx.link;
  const plugin = ctx.plugin;
  const app = plugin.app;
  const lp = l.linkpath.replace(/\.md$/i, '');
  const slash = lp.lastIndexOf('/');
  const baseName = slash >= 0 ? lp.slice(slash + 1) : lp;
  let defFolder = slash >= 0 ? lp.slice(0, slash) : '';
  if (slash < 0) {
    const parent = app.fileManager.getNewFileParent(ctx.sourcePath);
    defFolder = parent && parent.path !== '/' ? parent.path : '';
  }
  const tf = templatesFolder(plugin);
  const tpls = tf ? app.vault.getMarkdownFiles().filter(function (f) { return f.path.indexOf(tf + '/') === 0; }) : [];
  tpls.sort(function (a, b) { return a.path.localeCompare(b.path); });
  const options = [['', 'без шаблона']].concat(tpls.map(function (f) { return [f.path, f.path.slice(tf.length + 1).replace(/\.md$/, '')]; }));
  const last = plugin.settings.lastTemplate;

  const r = await askDialog(app, {
    title: 'Новая заметка',
    fields: [
      { key: 'name', label: 'Имя', value: baseName },
      { key: 'folder', label: 'Папка', value: defFolder, suggestFolders: true, desc: 'Пусто — корень хранилища' },
      { key: 'tpl', label: 'Шаблон', type: 'dropdown', options: options,
        value: tpls.some(function (f) { return f.path === last; }) ? last : '',
        desc: tf ? 'Из папки ' + tf + (templaterApi(app) ? ', обрабатывается Templater' : '') : 'Папка шаблонов не найдена — укажи её в настройках плагина' }
    ],
    buttons: [{ text: 'Отмена' }, { text: 'Создать', value: 'create' }, { text: 'Создать и открыть', value: 'open', cta: true }]
  });
  if (!r) return;

  const name = sanitizeName(r.name);
  if (!name) { new Notice('Пустое имя'); return; }
  const folder = r.folder.trim().replace(/^\/+|\/+$/g, '');
  const path = (folder ? folder + '/' : '') + name + '.md';
  if (app.vault.getAbstractFileByPath(path)) { new Notice('Заметка уже есть: ' + path); return; }
  if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);

  const tplFile = r.tpl ? app.vault.getAbstractFileByPath(r.tpl) : null;
  const tp = templaterApi(app);
  let file;
  if (tplFile && tp) {
    const folderObj = folder ? app.vault.getAbstractFileByPath(folder) : app.vault.getRoot();
    file = await tp.create_new_note_from_template(tplFile, folderObj, name, false);
  } else {
    const content = tplFile ? applyCoreTemplate(await app.vault.read(tplFile), name) : '';
    file = await app.vault.create(path, content);
  }
  plugin.settings.lastTemplate = r.tpl || '';
  await plugin.saveSettings();
  if (!file) { new Notice('Заметку создать не удалось'); return; }

  const resolved = app.metadataCache.getFirstLinkpathDest(l.linkpath, ctx.sourcePath);
  if (!resolved || resolved.path !== file.path) {
    applyEdit(ctx, null, app.metadataCache.fileToLinktext(file, ctx.sourcePath, true) + (l.subpath || ''));
  }
  if (r._button === 'open') await app.workspace.getLeaf('tab').openFile(file);
  else new Notice('Создана заметка: ' + file.path);
}

/* 63 — переименовать цель */
async function renameTarget(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  if (hasVaultFile(l)) {
    const f = l.file;
    const r = await askDialog(app, {
      title: 'Переименовать',
      message: f.path,
      fields: [{ key: 'name', label: 'Новое имя', value: f.basename,
        desc: 'Ссылки на файл Obsidian обновит сам, если в настройках «Файлы и ссылки» включено автообновление ссылок.' }],
      buttons: [{ text: 'Отмена' }, { text: 'Переименовать', value: 'go', cta: true }]
    });
    if (!r) return;
    const name = sanitizeName(r.name);
    if (!name || name === f.basename) return;
    const dir = f.parent && f.parent.path !== '/' ? f.parent.path + '/' : '';
    const np = dir + name + '.' + f.extension;
    if (app.vault.getAbstractFileByPath(np)) { new Notice('Уже есть: ' + np); return; }
    await app.fileManager.renameFile(f, np);
    new Notice('Переименовано: ' + np);
    return;
  }
  const fs = require('fs');
  const pathMod = require('path');
  const p = fileUrlToPath(l.dest);
  if (!fs.existsSync(p)) { new Notice('Файл не найден: ' + p); return; }
  const r = await askDialog(app, {
    title: 'Переименовать файл на диске',
    message: p,
    fields: [{ key: 'name', label: 'Новое имя', value: pathMod.basename(p), desc: 'Ссылки на этот файл во всех заметках будут обновлены.' }],
    buttons: [{ text: 'Отмена' }, { text: 'Переименовать', value: 'go', cta: true }]
  });
  if (!r) return;
  const name = r.name.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!name || name === pathMod.basename(p)) return;
  const np = pathMod.join(pathMod.dirname(p), name);
  if (fs.existsSync(np)) { new Notice('Уже есть: ' + np); return; }
  fs.renameSync(p, np);
  const n = await relinkDisk(ctx, p, np);
  new Notice('Переименовано. Обновлено ссылок: ' + n);
}

/* 64 — переместить цель */
async function moveTarget(ctx) {
  const l = ctx.link;
  const plugin = ctx.plugin;
  const app = plugin.app;
  if (hasVaultFile(l)) {
    const f = l.file;
    const folders = app.vault.getAllLoadedFiles().filter(function (x) { return x instanceof obsidian.TFolder; })
      .map(function (x) { return { label: x.path === '/' ? '/ (корень)' : x.path, folder: x }; });
    const pick = await pickFrom(app, folders, 'Куда переместить ' + f.name);
    if (!pick) return;
    const dir = pick.folder.path === '/' ? '' : pick.folder.path + '/';
    const np = dir + f.name;
    if (np === f.path) return;
    if (app.vault.getAbstractFileByPath(np)) { new Notice('Уже есть: ' + np); return; }
    await app.fileManager.renameFile(f, np);
    new Notice('Перемещено: ' + np);
    return;
  }
  const fs = require('fs');
  const pathMod = require('path');
  const p = fileUrlToPath(l.dest);
  if (!fs.existsSync(p)) { new Notice('Файл не найден: ' + p); return; }
  const r = await askDialog(app, {
    title: 'Переместить файл на диске',
    message: p,
    fields: [{ key: 'dir', label: 'Новая папка', value: pathMod.dirname(p), desc: 'Ссылки на этот файл во всех заметках будут обновлены.' }],
    buttons: [{ text: 'Отмена' }, { text: 'Переместить', value: 'go', cta: true }]
  });
  if (!r) return;
  const dir = r.dir.trim().replace(/[\\\/]+$/, '');
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const np = pathMod.join(dir, pathMod.basename(p));
  if (np === p) return;
  if (fs.existsSync(np)) { new Notice('Уже есть: ' + np); return; }
  moveOnDisk(p, np);
  const n = await relinkDisk(ctx, p, np);
  new Notice('Перемещено. Обновлено ссылок: ' + n);
}

/* 65 — удалить цель */
async function deleteTarget(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  const vaultFile = hasVaultFile(l);
  const label = vaultFile ? l.file.path : fileUrlToPath(l.dest);
  const r = await askDialog(app, {
    title: 'Удалить файл?',
    message: label + (vaultFile ? '' : '\nФайл уйдёт в корзину Windows.'),
    buttons: [{ text: 'Отмена' }, { text: 'Удалить файл', value: 'file', warning: true }, { text: 'Удалить файл и ссылку', value: 'both', warning: true }]
  });
  if (!r) return;
  if (vaultFile) {
    await app.fileManager.trashFile(l.file);
  } else {
    const sh = electronShell();
    if (!sh) return;
    await sh.trashItem(label);
  }
  if (r._button === 'both') deleteLink(ctx);
  new Notice('Удалено: ' + label);
}

/* 69 — вставить содержимое цели на место ссылки */
async function insertContent(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  const f = l.file;
  const content = await app.vault.cachedRead(f);
  const cache = app.metadataCache.getFileCache(f) || {};
  let text = null;
  if (l.subpath && typeof obsidian.resolveSubpath === 'function') {
    const r = obsidian.resolveSubpath(cache, l.subpath);
    if (r) {
      text = content.slice(r.start.offset, r.end ? r.end.offset : content.length);
      if (r.type === 'block') text = text.replace(/\s*\^[\w-]+\s*$/, '');
    }
  }
  if (text == null) {
    const fmEnd = cache.frontmatterPosition ? cache.frontmatterPosition.end.offset : 0;
    text = content.slice(fmEnd);
  }
  text = text.replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (!text) { new Notice('Содержимое пустое'); return; }
  if (!verify(ctx)) return;
  const line = ctx.editor.getLine(ctx.line);
  if (line.trim() === l.raw) replaceSpan(ctx, 0, line.length, text);
  else replaceSpan(ctx, l.from, l.to, text);
  ctx.editor.focus();
}


/* ------------------------------------------------------------------ */
/*  Этап 3: сеть                                                       */
/* ------------------------------------------------------------------ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/* Загрузка страницы с учётом кодировки (в том числе windows-1251) */
async function fetchHtml(url) {
  const r = await obsidian.requestUrl({
    url: url, method: 'GET', throw: false,
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ru,en;q=0.8' }
  });
  const h = r.headers || {};
  const ct = String(h['content-type'] || h['Content-Type'] || '');
  const bytes = new Uint8Array(r.arrayBuffer);
  let cs = (ct.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
    const m = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
    cs = m && m[1];
  }
  let html;
  try { html = new TextDecoder(String(cs || 'utf-8').toLowerCase()).decode(bytes); }
  catch (e) { html = new TextDecoder('utf-8').decode(bytes); }
  return { status: r.status, html: html, ct: ct };
}

function titleFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = function (sel) { const m = doc.querySelector(sel); return m ? (m.getAttribute('content') || '').trim() : ''; };
  const t = (doc.title || '').trim() || meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]');
  return t.replace(/\s+/g, ' ').trim();
}

async function pageTitle(plugin, url) {
  const r = await fetchHtml(url);
  if (r.status >= 400) throw new Error('страница ответила кодом ' + r.status);
  if (!/html|xml/i.test(r.ct) && r.ct) throw new Error('это не веб-страница (' + r.ct.split(';')[0] + ')');
  let t = titleFromHtml(r.html);
  if (t && plugin.settings.titleStripSite) {
    const cut = t.replace(/\s+[—–|-]\s+[^—–|]{1,40}$/, '');
    if (cut.length >= 8) t = cut;
  }
  return t;
}

function htmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* 29, 42 — текст из заголовка страницы */
async function titleFromPage(ctx) {
  const l = ctx.link;
  const url = destForCopy(l);
  new Notice('Загружаю заголовок…', 1500);
  let t;
  try { t = await pageTitle(ctx.plugin, url); }
  catch (e) { new Notice('Не удалось получить заголовок: ' + e.message); return; }
  if (!t) { new Notice('У страницы нет заголовка'); return; }
  applyEdit(ctx, l.kind === 'html' ? htmlEscape(t) : t, null);
}

/* 48 — <iframe> в обычную ссылку с заголовком страницы */
async function iframeToLinkTitled(ctx) {
  const url = ctx.link.dest;
  let t = '';
  try { t = await pageTitle(ctx.plugin, url); } catch (e) { t = ''; }
  const d = url.replace(/ /g, '%20');
  replaceWhole(ctx, t ? '[' + escMdText(t) + '](' + mdDest(url) + ')' : d);
}

/* Запрос без тела ответа, чтобы видеть коды и перенаправления */
function nodeRequest(url, method) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('неверный адрес')); return; }
    const mod = u.protocol === 'http:' ? require('http') : require('https');
    const req = mod.request(u, {
      method: method, timeout: 10000,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ru,en;q=0.8' }
    }, function (res) {
      resolve({ status: res.statusCode, headers: res.headers });
      res.destroy();
    });
    req.on('timeout', function () { req.destroy(new Error('сайт не ответил за 10 секунд')); });
    req.on('error', reject);
    req.end();
  });
}

async function followRedirects(url) {
  let cur = url;
  const hops = [];
  for (let i = 0; i < 10; i++) {
    let r = await nodeRequest(cur, 'HEAD');
    if ([400, 403, 405, 501].indexOf(r.status) >= 0) r = await nodeRequest(cur, 'GET');
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      cur = new URL(r.headers.location, cur).toString();
      hops.push(cur);
      continue;
    }
    return { status: r.status, final: cur, hops: hops };
  }
  return { status: 0, final: cur, hops: hops, loop: true };
}

/* 60 — проверить ссылку */
async function checkLink(ctx) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  if (isVault(l)) {
    if (!l.file) { new Notice('В хранилище нет такой заметки или файла'); return; }
    if (l.subpath && typeof obsidian.resolveSubpath === 'function') {
      const cache = app.metadataCache.getFileCache(l.file);
      if (cache && !obsidian.resolveSubpath(cache, l.subpath)) {
        new Notice('Файл есть: ' + l.file.path + '\nНо раздела или блока ' + l.subpath + ' в нём нет', 6000);
        return;
      }
    }
    new Notice('Файл есть: ' + l.file.path);
    return;
  }
  if (isFileUrl(l)) {
    const fs = require('fs');
    const p = fileUrlToPath(l.dest);
    if (fs.existsSync(p)) new Notice('Файл есть: ' + p + ' — ' + fmtSize(fs.statSync(p).size), 5000);
    else new Notice('Файла нет: ' + p, 6000);
    return;
  }
  const url = destForCopy(l);
  new Notice('Проверяю…', 1500);
  let r;
  try { r = await followRedirects(url); }
  catch (e) { new Notice('Сайт не отвечает: ' + e.message, 6000); return; }
  const s = r.status;
  let msg;
  if (r.loop) msg = 'Бесконечные перенаправления';
  else if (s >= 200 && s < 300) msg = 'Работает (' + s + ')';
  else if (s === 404 || s === 410) msg = 'Страница не найдена (' + s + ')';
  else if (s === 401 || s === 403) msg = 'Доступ закрыт (' + s + '). В браузере страница может открываться';
  else if (s === 429) msg = 'Сайт просит не частить (429). Проверь позже';
  else if (s >= 500) msg = 'Ошибка на стороне сайта (' + s + ')';
  else msg = 'Ответ ' + s;
  if (r.hops.length && !r.loop) msg += '\nПеренаправляет на: ' + decodePct(r.final);
  new Notice(msg, r.hops.length ? 8000 : 5000);
}

function shortenerHosts(plugin) {
  return String(plugin.settings.shorteners || '').split(/[\s,;]+/).filter(Boolean).map(function (x) { return x.toLowerCase(); });
}

function isShortened(plugin, l) {
  if (!isWeb(l)) return false;
  const m = destForCopy(l).match(/^https?:\/\/(?:www\.)?([^\/:?#\s]+)/i);
  return !!m && shortenerHosts(plugin).indexOf(m[1].toLowerCase()) >= 0;
}

/* 61 — раскрыть сокращённую ссылку */
async function unshorten(ctx) {
  const url = destForCopy(ctx.link);
  new Notice('Раскрываю…', 1500);
  let r;
  try { r = await followRedirects(url); }
  catch (e) { new Notice('Не удалось: ' + e.message, 6000); return; }
  if (!r.hops.length) { new Notice('Ссылка никуда не перенаправляет'); return; }
  const fin = decodePct(r.final);
  applyEdit(ctx, null, fin);
  new Notice('Ведёт на: ' + fin, 6000);
}

/* 9 — предпросмотр страницы во всплывающем окне */
let previewState = null;

function closePreview() {
  if (!previewState) return;
  const s = previewState;
  previewState = null;
  s.doc.removeEventListener('keydown', s.onKey, true);
  s.doc.removeEventListener('mousedown', s.onDown, true);
  s.panel.remove();
}

function openPreview(ctx) {
  closePreview();
  const url = destForCopy(ctx.link);
  const doc = ctx.targetEl.ownerDocument;
  const win = doc.defaultView;
  const x = ctx.evt ? ctx.evt.clientX : ctx.at.x;
  const y = ctx.evt ? ctx.evt.clientY : ctx.at.y;
  const w = Math.min(960, Math.round(win.innerWidth * 0.62));
  const h = Math.min(680, Math.round(win.innerHeight * 0.72));
  const left = Math.max(8, Math.min(x + 12, win.innerWidth - w - 8));
  const top = Math.max(8, Math.min(y + 12, win.innerHeight - h - 8));

  const panel = doc.body.createDiv({ cls: 'ylm-preview' });
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  panel.style.width = w + 'px';
  panel.style.height = h + 'px';

  const head = panel.createDiv({ cls: 'ylm-preview-head' });
  const title = head.createDiv({ cls: 'ylm-preview-title', text: decodePct(url) });
  const openBtn = head.createDiv({ cls: 'ylm-preview-btn', attr: { 'aria-label': 'Открыть в браузере' } });
  obsidian.setIcon(openBtn, 'external-link');
  const closeBtn = head.createDiv({ cls: 'ylm-preview-btn', attr: { 'aria-label': 'Закрыть (Esc)' } });
  obsidian.setIcon(closeBtn, 'x');

  const body = panel.createDiv({ cls: 'ylm-preview-body' });
  const loading = body.createDiv({ cls: 'ylm-preview-loading', text: 'Загружаю страницу…' });

  const wv = doc.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', '');
  body.appendChild(wv);
  wv.addEventListener('did-stop-loading', function () { loading.remove(); });
  wv.addEventListener('page-title-updated', function (e) { if (e.title) title.setText(e.title); });
  wv.addEventListener('did-fail-load', function (e) {
    if (e.errorCode === -3) return;
    loading.setText('Страница не загрузилась: ' + (e.errorDescription || e.errorCode));
  });
  setTimeout(function () {
    if (typeof wv.getURL === 'function' || !panel.isConnected) return;
    // webview недоступен — показываем через iframe (часть сайтов это запрещает)
    wv.remove();
    const fr = body.createEl('iframe', { attr: { src: url, sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups' } });
    fr.addEventListener('load', function () { loading.remove(); });
  }, 800);

  openBtn.addEventListener('click', function () {
    const sh = electronShell();
    if (sh) sh.openExternal(url); else window.open(url);
    closePreview();
  });
  closeBtn.addEventListener('click', closePreview);

  const onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePreview(); } };
  const onDown = function (e) { if (!panel.contains(e.target)) closePreview(); };
  doc.addEventListener('keydown', onKey, true);
  setTimeout(function () { if (previewState) doc.addEventListener('mousedown', onDown, true); }, 0);
  previewState = { panel: panel, doc: doc, onKey: onKey, onDown: onDown };
}

/* ------------------------------------------------------------------ */
/*  Скриншоты из буфера                                                */
/* ------------------------------------------------------------------ */

const SHOT_MIME = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' };
const SHOT_EXT = { webp: 'webp', jpeg: 'jpg', png: 'png' };

async function processImage(blob, fmt, quality, maxW) {
  const bmp = await createImageBitmap(blob);
  const ow = bmp.width;
  const oh = bmp.height;
  let w = ow;
  let h = oh;
  if (maxW > 0 && ow > maxW) { w = maxW; h = Math.round(oh * maxW / ow); }
  if (fmt === 'png' && w === ow) {
    if (bmp.close) bmp.close();
    return { blob: blob, w: w, h: h, ow: ow, oh: oh };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (fmt === 'jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
  g.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const out = await new Promise(function (res) { c.toBlob(res, SHOT_MIME[fmt] || 'image/webp', quality / 100); });
  return { blob: out || blob, w: w, h: h, ow: ow, oh: oh };
}

function shotBaseName(plugin, sourcePath) {
  const st = plugin.settings;
  const note = sourcePath ? sourcePath.split('/').pop().replace(/\.md$/i, '') : 'Скриншот';
  const date = window.moment().format(st.shotDateFormat || 'YYYY-MM-DD HH-mm-ss');
  return sanitizeName(String(st.shotName || '{note} {date}').replace(/\{note\}/g, note).replace(/\{date\}/g, date)) || 'Скриншот ' + date;
}

class ShotModal extends obsidian.Modal {
  constructor(app, plugin, source, opts, done) {
    super(app);
    this.plugin = plugin;
    this.source = source;
    this.opts = Object.assign({}, opts);
    this.done = done;
    this.res = null;
    this.seq = 0;
    this.result = null;
  }
  onOpen() {
    const self = this;
    const st = this.plugin.settings;
    const c = this.contentEl;
    this.modalEl.addClass('ylm-shot-modal');
    this.titleEl.setText('Скриншот');

    const pv = c.createDiv({ cls: 'ylm-shot-preview' });
    this.img = pv.createEl('img');
    this.stats = c.createDiv({ cls: 'ylm-shot-stats' });

    new Setting(c).setName('Имя').addText(function (t) {
      t.setValue(self.opts.name);
      t.inputEl.style.width = '100%';
      self.nameInput = t;
      t.inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); self.finish(self.defaultDest()); }
      });
      setTimeout(function () { t.inputEl.focus(); t.inputEl.select(); }, 20);
    });
    new Setting(c).setName('Формат').addDropdown(function (d) {
      d.addOption('webp', 'WebP').addOption('jpeg', 'JPEG').addOption('png', 'PNG');
      d.setValue(self.opts.fmt);
      d.onChange(function (v) { self.opts.fmt = v; self.quality.setDisabled(v === 'png'); self.schedule(); });
    });
    this.quality = new Setting(c).setName('Качество').addSlider(function (sl) {
      sl.setLimits(40, 100, 1).setValue(self.opts.q).setDynamicTooltip()
        .onChange(function (v) { self.opts.q = v; self.schedule(); });
    });
    this.quality.setDisabled(this.opts.fmt === 'png');
    new Setting(c).setName('Наибольшая ширина, px').setDesc('0 — не уменьшать').addText(function (t) {
      t.setValue(String(self.opts.maxW));
      t.onChange(function (v) { self.opts.maxW = parseInt(v, 10) || 0; self.schedule(); });
    });

    const bs = new Setting(c);
    bs.addButton(function (b) { b.setButtonText('Отмена').onClick(function () { self.close(); }); });
    bs.addButton(function (b) { self.vaultBtn = b; b.setButtonText('В хранилище').onClick(function () { self.finish('vault'); }); });
    if (st.heavyFolder) bs.addButton(function (b) { self.heavyBtn = b; b.setButtonText('В тяжёлые').onClick(function () { self.finish('heavy'); }); });

    this.recompute();
  }
  schedule() {
    const self = this;
    clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.recompute(); }, 200);
  }
  isHeavy() {
    const st = this.plugin.settings;
    return !!st.heavyFolder && !!this.res && this.res.blob.size > st.heavyThresholdKB * 1024;
  }
  defaultDest() { return this.isHeavy() && this.heavyBtn ? 'heavy' : 'vault'; }
  async recompute() {
    const my = ++this.seq;
    const r = await processImage(this.source, this.opts.fmt, this.opts.q, this.opts.maxW);
    if (my !== this.seq || !this.modalEl.isConnected) return;
    this.res = r;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(r.blob);
    this.img.src = this.url;

    this.stats.empty();
    const dim = this.stats.createDiv();
    dim.appendText(r.ow + '×' + r.oh);
    if (r.w !== r.ow) { dim.appendText(' → '); dim.createEl('b', { text: r.w + '×' + r.h }); }
    const sz = this.stats.createDiv();
    sz.appendText(fmtSize(this.source.size) + ' → ');
    sz.createEl('b', { text: fmtSize(r.blob.size) });
    const pct = Math.round((1 - r.blob.size / this.source.size) * 100);
    const heavy = this.isHeavy();
    const gain = sz.createSpan({ cls: 'ylm-shot-gain' + (heavy ? ' is-heavy' : '') });
    gain.setText(heavy ? '  больше ' + this.plugin.settings.heavyThresholdKB + ' КБ' : (pct > 0 ? '  −' + pct + '%' : ''));

    if (this.vaultBtn) this.vaultBtn.buttonEl.toggleClass('mod-cta', !heavy || !this.heavyBtn);
    if (this.heavyBtn) this.heavyBtn.buttonEl.toggleClass('mod-cta', heavy);
  }
  finish(dest) {
    if (!this.res) return;
    this.result = { dest: dest, name: this.nameInput.getValue(), fmt: this.opts.fmt, res: this.res };
    this.close();
  }
  onClose() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.contentEl.empty();
    this.done(this.result);
  }
}

async function handleShot(plugin, file, editor, sourcePath) {
  const app = plugin.app;
  const st = plugin.settings;
  let fmt = st.shotFormat;
  let name = shotBaseName(plugin, sourcePath);
  let res;
  let dest = 'vault';

  if (st.shotDialog) {
    const r = await new Promise(function (resolve) {
      new ShotModal(app, plugin, file, { fmt: fmt, q: st.shotQuality, maxW: st.shotMaxWidth, name: name }, resolve).open();
    });
    if (!r) return;
    res = r.res;
    fmt = r.fmt;
    name = sanitizeName(r.name) || name;
    dest = r.dest;
  } else {
    res = await processImage(file, fmt, st.shotQuality, st.shotMaxWidth);
    if (st.heavyFolder && res.blob.size > st.heavyThresholdKB * 1024) {
      if (st.shotHeavy === 'heavy') dest = 'heavy';
      else if (st.shotHeavy === 'ask') {
        const q = await askDialog(app, {
          title: 'Тяжёлый скриншот',
          message: 'После сжатия скриншот весит ' + fmtSize(res.blob.size) + ' — больше ' + st.heavyThresholdKB +
                   ' КБ.\n\nПоложить в папку тяжёлых файлов?\n' + st.heavyFolder,
          buttons: [{ text: 'Отмена' }, { text: 'Нет, в хранилище', value: 'vault' }, { text: 'Да, в тяжёлые', value: 'heavy', cta: true }]
        });
        if (!q) return;
        dest = q._button;
      }
    }
  }

  const fileName = name + '.' + SHOT_EXT[fmt];
  const buf = await res.blob.arrayBuffer();
  let text;
  if (dest === 'heavy') {
    const fs = require('fs');
    const dir = st.heavyFolder.trim().replace(/[\\\/]+$/, '');
    fs.mkdirSync(dir, { recursive: true });
    const p = uniqueDiskPath(dir, fileName);
    fs.writeFileSync(p, Buffer.from(buf));
    text = '![](' + fileUrlFromPath(p) + ')';
  } else {
    const path = await attachmentPath(app, fileName, sourcePath);
    const tf = await app.vault.createBinary(path, buf);
    text = vaultLink(app, tf, sourcePath);
  }
  editor.replaceSelection(text);
  if (!st.shotDialog) new Notice('Скриншот: ' + fmtSize(file.size) + ' → ' + fmtSize(res.blob.size) + (dest === 'heavy' ? ', в тяжёлые' : ''), 2500);
}

/* ------------------------------------------------------------------ */
/*  Варианты текста (подменю «Текст ссылки»)                           */
/* ------------------------------------------------------------------ */

function textVariants(ctx) {
  const plugin = ctx.plugin;
  const l = ctx.link;
  const opt = plugin.settings.clean;
  const items = [];
  const name = cleanText(nameOf(l, opt), opt, false);
  items.push({ title: 'Имя: ' + short(name, 40), icon: 'file-text', run: function () { setWikiText(ctx, name); } });
  const h = headingOf(plugin.app, l);
  if (h) {
    const hc = cleanText(h, opt, true);
    items.push({ title: 'Заголовок: ' + short(hc, 40), icon: 'heading', run: function () { setWikiText(ctx, hc); } });
  }
  if ((l.subpath || '').indexOf('#^') === 0) {
    items.push({
      title: 'Текст блока', icon: 'text',
      run: function () {
        blockTextOf(plugin.app, l, plugin.settings.blockTextLength).then(function (bt) {
          if (bt) setWikiText(ctx, cleanText(bt, opt, true));
          else new Notice('Блок не найден');
        });
      }
    });
  }
  const full = l.dest.replace(/\.md(?=#|$)/i, '');
  if (full !== name) items.push({ title: 'Путь целиком: ' + short(full, 40), icon: 'folder', run: function () { setWikiText(ctx, full); } });
  aliasesOf(plugin.app, l).forEach(function (a) {
    items.push({ title: 'Алиас: ' + short(a, 40), icon: 'tag', run: function () { setWikiText(ctx, a); } });
  });
  if (l.text != null) items.push({ title: 'Убрать текст', icon: 'eraser', run: function () { removeWikiText(ctx); } });
  return items;
}

/* ------------------------------------------------------------------ */
/*  Реестр действий                                                    */
/* ------------------------------------------------------------------ */

const GROUPS = [
  { id: 'open', title: 'Открыть', icon: 'file-text' },
  { id: 'copy', title: 'Копировать', icon: 'copy' },
  { id: 'edit', title: 'Правка', icon: 'pencil' },
  { id: 'text', title: 'Текст ссылки', icon: 'type' },
  { id: 'convert', title: 'Преобразовать', icon: 'repeat' },
  { id: 'remove', title: 'Удалить', icon: 'trash-2' },
  { id: 'find', title: 'Найти', icon: 'search' },
  { id: 'file', title: 'Файл', icon: 'folder' }
];

function always() { return true; }
function textEditable(l) { return (l.kind === 'wiki' && !l.embed) || l.kind === 'md' || l.kind === 'html'; }

/*
 * place: по умолчанию — 'top' (на виду) или 'sub' (в подменю группы).
 * when(l, ctx): к каким ссылкам пункт применим.
 * items(ctx): для пунктов, которые раскрываются в несколько строк.
 * label: название в настройках, если заголовок пункта зависит от ссылки.
 */
const ACTIONS = [
  /* Открыть */
  { id: 'open', group: 'open', place: 'top', icon: 'file-text', label: 'Открыть',
    title: function (l) { return l.unresolved ? 'Создать заметку и открыть' : 'Открыть'; },
    when: function (l) { return l.kind !== 'iframe'; },
    run: function (c) { openLink(c, false); } },
  { id: 'create-note', group: 'file', place: 'top', icon: 'file-plus-2', title: 'Создать заметку…',
    when: function (l) { return l.kind === 'wiki' && !!l.unresolved && !!l.linkpath; }, run: createNote },
  { id: 'open-tab', group: 'open', place: 'top', icon: 'file-plus', title: 'Открыть в новой вкладке',
    when: isVault, run: function (c) { openLink(c, 'tab'); } },
  { id: 'open-split', group: 'open', place: 'sub', icon: 'columns', title: 'Открыть справа',
    when: isVault, run: function (c) { openLink(c, 'split'); } },
  { id: 'open-window', group: 'open', place: 'sub', icon: 'app-window', title: 'Открыть в новом окне',
    when: isVault, run: function (c) { openLink(c, 'window'); } },
  { id: 'open-browser', group: 'open', place: 'sub', icon: 'globe', title: 'Открыть в системном браузере',
    when: isExternal, run: openInSystemBrowser },
  { id: 'open-with', group: 'open', place: 'sub', icon: 'globe', label: 'Открыть в выбранном браузере',
    when: function (l, c) {
      const okType = isExternal(l) || (isFileUrl(l) && /\.html?(?:[#?].*)?$/i.test(l.dest));
      return okType && parseBrowsers(c.plugin.settings.browsers).length > 0;
    },
    items: openWithItems },
  { id: 'open-archive', group: 'open', place: 'sub', icon: 'history', title: 'Открыть архивную копию страницы',
    when: isWeb, run: openArchive },
  { id: 'preview', group: 'open', place: 'sub', icon: 'eye', title: 'Предпросмотр страницы',
    when: isWeb, run: openPreview },

  /* Копировать */
  { id: 'copy-dest', group: 'copy', place: 'top', icon: 'link', title: 'Копировать адрес',
    when: always, run: function (c) { copyText(destForCopy(c.link), 'Адрес скопирован'); } },
  { id: 'copy-raw', group: 'copy', place: 'sub', icon: 'copy', title: 'Копировать ссылку целиком',
    when: always, run: function (c) { copyText(c.link.raw, 'Ссылка скопирована'); } },
  { id: 'copy-text', group: 'copy', place: 'sub', icon: 'type', title: 'Копировать текст ссылки',
    when: function (l) { return !!l.text && !(l.kind === 'wiki' && l.embed); },
    run: function (c) { copyText(c.link.kind === 'html' ? c.link.text.replace(/<[^>]+>/g, '') : c.link.text, 'Текст скопирован'); } },
  { id: 'copy-obsidian-url', group: 'copy', place: 'sub', icon: 'link-2', title: 'Копировать obsidian:// URL',
    when: hasVaultFile, run: function (c) { copyText(obsidianUrl(c.plugin.app, c.link.file), 'URL скопирован'); } },
  { id: 'copy-path', group: 'copy', place: 'sub', icon: 'folder-tree', label: 'Копировать путь к файлу',
    when: hasVaultFile, items: copyPathItems },
  { id: 'copy-winpath', group: 'copy', place: 'sub', icon: 'hard-drive', title: 'Копировать как путь Windows',
    when: isFileUrl, run: function (c) { copyText(fileUrlToPath(c.link.dest), 'Путь скопирован'); } },
  { id: 'copy-image', group: 'copy', place: 'sub', icon: 'image', title: 'Копировать картинку',
    when: isImage, run: copyImage },
  { id: 'copy-gh-number', group: 'copy', place: 'sub', icon: 'hash', title: 'GitHub: копировать номер',
    when: function (l) { return !!ghInfo(l); }, run: function (c) { copyText('#' + ghInfo(c.link).num, 'Номер скопирован'); } },
  { id: 'cut', group: 'copy', place: 'sub', icon: 'scissors', title: 'Вырезать ссылку',
    when: always, run: cutLink },

  /* Правка */
  { id: 'edit-text', group: 'edit', place: 'top', icon: 'pencil', label: 'Редактировать текст',
    title: function (l) { return l.embed ? 'Редактировать подпись' : 'Редактировать текст'; },
    when: textEditable, run: editText },
  { id: 'edit-dest', group: 'edit', place: 'sub', icon: 'pencil-line', title: 'Редактировать адрес',
    when: function (l) { return l.destFrom != null; }, run: editDest },
  { id: 'edit-form', group: 'edit', place: 'sub', icon: 'text-cursor-input', title: 'Правка в окне: текст и адрес',
    when: function (l) { return textEditable(l) || l.kind === 'bare' || l.kind === 'auto'; }, run: editForm },
  { id: 'auto-text', group: 'edit', place: 'top', icon: 'heading', title: 'Текст = заголовок или имя',
    when: function (l) { return l.kind === 'wiki' && !l.embed && l.text == null; }, run: autoText },
  { id: 'file-name-text', group: 'edit', place: 'sub', icon: 'file', title: 'Текст = имя файла',
    when: function (l) { return isFileUrl(l) && !l.embed && (l.kind === 'md' || l.kind === 'bare' || l.kind === 'auto'); },
    run: fileNameText },
  { id: 'text-from-clipboard', group: 'edit', place: 'sub', icon: 'clipboard-paste', title: 'Текст из буфера',
    when: function (l) { return textEditable(l) || l.kind === 'bare' || l.kind === 'auto'; }, run: textFromClipboard },
  { id: 'dest-from-clipboard', group: 'edit', place: 'sub', icon: 'clipboard-paste', title: 'Адрес из буфера',
    when: function (l) { return l.destFrom != null; }, run: destFromClipboard },
  { id: 'save-alias', group: 'edit', place: 'sub', icon: 'tag', title: 'Сохранить текст как алиас цели',
    when: function (l) { return l.kind === 'wiki' && !l.embed && !!l.text && isMdFile(l); }, run: saveAlias },
  { id: 'pick-heading', group: 'edit', place: 'sub', icon: 'list-tree', title: 'Сменить раздел или блок',
    when: isMdFile, run: pickHeading },
  { id: 'redirect', group: 'edit', place: 'sub', icon: 'corner-up-right', title: 'Перенаправить на другой файл',
    when: isVault, run: redirect },
  { id: 'embed-size', group: 'edit', place: 'sub', icon: 'scaling', title: 'Размер встраивания',
    when: function (l) {
      if (l.kind === 'iframe') return true;
      if (!l.embed) return false;
      if (l.kind === 'wiki') return hasVaultFile(l) && (isImage(l) || isPdf(l));
      return l.kind === 'md';
    },
    run: embedSize },
  { id: 'pdf-page', group: 'edit', place: 'sub', icon: 'file-digit', title: 'Страница PDF',
    when: function (l) { return isPdf(l) && l.kind !== 'iframe' && l.kind !== 'html'; }, run: pdfPage },

  /* Текст ссылки — варианты */
  { id: 'text-variants', group: 'text', place: 'sub', icon: 'type', label: 'Варианты текста',
    when: function (l) { return l.kind === 'wiki' && !l.embed; }, items: textVariants },

  /* Преобразовать */
  { id: 'toggle-embed', group: 'convert', place: 'sub', icon: 'image', label: 'Ссылка ↔ встраивание',
    title: function (l) { return l.embed ? 'Сделать обычной ссылкой (убрать !)' : 'Сделать встраиванием (добавить !)'; },
    when: function (l) { return l.kind === 'wiki' || l.kind === 'md'; }, run: toggleEmbed },
  { id: 'md-to-bare', group: 'convert', place: 'sub', icon: 'link', title: '[текст](адрес) → голый адрес',
    when: function (l) { return l.kind === 'md' && !l.embed && !isVault(l); }, run: mdToBare },
  { id: 'html-to-md', group: 'convert', place: 'sub', icon: 'code', title: 'HTML → [текст](адрес)',
    when: function (l) { return l.kind === 'html'; }, run: htmlToMd },
  { id: 'to-iframe', group: 'convert', place: 'sub', icon: 'app-window', title: 'Встроить страницу через <iframe>',
    when: function (l) { return isWeb(l) && !l.embed; }, run: toIframe },
  { id: 'iframe-to-link', group: 'convert', place: 'sub', icon: 'link', title: '<iframe> → обычная ссылка',
    when: function (l) { return l.kind === 'iframe'; }, run: iframeToLinkTitled },
  { id: 'toggle-path', group: 'convert', place: 'sub', icon: 'folder-tree', label: 'Путь: краткий ↔ полный',
    title: function (l, c) {
      const pf = c && pathForms(c.plugin.app, l, c.sourcePath);
      return pf && pathIsFull(l, pf) ? 'Путь: сделать кратким' : 'Путь: сделать полным';
    },
    when: function (l, c) { const pf = pathForms(c.plugin.app, l, c.sourcePath); return !!pf && pf.short !== pf.full; },
    run: togglePath },
  { id: 'pct-decode', group: 'convert', place: 'sub', icon: 'languages', title: 'Раскодировать %D0%9F… в кириллицу',
    when: function (l) { if (isVault(l)) return false; const d = destForCopy(l); return hasPct(d) && decodePct(d) !== d; },
    run: pctDecode },
  { id: 'pct-encode', group: 'convert', place: 'sub', icon: 'languages', title: 'Закодировать кириллицу в %D0%9F…',
    when: function (l) { return !isVault(l) && /[^\x00-\x7F]/.test(destForCopy(l)); }, run: pctEncode },
  { id: 'gh-prefix', group: 'convert', place: 'sub', icon: 'github', title: 'GitHub: текст владелец/репо#N',
    when: function (l) { return !l.embed && !!ghInfo(l) && l.kind !== 'iframe'; }, run: ghPrefix },
  { id: 'title-from-page', group: 'edit', place: 'sub', icon: 'heading', label: 'Текст из заголовка страницы',
    title: function (l) { return (l.kind === 'bare' || l.kind === 'auto') ? 'Адрес → [заголовок страницы](адрес)' : 'Текст из заголовка страницы'; },
    when: function (l) { return isWeb(l) && !l.embed && ['md', 'html', 'bare', 'auto'].indexOf(l.kind) >= 0; }, run: titleFromPage },
  { id: 'unshorten', group: 'convert', place: 'sub', icon: 'unfold-horizontal', title: 'Раскрыть сокращённую ссылку',
    when: function (l, c) { return isShortened(c.plugin, l); }, run: unshorten },
  { id: 'check-link', group: 'find', place: 'sub', icon: 'activity', title: 'Проверить ссылку',
    when: function (l) { return l.kind !== 'iframe' || !!l.dest; }, run: checkLink },
  { id: 'clean-tracking', group: 'convert', place: 'sub', icon: 'eraser', title: 'Очистить от трекинг-параметров',
    when: function (l, c) { return isWeb(l) && trackingCleaned(Object.assign({}, c, { link: l })) !== destForCopy(l); },
    run: cleanTrackingAction },

  { id: 'download-image', group: 'convert', place: 'sub', icon: 'download', title: 'Скачать картинку в хранилище',
    when: function (l) { return l.tags.has(T.EHTTP); }, run: downloadImage },
  { id: 'file-to-vault', group: 'convert', place: 'sub', icon: 'import', title: 'Скопировать файл с диска в хранилище',
    when: function (l) { return isFileUrl(l) && (l.kind === 'md' || l.kind === 'bare' || l.kind === 'auto'); }, run: fileToVault },
  { id: 'vault-to-disk', group: 'convert', place: 'sub', icon: 'hard-drive-download', label: 'Вынести вложение в тяжёлые файлы',
    title: function (l, c) { return c && c.plugin.settings.heavyFolder ? 'Вынести вложение в тяжёлые файлы' : 'Вынести вложение на диск…'; },
    when: function (l, c) { return otherFile(l, c) && l.file.extension !== 'md'; },
    run: function (c) { return vaultToDisk(c, false); } },
  { id: 'vault-to-disk-other', group: 'convert', place: 'sub', icon: 'folder-output', title: 'Вынести вложение в другую папку на диске…',
    when: function (l, c) { return otherFile(l, c) && l.file.extension !== 'md' && !!c.plugin.settings.heavyFolder; },
    run: function (c) { return vaultToDisk(c, true); } },

  /* Удалить */
  { id: 'unlink', group: 'remove', place: 'sub', icon: 'unlink', title: 'Убрать ссылку, оставить текст',
    when: function (l) { return !l.embed && (l.kind === 'wiki' || l.kind === 'md' || l.kind === 'html'); }, run: unlink },
  { id: 'delete', group: 'remove', place: 'top', icon: 'trash-2', title: 'Удалить ссылку',
    when: always, run: deleteLink },
  { id: 'delete-with-target', group: 'remove', place: 'sub', icon: 'trash', title: 'Удалить ссылку и файл, если он больше не нужен',
    when: otherFile, run: deleteWithTarget },

  /* Найти */
  { id: 'find-refs', group: 'find', place: 'sub', icon: 'search', title: 'Все места со ссылкой на ту же цель',
    when: function (l) { return l.kind !== 'iframe' || !!l.dest; }, run: findRefs },
  { id: 'find-site', group: 'find', place: 'sub', icon: 'globe', label: 'Все ссылки на тот же сайт',
    title: function (l) { return 'Все ссылки на сайт ' + siteOf(destForCopy(l)); },
    when: function (l) { return isWeb(l) && !!siteOf(destForCopy(l)); }, run: findSite },
  { id: 'backlinks', group: 'find', place: 'sub', icon: 'links-coming-in', title: 'Обратные ссылки цели',
    when: hasVaultFile, run: openBacklinks },

  /* Файл */
  { id: 'open-default-app', group: 'file', place: 'sub', icon: 'monitor', title: 'Открыть в системной программе',
    when: function (l) { return hasVaultFile(l) || isFileUrl(l); }, run: openDefault },
  { id: 'show-in-folder', group: 'file', place: 'sub', icon: 'folder-open', title: 'Показать в проводнике',
    when: function (l) { return hasVaultFile(l) || isFileUrl(l); }, run: showInFolder },
  { id: 'open-tc', group: 'file', place: 'sub', icon: 'panels-top-left', title: 'Показать в Total Commander',
    when: function (l, c) { return (hasVaultFile(l) || isFileUrl(l)) && !!c.plugin.settings.tcPath; }, run: openInTC },
  { id: 'reveal-nav', group: 'file', place: 'sub', icon: 'folder-search', title: 'Показать в панели файлов',
    when: hasVaultFile, run: revealInNav },
  { id: 'rename-target', group: 'file', place: 'sub', icon: 'pencil', title: 'Переименовать файл',
    when: function (l, c) { return otherFile(l, c) || isFileUrl(l); }, run: renameTarget },
  { id: 'move-target', group: 'file', place: 'sub', icon: 'folder-input', title: 'Переместить файл',
    when: function (l, c) { return otherFile(l, c) || isFileUrl(l); }, run: moveTarget },
  { id: 'delete-target', group: 'file', place: 'sub', icon: 'trash-2', title: 'Удалить файл',
    when: function (l, c) { return otherFile(l, c) || isFileUrl(l); }, run: deleteTarget },
  { id: 'insert-content', group: 'file', place: 'sub', icon: 'text-quote', title: 'Вставить содержимое вместо ссылки',
    when: function (l, c) { return otherFile(l, c) && l.file.extension === 'md'; }, run: insertContent }
];

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  showHeader: true,
  ctrlTap: true,
  placement: {},
  blockMode: 'text',
  blockTextLength: 40,
  browsers: '',
  tcPath: '',
  tcArgs: '/O /T /L="{path}"',
  iframeHeight: 500,
  templatesFolder: '',
  lastTemplate: '',
  exportFolder: '',
  heavyFolder: 'E:\\Clouds\\YandexDisk\\Obs_Heavy_Attachments',
  heavyAskOnDrop: true,
  heavyThresholdKB: 200,
  shotEnabled: true,
  shotFormat: 'webp',
  shotQuality: 85,
  shotMaxWidth: 1600,
  shotName: '{note} {date}',
  shotDateFormat: 'YYYY-MM-DD HH-mm-ss',
  shotDialog: false,
  shotHeavy: 'ask',
  titleStripSite: false,
  shorteners: 'bit.ly, clck.ru, t.co, goo.gl, tinyurl.com, vk.cc, ya.cc, ow.ly, is.gd, cutt.ly, rb.gy, tiny.cc, buff.ly, lnkd.in, t.ly, shorturl.at, s.id, trib.al, surl.li, u.to, qps.ru',
  trackingParams: 'utm_*, fbclid, gclid, dclid, gbraid, wbraid, msclkid, yclid, ysclid, _openstat, igshid, mc_cid, mc_eid, ref_src, rcm, si, spm',
  clean: {
    underscores: true,
    markup: true,
    edges: true,
    emoji: true,
    attachmentExt: true
  }
};

/* ------------------------------------------------------------------ */
/*  Ссылки, отрисованные внутри таблиц, выносок и свойств              */
/* ------------------------------------------------------------------ */

const RENDERED_SEL = '.internal-embed, a.internal-link, a.external-link, img';

function canonAnchor(x) {
  if (!x) return null;
  const emb = x.closest('.internal-embed');
  if (emb) return emb;
  if (x.matches('a.internal-link, a.external-link')) return x;
  if (x.tagName === 'IMG') return x;
  return null;
}

function renderedAnchor(el, host) {
  const a = canonAnchor(el.closest(RENDERED_SEL));
  return a && host.contains(a) ? a : null;
}

function anchorKey(a) {
  if (a.classList.contains('internal-embed')) return { type: 'vault', value: a.getAttribute('src') || '' };
  if (a.classList.contains('internal-link')) return { type: 'vault', value: a.getAttribute('data-href') || a.getAttribute('href') || '' };
  if (a.classList.contains('external-link')) return { type: 'ext', value: a.getAttribute('href') || '' };
  const src = a.getAttribute('src') || '';
  return /^https?:/i.test(src) ? { type: 'ext', value: src } : null;
}

function normVault(s) { return safeDecode(String(s || '')).trim().replace(/\.md(?=#|$)/i, ''); }

function linkMatchesKey(l, key) {
  if (key.type === 'vault') {
    if (l.kind === 'wiki') return normVault(l.dest) === normVault(key.value);
    if (l.kind === 'md' && classifyDest(l.dest) === 'vault') return normVault(l.dest) === normVault(key.value);
    return false;
  }
  if (l.kind === 'wiki') return false;
  const d = (l.dest || '').replace(/^<|>$/g, '');
  return d === key.value || decodePct(d) === decodePct(key.value);
}

/* Находит в исходном тексте ссылку, по которой щёлкнули в отрисованном блоке */
function locateRendered(cm, host, anchor) {
  const doc = cm.state.doc;
  let fromLine, toLine;
  if (host.classList.contains('metadata-container')) {
    if (doc.line(1).text.trim() !== '---') return null;
    fromLine = 2;
    toLine = 2;
    while (toLine <= doc.lines && doc.line(toLine).text.trim() !== '---') toLine++;
    toLine--;
    if (toLine < fromLine) return null;
  } else {
    let pos;
    try { pos = cm.posAtDOM(host); } catch (e) { return null; }
    const isTable = host.classList.contains('cm-table-widget');
    const test = isTable
      ? function (t) { return t.trim() !== '' && t.indexOf('|') >= 0; }
      : function (t) { return /^\s*>/.test(t); };
    fromLine = doc.lineAt(pos).number;
    toLine = fromLine;
    while (toLine + 1 <= doc.lines && test(doc.line(toLine + 1).text)) toLine++;
  }
  const key = anchorKey(anchor);
  if (!key || !key.value) return null;

  // который по счёту среди одинаковых ссылок в этом блоке
  const same = [];
  host.querySelectorAll(RENDERED_SEL).forEach(function (x) {
    const c = canonAnchor(x);
    if (!c || same.indexOf(c) >= 0) return;
    const k = anchorKey(c);
    if (k && k.type === key.type && (k.value === key.value || normVault(k.value) === normVault(key.value))) same.push(c);
  });
  const idx = Math.max(0, same.indexOf(anchor));

  const matches = [];
  for (let n = fromLine; n <= toLine; n++) {
    findLinks(doc.line(n).text).forEach(function (l) {
      if (linkMatchesKey(l, key)) matches.push({ line: n, link: l });
    });
  }
  if (!matches.length) return null;
  return matches[Math.min(idx, matches.length - 1)];
}

/* ------------------------------------------------------------------ */
/*  Total Commander: поиск exe                                         */
/* ------------------------------------------------------------------ */

async function detectTotalCommander() {
  const fs = require('fs');
  const pathMod = require('path');
  const cp = require('child_process');
  const env = process.env;
  const tryDir = function (d) {
    if (!d) return null;
    for (const e of ['TOTALCMD64.EXE', 'TOTALCMD.EXE']) {
      const p = pathMod.join(d, e);
      if (fs.existsSync(p)) return p;
    }
    return null;
  };
  const run = function (cmd, args) {
    return new Promise(function (res) {
      cp.execFile(cmd, args, { windowsHide: true, timeout: 6000 }, function (err, out) { res(err ? '' : String(out)); });
    });
  };

  const keys = ['HKCU\\Software\\Ghisler\\Total Commander', 'HKLM\\Software\\Ghisler\\Total Commander',
    'HKLM\\Software\\WOW6432Node\\Ghisler\\Total Commander'];
  for (const k of keys) {
    const out = await run('reg', ['query', k, '/v', 'InstallDir']);
    const m = out.match(/InstallDir\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (m) {
      const d = m[1].trim().replace(/%([^%]+)%/g, function (x, v) { return env[v] || x; });
      const p = tryDir(d);
      if (p) return p;
    }
  }

  const dirs = [
    env.COMMANDER_PATH,
    pathMod.join(env.ProgramFiles || 'C:\\Program Files', 'totalcmd'),
    pathMod.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'totalcmd'),
    'C:\\totalcmd', 'C:\\Total Commander', 'C:\\Program Files\\Total Commander',
    env.LOCALAPPDATA ? pathMod.join(env.LOCALAPPDATA, 'totalcmd') : null
  ];
  for (const d of dirs) { const p = tryDir(d); if (p) return p; }

  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-Process TOTALCMD64,TOTALCMD -ErrorAction SilentlyContinue | Select-Object -First 1).Path']);
  const p = out.trim();
  if (p && fs.existsSync(p)) return p;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Плагин                                                             */
/* ------------------------------------------------------------------ */

module.exports = class YuleLinkMenu extends Plugin {
  async onload() {
    await this.loadSettings();
    this.bypass = false;
    this.handler = this.onContextMenu.bind(this);

    this.keyHandler = this.onKey.bind(this);
    this.lastMenuKey = 0;
    this.ctrlAt = 0;
    this.ctrlClean = false;

    const hook = (win) => {
      this.registerDomEvent(win, 'contextmenu', this.handler, true);
      this.registerDomEvent(win, 'keydown', this.keyHandler, true);
      this.registerDomEvent(win, 'keyup', this.keyHandler, true);
      this.registerDomEvent(win, 'mousedown', () => { this.ctrlClean = false; }, true);
      this.registerDomEvent(win, 'wheel', () => { this.ctrlClean = false; }, { capture: true, passive: true });
      this.registerDomEvent(win, 'blur', () => { this.ctrlClean = false; });
    };
    hook(window);
    this.registerEvent(this.app.workspace.on('window-open', (ww, win) => hook(win)));

    this.registerEvent(this.app.workspace.on('editor-drop', (evt, editor, info) => this.onEditorDrop(evt, editor, info)));
    this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor, info) => this.onEditorPaste(evt, editor, info)));

    this.addSettingTab(new YuleLinkMenuSettings(this.app, this));
    this.app.workspace.onLayoutReady(() => { this.ensureTC(); });
  }

  /* Если путь к Total Commander не задан или неверен — ищем сами */
  async ensureTC() {
    try {
      const fs = require('fs');
      const cur = this.settings.tcPath;
      if (cur && fs.existsSync(cur)) return;
      const p = await detectTotalCommander();
      if (p && p !== cur) { this.settings.tcPath = p; await this.saveSettings(); }
    } catch (e) { console.error(e); }
  }

  onEditorPaste(evt, editor, info) {
    if (evt.defaultPrevented) return;
    const st = this.settings;
    const cd = evt.clipboardData;
    if (!cd || !cd.files || !cd.files.length) return;

    // скриншот: картинка в буфере без пути на диске
    if (st.shotEnabled) {
      const shot = Array.from(cd.files).filter(function (f) { return /^image\//.test(f.type) && !diskPathOf(f); })[0];
      if (shot) {
        evt.preventDefault();
        const sp = info && info.file ? info.file.path : '';
        handleShot(this, shot, editor, sp).catch(function (e) {
          console.error(e);
          new Notice('Ошибка при вставке скриншота: ' + e.message);
        });
        return;
      }
    }

    if (!st.heavyAskOnDrop || !st.heavyFolder) return;
    // только файлы, скопированные в Проводнике: у них есть путь на диске
    const files = Array.from(cd.files).filter(function (f) { return !!diskPathOf(f); });
    if (!files.length) return;
    const limit = (st.heavyThresholdKB || 200) * 1024;
    const heavy = files.filter(function (f) { return f.size > limit; });
    if (!heavy.length) return;
    evt.preventDefault();
    const sourcePath = info && info.file ? info.file.path : '';
    handleHeavyDrop(this, files, heavy, editor, sourcePath, null).catch(function (e) {
      console.error(e);
      new Notice('Ошибка при вставке файла: ' + e.message);
    });
  }

  onEditorDrop(evt, editor, info) {
    if (evt.defaultPrevented) return;
    const st = this.settings;
    if (!st.heavyAskOnDrop || !st.heavyFolder) return;
    const dt = evt.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const files = Array.from(dt.files);
    const limit = (st.heavyThresholdKB || 200) * 1024;
    const heavy = files.filter(function (f) { return f.size > limit; });
    if (!heavy.length) return;
    evt.preventDefault();
    let offset = null;
    const cm = editor.cm;
    if (cm) { const pos = cm.posAtCoords({ x: evt.clientX, y: evt.clientY }); if (pos != null) offset = pos; }
    if (offset == null) offset = editor.posToOffset(editor.getCursor());
    const sourcePath = info && info.file ? info.file.path : '';
    handleHeavyDrop(this, files, heavy, editor, sourcePath, offset).catch(function (e) {
      console.error(e);
      new Notice('Ошибка при вставке файла: ' + e.message);
    });
  }

  onunload() {
    closePreview();
  }

  async loadSettings() {
    const d = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, d);
    this.settings.clean = Object.assign({}, DEFAULT_SETTINGS.clean, d.clean || {});
    this.settings.placement = Object.assign({}, d.placement || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  placementOf(a) {
    return this.settings.placement[a.id] || a.place;
  }

  findView(el) {
    let res = null;
    this.app.workspace.iterateAllLeaves(function (leaf) {
      if (res) return;
      const v = leaf.view;
      if (v instanceof MarkdownView && v.containerEl.contains(el)) res = v;
    });
    return res;
  }

  /* Одиночное нажатие Ctrl и клавиша меню (Menu, Shift+F10) */
  onKey(evt) {
    if (evt.type === 'keydown') {
      if (evt.key === 'ContextMenu' || (evt.key === 'F10' && evt.shiftKey)) this.lastMenuKey = Date.now();
      if (evt.key === 'Control') {
        if (!evt.repeat) { this.ctrlAt = Date.now(); this.ctrlClean = true; }
      } else {
        this.ctrlClean = false;
      }
      return;
    }
    if (evt.key !== 'Control') return;
    const tap = this.ctrlClean && Date.now() - this.ctrlAt < 500;
    this.ctrlClean = false;
    if (!tap || !this.settings.ctrlTap) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== 'source') return;
    const cm = view.editor && view.editor.cm;
    if (!cm || !cm.hasFocus) return;
    this.menuAtCaret(view, false);
  }

  /* Меню для ссылки, на которой стоит текстовый курсор */
  menuAtCaret(view, verbose) {
    const cm = view.editor && view.editor.cm;
    if (!cm) return false;
    const head = cm.state.selection.main.head;
    const lineObj = cm.state.doc.lineAt(head);
    const off = head - lineObj.from;
    const links = findLinks(lineObj.text);
    const link = links.find(function (l) { return l.from < off && off < l.to; }) ||
                 links.find(function (l) { return l.from <= off && off <= l.to; });
    if (!link) { if (verbose) new Notice('Под курсором нет ссылки'); return false; }
    const c = cm.coordsAtPos(head) || cm.coordsAtPos(lineObj.from + link.from);
    if (!c) return false;
    const el = cm.contentDOM.ownerDocument.elementFromPoint(c.left, (c.top + c.bottom) / 2) || cm.contentDOM;
    const sourcePath = view.file ? view.file.path : '';
    enrichLink(this.app, link, sourcePath);
    this.showMenu({
      plugin: this, view: view, editor: view.editor,
      line: lineObj.number - 1, link: link,
      evt: null, at: { x: c.left, y: c.bottom + 2 },
      targetEl: el, sourcePath: sourcePath
    });
    return true;
  }

  onContextMenu(evt) {
    if (this.bypass) return;

    // Контекстное меню с клавиатуры: берём ссылку у текстового курсора
    const fromKeyboard = Date.now() - this.lastMenuKey < 800 || evt.pointerType === '' && evt.button === 0 && evt.detail === 0;
    if (fromKeyboard) {
      this.lastMenuKey = 0;
      const t0 = evt.target && evt.target.nodeType === 1 ? evt.target : (evt.target && evt.target.parentElement);
      const kv = t0 && t0.closest && t0.closest('.markdown-source-view .cm-editor') ? this.findView(t0) : null;
      if (kv && kv.getMode() === 'source') {
        const kcm = kv.editor && kv.editor.cm;
        if (kcm) {
          const head = kcm.state.selection.main.head;
          const ln = kcm.state.doc.lineAt(head);
          const o = head - ln.from;
          const has = findLinks(ln.text).some(function (l) { return l.from <= o && o <= l.to; });
          if (has) {
            evt.preventDefault();
            evt.stopPropagation();
            evt.stopImmediatePropagation();
            this.menuAtCaret(kv, false);
          }
        }
      }
      return;
    }

    if (evt.shiftKey) return;

    let el = evt.target;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || !el.closest) return;

    if (!el.closest('.markdown-source-view .cm-editor')) return;
    if (el.closest('.markdown-embed-content, .pdf-viewer-container, .pdf-toolbar')) return;

    // Отрисованные ссылки в таблицах, выносках и свойствах (Live Preview)
    const host = el.closest('.cm-table-widget, .cm-callout, .metadata-container');
    if (host) {
      const hv = this.findView(el);
      if (!hv || hv.getMode() !== 'source') return;
      const hcm = hv.editor && hv.editor.cm;
      if (!hcm) return;
      const anchor = renderedAnchor(el, host);
      if (!anchor) return;
      const found = locateRendered(hcm, host, anchor);
      if (!found) return;
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();
      const hsp = hv.file ? hv.file.path : '';
      enrichLink(this.app, found.link, hsp);
      this.showMenu({
        plugin: this, view: hv, editor: hv.editor,
        line: found.line - 1, link: found.link,
        evt: evt, targetEl: el, sourcePath: hsp
      });
      return;
    }

    if (el.closest('.cm-inline-code, .HyperMD-codeblock, .cm-math, .math, .cm-comment')) return;

    const view = this.findView(el);
    if (!view || view.getMode() !== 'source') return;
    const cm = view.editor && view.editor.cm;
    if (!cm) return;

    let pos = null;
    let fromWidget = false;
    const widget = el.tagName === 'IMG' ? el : el.closest('.internal-embed, .image-embed, .cm-embed-block, .media-embed');
    if (widget && cm.contentDOM.contains(widget)) {
      try { pos = cm.posAtDOM(widget); fromWidget = true; } catch (e) { pos = null; }
    }
    if (pos == null) pos = cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
    if (pos == null) return;

    const lineObj = cm.state.doc.lineAt(pos);
    const off = pos - lineObj.from;
    const links = findLinks(lineObj.text);

    let link = links.find(function (l) { return l.from <= off && off < l.to; });
    if (!link) {
      const edge = links.find(function (l) { return l.to === off; });
      if (edge && (fromWidget || el.matches('[class*="link"], [class*="url"], .cm-underline, .cm-hmd-barelink'))) link = edge;
    }
    if (!link && fromWidget) link = links.find(function (l) { return l.embed && l.from >= off; });
    if (!link) return;

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    const sourcePath = view.file ? view.file.path : '';
    enrichLink(this.app, link, sourcePath);

    this.showMenu({
      plugin: this,
      view: view,
      editor: view.editor,
      line: lineObj.number - 1,
      link: link,
      evt: evt,
      targetEl: el,
      sourcePath: sourcePath
    });
  }

  expand(a, ctx) {
    if (a.items) return a.items(ctx);
    const l = ctx.link;
    return [{
      title: typeof a.title === 'function' ? a.title(l, ctx) : a.title,
      icon: a.icon,
      run: function () { return a.run(ctx); }
    }];
  }

  addItems(menu, a, ctx) {
    this.expand(a, ctx).forEach(function (it) {
      menu.addItem(function (mi) {
        mi.setTitle(it.title).setIcon(it.icon).onClick(function () {
          try {
            const r = it.run();
            if (r && typeof r.catch === 'function') r.catch(function (e) { console.error(e); new Notice('Ошибка: ' + e.message); });
          } catch (e) { console.error(e); new Notice('Ошибка: ' + e.message); }
        });
      });
    });
  }

  applies(a, ctx) {
    try { return a.when(ctx.link, ctx); } catch (e) { console.error(e); return false; }
  }

  showMenu(ctx) {
    const self = this;
    const l = ctx.link;
    const menu = new Menu();

    if (this.settings.showHeader) {
      const tags = Array.from(l.tags).join(' ');
      const d = short(l.kind === 'wiki' ? l.dest : destForCopy(l), 48);
      menu.addItem(function (mi) { mi.setTitle(tags + '   ' + d).setIcon('link').setDisabled(true); });
      menu.addSeparator();
    }

    const avail = ACTIONS.filter(function (a) { return self.placementOf(a) !== 'off' && self.applies(a, ctx); });

    const top = avail.filter(function (a) { return self.placementOf(a) === 'top'; });
    top.forEach(function (a) { self.addItems(menu, a, ctx); });
    if (top.length) menu.addSeparator();

    GROUPS.forEach(function (g) {
      const list = avail.filter(function (a) { return a.group === g.id && self.placementOf(a) === 'sub'; });
      if (!list.length) return;
      let flat = false;
      menu.addItem(function (mi) {
        mi.setTitle(g.title).setIcon(g.icon);
        if (typeof mi.setSubmenu === 'function') {
          const sub = mi.setSubmenu();
          list.forEach(function (a) { self.addItems(sub, a, ctx); });
        } else {
          mi.setDisabled(true);
          flat = true;
        }
      });
      if (flat) list.forEach(function (a) { self.addItems(menu, a, ctx); });
    });

    menu.addSeparator();
    menu.addItem(function (mi) {
      mi.setTitle('Показать обычное контекстное меню').setIcon('menu').onClick(function () { self.showNative(ctx); });
    });

    if (ctx.evt) menu.showAtMouseEvent(ctx.evt);
    else menu.showAtPosition(ctx.at);
  }

  showNative(ctx) {
    const self = this;
    const evt = ctx.evt;
    const x = evt ? evt.clientX : ctx.at.x;
    const y = evt ? evt.clientY : ctx.at.y - 6;
    const doc = ctx.targetEl.ownerDocument;
    const win = doc.defaultView;
    setTimeout(function () {
      const el = doc.elementFromPoint(x, y) || ctx.targetEl;
      self.bypass = true;
      try {
        el.dispatchEvent(new win.MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, view: win, button: 2, buttons: 2,
          clientX: x, clientY: y,
          screenX: evt ? evt.screenX : x + win.screenX, screenY: evt ? evt.screenY : y + win.screenY
        }));
      } finally {
        self.bypass = false;
      }
    }, 50);
  }
};

/* ------------------------------------------------------------------ */
/*  Вкладка настроек                                                   */
/* ------------------------------------------------------------------ */

class YuleLinkMenuSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const self = this;
    const el = this.containerEl;
    const p = this.plugin;
    const s = p.settings;
    el.empty();

    new Setting(el).setName('Меню').setHeading();

    new Setting(el)
      .setName('Заголовок меню')
      .setDesc('Первой строкой меню показывать распознанный тип ссылки и её адрес.')
      .addToggle(function (t) { t.setValue(s.showHeader).onChange(async function (v) { s.showHeader = v; await p.saveSettings(); }); });

    new Setting(el)
      .setName('Меню по одиночному нажатию Ctrl')
      .setDesc('Нажать и отпустить Ctrl, не трогая других клавиш, — откроется меню ссылки, на которой стоит текстовый курсор. ' +
               'Клавиша меню на клавиатуре и Shift+F10 тоже работают от курсора.')
      .addToggle(function (t) { t.setValue(s.ctrlTap).onChange(async function (v) { s.ctrlTap = v; await p.saveSettings(); }); });

    el.createEl('p', {
      text: 'Где стоит каждый пункт: наверху меню, в подменю своей группы или нигде. ' +
            'Пункты, неприменимые к ссылке, в меню не появляются.',
      cls: 'setting-item-description'
    });

    GROUPS.forEach(function (g) {
      const acts = ACTIONS.filter(function (a) { return a.group === g.id; });
      if (!acts.length) return;
      new Setting(el).setName(g.title).setHeading();
      acts.forEach(function (a) {
        const name = a.label || a.title;
        new Setting(el).setName(name).addDropdown(function (d) {
          d.addOption('top', 'Наверху').addOption('sub', 'В подменю').addOption('off', 'Скрыт');
          d.setValue(p.placementOf(a)).onChange(async function (v) {
            if (v === a.place) delete s.placement[a.id];
            else s.placement[a.id] = v;
            await p.saveSettings();
          });
        });
      });
    });

    new Setting(el).setName('Текст ссылки').setHeading();
    el.createEl('p', {
      text: 'Как собирается текст для [[ссылок]] в пунктах «Текст = заголовок или имя», «Редактировать текст» и в вариантах текста. ' +
            'Заголовок раздела всегда берётся из самой заметки: в адресе ссылки Obsidian заменяет часть символов (: | ^ #) пробелами.',
      cls: 'setting-item-description'
    });

    const toggles = [
      ['underscores', 'Подчёркивания → пробелы', 'Моя_заметка → Моя заметка'],
      ['markup', 'Убирать разметку из заголовков', '**жирный**, *курсив*, `код`, ==выделение==, [[ссылки]], #теги на конце'],
      ['emoji', 'Убирать эмодзи в начале', '📚 Книги → Книги'],
      ['edges', 'Чистить края и двойные пробелы', 'Пробелы и знаки препинания в начале и в конце, повторные пробелы внутри'],
      ['attachmentExt', 'Убирать расширение у вложений', 'отчёт.pdf → отчёт']
    ];
    toggles.forEach(function (row) {
      new Setting(el).setName(row[1]).setDesc(row[2]).addToggle(function (t) {
        t.setValue(!!s.clean[row[0]]).onChange(async function (v) { s.clean[row[0]] = v; await p.saveSettings(); });
      });
    });

    new Setting(el)
      .setName('Ссылка на блок')
      .setDesc('Что ставить текстом у [[Заметка#^abc123]].')
      .addDropdown(function (d) {
        d.addOption('text', 'Начало текста блока').addOption('name', 'Имя заметки');
        d.setValue(s.blockMode).onChange(async function (v) { s.blockMode = v; await p.saveSettings(); });
      });

    new Setting(el)
      .setName('Длина текста блока')
      .setDesc('Сколько символов брать из блока.')
      .addSlider(function (sl) {
        sl.setLimits(15, 120, 5).setValue(s.blockTextLength).setDynamicTooltip()
          .onChange(async function (v) { s.blockTextLength = v; await p.saveSettings(); });
      });

    new Setting(el).setName('Внешние программы').setHeading();

    new Setting(el)
      .setName('Браузеры для пункта «Открыть в: …»')
      .setDesc('По строке на браузер: название | путь к exe | аргументы. {url} заменяется адресом. ' +
               'Пример: Firefox приватно | C:\\Program Files\\Mozilla Firefox\\firefox.exe | -private-window {url}')
      .addTextArea(function (t) {
        t.setValue(s.browsers).setPlaceholder('Chrome | C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe | {url}');
        t.inputEl.rows = 4;
        t.inputEl.style.width = '100%';
        t.onChange(async function (v) { s.browsers = v; await p.saveSettings(); });
      });

    new Setting(el)
      .setName('Total Commander: путь к exe')
      .setDesc('Находится сам при запуске Obsidian: по реестру, обычным папкам установки и запущенному Total Commander. ' +
               'Пусто — пункт «Показать в Total Commander» не показывается.')
      .addText(function (t) {
        t.setValue(s.tcPath);
        t.inputEl.style.width = '100%';
        t.onChange(async function (v) { s.tcPath = v.trim(); await p.saveSettings(); });
      })
      .addExtraButton(function (b) {
        b.setIcon('search').setTooltip('Найти автоматически').onClick(async function () {
          const found = await detectTotalCommander();
          if (found) { s.tcPath = found; await p.saveSettings(); new Notice('Найден: ' + found); self.display(); }
          else new Notice('Total Commander не найден — укажи путь вручную');
        });
      });

    new Setting(el)
      .setName('Total Commander: аргументы')
      .setDesc('{path} заменяется путём к файлу. /O — в уже открытом окне, /T — в новой вкладке, /L — в левой панели (/R — в правой).')
      .addText(function (t) {
        t.setValue(s.tcArgs);
        t.inputEl.style.width = '100%';
        t.onChange(async function (v) { s.tcArgs = v; await p.saveSettings(); });
      });

    new Setting(el).setName('Файлы').setHeading();

    new Setting(el)
      .setName('Папка шаблонов')
      .setDesc('Для пункта «Создать заметку…». Пусто — берётся из Templater или из встроенных шаблонов' +
               (templatesFolder(p) && !s.templatesFolder ? ' (сейчас: ' + templatesFolder(p) + ')' : '') + '.')
      .addText(function (t) {
        t.setValue(s.templatesFolder).setPlaceholder('Шаблоны');
        t.onChange(async function (v) { s.templatesFolder = v.trim(); await p.saveSettings(); });
      });

    new Setting(el).setName('Тяжёлые файлы').setHeading();

    new Setting(el)
      .setName('Папка тяжёлых файлов')
      .setDesc('Абсолютный путь на диске. Сюда уходят вложения по пункту «Вынести вложение в тяжёлые файлы» и тяжёлые файлы при перетаскивании.')
      .addText(function (t) {
        t.setValue(s.heavyFolder);
        t.inputEl.style.width = '100%';
        t.onChange(async function (v) { s.heavyFolder = v.trim(); await p.saveSettings(); });
      });

    new Setting(el)
      .setName('Спрашивать при перетаскивании и вставке')
      .setDesc('Если перетащить в заметку или вставить через Ctrl+V файл из Проводника больше порога, ' +
               'плагин предложит положить его в папку тяжёлых файлов. Скриншоты из буфера не затрагиваются.')
      .addToggle(function (t) { t.setValue(s.heavyAskOnDrop).onChange(async function (v) { s.heavyAskOnDrop = v; await p.saveSettings(); }); });

    new Setting(el)
      .setName('Порог, КБ')
      .addText(function (t) {
        t.setValue(String(s.heavyThresholdKB));
        t.onChange(async function (v) { const n = parseInt(v, 10); if (n > 0) { s.heavyThresholdKB = n; await p.saveSettings(); } });
      });

    new Setting(el).setName('Скриншоты').setHeading();

    new Setting(el)
      .setName('Обрабатывать скриншоты при вставке')
      .setDesc('Картинка из буфера (Win+Shift+S и подобное) сжимается, уменьшается и получает имя по заметке.')
      .addToggle(function (t) { t.setValue(s.shotEnabled).onChange(async function (v) { s.shotEnabled = v; await p.saveSettings(); }); });

    new Setting(el)
      .setName('Показывать окно перед сохранением')
      .setDesc('Предпросмотр, размер до и после, выбор формата, качества, ширины и места. Выключено — всё по настройкам ниже, молча.')
      .addToggle(function (t) { t.setValue(s.shotDialog).onChange(async function (v) { s.shotDialog = v; await p.saveSettings(); }); });

    new Setting(el)
      .setName('Формат')
      .setDesc('WebP — самый лёгкий при хорошем качестве. PNG — без потерь, но тяжёлый.')
      .addDropdown(function (d) {
        d.addOption('webp', 'WebP').addOption('jpeg', 'JPEG').addOption('png', 'PNG (как есть)');
        d.setValue(s.shotFormat).onChange(async function (v) { s.shotFormat = v; await p.saveSettings(); });
      });

    new Setting(el)
      .setName('Качество')
      .setDesc('Для WebP и JPEG. 80–90 — текст на снимке остаётся чётким.')
      .addSlider(function (sl) {
        sl.setLimits(40, 100, 1).setValue(s.shotQuality).setDynamicTooltip()
          .onChange(async function (v) { s.shotQuality = v; await p.saveSettings(); });
      });

    new Setting(el)
      .setName('Наибольшая ширина, px')
      .setDesc('Более широкие снимки уменьшаются по пропорциям. 0 — не уменьшать.')
      .addText(function (t) {
        t.setValue(String(s.shotMaxWidth));
        t.onChange(async function (v) { const n = parseInt(v, 10); if (n >= 0) { s.shotMaxWidth = n; await p.saveSettings(); } });
      });

    new Setting(el)
      .setName('Имя файла')
      .setDesc('{note} — имя заметки, {date} — дата и время по формату ниже.')
      .addText(function (t) {
        t.setValue(s.shotName);
        t.onChange(async function (v) { s.shotName = v || '{note} {date}'; await p.saveSettings(); });
      });

    new Setting(el)
      .setName('Формат даты в имени')
      .setDesc('Как в Moment.js: YYYY-MM-DD HH-mm-ss. Двоеточия в именах файлов запрещены.')
      .addText(function (t) {
        t.setValue(s.shotDateFormat);
        t.onChange(async function (v) { s.shotDateFormat = v || 'YYYY-MM-DD HH-mm-ss'; await p.saveSettings(); });
      });

    new Setting(el)
      .setName('Если после сжатия больше порога тяжёлых')
      .addDropdown(function (d) {
        d.addOption('ask', 'Спрашивать').addOption('vault', 'Всегда в хранилище').addOption('heavy', 'Всегда в тяжёлые');
        d.setValue(s.shotHeavy).onChange(async function (v) { s.shotHeavy = v; await p.saveSettings(); });
      });

    new Setting(el).setName('Сеть').setHeading();

    new Setting(el)
      .setName('Убирать название сайта из заголовка страницы')
      .setDesc('«Как устроен Obsidian — Хабр» → «Как устроен Obsidian».')
      .addToggle(function (t) { t.setValue(s.titleStripSite).onChange(async function (v) { s.titleStripSite = v; await p.saveSettings(); }); });

    new Setting(el)
      .setName('Сервисы сокращения ссылок')
      .setDesc('Для них в меню появляется «Раскрыть сокращённую ссылку». Через запятую.')
      .addTextArea(function (t) {
        t.setValue(s.shorteners);
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
        t.onChange(async function (v) { s.shorteners = v; await p.saveSettings(); });
      });

    new Setting(el).setName('Преобразования').setHeading();

    new Setting(el)
      .setName('Высота окна <iframe>')
      .setDesc('Для пункта «Встроить страницу через <iframe>», в пикселях.')
      .addText(function (t) {
        t.setValue(String(s.iframeHeight));
        t.onChange(async function (v) { const n = parseInt(v, 10); if (n > 0) { s.iframeHeight = n; await p.saveSettings(); } });
      });

    new Setting(el)
      .setName('Трекинг-параметры')
      .setDesc('Какие параметры убирать из адреса. Через запятую, * — любые символы.')
      .addTextArea(function (t) {
        t.setValue(s.trackingParams);
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
        t.onChange(async function (v) { s.trackingParams = v; await p.saveSettings(); });
      });
  }
}

/* Для проверки вне Obsidian */
module.exports._test = {
  findLinks: findLinks, cleanText: cleanText, stripMarkup: stripMarkup, fileUrlToPath: fileUrlToPath,
  composeRaw: composeRaw, cleanTracking: cleanTracking, parseTracking: parseTracking, mdDest: mdDest,
  decodePct: decodePct, encodeNonAscii: encodeNonAscii, subParams: subParams, joinParams: joinParams,
  enrichLink: enrichLink, T: T, siteOf: siteOf, followRedirects: followRedirects
};
