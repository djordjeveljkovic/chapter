import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { discover, latestCommit, prepareBook } from "../../src/lib/github";
import {
  sourceId,
  validateDocuments,
  headingSlugs,
  parseChapter,
} from "../../src/lib/format";
import {
  db,
  listBooks,
  loadDraft,
  loadReading,
  saveBook,
  saveReading,
  saveDraft,
  savePreferences,
  saveBrief,
  loadPreferences,
  loadBrief,
  saveUpdate,
  loadUpdates,
  removeBook,
} from "../../src/lib/storage";
import {
  exportBackup,
  importBackup,
  validateBackup,
} from "../../src/lib/backup";
import {
  defaultBrief,
  defaultPreferences,
  type Book,
  type Discovery,
} from "../../src/lib/types";
import {
  scaffoldFiles,
  promptFor,
  promptStages,
} from "../../src/lib/authoring";

const commit = "a".repeat(40),
  nextCommit = "b".repeat(40);
const source = { owner: "author", repo: "audit", branch: "main", root: "book" };
const id = sourceId(source);
const chapterPath = "book/volumes/01-one/001-one.md";
const files: Record<string, string> = {
  "book/README.md": "# Audit\n[One](volumes/01-one/001-one.md)",
  "book/volumes/01-one/README.md": "# One\n[One](001-one.md)",
  [chapterPath]:
    "---\nvolume: 1\nvolume_title: One\nchapter: 1\ntitle: One\nslug: one\nstatus: complete\n---\n# One\n\n## Section\n\nThe original edition.",
};
const entries = Object.keys(files).map((path) => ({
  path,
  type: "blob",
  sha: commit,
  size: files[path].length,
}));
const discovery: Discovery = {
  id,
  source,
  commit,
  title: "Audit",
  description: "",
  entries,
  chapterPaths: [chapterPath],
  volumes: 1,
  bytes: 1000,
  index: files["book/README.md"],
};
const makeBook = (): Book => ({
  id,
  source,
  commit,
  title: "Audit",
  description: "",
  documents: structuredClone(files),
  chapters: validateDocuments(files, entries, "book").chapters,
  assets: [],
  issues: [],
  downloadedAt: new Date().toISOString(),
  bytes: 1000,
});
const backupOf = (book: Book) => ({
  format: "chapter-backup",
  version: 1,
  exportedAt: new Date().toISOString(),
  books: [book],
  reading: [],
  updates: [],
  preferences: defaultPreferences,
});
beforeEach(async () => {
  const database = await db();
  const tx = database.transaction(
    ["books", "drafts", "reading", "updates", "settings"],
    "readwrite",
  );
  for (const store of [
    "books",
    "drafts",
    "reading",
    "updates",
    "settings",
  ] as const)
    await tx.objectStore(store).clear();
  await tx.done;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub failure and branch contract", () => {
  it.each([
    [404, "could not find", 1],
    [403, "limited requests", 1],
    [429, "limited requests", 1],
    [503, "HTTP 503", 3],
  ])(
    "handles HTTP %s without affecting installed books",
    async (status, message, attempts) => {
      await saveBook(makeBook());
      const fetch = vi.fn(
        async () =>
          new Response("", {
            status: Number(status),
            headers: { "x-ratelimit-reset": "2000000000" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(discover("https://github.com/author/audit")).rejects.toThrow(
        String(message),
      );
      expect(fetch).toHaveBeenCalledTimes(Number(attempts));
      expect((await listBooks())[0].commit).toBe(commit);
    },
  );
  it.each([
    [new TypeError("network disconnected"), "Could not connect"],
    [new DOMException("timeout", "TimeoutError"), "took too long"],
  ])(
    "retries transport errors and provides an actionable message",
    async (error, message) => {
      const fetch = vi.fn(async () => {
        throw error;
      });
      vi.stubGlobal("fetch", fetch);
      await expect(latestCommit(source)).rejects.toThrow(String(message));
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );
  it.each([
    [true, false, "public repositories"],
    [false, true, "complete GitHub tree"],
  ])(
    "rejects inaccessible or incomplete trees",
    async (isPrivate, truncated, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.endsWith("/repos/author/audit"))
            return Response.json({
              default_branch: "main",
              private: isPrivate,
            });
          if (url.includes("/commits/")) return Response.json({ sha: commit });
          return Response.json({ tree: entries, truncated });
        }),
      );
      await expect(discover("https://github.com/author/audit")).rejects.toThrow(
        String(message),
      );
    },
  );
  it("encodes an explicitly selected branch and pins every downloaded file to the preview commit", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith("/repos/author/audit"))
          return Response.json({ default_branch: "main", private: false });
        if (url.includes("/commits/")) return Response.json({ sha: commit });
        if (url.includes("/git/trees/"))
          return Response.json({ tree: entries, truncated: false });
        const path = decodeURIComponent(url.split(`/${commit}/`)[1]);
        return new Response(files[path]);
      }),
    );
    const snapshot = await discover(
      "https://github.com/author/audit",
      " release/edition ",
    );
    expect(snapshot.source.branch).toBe("release/edition");
    expect(urls.some((url) => url.endsWith("/commits/release%2Fedition"))).toBe(
      true,
    );
    urls.length = 0;
    const book = await prepareBook(
      snapshot,
      vi.fn(),
      new AbortController().signal,
      undefined,
      false,
    );
    expect(book.commit).toBe(commit);
    expect(urls.length).toBe(2);
    expect(urls.every((url) => url.includes(`/${commit}/`))).toBe(true);
  });
  it("reports an unavailable selected branch without downloading its tree", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return url.includes("/commits/")
          ? new Response("", { status: 404 })
          : Response.json({ default_branch: "main", private: false });
      }),
    );
    await expect(
      discover("https://github.com/author/audit", "missing-branch"),
    ).rejects.toThrow("Check the URL and branch");
    expect(urls[1]).toContain("/commits/missing-branch");
    expect(urls).toHaveLength(2);
  });
});

