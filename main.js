/*
 * Yule Click
 * Двойной щелчок по заголовку вкладки → закрепить / открепить её.
 * Одиночный щелчок по полям заметки   → «Исходный код» ⇄ «Живой просмотр».
 *
 * Режим чтения в цикл не входит. Щелчки по самому тексту не затрагиваются:
 * выделение слова и строки двойным щелчком работает как обычно.
 */

const { Plugin } = require("obsidian");

// true  — закреплять только в основной области редактора (и во всплывающих окнах);
// false — реагировать ещё и на иконки вкладок в боковых панелях.
const MAIN_AREA_ONLY = false;

// "click" — переключать режим одиночным щелчком, "dblclick" — двойным.
const MARGIN_TRIGGER = "click";

// Зоны заголовка вкладки, где двойной щелчок не должен менять закрепление:
// крестик закрытия и контейнер статуса (в нём живёт индикатор-«булавка»).
const IGNORED_ZONES = [
	".workspace-tab-header-inner-close-button",
	".workspace-tab-header-status-container",
].join(", ");

module.exports = class YuleClick extends Plugin {
	// Состояние курсора, снятое до того, как щелчок успел его сдвинуть.
	pending = null;

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
	}

	/* ---------- закрепление вкладки ---------- */

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

	/* ---------- переключение режима по полям ---------- */

	onMouseDown = (evt) => {
		this.pending = null;
		if (evt.button !== 0) return;

		const viewEl = evt.target?.closest?.(".markdown-source-view");
		if (!viewEl || !this.isSideMargin(evt, viewEl)) return;

		const leaf = this.findLeaf((l) => l.view?.containerEl?.contains(viewEl));
		const editor = leaf?.view?.editor;
		if (!editor) return;

		this.pending = {
			leaf,
			selections: editor.listSelections(),
			scroll: editor.getScrollInfo?.(),
			hadFocus: editor.hasFocus?.(),
		};
	};

	onMarginTrigger = (evt) => {
		const pending = this.pending;
		this.pending = null;
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
			() => this.restore(leaf, pending)
		);
	};

	restore(leaf, pending) {
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

	/* ---------- общее ---------- */

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
