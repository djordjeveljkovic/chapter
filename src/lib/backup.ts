import { db } from "./storage";
import {
  defaultPreferences,
  type Book,
  type Brief,
  type Preferences,
  type ReadingState,
  type UpdateStatus,
} from "./types";
import {
  IMAGE_MIME_TYPES,
  frontMatter,
  markdownLinks,
  normalizeRoot,
  parseRepoUrl,
  resolvePath,
  sourceId,
  validateDocuments,
  parseGeneralDocuments,
} from "./format";

export interface Backup {
  format: "chapter-backup";
  version: 1 | 2;
  exportedAt: string;
  books: Book[];
  reading: ReadingState[];
  updates: UpdateStatus[];
  preferences: Preferences;
  brief?: Brief;
}
export async function exportBackup(): Promise<Backup> {
  const database = await db();
  // One read transaction gives books and their reading state the same snapshot.
  const tx = database.transaction(
    ["books", "reading", "updates", "settings"],
    "readonly",
  );
  const backup: Backup = {
    format: "chapter-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    books: await tx.objectStore("books").getAll(),
    reading: await tx.objectStore("reading").getAll(),
    updates: await tx.objectStore("updates").getAll(),
    preferences:
      ((await tx.objectStore("settings").get("preferences")) as Preferences) ||
      defaultPreferences,
    brief: (await tx.objectStore("settings").get("brief")) as Brief | undefined,
  };
  await tx.done;
  return backup;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}
