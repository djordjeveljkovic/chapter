import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  CircleHelp,
  CloudOff,
  Download,
  ExternalLink,
  HardDrive,
  Library,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  WifiOff,
  X,
} from "lucide-react";
import {
  BookValidationError,
  discover,
  latestCommit,
  prepareBook,
  repoURL,
} from "../lib/github";
import { bookHref, findChapter, formatBytes, SAMPLE_URL } from "../lib/format";
import {
  defaultPreferences,
  type Book,
  type Discovery,
  type Draft,
  type Issue,
  type Location,
  type Preferences,
  type ReadingState,
  type TransferProgress,
  type UpdateStatus,
} from "../lib/types";
import {
  discardDraft,
  listBooks,
  listDrafts,
  loadGitHubToken,
  loadPreferences,
  loadReading,
  loadUpdates,
  removeBook,
  removeGitHubToken,
  saveBook,
  saveGitHubToken,
  savePreferences,
  saveUpdate,
} from "../lib/storage";
import {
  downloadFile,
  exportBackup,
  importBackup,
  validateBackup,
  type Backup,
} from "../lib/backup";
import { registerOffline, verifyOfflineShell } from "../lib/offline";
import Modal from "./Modal";
import Reader from "./Reader";
import Authoring, { IssueList } from "./Authoring";

interface Route {
  page: "library" | "create" | "read";
  bookId?: string;
  chapter?: string;
}
function route(): Route {
  const [page, id, chapter] = window.location.hash.slice(1).split("/");
  try {
    return page === "create"
      ? { page: "create" }
      : page === "read" && id
        ? {
            page: "read",
            bookId: decodeURIComponent(id),
            chapter: chapter ? decodeURIComponent(chapter) : undefined,
          }
        : { page: "library" };
  } catch {
    return { page: "library" };
  }
}

