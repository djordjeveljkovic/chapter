import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  List,
  NotebookPen,
  Pencil,
  Search,
  Settings2,
  X,
} from "lucide-react";
import type {
  Book,
  Chapter,
  Location,
  Preferences,
  ReadingState,
  Note,
} from "../lib/types";
import { findChapter } from "../lib/format";
import { loadReading, saveReading } from "../lib/storage";
import { renderChapter } from "../lib/render";
import Modal from "./Modal";

function textRange(element: Element, offset: number): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset),
    node: Node | null,
    last: Node | null = null;
  while ((node = walker.nextNode())) {
    last = node;
    if (remaining < (node.textContent?.length || 0)) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      return range;
    }
    remaining -= node.textContent?.length || 0;
  }
  if (last) {
    const range = document.createRange();
    range.setStart(last, last.textContent?.length || 0);
    range.collapse(true);
    return range;
  }
  return null;
}

function locateBlock(
  article: HTMLElement,
  location: Location,
): { block: Element; offset: number } | null {
  let block = article.children[location.block];
  let offset = location.offset;
  if (location.quote) {
    if (!block?.textContent?.includes(location.quote))
      block =
        Array.from(article.children).find((el) =>
          el.textContent?.includes(location.quote),
        ) || block;
    const match = block?.textContent?.indexOf(location.quote) ?? -1;
    if (match >= 0 && Math.abs(match - offset) > 45) offset = match;
  }
  return block ? { block, offset } : null;
}