describe("persistent, immutable edition staging", () => {
  it("persists completed in-flight responses on cancellation and resumes the same pinned snapshot", async () => {
    const old = makeBook();
    await saveBook(old);
    const snapshot = { ...discovery, commit: nextCommit };
    const controller = new AbortController();
    const successful = "book/volumes/01-one/README.md";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        const path = decodeURIComponent(url.split(`/${nextCommit}/`)[1]);
        if (path === successful) return new Response(files[path]);
        return new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          setTimeout(() => controller.abort(), 5);
        });
      }),
    );
    await expect(
      prepareBook(snapshot, vi.fn(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const draft = await loadDraft(id);
    expect(draft?.discovery.commit).toBe(nextCommit);
    expect(draft?.documents[successful]).toBe(files[successful]);
    expect((await listBooks())[0].commit).toBe(commit);
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        const path = decodeURIComponent(url.split(`/${nextCommit}/`)[1]);
        return new Response(files[path]);
      }),
    );
    const resumed = await prepareBook(
      draft!.discovery,
      vi.fn(),
      new AbortController().signal,
    );
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain(chapterPath);
    expect(resumed.commit).toBe(nextCommit);
  });
  it("reuses unchanged chapter and image blobs without mutating the installed edition", async () => {
    const previous = makeBook();
    previous.documents[chapterPath] += "\n![Chart](../../images/chart.png)";
    previous.assets = [
      {
        path: "book/images/chart.png",
        mime: "image/png",
        blobSha: commit,
        data: "iVBORw==",
      },
    ];
    const original = structuredClone(previous);
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain(`/${nextCommit}/book/volumes/01-one/README.md`);
      return new Response(files["book/volumes/01-one/README.md"]);
    });
    vi.stubGlobal("fetch", fetch);
    const next = await prepareBook(
      {
        ...discovery,
        commit: nextCommit,
        entries: [
          ...entries,
          { path: "book/images/chart.png", type: "blob", sha: commit, size: 4 },
        ],
      },
      vi.fn(),
      new AbortController().signal,
      previous,
      false,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(next.documents[chapterPath]).toBe(previous.documents[chapterPath]);
    expect(next.assets).toEqual(previous.assets);
    expect(next.assets[0]).not.toBe(previous.assets[0]);
    expect(previous).toEqual(original);
    const documentBytes = Object.values(next.documents).reduce(
      (total, text) => total + new TextEncoder().encode(text).length,
      0,
    );
    expect(next.bytes).toBe(documentBytes + 4);
  });
  it("rolls back a quota failure without removing the staged draft or previous reading state", async () => {
    const old = makeBook();
    await saveBook(old);
    const state = { bookId: id, bookmarks: [], completed: ["1:one"] };
    await saveReading(state);
    await saveDraft({ id, discovery, documents: files, assets: [] });
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "reading")
        throw new DOMException("Storage full", "QuotaExceededError");
      return put.call(this, value, key);
    });
    await expect(
      saveBook({ ...old, commit: nextCommit }, state),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect((await listBooks())[0].commit).toBe(commit);
    expect(await loadDraft(id)).toBeDefined();
    expect(await loadReading(id)).toEqual(state);
  });
});

