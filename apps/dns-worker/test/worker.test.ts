import "reflect-metadata";
import { strict as assert } from "node:assert";
import { createHash, webcrypto } from "node:crypto";
import { test } from "node:test";
import { cryptoProvider, X509CertificateGenerator } from "@peculiar/x509";
import { SignJWT } from "jose";
import { verifyAppleJWS } from "../src/apple-jws.js";
import { subscriptionIsRequired } from "../src/access-policy.js";
import { createBlocklist, normalizeDomain } from "../src/blocklist.js";
import { createDNSWorker } from "../src/handler.js";
import { BLOCKED_RESPONSE_TTL, parseDNSMessage } from "../src/dns.js";
import { StatsDurableObject } from "../src/stats.js";
import {
  handleAppleNotification,
  handleAuthorizationRegister,
  processAppleNotification,
  authorizeToken,
  type AppleAppTransactionPayload,
  type AppleNotificationPayload,
  type AppleRenewalInfoPayload,
  type AppleTransactionPayload,
  type AuthorizationEnvironment,
  type AuthorizationKV,
  type TokenAuthorization,
  type TokenRole,
} from "../src/authorization.js";
import type { StatsStorage, SubscriptionAuthorityEvent, WorkerEnvironment } from "../src/types.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1234567890_-".slice(0, 43);
const OTHER_TOKEN = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210_-abc12";
const ROTATION_NONCE = "0123456789abcdefghijklmnopqrstuvwxyz_ABCD12".slice(0, 43);
const OTHER_ROTATION_NONCE = "9876543210ZYXWVUTSRQPONMLKJIHGFEDCBA_abcd12".slice(0, 43);
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const AUTH_NOW = 1_000_000;
const AUTH_ENV = {
  AUTH_TOKEN_DERIVATION_SECRET: "test-only-token-derivation-secret-with-at-least-32-bytes",
  APPLE_BUNDLE_ID: "com.orbeworks.adless",
  APPLE_APP_ID: "6803552143",
  APPLE_ALLOWED_ENVIRONMENTS: "Production",
  APPLE_NOTIFICATION_ENVIRONMENTS: "Production,Sandbox",
  APPLE_TESTFLIGHT_BUILD_VERSIONS: "2",
} as const;

cryptoProvider.set(webcrypto as unknown as Crypto);
const DEVELOPMENT_AUTH_ENV = {
  AUTH_TOKEN_DERIVATION_SECRET: "test-only-development-secret-with-at-least-32-bytes",
  APPLE_BUNDLE_ID: "com.orbeworks.adless.dev",
  APPLE_ALLOWED_ENVIRONMENTS: "Xcode",
  APPLE_NOTIFICATION_ENVIRONMENTS: "",
  APPLE_TESTFLIGHT_BUILD_VERSIONS: "",
  XCODE_STOREKIT_CERTIFICATE_SHA256: "f".repeat(64),
} as const;

class MemoryDOStorage implements StatsStorage {
  readonly values = new Map<string, unknown>();
  private queue: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async transaction<T>(callback: (transaction: StatsStorage) => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = new Map(this.values);
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, value] of snapshot) this.values.set(key, value);
      throw error;
    } finally {
      release?.();
    }
  }
}

class MemoryAuthorityNamespace {
  readonly objects = new Map<string, MemoryDOStorage>();
  readonly names: string[] = [];
  unavailable = false;
  hang = false;

  get idCalls(): number { return this.names.length; }

  idFromName(name: string) {
    this.names.push(name);
    return name;
  }

  get(id: unknown) {
    const name = String(id);
    let storage = this.objects.get(name);
    if (!storage) {
      storage = new MemoryDOStorage();
      this.objects.set(name, storage);
    }
    const object = new StatsDurableObject({ storage }, {});
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (this.unavailable) throw new Error("authority DO unavailable");
        if (this.hang) {
          return await new Promise<Response>((_resolve, reject) => {
            const watchdog = setTimeout(() => reject(new Error("authority timeout signal was not honored")), 2_000);
            const abort = () => {
              clearTimeout(watchdog);
              reject(init?.signal?.reason ?? new Error("authority request aborted"));
            };
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return await object.fetch(new Request(String(input), init));
      },
    };
  }
}

class MemoryKV implements AuthorizationKV {
  readonly values = new Map<string, string>();
  readonly authority = new MemoryAuthorityNamespace();
  unavailable = false;
  putCalls = 0;
  failPutAt: number | undefined;
  failDeletes = false;

  async get(key: string, type: "json" | "text" = "text"): Promise<unknown> {
    if (this.unavailable) throw new Error("KV unavailable");
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.unavailable) throw new Error("KV unavailable");
    this.putCalls += 1;
    if (this.putCalls === this.failPutAt) throw new Error("injected KV put failure");
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    if (this.unavailable || this.failDeletes) throw new Error("KV unavailable");
    this.values.delete(key);
  }
}

function environmentForAuthorization(
  kv: MemoryKV,
  base: AuthorizationEnvironment = AUTH_ENV,
): AuthorizationEnvironment {
  return { ...base, AUTH: kv, AUTHORITY: base.AUTHORITY ?? kv.authority };
}

function latestAuthorityEvent(
  kv: MemoryKV,
  environment: "Production" | "Sandbox" | "Xcode" = "Production",
): SubscriptionAuthorityEvent | undefined {
  return [...kv.authority.objects.values()]
    .map((storage) => storage.values.get("authority:latest") as SubscriptionAuthorityEvent | undefined)
    .find((event) => event?.environment === environment);
}

function testTransaction(overrides: Partial<AppleTransactionPayload> = {}): AppleTransactionPayload {
  return {
    bundleId: "com.orbeworks.adless",
    environment: "Production",
    productId: "com.orbeworks.adless.pro.monthly",
    originalTransactionId: "1000000000000001",
    transactionId: "1000000000000002",
    purchaseDate: 900_000,
    expiresDate: 2_000_000,
    signedDate: 1_000_000,
    ...overrides,
  };
}

function testAppTransaction(overrides: Partial<AppleAppTransactionPayload> = {}): AppleAppTransactionPayload {
  return {
    receiptType: "Sandbox",
    bundleId: "com.orbeworks.adless",
    applicationVersion: "2",
    receiptCreationDate: 950_000,
    appTransactionId: "app-download-1000000000000001",
    ...overrides,
  };
}

function testNotification(overrides: Partial<AppleNotificationPayload> = {}): AppleNotificationPayload {
  return {
    notificationType: "DID_CHANGE_RENEWAL_STATUS",
    notificationUUID: "notification-1",
    signedDate: 1_100_000,
    data: {
      appAppleId: 6_803_552_143,
      bundleId: "com.orbeworks.adless",
      environment: "Production",
    },
    ...overrides,
  };
}

function qname(name: string): Uint8Array {
  const labels = name.replace(/\.$/, "").split(".");
  const bytes: number[] = [];
  for (const label of labels) bytes.push(label.length, ...[...label].map((character) => character.charCodeAt(0)));
  bytes.push(0);
  return Uint8Array.from(bytes);
}

function query(name = "www.example.com", type = 1, id = 0x1234, withEDNS = false): Uint8Array {
  const nameBytes = qname(name);
  const question = Uint8Array.from([...nameBytes, type >> 8, type & 0xff, 0, 1]);
  const opt = withEDNS ? Uint8Array.from([0, 0, 41, 0x10, 0, 0, 0, 0, 0, 0, 0]) : new Uint8Array();
  const result = new Uint8Array(12 + question.length + opt.length);
  result.set(Uint8Array.from([id >> 8, id & 0xff, 0x01, 0x10, 0, 1, 0, 0, 0, 0, 0, withEDNS ? 1 : 0]));
  result.set(question, 12);
  result.set(opt, 12 + question.length);
  return result;
}

function response(request: Uint8Array, type = 1, rcode = 0, ttl = 60): Uint8Array {
  const parsed = parseDNSMessage(request, 0);
  const question = parsed.questions[0].raw;
  const address = type === 1
    ? Uint8Array.from([1, 2, 3, 4])
    : type === 28
      ? Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
      : undefined;
  const answer = address
    ? Uint8Array.from([
      0xc0, 0x0c, type >> 8, type & 0xff, 0, 1,
      ttl >> 24, (ttl >> 16) & 0xff, (ttl >> 8) & 0xff, ttl & 0xff,
      address.length >> 8, address.length & 0xff, ...address,
    ])
    : new Uint8Array();
  const result = new Uint8Array(12 + question.length + answer.length);
  result.set(Uint8Array.from([
    request[0], request[1], 0x81, rcode === 0 ? 0x80 : 0x83, 0, 1,
    answer.length ? 0 : 0, answer.length ? 1 : 0, 0, 0, 0, 0,
  ]));
  result.set(question, 12);
  result.set(answer, 12 + question.length);
  return result;
}

function metadata(text: string, count = text.trim().split("\n").length) {
  return {
    schemaVersion: 1,
    version: "v0000000000000000",
    domainCount: count,
    textSHA256: createHash("sha256").update(text).digest("hex"),
  };
}

function binaryBody(data: Uint8Array): ArrayBuffer {
  return data.buffer as ArrayBuffer;
}

function makeWorker(
  text = "ads.example.com\ntracker.example.net\n",
  fetchImpl: typeof fetch = async () => new Response(null, { status: 500 }),
  options: Parameters<typeof createDNSWorker>[2] = {},
) {
  const authorizeToken = options.authorizeToken ?? (async (_env: WorkerEnvironment, token: string, _role: TokenRole, _now: number): Promise<TokenAuthorization> => {
    if (token === TOKEN) return { kind: "active", installationId: INSTALLATION_ID, accessUntil: Number.MAX_SAFE_INTEGER };
    if (token === OTHER_TOKEN) return { kind: "active", installationId: OTHER_INSTALLATION_ID, accessUntil: Number.MAX_SAFE_INTEGER };
    return { kind: "rejected", reason: "unknown" };
  });
  return createDNSWorker(text, metadata(text), { ...options, fetch: fetchImpl, authorizeToken });
}

function requestFor(body: Uint8Array, method = "POST", headers: Record<string, string> = {}) {
  return requestForToken(body, TOKEN, method, headers);
}

function requestForToken(body: Uint8Array, token: string, method = "POST", headers: Record<string, string> = {}) {
  return new Request(`https://worker.example.test/${token}/dns-query`, {
    method,
    headers: { "content-type": "application/dns-message", ...headers },
    body: body.buffer as ArrayBuffer,
  });
}

function context() {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil(promise: Promise<unknown>) { pending.push(promise); } };
}

async function authorizationResponse(
  kv: MemoryKV,
  installationId = INSTALLATION_ID,
  transaction: AppleTransactionPayload = testTransaction(),
  authorizationEnvironment: AuthorizationEnvironment = AUTH_ENV,
  appTransaction?: AppleAppTransactionPayload,
  rotationNonce = ROTATION_NONCE,
  currentCredentialProof?: { dnsToken: string; statsToken: string },
): Promise<Response> {
  const request = new Request("https://worker.example.test/v1/authorization/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installationId,
      transactionJWS: "test-transaction-jws",
      rotationNonce,
      ...(appTransaction ? { appTransactionJWS: "test-app-transaction-jws" } : {}),
      ...(currentCredentialProof ? {
        currentDnsToken: currentCredentialProof.dnsToken,
        currentStatsToken: currentCredentialProof.statsToken,
      } : {}),
    }),
  });
  return await handleAuthorizationRegister(request, environmentForAuthorization(kv, authorizationEnvironment), {
    now: () => AUTH_NOW,
    verifyTransaction: async (jws) => {
      assert.equal(jws, "test-transaction-jws");
      return transaction;
    },
    verifyAppTransaction: async (jws) => {
      assert.equal(jws, "test-app-transaction-jws");
      if (!appTransaction) throw new Error("unexpected app transaction verification");
      return appTransaction;
    },
  });
}

