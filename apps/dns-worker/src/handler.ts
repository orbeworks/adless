import { createBlocklist, type Blocklist, type BlocklistMetadata } from "./blocklist.js";
import { subscriptionIsRequired } from "./access-policy.js";
import {
  blockedResponse,
  BLOCKED_RESPONSE_TTL,
  cacheKey,
  formErrorResponse,
  isValidUpstreamResponse,
  minimumTTL,
  parseDNSMessage,
  servfailResponse,
  withMaximumTTL,
  withRemainingTTL,
  withTransactionID,
  DNSFormatError,
} from "./dns.js";
import {
  authorizeToken as authorizeTokenInKV,
  handleAppleNotification,
  handleAuthorizationRegister,
  type AuthorizationDependencies,
  type TokenAuthorization,
  type TokenRole,
} from "./authorization.js";
import type { WorkerEnvironment, WorkerExecutionContext } from "./types.js";

const MAX_QUERY_BYTES = 4096;
const MAX_CACHE_ENTRIES = 512;
const MAX_RATE_ENTRIES = 4096;
const UPSTREAM_TIMEOUT_MS = 1500;
const CIRCUIT_FAILURES = 3;
const CIRCUIT_OPEN_MS = 15_000;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 1200;
const AUTHORIZATION_CACHE_GRACE_MS = 10 * 60_000;
const MAX_AUTHORIZATION_CACHE_ENTRIES = 4096;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLOUDFLARE_DOH = "https://cloudflare-dns.com/dns-query";
const QUAD9_DOH = "https://dns.quad9.net/dns-query";

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
  response: Uint8Array;
  expiresAt: number;
}

interface RateEntry {
  start: number;
  count: number;
}

interface AuthorizationCacheEntry {
  authorization: Extract<TokenAuthorization, { kind: "active" | "passThrough" }>;
  staleAt: number;
}

export interface WorkerDependencies {
  fetch?: FetchFunction;
  now?: () => number;
  rateLimit?: number;
  upstreamTimeoutMs?: number;
  authorizeToken?: (env: WorkerEnvironment, token: string, role: TokenRole, now: number) => Promise<TokenAuthorization>;
  subscriptionIsRequired?: (env: WorkerEnvironment) => Promise<boolean>;
  authorization?: AuthorizationDependencies;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function dnsResponse(data: Uint8Array, status: number, ttl?: number): Response {
  // The Worker cache below is keyed by the complete query with its ID removed.
  // Keep HTTP caching disabled because a shared intermediary must never replay
  // a response containing another client's transaction ID.
  void ttl;
  const headers = new Headers({ "content-type": "application/dns-message", "cache-control": "no-store" });
  return new Response(data.buffer as ArrayBuffer, { status, headers });
}

function tokenFromPath(pathname: string): string | null {
  const parts = pathname.split("/");
  if (parts.length !== 3 || parts[0] !== "" || parts[2] !== "dns-query" || !TOKEN_PATTERN.test(parts[1])) return null;
  return parts[1];
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Bearer ")) return null;
  const token = value.slice(7);
  return TOKEN_PATTERN.test(token) ? token : null;
}

function decodeBase64URL(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8192 || value.length % 4 === 1) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function contentTypeIsDNS(request: Request): boolean {
  const value = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return value === "application/dns-message";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requestBody(request: Request): Promise<{ data?: Uint8Array; error?: Response }> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_QUERY_BYTES)) return { error: new Response(null, { status: 413 }) };
  if (!request.body) return { data: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_QUERY_BYTES) {
        await reader.cancel();
        return { error: new Response(null, { status: 413 }) };
      }
      chunks.push(next.value);
    }
  } catch {
    return { error: new Response(null, { status: 400 }) };
  } finally {
    reader.releaseLock();
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return { data };
}

function isCircuitOpen(state: { failures: number; openedAt: number }, now: number): boolean {
  return state.failures >= CIRCUIT_FAILURES && now - state.openedAt < CIRCUIT_OPEN_MS;
}

