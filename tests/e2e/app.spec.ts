import { expect, test, type Page } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scaffoldFiles } from "../../src/lib/authoring";
import { defaultBrief } from "../../src/lib/types";

const commit1 = "a".repeat(40),
  commit2 = "b".repeat(40);
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/E9sAAAAASUVORK5CYII=";
function fixture() {
  const files: Record<string, string> = {
    "book/README.md":
      "# Field Notes on Learning\n\n- [Volume 1](volumes/01-foundations/README.md)",
    "book/volumes/01-foundations/README.md":
      "# Foundations\n\n- [First steps](001-first-steps.md)\n- [Going deeper](002-going-deeper.md)\n- [Putting it together](003-putting-it-together.md)",
  };
  for (let n = 1; n <= 3; n++) {
    const slug = ["first-steps", "going-deeper", "putting-it-together"][n - 1];
    files[
      `book/volumes/01-foundations/${String(n).padStart(3, "0")}-${slug}.md`
    ] =
      `---\nbook: Field Notes on Learning\nvolume: 1\nvolume_title: Foundations\nchapter: ${n}\ntitle: ${["First steps", "Going deeper", "Putting it together"][n - 1]}\nslug: ${slug}\nstatus: complete\n---\n\n# ${["First steps", "Going deeper", "Putting it together"][n - 1]}\n\n## A heading\n\n${Array.from({ length: 40 }, (_, i) => `Passage ${i}: Learning is a journey of thoughtful questions and practical experiments. Read slowly, test your assumptions, and connect the ideas to things you already understand. This paragraph helps us verify that your position stays with the text.`).join("\n\n")}\n\n![A local illustration](../../images/illustration.png)\n\n\`\`\`php\n${Array.from({ length: 85 }, (_, i) => `echo 'Example line ${i}';`).join("\n")}\n\`\`\`\n\n| Name | Explanation |\n| --- | --- |\n| Memory | A very long table cell to exercise phone layout and horizontal scrolling. |\n\n${n === 1 ? "[Next chapter](002-going-deeper.md#a-heading)" : "[Back to first steps](001-first-steps.md)"}\n\n<script>window.unsafeBookScript = true</script>\n`;
  }
  return files;
}
async function mockGitHub(page: Page, files = fixture()) {
  let latest = commit1;
  let failRaw = "";
  let failLatest = false;
  let rawDelay = 0;
  const requests: string[] = [];
  const tree = Object.entries(files).map(([path, text]) => ({
    path,
    type: "blob",
    sha: "c".repeat(40),
    size: Buffer.byteLength(text),
  }));
  tree.push({
    path: "book/images/illustration.png",
    type: "blob",
    sha: "d".repeat(40),
    size: Buffer.from(image, "base64").length,
  });
  await page.route("https://api.github.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.includes("/commits/"))
      return route.fulfill({
        status: failLatest ? 403 : 200,
        json: failLatest ? { message: "rate limited" } : { sha: latest },
      });
    if (path.includes("/git/trees/"))
      return route.fulfill({
        json: {
          sha: latest,
          tree: tree.map((entry) => ({
            ...entry,
            sha: path.includes(commit1) ? entry.sha : "e".repeat(40),
          })),
          truncated: false,
        },
      });
    return route.fulfill({
      json: {
        default_branch: "main",
        description: "A reference fixture for offline reading.",
        private: false,
      },
    });
  });
  await page.route("https://raw.githubusercontent.com/**", async (route) => {
    const parts = new URL(route.request().url()).pathname
      .split("/")
      .filter(Boolean);
    const path = parts.slice(3).map(decodeURIComponent).join("/");
    requests.push(path);
    if (rawDelay) await new Promise((resolve) => setTimeout(resolve, rawDelay));
    if (path === failRaw)
      return route.fulfill({ status: 503, body: "temporary failure" });
    if (path.endsWith(".png"))
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(image, "base64"),
      });
    if (!(path in files)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: "text/plain", body: files[path] });
  });
  return {
    setLatest: (value: string) => {
      latest = value;
    },
    failFile: (path: string) => {
      failRaw = path;
    },
    failCheck: (value: boolean) => {
      failLatest = value;
    },
    delay: (ms: number) => {
      rawDelay = ms;
    },
    requests,
    files,
  };
}
async function importFixture(page: Page) {
  await page.getByRole("button", { name: "Add a book", exact: true }).click();
  await page
    .getByRole("textbox", { name: "GitHub repository URL" })
    .fill("https://github.com/example/learning-book");
  await page.getByRole("button", { name: "Preview book" }).click();
  await expect(page.getByRole("dialog")).toContainText("3 chapters");
  await page
    .getByRole("button", { name: "Download for offline reading" })
    .click();
  await expect(
    page.getByRole("button", { name: "Start reading" }),
  ).toBeVisible();
}
async function storedBooks(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chapter-library");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<unknown[]>((resolve, reject) => {
      const request = database
        .transaction("books")
        .objectStore("books")
        .getAll();
      request.onsuccess = () => {
        resolve(request.result);
        database.close();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

test("phone library imports a complete snapshot and reopens its reader offline", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockGitHub(page);
  await page.goto("/");
  await expect(page.getByText("Offline app ready")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "A little space for big ideas." }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "/tmp/chapter-mobile-library.png",
    fullPage: true,
  });
  await importFixture(page);
  const books = (await storedBooks(page)) as {
    commit: string;
    assets: unknown[];
    chapters: unknown[];
  }[];
  expect(books[0].commit).toBe(commit1);
  expect(books[0].chapters).toHaveLength(3);
  expect(books[0].assets).toHaveLength(1);
  await page.getByRole("button", { name: "Start reading" }).click();
  await expect(page.locator(".book-content")).toContainText("Passage 0");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { unsafeBookScript?: boolean }).unsafeBookScript,
    ),
  ).toBeUndefined();
  await page.locator(".reading-frame").evaluate((element) => {
    element.scrollTop = 2600;
  });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Bookmark this passage" }).click();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await page.getByRole("button", { name: "Search book", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search book text" })
    .fill("Passage 25");
  await expect(page.locator(".search-results button")).toHaveCount(3);
  await page.locator(".search-results button").nth(1).click();
  await expect(page.locator(".reader-book-title small")).toContainText(
    "Chapter 2",
  );
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".reader-book-title small")).toContainText(
    "Chapter 2",
  );
  await expect(
    page.getByText("You're offline. Your saved books are here."),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.locator(".reading-frame").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(2000);
  await page.getByRole("button", { name: "View bookmarks" }).click();
  await expect(page.locator(".bookmark-item")).toHaveCount(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close reader panel" })
    .click();
  await page.getByRole("button", { name: "Back to library" }).click();
  await expect(
    page.getByRole("button", { name: "Continue reading" }),
  ).toBeVisible();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(
    reopened.getByRole("button", { name: "Continue reading" }),
  ).toBeVisible();
  await reopened.getByRole("button", { name: "Continue reading" }).click();
  await expect(reopened.locator(".reader-book-title small")).toContainText(
    "Chapter 2",
  );
  await expect
    .poll(() =>
      reopened
        .locator(".reading-frame")
        .evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(2000);
  expect(errors).toEqual([]);
});

test("paged mode preserves passage across typography, rotation, and mode changes", async ({
  page,
}) => {
  await mockGitHub(page);
  await page.goto("/");
  await expect(page.getByText("Offline app ready")).toBeVisible();
  await importFixture(page);
  await page.getByRole("button", { name: "Start reading" }).click();
  await page.getByRole("button", { name: "Reading settings" }).click();
  await expect(
    page.getByRole("dialog", { name: "settings panel" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close reader panel" })
    .click();
  await expect(page.locator(".reader")).toHaveClass(/mode-pages/);
  await expect
    .poll(() =>
      page
        .locator(".book-content pre")
        .first()
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page
        .locator(".table-frame")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
  for (let i = 0; i < 4; i++)
    await page.getByRole("button", { name: "Next page or chapter" }).click();
  await expect(page.locator(".chapter-navigation span")).toContainText("5 /");
  const before = await page.locator(".book-content").evaluate((element) => {
    const frame = element.parentElement!.getBoundingClientRect();
    return Array.from(element.children).find((child) =>
      Array.from(child.getClientRects()).some(
        (rect) =>
          rect.right > frame.left + 25 &&
          rect.left < frame.right &&
          rect.bottom > frame.top &&
          rect.top < frame.bottom,
      ),
    )?.textContent;
  });
  await page.getByRole("button", { name: "Reading settings" }).click();
  await expect(
    page.getByRole("dialog", { name: "settings panel" }),
  ).toBeVisible();
  await page.getByRole("slider", { name: "Font size" }).fill("24");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close reader panel" })
    .click();
  await page.setViewportSize({ width: 852, height: 393 });
  await page.waitForTimeout(400);
  await expect(page.locator(".reader-book-title small")).toContainText(
    "Chapter 1",
  );
  await page.setViewportSize({ width: 393, height: 852 });
  await expect
    .poll(() =>
      page.locator(".reading-frame").evaluate((element) => element.clientWidth),
    )
    .toBe(353);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.getByRole("button", { name: "Reading settings" }).click();
  await expect(
    page.getByRole("dialog", { name: "settings panel" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Scroll", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close reader panel" })
    .click();
  await expect
    .poll(() =>
      page.locator(".reading-frame").evaluate((element) => element.scrollTop),
    )
    .toBeGreaterThan(100);
  expect(before).toBeTruthy();
  await page.screenshot({ path: "/tmp/chapter-mobile-reader.png" });
});

test("update indicator compares commits and failed downloads preserve old edition", async ({
  page,
}) => {
  const github = await mockGitHub(page);
  await page.goto("/");
  await expect(page.getByText("Offline app ready")).toBeVisible();
  await importFixture(page);
  await page.getByRole("button", { name: "Start reading" }).click();
  await page.getByRole("button", { name: "Bookmark this passage" }).click();
  await page
    .getByRole("button", { name: "Add passage note", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Note text" })
    .fill("Keep this thought across book updates.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await page.getByRole("button", { name: "Back to library" }).click();
  github.setLatest(commit2);
  await page
    .getByRole("button", { name: "Manage Field Notes on Learning" })
    .click();
  await page.getByRole("button", { name: "Check updates" }).click();
  await expect(page.getByRole("dialog")).toContainText("Update available");
  await expect(page.getByRole("dialog")).toContainText("aaaaaaa");
  await expect(page.getByRole("dialog")).toContainText("bbbbbbb");
  github.failFile("book/volumes/01-foundations/001-first-steps.md");
  await page.getByRole("button", { name: "Update book", exact: true }).click();
  await page.getByRole("button", { name: "Download updated edition" }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  expect(((await storedBooks(page)) as { commit: string }[])[0].commit).toBe(
    commit1,
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await page
    .getByRole("button", { name: "Manage Field Notes on Learning" })
    .click();
  github.failCheck(true);
  await page.getByRole("button", { name: "Check updates" }).click();
  await expect(page.getByRole("dialog")).toContainText("Last check failed");
  await expect(page.getByRole("dialog")).toContainText("bbbbbbb");
  github.failCheck(false);
  github.failFile("");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("button", { name: "Download updated edition" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Continue reading" }),
  ).toBeVisible();
  await expect
    .poll(
      async () => ((await storedBooks(page)) as { commit: string }[])[0].commit,
    )
    .toBe(commit2);
  await page.getByRole("button", { name: "Continue reading" }).click();
  await expect(
    page.getByRole("button", { name: "Completed", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View bookmarks" }).click();
  await expect(page.locator(".bookmark-item")).toHaveCount(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close reader panel" })
    .click();
  await page.getByRole("button", { name: "View passage notes" }).click();
  await expect(page.locator(".note-item")).toContainText(
    "Keep this thought across book updates.",
  );
  await page
    .getByRole("button", {
      name: "Read passage for note: Keep this thought across book updates.",
    })
    .click();
  await expect(page.locator(".reader-drawer")).toBeHidden();
});

test("authoring prompts, ZIP, GitHub validation, and backup round trip", async ({
  page,
}) => {
  await mockGitHub(page);
  await page.goto("/");
  await expect(page.getByText("Offline app ready")).toBeVisible();
  await importFixture(page);
  await page.getByRole("link", { name: "Create a book", exact: true }).click();
  await page
    .getByRole("textbox", { name: "What do you want to explore?" })
    .fill("Urban gardening");
  await expect(
    page.getByRole("textbox", { name: "Outline prompt" }),
  ).toHaveValue(/Urban gardening/);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download repository template" })
    .click();
  expect((await download).suggestedFilename()).toBe(
    "urban-gardening-book-template.zip",
  );
  await page.getByRole("tab", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Continue prompt" }),
  ).toHaveValue(/Exact Next Section/);
  await page
    .getByRole("textbox", { name: "GitHub repository URL" })
    .fill("https://github.com/example/learning-book");
  await page.getByRole("button", { name: "Validate GitHub book" }).click();
  await expect(page.locator(".validation-result")).toContainText(
    "Ready to import",
  );
  await page.getByRole("button", { name: "Library settings" }).click();
  const exportEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const exported = await exportEvent;
  const path = await exported.path();
  const backup = JSON.parse(readFileSync(path!, "utf8"));
  expect(backup.books).toHaveLength(1);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("link", { name: "My library", exact: true }).click();
  await page
    .getByRole("button", { name: "Manage Field Notes on Learning" })
    .click();
  await page
    .getByRole("button", { name: "Remove book from this device" })
    .click();
  await page.getByRole("button", { name: "Remove book", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your next chapter starts here." }),
  ).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await page
    .getByRole("button", { name: "Restore backup", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start reading" }),
  ).toBeVisible();
});

test("generated scaffold can be validated through the same GitHub flow", async ({
  page,
}) => {
  await mockGitHub(
    page,
    scaffoldFiles({ ...defaultBrief, topic: "Botany", chapters: 10 }),
  );
  await page.goto("/#create");
  await page
    .getByRole("textbox", { name: "GitHub repository URL" })
    .fill("https://github.com/example/botany");
  await page.getByRole("button", { name: "Validate GitHub book" }).click();
  await expect(page.locator(".validation-result")).toContainText(
    "10 chapters across 2 volumes. Ready to import.",
  );
});

test("library and authoring stay readable on phone, tablet, and desktop", async ({
  page,
}) => {
  await mockGitHub(page);
  await page.goto("/");
  await expect(page.getByText("Offline app ready")).toBeVisible();
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await expect(page.locator(".sample-section h3")).toBeVisible();
    if (width === 360) {
      expect(
        await page
          .locator(".sample-section h3")
          .evaluate((element) => element.getBoundingClientRect().width),
      ).toBeGreaterThan(190);
      await page.screenshot({
        path: "/tmp/chapter-mobile-library.png",
        fullPage: true,
      });
    }
    if (width === 1440)
      await page.screenshot({
        path: "/tmp/chapter-desktop-library.png",
        fullPage: true,
      });
  }
  await page.getByRole("link", { name: "Create a book", exact: true }).click();
  await page.setViewportSize({ width: 360, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "/tmp/chapter-mobile-authoring.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Library settings" }).click();
  await page.getByRole("button", { name: "Night", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.screenshot({
    path: "/tmp/chapter-mobile-night.png",
    fullPage: true,
  });
});

test("actual PHP reference repository imports 308 ordered chapters", async ({
  page,
}) => {
  const directory = process.env.BOOK_REFERENCE_DIR;
  test.skip(
    !directory,
    "Set BOOK_REFERENCE_DIR to a checkout of the reference PHP book.",
  );
  const files: Record<string, string> = {};
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md"))
        files[relative(directory!, path)] = readFileSync(path, "utf8");
    }
  }
  walk(directory!);
  await mockGitHub(page, files);
  await page.goto("/");
  await expect(page.getByText("Offline app ready")).toBeVisible();
  await page.getByRole("button", { name: "Try this book" }).click();
  await page.getByRole("button", { name: "Preview book" }).click();
  await expect(page.getByRole("dialog")).toContainText("308 chapters");
  await page
    .getByRole("button", { name: "Download for offline reading" })
    .click();
  await expect(page.getByRole("button", { name: "Start reading" })).toBeVisible(
    { timeout: 60000 },
  );
  const books = (await storedBooks(page)) as {
    chapters: { number: number; volume: number; path: string }[];
  }[];
  expect(books[0].chapters).toHaveLength(308);
  expect(books[0].chapters[0].number).toBe(1);
  expect(books[0].chapters.at(-1)!.number).toBe(308);
  expect(new Set(books[0].chapters.map((c) => c.volume)).size).toBe(21);
  expect(books[0].chapters.some((c) => c.path.includes("_ai"))).toBe(false);
});