async function registerTestInstallation(
  kv: MemoryKV,
  installationId = INSTALLATION_ID,
  transaction: AppleTransactionPayload = testTransaction(),
  authorizationEnvironment: AuthorizationEnvironment = AUTH_ENV,
  appTransaction?: AppleAppTransactionPayload,
  rotationNonce = ROTATION_NONCE,
  currentCredentialProof?: { dnsToken: string; statsToken: string },
) {
  const result = await authorizationResponse(
    kv,
    installationId,
    transaction,
    authorizationEnvironment,
    appTransaction,
    rotationNonce,
    currentCredentialProof,
  );
  assert.equal(result.status, 200);
  return await result.json() as { installationId: string; dnsToken: string; statsToken: string; accessUntil: number };
}

function statsNamespace(expectedInstallationId: string, blockedTotal = 0) {
  const values = new Map<string, unknown>([
    ["blockedTotal", blockedTotal],
    ["updatedAt", "2026-08-26T00:00:00.000Z"],
  ]);
  const state = {
    storage: {
      async get<T>(key: string) { return values.get(key) as T | undefined; },
      async put<T>(key: string, value: T) { values.set(key, value); },
    },
  };
  const object = new StatsDurableObject(state, {});
  let idCalls = 0;
  return {
    values,
    get idCalls() { return idCalls; },
    idFromName(name: string) {
      idCalls += 1;
      assert.equal(name, expectedInstallationId);
      return name;
    },
    get() {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          return object.fetch(new Request(String(input), init));
        },
      };
    },
  };
}

test("health check identifies production without resolving DNS", async () => {
  let calls = 0;
  const worker = makeWorker(undefined, async () => { calls += 1; return new Response(null, { status: 500 }); });
  const result = await worker.fetch(new Request("https://worker.example.test/healthz"), { DEPLOYMENT_ENV: "production" }, context());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: "ok", environment: "production" });
  assert.equal(calls, 0);
});

test("access policy exposes the Worker-authoritative subscription requirement", async () => {
  const worker = makeWorker(undefined, undefined, {
    subscriptionIsRequired: async () => false,
  });
  const response = await worker.fetch(
    new Request("https://worker.example.test/v1/access-policy"),
    {},
    context(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subscriptionRequired: false });
  assert.equal(
    (await worker.fetch(new Request("https://worker.example.test/v1/access-policy", { method: "POST" }), {}, context())).status,
    405,
  );
});

test("access policy fails closed when ConfigCat is not configured", async () => {
  assert.equal(await subscriptionIsRequired({}), true);
});

test("accepts valid POST and GET DoH messages with the wire content type", async () => {
  const incoming = query();
  let calls = 0;
  const worker = makeWorker(incoming.length ? "ads.example.com\ntracker.example.net\n" : "", async (url) => {
    calls += 1;
    assert.equal(url, "https://cloudflare-dns.com/dns-query");
    return new Response(binaryBody(response(incoming)), { status: 200, headers: { "content-type": "application/dns-message" } });
  });
  const post = await worker.fetch(requestFor(incoming), {}, context());
  assert.equal(post.status, 200);
  assert.equal(post.headers.get("content-type"), "application/dns-message");
  assert.deepEqual(new Uint8Array(await post.arrayBuffer()), response(incoming));
  const encoded = Buffer.from(incoming).toString("base64url");
  const get = await worker.fetch(new Request(`https://worker.example.test/${TOKEN}/dns-query?dns=${encoded}`), {}, context());
  assert.equal(get.status, 200);
  assert.equal(calls, 1, "GET should be served from the compatible cache");
});

test("does not serve an upstream response after its TTL expires", async () => {
  let clock = 1_000;
  let calls = 0;
  const incoming = query("ttl.example.com");
  const worker = makeWorker(undefined, async () => {
    calls += 1;
    return new Response(binaryBody(response(incoming, 1, 0, 1)), {
      headers: { "content-type": "application/dns-message" },
    });
  }, { now: () => clock });
  await worker.fetch(requestFor(incoming), {}, context());
  clock += 999;
  await worker.fetch(requestFor(incoming), {}, context());
  assert.equal(calls, 1);
  clock += 2;
  await worker.fetch(requestFor(incoming), {}, context());
  assert.equal(calls, 2);
});

test("cache hit replaces the upstream transaction ID with the current query ID", async () => {
  const first = query("same-cache-key.example.com", 1, 0x1111);
  const second = query("same-cache-key.example.com", 1, 0x2222);
  let clock = 1_000;
  let calls = 0;
  const worker = makeWorker(undefined, async (_url, init) => {
    calls += 1;
    const incoming = new Uint8Array(init?.body as ArrayBuffer);
    return new Response(binaryBody(response(incoming, 1, 0, 60)), {
      headers: { "content-type": "application/dns-message" },
    });
  }, { now: () => clock });

  const firstResponse = await worker.fetch(requestFor(first), {}, context());
  clock += 10_001;
  const secondResponse = await worker.fetch(requestFor(second), {}, context());
  assert.equal(parseDNSMessage(new Uint8Array(await firstResponse.arrayBuffer()), 1).id, 0x1111);
  const cached = parseDNSMessage(new Uint8Array(await secondResponse.arrayBuffer()), 1);
  assert.equal(cached.id, 0x2222);
  assert.equal(cached.records[0].ttl, 50);
  assert.equal(calls, 1);
});

test("does not share the in-memory response cache between installation tokens", async () => {
  const incoming = query("token-scoped-cache.example.com");
  let calls = 0;
  const worker = makeWorker(undefined, async (_url, init) => {
    calls += 1;
    const request = new Uint8Array(init?.body as ArrayBuffer);
    return new Response(binaryBody(response(request)), {
      headers: { "content-type": "application/dns-message" },
    });
  });

  await worker.fetch(requestFor(incoming), {}, context());
  await worker.fetch(requestForToken(incoming, OTHER_TOKEN), {}, context());
  assert.equal(calls, 2);
});

test("blocks exact names and descendants, but not lookalikes, without contacting an upstream", async () => {
  let calls = 0;
  const worker = makeWorker(undefined, async () => { calls += 1; return new Response(binaryBody(response(query("notads.example.com"))), { headers: { "content-type": "application/dns-message" } }); });
  const blockedContext = context();
  const blocked = await worker.fetch(requestFor(query("sub.ads.example.com")), {}, blockedContext);
  assert.equal(blocked.status, 200);
  assert.equal(parseDNSMessage(new Uint8Array(await blocked.arrayBuffer()), 1).questions[0].name, "sub.ads.example.com");
  assert.equal(calls, 0);
  const similar = await worker.fetch(requestFor(query("notads.example.com")), {}, context());
  assert.equal(similar.status, 200);
  assert.equal(calls, 1);
  await Promise.all(blockedContext.pending);
});

test("normalizes IDN names to the same A-label representation as the blocklist", () => {
  const normalized = normalizeDomain("Bücher.Example.");
  assert.equal(normalized, "xn--bcher-kva.example");
  assert.equal(normalizeDomain("example.com.."), null);
  const list = createBlocklist("xn--bcher-kva.example\n", metadata("xn--bcher-kva.example\n"));
  assert.equal(list.has("bücher.example."), true);
  assert.equal(list.has("other.example"), false);
});

test("keeps the transaction ID and EDNS record in a synthesized blocked response", async () => {
  const incoming = query("ads.example.com", 28, 0xbeef, true);
  const worker = makeWorker();
  const result = await worker.fetch(requestFor(incoming), {}, context());
  const bytes = new Uint8Array(await result.arrayBuffer());
  const parsed = parseDNSMessage(bytes, 1);
  assert.equal(parsed.id, 0xbeef);
  assert.equal(parsed.questions[0].type, 28);
  assert.equal(parsed.additionals.length, 1);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].ttl, BLOCKED_RESPONSE_TTL);
});

test("does not fallback after a valid NXDOMAIN response", async () => {
  const incoming = query("unknown.example.com");
  const calls: string[] = [];
  const worker = makeWorker(undefined, async (url) => {
    calls.push(String(url));
    return new Response(binaryBody(response(incoming, 1, 3)), { status: 200, headers: { "content-type": "application/dns-message" } });
  });
  const result = await worker.fetch(requestFor(incoming), {}, context());
  assert.equal(result.status, 200);
  assert.equal(parseDNSMessage(new Uint8Array(await result.arrayBuffer()), 1).flags & 0xf, 3);
  assert.deepEqual(calls, ["https://cloudflare-dns.com/dns-query"]);
});

test("accepts the DNS query types used by browsers and applications", async () => {
  const types = [1, 28, 65, 64, 5, 16, 15, 2, 12, 6, 33];
  const worker = makeWorker(undefined, async (_url, init) => {
    const body = init?.body as ArrayBuffer;
    const incoming = new Uint8Array(body);
    return new Response(binaryBody(response(incoming, parseDNSMessage(incoming, 0).questions[0].type)), {
      status: 200,
      headers: { "content-type": "application/dns-message" },
    });
  });
  for (const [index, type] of types.entries()) {
    const result = await worker.fetch(requestFor(query(`type-${index}.example.com`, type)), {}, context());
    assert.equal(result.status, 200);
    assert.equal(parseDNSMessage(new Uint8Array(await result.arrayBuffer()), 1).questions[0].type, type);
  }
});

test("keeps concurrent responses isolated by transaction ID", async () => {
  const worker = makeWorker(undefined, async (_url, init) => {
    const incoming = new Uint8Array(init?.body as ArrayBuffer);
    return new Response(binaryBody(response(incoming)), {
      headers: { "content-type": "application/dns-message" },
    });
  });
  const requests = Array.from({ length: 32 }, (_, index) => query(`parallel-${index}.example.com`, 1, 0x4000 + index));
  const responses = await Promise.all(requests.map((request) => worker.fetch(requestFor(request), {}, context())));
  for (const [index, result] of responses.entries()) {
    assert.equal(result.status, 200);
    assert.equal(parseDNSMessage(new Uint8Array(await result.arrayBuffer()), 1).id, 0x4000 + index);
  }
});

test("uses Quad9 after primary transport failure and returns SERVFAIL if both fail", async () => {
  const incoming = query("allowed.example.com");
  const calls: string[] = [];
  const worker = makeWorker(undefined, async (url) => {
    calls.push(String(url));
    if (String(url).includes("cloudflare")) throw new Error("timeout");
    return new Response(binaryBody(response(incoming)), { status: 200, headers: { "content-type": "application/dns-message" } });
  });
  const fallback = await worker.fetch(requestFor(incoming), {}, context());
  assert.equal(fallback.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /quad9/);

  const failedWorker = makeWorker(undefined, async () => { throw new Error("network down"); });
  const failed = await failedWorker.fetch(requestFor(query("another.example.com")), {}, context());
  assert.equal(parseDNSMessage(new Uint8Array(await failed.arrayBuffer()), 1).flags & 0xf, 2);
});

test("falls back after an invalid upstream HTTP content type", async () => {
  const incoming = query("invalid-http.example.com");
  const calls: string[] = [];
  const worker = makeWorker(undefined, async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("not dns", { status: 200, headers: { "content-type": "text/plain" } });
    return new Response(binaryBody(response(incoming)), { headers: { "content-type": "application/dns-message" } });
  });
  const result = await worker.fetch(requestFor(incoming), {}, context());
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
});

test("falls back after an invalid upstream DNS payload", async () => {
  const incoming = query("invalid-dns.example.com");
  const calls: string[] = [];
  const worker = makeWorker(undefined, async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-type": "application/dns-message" } });
    return new Response(binaryBody(response(incoming)), { headers: { "content-type": "application/dns-message" } });
  });
  const result = await worker.fetch(requestFor(incoming), {}, context());
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /quad9/);
});

