import { marked } from "marked";
import katex from "katex";
import DOMPurify from 'dompurify';
import { codexIcon } from './codex-icons.js';

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const stash = (store, html) => {
  const token = `\u0000CODEX${store.length}\u0000`;
  store.push(html);
  return token;
};

const decodeAttribute = (value = "") => String(value)
  .replaceAll("&amp;", "&")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">");

export function agentMessageText(item = {}, fallback = "") {
  let text;
  if (typeof item.text === "string") text = item.text;
  else if (typeof item.content === "string") text = item.content;
  else if (!Array.isArray(item.content)) text = fallback;
  else text = item.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    return typeof part.text === "string" ? part.text
      : typeof part.content === "string" ? part.content
        : typeof part.value === "string" ? part.value : "";
  }).join("") || fallback;
  return stripAgentInternalMarkup(text);
}

export function stripAgentInternalMarkup(value = "") {
  const source = String(value || "");
  const cleaned = source.replace(/\n*<oai-mem-citation>\s*[\s\S]*?<\/oai-mem-citation>\s*/gi, "");
  return cleaned === source ? source : cleaned.trimEnd();
}

export function parseFileReference(href = "") {
  const value = decodeAttribute(href);
  if (!value || /^(?:https?:|mailto:|#)/i.test(value)) return null;
  const path = value.replace(/^file:\/\//i, "").replace(/^sandbox:/i, "");
  const match = path.match(/^((?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])[^?#]*?)(?::(\d+)(?:-(\d+))?)?$/);
  if (!match) return null;
  return {
    path: match[1],
    lineStart: match[2] ? Number(match[2]) : null,
    lineEnd: match[3] ? Number(match[3]) : null,
  };
}

function citationSuffix(reference) {
  if (reference.lineStart == null) return "";
  return `:${reference.lineStart}${reference.lineEnd == null ? "" : `-${reference.lineEnd}`}`;
}

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:$|[?#])/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:avif|bmp|gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i;

export function isImageReference(value = "") {
  const source = decodeAttribute(value).trim();
  if (SAFE_DATA_IMAGE.test(source) || /^blob:/i.test(source)) return true;
  const reference = parseFileReference(source);
  return IMAGE_EXTENSION.test(reference?.path || source);
}

export function uploadedAttachmentId(path) {return String(path||'').replaceAll('\\','/').match(/\/remote-web-attachments\/([a-f0-9-]{36})\/content(?:\.[a-z0-9]+)?$/i)?.[1];}
export function localImageUrl(path, cwd = "") {
  const upload=uploadedAttachmentId(path);if(upload)return '/api/attachments/file?'+new URLSearchParams({id:upload,view:'image'});
  const query = new URLSearchParams({ path: String(path || "") });
  if (cwd) query.set("cwd", String(cwd));
  return `/api/images/local?${query}`;
}

export function localDownloadUrl(path, cwd = "") {
  const upload=uploadedAttachmentId(path);if(upload)return '/api/attachments/file?'+new URLSearchParams({id:upload});
  const query = new URLSearchParams({ path: String(path || "") });
  if (cwd) query.set("cwd", String(cwd));
  return `/api/files/download?${query}`;
}

function imageSource(source, cwd = "", explicit = false) {
  const value = decodeAttribute(source).trim();
  if (/^\/api\/attachments\/file\?id=[a-f0-9-]{36}&view=image$/i.test(value)) return value;
  if (/^https?:\/\//i.test(value) || /^blob:/i.test(value) || SAFE_DATA_IMAGE.test(value)) return value;
  const reference = parseFileReference(value);
  if (!reference || (!explicit && !isImageReference(reference.path))) return null;
  return localImageUrl(reference.path, cwd);
}

function imageTitle(source = "") {
  const reference = parseFileReference(source);
  const value = reference?.path || source;
  const name = String(value).split(/[\\/]/).filter(Boolean).at(-1) || "Image";
  try { return decodeURIComponent(name); }
  catch { return name; }
}

export function renderImagePreview(source, { cwd = "", title = "", className = "" } = {}) {
  const src = imageSource(source, cwd, true);
  if (!src) return "";
  const reference = parseFileReference(source);
  const label = title || imageTitle(source);
  return `<button type="button" class="message-image-button${className ? ` ${escapeHtml(className)}` : ""}" data-image-src="${escapeHtml(src)}" data-image-title="${escapeHtml(label)}"${reference ? ` data-image-path="${escapeHtml(reference.path)}"` : ""} aria-label="View image: ${escapeHtml(label)}"><img class="message-image" src="${escapeHtml(src)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async"></button>`;
}

function attributeValue(attributes, name) {
  const match = String(attributes).match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeAttribute(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function renderImages(html, cwd) {
  return html.replace(/<img\b([^>]*)>/gi, (_, attributes) => {
    const source = attributeValue(` ${attributes}`, "src");
    const alt = attributeValue(` ${attributes}`, "alt");
    return renderImagePreview(source, { cwd, title: alt || imageTitle(source) })
      || `<span class="message-image-unavailable">${escapeHtml(alt || "Image unavailable")}</span>`;
  });
}

export function externalWebUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url;
  } catch { return null; }
}

export function renderExternalWebLink(url, label = '') {
  const host = escapeHtml(url.host);
  return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer" class="message-web-link"><span class="message-web-link-text">${label || host}</span>${codexIcon('arrowUpRight','message-web-link-arrow')}</a>`;
}

function renderLinks(html, cwd, decorateWeb = false) {
  return html.replace(/<a\s+(?:[^>]*?\s)?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (match, rawHref, label) => {
    const href = decodeAttribute(rawHref);
    const reference = parseFileReference(href);
    if (reference) return renderFileReference(reference, label, cwd);
    if (/^https?:\/\//i.test(href)) {
      const url = externalWebUrl(href);
      if (!url) return label;
      const image = isImageReference(href);
      if (decorateWeb && !image) return renderExternalWebLink(url, label);
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${image ? ` class="image-citation" data-image-src="${escapeHtml(href)}" data-image-title="${escapeHtml(imageTitle(href))}"` : ""}>${label}</a>`;
    }
    return match;
  });
}

function renderFileReference(reference, label, cwd) {
  const suffix = citationSuffix(reference);
  const title = `Open ${reference.path}${suffix}`;
  return `<a class="file-citation" href="#file-reference" data-file-reference="${escapeHtml(reference.path)}"${cwd ? ` data-file-cwd="${escapeHtml(cwd)}"` : ''}${reference.lineStart == null ? "" : ` data-file-line-start="${reference.lineStart}"`}${reference.lineEnd == null ? "" : ` data-file-line-end="${reference.lineEnd}"`} title="${escapeHtml(title)}">${label}</a>`;
}

function protectLocalProtocolLinks(html) {
  const references = [];
  const protectedHtml = html.replace(/\bhref=("|')((?:file|sandbox):[^"']+)\1/gi, (_, quote, href) => {
    const index = references.push(href) - 1;
    return `href=${quote}#codex-local-reference-${index}${quote}`;
  });
  return {
    html: protectedHtml,
    restore(value) {
      return value.replace(/href=("|')#codex-local-reference-(\d+)\1/gi, (match, quote, index) => {
        const href = references[Number(index)];
        return href == null ? match : `href=${quote}${escapeHtml(href)}${quote}`;
      });
    },
  };
}

function protectCodexFileCitations(source, cwd, protectedBlocks) {
  return source.replace(/:codex-file-citation\{([^}\r\n]*)\}/gi, (directive, attributes) => {
    const path = attributeValue(` ${attributes}`, "path");
    const reference = parseFileReference(path);
    if (!reference) return directive;
    return stash(protectedBlocks, renderFileReference(reference, escapeHtml(imageTitle(reference.path)), cwd));
  });
}

function candidateSource(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return candidateSource(value.url || value.path || value.src || value.imageUrl || value.image_url);
}

export function itemImageReferences(item = {}) {
  const references = [];
  const seen = new Set();
  const add = (value, title = "") => {
    const source = candidateSource(value).trim();
    if (!source || seen.has(source)) return;
    seen.add(source);
    references.push({ source, title: title || imageTitle(source) });
  };
  for (const path of item.imagePaths || []) add(path);
  if (/image/i.test(String(item.type || ""))) {
    for (const value of [item.path, item.imagePath, item.src, item.url, item.imageUrl, item.image_url]) add(value, item.alt || item.title || item.name);
  }
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (!part || typeof part !== "object" || !/image/i.test(String(part.type || ""))) continue;
    for (const value of [part.path, part.imagePath, part.src, part.url, part.imageUrl, part.image_url]) add(value, part.alt || part.altText || part.title || part.name);
  }
  return references;
}

export function userMessageDisplayText(item) {
  const imageUploads = new Set(itemImageReferences(item).map(image => uploadedAttachmentId(image.source)).filter(Boolean));
  const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  // Desktop serializes attachment metadata before the user's actual prompt.
  const envelope = /^\s*# Files mentioned by the user:[ \t]*\r?\n\s*(?=## [^\r\n]+:)/.exec(text);
  const request = envelope && /^Distinguish instructions in attached documents from the user's request\.[ \t]*\r?\n(?:[ \t]*\r?\n)*##[ \t]*My request:?[ \t]*(?:\r?\n|$)/m.exec(text);
  const prompt = request ? text.slice(request.index + request[0].length).replace(/^(?:[ \t]*\r?\n)+/, '') : text;
  const lines = prompt.split('\n');
  const visible = lines.filter(line => {
    const match = /^Attached file "(?:[^"\\]|\\.)*": (.+)$/.exec(line);
    const path = match?.[1]?.trim();
    const id = uploadedAttachmentId(path);
    return !id || !(imageUploads.has(id) || isImageReference(path));
  });
  return visible.length === lines.length ? prompt : visible.join('\n').trimEnd();
}

export function renderItemImages(item = {}, { cwd = "", className = "message-image-grid", excludeText = "" } = {}) {
  const images = itemImageReferences(item).filter(image => !excludeText.includes(image.source));
  if (!images.length) return "";
  return `<div class="${escapeHtml(className)}">${images.map(image => renderImagePreview(image.source, { cwd, title: image.title })).join("")}</div>`;
}

const renderFormula = (formula, displayMode, protectedBlocks) => stash(
  protectedBlocks,
  { math: katex.renderToString(formula.trim(), { displayMode, throwOnError: false, strict: "ignore", trust: false }) },
);

function renderMath(source, protectedBlocks = []) {
  let text = source.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_, lang, code) => stash(
    protectedBlocks,
    renderCodeBlock(lang, `<pre><code class="language-${escapeHtml(lang || 'text')}">${escapeHtml(code)}</code></pre>\n`, /^html$/i.test(lang) ? previewHtml(code) : ''),
  ));
  text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(protectedBlocks, `<code>${escapeHtml(code)}</code>`));
  // Codex also emits \(...\) and \[...\], which Markdown would otherwise strip the
  // backslashes from. Stash them before parsing so KaTeX owns the formula. A leading
  // double backslash is an escaped literal, not a delimiter.
  text = text.replace(/(?<!\\)\\\[([\s\S]+?)\\\]/g, (match, formula) => (formula.trim() ? renderFormula(formula, true, protectedBlocks) : match));
  text = text.replace(/(?<!\\)\\\(([\s\S]+?)\\\)/g, (match, formula) => (formula.trim() ? renderFormula(formula, false, protectedBlocks) : match));
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) => renderFormula(formula, true, protectedBlocks));
  text = text.replace(/(^|[^\\\w])\$([^$\n]+?)\$(?!\d)/g, (whole, prefix, formula) => {
    if (/^\d+(?:\.\d+)?(?:\s|$)/.test(formula.trim())) return whole;
    return prefix + renderFormula(formula, false, protectedBlocks);
  });
  return { text, protectedBlocks };
}