export function createDNSWorker(blocklistText: string, metadata: BlocklistMetadata, dependencies: WorkerDependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => Date.now());
  const rateLimit = dependencies.rateLimit ?? DEFAULT_RATE_LIMIT;
  const timeoutMs = dependencies.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const cache = new Map<string, CacheEntry>();
  const rateEntries = new Map<string, RateEntry>();
  const authorizationCache = new Map<string, AuthorizationCacheEntry>();
  const circuit = { failures: 0, openedAt: 0 };
  let blocklistPromise: Promise<Blocklist> | undefined;

  const loadBlocklist = (): Promise<Blocklist> => {
    blocklistPromise ??= (async () => {
      const blocklist = createBlocklist(blocklistText, metadata);
      if (metadata.textSHA256) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(blocklistText));
        const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (actual !== metadata.textSHA256) throw new Error("blocklist checksum mismatch");
      }
      return blocklist;
    })();
    return blocklistPromise;
  };

  const allowedByRate = async (request: Request, token: string): Promise<boolean> => {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const [tokenHash, ipHash] = await Promise.all([sha256Hex(token), sha256Hex(ip)]);
    const key = `${tokenHash}:${ipHash}`;
    const timestamp = now();
    const previous = rateEntries.get(key);
    if (!previous || timestamp - previous.start >= RATE_WINDOW_MS) {
      if (rateEntries.size >= MAX_RATE_ENTRIES) {
        for (const [entryKey, entry] of rateEntries) {
          if (timestamp - entry.start >= RATE_WINDOW_MS) rateEntries.delete(entryKey);
          if (rateEntries.size < MAX_RATE_ENTRIES) break;
        }
        if (rateEntries.size >= MAX_RATE_ENTRIES) rateEntries.delete(rateEntries.keys().next().value as string);
      }
      rateEntries.set(key, { start: timestamp, count: 1 });
      return true;
    }
    previous.count += 1;
    return previous.count <= rateLimit;
  };

  const authorizationCacheKey = async (token: string, role: TokenRole): Promise<string> =>
    `${role}:${await sha256Hex(token)}`;

  const authorizeWithAvailability = async (
    env: WorkerEnvironment,
    token: string,
    role: TokenRole,
    timestamp: number,
    authorize: (env: WorkerEnvironment, token: string, role: TokenRole, now: number) => Promise<TokenAuthorization>,
  ): Promise<TokenAuthorization> => {
    const key = await authorizationCacheKey(token, role);
    try {
      const authorization = await authorize(env, token, role, timestamp);
      if (authorization.kind === "rejected") {
        authorizationCache.delete(key);
        return authorization;
      }
      // Only cache records with a server-provided expiry. The cache proves
      // that a credential was known recently, but never preserves an active
      // entitlement when its authoritative record cannot be read.
      if (Number.isSafeInteger(authorization.accessUntil)) {
        if (authorizationCache.size >= MAX_AUTHORIZATION_CACHE_ENTRIES && !authorizationCache.has(key)) {
          authorizationCache.delete(authorizationCache.keys().next().value as string);
        }
        authorizationCache.set(key, {
          authorization,
          staleAt: timestamp + AUTHORIZATION_CACHE_GRACE_MS,
        });
      }
      return authorization;
    } catch (error) {
      const cached = authorizationCache.get(key);
      if (!cached || cached.staleAt <= timestamp) {
        authorizationCache.delete(key);
        throw error;
      }
      return role === "dns"
        ? { kind: "passThrough", installationId: cached.authorization.installationId, accessUntil: cached.authorization.accessUntil }
        : { kind: "rejected", reason: "forbidden" };
    }
  };

  const purgeExpiredCache = (timestamp: number): void => {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= timestamp) cache.delete(key);
    }
  };

  const recordBlocked = async (env: WorkerEnvironment, installationId: string): Promise<void> => {
    if (!env.STATS) return;
    try {
      const id = env.STATS.idFromName(installationId);
      await env.STATS.get(id).fetch("https://stats/increment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"increment":1}',
      });
    } catch {
      // Metrics are deliberately best effort and never delay DNS resolution.
    }
  };

  const resolveUpstream = async (query: Uint8Array, parsed: ReturnType<typeof parseDNSMessage>, url: string): Promise<{ response: Uint8Array; ttl: number }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(url, {
        method: "POST",
        headers: { accept: "application/dns-message", "content-type": "application/dns-message" },
        body: query.buffer as ArrayBuffer,
        signal: controller.signal,
      });
      const contentType = upstream.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (!upstream.ok || upstream.status < 200 || upstream.status >= 300 || contentType !== "application/dns-message") {
        throw new Error("upstream http response is not dns wire format");
      }
      const body = new Uint8Array(await upstream.arrayBuffer());
      if (body.length === 0 || body.length > 65535) throw new Error("invalid upstream body");
      const responseParsed = isValidUpstreamResponse(parsed, body);
      return { response: body, ttl: minimumTTL(responseParsed) ?? 0 };
    } finally {
      clearTimeout(timeout);
    }
  };

  const fetchAllowed = async (query: Uint8Array, parsed: ReturnType<typeof parseDNSMessage>): Promise<{ response: Uint8Array; ttl: number }> => {
    const timestamp = now();
    if (!isCircuitOpen(circuit, timestamp)) {
      try {
        const result = await resolveUpstream(query, parsed, CLOUDFLARE_DOH);
        circuit.failures = 0;
        return result;
      } catch {
        circuit.failures += 1;
        if (circuit.failures >= CIRCUIT_FAILURES) circuit.openedAt = timestamp;
      }
    }
    try {
      const result = await resolveUpstream(query, parsed, QUAD9_DOH);
      return result;
    } catch {
      throw new Error("all upstreams failed");
    }
  };

  const fetchStats = async (env: WorkerEnvironment, installationId: string): Promise<Response> => {
    if (!env.STATS) return jsonResponse({ blockedTotal: 0, updatedAt: new Date(0).toISOString() });
    try {
      const id = env.STATS.idFromName(installationId);
      const response = await env.STATS.get(id).fetch("https://stats/total");
      if (!response.ok) return jsonResponse({ error: "temporarily unavailable" }, 503);
      const payload = await response.json() as { blockedTotal?: unknown; updatedAt?: unknown };
      if (!Number.isSafeInteger(payload.blockedTotal) || (payload.blockedTotal as number) < 0 || typeof payload.updatedAt !== "string") {
        return jsonResponse({ error: "temporarily unavailable" }, 503);
      }
      return jsonResponse({ blockedTotal: payload.blockedTotal, updatedAt: payload.updatedAt });
    } catch {
      return jsonResponse({ error: "temporarily unavailable" }, 503);
    }
  };

  const blockingPreference = async (
    env: WorkerEnvironment,
    installationId: string,
    enabled?: boolean,
  ): Promise<Response> => {
    if (!env.STATS) return jsonResponse({ error: "temporarily unavailable" }, 503);
    try {
      const id = env.STATS.idFromName(installationId);
      const response = await env.STATS.get(id).fetch("https://stats/blocking", enabled === undefined ? undefined : {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blockingEnabled: enabled }),
      });
      if (!response.ok) return jsonResponse({ error: "temporarily unavailable" }, 503);
      const payload = await response.json() as { blockingEnabled?: unknown };
      if (typeof payload.blockingEnabled !== "boolean") {
        return jsonResponse({ error: "temporarily unavailable" }, 503);
      }
      return jsonResponse({ blockingEnabled: payload.blockingEnabled });
    } catch {
      return jsonResponse({ error: "temporarily unavailable" }, 503);
    }
  };

  const blockingState = async (
    env: WorkerEnvironment,
    installationId: string,
  ): Promise<"enabled" | "paused" | "unavailable"> => {
    // STATS is optional in unit-level worker environments. Production declares
    // it in wrangler.toml; an unavailable configured object fails open to
    // upstream DNS so a control-plane error cannot strand connectivity.
    if (!env.STATS) return "enabled";
    const response = await blockingPreference(env, installationId);
    if (!response.ok) return "unavailable";
    const payload = await response.json() as { blockingEnabled: boolean };
    return payload.blockingEnabled ? "enabled" : "paused";
  };

  return {
    async fetch(request: Request, env: WorkerEnvironment, context: WorkerExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const loadSubscriptionRequirement = dependencies.subscriptionIsRequired ?? subscriptionIsRequired;
      const authorizeToken = dependencies.authorizeToken
        ?? ((authorizationEnv: WorkerEnvironment, token: string, role: TokenRole, timestamp: number) =>
          authorizeTokenInKV(authorizationEnv, token, role, timestamp, () => loadSubscriptionRequirement(authorizationEnv)));
      if (url.pathname === "/healthz") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
        }
        return jsonResponse({ status: "ok", environment: env.DEPLOYMENT_ENV ?? "unknown" });
      }
      if (url.pathname === "/v1/access-policy") {
        if (request.method !== "GET") {
          return new Response(null, { status: 405, headers: { allow: "GET" } });
        }
        return jsonResponse({ subscriptionRequired: await loadSubscriptionRequirement(env) });
      }
      if (url.pathname === "/v1/authorization/register") {
        const subscriptionRequired = await loadSubscriptionRequirement(env);
        return handleAuthorizationRegister(request, env, {
          ...dependencies.authorization,
          now,
          subscriptionRequired,
        });
      }
      if (url.pathname === "/v1/notifications/apple") {
        return handleAppleNotification(request, env, {
          ...dependencies.authorization,
          now,
        });
      }
      if (url.pathname === "/v1/stats") {
        if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
        const token = bearerToken(request);
        if (!token) return jsonResponse({ error: "unauthorized" }, 401);
        let authorization: TokenAuthorization;
        try {
          authorization = await authorizeWithAvailability(env, token, "stats", now(), authorizeToken);
        } catch {
          return jsonResponse({ error: "temporarily unavailable" }, 503);
        }
        if (authorization.kind !== "active") return jsonResponse({ error: "unauthorized" }, 401);
        if (!await allowedByRate(request, token)) return jsonResponse({ error: "rate limited" }, 429);
        return fetchStats(env, authorization.installationId);
      }
      if (url.pathname === "/v1/blocking") {
        if (request.method !== "GET" && request.method !== "PUT") {
          return new Response(null, { status: 405, headers: { allow: "GET, PUT" } });
        }
        const token = bearerToken(request);
        if (!token) return jsonResponse({ error: "unauthorized" }, 401);
        let authorization: TokenAuthorization;
        try {
          authorization = await authorizeWithAvailability(env, token, "stats", now(), authorizeToken);
        } catch {
          return jsonResponse({ error: "temporarily unavailable" }, 503);
        }
        if (authorization.kind !== "active") return jsonResponse({ error: "unauthorized" }, 401);
        if (!await allowedByRate(request, token)) return jsonResponse({ error: "rate limited" }, 429);
        if (request.method === "GET") return blockingPreference(env, authorization.installationId);
        const body = await requestBody(request);
        if (body.error) return body.error;
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(body.data));
        } catch {
          return jsonResponse({ error: "invalid request" }, 400);
        }
        const blockingEnabled = payload && typeof payload === "object"
          ? (payload as { blockingEnabled?: unknown }).blockingEnabled
          : undefined;
        if (typeof blockingEnabled !== "boolean") return jsonResponse({ error: "invalid request" }, 400);
        return blockingPreference(env, authorization.installationId, blockingEnabled);
      }
      const token = tokenFromPath(url.pathname);
      if (!token) return new Response(null, { status: 404 });
      let authorization: TokenAuthorization;
      try {
        authorization = await authorizeWithAvailability(env, token, "dns", now(), authorizeToken);
      } catch {
        return new Response(null, { status: 503 });
      }
      if (authorization.kind === "rejected") return jsonResponse({ error: "unauthorized" }, 401);
      const currentBlockingState = authorization.kind === "active"
        ? await blockingState(env, authorization.installationId)
        : "unavailable";
      const shouldBlock = authorization.kind === "active" && currentBlockingState === "enabled";
      const shouldLimitPassThroughTTL = authorization.kind === "active" && currentBlockingState === "paused";
      if (shouldBlock && !await allowedByRate(request, token)) {
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      }

      let query: Uint8Array | undefined;
      if (request.method === "POST") {
        if (!contentTypeIsDNS(request)) return new Response(null, { status: 415 });
        const body = await requestBody(request);
        if (body.error) return body.error;
        query = body.data;
      } else if (request.method === "GET") {
        query = decodeBase64URL(url.searchParams.get("dns") ?? "") ?? undefined;
        if (!query || query.length > MAX_QUERY_BYTES) return new Response(null, { status: 400 });
      } else {
        return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
      }
      if (!query || query.length < 2) return dnsResponse(formErrorResponse(query ?? new Uint8Array()), 400);
      let parsed: ReturnType<typeof parseDNSMessage>;
      try {
        parsed = parseDNSMessage(query, 0);
      } catch (error) {
        if (error instanceof DNSFormatError) return dnsResponse(formErrorResponse(query), 400);
        return new Response(null, { status: 400 });
      }
      if (!shouldBlock) {
        // A paused installation or one without an active entitlement must keep
        // DNS working without consulting the blocklist, response cache, or
        // blocked-query counter. Send every query directly to the upstreams.
        try {
          const result = await fetchAllowed(query, parsed);
          const response = shouldLimitPassThroughTTL
            ? withMaximumTTL(result.response, BLOCKED_RESPONSE_TTL)
            : result.response;
          const ttl = shouldLimitPassThroughTTL
            ? Math.min(result.ttl, BLOCKED_RESPONSE_TTL)
            : result.ttl;
          return dnsResponse(response, 200, ttl);
        } catch {
          return dnsResponse(servfailResponse(parsed), 200, 1);
        }
      }
      try {
        const blocklist = await loadBlocklist();
        const question = parsed.questions[0];
        if (question.klass === 1 && blocklist.has(question.name)) {
          context.waitUntil(recordBlocked(env, authorization.installationId));
          return dnsResponse(blockedResponse(parsed), 200, BLOCKED_RESPONSE_TTL);
        }
        // Keep every installation in its own cache namespace. The current
        // response is global, but future entitlement or policy data must not
        // cross an installation boundary.
        const key = `${authorization.installationId}:${cacheKey(query)}`;
        const timestamp = now();
        purgeExpiredCache(timestamp);
        const cached = cache.get(key);
        if (cached && cached.expiresAt > timestamp) {
          const remainingTTL = Math.max(1, Math.ceil((cached.expiresAt - timestamp) / 1000));
          return dnsResponse(withTransactionID(withRemainingTTL(cached.response, remainingTTL), parsed.id), 200, remainingTTL);
        }
        cache.delete(key);
        try {
          const result = await fetchAllowed(query, parsed);
          if (result.ttl > 0) {
            const normalized = result.response.slice();
            normalized[0] = 0;
            normalized[1] = 0;
            if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
            cache.set(key, { response: normalized, expiresAt: now() + result.ttl * 1000 });
          }
          return dnsResponse(result.response, 200, result.ttl);
        } catch {
          return dnsResponse(servfailResponse(parsed), 200, 1);
        }
      } catch {
        return new Response(null, { status: 500 });
      }
    },
  };
}