test("rejects malformed payloads, oversized requests, and unsupported methods", async () => {
  const worker = makeWorker();
  const malformed = await worker.fetch(requestFor(Uint8Array.from([1, 2, 3])), {}, context());
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("content-type"), "application/dns-message");
  const tooLarge = await worker.fetch(requestFor(new Uint8Array(4097)), {}, context());
  assert.equal(tooLarge.status, 413);
  const badMethod = await worker.fetch(requestFor(query(), "PUT"), {}, context());
  assert.equal(badMethod.status, 405);
  const badContentType = await worker.fetch(requestFor(query(), "POST", { "content-type": "application/json" }), {}, context());
  assert.equal(badContentType.status, 415);
  assert.equal((await worker.fetch(new Request("https://worker.example.test/healthz", { method: "PUT" }), {}, context())).status, 405);
});

test("applies rate limiting without persisting the client IP", async () => {
  const worker = makeWorker(undefined, async () => new Response(binaryBody(response(query())), { headers: { "content-type": "application/dns-message" } }), { rateLimit: 1 });
  const headers = { "cf-connecting-ip": "203.0.113.10" };
  assert.equal((await worker.fetch(requestFor(query(), "POST", headers), {}, context())).status, 200);
  assert.equal((await worker.fetch(requestFor(query("second.example.com"), "POST", headers), {}, context())).status, 429);
});

test("rejects a blocklist whose metadata count or checksum is invalid", async () => {
  const text = "ads.example.com\n";
  const worker = createDNSWorker(text, { ...metadata(text), domainCount: 2 }, {
    fetch: async () => new Response(null, { status: 500 }),
    authorizeToken: async () => ({ kind: "active", installationId: INSTALLATION_ID, accessUntil: Number.MAX_SAFE_INTEGER }),
  });
  const result = await worker.fetch(requestFor(query("allowed.example.com")), {}, context());
  assert.equal(result.status, 500);
});

test("never uses a plaintext DNS upstream", async () => {
  const worker = makeWorker(undefined, async (url) => {
    assert.match(String(url), /^https:\/\//);
    return new Response(binaryBody(response(query())), { headers: { "content-type": "application/dns-message" } });
  });
  await worker.fetch(requestFor(query("safe.example.com")), {}, context());
});

test("stores only an aggregate blocked total in the stats object", async () => {
  const values = new Map<string, unknown>();
  const state = {
    storage: {
      async get<T>(key: string) { return values.get(key) as T | undefined; },
      async put<T>(key: string, value: T) { values.set(key, value); },
    },
  };
  const object = new StatsDurableObject(state, {});
  assert.equal((await object.fetch(new Request("https://stats/increment", { method: "POST", body: '{"increment":1}' }))).status, 204);
  const result = await object.fetch(new Request("https://stats/total"));
  assert.deepEqual(await result.json(), { blockedTotal: 1, updatedAt: values.get("updatedAt") });
  assert.deepEqual([...values.keys()].sort(), ["blockedTotal", "updatedAt"]);
});

test("stores blocking preference separately and defaults it to enabled", async () => {
  const storage = new MemoryDOStorage();
  const object = new StatsDurableObject({ storage }, {});

  const initial = await object.fetch(new Request("https://stats/blocking"));
  assert.deepEqual(await initial.json(), { blockingEnabled: true });

  const paused = await object.fetch(new Request("https://stats/blocking", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blockingEnabled: false }),
  }));
  assert.deepEqual(await paused.json(), { blockingEnabled: false });
  assert.equal(storage.values.get("blockingEnabled"), false);
});

test("authenticates stats with the installation token", async () => {
  const namespace = {
    idFromName(name: string) {
      assert.equal(name, INSTALLATION_ID);
      return name;
    },
    get() {
      return {
        async fetch(input: RequestInfo | URL) {
          assert.equal(String(input), "https://stats/total");
          return new Response(JSON.stringify({ blockedTotal: 8, updatedAt: "2026-08-26T00:00:00.000Z" }), {
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  };
  const worker = makeWorker();
  const unauthorized = await worker.fetch(new Request("https://worker.example.test/v1/stats"), { STATS: namespace }, context());
  assert.equal(unauthorized.status, 401);
  const authorized = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${TOKEN}` },
  }), { STATS: namespace }, context());
  assert.deepEqual(await authorized.json(), { blockedTotal: 8, updatedAt: "2026-08-26T00:00:00.000Z" });
});

test("does not expose DNS responses to shared HTTP caches", async () => {
  const worker = makeWorker(undefined, async () => new Response(binaryBody(response(query())), {
    headers: { "content-type": "application/dns-message" },
  }));
  const result = await worker.fetch(requestFor(query("cache-header.example.com")), {}, context());
  assert.equal(result.headers.get("cache-control"), "no-store");
});

test("a valid authorized installation blocks DNS and records stats by installation", async () => {
  const kv = new MemoryKV();
  const credentials = await registerTestInstallation(kv);
  const stats = statsNamespace(INSTALLATION_ID);
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", metadata("ads.example.com\n"), {
    now: () => AUTH_NOW,
    fetch: async () => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(query("ads.example.com"))), {
        headers: { "content-type": "application/dns-message" },
      });
    },
  });
  const env = { ...environmentForAuthorization(kv), STATS: stats };
  const requestContext = context();
  const result = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), env, requestContext);
  assert.equal(result.status, 200);
  assert.equal(upstreamCalls, 0);
  await Promise.all(requestContext.pending);
  const statsResult = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${credentials.statsToken}` },
  }), env, context());
  assert.equal(statsResult.status, 200);
  assert.equal((await statsResult.json() as { blockedTotal: number }).blockedTotal, 1);
  assert.equal(stats.idCalls, 3);
});

test("active and paused transitions cap pass-through A/AAAA TTLs without stale cache or stats", async () => {
  const kv = new MemoryKV();
  const credentials = await registerTestInstallation(kv);
  const stats = statsNamespace(INSTALLATION_ID);
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", metadata("ads.example.com\n"), {
    now: () => AUTH_NOW,
    fetch: async (_url, init) => {
      upstreamCalls += 1;
      const incoming = new Uint8Array(init?.body as ArrayBuffer);
      const type = parseDNSMessage(incoming, 0).questions[0].type;
      const ttl = type === 28 ? 600 : 300;
      return new Response(binaryBody(response(incoming, type, 0, ttl)), {
        headers: { "content-type": "application/dns-message" },
      });
    },
  });
  const env = { ...environmentForAuthorization(kv), STATS: stats };

  const activeAllowed = await worker.fetch(
    requestForToken(query("allowed.example.com", 1, 0x1111), credentials.dnsToken),
    env,
    context(),
  );
  assert.equal(parseDNSMessage(new Uint8Array(await activeAllowed.arrayBuffer()), 1).records[0].ttl, 300,
    "active allowed responses must retain the upstream TTL");
  const cachedAllowed = await worker.fetch(
    requestForToken(query("allowed.example.com", 1, 0x2222), credentials.dnsToken),
    env,
    context(),
  );
  assert.equal(parseDNSMessage(new Uint8Array(await cachedAllowed.arrayBuffer()), 1).id, 0x2222);
  assert.equal(upstreamCalls, 1, "active allowed A responses should use the internal cache");

  const activeAllowedAAAA = await worker.fetch(
    requestForToken(query("allowed.example.com", 28, 0x1112), credentials.dnsToken),
    env,
    context(),
  );
  assert.equal(parseDNSMessage(new Uint8Array(await activeAllowedAAAA.arrayBuffer()), 1).records[0].ttl, 600,
    "active allowed AAAA responses must retain the upstream TTL");
  const cachedAllowedAAAA = await worker.fetch(
    requestForToken(query("allowed.example.com", 28, 0x2223), credentials.dnsToken),
    env,
    context(),
  );
  assert.equal(parseDNSMessage(new Uint8Array(await cachedAllowedAAAA.arrayBuffer()), 1).id, 0x2223);
  assert.equal(upstreamCalls, 2, "active allowed AAAA responses should use the internal cache");

  const initiallyBlockedContext = context();
  await worker.fetch(
    requestForToken(query("ads.example.com", 1, 0x3001), credentials.dnsToken),
    env,
    initiallyBlockedContext,
  );
  await worker.fetch(
    requestForToken(query("ads.example.com", 28, 0x3002), credentials.dnsToken),
    env,
    initiallyBlockedContext,
  );
  await Promise.all(initiallyBlockedContext.pending);
  assert.equal(stats.values.get("blockedTotal"), 2);

  const wrongRole = await worker.fetch(new Request("https://worker.example.test/v1/blocking", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${credentials.dnsToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ blockingEnabled: false }),
  }), env, context());
  assert.equal(wrongRole.status, 401);

  const pause = await worker.fetch(new Request("https://worker.example.test/v1/blocking", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${credentials.statsToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ blockingEnabled: false }),
  }), env, context());
  assert.equal(pause.status, 200);
  assert.deepEqual(await pause.json(), { blockingEnabled: false });
  const persistedPause = await worker.fetch(new Request("https://worker.example.test/v1/blocking", {
    headers: { authorization: `Bearer ${credentials.statsToken}` },
  }), env, context());
  assert.deepEqual(await persistedPause.json(), { blockingEnabled: false });

  const pausedAContext = context();
  const passThroughA = await worker.fetch(
    requestForToken(query("ads.example.com", 1, 0x4001), credentials.dnsToken),
    env,
    pausedAContext,
  );
  const parsedA = parseDNSMessage(new Uint8Array(await passThroughA.arrayBuffer()), 1);
  assert.equal(parsedA.id, 0x4001);
  assert.equal(parsedA.records[0].type, 1);
  assert.equal(parsedA.records[0].ttl, BLOCKED_RESPONSE_TTL);
  assert.equal(pausedAContext.pending.length, 0, "paused A queries must not increment statistics");

  const repeatedPausedA = await worker.fetch(
    requestForToken(query("ads.example.com", 1, 0x4002), credentials.dnsToken),
    env,
    context(),
  );
  assert.equal(parseDNSMessage(new Uint8Array(await repeatedPausedA.arrayBuffer()), 1).id, 0x4002);

  const pausedAAAAContext = context();
  const passThroughAAAA = await worker.fetch(
    requestForToken(query("ads.example.com", 28, 0x4003), credentials.dnsToken),
    env,
    pausedAAAAContext,
  );
  const parsedAAAA = parseDNSMessage(new Uint8Array(await passThroughAAAA.arrayBuffer()), 1);
  assert.equal(parsedAAAA.id, 0x4003);
  assert.equal(parsedAAAA.records[0].type, 28);
  assert.equal(parsedAAAA.records[0].ttl, BLOCKED_RESPONSE_TTL);
  assert.equal(pausedAAAAContext.pending.length, 0, "paused AAAA queries must not increment statistics");
  assert.equal(upstreamCalls, 5, "paused A/AAAA queries must bypass the internal response cache");
  assert.equal(stats.values.get("blockedTotal"), 2);

  const resume = await worker.fetch(new Request("https://worker.example.test/v1/blocking", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${credentials.statsToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ blockingEnabled: true }),
  }), env, context());
  assert.equal(resume.status, 200);

  const activeContext = context();
  const blockedA = await worker.fetch(
    requestForToken(query("ads.example.com", 1, 0x5001), credentials.dnsToken),
    env,
    activeContext,
  );
  const blockedAAAA = await worker.fetch(
    requestForToken(query("ads.example.com", 28, 0x5002), credentials.dnsToken),
    env,
    activeContext,
  );
  assert.equal(parseDNSMessage(new Uint8Array(await blockedA.arrayBuffer()), 1).id, 0x5001);
  assert.equal(parseDNSMessage(new Uint8Array(await blockedAAAA.arrayBuffer()), 1).id, 0x5002);
  assert.equal(upstreamCalls, 5, "resumed blocking must apply to A/AAAA without using paused responses");
  await Promise.all(activeContext.pending);
  assert.equal(stats.values.get("blockedTotal"), 4);
});

