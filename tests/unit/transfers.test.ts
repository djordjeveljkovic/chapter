import "fake-indexeddb/auto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { scaffoldFiles } from "../../src/lib/authoring";
import {
  defaultBrief,
  defaultPreferences,
  type Book,
  type Discovery,
} from "../../src/lib/types";
import { isChapter, sourceId, validateDocuments } from "../../src/lib/format";
import { discover, prepareBook } from "../../src/lib/github";
import {
  db,
  loadDraft,
  saveBook,
  saveReading,
  loadReading,
  listBooks,
  saveDraft,
} from "../../src/lib/storage";
import {
  exportBackup,
  importBackup,
  validateBackup,
} from "../../src/lib/backup";

const commit = "a".repeat(40);
const source = { owner: "author", repo: "book", branch: "main", root: "book" };
const id = sourceId(source);
const files = scaffoldFiles({ ...defaultBrief, topic: "Tests", chapters: 9 });
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
  title: "Tests",
  description: "",
  entries,
  chapterPaths: entries
    .filter((e) => /\d+-chapter/.test(e.path))
    .map((e) => e.path),
  volumes: 2,
  bytes: 1000,
  index: files["book/README.md"],
};
const makeBook = (): Book => ({
  id,
  source,
  title: "Tests",
  description: "",
  commit,
  documents: files,
  chapters: validateDocuments(files, entries, "book").chapters,
  assets: [],
  issues: [],
  downloadedAt: new Date().toISOString(),
  bytes: 1000,
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
afterEach(() => vi.unstubAllGlobals());

describe("GitHub transfers", () => {
  it("discovers a pinned commit and respects YAML index titles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/repos/author/book"))
          return Response.json({
            default_branch: "main",
            description: "Example",
            private: false,
          });
        if (url.includes("/commits/")) return Response.json({ sha: commit });
        if (url.includes("/git/trees/"))
          return Response.json({ tree: entries, truncated: false });
        expect(url).toContain(`/${commit}/book/README.md`);
        return new Response("---\ntitle: Metadata title\n---\n# Heading title");
      }),
    );
    const result = await discover("https://github.com/author/book");
    expect(result.title).toBe("Metadata title");
    expect(result.commit).toBe(commit);
    expect(result.chapterPaths).toHaveLength(9);
  });
  it("persists successful requests after failure and resumes with at most six requests", async () => {
    let active = 0,
      max = 0,
      fail = true;
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        active++;
        max = Math.max(max, active);
        const path = decodeURIComponent(url.split(`/${commit}/`)[1]);
        fetched.push(path);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        if (fail && path.endsWith("001-chapter-1.md"))
          return new Response("", { status: 404 });
        return new Response(files[path]);
      }),
    );
    await expect(
      prepareBook(discovery, vi.fn(), new AbortController().signal),
    ).rejects.toThrow("could not find");
    const draft = await loadDraft(id);
    expect(Object.keys(draft!.documents)).toHaveLength(6);
    const successful = new Set(Object.keys(draft!.documents));
    fetched.length = 0;
    fail = false;
    const book = await prepareBook(
      discovery,
      vi.fn(),
      new AbortController().signal,
    );
    expect(book.chapters).toHaveLength(9);
    expect(max).toBeLessThanOrEqual(6);
    expect(fetched.every((path) => !successful.has(path))).toBe(true);
    await saveBook(book);
    expect(await loadDraft(id)).toBeUndefined();
    expect((await listBooks())[0].commit).toBe(commit);
  });
  it("imports unfinished books with missing chapter links and draft statuses", async () => {
    const chapterPaths = entries
      .filter((entry) => isChapter(entry.path, "book"))
      .map((entry) => entry.path);
    const missing = chapterPaths[1];
    const documents = { ...files };
    delete documents[missing];
    for (const [index, status] of ["draft", "drafting"].entries()) {
      const path = chapterPaths[index + 2];
      documents[path] = documents[path].replace(
        "status: planned", `status: ${status}`,
      );
    }
    documents["book/README.md"] +=
      `\n[Unwritten chapter](${missing.slice("book/".length)})\n[Unwritten volume](volumes/03-unwritten/)\n[Future heading](volumes/01-volume-1/001-chapter-1.md#future-heading)`;
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = decodeURIComponent(url.split(`/${commit}/`)[1]);
        fetched.push(path);
        return new Response(documents[path]);
      }),
    );
    const book = await prepareBook(
      {
        ...discovery,
        entries: entries.filter((entry) => entry.path !== missing),
        chapterPaths: chapterPaths.filter((path) => path !== missing),
        index: documents["book/README.md"],
      },
      vi.fn(),
      new AbortController().signal,
    );
    expect(book.chapters).toHaveLength(8);
    expect(book.chapters.map((chapter) => chapter.status)).toEqual(
      expect.arrayContaining(["draft", "drafting"]),
    );
    expect(book.issues.every((issue) => issue.severity === "warning")).toBe(true);
    expect(book.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining("Broken internal link:"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("Missing heading anchor:"),
      }),
    ]));
    expect(fetched).not.toContain(missing);
    await saveBook(book);
    expect((await listBooks())[0].chapters).toHaveLength(8);
    expect(validateBackup(await exportBackup()).books[0].chapters).toHaveLength(8);
  });
  it("keeps the installed edition and saved reading position when an update is aborted", async () => {
    const old = makeBook();
    await saveBook(old);
    await saveReading({
      bookId: id,
      bookmarks: [],
      completed: [old.chapters[0].id],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareBook(
        { ...discovery, commit: "b".repeat(40) },
        vi.fn(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect((await listBooks())[0].commit).toBe(commit);
    expect((await loadReading(id)).completed).toEqual([old.chapters[0].id]);
  });
  it("caches linked repository images and warns about external images", async () => {
    const path = "book/volumes/01-volume-1/001-chapter-1.md";
    const documents: Record<string, string> = {
      ...files,
      [path]:
        files[path] +
        "\n![local](../../images/chart.png)\n![external](https://example.com/chart.png)",
    };
    const imagePath = "book/images/chart.png";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = decodeURIComponent(url.split(`/${commit}/`)[1]);
        return path === imagePath
          ? new Response(new Uint8Array([137, 80, 78, 71]))
          : new Response(documents[path]);
      }),
    );
    const book = await prepareBook(
      {
        ...discovery,
        entries: [
          ...entries,
          { path: imagePath, type: "blob", sha: commit, size: 4 },
        ],
      },
      vi.fn(),
      new AbortController().signal,
    );
    expect(book.assets).toEqual([
      { path: imagePath, mime: "image/png", blobSha: commit, data: "iVBORw==" },
    ]);
    expect(book.issues.some((i) => i.message.includes("External image"))).toBe(
      true,
    );
  });
});

