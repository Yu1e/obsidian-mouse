/*
 * Yule Mouse
 * 1. Двойной щелчок по заголовку вкладки → закрепить / открепить её.
 * 2. Одиночный щелчок по полям заметки   → «Исходный код» ⇄ «Живой просмотр»;
 *    из режима чтения — в «Живой просмотр».
 * 3. Перетаскивание выделенного текста в другую вкладку → перенос
 *    (вставка в точку под мышью + удаление из источника), с Ctrl — копирование.
 * 4. Перетаскивание вкладки за заголовок на папку в проводнике → заметка
 *    перемещается в эту папку (ссылки на неё обновляются штатно).
 *
 * Перетаскивание текста внутри одной заметки не затрагивается — его штатно
 * обрабатывает CodeMirror. Вставка и удаление при межвкладочном переносе
 * выполняются одним синхронным блоком: если вставка не удалась, удаление
 * не запускается — текст не может пропасть.
 */

const { Plugin, Notice, normalizePath } = require("obsidian");

// true  — закреплять только в основной области редактора (и во всплывающих окнах);
// false — реагировать ещё и на иконки вкладок в боковых панелях.
const MAIN_AREA_ONLY = false;

// "click" — переключать режим одиночным щелчком по полям, "dblclick" — двойным.
const MARGIN_TRIGGER = "click";

// Ширина безопасной полосы слева от текста (пиксели): щелчок в ней уходит
// к редактору и ставит курсор в начало строки, а не переключает режим.
const MARGIN_SAFE_ZONE_PX = 24;

// Зоны заголовка вкладки, где двойной щелчок не должен менять закрепление:
// крестик закрытия и контейнер статуса (в нём живёт индикатор-«булавка»).
const IGNORED_ZONES = [
	".workspace-tab-header-inner-close-button",
	".workspace-tab-header-status-container",
].join(", ");

// Класс подсветки папки под курсором — тот же, что использует сам проводник,
// поэтому тема рисует его привычно.
const DROP_HIGHLIGHT = "is-being-dragged-over";