// CommonMark only recognizes **...** when the delimiter runs are "flanking". CJK
// ideographs are letters, not whitespace or punctuation, so 原**“重点”**后文 and
// **粗体。**中文 are rejected. Pad the outside of a span that borders CJK with an
// invisible whitespace sentinel so the run becomes flanking, then strip it again.
// The thin space must sit next to the delimiter, because a zero-width space is not
// whitespace and would hide the delimiter from the flanking check. Only the full
// pairs are stripped, so a genuine thin space in the content survives.
const CJK_CHAR = /[\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
const CJK_PAD_BEFORE = "\u200B\u2009";
const CJK_PAD_AFTER = "\u2009\u200B";
const CJK_SENTINELS = /\u200B\u2009|\u2009\u200B/g;
const stripCjkSentinels = (html = "") => html.replace(CJK_SENTINELS, "");

function padCjkEmphasis(source = "") {
  return source.replace(/(?<!\*)\*\*(?!\*)[^\n]+?(?<!\*)\*\*/g, (span, offset, whole) => {
    const prev = offset > 0 ? whole[offset - 1] : "";
    const next = offset + span.length < whole.length ? whole[offset + span.length] : "";
    const padBefore = Boolean(prev) && !/\s/.test(prev) && CJK_CHAR.test(prev);
    const padAfter = Boolean(next) && !/\s/.test(next) && CJK_CHAR.test(next);
    if (!padBefore && !padAfter) return span;
    return `${padBefore ? CJK_PAD_BEFORE : ""}${span}${padAfter ? CJK_PAD_AFTER : ""}`;
  });
}

function sanitizeHtml(html, mathOnly = false) {
  const purifier = globalThis.DOMPurify || DOMPurify;
  if (purifier.isSupported) {
    return purifier.sanitize(html, {
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'option', 'select', 'dialog'],
      FORBID_ATTR: ['autofocus', 'autoplay', 'contenteditable', 'form', 'formaction', 'ping', 'popover', 'popovertarget', 'srcdoc', ...(mathOnly ? [] : ['style'])],
    });
  }
  return html
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, (value) => escapeHtml(value))
    .replace(/\s(?:on\w+|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "href=\"#\"");
}