describe("backup portability and concurrent snapshots", () => {
  it("exports one consistent snapshot while an edition and reading state are replaced", async () => {
    const old = makeBook();
    await saveBook(old, { bookId: id, bookmarks: [], completed: ["old"] });
    const exportPromise = exportBackup();
    const updatePromise = saveBook(
      { ...old, commit: nextCommit },
      { bookId: id, bookmarks: [], completed: ["new"] },
    );
    const snapshot = await exportPromise;
    await updatePromise;
    expect(snapshot.reading[0].completed).toEqual([
      snapshot.books[0].commit === commit ? "old" : "new",
    ]);
  });
  it("restores preferences, authoring brief, update status and orphaned bookmarks while keeping other library books", async () => {
    const book = makeBook();
    await saveBook(book);
    const prefs = {
      ...defaultPreferences,
      theme: "sepia" as const,
      fontSize: 24,
    };
    const brief = {
      ...defaultBrief,
      topic: "Restored topic",
      language: "Serbian",
      chapters: 24,
    };
    await savePreferences(prefs);
    await saveBrief(brief);
    await saveUpdate({
      bookId: id,
      latestCommit: nextCommit,
      checkedAt: new Date().toISOString(),
    });
    const location = {
      chapterId: "removed-chapter",
      path: "book/volumes/01-one/002-removed.md",
      block: 1,
      offset: 0.5,
      quote: "Saved quotation",
    };
    await saveReading({
      bookId: id,
      bookmarks: [
        {
          id: "orphan",
          label: "Keep this",
          createdAt: new Date().toISOString(),
          location,
        },
      ],
      completed: ["removed-chapter"],
    });
    const backup = await exportBackup();
    await savePreferences(defaultPreferences);
    await saveBrief(defaultBrief);
    const other = { ...book, source: { ...source, repo: "another" } };
    other.id = sourceId(other.source);
    await saveBook(other);
    await importBackup(JSON.parse(JSON.stringify(backup)));
    expect(await loadPreferences()).toEqual(prefs);
    expect(await loadBrief()).toEqual(brief);
    expect((await loadUpdates())[0].latestCommit).toBe(nextCommit);
    expect((await loadReading(id)).bookmarks[0].location).toEqual(location);
    expect((await listBooks()).map((book) => book.id)).toEqual(
      expect.arrayContaining([id, other.id]),
    );
    await removeBook(id);
    expect((await listBooks()).map((book) => book.id)).toEqual([other.id]);
    expect(await loadUpdates()).toEqual([]);
    expect((await loadReading(id)).bookmarks).toEqual([]);
  });
  it("restores books with broken anchor warnings and rejects invalid metadata", () => {
    const book = makeBook();
    book.documents[chapterPath] += "\n[Broken](#absent)";
    expect(validateBackup(backupOf(book)).books[0].issues).toContainEqual({
      severity: "warning",
      path: chapterPath,
      message: "Missing heading anchor: #absent",
    });
    book.documents[chapterPath] = files[chapterPath].replace(
      "volume: 1", "volume: nope",
    );
    expect(() => validateBackup(backupOf(book))).toThrow("invalid chapter metadata");
  });
  it("rolls back all backup writes after a quota failure while preserving existing preferences and drafts", async () => {
    const installed = makeBook();
    await saveBook(installed);
    await savePreferences({ ...defaultPreferences, theme: "dark" });
    await saveDraft({ id, discovery, documents: files, assets: [] });
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "settings")
        throw new DOMException("Storage full", "QuotaExceededError");
      return put.call(this, value, key);
    });
    await expect(
      importBackup(
        backupOf({ ...installed, title: "Incoming book", commit: nextCommit }),
      ),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect((await listBooks())[0].title).toBe(installed.title);
    expect((await loadPreferences()).theme).toBe("dark");
    expect(await loadDraft(id)).toBeDefined();
  });
  it("round trips passage notes, migrates legacy positions and keeps notes on removed passages", async () => {
    const book = makeBook();
    book.chapters[0].id = "legacy-one";
    await saveBook(book);
    const createdAt = new Date().toISOString();
    const passage = {
      chapterId: "legacy-one",
      path: chapterPath,
      block: 2,
      offset: 0.3,
      quote: "The original edition.",
    };
    const orphan = {
      chapterId: "removed",
      path: "book/volumes/01-one/002-removed.md",
      block: 0,
      offset: 0,
      quote: "A removed passage",
    };
    const notes = [
      {
        id: "passage-note",
        location: passage,
        text: "Check this argument",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "orphan-note",
        location: orphan,
        text: "Keep my observation",
        createdAt,
        updatedAt: createdAt,
      },
    ];
    await saveReading({ bookId: id, bookmarks: [], completed: [], notes });
    const exported = await exportBackup();
    await saveReading({ bookId: id, bookmarks: [], completed: [], notes: [] });
    await importBackup(JSON.parse(JSON.stringify(exported)));
    const restored = await loadReading(id);
    expect(restored.notes).toHaveLength(2);
    expect(restored.notes?.[0]).toMatchObject({
      id: "passage-note",
      text: "Check this argument",
      location: { ...passage, chapterId: "1:one" },
    });
    expect(restored.notes?.[1]).toEqual(notes[1]);
    expect(exported.reading[0].notes?.[0].location.chapterId).toBe(
      "legacy-one",
    );
  });
  it("accepts legacy backups without notes and rejects malformed notes before library writes", async () => {
    const book = makeBook();
    await saveBook(book);
    const legacy = backupOf(book);
    expect(validateBackup(legacy).books).toHaveLength(1);
    const malformed = {
      ...legacy,
      books: [{ ...book, title: "Should not overwrite" }],
      reading: [
        {
          bookId: id,
          completed: [],
          bookmarks: [],
          notes: [
            {
              id: "bad",
              text: "Lost passage",
              createdAt: "today",
              updatedAt: "today",
              location: { chapterId: "1:one", block: -1 },
            },
          ],
        },
      ],
    };
    await expect(importBackup(malformed)).rejects.toThrow("invalid reading");
    expect((await listBooks())[0].title).toBe(book.title);
  });
});

