# Android Chrome acceptance

This is the remaining hardware check. Automated Chromium tests do not establish an Android result. Record results below after testing on a real phone.

## Prepare

1. Build with `bun run package`. Extract `release/chapter-site.zip` and upload its contents to an HTTPS static host, or serve `dist/` directly from your host. For a path deployment, set `SITE_BASE=/your-path/` before packaging and upload beneath that same path.
2. Open that HTTPS address in Android Chrome while connected. Wait for **Offline app ready**. Use Chrome's menu to install the app or add it to the home screen. Record which option Chrome offers.
3. Download the sample PHP book. Wait for **Ready offline** and confirm 308 chapters across 21 volumes. The reference book currently has no images; use a compatible book with a repository-local image to check images.
4. In a chapter, scroll to an identifiable sentence, bookmark it, then select some text and add a note. Write down the sentence and note text. Mark the chapter complete. Export a backup.

## Offline and passage checks

1. Close the installed app and Chrome, enable airplane mode, and disable Wi-Fi. Reopen the installed app. Confirm that your library and saved sentence return.
2. Navigate to another volume and chapter, then search for a phrase in a downloaded chapter. Confirm that text, highlighted code, tables, and a downloaded local image render. External image placeholders should identify unavailable images.
3. Open bookmarks and return to the saved passage. Open passage notes and tap the note text to return to its passage. Confirm the recorded sentence is visible. Edit the note, close the app, reopen, and confirm the edit persists.
4. Repeat passage return in paged mode. Change font size, line spacing, typeface, and width; rotate between portrait and landscape. Confirm the saved passage remains visible.
5. Swipe an ordinary page, then scroll a long code block and wide table. Their own scrolling should work without turning the reader page.
6. Open the prompt toolkit offline, fill out a brief, copy a prompt, and download the template ZIP. Confirm that repository validation requires reconnection.
7. Restore the backup and confirm bookmarks, notes, completion, appearance, and saved authoring brief. Reconnect and check book updates; decline applying an update initially to confirm the saved edition remains available.

## Result record

```text
Date:
Phone model / Android version:
Chrome version:
HTTPS site address:
Install option offered and used:
Book commit:
308 chapters / 21 volumes:
Airplane mode, Wi-Fi off, app closed and reopened:
Resume sentence:
Bookmarks save / return / survive reopening:
Notes create / edit / return / survive reopening:
Scroll / pages / typography / rotation:
Code / table independent scrolling:
Offline navigation / search / local image:
Offline prompts / ZIP:
Backup restored personal data:
Online update check / saved edition retained:
Failures (step, expected behavior, actual behavior):
```

Status: **Awaiting the user's Android test.** No hardware pass has been recorded.