test("malformed StoreKit JWS cannot issue authorization credentials", async () => {
  const kv = new MemoryKV();
  const result = await handleAuthorizationRegister(
    new Request("https://worker.example.test/v1/authorization/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: INSTALLATION_ID,
        transactionJWS: "not-a-storekit-jws",
        rotationNonce: ROTATION_NONCE,
      }),
    }),
    environmentForAuthorization(kv),
  );
  assert.equal(result.status, 401);
  assert.equal(kv.values.size, 0);
});

test("disabled subscription requirement issues credentials without StoreKit", async () => {
  const kv = new MemoryKV();
  const request = new Request("https://worker.example.test/v1/authorization/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      transactionJWS: "",
      rotationNonce: ROTATION_NONCE,
    }),
  });
  const registration = await handleAuthorizationRegister(
    request,
    environmentForAuthorization(kv),
    { now: () => AUTH_NOW, subscriptionRequired: false },
  );
  assert.equal(registration.status, 200);
  const credentials = await registration.json() as { dnsToken: string; statsToken: string };

  assert.equal(
    (await authorizeToken(environmentForAuthorization(kv), credentials.dnsToken, "dns", AUTH_NOW, false)).kind,
    "active",
  );
  assert.equal(
    (await authorizeToken(environmentForAuthorization(kv), credentials.statsToken, "stats", AUTH_NOW, false)).kind,
    "active",
  );
  assert.equal(
    (await authorizeToken(environmentForAuthorization(kv), credentials.dnsToken, "dns", AUTH_NOW, true)).kind,
    "passThrough",
  );
  assert.equal(
    (await authorizeToken(environmentForAuthorization(kv), credentials.statsToken, "stats", AUTH_NOW, true)).kind,
    "rejected",
  );

  const unauthorizedRotation = await handleAuthorizationRegister(
    new Request("https://worker.example.test/v1/authorization/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: INSTALLATION_ID,
        transactionJWS: "",
        rotationNonce: OTHER_ROTATION_NONCE,
      }),
    }),
    environmentForAuthorization(kv),
    { now: () => AUTH_NOW + 1, subscriptionRequired: false },
  );
  assert.equal(unauthorizedRotation.status, 401);
  assert.equal(
    (await authorizeToken(environmentForAuthorization(kv), credentials.dnsToken, "dns", AUTH_NOW + 1, false)).kind,
    "active",
  );
});

test("subscription-disabled registration fails closed when subscription is required", async () => {
  const kv = new MemoryKV();
  const response = await handleAuthorizationRegister(
    new Request("https://worker.example.test/v1/authorization/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: INSTALLATION_ID,
        transactionJWS: "",
        rotationNonce: ROTATION_NONCE,
      }),
    }),
    environmentForAuthorization(kv),
    { now: () => AUTH_NOW, subscriptionRequired: true },
  );
  assert.equal(response.status, 400);
  assert.equal(kv.values.size, 0);
});

test("unknown tokens are rejected before loading remote access policy", async () => {
  const kv = new MemoryKV();
  let policyCalls = 0;
  const result = await authorizeToken(
    environmentForAuthorization(kv),
    TOKEN,
    "dns",
    AUTH_NOW,
    async () => {
      policyCalls += 1;
      return false;
    },
  );
  assert.deepEqual(result, { kind: "rejected", reason: "unknown" });
  assert.equal(policyCalls, 0);
});

test("single-certificate Xcode JWS requires one of the explicitly pinned signing certificates", async () => {
  const keys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const verificationTime = new Date("2026-09-06T12:00:00Z");
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=StoreKit Test",
    notBefore: new Date("2026-09-05T00:00:00Z"),
    notAfter: new Date("2027-09-05T00:00:00Z"),
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys: keys as CryptoKeyPair,
  }, webcrypto as unknown as Crypto);
  const certificateBytes = new Uint8Array(certificate.rawData);
  const fingerprint = createHash("sha256").update(certificateBytes).digest("hex");
  const jws = await new SignJWT({ environment: "Xcode", bundleId: "com.orbeworks.adless.dev" })
    .setProtectedHeader({
      alg: "ES256",
      x5c: [Buffer.from(certificateBytes).toString("base64")],
    })
    .sign(keys.privateKey);

  const payload = await verifyAppleJWS<{ environment: string; bundleId: string }>(jws, {
    trustedLeafCertificateSHA256: `${"0".repeat(64)}, ${fingerprint}`,
    verificationTime,
  });
  assert.deepEqual(payload, { environment: "Xcode", bundleId: "com.orbeworks.adless.dev" });
  await assert.rejects(verifyAppleJWS(jws, {
    trustedLeafCertificateSHA256: "0".repeat(64),
    verificationTime,
  }));
  await assert.rejects(verifyAppleJWS(jws, { verificationTime }));
});

test("authorization fails closed when the token derivation secret is absent", async () => {
  const kv = new MemoryKV();
  const result = await authorizationResponse(kv, INSTALLATION_ID, testTransaction(), {
    ...AUTH_ENV,
    AUTH_TOKEN_DERIVATION_SECRET: undefined,
  });
  assert.equal(result.status, 401);
  assert.equal(kv.values.size, 0);
});

test("unknown tokens are rejected before cache, Durable Object, and upstream", async () => {
  const kv = new MemoryKV();
  const credentials = await registerTestInstallation(kv);
  const stats = statsNamespace(INSTALLATION_ID);
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", metadata("ads.example.com\n"), {
    fetch: async () => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(query())), { headers: { "content-type": "application/dns-message" } });
    },
  });
  const env = {
    ...environmentForAuthorization(kv),
    STATS: stats,
  };
  const cached = await worker.fetch(requestForToken(query(), credentials.dnsToken), env, context());
  assert.equal(cached.status, 200);
  assert.equal(upstreamCalls, 1, "the authorized request must populate the DNS response cache");
  const authorityCallsBeforeUnknown = kv.authority.idCalls;
  const result = await worker.fetch(requestForToken(query(), "u".repeat(43)), {
    ...env,
  }, context());
  assert.equal(result.status, 401);
  assert.equal(upstreamCalls, 1, "an unknown token must be rejected before the populated DNS cache and upstream");
  assert.equal(kv.authority.idCalls, authorityCallsBeforeUnknown, "an unknown token must be rejected before authority DO lookup");
  assert.equal(stats.idCalls, 0, "an unknown token must not read blocking state");
});

test("KV outages degrade known credentials to DNS pass-through and deny stats", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 1_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  const stats = statsNamespace(INSTALLATION_ID);
  let clock = AUTH_NOW;
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", metadata("ads.example.com\n"), {
    now: () => clock,
    fetch: async (_url, init) => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(new Uint8Array(init?.body as ArrayBuffer))), { headers: { "content-type": "application/dns-message" } });
    },
  });
  const env = { ...environmentForAuthorization(kv), STATS: stats };

  await worker.fetch(requestForToken(query("safe.example.com"), credentials.dnsToken), env, context());
  const availableStats = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${credentials.statsToken}` },
  }), env, context());
  assert.equal(availableStats.status, 200);
  assert.equal(stats.idCalls, 2);

  kv.unavailable = true;
  clock = AUTH_NOW + 500;
  const passThroughContext = context();
  const passThrough = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), env, passThroughContext);
  assert.equal(passThrough.status, 200);
  assert.equal(upstreamCalls, 2, "a cached known token must use the upstream instead of retaining active blocking");
  assert.equal(passThroughContext.pending.length, 0);
  assert.equal(stats.idCalls, 2, "DNS pass-through must not read blocking state or increment statistics");

  const unavailableStats = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${credentials.statsToken}` },
  }), env, context());
  assert.equal(unavailableStats.status, 401, "cached active authorization must not expose stats during a KV outage");
  assert.equal(stats.idCalls, 2);

  const unknown = await worker.fetch(requestForToken(query("safe.example.com"), "u".repeat(43)), env, context());
  assert.equal(unknown.status, 503);
  assert.equal(upstreamCalls, 2, "an unknown token never fails open during a KV outage");

  clock = AUTH_NOW + 62_000;
  const expired = await worker.fetch(requestForToken(query("safe.example.com"), credentials.dnsToken), env, context());
  assert.equal(expired.status, 200);
  assert.equal(upstreamCalls, 3, "a known token keeps resolving without blocking after its cached entitlement expires");
});

test("DNS and stats credentials cannot be used for the other endpoint", async () => {
  const kv = new MemoryKV();
  const credentials = await registerTestInstallation(kv);
  const stats = statsNamespace(INSTALLATION_ID);
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", metadata("ads.example.com\n"), {
    fetch: async () => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(query())), { headers: { "content-type": "application/dns-message" } });
    },
  });
  const env = { ...environmentForAuthorization(kv), STATS: stats };
  const dnsWithStatsToken = await worker.fetch(requestForToken(query(), credentials.statsToken), env, context());
  const statsWithDNS = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${credentials.dnsToken}` },
  }), env, context());
  assert.equal(dnsWithStatsToken.status, 401);
  assert.equal(statsWithDNS.status, 401);
  assert.equal(upstreamCalls, 0);
  assert.equal(stats.idCalls, 0);
});

test("cancellation keeps DNS blocking until the paid period expires", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 100_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  await processAppleNotification(
    environmentForAuthorization(kv),
    testNotification({ notificationType: "DID_CHANGE_RENEWAL_STATUS" }),
    transaction,
    { environment: "Production", originalTransactionId: transaction.originalTransactionId, autoRenewStatus: 0 },
    AUTH_NOW + 1_000,
  );
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", metadata("ads.example.com\n"), {
    now: () => AUTH_NOW + 1_000,
    fetch: async () => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(query("ads.example.com"))), { headers: { "content-type": "application/dns-message" } });
    },
  });
  const result = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), environmentForAuthorization(kv), context());
  assert.equal(result.status, 200);
  assert.equal(upstreamCalls, 0);
});

test("grace period keeps the installation active while billing retry is recorded", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 1_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  await processAppleNotification(
    environmentForAuthorization(kv),
    testNotification({ notificationType: "DID_FAIL_TO_RENEW" }),
    transaction,
    {
      environment: "Production",
      originalTransactionId: transaction.originalTransactionId,
      gracePeriodExpiresDate: AUTH_NOW + 10_000,
      isInBillingRetryPeriod: true,
    },
    AUTH_NOW + 2_000,
  );
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", metadata("ads.example.com\n"), {
    now: () => AUTH_NOW + 2_000,
    fetch: async () => {
      upstreamCalls += 1;
      return new Response(null, { status: 500 });
    },
  });
  const result = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), environmentForAuthorization(kv), context());
  assert.equal(result.status, 200);
  assert.equal(parseDNSMessage(new Uint8Array(await result.arrayBuffer()), 1).flags & 0xf, 0);
  assert.equal(upstreamCalls, 0);
});

test("revocation independently moves an active installation to DNS pass-through", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 100_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  const env = environmentForAuthorization(kv);
  await processAppleNotification(
    env,
    testNotification({ notificationType: "REVOKE" }),
    { ...transaction, revocationDate: AUTH_NOW + 2_000 },
    undefined,
    AUTH_NOW + 2_000,
  );

  const stats = statsNamespace(INSTALLATION_ID);
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", { ...metadata("ads.example.com\n"), domainCount: 2 }, {
    now: () => AUTH_NOW + 2_000,
    fetch: async () => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(query("ads.example.com"))), { headers: { "content-type": "application/dns-message" } });
    },
  });
  const revokedEnv = { ...env, STATS: stats };
  const requestContext = context();
  const dnsResult = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), revokedEnv, requestContext);
  assert.equal(dnsResult.status, 200);
  assert.equal(upstreamCalls, 1, "revocation must bypass the invalid blocklist and reach the upstream");
  assert.equal(requestContext.pending.length, 0);

  const statsResult = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${credentials.statsToken}` },
  }), revokedEnv, context());
  assert.equal(statsResult.status, 401);
  assert.equal(stats.idCalls, 0);
});