describe("book format and complete authoring workflow", () => {
  it("uses actual Markdown heading tokens, including setext/reference headings, and excludes fenced code", () => {
    const markdown =
      "# Top\n\n```md\n## Fake heading\n```\n\nA [reference][docs]\n---\n\n[docs]: https://example.com\n\n## Rock &amp; Roll\n\n> ## Nested";
    expect(headingSlugs(markdown)).toEqual([
      "top",
      "a-reference",
      "rock--roll",
      "nested",
    ]);
    const documents = {
      ...files,
      [chapterPath]: files[chapterPath] + "\n```md\n## Fake\n```\n[bad](#fake)",
    };
    expect(
      validateDocuments(documents, entries, "book").report.issues.some(
        (issue) => issue.message.includes("Missing heading anchor"),
      ),
    ).toBe(true);
  });
  it("rejects non-text identity/title metadata and unknown completion states", () => {
    for (const metadata of [
      "slug: []",
      'slug: ""',
      "title: {bad: value}",
      "status: finished",
    ]) {
      expect(() =>
        parseChapter(chapterPath, `---\n${metadata}\n---\n# Chapter`),
      ).toThrow();
    }
  });
  it("rejects conflicting volume titles while accepting filename numeric fallbacks", () => {
    const path = "book/volumes/01-one/002-two.md";
    const documents = {
      ...files,
      [path]: files[chapterPath]
        .replace("chapter: 1", "chapter: 2")
        .replace("slug: one", "slug: two")
        .replace("volume_title: One", "volume_title: Different"),
    };
    const report = validateDocuments(
      documents,
      [...entries, { path, type: "blob", sha: commit }],
      "book",
    ).report;
    expect(
      report.issues.some((issue) =>
        issue.message.includes("Conflicting titles"),
      ),
    ).toBe(true);
    expect(
      parseChapter("book/volumes/12-twelve/103-sample.md", "# Sample"),
    ).toMatchObject({ volume: 12, number: 103, title: "Sample" });
    expect(() =>
      parseChapter(
        chapterPath,
        "---\nchapter: 9007199254740993\n---\n# Sample",
      ),
    ).toThrow("positive integers");
  });
  it("validates all prompt stages and the maximum 500-chapter scaffold", () => {
    const brief = { ...defaultBrief, topic: "Large book", chapters: 500 };
    const files = scaffoldFiles(brief);
    const result = validateDocuments(
      files,
      Object.keys(files).map((path) => ({ path, type: "blob", sha: commit })),
      "book",
    );
    expect(result.report.chapters).toBe(500);
    expect(
      result.report.issues.filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    for (const stage of promptStages) {
      expect(promptFor(brief, stage)).toContain(`Current task: ${stage}`);
      expect(promptFor(brief, stage)).toContain("Do not invent facts");
    }
    expect(promptFor(brief, "Publish")).toContain(
      "Do not publish or push anything without the author's instruction",
    );
    expect(promptFor(brief, "Verify sources")).toContain(
      "actually inspected supporting material",
    );
    expect(promptFor(brief, "Write")).toContain("Exact Next Section");
  });
});