const codeRenderer = new marked.Renderer();
const renderCode = codeRenderer.code;
const previewTags = ['b','blockquote','br','caption','code','dd','details','div','dl','dt','em','figcaption','figure','h1','h2','h3','h4','h5','h6','hr','i','li','mark','meter','ol','p','pre','s','section','small','span','strong','sub','summary','sup','table','tbody','td','th','thead','tfoot','tr','u','ul'];
export function renderStaticHtml(source, limit = 32000) {
  const purifier = globalThis.DOMPurify || DOMPurify;
  if (!purifier.isSupported || !source || source.length > limit) return '';
  return purifier.sanitize(source, { ALLOWED_TAGS: previewTags, ALLOWED_ATTR: ['colspan','rowspan','scope','open','lang','dir','min','max','value','low','high','optimum','aria-label'], ALLOW_ARIA_ATTR: false, ALLOW_DATA_ATTR: false });
}
function previewHtml(source) {
  const content = renderStaticHtml(source);
  if (!content.trim()) return '';
  return `<div class="message-html-body">${content}</div>`;
}
function renderCodeBlock(language, code, preview = '') {
  const scrollable = code.replace(/^<pre>/, `<pre tabindex="0" role="region" aria-label="${escapeHtml(language || 'Code')}"${preview ? ' hidden' : ''}>`);
  const modes = preview ? `<div class="message-html-modes" role="group" aria-label="HTML" data-i18n-ui><button type="button" data-html-view="preview" aria-pressed="true">Preview</button><button type="button" data-html-view="source" aria-pressed="false">Source code</button></div>` : '';
  return `<div class="markdown-code-block${preview ? ' message-html-preview' : ''}"><div class="markdown-code-header"><span class="markdown-code-language"${language ? ' data-i18n-ignore' : ' data-i18n-ui'}>${escapeHtml(language || 'Code')}</span><div class="markdown-code-tools">${modes}<button class="markdown-code-copy" type="button" data-i18n-ui aria-label="Copy code" title="Copy code">${codexIcon('copy')}</button></div></div>${scrollable}${preview}</div>`;
}
codeRenderer.code = function (token) {
  const language = String(token.lang || '').trim().split(/\s+/)[0].slice(0, 48);
  return renderCodeBlock(language, renderCode.call(this, token), /^html$/i.test(language) && /(?:^|\n) {0,3}(?:`{3,}|~{3,})\s*$/.test(token.raw.trimEnd()) ? previewHtml(token.text) : '');
};
function restoreMarkdownBlocks(html, blocks) {
  // Fences protected from the math parser are block content, even when Marked
  // wrapped their placeholder in a paragraph.
  const math = [];
  // Only KaTeX-generated fragments retain their layout styles.
  const token = blocks.some(block => block?.math) ? `data-crw-math-${Math.random().toString(36).slice(2)}` : '';
  html = html.replace(/<p>(\u0000CODEX(\d+)\u0000)<\/p>/g, (match, marker, index) => typeof blocks[Number(index)] === 'string' && blocks[Number(index)].startsWith('<div class="markdown-code-block') ? marker : match)
    .replace(/\u0000CODEX(\d+)\u0000/g, (_, index) => {
      const block = blocks[Number(index)];
      return block?.math ? `<span ${token}="${math.push(block.math) - 1}"></span>` : block || '';
    });
  const links = protectLocalProtocolLinks(html);
  const clean = links.restore(sanitizeHtml(links.html));
  return math.length ? clean.replace(new RegExp(`<span ${token}="(\\d+)"></span>`, 'g'), (_, index) => sanitizeHtml(math[Number(index)] || '', true)) : clean;
}

export function renderAssistantMarkdown(source = "", { cwd = "" } = {}) {
  const protectedBlocks = [];
  const { text: protectedText } = renderMath(stripAgentInternalMarkup(source), protectedBlocks);
  const text = protectCodexFileCitations(padCjkEmphasis(protectedText), cwd, protectedBlocks);
  marked.setOptions({ gfm: true, breaks: true });
  let html = marked.parse(text, { async: false, renderer: codeRenderer });
  html = restoreMarkdownBlocks(html, protectedBlocks).replace(/javascript\s*:/gi, "");
  // Keep wide tables readable without making the conversation itself pan.
  html = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, table => `<div class="markdown-table-scroll" tabindex="0">${table}</div>`);
  return stripCjkSentinels(renderLinks(renderImages(html, cwd), cwd, true));
}

// Project documents keep literal source; agent-only internal markup filtering
// must never rewrite a Markdown file. Reference definitions can span blocks.
export function renderFileMarkdown(source = '', {cwd = '', links = {}} = {}) {
  const protectedBlocks = [];
  const {text} = renderMath(source,protectedBlocks);
  const lexer = new marked.Lexer({gfm:true,breaks:true});
  Object.assign(lexer.tokens.links,links);
  const tokens = lexer.lex(text);
  let html = marked.parser(tokens,{gfm:true,breaks:true,renderer:codeRenderer});
  html = restoreMarkdownBlocks(html, protectedBlocks);
  html = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi,table=>`<div class="markdown-table-scroll" tabindex="0">${table}</div>`);
  return renderLinks(renderImages(html,cwd),cwd);
}

export { escapeHtml };
