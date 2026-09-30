import { expect, test, type Page, type Locator } from "@playwright/test";
import type {
  Book,
  Location,
  Preferences,
  ReadingState,
} from "../../src/lib/types";
import { defaultPreferences } from "../../src/lib/types";
import { parseChapter } from "../../src/lib/format";

const bookId = "reader-audit";
const book: Book = {
  id: bookId,
  source: { owner: "fixture", repo: "reader", branch: "main", root: "book" },
  title: "Reader audit",
  description: "An offline behavior fixture",
  commit: "a".repeat(40),
  chapters: [1, 2].map((number) =>
    parseChapter(
      `book/volumes/01-audit/00${number}-chapter.md`,
      `---\nvolume: 1\nchapter: ${number}\ntitle: Audit chapter ${number}\nslug: audit-${number}\n---\n# Audit chapter ${number}\n\n[Internal destination](00${number === 1 ? 2 : 1}-chapter.md#anchor-destination)\n\n${Array.from({ length: 35 }, (_, i) => `Passage ${number}.${i} — Distinctive marker ${number}-${i}. Reading rewards careful attention to the details of a sentence. We keep this paragraph long enough to span several lines at phone widths, so restoring a text offset differs from restoring a pixel position. Each measured page should keep the passage visible through many changes in layout.`).join("\n\n")}\n\n## Anchor destination\n\nDestination passage in chapter ${number}.\n\n\`\`\`php\n${Array.from({ length: 65 }, (_, i) => `$codeMarker${i} = "${"wide-code ".repeat(25)}";`).join("\n")}\n\`\`\`\n\n| TableMarker | Very wide unbreakable column |\n| --- | --- |\n${Array.from({ length: 35 }, (_, i) => `| Row ${i} | ${"longtablecell".repeat(12)} |`).join("\n")}\n\n~~struck~~ and **strong**\n\n![external picture](https://example.invalid/tracker.png)\n\n<script>window.readerUnsafe = true</script>\n\n[Malformed fragment](#%ZZ)\n`,
    ),
  ),
  documents: {},
  assets: [],
  issues: [],
  downloadedAt: new Date().toISOString(),
  bytes: 1000,
};
const orphan: Location = {
  chapterId: "removed",
  path: "book/removed.md",
  block: 0,
  offset: 0,
  quote: "A retained removed passage",
};

