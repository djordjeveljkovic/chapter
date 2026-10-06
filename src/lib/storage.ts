import { openDB, type DBSchema } from "idb";
import {
  defaultBrief,
  defaultPreferences,
  type Book,
  type Brief,
  type Draft,
  type Preferences,
  type ReadingState,
  type UpdateStatus,
} from "./types";

interface ReaderDB extends DBSchema {
  books: { key: string; value: Book };
  drafts: { key: string; value: Draft };
  reading: { key: string; value: ReadingState };
  updates: { key: string; value: UpdateStatus };
  settings: { key: string; value: Preferences | Brief };
  credentials: { key: string; value: string };
}
export const db = () =>
  openDB<ReaderDB>("chapter-library", 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        for (const name of [
          "books",
          "drafts",
          "reading",
          "updates",
          "settings",
        ] as const)
          database.createObjectStore(name);
      }
      if (oldVersion < 2) database.createObjectStore("credentials");
    },
  });
export async function listBooks() {
  return (await db()).getAll("books");
}
export async function saveBook(book: Book, reading?: ReadingState) {
  const database = await db();
  const tx = database.transaction(["books", "drafts", "reading"], "readwrite");
  try {
    await tx.objectStore("books").put(book, book.id);
    if (reading) await tx.objectStore("reading").put(reading, book.id);
    await tx.objectStore("drafts").delete(book.id);
    await tx.done;
  } catch (error) {
    // A synchronous structured-clone failure need not abort IndexedDB itself.
    // Explicitly roll back so the edition and its reading state stay together.
    try {
      tx.abort();
    } catch {
      /* the transaction may have already aborted */
    }
    await tx.done.catch(() => {});
    throw error;
  }
}
export async function removeBook(id: string) {
  const database = await db();
  const tx = database.transaction(
    ["books", "drafts", "reading", "updates"],
    "readwrite",
  );
  for (const name of ["books", "drafts", "reading", "updates"] as const)
    await tx.objectStore(name).delete(id);
  await tx.done;
}
export async function loadReading(id: string): Promise<ReadingState> {
  return (
    (await (await db()).get("reading", id)) || {
      bookId: id,
      bookmarks: [],
      completed: [],
    }
  );
}
export async function saveReading(state: ReadingState) {
  await (await db()).put("reading", state, state.bookId);
}
export async function loadPreferences() {
  return {
    ...defaultPreferences,
    ...(await (await db()).get("settings", "preferences")),
  } as Preferences;
}
export async function savePreferences(prefs: Preferences) {
  await (await db()).put("settings", prefs, "preferences");
}
export async function loadBrief() {
  return {
    ...defaultBrief,
    ...(await (await db()).get("settings", "brief")),
  } as Brief;
}
export async function saveBrief(brief: Brief) {
  await (await db()).put("settings", brief, "brief");
}
export async function saveDraft(draft: Draft) {
  await (await db()).put("drafts", draft, draft.id);
}
export async function listDrafts() {
  return (await db()).getAll("drafts");
}
export async function loadDraft(id: string) {
  return (await db()).get("drafts", id);
}
export async function discardDraft(id: string) {
  await (await db()).delete("drafts", id);
}
export async function loadUpdates() {
  return (await db()).getAll("updates");
}
export async function saveUpdate(update: UpdateStatus) {
  await (await db()).put("updates", update, update.bookId);
}
export async function loadGitHubToken() {
  return (await (await db()).get("credentials", "github")) || "";
}
export async function saveGitHubToken(token: string) {
  await (await db()).put("credentials", token, "github");
}
export async function removeGitHubToken() {
  await (await db()).delete("credentials", "github");
}
