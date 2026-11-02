import { isLocalInspectionRequest } from '../auth/loopback.js';

// Auth is checked by the router first. An explicit same-origin typed request also
// prevents cross-site forms and fetches from mutating a loopback workspace.
export function workspaceMutation(req, authConfig, contentType = 'application/json') {
  if (
    req.headers['x-workspace-request'] !== '1' ||
    String(req.headers['content-type'] || '')
      .toLowerCase()
      .split(';')[0].trim() !== contentType
  )
    return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  try {
    const origin = new URL(req.headers.origin);
    return authConfig.mode === 'local'
      ? ['http:', 'https:'].includes(origin.protocol) &&
          origin.host === req.headers.host
      : origin.origin === authConfig.publicOrigin || isLocalInspectionRequest(req, authConfig);
  } catch {
    return false;
  }
}