async function start(page: Page, mode: Preferences["mode"] = "scroll") {
  await page.goto("/");
  await expect(page.getByText("Offline app ready")).toBeVisible();
  await page.evaluate(
    async ({ book, prefs, orphan }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("chapter-library");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction(
        ["books", "settings", "reading"],
        "readwrite",
      );
      transaction.objectStore("books").put(book, book.id);
      transaction.objectStore("settings").put(prefs, "preferences");
      transaction
        .objectStore("reading")
        .put(
          {
            bookId: book.id,
            completed: [],
            bookmarks: [
              {
                id: "orphan",
                location: orphan,
                label: orphan.quote,
                createdAt: new Date().toISOString(),
              },
            ],
          },
          book.id,
        );
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    },
    { book, prefs: { ...defaultPreferences, mode }, orphan },
  );
  await page.goto(`/#read/${bookId}/audit-1`);
  await page.reload();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.locator(".book-content")).toContainText("Passage 1.0");
}
async function state(page: Page): Promise<ReadingState> {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("chapter-library");
      request.onsuccess = () => resolve(request.result);
    });
    return await new Promise<ReadingState>((resolve) => {
      const request = database
        .transaction("reading")
        .objectStore("reading")
        .get(id);
      request.onsuccess = () => {
        database.close();
        resolve(request.result);
      };
    });
  }, bookId);
}
async function search(page: Page, query: string) {
  await page.getByRole("button", { name: "Search book", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search book text" }).fill(query);
  await expect(page.locator(".search-results button")).toHaveCount(
    book.chapters.filter((chapter) =>
      chapter.plainText.toLowerCase().includes(query.toLowerCase()),
    ).length,
  );
  await page.locator(".search-results button").first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(100);
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "Reading settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function close(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close reader panel" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(100);
}
async function passageVisible(page: Page, location: Location) {
  return page.locator(".book-content").evaluate((root, location) => {
    const frame = root.parentElement!.getBoundingClientRect();
    const block = Array.from(root.children).find((child) =>
      child.textContent?.includes(location.quote),
    );
    if (!block) return false;
    let remaining = block.textContent!.indexOf(location.quote);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let text: Node | null;
    while ((text = walker.nextNode())) {
      if (remaining < text.textContent!.length) {
        const range = document.createRange();
        range.setStart(text, remaining);
        range.setEnd(text, Math.min(text.textContent!.length, remaining + 8));
        return Array.from(range.getClientRects()).some(
          (rect) =>
            rect.right > frame.left &&
            rect.left < frame.right &&
            rect.bottom > frame.top &&
            rect.top < frame.bottom,
        );
      }
      remaining -= text.textContent!.length;
    }
    return false;
  }, location);
}

for (const mode of ["scroll", "pages"] as const) {
  test(`${mode} keeps the exact bookmarked passage through typography, rotation, width, mode switches and offline resume`, async ({
    page,
    context,
  }) => {
    await start(page, mode);
    await search(page, "Distinctive marker 1-18");
    await page.getByRole("button", { name: "Bookmark this passage" }).click();
    await expect.poll(async () => (await state(page)).bookmarks.length).toBe(2);
    const anchor = (await state(page)).bookmarks[1].location;
    expect(anchor.quote).toContain("Distinctive marker 1-18");
    const visible = () =>
      expect.poll(() => passageVisible(page, anchor)).toBe(true);
    await visible();
    await settings(page);
    await page.getByRole("slider", { name: "Font size" }).fill("27");
    await page.getByRole("slider", { name: "Line spacing" }).fill("2.3");
    await page.getByRole("button", { name: "Sans serif", exact: true }).click();
    await close(page);
    await visible();
    for (const viewport of [
      { width: 852, height: 393 },
      { width: 393, height: 852 },
      { width: 1200, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(150);
      await visible();
    }
    await settings(page);
    await page.getByRole("slider", { name: "Reading width" }).fill("480");
    await close(page);
    await visible();
    await settings(page);
    await page.getByRole("slider", { name: "Reading width" }).fill("960");
    await close(page);
    await visible();
    for (const nextMode of [
      "Pages",
      "Scroll",
      mode === "pages" ? "Pages" : "Scroll",
    ]) {
      await settings(page);
      await page.getByRole("button", { name: nextMode, exact: true }).click();
      await close(page);
      await visible();
    }
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator(".reader-loading")).toHaveCount(0);
    await visible();
    await page.getByRole("button", { name: "Back to library" }).click();
    await page
      .getByRole("button", { name: "Continue reading", exact: true })
      .click();
    await visible();
    expect((await state(page)).location?.path).toBe(book.chapters[0].path);
  });
}

test("offline contents, internal anchors, search, completion, bookmark relocation and accessibility states work", async ({
  page,
  context,
}) => {
  await start(page);
  await context.setOffline(true);
  expect(
    await page.evaluate(
      () => (window as unknown as { readerUnsafe?: boolean }).readerUnsafe,
    ),
  ).toBeUndefined();
  await expect(page.locator(".book-content .raw-markup")).toContainText(
    "<script>",
  );
  await expect(page.locator(".book-content img")).toHaveCount(0);
  await expect(page.locator(".media-missing")).toContainText(
    "unavailable offline",
  );
  await expect(page.locator(".book-content del")).toHaveText("struck");
  await expect(
    page.locator(".book-content .hljs-variable").first(),
  ).toBeAttached();
  await page.getByRole("button", { name: "Table of contents" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "0 of 2 chapters completed",
  );
  await expect(
    page.locator('.toc-chapter[aria-current="location"]'),
  ).toContainText("Audit chapter 1");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Table of contents" }),
  ).toBeFocused();
  await page.locator('a[data-book-hash="anchor-destination"]').click();
  await expect(page.locator(".reader-book-title small")).toContainText(
    "Chapter 2",
  );
  await expect
    .poll(() =>
      page.locator("#anchor-destination").evaluate((element) => {
        const bounds = element.getBoundingClientRect(),
          frame = element.closest(".reading-frame")!.getBoundingClientRect();
        return bounds.top >= frame.top - 1 && bounds.top < frame.bottom;
      }),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(
    page.getByRole("button", { name: "Completed", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await search(page, "Distinctive marker 2-24");
  await page.getByRole("button", { name: "Bookmark this passage" }).click();
  await expect.poll(async () => (await state(page)).bookmarks.length).toBe(2);
  const mark = (await state(page)).bookmarks[1];
  await search(page, "Distinctive marker 1-5");
  await page.getByRole("button", { name: "View bookmarks" }).click();
  await expect(
    page.locator(".bookmark-item").first().getByRole("button").first(),
  ).toBeDisabled();
  await expect(page.locator(".bookmark-item").first()).toContainText(
    "Chapter removed from this edition",
  );
  await page
    .locator(".bookmark-item")
    .nth(1)
    .getByRole("button")
    .first()
    .click();
  await expect.poll(() => passageVisible(page, mark.location)).toBe(true);
  await settings(page);
  for (const [name, theme] of [
    ["Night", "dark"],
    ["Paper", "sepia"],
    ["Day", "light"],
  ] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(await page.locator("html").getAttribute("data-theme")).toBe(theme);
  }
  await page.getByRole("slider", { name: "Reading width" }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Close reader panel" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("slider", { name: "Reading width" }),
  ).toBeFocused();
  await close(page);
  // A malformed fragment is inert and cannot crash chapter navigation.
  await page
    .locator('a[data-book-hash="%ZZ"]')
    .evaluate((element: HTMLElement) => element.click());
  await expect(page.locator(".reader-book-title small")).toContainText(
    "Chapter 2",
  );
  await page.getByRole("button", { name: "Table of contents" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "1 of 2 chapters completed",
  );
});

async function swipe(page: Page, locator: Locator, axis: "x" | "y") {
  const rect = await locator.boundingBox();
  expect(rect).toBeTruthy();
  const x = rect!.x + Math.min(250, rect!.width - 20),
    y = rect!.y + Math.min(190, rect!.height - 20);
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 6; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: x - (axis === "x" ? step * 25 : 0),
          y: y - (axis === "y" ? step * 25 : 0),
        },
      ],
    });
    await page.waitForTimeout(16);
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
  await page.waitForTimeout(100);
}
test("paged code and tables scroll independently, touch and keyboard turn only reader pages, reduced motion retains usable controls", async ({
  page,
}) => {
  await start(page, "pages");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await search(page, "$codeMarker0");
  const pre = page.locator(".code-frame pre");
  const pageBefore = await page.locator(".chapter-navigation span").innerText();
  expect(
    await pre.evaluate(
      (element) =>
        element.scrollWidth > element.clientWidth &&
        element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await pre.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".chapter-navigation span")).toHaveText(pageBefore);
  await swipe(page, pre, "x");
  await expect
    .poll(() => pre.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(page.locator(".chapter-navigation span")).toHaveText(pageBefore);
  await swipe(page, pre, "y");
  await expect
    .poll(() => pre.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.locator(".chapter-navigation span")).toHaveText(pageBefore);
  await search(page, "TableMarker");
  const table = page.locator(".table-frame"),
    tablePage = await page.locator(".chapter-navigation span").innerText();
  expect(
    await table.evaluate(
      (element) =>
        element.scrollWidth > element.clientWidth &&
        element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await swipe(page, table, "x");
  await expect
    .poll(() => table.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(page.locator(".chapter-navigation span")).toHaveText(tablePage);
  await search(page, "Distinctive marker 1-10");
  const frame = page.locator(".reading-frame");
  await frame.focus();
  const before = await page.locator(".chapter-navigation span").innerText();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".chapter-navigation span")).not.toHaveText(before);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".chapter-navigation span")).toHaveText(before);
  await swipe(page, frame, "x");
  await expect(page.locator(".chapter-navigation span")).not.toHaveText(before);
  expect(
    await page.locator(".reader-footer").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom <= window.innerHeight && rect.top >= 0;
    }),
  ).toBe(true);
  expect(
    await page
      .getByRole("button", { name: "Reading settings" })
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
});

async function selectPhrase(page: Page, phrase: string) {
  await page
    .locator(".book-content p")
    .filter({ hasText: phrase })
    .evaluate((element, phrase) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text: Node | null;
      while ((text = walker.nextNode())) {
        const offset = text.textContent!.indexOf(phrase);
        if (offset >= 0) {
          const range = document.createRange();
          range.setStart(text, offset);
          range.setEnd(text, offset + phrase.length);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
      }
      throw new Error("Selection phrase missing");
    }, phrase);
}
test("selected passage bookmarks and notes save, reopen, return to exact text, edit and delete offline", async ({
  page,
  context,
}) => {
  await start(page);
  await search(page, "Distinctive marker 2-22");
  const phrase = "Distinctive marker 2-22";
  await selectPhrase(page, phrase);
  await page.getByRole("button", { name: "Bookmark this passage" }).click();
  await expect.poll(async () => (await state(page)).bookmarks.length).toBe(2);
  const mark = (await state(page)).bookmarks[1];
  expect(mark.location.quote).toBe(phrase);
  expect(mark.location.offset).toBeGreaterThan(0);
  await selectPhrase(page, phrase);
  await page
    .getByRole("button", { name: "Add passage note", exact: true })
    .click();
  await page.screenshot({ path: "/tmp/chapter-reader-note-editor.png" });
  await expect(page.getByRole("dialog")).toContainText(phrase);
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Save note", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Note text" })
    .fill("Remember to try this idea in my project.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await state(page)).notes?.length).toBe(1);
  const note = (await state(page)).notes![0];
  expect(note.location.quote).toBe(phrase);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await search(page, "Distinctive marker 1-4");
  await page.getByRole("button", { name: "View bookmarks" }).click();
  await page
    .locator(".bookmark-item")
    .nth(1)
    .getByRole("button")
    .first()
    .click();
  await expect.poll(() => passageVisible(page, mark.location)).toBe(true);
  await search(page, "Distinctive marker 1-6");
  await page
    .getByRole("button", { name: "View passage notes", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Read passage for note: Remember to try this idea in my project.",
      exact: true,
    })
    .click();
  await expect(page.locator(".reader-book-title small")).toContainText(
    "Chapter 2",
  );
  await expect.poll(() => passageVisible(page, note.location)).toBe(true);
  await page
    .getByRole("button", { name: "View passage notes", exact: true })
    .click();
  await page.screenshot({ path: "/tmp/chapter-reader-note-list.png" });
  await page
    .getByRole("button", {
      name: "Edit note: Remember to try this idea in my project.",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Note text" })
    .fill("Updated thought after rereading.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(async () => (await state(page)).notes?.[0].text)
    .toBe("Updated thought after rereading.");
  expect((await state(page)).notes![0].id).toBe(note.id);
  await page.reload();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await page
    .getByRole("button", { name: "View passage notes", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Delete note: Updated thought after rereading.",
      exact: true,
    })
    .click();
  await expect(page.locator(".note-item")).toHaveCount(0);
  await expect.poll(async () => (await state(page)).notes?.length).toBe(0);
  await page.reload();
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await page
    .getByRole("button", { name: "View passage notes", exact: true })
    .click();
  await expect(page.locator(".note-item")).toHaveCount(0);
});
