import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  frontMatter,
  headingSlug,
  markdownLinks,
  parseChapter,
  parseRepoUrl,
  resolvePath,
  validateDocuments,
} from "../../src/lib/format";
import { scaffoldFiles, scaffoldZip, promptFor } from "../../src/lib/authoring";
import { defaultBrief } from "../../src/lib/types";
import { strFromU8, unzipSync } from "fflate";

const chapter = (title: string, slug = title) =>
  `---\nvolume: 1\nvolume_title: One\nchapter: 1\ntitle: ${title}\nslug: ${slug}\n---\n# ${title}\n`;
const validate = (documents: Record<string, string>) =>
  validateDocuments(
    documents,
    Object.keys(documents).map((path) => ({ path, type: "blob", sha: "abc" })),
    "book",
  );

describe("compatible Markdown books", () => {
  it("parses a real source PHP chapter and removes authoring metadata", () => {
    const text = readFileSync(
      new URL("./fixtures/php-chapter.md", import.meta.url),
      "utf8",
    );
    const parsed = parseChapter(
      "book/volumes/01-the-php-mental-model/001-what-php-actually-is.md",
      text,
      "abc",
    );
    expect(parsed).toMatchObject({
      id: "what-php-actually-is",
      volume: 1,
      number: 1,
      title: "What PHP Actually Is",
      status: "complete",
      blobSha: "abc",
    });
    expect(parsed.markdown).toContain("## Why This Matters");
    expect(parsed.markdown).not.toContain("summary:");
  });
  it("normalizes BOM and CRLF front matter and rejects non-mappings", () => {
    expect(frontMatter("\ufeff---\r\ntitle: Book\r\n---\r\n# Body")).toEqual({
      meta: { title: "Book" },
      body: "# Body",
    });
    expect(() => frontMatter("---\n- item\n---\n# Body")).toThrow("mapping");
  });
  it("returns malformed YAML as validation findings instead of throwing", () => {
    const report = validate({
      "book/README.md": "# Book",
      "book/volumes/01-one/001-one.md": "---\ntitle: [\n---\n# Broken",
    }).report;
    expect(report.issues.some((i) => i.severity === "error")).toBe(true);
  });
  it("sorts numeric volumes and chapters and supports repeated slugs across volumes", () => {
    const documents = {
      "book/README.md": "# Book",
      "book/volumes/10-ten/010-same.md": "---\nslug: same\n---\n# Ten",
      "book/volumes/02-two/002-same.md": "---\nslug: same\n---\n# Two",
    };
    const parsed = validate(documents);
    expect(parsed.chapters.map((c) => [c.volume, c.number, c.id])).toEqual([
      [2, 2, "2:same"],
      [10, 10, "10:same"],
    ]);
    expect(parsed.report.issues.every((i) => i.severity === "warning")).toBe(
      true,
    );
  });
  it("rejects duplicate slugs within a volume, duplicate numbers and nonnumeric metadata", () => {
    const parsed = validate({
      "book/README.md": "# Book",
      "book/volumes/01-one/001-one.md": chapter("First", "same"),
      "book/volumes/01-one/002-two.md": chapter("Second", "same").replace(
        "chapter: 1",
        "chapter: 2",
      ),
    });
    expect(
      parsed.report.issues.some((i) =>
        i.message.includes("Duplicate chapter identity"),
      ),
    ).toBe(true);
    expect(() =>
      parseChapter(
        "book/volumes/01-one/001-one.md",
        chapter("First").replace("volume: 1", "volume: true"),
      ),
    ).toThrow("positive integers");
    expect(
      validate({
        "book/README.md": "# Book",
        "book/volumes/01-one/001-one.md": chapter("First"),
        "book/volumes/01-one/002-two.md": chapter("Second"),
      }).report.issues.some((i) =>
        i.message.includes("Duplicate chapter number"),
      ),
    ).toBe(true);
  });
  it("walks reference links, nested lists and table cells, ignoring code", () => {
    const links = markdownLinks(
      "| Col |\n| --- |\n| [table](table.md) |\n\n- [list](list.md)\n\n![img][picture]\n\n[picture]: image.png\n\n`[code](missing.md)`",
    );
    expect(links).toEqual(
      expect.arrayContaining([
        { href: "table.md", image: false },
        { href: "list.md", image: false },
        { href: "image.png", image: true },
      ]),
    );
    expect(links).toHaveLength(3);
  });
  it("validates duplicate heading anchors, encoded paths, and directory indexes", () => {
    const parsed = validate({
      "book/README.md":
        "# Book\n[volume](volumes/01-one/)\n[anchor](volumes/01-one/001-one.md#hello-1)",
      "book/volumes/01-one/README.md": "# Volume\n[chapter](001-one.md)",
      "book/volumes/01-one/001-one.md": "# First\n## Hello\n## Hello",
    });
    expect(parsed.report.issues).toEqual([]);
    expect(
      resolvePath(
        "book/volumes/01-one/a.md",
        "../../images/my%20image.png#part",
      ),
    ).toEqual({ path: "book/images/my image.png", hash: "part" });
    expect(resolvePath("book/a.md", "../../escape.md")).toBeNull();
    expect(
      resolvePath("book/a.md", "https://example.com/image.png"),
    ).toBeNull();
  });
  it("reports broken links and offline external image warnings", () => {
    const parsed = validate({
      "book/README.md": "# Book",
      "book/volumes/01-one/001-one.md":
        "# First\n[missing](missing.md)\n![external](https://example.com/p.png)",
    });
    expect(parsed.report.issues.map((i) => i.severity)).toEqual([
      "error",
      "warning",
    ]);
  });
  it("keeps identity stable when another volume later reuses its slug", () => {
    const documents = {
      "book/README.md": "# Book",
      "book/volumes/01-one/001-shared.md": "---\nslug: shared\n---\n# First",
    };
    const first = validate(documents).chapters[0];
    const updated = validate({
      ...documents,
      "book/volumes/02-two/001-shared.md": "---\nslug: shared\n---\n# Second",
    });
    expect(first.id).toBe("1:shared");
    expect(updated.chapters[0].id).toBe(first.id);
    expect(
      headingSlug("A [linked title](https://example.com) and **bold** `code`"),
    ).toBe("a-linked-title-and-bold-code");
  });
});