export function validLocation(value: unknown): boolean {
  return (
    object(value) &&
    typeof value.chapterId === "string" &&
    typeof value.path === "string" &&
    Number.isInteger(value.block) &&
    Number(value.block) >= 0 &&
    typeof value.offset === "number" &&
    Number.isFinite(value.offset) &&
    value.offset >= 0 &&
    typeof value.quote === "string"
  );
}
export function validateBackup(value: unknown): Backup {
  // Validation must not modify the caller's objects when a later field fails.
  value = structuredClone(value);
  if (
    !object(value) ||
    value.format !== "chapter-backup" ||
    ![1, 2].includes(Number(value.version)) ||
    !Array.isArray(value.books) ||
    !Array.isArray(value.reading) ||
    !Array.isArray(value.updates)
  )
    throw new Error("Choose a Chapter backup file with format version 1.");
  const ids = new Set<string>();
  const chapterMigrations = new Map<
    string,
    Map<string, Book["chapters"][number]>
  >();
  for (const book of value.books) {
    if (
      !object(book) ||
      typeof book.id !== "string" ||
      !object(book.source) ||
      !["owner", "repo", "branch", "root"].every(
        (k) => typeof (book.source as Record<string, unknown>)[k] === "string",
      ) ||
      typeof book.title !== "string" ||
      !/^[a-f0-9]{40}$/i.test(String(book.commit)) ||
      !Array.isArray(book.chapters) ||
      !Array.isArray(book.assets) ||
      !object(book.documents) ||
      !Object.values(book.documents).every((x) => typeof x === "string") ||
      !Array.isArray(book.issues) ||
      typeof book.downloadedAt !== "string" ||
      !Number.isFinite(book.bytes) ||
      Number(book.bytes) < 0
    )
      throw new Error(
        "The backup contains an invalid book. Nothing was imported.",
      );
    const typed = book as unknown as Book;
    parseRepoUrl(
      `https://github.com/${typed.source.owner}/${typed.source.repo}`,
    );
    if (
      !typed.source.branch.trim() ||
      normalizeRoot(typed.source.root) !== typed.source.root ||
      !Number.isFinite(Date.parse(typed.downloadedAt))
    )
      throw new Error("The backup contains an invalid book source or date.");
    if (
      !typed.chapters.every(
        (chapter) =>
          object(chapter) &&
          typeof chapter.id === "string" &&
          typeof chapter.path === "string" &&
          typeof chapter.blobSha === "string",
      )
    )
      throw new Error("The backup contains invalid chapter records.");
    if (typed.id !== sourceId(typed.source) || ids.has(typed.id))
      throw new Error(
        "The backup contains duplicate or invalid book identities.",
      );
    ids.add(typed.id);
    for (const asset of typed.assets) {
      if (
        !object(asset) ||
        typeof asset.path !== "string" ||
        typeof asset.data !== "string" ||
        !/^image\/(png|jpeg|webp|gif|avif|svg\+xml)$/.test(asset.mime) ||
        typeof asset.blobSha !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data) ||
        asset.data.length % 4 !== 0
      )
        throw new Error("The backup contains an invalid image.");
    }
    const entries = Object.keys(typed.documents)
      .concat(typed.assets.map((a) => a.path))
      .map((path) => ({ path, type: "blob", sha: "" }));
    // Rebuild derived chapter HTML/text from trusted Markdown rather than trusting imported chapter objects.
    const parsed = typed.generalLayout ? {
      chapters: parseGeneralDocuments(typed.documents, typed.selectedPaths || typed.chapters.map(c => c.path), entries),
      report: { issues: [], chapters: typed.chapters.length, volumes: 0 },
    } : validateDocuments(
      typed.documents,
      entries,
      typed.source.root,
    );
    // Non-reading repository links may legitimately point outside the exported book snapshot.
    if (
      !parsed.chapters.length ||
      parsed.report.issues.some(
        (i) =>
          i.severity === "error" &&
          !i.message.startsWith("Broken internal link:"),
      )
    )
      throw new Error("The backup has invalid chapter metadata.");
    const oldChapters = typed.chapters;
    typed.chapters = parsed.chapters.map((chapter) => ({
      ...chapter,
      blobSha: oldChapters.find((c) => c.path === chapter.path)?.blobSha || "",
    }));
    chapterMigrations.set(
      typed.id,
      new Map(
        oldChapters.flatMap((old) => {
          const replacement = typed.chapters.find(
            (chapter) => chapter.path === old.path,
          );
          return replacement ? [[old.id, replacement] as const] : [];
        }),
      ),
    );
    typed.description = String(typed.description || "");
    typed.issues = parsed.report.issues.filter(
      (i) => !i.message.startsWith("Broken internal link:"),
    );
    const assetPaths = new Set(typed.assets.map((asset) => asset.path));
    const unsupportedImages = new Set<string>();
    for (const [path, text] of Object.entries(typed.documents)) {
      for (const link of markdownLinks(frontMatter(text).body).filter(
        (link) => link.image,
      )) {
        const target = resolvePath(path, link.href);
        if (!target) continue;
        const mime =
          IMAGE_MIME_TYPES[target.path.split(".").at(-1)!.toLowerCase()];
        if (mime && !assetPaths.has(target.path))
          throw new Error(
            `The backup is missing a required offline image: ${target.path}. Nothing was imported.`,
          );
        if (!mime && !unsupportedImages.has(target.path)) {
          typed.issues.push({
            severity: "warning",
            path: target.path,
            message:
              "Unsupported image format; this image is unavailable offline.",
          });
          unsupportedImages.add(target.path);
        }
      }
    }
  }
  for (const state of value.reading) {
    if (
      !object(state) ||
      !ids.has(String(state.bookId)) ||
      !Array.isArray(state.bookmarks) ||
      !strings(state.completed) ||
      (state.location !== undefined && !validLocation(state.location)) ||
      state.bookmarks.some(
        (b) =>
          !object(b) ||
          typeof b.id !== "string" ||
          typeof b.label !== "string" ||
          typeof b.createdAt !== "string" ||
          !validLocation(b.location),
      ) ||
      (state.notes !== undefined &&
        (!Array.isArray(state.notes) ||
          state.notes.some(
            (note) =>
              !object(note) ||
              typeof note.id !== "string" ||
              typeof note.text !== "string" ||
              typeof note.createdAt !== "string" ||
              typeof note.updatedAt !== "string" ||
              !validLocation(note.location),
          )))
    )
      throw new Error(
        "The backup contains invalid reading positions or bookmarks.",
      );
    const typed = state as unknown as ReadingState;
    const migrations = chapterMigrations.get(typed.bookId)!;
    const book = (value.books as Book[]).find(
      (book) => book.id === typed.bookId,
    )!;
    const migrate = (location: NonNullable<ReadingState["location"]>) => {
      const chapter =
        book.chapters.find((chapter) => chapter.path === location.path) ||
        migrations.get(location.chapterId);
      if (chapter) {
        location.chapterId = chapter.id;
        location.path = chapter.path;
      }
    };
    if (typed.location) migrate(typed.location);
    typed.bookmarks.forEach((bookmark) => migrate(bookmark.location));
    typed.notes?.forEach((note) => migrate(note.location));
    typed.completed = [
      ...new Set(typed.completed.map((id) => migrations.get(id)?.id || id)),
    ];
  }
  for (const update of value.updates) {
    if (
      !object(update) ||
      !ids.has(String(update.bookId)) ||
      (update.latestCommit !== undefined &&
        !/^[a-f0-9]{40}$/i.test(String(update.latestCommit)))
    )
      throw new Error("Invalid update status in the backup.");
  }
  const prefs = value.preferences;
  if (
    !object(prefs) ||
    !["light", "dark", "sepia"].includes(String(prefs.theme)) ||
    !["scroll", "pages"].includes(String(prefs.mode)) ||
    !["serif", "sans"].includes(String(prefs.font)) ||
    typeof prefs.fontSize !== "number" ||
    !Number.isFinite(prefs.fontSize) ||
    prefs.fontSize < 14 ||
    prefs.fontSize > 30 ||
    typeof prefs.lineHeight !== "number" ||
    !Number.isFinite(prefs.lineHeight) ||
    prefs.lineHeight < 1.3 ||
    prefs.lineHeight > 2.4 ||
    typeof prefs.width !== "number" ||
    !Number.isFinite(prefs.width) ||
    prefs.width < 480 ||
    prefs.width > 960
  )
    throw new Error("The backup has invalid reader preferences.");
  if (
    value.brief !== undefined &&
    (!object(value.brief) ||
      !["topic", "audience", "level", "language", "goals", "depth"].every(
        (k) => typeof (value.brief as Record<string, unknown>)[k] === "string",
      ) ||
      !Number.isInteger(value.brief.chapters) ||
      Number(value.brief.chapters) < 1 ||
      Number(value.brief.chapters) > 500)
  )
    throw new Error("Invalid authoring brief in the backup.");
  return value as unknown as Backup;
}

export async function importBackup(value: unknown) {
  const backup = validateBackup(value);
  const database = await db();
  const tx = database.transaction(
    ["books", "reading", "updates", "settings", "drafts"],
    "readwrite",
  );
  try {
    for (const book of backup.books) {
      await tx.objectStore("books").put(book, book.id);
      await tx.objectStore("drafts").delete(book.id);
    }
    for (const state of backup.reading)
      await tx.objectStore("reading").put(state, state.bookId);
    for (const update of backup.updates)
      await tx.objectStore("updates").put(update, update.bookId);
    await tx.objectStore("settings").put(backup.preferences, "preferences");
    if (backup.brief)
      await tx.objectStore("settings").put(backup.brief, "brief");
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* it may have already aborted */
    }
    await tx.done.catch(() => {});
    throw error;
  }
  return backup.books.length;
}

export function downloadFile(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
