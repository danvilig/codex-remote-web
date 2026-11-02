// Test-only network boundary: production always fetches the configured Cloudflare HTTPS JWKS URL.
import { readFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) === 'https://fixture-team.cloudflareaccess.com/cdn-cgi/access/certs') {
    const data = JSON.parse(readFileSync(process.env.FIXTURE_JWKS_FILE!, 'utf8'));
    return data.unavailable ? new Response('', { status: 503 }) : Response.json(data);
  }
  return original(input, init);
};
