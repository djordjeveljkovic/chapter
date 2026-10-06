import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import php from "highlight.js/lib/languages/php";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import { headingSlug, resolvePath } from "./format";
import type { Book, Chapter } from "./types";

for (const [name, language] of Object.entries({
  php,
  javascript,
  typescript,
  python,
  sql,
  json,
  bash,
  xml,
  css,
}))
  hljs.registerLanguage(name, language);
const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderChapter(book: Book, chapter: Chapter): string {
  if (chapter.format === "text") return `<pre class="plain-document">${escape(chapter.markdown)}</pre>`;
  const renderer = new Renderer();
  renderer.html = ({ text }) => `<pre class="raw-markup">${escape(text)}</pre>`;
  renderer.code = ({ text, lang }) => {
    const language = (lang || "").split(/\s/)[0].toLowerCase();
    const highlighted = hljs.getLanguage(language)
      ? hljs.highlight(text, { language, ignoreIllegals: true }).value
      : escape(text);
    return `<div class="code-frame"><span class="code-language">${escape(language || "code")}</span><pre tabindex="0"><code>${highlighted}</code></pre></div>`;
  };
  const rendered = marked.parse(chapter.markdown, {
    renderer,
    async: false,
    gfm: true,
    breaks: false,
  });
  const html = DOMPurify.sanitize(rendered, {
    ADD_ATTR: ["tabindex"],
    FORBID_TAGS: ["style", "iframe", "form", "input", "video", "audio"],
    FORBID_ATTR: ["style"],
  });
  const document = new DOMParser().parseFromString(html, "text/html");
  const seen = new Map<string, number>();
  document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((heading) => {
    const slug = headingSlug(heading.textContent || "");
    const number = seen.get(slug) || 0;
    seen.set(slug, number + 1);
    heading.id = number ? `${slug}-${number}` : slug;
  });
  document.querySelectorAll("img").forEach((image) => {
    const path = resolvePath(
      chapter.path,
      image.getAttribute("src") || "",
    )?.path;
    const asset = book.assets.find((a) => a.path === path);
    image.removeAttribute("srcset");
    if (
      asset &&
      /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/i.test(asset.mime)
    ) {
      image.src = `data:${asset.mime};base64,${asset.data}`;
      image.loading = "eager";
      image.decoding = "async";
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "media-missing";
      placeholder.textContent = `${image.alt || "Image"} — unavailable offline`;
      image.replaceWith(placeholder);
    }
  });
  document.querySelectorAll("a").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    const target = resolvePath(chapter.path, href);
    if (target) {
      anchor.dataset.bookPath = target.path;
      anchor.dataset.bookHash = target.hash;
      anchor.href = "#";
    } else {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    }
  });
  document.querySelectorAll("table").forEach((table) => {
    const wrapper = document.createElement("div");
    wrapper.className = "table-frame";
    wrapper.tabIndex = 0;
    table.replaceWith(wrapper);
    wrapper.append(table);
  });
  return document.body.innerHTML;
}
