// Cloudflare durations use hours; one month is a fixed 30-day browser session.
// The edge owns CF_Authorization. Never copy that credential into JS storage.
export const accessSessionSettings = Object.freeze({
  session_duration: '720h',
  http_only_cookie: true,
  same_site_cookie: 'lax',
});
