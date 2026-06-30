/**
 * InFlow — Cloudflare Worker Proxy for Anthropic API
 *
 * Deploy this to a free Cloudflare Worker, then paste the Worker URL
 * into InFlow Settings → Proxy URL.
 *
 * This proxy:
 *  - Adds the correct CORS headers so the browser can call from any origin
 *  - Forwards the request to api.anthropic.com server-side (no CORS issue)
 *  - Passes through your API key from the request headers
 *  - Never stores or logs your API key or resume content
 *
 * Deploy steps:
 *  1. Go to https://workers.cloudflare.com and sign in (free account is fine)
 *  2. Click "Create Worker"
 *  3. Replace the default code with this entire file
 *  4. Click "Save and Deploy"
 *  5. Copy the *.workers.dev URL shown at the top
 *  6. Paste that URL into InFlow → Settings → Proxy URL
 */

const ANTHROPIC_API = "https://api.anthropic.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-allow-browser",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only allow POST to /v1/messages
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    // Forward to Anthropic — strip the worker path, always hit /v1/messages
    const target = `${ANTHROPIC_API}/v1/messages`;

    // Copy headers, drop the host
    const headers = new Headers(request.headers);
    headers.delete("host");
    // Remove the browser-only header — server-side doesn't need it
    headers.delete("anthropic-dangerous-allow-browser");

    let body;
    try {
      body = await request.text();
    } catch {
      return new Response("Bad request body", { status: 400, headers: CORS_HEADERS });
    }

    let anthropicRes;
    try {
      anthropicRes = await fetch(target, {
        method: "POST",
        headers,
        body,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: "Upstream fetch failed: " + err.message } }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Stream the response back with CORS headers
    const responseHeaders = new Headers(anthropicRes.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(k, v);
    }

    return new Response(anthropicRes.body, {
      status: anthropicRes.status,
      headers: responseHeaders,
    });
  },
};
