import type { IncomingMessage } from 'node:http';
export function readJsonBody(req: IncomingMessage, maxBytes = 256_000) {
  return new Promise<any>((resolvePromise, reject) => {
    let body = "", tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      if (tooLarge) return;
      if (Buffer.byteLength(body) + Buffer.byteLength(chunk) > maxBytes) { tooLarge = true; return; }
      body += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(new Error("Bridge payload too large"));
      try { resolvePromise(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON payload")); }
    });
  });
}