export default function Reader({
  book,
  preferences,
  onPreferences,
  onExit,
  notify,
  initialChapter,
}: {
  book: Book;
  preferences: Preferences;
  onPreferences: (prefs: Preferences) => void;
  onExit: () => void;
  notify: (message: string, error?: boolean) => void;
  initialChapter?: string;
}) {
  const [reading, setReading] = useState<ReadingState>({
    bookId: book.id,
    bookmarks: [],
    completed: [],
  });
  const readingRef = useRef(reading);
  const [chapterId, setChapterId] = useState(book.chapters[0].id);
  const [ready, setReady] = useState(false);
  const [drawer, setDrawer] = useState<
    "contents" | "search" | "bookmarks" | "notes" | "settings" | null
  >(null);
  const [query, setQuery] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteDraft, setNoteDraft] = useState<{
    id?: string;
    location: Location;
    text: string;
  } | null>(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [viewport, setViewport] = useState(0);
  const article = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const pendingLocation = useRef<Location | null>(null);
  const pendingHash = useRef("");
  const resizeLocation = useRef<Location | null>(null);
  const lastLocation = useRef<Location | null>(null);
  const preserveAnchor = useRef(false);
  const pendingEnd = useRef(false);
  const writes = useRef(Promise.resolve());
  const drawerRef = useRef<HTMLElement>(null);
  const restoring = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const touch = useRef<{ x: number; y: number; ignored: boolean } | null>(null);
  const chapter = findChapter(book, chapterId) || book.chapters[0];
  const index = book.chapters.indexOf(chapter);
  const html = useMemo(() => renderChapter(book, chapter), [book, chapter]);
  const volumes = [...new Set(book.chapters.map((c) => c.volume))];

  const persist = useCallback(
    (value: ReadingState) => {
      readingRef.current = value;
      setReading(value);
      const write = writes.current.then(() => saveReading(value));
      writes.current = write.catch(() =>
        notify(
          "Could not save your reading progress. Check device storage.",
          true,
        ),
      );
      return write.then(
        () => true,
        () => false,
      );
    },
    [notify],
  );

  const capture = useCallback((): Location | null => {
    const root = article.current,
      container = frame.current;
    if (!root || !container) return lastLocation.current;
    if (
      preserveAnchor.current &&
      lastLocation.current?.chapterId === chapter.id
    )
      return lastLocation.current;
    if (
      root.closest("[inert]") &&
      lastLocation.current?.chapterId === chapter.id
    )
      return lastLocation.current;
    const bounds = container.getBoundingClientRect();
    const pointY = bounds.top + (preferences.mode === "pages" ? 22 : 15);
    const pointX = Math.max(
      bounds.left + 18,
      root.getBoundingClientRect().left + 5,
    );
    const doc = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = doc.caretPositionFromPoint?.(pointX, pointY);
    const range = position ? null : doc.caretRangeFromPoint?.(pointX, pointY);
    const node = position?.offsetNode || range?.startContainer;
    const children = Array.from(root.children);
    let block = node ? children.find((el) => el.contains(node)) : undefined;
    let offset = 0;
    if (block && node && node.nodeType === Node.TEXT_NODE) {
      const before = document.createRange();
      before.setStart(block, 0);
      before.setEnd(node, position?.offset || range?.startOffset || 0);
      offset = before.toString().length;
    } else {
      block = children.find((el) =>
        Array.from(el.getClientRects()).some(
          (rect) =>
            rect.bottom > bounds.top + 5 &&
            rect.top < bounds.bottom &&
            rect.right > bounds.left + 10 &&
            rect.left < bounds.right,
        ),
      );
    }
    if (!block) return null;
    const quoteText = (block.textContent || "").slice(offset, offset + 64);
    offset += quoteText.length - quoteText.trimStart().length;
    const location = {
      chapterId: chapter.id,
      path: chapter.path,
      block: children.indexOf(block),
      offset,
      quote: quoteText.trim(),
    };
    lastLocation.current = location;
    return location;
  }, [chapter.id, chapter.path, preferences.mode]);
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const savePosition = useCallback(() => {
    if (!ready) return;
    const location = restoring.current
      ? pendingLocation.current ||
        resizeLocation.current ||
        lastLocation.current
      : capture();
    if (location)
      persist({
        ...readingRef.current,
        location,
        lastReadAt: new Date().toISOString(),
      });
  }, [capture, persist, ready]);
  const savePositionRef = useRef(savePosition);
  savePositionRef.current = savePosition;

  useEffect(() => {
    let disposed = false;
    loadReading(book.id)
      .then((state) => {
        if (disposed) return;
        readingRef.current = state;
        setReading(state);
        const selected = initialChapter
          ? findChapter(book, initialChapter)
          : state.location
            ? findChapter(book, state.location.chapterId, state.location.path)
            : undefined;
        setChapterId(selected?.id || book.chapters[0].id);
        if (
          selected &&
          state.location &&
          findChapter(book, state.location.chapterId, state.location.path)
            ?.id === selected.id
        ) {
          pendingLocation.current = state.location;
          lastLocation.current = state.location;
        }
        setReady(true);
      })
      .catch(() => {
        if (!disposed) {
          setReady(true);
          notify("Could not restore the previous reading position.", true);
        }
      });
    return () => {
      disposed = true;
      clearTimeout(scrollTimer.current);
      savePositionRef.current();
    };
  }, [book.id]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      resizeLocation.current ||= lastLocation.current;
      setViewport((v) => v + 1);
    });
    if (frame.current) observer.observe(frame.current);
    const visibility = () => {
      if (document.hidden) savePositionRef.current();
    };
    const pagehide = () => savePositionRef.current();
    window.addEventListener("pagehide", pagehide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!ready || !frame.current || !article.current) return;
    restoring.current = true;
    const container = frame.current,
      root = article.current;
    const stride = container.clientWidth + 48;
    const count =
      preferences.mode === "pages"
        ? Math.max(1, Math.ceil((root.scrollWidth + 48) / stride))
        : 1;
    setPages(count);
    const location =
      pendingLocation.current ||
      resizeLocation.current ||
      (lastLocation.current?.chapterId === chapter.id
        ? lastLocation.current
        : null);
    const hash = pendingHash.current;
    let decodedHash = hash;
    try {
      decodedHash = decodeURIComponent(hash);
    } catch {
      /* malformed fragments remain literal */
    }
    const target = hash
      ? Array.from(root.querySelectorAll("[id]")).find(
          (element) => element.id === decodedHash,
        )
      : location
        ? locateBlock(root, location)?.block
        : null;
    const range =
      location && !hash && target
        ? textRange(target, locateBlock(root, location)?.offset || 0)
        : null;
    if (preferences.mode === "pages") {
      let next = pendingEnd.current ? count - 1 : 0;
      const rect =
        range?.getBoundingClientRect() || target?.getBoundingClientRect();
      if (rect)
        next = Math.floor(
          (rect.left - root.getBoundingClientRect().left + 1) / stride,
        );
      next = Math.max(0, Math.min(count - 1, next));
      container.scrollLeft = next * stride;
      container.scrollTop = 0;
      setPage(next);
    } else {
      container.scrollLeft = 0;
      const rect =
        range?.getBoundingClientRect() || target?.getBoundingClientRect();
      if (rect)
        container.scrollTop +=
          rect.top - container.getBoundingClientRect().top - 14;
      else container.scrollTop = 0;
      setPage(0);
    }
    pendingEnd.current = false;
    pendingLocation.current = null;
    pendingHash.current = "";
    resizeLocation.current = null;
    if (location && !hash) {
      const located = locateBlock(root, location);
      lastLocation.current = {
        ...location,
        chapterId: chapter.id,
        path: chapter.path,
        block: located
          ? Array.from(root.children).indexOf(located.block)
          : location.block,
        offset: located?.offset ?? location.offset,
      };
      preserveAnchor.current = true;
    } else {
      preserveAnchor.current = false;
      captureRef.current();
    }
    let settledAnimation = 0;
    const animation = requestAnimationFrame(() => {
      savePositionRef.current();
      // Browser scroll events caused by the restore must settle before they can
      // replace the text anchor with the beginning of the new page.
      settledAnimation = requestAnimationFrame(() => {
        restoring.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(animation);
      cancelAnimationFrame(settledAnimation);
      restoring.current = false;
    };
  }, [
    html,
    ready,
    preferences.mode,
    preferences.font,
    preferences.fontSize,
    preferences.lineHeight,
    preferences.width,
    viewport,
  ]);

  const selectChapter = (selected: Chapter, location?: Location, hash = "") => {
    savePosition();
    clearTimeout(scrollTimer.current);
    pendingLocation.current = location || null;
    pendingHash.current = hash;
    resizeLocation.current = null;
    if (selected.id === chapterId) setViewport((v) => v + 1);
    lastLocation.current = location || null;
    preserveAnchor.current = !!location;
    setChapterId(selected.id);
    setDrawer(null);
    window.history.replaceState(
      null,
      "",
      `#read/${encodeURIComponent(book.id)}/${encodeURIComponent(selected.id)}`,
    );
  };
  const changePreferences = (changes: Partial<Preferences>) => {
    if (Object.keys(changes).some((key) => key !== "theme"))
      pendingLocation.current = capture();
    onPreferences({ ...preferences, ...changes });
  };
  const turn = (direction: number) => {
    if (
      preferences.mode === "pages" &&
      page + direction >= 0 &&
      page + direction < pages
    ) {
      preserveAnchor.current = false;
      const next = page + direction;
      frame.current!.scrollLeft = next * (frame.current!.clientWidth + 48);
      setPage(next);
      requestAnimationFrame(savePosition);
    } else if (book.chapters[index + direction]) {
      pendingEnd.current = direction < 0 && preferences.mode === "pages";
      selectChapter(book.chapters[index + direction]);
    }
  };
  const results = useMemo(() => {
    if (query.trim().length < 2) return [];
    const term = query.trim().toLowerCase();
    return book.chapters
      .flatMap((c) => {
        const found = c.plainText.toLowerCase().indexOf(term);
        return found < 0
          ? []
          : [
              {
                chapter: c,
                snippet: c.plainText.slice(
                  Math.max(0, found - 55),
                  found + 140,
                ),
                term,
              },
            ];
      })
      .slice(0, 60);
  }, [book, query]);
  const jumpSearch = (selected: Chapter, term: string) => {
    const rendered = new DOMParser().parseFromString(
      renderChapter(book, selected),
      "text/html",
    );
    const blocks = Array.from(rendered.body.children);
    const block = blocks.findIndex((el) =>
      el.textContent?.toLowerCase().includes(term),
    );
    const text = blocks[block]?.textContent || "";
    const offset = Math.max(0, text.toLowerCase().indexOf(term));
    selectChapter(selected, {
      chapterId: selected.id,
      path: selected.path,
      block: Math.max(0, block),
      offset,
      quote: text.slice(offset, offset + 64).trim(),
    });
  };
  const passageLocation = (): Location | null => {
    const selection = window.getSelection();
    const root = article.current;
    if (root && selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      const block = Array.from(root.children).find((element) =>
        element.contains(range.startContainer),
      );
      if (block && root.contains(range.endContainer)) {
        const prefix = document.createRange();
        prefix.setStart(block, 0);
        prefix.setEnd(range.startContainer, range.startOffset);
        const selected = selection.toString();
        const offset =
          prefix.toString().length +
          selected.length -
          selected.trimStart().length;
        return {
          chapterId: chapter.id,
          path: chapter.path,
          block: Array.from(root.children).indexOf(block),
          offset,
          quote: (block.textContent || "").slice(
            offset,
            offset + Math.min(64, selected.trim().length),
          ),
        };
      }
    }
    return capture();
  };
  const composeNote = (note?: Note) => {
    const location = note?.location || passageLocation();
    if (!location) {
      notify("Scroll to a passage before adding a note.", true);
      return;
    }
    setDrawer(null);
    setNoteDraft({ id: note?.id, location, text: note?.text || "" });
  };
  const saveNote = () => {
    if (!noteDraft?.text.trim()) return;
    const now = new Date().toISOString();
    const previous = (readingRef.current.notes || []).find(
      (note) => note.id === noteDraft.id,
    );
    const note: Note = {
      id: previous?.id || crypto.randomUUID(),
      location: noteDraft.location,
      text: noteDraft.text.trim(),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    const notes = previous
      ? (readingRef.current.notes || []).map((item) =>
          item.id === note.id ? note : item,
        )
      : [...(readingRef.current.notes || []), note];
    setNoteSaving(true);
    void persist({ ...readingRef.current, notes }).then((saved) => {
      setNoteSaving(false);
      if (saved) {
        setNoteDraft(null);
        notify(
          previous
            ? "Note updated on this device."
            : "Note saved on this device.",
        );
      }
    });
  };
  const addBookmark = () => {
    const location = passageLocation();
    if (!location) {
      notify("Scroll to a passage before saving a bookmark.", true);
      return;
    }
    const value = {
      id: crypto.randomUUID(),
      location,
      label: location.quote || chapter.title,
      createdAt: new Date().toISOString(),
    };
    persist({
      ...readingRef.current,
      bookmarks: [...readingRef.current.bookmarks, value],
    }).then((saved) => {
      if (saved) notify("Bookmark saved on this device.");
    });
  };
  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = drawerRef.current;
    if (!node) return;
    (
      node.querySelector<HTMLElement>("input") ||
      node.querySelector<HTMLElement>("button") ||
      node
    ).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawer(null);
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),a[href],[tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length);
      const first = elements[0],
        last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        node.focus();
      } else if (
        !node.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, [drawer]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        drawer ||
        noteDraft ||
        !ready ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.target as Element).closest(
          "input,textarea,select,[contenteditable],pre,.table-frame",
        )
      )
        return;
      if (
        preferences.mode === "pages" &&
        (event.key === "ArrowRight" || event.key === "ArrowLeft")
      ) {
        event.preventDefault();
        turn(event.key === "ArrowRight" ? 1 : -1);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });
  const completed = reading.completed.includes(chapter.id);
  const style = {
    "--reader-font-size": `${preferences.fontSize}px`,
    "--reader-line-height": preferences.lineHeight,
    "--reader-width": `${preferences.width}px`,
    "--reader-font":
      preferences.font === "serif"
        ? 'Georgia, "Times New Roman", serif'
        : "var(--font-sans)",
  } as CSSProperties;

  return (
    <main className={`reader mode-${preferences.mode}`} style={style}>
      <header
        className="reader-header"
        inert={!!drawer || !!noteDraft || !ready}
      >
        <button
          className="icon-button"
          onClick={() => {
            savePosition();
            onExit();
          }}
          aria-label="Back to library"
        >
          <ArrowLeft size={21} />
        </button>
        <div className="reader-book-title">
          <span>{book.title}</span>
          <small>
            Volume {chapter.volume} · Chapter {chapter.number}
          </small>
        </div>
        <div className="reader-tools">
          <button
            className="icon-button"
            onClick={addBookmark}
            aria-label="Bookmark this passage"
          >
            <Bookmark size={20} />
          </button>
          <button
            className="icon-button"
            onClick={() => composeNote()}
            aria-label="Add passage note"
          >
            <NotebookPen size={20} />
          </button>
          <button
            className="icon-button"
            onClick={() => setDrawer(drawer === "settings" ? null : "settings")}
            aria-label="Reading settings"
            aria-expanded={drawer === "settings"}
            aria-controls="reader-panel"
          >
            <Settings2 size={20} />
          </button>
        </div>
      </header>
      <div className="reader-body">
        <div
          className="reading-frame"
          ref={frame}
          inert={!!drawer || !!noteDraft || !ready}
          tabIndex={0}
          aria-label={`Reading ${chapter.title}`}
          onScroll={() => {
            if (!restoring.current && !preserveAnchor.current) {
              capture();
              if (preferences.mode === "pages" && frame.current)
                setPage(
                  Math.max(
                    0,
                    Math.min(
                      pages - 1,
                      Math.round(
                        frame.current.scrollLeft /
                          (frame.current.clientWidth + 48),
                      ),
                    ),
                  ),
                );
              clearTimeout(scrollTimer.current);
              scrollTimer.current = setTimeout(
                () => savePositionRef.current(),
                250,
              );
            }
          }}
          onWheel={(event) => {
            if (!(event.target as Element).closest("pre,.table-frame"))
              preserveAnchor.current = false;
          }}
          onKeyDown={(event) => {
            if (
              !(event.target as Element).closest("pre,.table-frame") &&
              [
                "ArrowDown",
                "ArrowUp",
                "PageDown",
                "PageUp",
                "Home",
                "End",
                " ",
              ].includes(event.key)
            )
              preserveAnchor.current = false;
          }}
          onTouchStart={(event) => {
            if (event.touches.length !== 1) {
              touch.current = null;
              return;
            }
            const t = event.touches[0];
            if (!(event.target as Element).closest("pre,.table-frame"))
              preserveAnchor.current = false;
            touch.current = {
              x: t.clientX,
              y: t.clientY,
              ignored: !!(event.target as Element).closest(
                "pre,.table-frame,a,button",
              ),
            };
          }}
          onTouchCancel={() => {
            touch.current = null;
          }}
          onTouchEnd={(event) => {
            const t = event.changedTouches[0],
              start = touch.current;
            touch.current = null;
            if (
              preferences.mode !== "pages" ||
              !start ||
              start.ignored ||
              window.getSelection()?.toString()
            )
              return;
            const dx = t.clientX - start.x,
              dy = t.clientY - start.y;
            if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5)
              turn(dx < 0 ? 1 : -1);
          }}
        >
          <article
            className="book-content"
            onLoadCapture={() => {
              resizeLocation.current ||= lastLocation.current;
              setViewport((v) => v + 1);
            }}
            ref={article}
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={(event) => {
              const link = (event.target as Element).closest<HTMLAnchorElement>(
                "a[data-book-path]",
              );
              if (!link) return;
              event.preventDefault();
              const path = link.dataset.bookPath!;
              let selected = book.chapters.find((c) => c.path === path);
              if (
                !selected &&
                (/README\.md$/.test(path) || !/\.[a-z]+$/i.test(path))
              ) {
                const folder = path
                  .replace(/\/README\.md$/, "")
                  .replace(/\/$/, "");
                selected = book.chapters.find((c) =>
                  c.path.startsWith(`${folder}/`),
                );
              }
              if (selected)
                selectChapter(selected, undefined, link.dataset.bookHash);
              else
                notify(
                  "This link points outside the downloaded reading chapters. Open the source repository to view it.",
                );
            }}
          />
        </div>
        {!ready && <div className="reader-loading">Restoring your place…</div>}
        {drawer && (
          <>
            <button
              className="drawer-scrim"
              onClick={() => setDrawer(null)}
              aria-label="Close reader panel"
            />
            <aside
              className="reader-drawer"
              id="reader-panel"
              ref={drawerRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label={`${drawer} panel`}
            >
              <div className="modal-heading">
                <h2>
                  {drawer === "contents"
                    ? "Contents"
                    : drawer === "settings"
                      ? "Make yourself comfortable"
                      : drawer === "search"
                        ? "Search this book"
                        : drawer === "notes"
                          ? "Your passage notes"
                          : "Your bookmarks"}
                </h2>
                <button
                  className="icon-button"
                  onClick={() => setDrawer(null)}
                  aria-label="Close reader panel"
                >
                  <X size={20} />
                </button>
              </div>
              {drawer === "contents" && (
                <>
                  <p className="small muted">
                    {
                      book.chapters.filter((c) =>
                        reading.completed.includes(c.id),
                      ).length
                    }{" "}
                    of {book.chapters.length} chapters completed
                  </p>
                  {volumes.map((volume) => (
                    <div className="toc-volume" key={volume}>
                      <h3>
                        Volume {volume} ·{" "}
                        {
                          book.chapters.find((c) => c.volume === volume)!
                            .volumeTitle
                        }
                      </h3>
                      {book.chapters
                        .filter((c) => c.volume === volume)
                        .map((c) => (
                          <button
                            key={c.id}
                            onClick={() => selectChapter(c)}
                            aria-current={
                              c.id === chapterId ? "location" : undefined
                            }
                            className={`toc-chapter ${c.id === chapterId ? "active" : ""}`}
                          >
                            <span>{String(c.number).padStart(2, "0")}</span>
                            <span>{c.title}</span>
                            {reading.completed.includes(c.id) && (
                              <Check size={15} />
                            )}
                          </button>
                        ))}
                    </div>
                  ))}
                </>
              )}
              {drawer === "settings" && (
                <div className="reader-settings">
                  <fieldset>
                    <legend>Reading mode</legend>
                    <div className="segmented">
                      {(["scroll", "pages"] as const).map((mode) => (
                        <button
                          className={preferences.mode === mode ? "active" : ""}
                          aria-pressed={preferences.mode === mode}
                          key={mode}
                          onClick={() => changePreferences({ mode })}
                        >
                          {mode === "scroll" ? "Scroll" : "Pages"}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>Theme</legend>
                    <div className="theme-choices">
                      {(["light", "sepia", "dark"] as const).map((theme) => (
                        <button
                          key={theme}
                          className={`theme-choice ${theme} ${preferences.theme === theme ? "selected" : ""}`}
                          aria-pressed={preferences.theme === theme}
                          onClick={() => changePreferences({ theme })}
                        >
                          {theme === "light"
                            ? "Day"
                            : theme === "dark"
                              ? "Night"
                              : "Paper"}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>Typeface</legend>
                    <div className="segmented">
                      {(["serif", "sans"] as const).map((font) => (
                        <button
                          key={font}
                          className={preferences.font === font ? "active" : ""}
                          aria-pressed={preferences.font === font}
                          onClick={() => changePreferences({ font })}
                        >
                          {font === "serif" ? "Serif" : "Sans serif"}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label>
                    Font size <span>{preferences.fontSize}px</span>
                    <input
                      aria-label="Font size"
                      type="range"
                      min={14}
                      max={30}
                      step={1}
                      value={preferences.fontSize}
                      onChange={(event) =>
                        changePreferences({
                          fontSize: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Line spacing{" "}
                    <span>{preferences.lineHeight.toFixed(1)}</span>
                    <input
                      aria-label="Line spacing"
                      type="range"
                      min={1.3}
                      max={2.4}
                      step={0.1}
                      value={preferences.lineHeight}
                      onChange={(event) =>
                        changePreferences({
                          lineHeight: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Reading width <span>{preferences.width}px</span>
                    <input
                      aria-label="Reading width"
                      type="range"
                      min={480}
                      max={960}
                      step={40}
                      value={preferences.width}
                      onChange={(event) =>
                        changePreferences({ width: Number(event.target.value) })
                      }
                    />
                  </label>
                  <p className="small muted">
                    Your place stays with the text when you change the layout.
                  </p>
                </div>
              )}
              {drawer === "search" && (
                <>
                  <label className="search-field">
                    <Search size={18} />
                    <input
                      autoFocus
                      type="search"
                      aria-label="Search book text"
                      placeholder="Search words or phrases"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                  <p className="small muted">
                    {query.trim().length < 2
                      ? "Enter at least two characters. Search works offline."
                      : `${results.length}${results.length === 60 ? "+" : ""} matching chapters`}
                  </p>
                  <div className="search-results">
                    {results.map((result) => (
                      <button
                        key={result.chapter.id}
                        onClick={() => jumpSearch(result.chapter, result.term)}
                      >
                        <strong>{result.chapter.title}</strong>
                        <span>…{result.snippet}…</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {drawer === "notes" && (
                <>
                  <button
                    className="button primary"
                    onClick={() => composeNote()}
                  >
                    Add a note here
                  </button>
                  {!!reading.notes?.length && (
                    <p className="small muted">
                      Tap a note to return to its passage.
                    </p>
                  )}
                  {!reading.notes?.length && (
                    <p className="muted">
                      Keep your thoughts beside a passage. Select text or add a
                      note where you are reading.
                    </p>
                  )}
                  {(reading.notes || []).map((note) => {
                    const target = findChapter(
                      book,
                      note.location.chapterId,
                      note.location.path,
                    );
                    return (
                      <div className="note-item bookmark-item" key={note.id}>
                        <button
                          onClick={() =>
                            target && selectChapter(target, note.location)
                          }
                          disabled={!target}
                          aria-label={`Read passage for note: ${note.text}`}
                        >
                          <small>
                            {target?.title ||
                              "Chapter removed from this edition"}
                          </small>
                          <span>{note.text}</span>
                          <small className="note-passage">
                            {note.location.quote}
                          </small>
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Edit note: ${note.text}`}
                          onClick={() => composeNote(note)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Delete note: ${note.text}`}
                          onClick={() => {
                            void persist({
                              ...readingRef.current,
                              notes: (readingRef.current.notes || []).filter(
                                (item) => item.id !== note.id,
                              ),
                            }).then((saved) => {
                              if (saved) notify("Note deleted.");
                            });
                          }}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
              {drawer === "bookmarks" && (
                <>
                  {!reading.bookmarks.length && (
                    <p className="muted">
                      Save passages using the bookmark button while reading.
                    </p>
                  )}
                  {reading.bookmarks.map((mark) => {
                    const target = findChapter(
                      book,
                      mark.location.chapterId,
                      mark.location.path,
                    );
                    return (
                      <div className="bookmark-item" key={mark.id}>
                        <button
                          onClick={() =>
                            target && selectChapter(target, mark.location)
                          }
                          disabled={!target}
                        >
                          <small>
                            {target?.title ||
                              "Chapter removed from this edition"}
                          </small>
                          <span>{mark.label}</span>
                        </button>
                        <button
                          className="icon-button"
                          aria-label="Remove bookmark"
                          onClick={() =>
                            persist({
                              ...readingRef.current,
                              bookmarks: readingRef.current.bookmarks.filter(
                                (b) => b.id !== mark.id,
                              ),
                            })
                          }
                        >
                          <X size={16} />
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </aside>
          </>
        )}
      </div>
      <footer
        className="reader-footer"
        inert={!!drawer || !!noteDraft || !ready}
      >
        <div className="reader-footer-tools">
          <button
            className={`icon-button ${drawer === "contents" ? "selected" : ""}`}
            onClick={() => setDrawer(drawer === "contents" ? null : "contents")}
            aria-label="Table of contents"
            aria-expanded={drawer === "contents"}
            aria-controls="reader-panel"
          >
            <List size={21} />
          </button>
          <button
            className="icon-button"
            onClick={() => setDrawer(drawer === "search" ? null : "search")}
            aria-label="Search book"
            aria-expanded={drawer === "search"}
            aria-controls="reader-panel"
          >
            <Search size={20} />
          </button>
          <button
            className="icon-button"
            onClick={() =>
              setDrawer(drawer === "bookmarks" ? null : "bookmarks")
            }
            aria-label="View bookmarks"
            aria-expanded={drawer === "bookmarks"}
            aria-controls="reader-panel"
          >
            <BookmarkCheck size={20} />
          </button>
          <button
            className="icon-button"
            onClick={() => setDrawer(drawer === "notes" ? null : "notes")}
            aria-label="View passage notes"
            aria-expanded={drawer === "notes"}
            aria-controls="reader-panel"
          >
            <NotebookPen size={20} />
          </button>
        </div>
        <div className="chapter-navigation">
          <button
            className="icon-button"
            disabled={index === 0 && page === 0}
            onClick={() => turn(-1)}
            aria-label="Previous page or chapter"
          >
            <ChevronLeft size={21} />
          </button>
          <span>
            {preferences.mode === "pages"
              ? `${page + 1} / ${pages}`
              : `${index + 1} / ${book.chapters.length}`}
          </span>
          <button
            className="icon-button"
            disabled={
              index === book.chapters.length - 1 &&
              (preferences.mode === "scroll" || page === pages - 1)
            }
            onClick={() => turn(1)}
            aria-label="Next page or chapter"
          >
            <ChevronRight size={21} />
          </button>
        </div>
        <button
          className={`complete-button ${completed ? "completed" : ""}`}
          aria-pressed={completed}
          onClick={() =>
            persist({
              ...readingRef.current,
              completed: completed
                ? readingRef.current.completed.filter((id) => id !== chapter.id)
                : [...readingRef.current.completed, chapter.id],
            })
          }
        >
          <Check size={18} />
          <span>{completed ? "Completed" : "Mark complete"}</span>
        </button>
      </footer>
      {noteDraft && (
        <Modal
          title={noteDraft.id ? "Edit passage note" : "Add passage note"}
          onClose={() => setNoteDraft(null)}
        >
          <div className="note-editor">
            <p className="small muted">Your note returns to this passage:</p>
            <blockquote className="note-passage">
              {noteDraft.location.quote || chapter.title}
            </blockquote>
            <label htmlFor="passage-note-text">Note text</label>
            <textarea
              id="passage-note-text"
              autoFocus
              rows={6}
              maxLength={10000}
              value={noteDraft.text}
              placeholder="What would you like to remember?"
              onChange={(event) =>
                setNoteDraft({ ...noteDraft, text: event.target.value })
              }
            />
            <div className="button-row">
              <button
                className="button secondary"
                onClick={() => setNoteDraft(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={noteSaving || !noteDraft.text.trim()}
                aria-busy={noteSaving}
                onClick={saveNote}
              >
                {noteSaving ? "Saving…" : "Save note"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
