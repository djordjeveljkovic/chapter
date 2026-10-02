# Chapter

A quiet, mobile-first library for Markdown books on GitHub. Import a public repository, download a complete edition, and read it offline. Built with Astro, TypeScript, and React. Uses Bun for dependency installation and project commands.

## Run locally

Requires Bun 1.4+ and Node 22.12+ (used by Astro's CLI).

```sh
bun install --frozen-lockfile
bun run dev
```

Open the URL printed by Astro. The development server saves books to IndexedDB, but does **not** register a service worker. To test the complete offline experience:

```sh
bun run build
bun run preview
```

Open the production preview while online and wait for **Offline app ready**. Import a book and wait for **Ready offline**, then turn off connectivity and reopen the site. Service workers require HTTPS on a deployed site; localhost works for development. On Android Chrome, use the browser menu's **Install app** or **Add to home screen** option.

## What is included

- Public GitHub import with a branch choice, preview, commit-pinned downloads, metadata/link checks, local images, download pause/resume, and staged updates.
- Whole-book offline reading, scroll and paged modes, themes, typography, chapter navigation, search, text-position resume, bookmarks, passage notes, and chapter completion.
- Update information showing the saved and latest checked GitHub commits, with the last successful check time. Automatic checks run at most once an hour per book; applying updates requires a user action.
- Versioned backup export/import, storage information, book removal, and an installable app shell.
- A saved book brief, seven customizable AI prompts, a repository-template ZIP, and public GitHub URL validation. The site does not call an AI service.

The sample is [The Complete Modern PHP Engineering Book](https://github.com/djordjeveljkovic/chatgpt-php-book): 308 chapters in 21 volumes. Its authoring files stay outside the reading contents.

To keep a passage, select its text and use the bookmark or note button in the reader header. Without a selection, the reader saves your current passage. The footer's bookmarks and notebook buttons open your saved entries; tap an entry to return to its text. Notes can be edited or deleted and are included in backups and book updates.

## Book format

```text
README.md
SKELETON.md
AI_AUTHORING_GUIDE.md
book/
  README.md
  volumes/
    01-foundations/
      README.md
      001-introduction.md
  images/
  _ai/
    CONTINUATION_STATE.md
    chapter-summaries/
```

Chapter example:

```md
---
book: My Book
volume: 1
volume_title: Foundations
chapter: 1
title: Introduction
slug: introduction
status: complete
summary: ../../_ai/chapter-summaries/001-introduction-summary.md
---

# Introduction

Book prose goes here.
```

Numeric metadata determines chapter ordering; numbered folders/files provide a fallback. Titles can fall back to a top-level heading. Slugs are unique within a volume; the reader qualifies stored identities by volume. Repeated slugs across volumes produce a note, while duplicate slugs within a volume block import. Links to missing chapters or heading anchors are warnings: available chapters can still be imported, even when the book is unfinished. The planned, draft, drafting, in-progress, and review statuses are also allowed with warnings. Invalid metadata, missing local images, and conflicting ordering block import.

Use Markdown links and repository-local images. Raw HTML is displayed as text; JavaScript and MDX are never executed. External images are shown as offline-unavailable placeholders. Source links outside the downloaded chapters are accessible through the repository link. The generated template contains planned placeholders, not finished book content; use the outline, writing, verification, and review prompts to complete it.

## Storage and architecture

Astro renders the application shell and `/format/` documentation. A browser-only React island handles the library, reader, and authoring workflow. Hash navigation keeps book/chapter URLs compatible with static hosts and offline reopening.

IndexedDB stores books, chapter Markdown, image data, reading state, update checks, preferences, authoring briefs, and paused downloads. Imports resolve one Git commit before reading files. Updated editions reuse unchanged chapter/image blobs, stage missing content, then atomically switch the book and migrated reading data after successful validation and offline-shell verification. Removed-chapter bookmarks remain visible.

The post-build script generates icons, a web manifest, and a service worker that precaches the compiled app, assets, and documentation. GitHub requests are not cached by the service worker. New app builds wait for an explicit reload; activating a new build removes obsolete app caches without changing IndexedDB books.

Browser storage belongs to the site's origin. Clearing site data, using private browsing, switching browsers, or moving to another domain can remove or separate your library. The app requests persistent storage after successful download, and library backups let you transfer books and progress.

## Checks

```sh
bun run check
bun run test
bun run build
bun run test:e2e
```

Browser tests use Chromium at `/usr/bin/chromium` by default. Set `CHROMIUM_PATH` for another installed executable. The suite runs its own production preview at port 47819 and covers imports, offline reopening, reading positions, pagination, updates, authoring, validation, and backups. It mocks GitHub responses so checks do not depend on network access or API quotas.

To exercise all chapters from the actual reference book:

```sh
git clone --depth 1 https://github.com/djordjeveljkovic/chatgpt-php-book /tmp/chapter-reference
BOOK_REFERENCE_DIR=/tmp/chapter-reference bun run test:e2e
```

Android-sized Chromium tests exercise phone layout and offline browser behavior. Final hardware acceptance remains pending on an actual Android phone. Follow [the phone checklist](docs/android-acceptance.md) to check installation, airplane-mode reopening, passage bookmarks and notes, reading modes, images, search, and backups. The [completion inventory](docs/completion-audit.md) records requirements and their verification.

## Deploy

Deploy `dist/` to an HTTPS static host. No backend, database server, API secret, or AI key is required. Keep `sw.js` and HTML revalidated; compiled hashed assets can be cached long-term.

### GitHub Pages

GitHub Pages publishes from the `main` branch and `/` (repository root). The site address is `https://djordjeveljkovic.github.io/chapter/`: `/` selects the folder within the repository, while `/chapter/` is the project's URL path. The repository root contains the built `index.html`, assets, manifest, and service worker. `.nojekyll` keeps the `_astro/` asset directory available.

After changing the app, refresh those root files and commit them with the source:

```sh
bun run build:pages
git add .
git commit -m "Update GitHub Pages site"
git push
```

If you rename the repository, update `SITE_BASE` in `package.json` to match its new URL path.

The checked-in `release/` directory is a separate, root-scoped static-host bundle. It is not used by GitHub Pages. Rebuild it with `bun run package` before uploading to a different host.

For a portable upload bundle, run `bun run package`. This rebuilds the app, verifies each offline artifact against the service worker's SHA-256 inventory, and writes `release/chapter-site.zip` plus its checksum and deployment inventory. Extract the ZIP and upload its contents to the host's static site directory; `index.html`, `sw.js`, and `manifest.webmanifest` must sit at the site's root. The bundle contains compiled site files; your downloaded books and notes stay in your browser.

For a host that serves the app below a path, use the same base path when building:

```sh
SITE_BASE=/chapter/ bun run build
```

The manifest, asset URLs, service-worker scope, and cached navigation paths use that base. Deploy the contents of `dist/` at `/chapter/`. Backup the library before changing the production origin.

## Local sandbox notes

If your environment restricts Bun's default cache directories, point the install's temporary/cache paths to writable locations:

```sh
BUN_TMPDIR=/tmp BUN_INSTALL_CACHE_DIR=/tmp/chapter-bun-cache bun install --frozen-lockfile
```

`BUN_TMPDIR` holds temporary installation files. `BUN_INSTALL_CACHE_DIR` holds reusable downloaded packages. Neither is used for offline books; those stay in the reader's IndexedDB. In restricted environments, `ASTRO_TELEMETRY_DISABLED=1` avoids Astro trying to write telemetry configuration outside the workspace.