export default function App() {
  const [currentRoute, setRoute] = useState<Route>({ page: "library" });
  const [books, setBooks] = useState<Book[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [states, setStates] = useState<Record<string, ReadingState>>({});
  const [updates, setUpdates] = useState<Record<string, UpdateStatus>>({});
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [githubToken, setGitHubToken] = useState("");
  const [githubTokenInput, setGitHubTokenInput] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [shellReady, setShellReady] = useState(false);
  const [siteUpdate, setSiteUpdate] =
    useState<ServiceWorkerRegistration | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [root, setRoot] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<Discovery | null>(null);
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [importIssues, setImportIssues] = useState<Issue[]>([]);
  const [manage, setManage] = useState<Book | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [storageUsage, setStorageUsage] = useState<{
    usage: number;
    quota: number;
    persisted: boolean;
  } | null>(null);
  const [installPrompt, setInstallPrompt] = useState<
    | (Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: string }>;
      })
    | null
  >(null);
  const inputBackup = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const checking = useRef(new Set<string>());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const notify = useCallback((message: string, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ message, error });
    if (!error) toastTimer.current = setTimeout(() => setToast(null), 6500);
  }, []);
  const reload = useCallback(async () => {
    const [saved, pending, status] = await Promise.all([
      listBooks(),
      listDrafts(),
      loadUpdates(),
    ]);
    setBooks(
      saved.sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt)),
    );
    setDrafts(pending);
    setStates(
      Object.fromEntries(
        await Promise.all(
          saved.map(async (book) => [book.id, await loadReading(book.id)]),
        ),
      ),
    );
    setUpdates(Object.fromEntries(status.map((s) => [s.bookId, s])));
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      setStorageUsage({
        usage: estimate.usage || 0,
        quota: estimate.quota || 0,
        persisted: await navigator.storage.persisted(),
      });
    }
  }, []);
  const navigate = (next: string) => {
    window.location.hash = next;
  };
  useEffect(() => {
    setRoute(route());
    setOnline(navigator.onLine);
    void Promise.all([
      reload(),
      loadPreferences().then(setPreferences),
      loadGitHubToken().then(setGitHubToken),
    ])
      .catch(() =>
        notify(
          "Local storage is unavailable. Allow site storage in your browser to save books.",
          true,
        ),
      )
      .finally(() => setLoaded(true));
    const routing = () => {
      setRoute(route());
      void reload().catch(() => {});
    };
    const connectivity = () => setOnline(navigator.onLine);
    const install = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as typeof installPrompt);
    };
    const installed = () => setInstallPrompt(null);
    window.addEventListener("hashchange", routing);
    window.addEventListener("online", connectivity);
    window.addEventListener("offline", connectivity);
    window.addEventListener("beforeinstallprompt", install);
    window.addEventListener("appinstalled", installed);
    void registerOffline(setSiteUpdate)
      .then(async (ready) =>
        setShellReady(ready && (await verifyOfflineShell())),
      )
      .catch((error) => notify((error as Error).message, true));
    return () => {
      abort.current?.abort();
      clearTimeout(toastTimer.current);
      window.removeEventListener("hashchange", routing);
      window.removeEventListener("online", connectivity);
      window.removeEventListener("offline", connectivity);
      window.removeEventListener("beforeinstallprompt", install);
      window.removeEventListener("appinstalled", installed);
    };
  }, [reload, notify]);
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);
  const onPreferences = (prefs: Preferences) => {
    setPreferences(prefs);
    void savePreferences(prefs).catch(() =>
      notify("Could not save reading settings.", true),
    );
  };
  const checkUpdate = useCallback(
    async (book: Book, force = false) => {
      if (!navigator.onLine || checking.current.has(book.id)) return;
      const existing = updates[book.id];
      if (
        !force &&
        existing?.attemptedAt &&
        Date.now() - Date.parse(existing.attemptedAt) < 3600000
      )
        return;
      checking.current.add(book.id);
      const attemptedAt = new Date().toISOString();
      let status: UpdateStatus;
      try {
        status = {
          bookId: book.id,
          latestCommit: await latestCommit(book.source, undefined, githubToken),
          checkedAt: new Date().toISOString(),
          attemptedAt,
        };
        if (force)
          notify(
            status.latestCommit === book.commit
              ? "This book is on the latest commit."
              : "An update is available for this book.",
          );
      } catch (error) {
        status = {
          ...existing,
          bookId: book.id,
          attemptedAt,
          error: (error as Error).message,
        };
        if (force) notify(status.error!, true);
      }
      try {
        await saveUpdate(status);
        setUpdates((old) => ({ ...old, [book.id]: status }));
      } catch {
        notify("Could not save the update status.", true);
      } finally {
        checking.current.delete(book.id);
      }
    },
    [updates, notify, githubToken],
  );
  useEffect(() => {
    if (loaded && online)
      books.forEach((book) => {
        void checkUpdate(book);
      });
  }, [books, online, loaded, checkUpdate]);
  const closeImport = useCallback(() => {
    if (abort.current) abort.current.abort();
    setImportOpen(false);
  }, []);
  const openImport = (sample = false) => {
    setUrl(sample ? SAMPLE_URL : "");
    setBranch("");
    setRoot("");
    setPreview(null);
    setImportIssues([]);
    setTransfer(null);
    setImportOpen(true);
  };
  const inspect = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setPreview(null);
    setImportIssues([]);
    try {
      let snapshot = await discover(
        url,
        branch,
        root,
        controller.signal,
        githubToken,
      );
      if (!controller.signal.aborted) { setPreview(snapshot); setSelectedPaths(snapshot.selectedPaths || []); }
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        notify((error as Error).message, true);
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };
  const download = async (snapshot: Discovery) => {
    snapshot = { ...snapshot, selectedPaths };
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setImportIssues([]);
    try {
      const estimate = await navigator.storage?.estimate();
      if (
        estimate?.quota &&
        snapshot.bytes > estimate.quota - (estimate.usage || 0)
      )
        throw new Error(
          "There is not enough browser storage for this book. Remove a downloaded book or free device space.",
        );
      const book = await prepareBook(
        snapshot,
        (progress) => {
          if (abort.current === controller && !controller.signal.aborted)
            setTransfer(progress);
        },
        controller.signal,
        books.find((b) => b.id === snapshot.id),
        true,
        githubToken,
      );
      if (import.meta.env.PROD && !(await verifyOfflineShell()))
        throw new Error(
          "The book is staged, but the offline app has not finished saving. Reconnect, reload, then resume this download.",
        );
      controller.signal.throwIfAborted();
      const previous = books.find((saved) => saved.id === snapshot.id);
      let migrated: ReadingState | undefined;
      if (previous) {
        const state = await loadReading(previous.id);
        const migrateLocation = (location: Location): Location => {
          const old = findChapter(previous, location.chapterId, location.path);
          const replacement = findChapter(
            book,
            old?.id || location.chapterId,
            old?.path || location.path,
          );
          return replacement
            ? { ...location, chapterId: replacement.id, path: replacement.path }
            : location;
        };
        migrated = {
          ...state,
          location: state.location
            ? migrateLocation(state.location)
            : undefined,
          bookmarks: state.bookmarks.map((mark) => ({
            ...mark,
            location: migrateLocation(mark.location),
          })),
          notes: state.notes?.map((note) => ({
            ...note,
            location: migrateLocation(note.location),
          })),
          completed: [
            ...new Set(
              state.completed.map((id) => {
                const old = findChapter(previous, id);
                return findChapter(book, id, old?.path)?.id || id;
              }),
            ),
          ],
        };
      }
      controller.signal.throwIfAborted();
      await saveBook(book, migrated);
      await navigator.storage?.persist?.().catch(() => false);
      await reload();
      if (abort.current === controller) {
        setImportOpen(false);
        setTransfer(null);
      }
      notify(
        `${book.title} is ${import.meta.env.PROD ? "ready to read offline" : "saved. Offline app caching is enabled in production builds"}.`,
      );
    } catch (error) {
      if (error instanceof BookValidationError) {
        if (abort.current === controller) setImportIssues(error.issues);
      } else if ((error as Error).name === "AbortError")
        notify("Download paused. Resume it from your library.");
      else
        notify(
          (error as Error).name === "QuotaExceededError"
            ? "Storage is full. Free space and resume the download. Your previous edition is safe."
            : (error as Error).message,
          true,
        );
      await reload().catch(() => {});
    } finally {
      if (abort.current === controller) {
        setBusy(false);
        setTransfer(null);
      }
    }
  };
  const updateBook = async (book: Book) => {
    const controller = new AbortController();
    abort.current = controller;
    setManage(null);
    setUrl(repoURL(book.source));
    setBranch(book.source.branch);
    setRoot(book.source.root);
    setPreview(null);
    setImportIssues([]);
    setImportOpen(true);
    setBusy(true);
    try {
      let snapshot = await discover(
        repoURL(book.source),
        book.source.branch,
        book.source.root,
        controller.signal,
        githubToken,
      );
      if (!controller.signal.aborted) {
        const chosen = new Set(book.selectedPaths || book.chapters.map(c => c.path));
        snapshot = { ...snapshot, selectedPaths: (snapshot.readablePaths || []).filter(path => chosen.has(path)) };
        setPreview(snapshot); setSelectedPaths(snapshot.selectedPaths || []);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        notify((error as Error).message, true);
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };
  const savedBook = books.find((book) => book.id === currentRoute.bookId);
  const isReader = currentRoute.page === "read" && !!savedBook;
  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");

  return (
    <>
      {!isReader && (
        <header className="site-header">
          <div className="header-inner">
            <a href="#library" className="brand" aria-label="Chapter home">
              <span className="brand-mark">
                <BookOpen size={22} strokeWidth={1.8} />
              </span>
              chapter<span className="brand-dot">.</span>
            </a>
            <nav aria-label="Main navigation">
              <a
                className={currentRoute.page === "library" ? "active" : ""}
                href="#library"
              >
                <Library size={17} />
                <span>My library</span>
              </a>
              <a
                className={currentRoute.page === "create" ? "active" : ""}
                href="#create"
              >
                <Sparkles size={17} />
                <span>Create a book</span>
              </a>
            </nav>
            <button
              className="icon-button library-settings"
              onClick={() => {
                setGitHubTokenInput("");
                setSettingsOpen(true);
              }}
              aria-label="Library settings"
            >
              <Settings2 size={20} />
            </button>
          </div>
        </header>
      )}
      {!online && (
        <div className="connection-banner">
          <WifiOff size={15} />
          You're offline. Your saved books are here.
        </div>
      )}
      {siteUpdate && (
        <div className="connection-banner">
          A new version of Chapter is ready.
          <button
            className="text-button"
            onClick={() => {
              navigator.serviceWorker.addEventListener(
                "controllerchange",
                () => window.location.reload(),
                { once: true },
              );
              siteUpdate.waiting?.postMessage({ type: "SKIP_WAITING" });
            }}
          >
            Reload app
          </button>
        </div>
      )}
      {isReader ? (
        <Reader
          key={savedBook.id}
          book={savedBook}
          preferences={preferences}
          onPreferences={onPreferences}
          onExit={() => navigate("library")}
          notify={notify}
          initialChapter={currentRoute.chapter}
        />
      ) : currentRoute.page === "create" ? (
        <Authoring notify={notify} online={online} />
      ) : (
        <main className="page library-page">
          <section className="library-hero">
            <div className="hero-copy">
              <span className="eyebrow">
                <span className="tiny-dot" /> YOUR OWN CORNER OF KNOWLEDGE
              </span>
              <h1>
                A little space
                <br />
                for <em>big ideas.</em>
              </h1>
              <p>
                Bring a book from GitHub. Make yourself comfortable.
                <br className="desktop-break" /> Keep reading, even when the
                world goes offline.
              </p>
              <div className="button-row">
                <button
                  className="button primary"
                  onClick={() => openImport()}
                  disabled={!online}
                >
                  <Plus size={19} />
                  Add a book
                </button>
                <a className="text-button" href="#create">
                  Create your own
                  <ArrowRight size={17} />
                </a>
              </div>
              <div className="hero-details">
                <span>
                  <HardDrive size={15} />
                  Stored on your device
                </span>
                <span>
                  <ShieldCheck size={15} />
                  Public books need no login
                </span>
              </div>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="art-circle" />
              <div className="art-book art-book-back">
                <span>
                  always
                  <br />
                  learning
                </span>
                <i />
              </div>
              <div className="art-book art-book-front">
                <span className="art-book-kicker">
                  ONE CHAPTER
                  <br />
                  AT A TIME
                </span>
                <BookOpen size={62} strokeWidth={1} />
                <span className="art-book-title">
                  Stay
                  <br />
                  <em>curious.</em>
                </span>
                <span className="art-book-footer">
                  A LIBRARY THAT GOES WITH YOU
                </span>
              </div>
              <div className="art-caption">
                <CloudOff size={16} /> A good book. Anywhere.
              </div>
              <span className="art-star star-one">✳</span>
              <span className="art-star star-two">✧</span>
            </div>
          </section>
          <section className="shelf-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
                <h2>
                  Your bookshelf{" "}
                  <span className="count-pill">{books.length}</span>
                </h2>
              </div>
              <span className={`offline-badge ${shellReady ? "ready" : ""}`}>
                <span className="tiny-dot" />
                {shellReady
                  ? "Offline app ready"
                  : import.meta.env.DEV
                    ? "Development preview"
                    : "Saving offline app…"}
              </span>
            </div>
            {!loaded ? (
              <div className="empty-shelf">
                <LoaderCircle className="spin" size={25} />
                <p>Opening your library…</p>
              </div>
            ) : books.length ? (
              <div className="books-grid">
                {books.map((book, i) => {
                  const state = states[book.id];
                  const resume =
                    state?.location &&
                    findChapter(
                      book,
                      state.location.chapterId,
                      state.location.path,
                    );
                  const completed =
                    state?.completed.filter((id) =>
                      book.chapters.some((c) => c.id === id),
                    ).length || 0;
                  const status = updates[book.id];
                  const changed =
                    status?.latestCommit && status.latestCommit !== book.commit;
                  return (
                    <article className="book-card" key={book.id}>
                      <div className={`book-cover cover-${i % 4}`}>
                        <div className="cover-top">
                          <span>{book.chapters.length} CHAPTERS</span>
                          <BookOpen size={20} />
                        </div>
                        <h3>{book.title}</h3>
                        <div className="cover-bottom">
                          <span>{book.source.owner}</span>
                          <span>↗</span>
                        </div>
                        <span className="cover-spine" />
                      </div>
                      <div className="book-card-info">
                        <div className="book-card-meta">
                          <span>
                            <Check size={14} />
                            {shellReady ? "Ready offline" : "Saved on device"}
                          </span>
                          <button
                            className="icon-button"
                            aria-label={`Manage ${book.title}`}
                            onClick={() => setManage(book)}
                          >
                            <MoreHorizontal size={21} />
                          </button>
                        </div>
                        <h3>{book.title}</h3>
                        <p>
                          {new Set(book.chapters.map((c) => c.volume)).size}{" "}
                          volumes · {formatBytes(book.bytes)}
                        </p>
                        <div
                          className="book-progress"
                          aria-label={`${completed} chapters completed`}
                        >
                          <span
                            style={{
                              width: `${(completed / book.chapters.length) * 100}%`,
                            }}
                          />
                        </div>
                        <div className="book-progress-label">
                          <span>
                            {completed
                              ? `${completed} chapters completed`
                              : "A new adventure awaits"}
                          </span>
                          <span>
                            {Math.round(
                              (completed / book.chapters.length) * 100,
                            )}
                            %
                          </span>
                        </div>
                        {changed && (
                          <button
                            className="update-badge"
                            onClick={() => setManage(book)}
                          >
                            <RefreshCw size={13} />
                            Update available
                          </button>
                        )}
                        <button
                          className="button secondary full"
                          onClick={() =>
                            navigate(`read/${encodeURIComponent(book.id)}`)
                          }
                        >
                          {resume ? "Continue reading" : "Start reading"}
                          <ArrowRight size={17} />
                        </button>
                        {resume && (
                          <p className="resume-label">
                            Chapter {resume.number} · {resume.title}
                          </p>
                        )}
                      </div>
                    </article>
                  );
                })}
                <button
                  className="add-book-card"
                  onClick={() => openImport()}
                  disabled={!online}
                >
                  <span>
                    <Plus size={27} />
                  </span>
                  <strong>Room for another idea</strong>
                  <p>Add a GitHub book to your shelf</p>
                </button>
              </div>
            ) : (
              <div className="empty-shelf">
                <div className="empty-icon">
                  <Library size={30} strokeWidth={1.5} />
                </div>
                <h3>Your next chapter starts here.</h3>
                <p>
                  Add your first book from GitHub. Once downloaded,
                  <br />
                  it's yours to read wherever you are.
                </p>
                <button
                  className="text-button"
                  onClick={() => openImport()}
                  disabled={!online}
                >
                  Add your first book
                  <ArrowRight size={17} />
                </button>
              </div>
            )}
            {!!drafts.length && (
              <div className="pending-downloads">
                <h3>Downloads to finish</h3>
                {drafts.map((draft) => (
                  <div className="draft-item" key={draft.id}>
                    <Download size={19} />
                    <div>
                      <strong>{draft.discovery.title}</strong>
                      <span>
                        {Object.keys(draft.documents).length} files saved ·
                        commit {draft.discovery.commit.slice(0, 7)}
                      </span>
                    </div>
                    <button
                      className="text-button"
                      disabled={!online || busy}
                      onClick={() => {
                        setPreview(draft.discovery);
                        setSelectedPaths(draft.discovery.selectedPaths || draft.discovery.readablePaths || []);
                        setUrl(repoURL(draft.discovery.source));
                        setBranch(draft.discovery.source.branch);
                        setRoot(draft.discovery.source.root);
                        setImportIssues([]);
                        setImportOpen(true);
                      }}
                    >
                      Resume
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Discard download of ${draft.discovery.title}`}
                      onClick={() => {
                        void discardDraft(draft.id)
                          .then(reload)
                          .catch((error) => notify(error.message, true));
                      }}
                    >
                      <X size={17} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="sample-section">
            <div className="sample-icon">
              <BookOpen size={28} strokeWidth={1.4} />
            </div>
            <div>
              <span className="eyebrow">A GOOD PLACE TO START</span>
              <h3>The Complete Modern PHP Engineering Book</h3>
              <p>
                From fundamentals to production systems. 21 volumes, 308
                chapters, one thoughtfully structured journey.
              </p>
            </div>
            <button
              className="button secondary"
              onClick={() => openImport(true)}
              disabled={!online}
            >
              <Plus size={17} />
              Try this book
            </button>
          </section>
          <section className="library-bottom">
            <div>
              <Sparkles size={21} />
              <h3>Turn a question into a book.</h3>
              <p>
                A guided AI writing toolkit for the topics you want to
                understand.
              </p>
              <a className="text-button" href="#create">
                Explore the toolkit
                <ArrowRight size={16} />
              </a>
            </div>
            <div>
              <CloudOff size={22} />
              <h3>Your library, on your terms.</h3>
              <p>
                Books and reading progress stay in this browser. Export a backup
                to take them to another device.
              </p>
              <button
                className="text-button"
                onClick={() => {
                  setGitHubTokenInput("");
                  setSettingsOpen(true);
                }}
              >
                Manage your library
                <ArrowRight size={16} />
              </button>
            </div>
          </section>
        </main>
      )}
      {!isReader && (
        <footer className="site-footer">
          <span className="footer-brand">chapter.</span>
          <p>A little more curious, one page at a time.</p>
          <a href={`${base}format/`}>
            <CircleHelp size={15} />
            Book format
          </a>
          <a href={SAMPLE_URL} target="_blank" rel="noreferrer">
            Sample repository
            <ExternalLink size={14} />
          </a>
        </footer>
      )}
      {importOpen && (
        <Modal
          title={
            preview ? "Bring this book to your shelf" : "Add a GitHub book"
          }
          onClose={closeImport}
        >
          <p className="muted">
            Public books need no token. For private books, save a read-only
            fine-grained token in Library settings.
          </p>
          {!preview ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void inspect();
              }}
            >
              <label>
                GitHub repository URL
                <input
                  type="url"
                  required
                  value={url}
                  disabled={busy}
                  placeholder="https://github.com/owner/book"
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <div className="field-row">
                <label>
                  Branch <span className="muted">(optional)</span>
                  <input
                    value={branch}
                    disabled={busy}
                    placeholder="Repository default"
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </label>
                <label>
                  Source folder <span className="muted">(blank scans repository root)</span>
                  <input
                    value={root}
                    disabled={busy}
                    onChange={(event) => setRoot(event.target.value)}
                  />
                </label>
              </div>
              <button
                className="button primary full"
                disabled={busy || !online}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <ArrowRight size={18} />
                )}
                {busy ? "Looking inside the book…" : "Preview book"}
              </button>
              <p className="small muted">
                Supports the{" "}
                <a href={`${base}format/`}>compatible book format</a>. No GitHub
                login is needed for public repositories.
              </p>
            </form>
          ) : (
            <>
              <div className="import-preview">
                <BookOpen size={30} />
                <h3>{preview.title}</h3>
                {preview.description && <p>{preview.description}</p>}
                <div className="preview-facts">
                  <span>{preview.chapterPaths.length} readable files</span>
                  <span>{preview.volumes} volumes</span>
                  <span>≈ {formatBytes(preview.bytes)}</span>
                </div>
                <p className="small muted">
                  {preview.source.owner}/{preview.source.repo} ·{" "}
                  {preview.source.branch}
                  <br />
                  Snapshot {preview.commit.slice(0, 7)}
                </p>
              </div>
              {preview.generalLayout && (
                <fieldset className="import-file-list">
                  <legend>Files to include</legend>
                  {Array.from(new Set((preview.readablePaths || []).map(path => path.split("/").slice(0, -1).join("/") || "Repository root"))).map(folder => {
                    const paths = (preview.readablePaths || []).filter(path => (path.split("/").slice(0, -1).join("/") || "Repository root") === folder);
                    const all = paths.every(path => selectedPaths.includes(path));
                    return <div key={folder} className="import-file-folder">
                      <label><input type="checkbox" checked={all} disabled={busy} onChange={() => setSelectedPaths(current => all ? current.filter(path => !paths.includes(path)) : [...new Set([...current, ...paths])])} /> <strong>{folder}</strong></label>
                      {paths.map(path => <label key={path} className="import-file"><input type="checkbox" checked={selectedPaths.includes(path)} disabled={busy} onChange={() => setSelectedPaths(current => current.includes(path) ? current.filter(p => p !== path) : [...current, path])} />{path.split("/").at(-1)}</label>)}
                    </div>;
                  })}
                </fieldset>
              )}
              {transfer ? (
                <div className="transfer-status" role="status">
                  <span>{transfer.label}</span>
                  <progress
                    value={transfer.done}
                    max={Math.max(1, transfer.total)}
                  />
                  <small>
                    {transfer.done} / {transfer.total} files
                  </small>
                </div>
              ) : (
                <p className="small muted">
                  Chapters, links, and metadata are checked during download.
                  Your current edition stays readable until the new one is
                  complete.
                </p>
              )}
              <div className="button-row">
                <button
                  className="button primary grow"
                  disabled={busy || !online || (!!preview.generalLayout && selectedPaths.length === 0)}
                  onClick={() => {
                    void download(preview);
                  }}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <ArrowDownToLine size={18} />
                  )}
                  {busy
                    ? "Saving your book…"
                    : books.some((b) => b.id === preview.id)
                      ? "Download updated edition"
                      : "Download for offline reading"}
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    busy ? abort.current?.abort() : setPreview(null)
                  }
                >
                  {busy ? "Pause" : "Back"}
                </button>
              </div>
              {!!importIssues.length && <IssueList issues={importIssues} />}
            </>
          )}
        </Modal>
      )}
      {manage && (
        <Modal title="About this book" onClose={() => setManage(null)}>
          <h3>{manage.title}</h3>
          <p className="muted">
            {manage.chapters.length} chapters · {formatBytes(manage.bytes)} ·
            downloaded {new Date(manage.downloadedAt).toLocaleDateString()}
          </p>
          <div className="commit-details">
            <span>
              Saved commit
              <a
                href={`${bookHref(manage)}/commit/${manage.commit}`}
                target="_blank"
                rel="noreferrer"
              >
                {manage.commit.slice(0, 7)}
                <ExternalLink size={14} />
              </a>
            </span>
            <span>
              Latest checked commit
              {updates[manage.id]?.latestCommit ? (
                <a
                  href={`${bookHref(manage)}/commit/${updates[manage.id].latestCommit}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {updates[manage.id].latestCommit!.slice(0, 7)}
                  <ExternalLink size={14} />
                </a>
              ) : (
                <em>Not checked yet</em>
              )}
            </span>
          </div>
          {updates[manage.id]?.latestCommit &&
            updates[manage.id].latestCommit !== manage.commit && (
              <p className="update-notice">
                <RefreshCw size={16} />
                Update available — saved edition differs from the latest checked
                commit.
              </p>
            )}
          <p className="small muted">
            {updates[manage.id]?.checkedAt
              ? `Last successful check: ${new Date(updates[manage.id].checkedAt!).toLocaleString()}`
              : "No successful update check yet."}
            {!online && " Reconnect to check the latest commit."}
          </p>
          {updates[manage.id]?.error && (
            <p className="small error-text">
              Last check failed: {updates[manage.id].error}
            </p>
          )}
          <div className="button-row">
            <button
              className="button secondary"
              disabled={!online}
              onClick={() => {
                void checkUpdate(manage, true);
              }}
            >
              <RefreshCw size={16} />
              Check updates
            </button>
            <button
              className="button primary"
              disabled={!online}
              onClick={() => {
                void updateBook(manage);
              }}
            >
              <Download size={16} />
              Update book
            </button>
          </div>
          <a
            className="source-link"
            href={bookHref(manage)}
            target="_blank"
            rel="noreferrer"
          >
            Open source repository
            <ExternalLink size={15} />
          </a>
          {!!manage.issues.length && (
            <details>
              <summary>{manage.issues.length} import notes</summary>
              <IssueList issues={manage.issues} />
            </details>
          )}
          <button
            className="text-button danger delete-link"
            onClick={() => {
              setDeleteTarget(manage);
              setManage(null);
            }}
          >
            <Trash2 size={16} />
            Remove book from this device
          </button>
        </Modal>
      )}
      {settingsOpen && (
        <Modal
          title="Your library, your device"
          onClose={() => setSettingsOpen(false)}
        >
          <div className="storage-summary">
            <HardDrive size={24} />
            <div>
              <strong>
                {storageUsage
                  ? `${formatBytes(storageUsage.usage)} used by this site`
                  : "Storage usage unavailable"}
              </strong>
              <p className="small muted">
                {storageUsage?.persisted
                  ? "Persistent storage enabled."
                  : "Browser-managed storage. Keep a backup of your library."}
                {storageUsage?.quota
                  ? ` Up to ${formatBytes(storageUsage.quota)} available to this site.`
                  : ""}
              </p>
            </div>
          </div>
          <h3>Private repositories</h3>
          <p className="muted">
            Save a fine-grained GitHub token to read private books. Limit it to
            the repositories you need and grant <strong>Contents: read</strong>
            only. GitHub grants repository metadata access automatically. The
            token stays in this browser, is sent only to GitHub, and is not
            included in library backups. Code running on this site can access
            it, so use a narrowly scoped token.
          </p>
          <p className="small muted">
            Create one at{" "}
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
            >
              GitHub fine-grained tokens
            </a>
            . Select the repositories Chapter should read and set Contents to
            read-only.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const token = githubTokenInput.trim();
              if (!token) return;
              void saveGitHubToken(token)
                .then(() => {
                  setGitHubToken(token);
                  setGitHubTokenInput("");
                  notify("GitHub token saved on this device.");
                })
                .catch(() => notify("Could not save the GitHub token.", true));
            }}
          >
            <label>
              Fine-grained access token
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={githubTokenInput}
                placeholder={
                  githubToken ? "Enter a replacement token" : "github_pat_…"
                }
                onChange={(event) => setGitHubTokenInput(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button
                className="button secondary"
                type="submit"
                disabled={!githubTokenInput.trim()}
              >
                Save token
              </button>
              {githubToken && (
                <button
                  className="text-button danger"
                  type="button"
                  onClick={() => {
                    void removeGitHubToken()
                      .then(() => {
                        setGitHubToken("");
                        setGitHubTokenInput("");
                        notify("GitHub token removed from this device.");
                      })
                      .catch(() =>
                        notify("Could not remove the GitHub token.", true),
                      );
                  }}
                >
                  Remove saved token
                </button>
              )}
            </div>
            <p className="small muted">
              {githubToken
                ? "A token is saved in this browser. Replace or remove it here."
                : "No token is saved. Public repositories remain available without one."}
            </p>
          </form>
          <h3>Keep a copy</h3>
          <p className="muted">
            Export downloaded books, bookmarks, notes, progress, and
            preferences. Restore the backup here or on another phone.
          </p>
          <div className="button-row">
            <button
              className="button secondary"
              onClick={() => {
                void exportBackup()
                  .then((data) => {
                    downloadFile(
                      `chapter-backup-${new Date().toISOString().slice(0, 10)}.json`,
                      JSON.stringify(data),
                      "application/json",
                    );
                    notify("Library backup exported.");
                  })
                  .catch((error) => notify(error.message, true));
              }}
            >
              <Download size={17} />
              Export backup
            </button>
            <button
              className="button secondary"
              onClick={() => inputBackup.current?.click()}
            >
              <Upload size={17} />
              Restore backup
            </button>
          </div>
          <h3>Take Chapter with you</h3>
          <p className="muted">
            In Android Chrome, open the browser menu and choose “Add to home
            screen” or “Install app”. Open it once online before reading
            offline.
          </p>
          {installPrompt && (
            <button
              className="button primary"
              onClick={async () => {
                await installPrompt.prompt();
                await installPrompt.userChoice;
                setInstallPrompt(null);
              }}
            >
              Install Chapter
              <ArrowDownToLine size={17} />
            </button>
          )}
          <h3>Library appearance</h3>
          <div className="theme-choices">
            {(["light", "sepia", "dark"] as const).map((theme) => (
              <button
                className={`theme-choice ${theme} ${preferences.theme === theme ? "selected" : ""}`}
                key={theme}
                onClick={() => onPreferences({ ...preferences, theme })}
              >
                {theme === "light"
                  ? "Day"
                  : theme === "dark"
                    ? "Night"
                    : "Paper"}
              </button>
            ))}
          </div>
          <p className="small muted">
            Clearing this site's browser data removes the library. Backups also
            help when switching phones or moving to a new site address.
          </p>
        </Modal>
      )}
      {backup && (
        <Modal title="Restore your library" onClose={() => setBackup(null)}>
          <p>
            This backup contains {backup.books.length} books and their reading
            data.
          </p>
          <ul>
            {backup.books.map((book) => (
              <li key={book.id}>
                {book.title}
                {books.some((b) => b.id === book.id)
                  ? " — replaces the matching saved book"
                  : ""}
              </li>
            ))}
          </ul>
          <p className="muted">
            Other saved books stay on your shelf. This also restores appearance
            settings and the authoring brief.
          </p>
          <button
            className="button primary full"
            onClick={() => {
              void importBackup(backup)
                .then(async (count) => {
                  setPreferences(backup.preferences);
                  setBackup(null);
                  await reload();
                  notify(`Restored ${count} books.`);
                })
                .catch((error) => notify(error.message, true));
            }}
          >
            <Upload size={17} />
            Restore backup
          </button>
        </Modal>
      )}
      {deleteTarget && (
        <Modal title="Remove this book?" onClose={() => setDeleteTarget(null)}>
          <p>
            Remove <strong>{deleteTarget.title}</strong>, its bookmarks, notes,
            and reading progress from this device?
          </p>
          <p className="muted">
            Export a backup first if you want to keep your reading data.
          </p>
          <button
            className="button danger-button full"
            onClick={() => {
              void removeBook(deleteTarget.id)
                .then(async () => {
                  setDeleteTarget(null);
                  await reload();
                  notify("Book removed from this device.");
                })
                .catch((error) => notify(error.message, true));
            }}
          >
            <Trash2 size={17} />
            Remove book
          </button>
        </Modal>
      )}
      <input
        ref={inputBackup}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        aria-label="Choose library backup"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          try {
            setBackup(validateBackup(JSON.parse(await file.text())));
            setSettingsOpen(false);
          } catch (error) {
            notify(
              (error as Error).message || "This backup could not be read.",
              true,
            );
          }
        }}
      />
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          <span>
            {toast.error ? <CircleHelp size={19} /> : <Check size={19} />}
          </span>
          <p>{toast.message}</p>
          <button
            className="icon-button"
            onClick={() => setToast(null)}
            aria-label="Dismiss message"
          >
            <X size={17} />
          </button>
        </div>
      )}
    </>
  );
}