test("expiration resolves DNS without blocking or collecting stats", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 1_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  await processAppleNotification(
    environmentForAuthorization(kv),
    testNotification({ notificationType: "EXPIRED" }),
    { ...transaction, expiresDate: AUTH_NOW + 1_000 },
    undefined,
    AUTH_NOW + 2_000,
  );
  const stats = statsNamespace(INSTALLATION_ID);
  let upstreamCalls = 0;
  const blocklistMetadata = { ...metadata("ads.example.com\n"), domainCount: 2 };
  const worker = createDNSWorker("ads.example.com\n", blocklistMetadata, {
    now: () => AUTH_NOW + 2_000,
    rateLimit: 1,
    fetch: async () => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(query("ads.example.com"))), { headers: { "content-type": "application/dns-message" } });
    },
  });
  const env = { ...environmentForAuthorization(kv), STATS: stats };
  const firstContext = context();
  const first = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), env, firstContext);
  const secondContext = context();
  const second = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), env, secondContext);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls, 2, "an expired installation must bypass rate limiting, the invalid blocklist, and DNS response cache");
  assert.equal(firstContext.pending.length, 0);
  assert.equal(secondContext.pending.length, 0);
  const statsResult = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${credentials.statsToken}` },
  }), env, context());
  assert.equal(statsResult.status, 401);
  assert.equal(stats.idCalls, 0);
});

test("App Store Server Notifications V2 update refund and revocation status", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 100_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  const notification = testNotification({
    notificationType: "REFUND",
    data: {
      appAppleId: 6_803_552_143,
      bundleId: "com.orbeworks.adless",
      environment: "Production",
      signedTransactionInfo: "signed-transaction-jws",
    },
  });
  const env = environmentForAuthorization(kv);
  const notificationResult = await handleAppleNotification(
    new Request("https://worker.example.test/v1/notifications/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "signed-notification-jws" }),
    }),
    env,
    {
      verifyNotification: async () => notification,
      verifyTransaction: async () => ({ ...transaction, revocationDate: AUTH_NOW + 2_000 }),
      now: () => AUTH_NOW + 2_000,
    },
  );
  assert.equal(notificationResult.status, 200);
  const stats = statsNamespace(INSTALLATION_ID);
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", { ...metadata("ads.example.com\n"), domainCount: 2 }, {
    now: () => AUTH_NOW + 2_000,
    fetch: async (_url, init) => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(new Uint8Array(init?.body as ArrayBuffer))), { headers: { "content-type": "application/dns-message" } });
    },
  });
  const refundEnv = { ...env, STATS: stats };
  const refunded = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), refundEnv, context());
  assert.equal(refunded.status, 200);
  assert.equal(upstreamCalls, 1, "a refunded installation must resolve through the upstream");
  assert.equal(stats.idCalls, 0, "a refunded installation must not record statistics");
  const refundedStats = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${credentials.statsToken}` },
  }), refundEnv, context());
  assert.equal(refundedStats.status, 401);

  const revokeNotification = testNotification({
    notificationType: "REVOKE",
    notificationUUID: "notification-2",
    data: {
      appAppleId: 6_803_552_143,
      bundleId: "com.orbeworks.adless",
      environment: "Production",
      signedTransactionInfo: "signed-transaction-jws",
    },
  });
  const revokeResult = await handleAppleNotification(
    new Request("https://worker.example.test/v1/notifications/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "signed-notification-jws-2" }),
    }),
    env,
    {
      verifyNotification: async () => revokeNotification,
      verifyTransaction: async () => ({ ...transaction, revocationDate: AUTH_NOW + 3_000 }),
      now: () => AUTH_NOW + 3_000,
    },
  );
  assert.equal(revokeResult.status, 200);
  const revoked = await worker.fetch(requestForToken(query("ads.example.com"), credentials.dnsToken), refundEnv, context());
  assert.equal(revoked.status, 200);
  assert.equal(upstreamCalls, 2, "a revoked installation must resolve through the upstream");
  const revokedStats = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${credentials.statsToken}` },
  }), refundEnv, context());
  assert.equal(revokedStats.status, 401);
  assert.equal(stats.idCalls, 0, "a revoked installation must neither increment nor read statistics");
});

test("revocationDate remains authoritative under a later non-revocation notification", async (context) => {
  for (const adverseType of ["REFUND", "REVOKE"]) {
    await context.test(adverseType, async () => {
      const kv = new MemoryKV();
      const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
      const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
      const revokedTransaction = { ...transaction, revocationDate: AUTH_NOW + 500 };
      const env = environmentForAuthorization(kv);

      await processAppleNotification(
        env,
        testNotification({
          notificationType: adverseType,
          notificationUUID: `notification-${adverseType.toLowerCase()}-first`,
          signedDate: 1_100_000,
        }),
        revokedTransaction,
        undefined,
        AUTH_NOW + 1_000,
      );
      await processAppleNotification(
        env,
        testNotification({
          notificationType: "DID_CHANGE_RENEWAL_STATUS",
          notificationUUID: `notification-${adverseType.toLowerCase()}-later`,
          signedDate: 1_200_000,
        }),
        { ...revokedTransaction, signedDate: 1_150_000 },
        undefined,
        AUTH_NOW + 2_000,
      );

      assert.equal((await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 2_000)).kind, "passThrough");
      assert.equal((await authorizeToken(env, credentials.statsToken, "stats", AUTH_NOW + 2_000)).kind, "rejected");
      assert.equal(latestAuthorityEvent(kv)?.status, "revoked");
    });
  }
});

test("an exact retry with the same nonce recovers the same credentials", async () => {
  const kv = new MemoryKV();
  const credentials = await registerTestInstallation(kv);
  const storedEntryCount = kv.values.size;
  const retry = await authorizationResponse(kv);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), credentials);
  assert.equal(kv.values.size, storedEntryCount, "an idempotent retry must not mutate authorization state");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), credentials.dnsToken, "dns", AUTH_NOW)).kind, "active");
});

test("rejects an exact transaction replay with a different nonce", async () => {
  const kv = new MemoryKV();
  const credentials = await registerTestInstallation(kv);
  const storedEntryCount = kv.values.size;
  const replay = await authorizationResponse(
    kv,
    INSTALLATION_ID,
    testTransaction(),
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );
  assert.equal(replay.status, 401);
  assert.equal(kv.values.size, storedEntryCount);
  assert.equal((await authorizeToken(environmentForAuthorization(kv), credentials.dnsToken, "dns", AUTH_NOW)).kind, "active");
});

test("migrates a schema v1 record only with proof of both current credentials", async () => {
  const kv = new MemoryKV();
  const credentials = await registerTestInstallation(kv);
  const recordKey = [...kv.values.keys()].find((key) => key.endsWith(`installation:${INSTALLATION_ID}`));
  assert.ok(recordKey);
  const current = JSON.parse(kv.values.get(recordKey) ?? "null") as Record<string, unknown>;
  const legacy = { ...current };
  delete legacy.lastRegistrationTransactionId;
  delete legacy.lastTransactionSignedDate;
  delete legacy.lastNotificationSignedDate;
  delete legacy.rotationNonceHash;
  legacy.schemaVersion = 1;
  legacy.lastSignedDate = current.lastTransactionSignedDate;
  kv.values.set(recordKey, JSON.stringify(legacy));

  const withoutProof = await authorizationResponse(
    kv,
    INSTALLATION_ID,
    testTransaction(),
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );
  assert.equal(withoutProof.status, 401);

  const migrated = await authorizationResponse(
    kv,
    INSTALLATION_ID,
    testTransaction(),
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
    credentials,
  );
  assert.equal(migrated.status, 200);
  const migratedRecord = JSON.parse(kv.values.get(recordKey) ?? "null") as Record<string, unknown>;
  assert.equal(migratedRecord.schemaVersion, 2);
  assert.equal(migratedRecord.lastTransactionSignedDate, testTransaction().signedDate);
  assert.equal(migratedRecord.lastNotificationSignedDate, testTransaction().signedDate);
  assert.equal(typeof migratedRecord.rotationNonceHash, "string");
  assert.notEqual(migratedRecord.rotationNonceHash, "");
});

test("rejects an older different transaction after refund or revocation", async (context) => {
  for (const notificationType of ["REFUND", "REVOKE"]) {
    await context.test(notificationType, async () => {
      const kv = new MemoryKV();
      const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
      const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
      await processAppleNotification(
        environmentForAuthorization(kv),
        testNotification({
          notificationType,
          notificationUUID: `notification-${notificationType.toLowerCase()}`,
          signedDate: 1_300_000,
        }),
        { ...transaction, revocationDate: AUTH_NOW + 1_000 },
        undefined,
        AUTH_NOW + 1_000,
      );
      const storedEntryCount = kv.values.size;

      const replay = await authorizationResponse(kv, INSTALLATION_ID, testTransaction({
        transactionId: "1000000000000099",
        expiresDate: AUTH_NOW + 500_000,
        signedDate: 1_200_000,
      }), AUTH_ENV, undefined, OTHER_ROTATION_NONCE);

      assert.equal(replay.status, 401);
      assert.equal(kv.values.size, storedEntryCount, "an out-of-order transaction must not mutate authorization state");
      assert.equal((await authorizeToken(environmentForAuthorization(kv), credentials.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "passThrough");
      assert.equal((await authorizeToken(environmentForAuthorization(kv), credentials.statsToken, "stats", AUTH_NOW + 1_000)).kind, "rejected");
    });
  }
});

test("a revoked subscription cannot replay its pre-revocation JWS onto another installation", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
  await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  await processAppleNotification(
    environmentForAuthorization(kv),
    testNotification({ notificationType: "REVOKE", signedDate: 1_300_000 }),
    { ...transaction, revocationDate: AUTH_NOW + 1_000 },
    undefined,
    AUTH_NOW + 1_000,
  );
  const storedState = new Map(kv.values);

  const replay = await authorizationResponse(
    kv,
    OTHER_INSTALLATION_ID,
    transaction,
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );

  assert.equal(replay.status, 401);
  assert.deepEqual(kv.values, storedState, "global revocation must reject before mutating installation state");
});

test("accepts a Sandbox transaction only with matching Apple-signed TestFlight app evidence", async () => {
  const kv = new MemoryKV();
  const appTransactionId = "app-download-1000000000000001";
  const sandbox = await registerTestInstallation(
    kv,
    INSTALLATION_ID,
    testTransaction({ environment: "Sandbox", appTransactionId }),
    AUTH_ENV,
    testAppTransaction({ appTransactionId }),
  );
  assert.equal(sandbox.installationId, INSTALLATION_ID);
  assert.equal([...kv.values.keys()].some((key) => key.includes("subscription:Sandbox:")), true);
  assert.equal([...kv.values.keys()].some((key) => key.includes("subscription:Production:")), false);

  await registerTestInstallation(
    kv,
    OTHER_INSTALLATION_ID,
    testTransaction({ appTransactionId }),
  );
  assert.equal([...kv.values.keys()].some((key) => key.includes("subscription:Production:")), true);
});

test("generic Sandbox enablement cannot bypass the TestFlight app-transaction requirement", async () => {
  const kv = new MemoryKV();
  const result = await authorizationResponse(
    kv,
    INSTALLATION_ID,
    testTransaction({ environment: "Sandbox", appTransactionId: "app-download-1000000000000001" }),
    { ...AUTH_ENV, APPLE_ALLOWED_ENVIRONMENTS: "Production,Sandbox" },
  );
  assert.equal(result.status, 401);
  assert.equal(kv.values.size, 0);
});

test("rejects Sandbox app evidence that does not match the TestFlight transaction", async (context) => {
  const appTransactionId = "app-download-1000000000000001";
  const transaction = testTransaction({ environment: "Sandbox", appTransactionId });
  const mismatchCases: Array<[string, AppleTransactionPayload, AppleAppTransactionPayload]> = [
    ["Xcode receipt type", transaction, testAppTransaction({ receiptType: "Xcode" })],
    ["Production receipt type", transaction, testAppTransaction({ receiptType: "Production" })],
    ["Sandbox appAppleId must be absent", transaction, testAppTransaction({ appAppleId: 6_803_552_143 })],
    ["bundle identifier", transaction, testAppTransaction({ bundleId: "com.example.not-adless" })],
    ["app transaction identifier", transaction, testAppTransaction({ appTransactionId: "different-app-download" })],
    ["unlisted build version", transaction, testAppTransaction({ applicationVersion: "3" })],
    ["future receipt date", transaction, testAppTransaction({ receiptCreationDate: AUTH_NOW + 300_001 })],
    ["missing transaction app identifier", testTransaction({ environment: "Sandbox", appTransactionId: undefined }), testAppTransaction()],
  ];

  for (const [name, candidateTransaction, appTransaction] of mismatchCases) {
    await context.test(name, async () => {
      const kv = new MemoryKV();
      const result = await authorizationResponse(kv, INSTALLATION_ID, candidateTransaction, AUTH_ENV, appTransaction);
      assert.equal(result.status, 401);
      assert.equal(kv.values.size, 0);
    });
  }
});

test("accepts Xcode StoreKit transactions only in the isolated development environment", async () => {
  const kv = new MemoryKV();
  const appTransactionId = "xcode-app-transaction-1";
  const transaction = testTransaction({
    bundleId: "com.orbeworks.adless.dev",
    environment: "Xcode",
    appTransactionId,
  });
  const appTransaction = testAppTransaction({
    receiptType: "Xcode",
    bundleId: "com.orbeworks.adless.dev",
    appTransactionId,
  });

  const credentials = await registerTestInstallation(
    kv,
    INSTALLATION_ID,
    transaction,
    DEVELOPMENT_AUTH_ENV,
    appTransaction,
  );
  assert.equal(credentials.installationId, INSTALLATION_ID);
  assert.equal(latestAuthorityEvent(kv, "Xcode")?.environment, "Xcode");
  assert.equal([...kv.values.keys()].some((key) => key.includes("subscription:Xcode:")), true);
});

test("production and incomplete development configurations reject Xcode StoreKit transactions", async (context) => {
  const appTransactionId = "xcode-app-transaction-1";
  const transaction = testTransaction({
    bundleId: "com.orbeworks.adless.dev",
    environment: "Xcode",
    appTransactionId,
  });
  const appTransaction = testAppTransaction({
    receiptType: "Xcode",
    bundleId: "com.orbeworks.adless.dev",
    appTransactionId,
  });
  const cases: Array<[string, AuthorizationEnvironment]> = [
    ["production", AUTH_ENV],
    ["missing pinned certificate", { ...DEVELOPMENT_AUTH_ENV, XCODE_STOREKIT_CERTIFICATE_SHA256: undefined }],
    ["Xcode not explicitly allowed", { ...DEVELOPMENT_AUTH_ENV, APPLE_ALLOWED_ENVIRONMENTS: "Sandbox" }],
    ["wrong bundle", { ...DEVELOPMENT_AUTH_ENV, APPLE_BUNDLE_ID: "com.orbeworks.adless" }],
  ];

  for (const [name, candidateEnvironment] of cases) {
    await context.test(name, async () => {
      const kv = new MemoryKV();
      const response = await authorizationResponse(
        kv,
        INSTALLATION_ID,
        transaction,
        candidateEnvironment,
        appTransaction,
      );
      assert.equal(response.status, 401);
      assert.equal(kv.values.size, 0);
    });
  }
});

test("development environment rejects App Store Server Notifications", async () => {
  const kv = new MemoryKV();
  const response = await handleAppleNotification(
    new Request("https://worker.example.test/v1/notifications/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "test-notification-jws" }),
    }),
    environmentForAuthorization(kv, DEVELOPMENT_AUTH_ENV),
    {
      now: () => AUTH_NOW,
      verifyNotification: async () => testNotification({
        data: { bundleId: "com.orbeworks.adless.dev", environment: "Sandbox" },
      }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(kv.values.size, 0);
});

test("Sandbox notifications omit appAppleId and remain isolated from Production records", async () => {
  const kv = new MemoryKV();
  const appTransactionId = "app-download-1000000000000001";
  const transaction = testTransaction({ environment: "Sandbox", appTransactionId, expiresDate: AUTH_NOW + 100_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction, AUTH_ENV, testAppTransaction());
  const notification = testNotification({
    notificationType: "EXPIRED",
    data: {
      bundleId: "com.orbeworks.adless",
      environment: "Sandbox",
      signedTransactionInfo: "sandbox-transaction-jws",
    },
  });
  const response = await handleAppleNotification(
    new Request("https://worker.example.test/v1/notifications/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "sandbox-notification-jws" }),
    }),
    environmentForAuthorization(kv),
    {
      now: () => AUTH_NOW + 2_000,
      verifyNotification: async () => notification,
      verifyTransaction: async () => transaction,
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await authorizeToken(environmentForAuthorization(kv), credentials.dnsToken, "dns", AUTH_NOW + 2_000)).kind, "passThrough");
});

test("rotating credentials preserves the installation counter and stores no plaintext token", async () => {
  const kv = new MemoryKV();
  const first = await registerTestInstallation(kv, INSTALLATION_ID, testTransaction({ transactionId: "1000000000000002" }));
  const stats = statsNamespace(INSTALLATION_ID);
  const env = { ...environmentForAuthorization(kv), STATS: stats };
  let upstreamCalls = 0;
  const worker = createDNSWorker("ads.example.com\n", metadata("ads.example.com\n"), {
    now: () => AUTH_NOW,
    fetch: async (_url, init) => {
      upstreamCalls += 1;
      return new Response(binaryBody(response(new Uint8Array(init?.body as ArrayBuffer))), {
        headers: { "content-type": "application/dns-message" },
      });
    },
  });
  const firstContext = context();
  await worker.fetch(requestForToken(query("ads.example.com"), first.dnsToken), env, firstContext);
  await Promise.all(firstContext.pending);

  const second = await registerTestInstallation(kv, INSTALLATION_ID, testTransaction({
    transactionId: "1000000000000003",
    signedDate: 1_200_000,
  }), AUTH_ENV, undefined, OTHER_ROTATION_NONCE);
  assert.notEqual(first.dnsToken, second.dnsToken);
  assert.notEqual(first.statsToken, second.statsToken);
  const secondContext = context();
  await worker.fetch(requestForToken(query("ads.example.com"), second.dnsToken), env, secondContext);
  await Promise.all(secondContext.pending);
  assert.equal((await authorizeToken(env, first.dnsToken, "dns", AUTH_NOW)).kind, "passThrough");
  assert.equal((await authorizeToken(env, first.statsToken, "stats", AUTH_NOW)).kind, "rejected");
  const supersededContext = context();
  const supersededDNS = await worker.fetch(
    requestForToken(query("ads.example.com"), first.dnsToken),
    env,
    supersededContext,
  );
  assert.equal(supersededDNS.status, 200);
  assert.equal(upstreamCalls, 1, "a superseded DNS token must reach upstream instead of returning 401");
  assert.equal(supersededContext.pending.length, 0, "a superseded DNS token must not record statistics");
  const result = await worker.fetch(new Request("https://worker.example.test/v1/stats", {
    headers: { authorization: `Bearer ${second.statsToken}` },
  }), env, context());
  assert.equal((await result.json() as { blockedTotal: number }).blockedTotal, 2);
  for (const value of kv.values.values()) {
    assert.equal(String(value).includes(first.dnsToken), false);
    assert.equal(String(value).includes(first.statsToken), false);
    assert.equal(String(value).includes(second.dnsToken), false);
    assert.equal(String(value).includes(second.statsToken), false);
  }
});

test("a failed rotation commit leaves the previous credentials usable", async () => {
  const kv = new MemoryKV();
  const first = await registerTestInstallation(kv);
  kv.putCalls = 0;
  kv.failPutAt = 5;

  const failedRotation = await authorizationResponse(kv, INSTALLATION_ID, testTransaction({
    transactionId: "1000000000000003",
    signedDate: 1_200_000,
  }), AUTH_ENV, undefined, OTHER_ROTATION_NONCE);

  assert.equal(failedRotation.status, 401);
  assert.equal((await authorizeToken(environmentForAuthorization(kv), first.dnsToken, "dns", AUTH_NOW)).kind, "active");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), first.statsToken, "stats", AUTH_NOW)).kind, "active");
});

test("a lost post-commit response is recoverable without persisted plaintext tokens", async () => {
  const kv = new MemoryKV();
  const first = await registerTestInstallation(kv);
  const committed = await authorizationResponse(kv, INSTALLATION_ID, testTransaction({
    transactionId: "1000000000000003",
    signedDate: 1_200_000,
  }), AUTH_ENV, undefined, OTHER_ROTATION_NONCE);
  assert.equal(committed.status, 200);
  const lostCredentials = await committed.json() as { dnsToken: string; statsToken: string };
  const storedEntryCount = kv.values.size;

  const retry = await authorizationResponse(kv, INSTALLATION_ID, testTransaction({
    transactionId: "1000000000000003",
    signedDate: 1_200_000,
  }), AUTH_ENV, undefined, OTHER_ROTATION_NONCE);
  assert.equal(retry.status, 200);
  const recovered = await retry.json() as { dnsToken: string; statsToken: string };
  assert.deepEqual(recovered, lostCredentials);
  assert.equal(kv.values.size, storedEntryCount);

  assert.equal((await authorizeToken(environmentForAuthorization(kv), recovered.dnsToken, "dns", AUTH_NOW)).kind, "active");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), recovered.statsToken, "stats", AUTH_NOW)).kind, "active");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), first.dnsToken, "dns", AUTH_NOW)).kind, "passThrough");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), first.statsToken, "stats", AUTH_NOW)).kind, "rejected");
  for (const value of kv.values.values()) {
    assert.equal(value.includes(lostCredentials.dnsToken), false);
    assert.equal(value.includes(lostCredentials.statsToken), false);
  }
});

test("a notification arriving before Transaction.updates does not consume the transaction watermark", async () => {
  const kv = new MemoryKV();
  const firstTransaction = testTransaction({ expiresDate: AUTH_NOW + 100_000 });
  const first = await registerTestInstallation(kv, INSTALLATION_ID, firstTransaction);
  const renewalTransaction = testTransaction({
    transactionId: "1000000000000003",
    expiresDate: AUTH_NOW + 200_000,
    signedDate: 1_200_000,
  });
  await processAppleNotification(
    environmentForAuthorization(kv),
    testNotification({
      notificationType: "DID_RENEW",
      notificationUUID: "notification-before-client-update",
      signedDate: 1_300_000,
    }),
    renewalTransaction,
    undefined,
    AUTH_NOW + 1_000,
  );
  const recordKey = [...kv.values.keys()].find((key) => key.endsWith(`installation:${INSTALLATION_ID}`));
  assert.ok(recordKey);
  const beforeUpdate = JSON.parse(kv.values.get(recordKey) ?? "null") as {
    lastTransactionSignedDate: number;
    lastNotificationSignedDate: number;
  };
  assert.equal(beforeUpdate.lastTransactionSignedDate, firstTransaction.signedDate);
  assert.equal(beforeUpdate.lastNotificationSignedDate, 1_300_000);

  const response = await authorizationResponse(
    kv,
    INSTALLATION_ID,
    renewalTransaction,
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );
  assert.equal(response.status, 200);
  const second = await response.json() as { dnsToken: string; statsToken: string };
  const afterUpdate = JSON.parse(kv.values.get(recordKey) ?? "null") as {
    lastTransactionSignedDate: number;
    lastNotificationSignedDate: number;
  };
  assert.equal(afterUpdate.lastTransactionSignedDate, renewalTransaction.signedDate);
  assert.equal(afterUpdate.lastNotificationSignedDate, 1_300_000);
  assert.equal((await authorizeToken(environmentForAuthorization(kv), second.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "active");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), first.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "passThrough");
});

test("subscription authority revokes concurrent installations even when their index update is lost", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
  const [first, second] = await Promise.all([
    registerTestInstallation(kv, INSTALLATION_ID, transaction, AUTH_ENV, undefined, ROTATION_NONCE),
    registerTestInstallation(kv, OTHER_INSTALLATION_ID, transaction, AUTH_ENV, undefined, OTHER_ROTATION_NONCE),
  ]);
  const subscriptionIndexKey = [...kv.values.keys()].find((key) => key.includes("subscription:Production:"));
  assert.ok(subscriptionIndexKey);
  kv.values.set(subscriptionIndexKey, JSON.stringify({ schemaVersion: 1, installationIds: [INSTALLATION_ID] }));

  await processAppleNotification(
    environmentForAuthorization(kv),
    testNotification({ notificationType: "REFUND", signedDate: 1_300_000 }),
    { ...transaction, revocationDate: AUTH_NOW + 1_000 },
    undefined,
    AUTH_NOW + 1_000,
  );

  assert.equal((await authorizeToken(environmentForAuthorization(kv), first.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "passThrough");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), second.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "passThrough");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), first.statsToken, "stats", AUTH_NOW + 1_000)).kind, "rejected");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), second.statsToken, "stats", AUTH_NOW + 1_000)).kind, "rejected");
});

test("a stale legacy KV projection cannot override a newer DO revocation", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  const env = environmentForAuthorization(kv);
  await processAppleNotification(
    env,
    testNotification({ notificationType: "REVOKE", signedDate: 1_400_000 }),
    { ...transaction, revocationDate: AUTH_NOW + 1_000 },
    undefined,
    AUTH_NOW + 1_000,
  );
  kv.values.set(
    `adless:auth:v1:subscription-authority:Production:${transaction.originalTransactionId}`,
    JSON.stringify({
      schemaVersion: 1,
      originalTransactionId: transaction.originalTransactionId,
      environment: "Production",
      productId: transaction.productId,
      transactionId: transaction.transactionId,
      status: "active",
      accessUntil: transaction.expiresDate,
      inGracePeriod: false,
      isInBillingRetryPeriod: false,
      updatedAt: AUTH_NOW + 2_000,
      lastNotificationSignedDate: 1_300_000,
    }),
  );
  await processAppleNotification(
    env,
    testNotification({
      notificationType: "DID_CHANGE_RENEWAL_STATUS",
      notificationUUID: "neutral-after-stale-kv",
      signedDate: 1_500_000,
    }),
    transaction,
    undefined,
    AUTH_NOW + 2_000,
  );

  assert.equal(latestAuthorityEvent(kv)?.status, "revoked");
  assert.equal((await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 2_000)).kind, "passThrough");
  assert.equal((await authorizeToken(env, credentials.statsToken, "stats", AUTH_NOW + 2_000)).kind, "rejected");
});

test("DNS authorization migrates a terminal legacy authority before a stale active record", async (context) => {
  for (const status of ["revoked", "expired"] as const) {
    await context.test(status, async () => {
      const kv = new MemoryKV();
      const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
      const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
      kv.values.set(
        `adless:auth:v1:subscription-authority:Production:${transaction.originalTransactionId}`,
        JSON.stringify({
          schemaVersion: 1,
          originalTransactionId: transaction.originalTransactionId,
          environment: "Production",
          productId: transaction.productId,
          transactionId: transaction.transactionId,
          status,
          accessUntil: status === "expired" ? AUTH_NOW - 1 : transaction.expiresDate,
          inGracePeriod: false,
          isInBillingRetryPeriod: false,
          updatedAt: AUTH_NOW + 1_000,
          lastNotificationSignedDate: 1_300_000,
        }),
      );
      kv.authority.objects.clear();
      const env = environmentForAuthorization(kv);

      assert.equal((await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "passThrough");
      assert.equal((await authorizeToken(env, credentials.statsToken, "stats", AUTH_NOW + 1_000)).kind, "rejected");
      assert.equal(latestAuthorityEvent(kv)?.status, status);
    });
  }
});

test("a late refund for an old period cannot override a newer renewal after an empty-DO rollout", async () => {
  const kv = new MemoryKV();
  const firstTransaction = testTransaction({ expiresDate: AUTH_NOW + 100_000 });
  await registerTestInstallation(kv, INSTALLATION_ID, firstTransaction);
  const renewal = testTransaction({
    transactionId: "1000000000000003",
    purchaseDate: 950_000,
    expiresDate: AUTH_NOW + 300_000,
    signedDate: 1_100_000,
  });
  const current = await registerTestInstallation(
    kv,
    INSTALLATION_ID,
    renewal,
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );
  kv.authority.objects.clear();

  await processAppleNotification(
    environmentForAuthorization(kv),
    testNotification({
      notificationType: "REFUND",
      notificationUUID: "late-refund-old-period",
      signedDate: 1_290_000,
    }),
    {
      ...firstTransaction,
      signedDate: 1_280_000,
      revocationDate: AUTH_NOW + 1_000,
    },
    undefined,
    AUTH_NOW + 1_000,
  );

  const latest = latestAuthorityEvent(kv);
  assert.equal(latest?.transactionId, renewal.transactionId);
  assert.equal(latest?.status, "active");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), current.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "active");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), current.statsToken, "stats", AUTH_NOW + 1_000)).kind, "active");
});

test("a prior-period notification watermark cannot mask a refund of the current period", async () => {
  const kv = new MemoryKV();
  const firstTransaction = testTransaction({ expiresDate: AUTH_NOW + 100_000 });
  await registerTestInstallation(kv, INSTALLATION_ID, firstTransaction);
  const env = environmentForAuthorization(kv);
  await processAppleNotification(
    env,
    testNotification({
      notificationType: "REFUND",
      notificationUUID: "refund-prior-period",
      signedDate: 1_300_000,
    }),
    { ...firstTransaction, revocationDate: AUTH_NOW + 500 },
    undefined,
    AUTH_NOW + 1_000,
  );
  const renewal = testTransaction({
    transactionId: "1000000000000003",
    purchaseDate: 950_000,
    expiresDate: AUTH_NOW + 300_000,
    signedDate: 1_200_000,
  });
  const current = await registerTestInstallation(
    kv,
    INSTALLATION_ID,
    renewal,
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );
  assert.equal((await authorizeToken(env, current.dnsToken, "dns", AUTH_NOW + 1_500)).kind, "active");

  await processAppleNotification(
    env,
    testNotification({
      notificationType: "REFUND",
      notificationUUID: "refund-current-period",
      signedDate: 1_250_000,
    }),
    { ...renewal, revocationDate: AUTH_NOW + 1_500 },
    undefined,
    AUTH_NOW + 2_000,
  );

  assert.equal(latestAuthorityEvent(kv)?.transactionId, renewal.transactionId);
  assert.equal(latestAuthorityEvent(kv)?.status, "revoked");
  assert.equal((await authorizeToken(env, current.dnsToken, "dns", AUTH_NOW + 2_000)).kind, "passThrough");
  assert.equal((await authorizeToken(env, current.statsToken, "stats", AUTH_NOW + 2_000)).kind, "rejected");

  await processAppleNotification(
    env,
    testNotification({
      notificationType: "REFUND_REVERSED",
      notificationUUID: "recovery-current-period",
      signedDate: 1_275_000,
    }),
    { ...renewal, revocationDate: AUTH_NOW + 1_500 },
    undefined,
    AUTH_NOW + 2_500,
  );
  assert.equal(latestAuthorityEvent(kv)?.status, "active");
  assert.equal((await authorizeToken(env, current.dnsToken, "dns", AUTH_NOW + 2_500)).kind, "active");
});

test("a re-signed active transaction cannot undo a refund, but REFUND_REVERSED can", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  const env = environmentForAuthorization(kv);
  await processAppleNotification(
    env,
    testNotification({
      notificationType: "REFUND",
      notificationUUID: "refund-before-reversal",
      signedDate: 1_200_000,
    }),
    { ...transaction, revocationDate: AUTH_NOW + 500 },
    undefined,
    AUTH_NOW + 1_000,
  );

  const staleRegistration = await authorizationResponse(
    kv,
    OTHER_INSTALLATION_ID,
    { ...transaction, signedDate: 1_250_000 },
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );
  assert.equal(staleRegistration.status, 401);
  assert.equal(latestAuthorityEvent(kv)?.status, "revoked");

  await processAppleNotification(
    env,
    testNotification({
      notificationType: "DID_FAIL_TO_RENEW",
      notificationUUID: "billing-failure-after-refund",
      signedDate: 1_275_000,
    }),
    { ...transaction, signedDate: 1_270_000 },
    { ...testTransaction(), isInBillingRetryPeriod: true },
    AUTH_NOW + 1_500,
  );
  assert.equal(latestAuthorityEvent(kv)?.status, "revoked", "billing failure is not recovery evidence");

  await processAppleNotification(
    env,
    testNotification({
      notificationType: "REFUND_REVERSED",
      notificationUUID: "refund-reversed",
      signedDate: 1_300_000,
    }),
    {
      ...transaction,
      signedDate: 1_290_000,
      revocationDate: AUTH_NOW + 500,
    },
    undefined,
    AUTH_NOW + 2_000,
  );

  assert.equal(latestAuthorityEvent(kv)?.reason, "REFUND_REVERSED");
  assert.equal(latestAuthorityEvent(kv)?.status, "active");
  assert.equal((await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 2_000)).kind, "active");
  assert.equal((await authorizeToken(env, credentials.statsToken, "stats", AUTH_NOW + 2_000)).kind, "active");
});

test("official resubscribe and billing-recovery notifications reactivate a later period", async (context) => {
  const cases = [
    { terminal: "EXPIRED", recovery: "SUBSCRIBED", subtype: "RESUBSCRIBE", reason: "RESUBSCRIBE" },
    { terminal: "GRACE_PERIOD_EXPIRED", recovery: "DID_RENEW", subtype: "BILLING_RECOVERY", reason: "BILLING_RECOVERY" },
  ] as const;

  for (const recoveryCase of cases) {
    await context.test(recoveryCase.reason, async () => {
      const kv = new MemoryKV();
      const transaction = testTransaction({ expiresDate: AUTH_NOW + 100_000 });
      const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
      const env = environmentForAuthorization(kv);
      await processAppleNotification(
        env,
        testNotification({
          notificationType: recoveryCase.terminal,
          notificationUUID: `terminal-before-${recoveryCase.reason}`,
          signedDate: 1_150_000,
        }),
        { ...transaction, expiresDate: AUTH_NOW + 500, signedDate: 1_100_000 },
        undefined,
        AUTH_NOW + 1_000,
      );
      assert.equal((await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "passThrough");
      assert.equal((await authorizeToken(env, credentials.statsToken, "stats", AUTH_NOW + 1_000)).kind, "rejected");

      await processAppleNotification(
        env,
        testNotification({
          notificationType: recoveryCase.recovery,
          subtype: recoveryCase.subtype,
          notificationUUID: `recovery-${recoveryCase.reason}`,
          signedDate: 1_250_000,
        }),
        testTransaction({
          transactionId: "1000000000000003",
          purchaseDate: 950_000,
          expiresDate: AUTH_NOW + 300_000,
          signedDate: 1_200_000,
        }),
        undefined,
        AUTH_NOW + 2_000,
      );

      assert.equal(latestAuthorityEvent(kv)?.reason, recoveryCase.reason);
      assert.equal(latestAuthorityEvent(kv)?.status, "active");
      assert.equal((await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 2_000)).kind, "active");
      assert.equal((await authorizeToken(env, credentials.statsToken, "stats", AUTH_NOW + 2_000)).kind, "active");
    });
  }
});

test("a later shorter product period outranks a refund from an older longer period", async () => {
  const kv = new MemoryKV();
  const annualPeriod = testTransaction({ expiresDate: AUTH_NOW + 800_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, annualPeriod);
  const env = environmentForAuthorization(kv);
  await processAppleNotification(
    env,
    testNotification({
      notificationType: "REFUND",
      notificationUUID: "refund-older-annual-period",
      signedDate: 1_200_000,
    }),
    { ...annualPeriod, revocationDate: AUTH_NOW + 500 },
    undefined,
    AUTH_NOW + 1_000,
  );
  assert.equal((await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "passThrough");

  const laterMonthlyPeriod = testTransaction({
    productId: "com.orbeworks.adless.pro.monthly",
    transactionId: "1000000000000003",
    purchaseDate: 950_000,
    expiresDate: AUTH_NOW + 300_000,
    signedDate: 1_250_000,
  });
  await processAppleNotification(
    env,
    testNotification({
      notificationType: "SUBSCRIBED",
      subtype: "RESUBSCRIBE",
      notificationUUID: "resubscribe-later-monthly-period",
      signedDate: 1_275_000,
    }),
    laterMonthlyPeriod,
    undefined,
    AUTH_NOW + 2_000,
  );

  assert.equal(latestAuthorityEvent(kv)?.transactionId, laterMonthlyPeriod.transactionId);
  assert.equal(latestAuthorityEvent(kv)?.status, "active");
  assert.equal((await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 2_000)).kind, "active");
});

test("an expired registration can recover on a later subscription period", async () => {
  const kv = new MemoryKV();
  const expired = await authorizationResponse(
    kv,
    INSTALLATION_ID,
    testTransaction({ expiresDate: AUTH_NOW - 1 }),
  );
  assert.equal(expired.status, 401);
  assert.equal(latestAuthorityEvent(kv)?.status, "expired");
  assert.equal([...kv.values.keys()].some((key) => key.includes("subscription-terminal:")), false);

  const renewal = await authorizationResponse(
    kv,
    INSTALLATION_ID,
    testTransaction({
      transactionId: "1000000000000003",
      purchaseDate: 950_000,
      expiresDate: AUTH_NOW + 500_000,
      signedDate: 1_100_000,
    }),
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );
  assert.equal(renewal.status, 200);
  assert.equal(latestAuthorityEvent(kv)?.status, "active");
});

test("schema v1/v2 terminal state seeds an empty authority before replay", async (context) => {
  const cases = [
    { schemaVersion: 1, status: "revoked", loseIndex: false },
    { schemaVersion: 2, status: "expired", loseIndex: true },
  ] as const;

  for (const migrationCase of cases) {
    await context.test(`schema ${migrationCase.schemaVersion} ${migrationCase.status}`, async () => {
      const kv = new MemoryKV();
      const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
      await registerTestInstallation(kv, INSTALLATION_ID, transaction);
      const recordKey = [...kv.values.keys()].find((key) => key.endsWith(`installation:${INSTALLATION_ID}`));
      const subscriptionIndexKey = [...kv.values.keys()].find((key) => key.includes("subscription:Production:"));
      assert.ok(recordKey);
      assert.ok(subscriptionIndexKey);
      const stored = JSON.parse(kv.values.get(recordKey) ?? "null") as Record<string, unknown>;
      stored.status = migrationCase.status;
      stored.accessUntil = migrationCase.status === "expired" ? AUTH_NOW - 1 : transaction.expiresDate;
      stored.lastNotificationSignedDate = 1_300_000;
      if (migrationCase.schemaVersion === 1) {
        stored.schemaVersion = 1;
        stored.lastSignedDate = 1_300_000;
        delete stored.lastRegistrationTransactionId;
        delete stored.lastTransactionSignedDate;
        delete stored.lastNotificationSignedDate;
        delete stored.rotationNonceHash;
      }
      kv.values.set(recordKey, JSON.stringify(stored));
      if (migrationCase.loseIndex) {
        kv.values.set(subscriptionIndexKey, JSON.stringify({ schemaVersion: 1, installationIds: [] }));
        assert.equal(
          [...kv.values.keys()].some((key) => key.includes("subscription-authority:")),
          false,
          "the transaction claim must recover the terminal record without a global legacy projection",
        );
      }
      kv.authority.objects.clear();

      const replay = await authorizationResponse(
        kv,
        OTHER_INSTALLATION_ID,
        { ...transaction, signedDate: 1_200_000 },
        AUTH_ENV,
        undefined,
        OTHER_ROTATION_NONCE,
      );

      assert.equal(replay.status, 401);
      assert.equal(latestAuthorityEvent(kv)?.status, migrationCase.status);
      assert.equal([...kv.values.keys()].some((key) => key.endsWith(`installation:${OTHER_INSTALLATION_ID}`)), false);
    });
  }
});

test("a preexisting notification dedup marker cannot skip authority migration or update", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  kv.authority.objects.clear();
  kv.values.set("adless:auth:v1:notification:already-seen", "1");
  const notification = testNotification({
    notificationType: "REFUND",
    notificationUUID: "already-seen",
    signedDate: 1_200_000,
    data: {
      appAppleId: 6_803_552_143,
      bundleId: "com.orbeworks.adless",
      environment: "Production",
      signedTransactionInfo: "signed-transaction-jws",
    },
  });

  const response = await handleAppleNotification(
    new Request("https://worker.example.test/v1/notifications/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "signed-notification-jws" }),
    }),
    environmentForAuthorization(kv),
    {
      now: () => AUTH_NOW + 1_000,
      verifyNotification: async () => notification,
      verifyTransaction: async () => ({ ...transaction, revocationDate: AUTH_NOW + 500 }),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(latestAuthorityEvent(kv)?.status, "revoked");
  assert.equal((await authorizeToken(environmentForAuthorization(kv), credentials.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "passThrough");
});

test("authority events are serialized and Production is isolated from Sandbox", async () => {
  const kv = new MemoryKV();
  const productionTransaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
  const production = await registerTestInstallation(kv, INSTALLATION_ID, productionTransaction);
  const appTransactionId = "app-download-1000000000000001";
  const sandboxTransaction = testTransaction({
    environment: "Sandbox",
    transactionId: "2000000000000002",
    appTransactionId,
    expiresDate: AUTH_NOW + 500_000,
  });
  const sandbox = await registerTestInstallation(
    kv,
    OTHER_INSTALLATION_ID,
    sandboxTransaction,
    AUTH_ENV,
    testAppTransaction({ appTransactionId }),
    OTHER_ROTATION_NONCE,
  );
  const sandboxEnv = environmentForAuthorization(kv);
  await Promise.all([
    processAppleNotification(
      sandboxEnv,
      testNotification({
        notificationType: "REFUND",
        notificationUUID: "sandbox-concurrent-refund",
        signedDate: 1_200_000,
        data: { bundleId: "com.orbeworks.adless", environment: "Sandbox" },
      }),
      { ...sandboxTransaction, revocationDate: AUTH_NOW + 500 },
      undefined,
      AUTH_NOW + 1_000,
    ),
    processAppleNotification(
      sandboxEnv,
      testNotification({
        notificationType: "REFUND_REVERSED",
        notificationUUID: "sandbox-concurrent-reversal",
        signedDate: 1_300_000,
        data: { bundleId: "com.orbeworks.adless", environment: "Sandbox" },
      }),
      { ...sandboxTransaction, revocationDate: AUTH_NOW + 500 },
      undefined,
      AUTH_NOW + 1_000,
    ),
  ]);

  assert.equal(latestAuthorityEvent(kv, "Sandbox")?.status, "active");
  assert.equal((await authorizeToken(sandboxEnv, sandbox.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "active");
  assert.equal((await authorizeToken(sandboxEnv, production.dnsToken, "dns", AUTH_NOW + 1_000)).kind, "active");
  const objectNames = new Set(kv.authority.names);
  assert.equal([...objectNames].some((name) => name.includes(":Production:")), true);
  assert.equal([...objectNames].some((name) => name.includes(":Sandbox:")), true);
  assert.equal([...objectNames].some((name) => name.includes(productionTransaction.originalTransactionId)), false);
});

test("authority timeout fails known DNS open and stats/registration/notifications closed", async () => {
  const kv = new MemoryKV();
  const transaction = testTransaction({ expiresDate: AUTH_NOW + 500_000 });
  const credentials = await registerTestInstallation(kv, INSTALLATION_ID, transaction);
  const env = environmentForAuthorization(kv);
  kv.authority.hang = true;
  const startedAt = Date.now();
  const dns = await authorizeToken(env, credentials.dnsToken, "dns", AUTH_NOW + 1_000);
  assert.equal(dns.kind, "passThrough");
  assert.ok(Date.now() - startedAt < 2_000, "authority lookup must have a bounded timeout");

  kv.authority.hang = false;
  kv.authority.unavailable = true;
  assert.equal((await authorizeToken(env, credentials.statsToken, "stats", AUTH_NOW + 1_000)).kind, "rejected");
  const registration = await authorizationResponse(
    kv,
    INSTALLATION_ID,
    testTransaction({
      transactionId: "1000000000000003",
      purchaseDate: 950_000,
      expiresDate: AUTH_NOW + 600_000,
      signedDate: 1_100_000,
    }),
    AUTH_ENV,
    undefined,
    OTHER_ROTATION_NONCE,
  );
  assert.equal(registration.status, 401);

  const notification = testNotification({
    notificationType: "REFUND",
    notificationUUID: "refund-during-authority-outage",
    data: {
      appAppleId: 6_803_552_143,
      bundleId: "com.orbeworks.adless",
      environment: "Production",
      signedTransactionInfo: "signed-transaction-jws",
    },
  });
  const notificationResponse = await handleAppleNotification(
    new Request("https://worker.example.test/v1/notifications/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedPayload: "signed-notification-jws" }),
    }),
    env,
    {
      now: () => AUTH_NOW + 1_000,
      verifyNotification: async () => notification,
      verifyTransaction: async () => ({ ...transaction, revocationDate: AUTH_NOW + 500 }),
    },
  );
  assert.equal(notificationResponse.status, 400);
  assert.equal(kv.values.has("adless:auth:v1:notification:refund-during-authority-outage"), false);
});

test("DNS authorization does not call Apple or another backend per request", async () => {
  const kv = new MemoryKV();
  const credentials = await registerTestInstallation(kv);
  let transactionVerificationCalls = 0;
  let upstreamCalls = 0;
  const worker = createDNSWorker("allowed.example.com\n", metadata("allowed.example.com\n"), {
    fetch: async (url) => {
      upstreamCalls += 1;
      assert.equal(String(url), "https://cloudflare-dns.com/dns-query");
      return new Response(binaryBody(response(query("allowed.example.com"))), { headers: { "content-type": "application/dns-message" } });
    },
    authorization: {
      verifyTransaction: async () => {
        transactionVerificationCalls += 1;
        return testTransaction();
      },
    },
  });
  const result = await worker.fetch(
    requestForToken(query("allowed.example.com"), credentials.dnsToken),
    environmentForAuthorization(kv),
    context(),
  );
  assert.equal(result.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.equal(transactionVerificationCalls, 0);
});