module.exports = class YuleMouse extends Plugin {
	// Состояние курсора, снятое до того, как щелчок по полю успел его сдвинуть.
	pendingMargin = null;

	// Данные текущего перетаскивания текста из редактора.
	drag = null;

	// Данные текущего перетаскивания вкладки: { file }.
	tabDrag = null;

	// Элемент проводника, подсвеченный как цель броска.
	highlightEl = null;

	onload() {
		this.attach(document);

		// У всплывающих окон свой собственный document.
		this.registerEvent(
			this.app.workspace.on("window-open", (win) => this.attach(win.doc))
		);
	}

	onunload() {
		this.setHighlight(null);
	}

	attach(doc) {
		this.registerDomEvent(doc, "dblclick", this.onDblClick);

		// Фаза перехвата: нужно опередить CodeMirror, который двигает курсор
		// на mousedown, до того как сработает click.
		this.registerDomEvent(doc, "mousedown", this.onMouseDown, { capture: true });
		this.registerDomEvent(doc, MARGIN_TRIGGER, this.onMarginTrigger);

		// Перетаскивание вешаем на window в фазе перехвата, а не на document.
		// Порядок вызова обработчиков одной фазы — порядок их регистрации, а
		// между плагинами он определяется порядком загрузки, то есть нам
		// неподконтролен. Фаза перехвата идёт window → document → …, поэтому
		// window-capture раньше любого document-обработчика других плагинов
		// (в частности, yule-auth с его диалогом авторства). Перетаскивание
		// из другого приложения (drag и tabDrag пусты) мы пропускаем — и оно
		// штатно доходит до auth.
		const win = doc.defaultView ?? window;
		this.registerDomEvent(win, "dragstart", this.onDragStart, { capture: true });
		this.registerDomEvent(win, "dragover", this.onDragOver, { capture: true });
		this.registerDomEvent(win, "drop", this.onDrop, { capture: true });
		this.registerDomEvent(win, "dragend", this.onDragEnd, { capture: true });
	}

	/* ---------- 1. Закрепление вкладки ---------- */

	onDblClick = (evt) => {
		const headerEl = evt.target?.closest?.(".workspace-tab-header");
		if (!headerEl) return;

		if (evt.target.closest(IGNORED_ZONES)) return;

		const leaf = this.findLeaf((l) => l.tabHeaderEl === headerEl, MAIN_AREA_ONLY);
		if (!leaf) return;

		evt.preventDefault();

		if (typeof leaf.togglePinned === "function") leaf.togglePinned();
		else leaf.setPinned(!leaf.getViewState().pinned);
	};

	/* ---------- 2. Переключение режима по полям ---------- */

	onMouseDown = (evt) => {
		this.pendingMargin = null;
		if (evt.button !== 0) return;

		const hit = this.marginHit(evt);
		if (!hit) return;

		// Курсор, прокрутку и фокус снимаем только для редактора — в режиме
		// чтения их нет, и сохранять нечего.
		const editor = hit.leaf.view?.editor;
		this.pendingMargin = {
			leaf: hit.leaf,
			selections: editor?.listSelections?.(),
			scroll: editor?.getScrollInfo?.(),
			hadFocus: editor?.hasFocus?.(),
		};
	};

	onMarginTrigger = (evt) => {
		const pending = this.pendingMargin;
		this.pendingMargin = null;
		// Щелчок должен был и начаться в поле — иначе это протяжка выделения,
		// случайно отпущенная за краем текста.
		if (!pending) return;

		// И закончиться в поле той же вкладки.
		const hit = this.marginHit(evt);
		if (!hit || hit.leaf !== pending.leaf) return;

		const viewState = hit.leaf.getViewState();
		if (viewState.type !== "markdown") return;
		viewState.state = viewState.state || {};

		if (viewState.state.mode === "preview") {
			// Режим чтения: щелчок только выводит из него — в Живой просмотр.
			// Обратно в чтение щелчок не переводит никогда.
			viewState.state.mode = "source";
			viewState.state.source = false;
			hit.leaf.setViewState(viewState, hit.leaf.getEphemeralState?.());
			return;
		}

		// Режим редактирования: «Исходный код» ⇄ «Живой просмотр».
		// state.source: true — «Исходный код», false — «Живой просмотр».
		viewState.state.source = !viewState.state.source;
		Promise.resolve(hit.leaf.setViewState(viewState, hit.leaf.getEphemeralState?.())).then(
			() => this.restoreMargin(hit.leaf, pending)
		);
	};

	restoreMargin(leaf, pending) {
		const editor = leaf.view?.editor;
		if (!editor || !pending.selections) return;

		if (pending.hadFocus) editor.focus();
		editor.setSelections(pending.selections);
		if (pending.scroll) editor.scrollTo(pending.scroll.left, pending.scroll.top);
	}

	// Определяет, попал ли щелчок в поле заметки, и в каком режиме она открыта.
	// Возвращает { leaf } или null.
	marginHit(evt) {
		// Редактирование: колонка текста — .cm-content, прокрутка — .cm-scroller.
		const srcEl = evt.target?.closest?.(".markdown-source-view");
		if (srcEl) {
			const leaf = this.findLeaf((l) => l.view?.containerEl?.contains(srcEl));
			const inMargin = this.inSideMargin(
				evt,
				srcEl.querySelector(".cm-content"),
				srcEl.querySelector(".cm-scroller")
			);
			return leaf && inMargin ? { leaf } : null;
		}

		// Чтение: колонка — .markdown-preview-sizer, прокрутка — .markdown-preview-view.
		const readEl = evt.target?.closest?.(".markdown-reading-view");
		if (readEl) {
			const leaf = this.findLeaf((l) => l.view?.containerEl?.contains(readEl));
			const inMargin = this.inSideMargin(
				evt,
				readEl.querySelector(".markdown-preview-sizer"),
				readEl.querySelector(".markdown-preview-view")
			);
			return leaf && inMargin ? { leaf } : null;
		}

		return null;
	}

	inSideMargin(evt, content, scroller) {
		if (!content || !scroller) return false;

		// Полоса прокрутки в clientWidth не входит — так её щелчки отсекаются.
		const scrollerRect = scroller.getBoundingClientRect();
		if (evt.clientX > scrollerRect.left + scroller.clientWidth) return false;

		const rect = content.getBoundingClientRect();
		// Слева — безопасная полоса вплотную к тексту: щелчок в ней проходит
		// к редактору (курсор в начало строки), переключение не срабатывает.
		// Пустота под текстом полем не считается: там щелчок ставит курсор в конец.
		const leftMargin = evt.clientX < rect.left - MARGIN_SAFE_ZONE_PX;
		const rightMargin = evt.clientX > rect.right;
		return leftMargin || rightMargin;
	}

	/* ---------- Диспетчер перетаскивания (функции 3 и 4) ---------- */

	onDragStart = (evt) => {
		this.drag = null;
		this.tabDrag = null;
		this.setHighlight(null);

		// Вкладку распознаём первой: иначе выделение, оставшееся в какой-нибудь
		// заметке, запустило бы ветку переноса текста.
		const headerEl = evt.target?.closest?.(".workspace-tab-header");
		if (headerEl) {
			this.startTabDrag(headerEl);
			return;
		}

		this.startTextDrag();
	};

	onDragOver = (evt) => {
		if (this.tabDrag) return this.tabDragOver(evt);
		if (this.drag) return this.textDragOver(evt);
	};

	onDrop = (evt) => {
		if (this.tabDrag) return this.tabDrop(evt);
		if (this.drag) return this.textDrop(evt);
	};

	onDragEnd = () => {
		// Бросок мимо целей или отменённое перетаскивание.
		this.drag = null;
		this.tabDrag = null;
		this.setHighlight(null);
	};

	/* ---------- 3. Перенос текста между вкладками ---------- */

	startTextDrag() {
		// В Live Preview dragstart.target — не .cm-content (CodeMirror делает
		// перетаскиваемым отдельный слой), поэтому источник ищем не по target,
		// а по редактору с непустым выделением.
		const source = this.findEditorWithSelection();
		if (!source) return;

		const { leaf, editor, selections } = source;
		const text = selections
			.map((sel) => {
				const [from, to] = this.orderPositions(sel.anchor, sel.head);
				return editor.getRange(from, to);
			})
			.join("\n");
		if (!text) return;

		this.drag = { leaf, editor, contentEl: editor.cm?.contentDOM ?? null, selections, text };
	}

	findEditorWithSelection() {
		let found = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			const editor = leaf.view?.editor;
			if (!editor) return;

			const selections = editor.listSelections();
			const hasText = selections.some((sel) => {
				const [from, to] = this.orderPositions(sel.anchor, sel.head);
				return from.line !== to.line || from.ch !== to.ch;
			});
			if (hasText) found = { leaf, editor, selections };
		});
		return found;
	}

	textDragOver(evt) {
		const drag = this.drag;

		// Без preventDefault на dragover браузер запрещает бросок вообще —
		// поэтому «из вкладки во вкладку» и не работает штатно.
		// Разрешаем его только над текстом другой заметки; внутри исходной
		// остаётся нативное поведение CodeMirror.
		const contentEl = evt.target?.closest?.(".cm-content");
		if (!contentEl || contentEl === drag.contentEl) return;

		evt.preventDefault();
		evt.dataTransfer.dropEffect = evt.ctrlKey || evt.metaKey ? "copy" : "move";
	}

	textDrop(evt) {
		const drag = this.drag;
		this.drag = null;

		// Проверяем лишь, что в переносе вообще есть текст. Сверять его
		// содержимое с нашим нельзя: dataTransfer заполняет CodeMirror или
		// браузер из своего представления, и оно не обязано совпадать
		// с markdown-источником.
		if (!evt.dataTransfer?.types?.includes("text/plain")) return;

		// Цель — только текст другой заметки. Броски внутри исходной обрабатывает
		// CodeMirror, броски в поиск и поля ввода остаются как есть.
		const contentEl = evt.target?.closest?.(".cm-content");
		if (!contentEl || contentEl === drag.contentEl) return;

		const targetLeaf = this.findLeaf((l) => l.view?.containerEl?.contains(contentEl));
		const targetEditor = targetLeaf?.view?.editor;
		if (!targetEditor || targetEditor === drag.editor) return;

		const pos = this.posAtMouse(targetEditor, evt);
		if (!pos) return;

		// С этого момента бросок полностью наш: глушим событие целиком, чтобы
		// его не обработали вторично ни CodeMirror, ни другие плагины.
		evt.preventDefault();
		evt.stopImmediatePropagation();

		const isCopy = evt.ctrlKey || evt.metaKey;

		// Одна и та же заметка в двух вкладках: редакторы разные, но документ
		// общий — вставка сдвинула бы сохранённые координаты, и удаление
		// зацепило бы не тот текст. Поэтому здесь всегда копирование.
		const sourcePath = drag.leaf.view?.file?.path;
		const sameFile = sourcePath && sourcePath === targetLeaf.view?.file?.path;

		targetEditor.replaceRange(drag.text, pos);
		if (!isCopy && !sameFile) this.deleteRanges(drag.editor, drag.selections);

		// Как при штатном броске: цель активируется, вставленное выделено.
		const end = this.endOfInsertion(pos, drag.text);
		this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
		targetEditor.setSelection(pos, end);
		targetEditor.focus();
	}

	posAtMouse(editor, evt) {
		// Публичный способ, если он есть в этой версии API…
		if (typeof editor.posAtMouse === "function") return editor.posAtMouse(evt);

		// …и запасной через CodeMirror напрямую.
		const offset = editor.cm?.posAtCoords?.({ x: evt.clientX, y: evt.clientY });
		return offset == null ? null : editor.offsetToPos(offset);
	}

	endOfInsertion(pos, text) {
		const lines = text.split("\n");
		const last = lines[lines.length - 1];
		return lines.length === 1
			? { line: pos.line, ch: pos.ch + last.length }
			: { line: pos.line + lines.length - 1, ch: last.length };
	}

	deleteRanges(editor, selections) {
		const ranges = selections
			.map((sel) => {
				const [from, to] = this.orderPositions(sel.anchor, sel.head);
				return { from, to };
			})
			// Снизу вверх, чтобы удаление не сдвигало координаты следующих.
			.sort((a, b) => b.from.line - a.from.line || b.from.ch - a.from.ch);

		for (const range of ranges) editor.replaceRange("", range.from, range.to);
	}

	orderPositions(a, b) {
		const aFirst = a.line < b.line || (a.line === b.line && a.ch <= b.ch);
		return aFirst ? [a, b] : [b, a];
	}

	/* ---------- 4. Вкладка → папка в проводнике ---------- */

	startTabDrag(headerEl) {
		const leaf = this.findLeaf((l) => l.tabHeaderEl === headerEl);
		// Вкладки без файла (граф, поиск, сам проводник) переносить некуда.
		const file = leaf?.view?.file;
		if (!file) return;

		this.tabDrag = { file };
	}

	// Определяет папку-цель под курсором в проводнике.
	// Возвращает { folder, highlightEl } или null.
	explorerTarget(evt) {
		const target = evt.target;
		if (!target?.closest?.(".nav-files-container")) return null;

		const { vault } = this.app;

		// Папка — бросок прямо в неё.
		const folderTitle = target.closest(".nav-folder-title");
		if (folderTitle) {
			const path = folderTitle.getAttribute("data-path");
			const folder = path === "/" || !path ? vault.getRoot() : vault.getAbstractFileByPath(path);
			if (folder && folder.children) {
				return { folder, highlightEl: folderTitle.closest(".nav-folder") ?? folderTitle };
			}
			return null;
		}

		// Файл — бросок в папку, где он лежит (как у штатного перетаскивания).
		const fileTitle = target.closest(".nav-file-title");
		if (fileTitle) {
			const file = vault.getAbstractFileByPath(fileTitle.getAttribute("data-path"));
			const folder = file?.parent ?? vault.getRoot();
			const folderEl = fileTitle.closest(".nav-folder");
			return { folder, highlightEl: folderEl ?? null };
		}

		// Пустое место проводника — корень хранилища.
		return { folder: vault.getRoot(), highlightEl: null };
	}

	tabDragOver(evt) {
		const hit = this.explorerTarget(evt);
		if (!hit) {
			this.setHighlight(null);
			return;
		}

		evt.preventDefault();
		evt.stopImmediatePropagation();
		evt.dataTransfer.dropEffect = "move";
		this.setHighlight(hit.highlightEl);
	}

	tabDrop(evt) {
		const { file } = this.tabDrag;
		this.tabDrag = null;
		this.setHighlight(null);

		const hit = this.explorerTarget(evt);
		if (!hit) return;

		// Бросок наш: дальше по цепочке его никто обрабатывать не должен.
		evt.preventDefault();
		evt.stopImmediatePropagation();

		const folder = hit.folder;
		const folderPath = folder.isRoot?.() || folder.path === "/" ? "" : folder.path;

		// Уже лежит здесь — делать нечего.
		if ((file.parent?.path ?? "/") === (folderPath || "/")) return;

		const newPath = normalizePath(folderPath ? `${folderPath}/${file.name}` : file.name);
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`В папке «${folderPath || "корень"}» уже есть ${file.name}`);
			return;
		}

		// renameFile — штатное перемещение: ссылки на заметку обновляются
		// по настройке «Автоматически обновлять внутренние ссылки»,
		// открытая вкладка остаётся на месте и следует за файлом.
		this.app.fileManager
			.renameFile(file, newPath)
			.then(() => new Notice(`${file.basename} → ${folderPath || "корень"}`))
			.catch((err) => {
				console.error("[yule-mouse] не удалось переместить:", err);
				new Notice(`Не удалось переместить ${file.name}`);
			});
	}

	setHighlight(el) {
		if (this.highlightEl === el) return;
		this.highlightEl?.removeClass?.(DROP_HIGHLIGHT);
		this.highlightEl = el;
		el?.addClass?.(DROP_HIGHLIGHT);
	}

	/* ---------- Общее ---------- */

	findLeaf(predicate, mainAreaOnly = false) {
		const { workspace } = this.app;
		let found = null;

		workspace.iterateAllLeaves((leaf) => {
			// tabHeaderEl — недокументированное, но давно стабильное свойство leaf.
			if (found || !predicate(leaf)) return;

			if (mainAreaOnly) {
				const root = leaf.getRoot();
				// Для вкладок всплывающих окон root — их собственный rootSplit,
				// поэтому такая проверка отсекает только боковые панели.
				if (root === workspace.leftSplit || root === workspace.rightSplit) return;
			}

			found = leaf;
		});

		return found;
	}
};