describe("repository URL and authoring", () => {
  it("accepts canonical GitHub URLs and rejects ambiguous or unsafe locations", () => {
    expect(parseRepoUrl(" https://github.com/Owner/my.book.git/ ")).toEqual({
      owner: "Owner",
      repo: "my.book",
    });
    for (const url of [
      "http://github.com/a/b",
      "https://github.com/a/b/tree/main",
      "https://github.com.evil/a/b",
      "https://user@github.com/a/b",
      "https://github.com/a/%2e%2e",
    ])
      expect(() => parseRepoUrl(url)).toThrow();
  });
  it("creates a valid multi-volume scaffold and ZIP with continuation handoffs", () => {
    const brief = {
      ...defaultBrief,
      topic: "PHP: practical engineering",
      chapters: 17,
    };
    const files = scaffoldFiles(brief);
    const parsed = validate(files);
    expect(parsed.report.chapters).toBe(17);
    expect(parsed.report.volumes).toBe(3);
    expect(parsed.report.issues.filter((i) => i.severity === "error")).toEqual(
      [],
    );
    const zip = unzipSync(scaffoldZip(brief));
    expect(strFromU8(zip["book/README.md"])).toEqual(files["book/README.md"]);
    expect(files["book/_ai/CONTINUATION_STATE.md"]).toContain(
      "Exact Next Section",
    );
    expect(promptFor(brief, "Continue")).toContain(
      "without restarting or duplicating",
    );
  });
});
