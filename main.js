/*
 * Yule Mouse
 * 1. Двойной щелчок по заголовку вкладки → закрепить / открепить её.
 * 2. Одиночный щелчок по полям заметки   → «Исходный код» ⇄ «Живой просмотр».
 * 3. Перетаскивание выделенного текста в другую вкладку → перенос
 *    (вставка в точку под мышью + удаление из источника), с Ctrl — копирование.
 *
 * Перетаскивание внутри одной заметки не затрагивается — его штатно
 * обрабатывает CodeMirror. Плагин берёт на себя только межвкладочный
 * случай, которого в Obsidian нет. Вставка и удаление выполняются одним
 * синхронным блоком: если вставка не удалась, удаление не запускается —
 * текст не может пропасть.
 */

const { Plugin } = require("obsidian");

// true  — закреплять только в основной области редактора (и во всплывающих окнах);
// false — реагировать ещё и на иконки вкладок в боковых панелях.
const MAIN_AREA_ONLY = false;

// "click" — переключать режим одиночным щелчком по полям, "dblclick" — двойным.
const MARGIN_TRIGGER = "click";

// Зоны заголовка вкладки, где двойной щелчок не должен менять закрепление:
// крестик закрытия и контейнер статуса (в нём живёт индикатор-«булавка»).
const IGNORED_ZONES = [
	".workspace-tab-header-inner-close-button",
	".workspace-tab-header-status-container",
].join(", ");

module.exports = class YuleMouse extends Plugin {
	// Состояние курсора, снятое до того, как щелчок по полю успел его сдвинуть.
	pendingMargin = null;

	// Данные текущего перетаскивания текста из редактора.
	drag = null;

	onload() {
		this.attach(document);

		// У всплывающих окон свой собственный document.
		this.registerEvent(
			this.app.workspace.on("window-open", (win) => this.attach(win.doc))
		);
	}

	attach(doc) {
		this.registerDomEvent(doc, "dblclick", this.onDblClick);

		// Фаза перехвата: нужно опередить CodeMirror, который двигает курсор
		// на mousedown, до того как сработает click.
		this.registerDomEvent(doc, "mousedown", this.onMouseDown, { capture: true });
		this.registerDomEvent(doc, MARGIN_TRIGGER, this.onMarginTrigger);

		// Перенос текста вешаем на window в фазе перехвата, а не на document.
		// Порядок вызова обработчиков одной фазы — порядок их регистрации, а
		// между плагинами он определяется порядком загрузки, то есть нам
		// неподконтролен. Но фаза перехвата идёт window → document → …, поэтому
		// window-capture гарантированно раньше любого document-обработчика
		// других плагинов (в частности, yule-auth с его диалогом авторства).
		// Так межвкладочный перенос обрабатывается и глушится до auth, а
		// перетаскивание из другого приложения (drag пуст) мы пропускаем — и
		// оно штатно доходит до auth.
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

		const viewEl = evt.target?.closest?.(".markdown-source-view");
		if (!viewEl || !this.isSideMargin(evt, viewEl)) return;

		const leaf = this.findLeaf((l) => l.view?.containerEl?.contains(viewEl));
		const editor = leaf?.view?.editor;
		if (!editor) return;

		this.pendingMargin = {
			leaf,
			selections: editor.listSelections(),
			scroll: editor.getScrollInfo?.(),
			hadFocus: editor.hasFocus?.(),
		};
	};

	onMarginTrigger = (evt) => {
		const pending = this.pendingMargin;
		this.pendingMargin = null;
		// Щелчок должен был и начаться в поле — иначе это протяжка выделения,
		// случайно отпущенная за краем текста.
		if (!pending) return;

		const viewEl = evt.target?.closest?.(".markdown-source-view");
		if (!viewEl || !this.isSideMargin(evt, viewEl)) return;

		const leaf = this.findLeaf((l) => l.view?.containerEl?.contains(viewEl));
		if (!leaf || leaf !== pending.leaf) return;

		const viewState = leaf.getViewState();
		if (viewState.type !== "markdown") return;
		// mode: "preview" — режим чтения, его не трогаем.
		if (viewState.state?.mode !== "source") return;

		// state.source: true — «Исходный код», false — «Живой просмотр».
		viewState.state.source = !viewState.state.source;

		Promise.resolve(leaf.setViewState(viewState, leaf.getEphemeralState?.())).then(
			() => this.restoreMargin(leaf, pending)
		);
	};

	restoreMargin(leaf, pending) {
		const editor = leaf.view?.editor;
		if (!editor) return;

		if (pending.hadFocus) editor.focus();
		editor.setSelections(pending.selections);
		if (pending.scroll) editor.scrollTo(pending.scroll.left, pending.scroll.top);
	}

	isSideMargin(evt, viewEl) {
		const content = viewEl.querySelector(".cm-content");
		const scroller = viewEl.querySelector(".cm-scroller");
		if (!content || !scroller) return false;

		// Полоса прокрутки в clientWidth не входит — так её щелчки отсекаются.
		const scrollerRect = scroller.getBoundingClientRect();
		if (evt.clientX > scrollerRect.left + scroller.clientWidth) return false;

		// Поле — всё, что левее или правее колонки текста. Пустота под текстом
		// полем не считается: там щелчок по-прежнему ставит курсор в конец.
		const rect = content.getBoundingClientRect();
		return evt.clientX < rect.left || evt.clientX > rect.right;
	}

	/* ---------- 3. Перенос текста между вкладками ---------- */

	onDragStart = (evt) => {
		this.drag = null;

		// В Live Preview dragstart.target — не .cm-content (CodeMirror делает
		// перетаскиваемым отдельный слой), поэтому источник ищем не по target,
		// а по редактору с непустым выделением. Заодно это отсекает
		// перетаскивание вкладок и файлов из проводника: там выделения в тексте нет.
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
	};

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

	onDragOver = (evt) => {
		const drag = this.drag;
		if (!drag) return;

		// Без preventDefault на dragover браузер запрещает бросок вообще —
		// именно поэтому «из вкладки во вкладку» не работает штатно.
		// Разрешаем его только над текстом другой заметки; внутри исходной
		// остаётся нативное поведение CodeMirror.
		const contentEl = evt.target?.closest?.(".cm-content");
		if (!contentEl || contentEl === drag.contentEl) return;

		evt.preventDefault();
		evt.dataTransfer.dropEffect = evt.ctrlKey || evt.metaKey ? "copy" : "move";
	};

	onDrop = (evt) => {
		const drag = this.drag;
		this.drag = null;
		if (!drag) return;

		// Проверяем лишь, что в переносе вообще есть текст. Сверять его
		// содержимое с нашим нельзя: dataTransfer заполняет CodeMirror или
		// браузер из своего представления (главное выделение, отрендеренный
		// текст Live Preview), и оно не обязано совпадать с markdown-источником.
		// Что перенос наш — известно из жизненного цикла: drag ставится только
		// при старте из текста заметки и сбрасывается на dragend. Если drag пуст
		// (перетаскивание из другого приложения) — мы молча выходим, и событие
		// доходит до document-обработчиков, включая диалог yule-auth.
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
		// его не обработали вторично ни CodeMirror с его editor-drop,
		// ни другие плагины. Обработчик висит на window в фазе перехвата,
		// поэтому здесь мы раньше document-обработчика yule-auth и глушение
		// до него дотягивается.
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
	};

	onDragEnd = () => {
		// Бросок мимо редакторов или отменённое перетаскивание.
		this.drag = null;
	};

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
