import { codexIcon } from './codex-icons.js';
import { escapeHtml, externalWebUrl } from './rendering.js';
import { summarizeActivity } from '../src/shared/codex-surfaces.js';

export function turnDurationMs(turn) {
  if (Number.isFinite(turn.durationMs)) return turn.durationMs;
  if (Number.isFinite(turn.startedAt) && Number.isFinite(turn.completedAt)) return Math.max(0, (turn.completedAt - turn.startedAt) * 1000);
  if (Number.isFinite(turn.startedAtMs) && Number.isFinite(turn.completedAtMs)) return Math.max(0, turn.completedAtMs - turn.startedAtMs);
}

export function workedDurationLabel(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 1000) return 'Worked';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `Worked for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `Worked for ${minutes}m ${rest}s` : `Worked for ${minutes}m`;
}

function actionMarkup(item) {
  const action = item.action || {};
  const { label, tone } = summarizeActivity(item);
  const icon = tone === 'error' ? 'triangleAlert' : action.type === 'openPage' ? 'globe' : 'search';
  const url = externalWebUrl(action.url);
  const page = url ? `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer" data-i18n-ignore>${escapeHtml(url.host + (url.pathname === '/' ? '' : url.pathname))}${codexIcon('arrowUpRight')}</a>` : '';
  const values = action.type === 'findInPage' ? [action.pattern]
    : action.type === 'openPage' ? [] : [action.query, ...(Array.isArray(action.queries) ? action.queries.slice(0, 20) : []), item.query];
  const terms = [...new Set(values.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
  const queries = terms.length ? `<ul class="web-search-terms" data-i18n-ignore>${terms.map(query => `<li>${escapeHtml(query)}</li>`).join('')}</ul>` : '';
  return `<li class="web-search-step${tone === 'active' ? ' active' : ''}" data-item-id="${escapeHtml(item.id || '')}">${codexIcon(icon)}<div><span class="web-search-step-label" data-i18n-ui>${escapeHtml(label)}</span>${page}${queries}</div></li>`;
}

export function syncWebSearchActivity(stream, items) {
  if (!items.length) return;
  let timeline = stream.querySelector('.web-search-timeline');
  if (!timeline) {
    timeline = document.createElement('ol');
    timeline.className = 'web-search-timeline';
    stream.append(timeline);
  }
  const markup = items.map(actionMarkup).join('');
  if (timeline.dataset.markup !== markup) {
    timeline.dataset.markup = markup;
    timeline.innerHTML = markup;
  }
}
