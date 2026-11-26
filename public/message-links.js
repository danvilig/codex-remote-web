import { codexIcon } from './codex-icons.js';
import { externalWebUrl } from './rendering.js';

const node = (tag, className, text = '') => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

export function installMessageLinkPreview({t, toast}) {
  const selector = 'a.message-web-link';
  const linkFor = element => element instanceof Element && element.closest(selector);
  const preview = node('div','message-link-preview');
  preview.hidden = true;
  const url = node('a','message-link-preview-url');
  url.target = '_blank'; url.rel = 'noopener noreferrer';
  const address = node('span','message-link-preview-address');
  url.append(address); url.insertAdjacentHTML('beforeend',codexIcon('arrowUpRight'));
  const copy = node('button','message-link-preview-copy');
  copy.type = 'button'; copy.setAttribute('aria-label','Copy link'); copy.title = 'Copy link'; copy.innerHTML = codexIcon('copy');
  preview.append(url,copy); document.body.append(preview);
  let anchor, openTimer, closeTimer, pinned = false;
  function close(restore = false) {
    const previous = anchor;
    clearTimeout(openTimer); clearTimeout(closeTimer);
    anchor = null; pinned = false; preview.hidden = true;
    if (restore) previous?.focus({preventScroll:true});
  }
  function place() {
    if (!anchor?.isConnected) { close(); return; }
    const rect = anchor.getClientRects()[0] || anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) { close(); return; }
    const {height,width} = preview.getBoundingClientRect();
    preview.style.left = `${Math.max(8,Math.min(rect.left,innerWidth-width-8))}px`;
    preview.style.top = `${rect.top > height+14 ? rect.top-height-8 : Math.min(rect.bottom+8,innerHeight-height-8)}px`;
  }
  function show(link) {
    const destination = externalWebUrl(link.href);
    if (!destination || !link.isConnected) return;
    clearTimeout(closeTimer); anchor = link;
    url.href = destination.href; address.textContent = destination.href; url.title = destination.href;
    preview.hidden = false; place();
  }
  function schedule(link) {
    if (pinned || (anchor === link && !preview.hidden)) return;
    clearTimeout(openTimer); clearTimeout(closeTimer);
    openTimer = setTimeout(() => show(link), preview.hidden ? 220 : 0);
  }
  function deferClose() {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    if (!pinned) closeTimer = setTimeout(() => { if (!preview.contains(document.activeElement)) close(); },180);
  }
  document.addEventListener('pointerover',event => {
    const link = linkFor(event.target);
    if (event.pointerType === 'mouse' && link && !link.contains(event.relatedTarget)) schedule(link);
  });
  document.addEventListener('pointerout',event => {
    const link = linkFor(event.target);
    if (link && !link.contains(event.relatedTarget) && !preview.contains(event.relatedTarget)) deferClose();
  });
  preview.addEventListener('pointerenter',() => clearTimeout(closeTimer));
  preview.addEventListener('pointerleave',event => { if (!anchor?.contains(event.relatedTarget)) deferClose(); });
  document.addEventListener('focusin',event => {
    if (preview.contains(event.target)) return;
    const link = linkFor(event.target);
    if (link?.matches(':focus-visible')) schedule(link);
    else close();
  });
  document.addEventListener('pointerdown',event => { if (!preview.contains(event.target) && !anchor?.contains(event.target)) close(); });
  document.addEventListener('keydown',event => {
    const link = linkFor(event.target);
    if (link && event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault(); clearTimeout(openTimer); show(link); pinned = true; copy.focus(); return;
    }
    if (!preview.hidden && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(preview.contains(document.activeElement)); clearTimeout(openTimer);
    }
  });
  document.addEventListener('scroll',() => { if (!preview.hidden) close(); }, {capture:true,passive:true});
  window.addEventListener('resize',close.bind(null,false));
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(url.href); toast(t('Copied')); }
    catch { toast(t('Could not copy the link.')); }
  };
}

export function updateAnswerLinks(turn, slot, enabled) {
  const existing = turn.querySelector(':scope > .answer-links');
  if (!enabled) { existing?.remove(); return; }
  const links = new Map();
  for (const anchor of slot.querySelectorAll('a.message-web-link')) {
    const url = externalWebUrl(anchor.href);
    if (url && !links.has(url.href)) links.set(url.href,{url, title:anchor.textContent.trim() || url.host});
    if (links.size >= 24) break;
  }
  if (!links.size) { existing?.remove(); return; }
  const signature = JSON.stringify([...links].map(([href,{title}]) => [href,title]));
  if (existing?.dataset.signature === signature) return;
  const details = node('details','answer-links');
  details.open = existing?.open || false; details.dataset.signature = signature;
  const summary = node('summary','answer-links-summary');
  summary.innerHTML = `${codexIcon('globe')}<span data-i18n-ui>Links in this answer</span><span class="answer-links-count">${links.size}</span>${codexIcon('chevronRight','answer-links-chevron')}`;
  const list = node('ul','answer-links-list'); list.setAttribute('role','list');
  for (const {url,title} of links.values()) {
    const item = node('li','answer-link-item'), link = node('a','message-web-link');
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const copy = node('span','answer-link-copy'); copy.dataset.i18nIgnore = '';
    copy.append(node('strong','',title), node('small','',url.host));
    link.append(copy); link.insertAdjacentHTML('beforeend',codexIcon('arrowUpRight'));
    item.append(link); list.append(item);
  }
  details.append(summary,list);
  if (existing) existing.replaceWith(details);
  else turn.querySelector(':scope > .turn-message-actions').before(details);
}