describe("portable backups", () => {
  it("round trips books, bookmarks, reading progress and preferences", async () => {
    const book = makeBook();
    await saveBook(book);
    const location = {
      chapterId: book.chapters[0].id,
      path: book.chapters[0].path,
      block: 2,
      offset: 0.4,
      quote: "planned chapter",
    };
    await saveReading({
      bookId: id,
      location,
      bookmarks: [
        {
          id: "bookmark",
          label: "Place",
          createdAt: new Date().toISOString(),
          location,
        },
      ],
      completed: [book.chapters[0].id],
    });
    const backup = await exportBackup();
    expect(backup.version).toBe(2);
    expect(
      validateBackup(JSON.parse(JSON.stringify(backup))).books[0].chapters,
    ).toHaveLength(9);
    await saveDraft({ id, discovery, documents: {}, assets: [] });
    expect(await importBackup(backup)).toBe(1);
    expect(await loadReading(id)).toMatchObject({
      location,
      completed: [book.chapters[0].id],
    });
    expect(await loadDraft(id)).toBeUndefined();
  });
  it("rejects invalid data before any database write and never mutates caller objects", async () => {
    const book = makeBook();
    await saveBook(book);
    const bad = {
      format: "chapter-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      books: [
        {
          ...book,
          title: "Replacement",
          chapters: book.chapters.map((c) => ({
            ...c,
            title: "Untrusted derived title",
          })),
        },
      ],
      reading: [],
      updates: [],
      preferences: { ...defaultPreferences, width: NaN },
    };
    await expect(importBackup(bad)).rejects.toThrow("preferences");
    expect(bad.books[0].chapters[0].title).toBe("Untrusted derived title");
    expect((await listBooks())[0].title).toBe("Tests");
    for (const update of [
      { version: 3 },
      {
        reading: [
          { bookId: id, completed: [], bookmarks: [], location: { block: -1 } },
        ],
      },
      {
        books: [
          {
            ...book,
            assets: [
              {
                path: "image.png",
                mime: "image/png",
                data: "!!!!",
                blobSha: commit,
              },
            ],
          },
        ],
      },
    ])
      expect(() =>
        validateBackup({ ...bad, preferences: defaultPreferences, ...update }),
      ).toThrow();
  });
  it("migrates legacy chapter identities in positions, bookmarks and completion", () => {
    const book = makeBook();
    book.chapters[0].id = "chapter-1";
    const location = {
      chapterId: "chapter-1",
      path: book.chapters[0].path,
      block: 1,
      offset: 0.2,
      quote: "Chapter",
    };
    const backup = validateBackup({
      format: "chapter-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      books: [book],
      reading: [
        {
          bookId: id,
          location,
          bookmarks: [
            {
              id: "one",
              label: "One",
              createdAt: new Date().toISOString(),
              location,
            },
          ],
          completed: ["chapter-1"],
        },
      ],
      updates: [],
      preferences: defaultPreferences,
    });
    expect(backup.reading[0].location?.chapterId).toBe("1:chapter-1");
    expect(backup.reading[0].bookmarks[0].location.chapterId).toBe(
      "1:chapter-1",
    );
    expect(backup.reading[0].completed).toEqual(["1:chapter-1"]);
    expect(location.chapterId).toBe("chapter-1");
  });
  it("activates a replacement edition and migrated reading together, clearing its draft", async () => {
    const book = makeBook();
    await saveBook(book);
    await saveDraft({ id, discovery, documents: {}, assets: [] });
    const reading = {
      bookId: id,
      bookmarks: [],
      completed: [book.chapters[0].id],
    };
    await saveBook({ ...book, commit: "b".repeat(40) }, reading);
    expect((await listBooks())[0].commit).toBe("b".repeat(40));
    expect(await loadReading(id)).toEqual(reading);
    expect(await loadDraft(id)).toBeUndefined();
  });
  it("rolls back the edition and preserves the draft if reading state cannot be saved", async () => {
    const book = makeBook();
    await saveBook(book);
    await saveDraft({ id, discovery, documents: {}, assets: [] });
    const invalid = {
      bookId: id,
      bookmarks: [],
      completed: [],
      nonSerializable: () => {},
    };
    await expect(
      saveBook({ ...book, commit: "b".repeat(40) }, invalid),
    ).rejects.toMatchObject({ name: "DataCloneError" });
    expect((await listBooks())[0].commit).toBe(commit);
    expect(await loadDraft(id)).toBeDefined();
  });
  it("round trips local image assets and rejects missing images before changing the library", async () => {
    const book = makeBook();
    const path = book.chapters[0].path;
    book.documents = {
      ...book.documents,
      [path]:
        book.documents[path] +
        "\n![local](../../images/chart.png)\n[repository guide](../../../GUIDE.md)",
    };
    book.assets = [
      {
        path: "book/images/chart.png",
        mime: "image/png",
        data: "iVBORw==",
        blobSha: commit,
      },
    ];
    await saveBook(book);
    const backup = await exportBackup();
    expect(await importBackup(backup)).toBe(1);
    expect((await listBooks())[0].assets).toEqual(book.assets);
    const damaged = structuredClone(backup);
    damaged.books[0].title = "Should not replace installed book";
    damaged.books[0].assets = [];
    await expect(importBackup(damaged)).rejects.toThrow(
      "missing a required offline image",
    );
    const installed = (await listBooks())[0];
    expect(installed.title).toBe(book.title);
    expect(installed.assets).toEqual(book.assets);
  });
  it("permits external images and keeps unsupported local image placeholders as warnings", () => {
    const book = makeBook();
    const path = book.chapters[0].path;
    book.documents = {
      ...book.documents,
      [path]:
        book.documents[path] +
        "\n![external](https://example.com/chart.png)\n![unsupported](../../images/chart.bmp)",
    };
    const backup = validateBackup({
      format: "chapter-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      books: [book],
      reading: [],
      updates: [],
      preferences: defaultPreferences,
    });
    expect(backup.books[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("External image"),
        }),
        expect.objectContaining({
          severity: "warning",
          path: "book/images/chart.bmp",
          message: expect.stringContaining("Unsupported image format"),
        }),
      ]),
    );
    expect(
      backup.books[0].issues.some((issue) => issue.severity === "error"),
    ).toBe(false);
  });
});
