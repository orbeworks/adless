import { verifyAppleJWS, type AppleJWSVerificationOptions } from "./apple-jws.js";
import type { DurableObjectNamespaceLike, SubscriptionAuthorityEvent } from "./types.js";

const AUTH_KEY_PREFIX = "adless:auth:v1:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_IDS = new Set([
  "com.orbeworks.adless.pro.monthly",
  "com.orbeworks.adless.pro.yearly",
]);
const MAX_INSTALLATIONS_PER_SUBSCRIPTION = 8;
const NOTIFICATION_TTL_SECONDS = 60 * 60 * 24 * 45;
const MAX_APPLE_IDENTIFIER_LENGTH = 128;
const MAX_APPLE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const AUTHORITY_TIMEOUT_MS = 750;

export type AuthorizationStatus = "active" | "expired" | "revoked";
export type TokenRole = "dns" | "stats";
export type AppleEnvironment = "Production" | "Sandbox" | "Xcode";
type AppleServerEnvironment = Exclude<AppleEnvironment, "Xcode">;

export interface AuthorizationKV {
  get(key: string, type?: "json" | "text"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface LegacyAuthorizationRecord {
  schemaVersion: 1;
  installationId: string;
  dnsTokenHash: string;
  statsTokenHash: string;
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  environment: AppleEnvironment;
  status: AuthorizationStatus;
  accessUntil: number;
  inGracePeriod: boolean;
  isInBillingRetryPeriod: boolean;
  updatedAt: number;
  lastSignedDate: number;
}

export interface AuthorizationRecord {
  schemaVersion: 2;
  installationId: string;
  dnsTokenHash: string;
  statsTokenHash: string;
  originalTransactionId: string;
  transactionId: string;
  lastRegistrationTransactionId: string;
  productId: string;
  environment: AppleEnvironment;
  status: AuthorizationStatus;
  accessUntil: number;
  inGracePeriod: boolean;
  isInBillingRetryPeriod: boolean;
  updatedAt: number;
  lastTransactionSignedDate: number;
  lastNotificationSignedDate: number;
  rotationNonceHash: string;
}

type StoredAuthorizationRecord = LegacyAuthorizationRecord | AuthorizationRecord;

interface TokenRecord {
  schemaVersion: 1;
  installationId: string;
  role: TokenRole;
}

interface SubscriptionInstallations {
  schemaVersion: 1;
  installationIds: string[];
}

interface TransactionClaim {
  schemaVersion: 1;
  originalTransactionId: string;
  installationIds: string[];
}

/** Mutable KV projection written by releases before DO-backed authority. */
interface LegacySubscriptionAuthorityRecord {
  schemaVersion: 1;
  originalTransactionId: string;
  environment: AppleEnvironment;
  productId: string;
  transactionId?: string;
  status: AuthorizationStatus;
  accessUntil: number;
  inGracePeriod: boolean;
  isInBillingRetryPeriod: boolean;
  updatedAt: number;
  lastNotificationSignedDate: number;
}

export interface AppleTransactionPayload {
  bundleId: string;
  environment: AppleEnvironment;
  productId: string;
  originalTransactionId: string;
  transactionId: string;
  purchaseDate: number;
  expiresDate: number;
  revocationDate?: number;
  signedDate: number;
  appTransactionId?: string;
  type?: string;
}

export interface AppleAppTransactionPayload {
  receiptType: AppleEnvironment;
  appAppleId?: number;
  bundleId: string;
  applicationVersion: string;
  receiptCreationDate: number;
  appTransactionId: string;
}

export interface AppleRenewalInfoPayload {
  environment: AppleEnvironment;
  originalTransactionId: string;
  productId?: string;
  autoRenewStatus?: number;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
}

export interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  signedDate: number;
  data?: {
    appAppleId?: number;
    bundleId?: string;
    environment?: AppleEnvironment;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

export type TokenAuthorization =
  | { kind: "active" | "passThrough"; installationId: string; accessUntil: number }
  | { kind: "rejected"; reason: "unknown" | "forbidden" };

export interface AuthorizationEnvironment {
  AUTH?: AuthorizationKV;
  AUTH_TOKEN_DERIVATION_SECRET?: string;
  AUTHORITY?: DurableObjectNamespaceLike;
  APPLE_BUNDLE_ID?: string;
  APPLE_APP_ID?: string;
  /** Comma-separated environments accepted for ordinary registration. */
  APPLE_ALLOWED_ENVIRONMENTS?: string;
  /** Comma-separated Apple environments accepted for signed notifications. */
  APPLE_NOTIFICATION_ENVIRONMENTS?: string;
  /** Comma-separated CFBundleShortVersionString values uploaded to TestFlight. */
  APPLE_TESTFLIGHT_BUILD_VERSIONS?: string;
  /** Pins the Xcode StoreKit Test signing certificate for an isolated development Worker. */
  XCODE_STOREKIT_CERTIFICATE_SHA256?: string;
}

export interface AuthorizationDependencies {
  now?: () => number;
  verifyTransaction?: (jws: string) => Promise<AppleTransactionPayload>;
  verifyAppTransaction?: (jws: string) => Promise<AppleAppTransactionPayload>;
  verifyNotification?: (jws: string) => Promise<AppleNotificationPayload>;
  verifyRenewalInfo?: (jws: string) => Promise<AppleRenewalInfoPayload>;
  appleJWSOptions?: AppleJWSVerificationOptions;
}

function authKey(suffix: string): string {
  return `${AUTH_KEY_PREFIX}${suffix}`;
}

function installationKey(installationId: string): string {
  return authKey(`installation:${installationId}`);
}

function tokenKey(hash: string): string {
  return authKey(`token:${hash}`);
}

function subscriptionKey(environment: AppleEnvironment, originalTransactionId: string): string {
  return authKey(`subscription:${environment}:${originalTransactionId}`);
}

function legacySubscriptionAuthorityKey(environment: AppleEnvironment, originalTransactionId: string): string {
  return authKey(`subscription-authority:${environment}:${originalTransactionId}`);
}

function legacySubscriptionKey(originalTransactionId: string): string {
  return authKey(`subscription:${originalTransactionId}`);
}

function transactionKey(environment: AppleEnvironment, transactionId: string): string {
  return authKey(`transaction:${environment}:${transactionId}`);
}

function notificationKey(notificationUUID: string): string {
  return authKey(`notification:${notificationUUID}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_APPLE_IDENTIFIER_LENGTH;
}

async function readJSON<T>(kv: AuthorizationKV, key: string): Promise<T | null> {
  const value = await kv.get(key, "json");
  return isRecord(value) ? value as T : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSubscriptionAuthorityEvent(value: unknown): value is SubscriptionAuthorityEvent {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && (value.source === "record" || value.source === "transaction" || value.source === "notification")
    && typeof value.sourceId === "string"
    && value.sourceId.length > 0
    && value.sourceId.length <= MAX_APPLE_IDENTIFIER_LENGTH
    && typeof value.reason === "string"
    && value.reason.length > 0
    && value.reason.length <= 64
    && (value.environment === "Production" || value.environment === "Sandbox" || value.environment === "Xcode")
    && typeof value.originalTransactionId === "string"
    && value.originalTransactionId.length > 0
    && value.originalTransactionId.length <= MAX_APPLE_IDENTIFIER_LENGTH
    && (value.transactionId === undefined
      || (typeof value.transactionId === "string"
        && value.transactionId.length > 0
        && value.transactionId.length <= MAX_APPLE_IDENTIFIER_LENGTH))
    && typeof value.productId === "string"
    && PRODUCT_IDS.has(value.productId)
    && (value.status === "active" || value.status === "expired" || value.status === "revoked")
    && Number.isSafeInteger(value.accessUntil)
    && (value.accessUntil as number) >= 0
    && typeof value.inGracePeriod === "boolean"
    && typeof value.isInBillingRetryPeriod === "boolean"
    && Number.isSafeInteger(value.periodPurchaseDate)
    && (value.periodPurchaseDate as number) >= 0
    && Number.isSafeInteger(value.periodExpiresDate)
    && (value.periodExpiresDate as number) >= 0
    && Number.isSafeInteger(value.signedDate)
    && (value.signedDate as number) > 0;
}

async function authorityObject(
  env: AuthorizationEnvironment,
  environment: AppleEnvironment,
  originalTransactionId: string,
) {
  if (!env.AUTHORITY) throw new Error("subscription authority is not configured");
  const originalTransactionHash = await sha256Hex(originalTransactionId);
  const id = env.AUTHORITY.idFromName(`subscription-authority:v1:${environment}:${originalTransactionHash}`);
  return env.AUTHORITY.get(id);
}

async function authorityEventFromResponse(
  response: Response,
  environment: AppleEnvironment,
  originalTransactionId: string,
): Promise<SubscriptionAuthorityEvent | null> {
  if (!response.ok) throw new Error("subscription authority rejected the request");
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("invalid subscription authority response");
  const event = payload.event;
  if (event === null) return null;
  if (!isSubscriptionAuthorityEvent(event)
    || event.environment !== environment
    || event.originalTransactionId !== originalTransactionId) {
    throw new Error("invalid subscription authority state");
  }
  return event;
}

async function readSubscriptionAuthority(
  env: AuthorizationEnvironment,
  environment: AppleEnvironment,
  originalTransactionId: string,
): Promise<SubscriptionAuthorityEvent | null> {
  const stub = await authorityObject(env, environment, originalTransactionId);
  return await authorityEventFromResponse(
    await stub.fetch("https://authority/authority/latest", {
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
    }),
    environment,
    originalTransactionId,
  );
}

async function appendSubscriptionAuthorityEvent(
  env: AuthorizationEnvironment,
  event: SubscriptionAuthorityEvent,
): Promise<SubscriptionAuthorityEvent> {
  const stub = await authorityObject(env, event.environment, event.originalTransactionId);
  const latest = await authorityEventFromResponse(
    await stub.fetch("https://authority/authority/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
    }),
    event.environment,
    event.originalTransactionId,
  );
  if (!latest) throw new Error("subscription authority did not persist an event");
  return latest;
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function normalizeAuthorizationRecord(record: StoredAuthorizationRecord | null): AuthorizationRecord | null {
  if (!record || (record.schemaVersion !== 1 && record.schemaVersion !== 2)) return null;
  if (record.schemaVersion === 2) return record;
  const { lastSignedDate, schemaVersion: _schemaVersion, ...legacy } = record;
  return {
    ...legacy,
    schemaVersion: 2,
    lastRegistrationTransactionId: record.transactionId,
    lastTransactionSignedDate: lastSignedDate,
    // Schema v1 mixed both clocks. Conservatively retain its watermark for
    // notification replay while registrations migrate using transaction IDs.
    lastNotificationSignedDate: lastSignedDate,
    rotationNonceHash: "",
  };
}

async function deriveTokens(
  secret: string | undefined,
  installationId: string,
  transaction: AppleTransactionPayload,
  rotationNonce: string,
): Promise<{ dnsToken: string; statsToken: string }> {
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret ?? "");
  if (secretBytes.byteLength < 32 || secretBytes.byteLength > 1024) {
    throw new Error("token derivation secret is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derive = async (role: TokenRole): Promise<string> => {
    const context = JSON.stringify([
      "adless-authorization-v2",
      role,
      installationId,
      transaction.environment,
      transaction.originalTransactionId,
      transaction.transactionId,
      rotationNonce,
    ]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(context));
    return base64URL(new Uint8Array(signature));
  };
  const [dnsToken, statsToken] = await Promise.all([derive("dns"), derive("stats")]);
  return { dnsToken, statsToken };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function configuredAppleEnvironments(value: string | undefined, defaults: AppleEnvironment[]): Set<AppleEnvironment> {
  const configured = value?.split(",")
    .map((value) => value.trim())
    .filter((value): value is AppleEnvironment => value === "Production" || value === "Sandbox" || value === "Xcode");
  return new Set(value === undefined ? defaults : configured);
}

function allowedRegistrationEnvironments(env: AuthorizationEnvironment): Set<AppleEnvironment> {
  return configuredAppleEnvironments(env.APPLE_ALLOWED_ENVIRONMENTS, ["Production"]);
}

function allowedNotificationEnvironments(env: AuthorizationEnvironment): Set<AppleServerEnvironment> {
  return new Set([...configuredAppleEnvironments(env.APPLE_NOTIFICATION_ENVIRONMENTS, ["Production", "Sandbox"])]
    .filter((value): value is AppleServerEnvironment => value !== "Xcode"));
}

function allowedTestFlightBuildVersions(env: AuthorizationEnvironment): Set<string> {
  const configured = env.APPLE_TESTFLIGHT_BUILD_VERSIONS?.split(",")
    .map((value) => value.trim())
    .filter((value) => /^[1-9][0-9]*(?:\.[0-9]+){0,2}$/.test(value));
  return new Set(configured ?? []);
}

function validTransaction(transaction: AppleTransactionPayload, env: AuthorizationEnvironment, now = Date.now()): boolean {
  const identifiersAreValid = [transaction.originalTransactionId, transaction.transactionId, transaction.appTransactionId]
    .filter((value): value is string => value !== undefined)
    .every((value) =>
    typeof value === "string" && value.length > 0 && value.length <= MAX_APPLE_IDENTIFIER_LENGTH);
  const datesAreValid = Number.isSafeInteger(transaction.purchaseDate)
    && Number.isSafeInteger(transaction.expiresDate)
    && transaction.purchaseDate > 0
    && transaction.purchaseDate <= now + MAX_APPLE_CLOCK_SKEW_MS
    && transaction.expiresDate > transaction.purchaseDate
    && Number.isSafeInteger(transaction.signedDate)
    && transaction.signedDate >= transaction.purchaseDate
    && transaction.signedDate <= now + MAX_APPLE_CLOCK_SKEW_MS
    && (transaction.revocationDate === undefined
      || (Number.isSafeInteger(transaction.revocationDate)
        && transaction.revocationDate >= transaction.purchaseDate
        && transaction.revocationDate <= now + MAX_APPLE_CLOCK_SKEW_MS));
  return transaction.bundleId === (env.APPLE_BUNDLE_ID ?? "com.orbeworks.adless")
    && (transaction.environment === "Production" || transaction.environment === "Sandbox" || transaction.environment === "Xcode")
    && PRODUCT_IDS.has(transaction.productId)
    && identifiersAreValid
    && datesAreValid;
}

function validTestFlightAppTransaction(
  appTransaction: AppleAppTransactionPayload | undefined,
  transaction: AppleTransactionPayload,
  env: AuthorizationEnvironment,
  now: number,
): boolean {
  if (!appTransaction || transaction.environment !== "Sandbox") return false;
  // TestFlight uses Apple's Sandbox environment. Sandbox is not, by itself,
  // evidence that the request came from an uploaded build; development-signed
  // apps can use it too, hence the additional signed fields and app-version allowlist.
  return appTransaction.receiptType === "Sandbox"
    && appTransaction.bundleId === (env.APPLE_BUNDLE_ID ?? "com.orbeworks.adless")
    // Apple omits appAppleId/appID from AppTransaction in Sandbox and Xcode.
    && appTransaction.appAppleId === undefined
    && typeof transaction.appTransactionId === "string"
    && transaction.appTransactionId.length > 0
    && transaction.appTransactionId.length <= MAX_APPLE_IDENTIFIER_LENGTH
    && appTransaction.appTransactionId === transaction.appTransactionId
    && typeof appTransaction.applicationVersion === "string"
    && allowedTestFlightBuildVersions(env).has(appTransaction.applicationVersion)
    && Number.isSafeInteger(appTransaction.receiptCreationDate)
    && appTransaction.receiptCreationDate > 0
    && appTransaction.receiptCreationDate <= now + MAX_APPLE_CLOCK_SKEW_MS;
}

function validXcodeAppTransaction(
  appTransaction: AppleAppTransactionPayload | undefined,
  transaction: AppleTransactionPayload,
  env: AuthorizationEnvironment,
  now: number,
): boolean {
  if (!appTransaction
    || transaction.environment !== "Xcode"
    || !allowedRegistrationEnvironments(env).has("Xcode")
    || !env.XCODE_STOREKIT_CERTIFICATE_SHA256) return false;
  return appTransaction.receiptType === "Xcode"
    && appTransaction.bundleId === (env.APPLE_BUNDLE_ID ?? "com.orbeworks.adless")
    && appTransaction.appAppleId === undefined
    && typeof transaction.appTransactionId === "string"
    && transaction.appTransactionId.length > 0
    && transaction.appTransactionId.length <= MAX_APPLE_IDENTIFIER_LENGTH
    && appTransaction.appTransactionId === transaction.appTransactionId
    && typeof appTransaction.applicationVersion === "string"
    && appTransaction.applicationVersion.length > 0
    && appTransaction.applicationVersion.length <= MAX_APPLE_IDENTIFIER_LENGTH
    && Number.isSafeInteger(appTransaction.receiptCreationDate)
    && appTransaction.receiptCreationDate > 0
    && appTransaction.receiptCreationDate <= now + MAX_APPLE_CLOCK_SKEW_MS;
}

function registrationEnvironmentIsAllowed(
  transaction: AppleTransactionPayload,
  appTransaction: AppleAppTransactionPayload | undefined,
  env: AuthorizationEnvironment,
  now: number,
): boolean {
  if (transaction.environment === "Production") {
    return allowedRegistrationEnvironments(env).has("Production");
  }
  if (transaction.environment === "Sandbox") {
    return validTestFlightAppTransaction(appTransaction, transaction, env, now);
  }
  return validXcodeAppTransaction(appTransaction, transaction, env, now);
}

function validNotification(notification: AppleNotificationPayload, env: AuthorizationEnvironment, now = Date.now()): boolean {
  const data = notification.data;
  const notificationEnvironments = allowedNotificationEnvironments(env);
  const configuredAppAppleId = env.APPLE_APP_ID ? Number(env.APPLE_APP_ID) : undefined;
  const appAppleIdMatches = data?.environment === "Sandbox"
    ? data.appAppleId === undefined
    : data?.environment === "Production"
      ? configuredAppAppleId !== undefined
        && Number.isSafeInteger(configuredAppAppleId)
        && data.appAppleId === configuredAppAppleId
      : data?.appAppleId === undefined
        || (configuredAppAppleId !== undefined
          && Number.isSafeInteger(configuredAppAppleId)
          && data.appAppleId === configuredAppAppleId);
  return typeof notification.notificationType === "string"
    && typeof notification.notificationUUID === "string"
    && notification.notificationUUID.length > 0
    && notification.notificationUUID.length <= MAX_APPLE_IDENTIFIER_LENGTH
    && Number.isSafeInteger(notification.signedDate)
    && notification.signedDate <= now + MAX_APPLE_CLOCK_SKEW_MS
    && appAppleIdMatches
    && (!data?.bundleId || data.bundleId === (env.APPLE_BUNDLE_ID ?? "com.orbeworks.adless"))
    && notificationEnvironments.size > 0
    && (!data?.environment
      || (data.environment !== "Xcode" && notificationEnvironments.has(data.environment)));
}

function validInstallationId(installationId: string): boolean {
  return INSTALLATION_ID_PATTERN.test(installationId);
}

async function readAuthorizationRecord(kv: AuthorizationKV, installationId: string): Promise<AuthorizationRecord | null> {
  return normalizeAuthorizationRecord(
    await readJSON<StoredAuthorizationRecord>(kv, installationKey(installationId)),
  );
}

function authorityEventApplies(
  record: AuthorizationRecord,
  authority: SubscriptionAuthorityEvent | null,
): authority is SubscriptionAuthorityEvent {
  return Boolean(authority)
    && authority?.environment === record.environment
    && authority.originalTransactionId === record.originalTransactionId;
}

function effectiveSubscriptionState(
  record: AuthorizationRecord,
  authority: SubscriptionAuthorityEvent | null,
): Pick<AuthorizationRecord, "status" | "accessUntil"> {
  return authorityEventApplies(record, authority)
    ? { status: authority.status, accessUntil: authority.accessUntil }
    : record;
}

export async function authorizeToken(
  env: AuthorizationEnvironment,
  token: string,
  role: TokenRole,
  now = Date.now(),
): Promise<TokenAuthorization> {
  if (!env.AUTH || !TOKEN_PATTERN.test(token)) return { kind: "rejected", reason: "unknown" };
  const tokenHash = await sha256Hex(token);
  const mapping = await readJSON<TokenRecord>(env.AUTH, tokenKey(tokenHash));
  if (!mapping || mapping.schemaVersion !== 1 || mapping.role !== role || !validInstallationId(mapping.installationId)) {
    return { kind: "rejected", reason: "unknown" };
  }

  const record = await readAuthorizationRecord(env.AUTH, mapping.installationId);
  if (!record || record.installationId !== mapping.installationId) {
    return { kind: "rejected", reason: "unknown" };
  }
  const currentHash = role === "dns" ? record.dnsTokenHash : record.statsTokenHash;
  // Superseded mappings remain known so an iPhone that did not receive or
  // persist the rotation response retains DNS connectivity. They never need
  // the authority object, block, or access statistics.
  if (currentHash !== tokenHash) {
    return role === "dns"
      ? { kind: "passThrough", installationId: mapping.installationId, accessUntil: record.accessUntil }
      : { kind: "rejected", reason: "forbidden" };
  }
  let authority: SubscriptionAuthorityEvent | null;
  try {
    const storedLegacyAuthority = await readJSON<LegacySubscriptionAuthorityRecord>(
      env.AUTH,
      legacySubscriptionAuthorityKey(record.environment, record.originalTransactionId),
    );
    const legacyAuthorityEvent = storedLegacyAuthority
      ? authorityEventFromLegacyAuthority(storedLegacyAuthority)
      : null;
    if (legacyAuthorityEvent) await appendSubscriptionAuthorityEvent(env, legacyAuthorityEvent);
    authority = await appendSubscriptionAuthorityEvent(env, authorityEventFromRecord(record));
  } catch {
    // Mapping plus installation record prove that this is a known credential.
    // An authority outage must not strand DNS, but can never preserve blocking
    // or disclose statistics.
    return role === "dns"
      ? { kind: "passThrough", installationId: mapping.installationId, accessUntil: record.accessUntil }
      : { kind: "rejected", reason: "forbidden" };
  }
  const effective = effectiveSubscriptionState(record, authority);
  const active = effective.status === "active" && effective.accessUntil > now;
  if (role === "stats" && !active) return { kind: "rejected", reason: "forbidden" };
  return { kind: active ? "active" : "passThrough", installationId: mapping.installationId, accessUntil: effective.accessUntil };
}

function statusFromTransaction(transaction: AppleTransactionPayload, now: number): AuthorizationStatus {
  if (transaction.revocationDate !== undefined) return "revoked";
  return (transaction.expiresDate ?? 0) > now ? "active" : "expired";
}

function authorityEventFromTransaction(
  transaction: AppleTransactionPayload,
  now: number,
): SubscriptionAuthorityEvent {
  const status = statusFromTransaction(transaction, now);
  return {
    schemaVersion: 1,
    source: "transaction",
    sourceId: transaction.transactionId,
    reason: status === "revoked"
      ? "TRANSACTION_REVOKED"
      : status === "expired"
        ? "TRANSACTION_EXPIRED"
        : "TRANSACTION_ACTIVE",
    environment: transaction.environment,
    originalTransactionId: transaction.originalTransactionId,
    transactionId: transaction.transactionId,
    productId: transaction.productId,
    status,
    accessUntil: transaction.expiresDate,
    inGracePeriod: false,
    isInBillingRetryPeriod: false,
    periodPurchaseDate: transaction.purchaseDate,
    periodExpiresDate: transaction.expiresDate,
    signedDate: transaction.signedDate,
  };
}

function authorityEventFromRecord(record: AuthorizationRecord): SubscriptionAuthorityEvent {
  return {
    schemaVersion: 1,
    // KV records do not retain which transaction/period produced the
    // notification watermark. Treat them as conservative baselines instead
    // of manufacturing a notification event for the current transaction.
    source: "record",
    sourceId: record.installationId,
    reason: `RECORD_${record.status.toUpperCase()}`,
    environment: record.environment,
    originalTransactionId: record.originalTransactionId,
    transactionId: record.transactionId,
    productId: record.productId,
    status: record.status,
    accessUntil: record.accessUntil,
    inGracePeriod: record.inGracePeriod,
    isInBillingRetryPeriod: record.isInBillingRetryPeriod,
    periodPurchaseDate: 0,
    periodExpiresDate: record.accessUntil,
    // The record does not associate lastNotificationSignedDate with its
    // current transactionId. Using that global watermark here could make a
    // prior-period notification outrank a real recovery for this period.
    signedDate: Math.max(record.lastTransactionSignedDate, 1),
  };
}

function authorityEventFromLegacyAuthority(
  authority: LegacySubscriptionAuthorityRecord,
): SubscriptionAuthorityEvent | null {
  if (authority.schemaVersion !== 1
    || (authority.environment !== "Production" && authority.environment !== "Sandbox" && authority.environment !== "Xcode")
    || !isSafeIdentifier(authority.originalTransactionId)
    || !PRODUCT_IDS.has(authority.productId)
    || (authority.transactionId !== undefined && !isSafeIdentifier(authority.transactionId))
    || (authority.status !== "active" && authority.status !== "expired" && authority.status !== "revoked")
    || !Number.isSafeInteger(authority.accessUntil)
    || authority.accessUntil <= 0
    || !Number.isSafeInteger(authority.lastNotificationSignedDate)
    || authority.lastNotificationSignedDate <= 0) {
    return null;
  }
  return {
    schemaVersion: 1,
    source: "notification",
    sourceId: "legacy-kv-authority",
    reason: `KV_AUTHORITY_${authority.status.toUpperCase()}`,
    environment: authority.environment,
    originalTransactionId: authority.originalTransactionId,
    transactionId: authority.transactionId,
    productId: authority.productId,
    status: authority.status,
    accessUntil: authority.accessUntil,
    inGracePeriod: authority.inGracePeriod,
    isInBillingRetryPeriod: authority.isInBillingRetryPeriod,
    periodPurchaseDate: 0,
    periodExpiresDate: authority.accessUntil,
    signedDate: authority.lastNotificationSignedDate,
  };
}

function authorityEventFromNotification(
  notification: AppleNotificationPayload,
  transaction: AppleTransactionPayload | undefined,
  renewal: AppleRenewalInfoPayload | undefined,
  now: number,
): SubscriptionAuthorityEvent | null {
  const originalTransactionId = transaction?.originalTransactionId ?? renewal?.originalTransactionId;
  const environment = transaction?.environment ?? renewal?.environment;
  const productId = transaction?.productId ?? renewal?.productId;
  if (!originalTransactionId || !environment || !productId) return null;

  const type = notification.notificationType;
  const isRefundReversal = type === "REFUND_REVERSED";
  const isExplicitRecovery = isRefundReversal
    || type === "SUBSCRIBED"
    || type === "DID_RENEW"
    || type === "DID_RECOVER"
    || type === "RENEWAL_EXTENDED";
  const isTerminal = type === "EXPIRED"
    || type === "GRACE_PERIOD_EXPIRED"
    || type === "REFUND"
    || type === "REVOKE"
    || (!isRefundReversal && transaction?.revocationDate !== undefined);
  const isBillingFailure = type === "DID_FAIL_TO_RENEW";
  if (!isExplicitRecovery && !isTerminal && !isBillingFailure) return null;

  const transactionExpiry = transaction?.expiresDate ?? 0;
  const graceExpiry = renewal?.gracePeriodExpiresDate ?? 0;
  const accessUntil = Math.max(transactionExpiry, graceExpiry);
  const forceRevoke = type === "REFUND"
    || type === "REVOKE"
    || (!isRefundReversal && transaction?.revocationDate !== undefined);
  const forceExpire = type === "EXPIRED" || type === "GRACE_PERIOD_EXPIRED";
  const status: AuthorizationStatus = forceRevoke
    ? "revoked"
    : forceExpire || accessUntil <= now
      ? "expired"
      : "active";
  const reason = type === "DID_RENEW" && notification.subtype === "BILLING_RECOVERY"
    ? "BILLING_RECOVERY"
    : type === "SUBSCRIBED" && notification.subtype === "RESUBSCRIBE"
      ? "RESUBSCRIBE"
      : type;
  return {
    schemaVersion: 1,
    source: "notification",
    sourceId: notification.notificationUUID,
    reason,
    environment,
    originalTransactionId,
    transactionId: transaction?.transactionId,
    productId,
    status,
    accessUntil,
    inGracePeriod: !forceRevoke && !forceExpire && graceExpiry > now,
    isInBillingRetryPeriod: !forceRevoke
      && (renewal?.isInBillingRetryPeriod ?? false),
    // A renewal-only notification has no Apple period purchase date. Zero
    // keeps it on the conservative expiry fallback instead of mistaking the
    // outer notification signing time for a purchase.
    periodPurchaseDate: transaction?.purchaseDate ?? 0,
    periodExpiresDate: transaction?.expiresDate ?? accessUntil,
    signedDate: notification.signedDate,
  };
}

interface CurrentCredentialProof {
  dnsToken: string;
  statsToken: string;
}

async function validCurrentCredentialProof(
  kv: AuthorizationKV,
  installationId: string,
  proof: CurrentCredentialProof | undefined,
): Promise<boolean> {
  if (!proof || !TOKEN_PATTERN.test(proof.dnsToken) || !TOKEN_PATTERN.test(proof.statsToken)) return false;
  const [dnsHash, statsHash] = await Promise.all([
    sha256Hex(proof.dnsToken),
    sha256Hex(proof.statsToken),
  ]);
  const [dnsMapping, statsMapping] = await Promise.all([
    readJSON<TokenRecord>(kv, tokenKey(dnsHash)),
    readJSON<TokenRecord>(kv, tokenKey(statsHash)),
  ]);
  return dnsMapping?.schemaVersion === 1
    && dnsMapping.installationId === installationId
    && dnsMapping.role === "dns"
    && statsMapping?.schemaVersion === 1
    && statsMapping.installationId === installationId
    && statsMapping.role === "stats";
}

export async function registerInstallation(
  env: AuthorizationEnvironment,
  installationId: string,
  transaction: AppleTransactionPayload,
  now = Date.now(),
  appTransaction?: AppleAppTransactionPayload,
  rotationNonce = "",
  currentCredentialProof?: CurrentCredentialProof,
): Promise<{ dnsToken: string; statsToken: string; installationId: string; accessUntil: number }> {
  const kv = env.AUTH;
  if (!kv) throw new Error("authorization storage is not configured");
  if (!validInstallationId(installationId)
    || !TOKEN_PATTERN.test(rotationNonce)
    || !validTransaction(transaction, env, now)
    || !registrationEnvironmentIsAllowed(transaction, appTransaction, env, now)) {
    throw new Error("invalid authorization data");
  }
  const transactionClaimKey = transactionKey(transaction.environment, transaction.transactionId);
  const subscriptionIndexKey = subscriptionKey(transaction.environment, transaction.originalTransactionId);
  const [
    storedPrevious,
    claimedTransaction,
    currentSubscription,
    legacySubscription,
    storedLegacyAuthority,
    rotationNonceHash,
  ] = await Promise.all([
    readJSON<StoredAuthorizationRecord>(kv, installationKey(installationId)),
    readJSON<TransactionClaim>(kv, transactionClaimKey),
    readJSON<SubscriptionInstallations>(kv, subscriptionIndexKey),
    readJSON<SubscriptionInstallations>(kv, legacySubscriptionKey(transaction.originalTransactionId)),
    readJSON<LegacySubscriptionAuthorityRecord>(
      kv,
      legacySubscriptionAuthorityKey(transaction.environment, transaction.originalTransactionId),
    ),
    sha256Hex(rotationNonce),
  ]);
  const previous = normalizeAuthorizationRecord(storedPrevious);
  const claimedInstallationIds = claimedTransaction?.schemaVersion === 1
    && claimedTransaction.originalTransactionId === transaction.originalTransactionId
    ? claimedTransaction.installationIds ?? []
    : [];
  const indexedInstallationIds = [...new Set([
    ...(currentSubscription?.installationIds ?? []),
    ...(legacySubscription?.installationIds ?? []),
    ...claimedInstallationIds,
  ])].filter(validInstallationId);
  const indexedRecords = await Promise.all(indexedInstallationIds.map((indexedInstallationId) =>
    readAuthorizationRecord(kv, indexedInstallationId)));
  const seedRecords = [previous, ...indexedRecords].filter((record): record is AuthorizationRecord => Boolean(record)
    && record?.environment === transaction.environment
    && record.originalTransactionId === transaction.originalTransactionId);
  for (const seed of new Map(seedRecords.map((record) => [record.installationId, record])).values()) {
    await appendSubscriptionAuthorityEvent(env, authorityEventFromRecord(seed));
  }
  const legacyAuthorityEvent = storedLegacyAuthority
    ? authorityEventFromLegacyAuthority(storedLegacyAuthority)
    : null;
  if (legacyAuthorityEvent) await appendSubscriptionAuthorityEvent(env, legacyAuthorityEvent);

  // The strongly-consistent authority object orders this Apple-signed event
  // before any KV credential commit. A terminal latest event fails closed;
  // a genuinely later transaction can recover the same subscription chain.
  const authority = await appendSubscriptionAuthorityEvent(
    env,
    authorityEventFromTransaction(transaction, now),
  );
  if (authority.status !== "active" || authority.accessUntil <= now) {
    throw new Error("subscription authority does not grant access");
  }

  const sameRegisteredTransaction = previous
    && previous.environment === transaction.environment
    && previous.originalTransactionId === transaction.originalTransactionId
    && previous.lastRegistrationTransactionId === transaction.transactionId;
  if (sameRegisteredTransaction && storedPrevious?.schemaVersion === 2) {
    if (previous.rotationNonceHash !== rotationNonceHash) {
      throw new Error("transaction replayed with a different nonce");
    }
    const credentials = await deriveTokens(
      env.AUTH_TOKEN_DERIVATION_SECRET,
      installationId,
      transaction,
      rotationNonce,
    );
    const [dnsTokenHash, statsTokenHash] = await Promise.all([
      sha256Hex(credentials.dnsToken),
      sha256Hex(credentials.statsToken),
    ]);
    if (dnsTokenHash !== previous.dnsTokenHash || statsTokenHash !== previous.statsTokenHash) {
      throw new Error("idempotent token derivation mismatch");
    }
    return {
      ...credentials,
      installationId,
      accessUntil: authority.accessUntil,
    };
  }

  const legacySameTransactionMigration = Boolean(sameRegisteredTransaction)
    && storedPrevious?.schemaVersion === 1
    && await validCurrentCredentialProof(kv, installationId, currentCredentialProof);
  if (sameRegisteredTransaction && !legacySameTransactionMigration) {
    throw new Error("legacy replay requires current credential proof");
  }
  const notificationAnnouncedTransaction = previous
    && previous.transactionId === transaction.transactionId
    && previous.lastRegistrationTransactionId !== transaction.transactionId;
  if (previous
    && !legacySameTransactionMigration
    && !notificationAnnouncedTransaction
    && transaction.signedDate <= previous.lastTransactionSignedDate) {
    throw new Error("transaction replayed or out of order");
  }
  if (previous && !legacySameTransactionMigration && rotationNonceHash === previous.rotationNonceHash) {
    throw new Error("a credential rotation requires a fresh nonce");
  }
  const claimedInstallations = claimedTransaction?.installationIds.filter(validInstallationId) ?? [];
  if (!claimedInstallations.includes(installationId) && claimedInstallations.length >= MAX_INSTALLATIONS_PER_SUBSCRIPTION) {
    throw new Error("transaction replay limit reached");
  }
  const subscriptionInstallations = currentSubscription?.installationIds.filter(validInstallationId) ?? [];
  if (!subscriptionInstallations.includes(installationId)) {
    if (subscriptionInstallations.length >= MAX_INSTALLATIONS_PER_SUBSCRIPTION) {
      throw new Error("subscription installation limit reached");
    }
    subscriptionInstallations.push(installationId);
  }

  const { dnsToken, statsToken } = await deriveTokens(
    env.AUTH_TOKEN_DERIVATION_SECRET,
    installationId,
    transaction,
    rotationNonce,
  );
  const [dnsTokenHash, statsTokenHash] = await Promise.all([sha256Hex(dnsToken), sha256Hex(statsToken)]);
  const lastNotificationSignedDate = authority.source === "notification"
    ? Math.max(previous?.lastNotificationSignedDate ?? 0, authority.signedDate)
    : previous?.lastNotificationSignedDate ?? 0;
  const effectiveAccessUntil = authority.accessUntil;
  const record: AuthorizationRecord = {
    schemaVersion: 2,
    installationId,
    originalTransactionId: transaction.originalTransactionId,
    transactionId: authority.transactionId ?? transaction.transactionId,
    lastRegistrationTransactionId: transaction.transactionId,
    productId: authority.productId,
    environment: transaction.environment,
    status: authority.status,
    accessUntil: effectiveAccessUntil,
    inGracePeriod: authority.inGracePeriod,
    isInBillingRetryPeriod: authority.isInBillingRetryPeriod,
    updatedAt: now,
    lastTransactionSignedDate: Math.max(previous?.lastTransactionSignedDate ?? 0, transaction.signedDate),
    lastNotificationSignedDate,
    rotationNonceHash,
    dnsTokenHash,
    statsTokenHash,
  };

  // KV has no multi-key transaction. New mappings and indexes are harmless
  // until the installation record switches hashes, so that record is the
  // commit point. A failed pre-commit write leaves the previous credentials
  // usable instead of stranding DNS.
  await kv.put(tokenKey(dnsTokenHash), JSON.stringify({ schemaVersion: 1, installationId, role: "dns" }));
  await kv.put(tokenKey(statsTokenHash), JSON.stringify({ schemaVersion: 1, installationId, role: "stats" }));
  await kv.put(transactionClaimKey, JSON.stringify({
    schemaVersion: 1,
    originalTransactionId: transaction.originalTransactionId,
    installationIds: [...new Set([...claimedInstallations, installationId])].slice(-MAX_INSTALLATIONS_PER_SUBSCRIPTION),
  }));
  await kv.put(subscriptionIndexKey, JSON.stringify({
    schemaVersion: 1,
    installationIds: subscriptionInstallations.slice(-MAX_INSTALLATIONS_PER_SUBSCRIPTION),
  }));
  await kv.put(installationKey(installationId), JSON.stringify(record));

  return { dnsToken, statsToken, installationId, accessUntil: effectiveAccessUntil };
}

function recordWithAuthorityEvent(
  current: AuthorizationRecord,
  authority: SubscriptionAuthorityEvent,
  now: number,
): AuthorizationRecord {
  if (!authorityEventApplies(current, authority)) return current;
  return {
    ...current,
    productId: authority.productId,
    transactionId: authority.transactionId ?? current.transactionId,
    status: authority.status,
    accessUntil: authority.accessUntil,
    inGracePeriod: authority.inGracePeriod,
    isInBillingRetryPeriod: authority.isInBillingRetryPeriod,
    updatedAt: now,
    lastNotificationSignedDate: authority.source === "notification"
      ? Math.max(current.lastNotificationSignedDate, authority.signedDate)
      : current.lastNotificationSignedDate,
  };
}

export async function processAppleNotification(
  env: AuthorizationEnvironment,
  notification: AppleNotificationPayload,
  transaction: AppleTransactionPayload | undefined,
  renewal: AppleRenewalInfoPayload | undefined,
  now = Date.now(),
): Promise<void> {
  const kv = env.AUTH;
  if (!kv) throw new Error("authorization storage is not configured");
  const originalTransactionId = transaction?.originalTransactionId ?? renewal?.originalTransactionId;
  if (!originalTransactionId) return;
  const environment = transaction?.environment ?? renewal?.environment;
  if (!environment) return;
  const [subscriptions, legacySubscriptions, claimedTransaction, storedLegacyAuthority] = await Promise.all([
    readJSON<SubscriptionInstallations>(kv, subscriptionKey(environment, originalTransactionId)),
    readJSON<SubscriptionInstallations>(kv, legacySubscriptionKey(originalTransactionId)),
    transaction
      ? readJSON<TransactionClaim>(kv, transactionKey(environment, transaction.transactionId))
      : Promise.resolve(null),
    readJSON<LegacySubscriptionAuthorityRecord>(
      kv,
      legacySubscriptionAuthorityKey(environment, originalTransactionId),
    ),
  ]);
  const installationIds = [...new Set([
    ...(subscriptions?.installationIds ?? []),
    ...(legacySubscriptions?.installationIds ?? []),
    ...(claimedTransaction?.schemaVersion === 1
      && claimedTransaction.originalTransactionId === originalTransactionId
      ? claimedTransaction.installationIds ?? []
      : []),
  ])].filter(validInstallationId);
  const records = await Promise.all(installationIds.map((installationId) =>
    readAuthorizationRecord(kv, installationId)));
  const matchingRecords = records.filter((record): record is AuthorizationRecord => Boolean(record)
    && record?.originalTransactionId === originalTransactionId
    && record.environment === environment);
  for (const record of matchingRecords) {
    await appendSubscriptionAuthorityEvent(env, authorityEventFromRecord(record));
  }
  const legacyAuthorityEvent = storedLegacyAuthority
    ? authorityEventFromLegacyAuthority(storedLegacyAuthority)
    : null;
  if (legacyAuthorityEvent) await appendSubscriptionAuthorityEvent(env, legacyAuthorityEvent);

  const event = authorityEventFromNotification(notification, transaction, renewal, now);
  // This call completes before the KV notification-dedup marker is written.
  // Replays are safe because the DO event key is immutable and idempotent.
  const authority = event
    ? await appendSubscriptionAuthorityEvent(env, event)
    : await readSubscriptionAuthority(env, environment, originalTransactionId);
  if (!authority) return;
  await Promise.allSettled(matchingRecords.map((record) => kv.put(
    installationKey(record.installationId),
    JSON.stringify(recordWithAuthorityEvent(record, authority, now)),
  )));
}

async function readJSONBody(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return null;
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function handleAuthorizationRegister(
  request: Request,
  env: AuthorizationEnvironment,
  dependencies: AuthorizationDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = await readJSONBody(request, 256 * 1024);
  const installationId = typeof body?.installationId === "string" ? body.installationId : "";
  const transactionJWS = typeof body?.transactionJWS === "string" ? body.transactionJWS : "";
  const appTransactionJWS = typeof body?.appTransactionJWS === "string" ? body.appTransactionJWS : "";
  const rotationNonce = typeof body?.rotationNonce === "string" ? body.rotationNonce : "";
  const currentDnsToken = typeof body?.currentDnsToken === "string" ? body.currentDnsToken : "";
  const currentStatsToken = typeof body?.currentStatsToken === "string" ? body.currentStatsToken : "";
  const hasCurrentCredentialProof = currentDnsToken.length > 0 || currentStatsToken.length > 0;
  if (!validInstallationId(installationId)
    || !TOKEN_PATTERN.test(rotationNonce)
    || transactionJWS.length === 0
    || transactionJWS.length > 128 * 1024
    || appTransactionJWS.length > 128 * 1024
    || (hasCurrentCredentialProof
      && (!TOKEN_PATTERN.test(currentDnsToken) || !TOKEN_PATTERN.test(currentStatsToken)))) {
    console.warn("authorization.register.rejected", { reason: "invalid_request" });
    return jsonResponse({ error: "invalid request" }, 400);
  }

  let appleEnvironment: AppleEnvironment | undefined;
  let appVersion: string | undefined;
  try {
    const now = dependencies.now?.() ?? Date.now();
    const jwsOptions = {
      ...dependencies.appleJWSOptions,
      trustedLeafCertificateSHA256: env.XCODE_STOREKIT_CERTIFICATE_SHA256,
      verificationTime: dependencies.appleJWSOptions?.verificationTime ?? new Date(now),
    };
    const transaction = dependencies.verifyTransaction
      ? await dependencies.verifyTransaction(transactionJWS)
      : await verifyAppleJWS<AppleTransactionPayload>(transactionJWS, jwsOptions);
    appleEnvironment = transaction.environment;
    const appTransaction = appTransactionJWS.length > 0
      ? dependencies.verifyAppTransaction
        ? await dependencies.verifyAppTransaction(appTransactionJWS)
        : await verifyAppleJWS<AppleAppTransactionPayload>(appTransactionJWS, jwsOptions)
      : undefined;
    appVersion = appTransaction?.applicationVersion;
    const result = await registerInstallation(
      env,
      installationId,
      transaction,
      now,
      appTransaction,
      rotationNonce,
      hasCurrentCredentialProof ? { dnsToken: currentDnsToken, statsToken: currentStatsToken } : undefined,
    );
    return jsonResponse(result);
  } catch {
    console.warn("authorization.register.rejected", {
      appleEnvironment: appleEnvironment ?? null,
      appVersion: appVersion ?? null,
      reason: "transaction_not_authorized",
    });
    return jsonResponse({ error: "transaction not authorized" }, 401);
  }
}

export async function handleAppleNotification(
  request: Request,
  env: AuthorizationEnvironment,
  dependencies: AuthorizationDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const body = await readJSONBody(request, 160 * 1024);
  const signedPayload = typeof body?.signedPayload === "string" ? body.signedPayload : "";
  if (!signedPayload) return jsonResponse({ error: "invalid request" }, 400);

  try {
    const now = dependencies.now?.() ?? Date.now();
    const jwsOptions = { ...dependencies.appleJWSOptions, verificationTime: dependencies.appleJWSOptions?.verificationTime ?? new Date(now) };
    const notification = dependencies.verifyNotification
      ? await dependencies.verifyNotification(signedPayload)
      : await verifyAppleJWS<AppleNotificationPayload>(signedPayload, jwsOptions);
    if (!validNotification(notification, env, now) || !env.AUTH) return jsonResponse({ error: "invalid notification" }, 400);

    const transactionJWS = notification.data?.signedTransactionInfo;
    const renewalJWS = notification.data?.signedRenewalInfo;
    const transaction = transactionJWS
      ? dependencies.verifyTransaction
        ? await dependencies.verifyTransaction(transactionJWS)
        : await verifyAppleJWS<AppleTransactionPayload>(transactionJWS, jwsOptions)
      : undefined;
    const renewal = renewalJWS
      ? dependencies.verifyRenewalInfo
        ? await dependencies.verifyRenewalInfo(renewalJWS)
        : await verifyAppleJWS<AppleRenewalInfoPayload>(renewalJWS, jwsOptions)
      : undefined;

    if (transaction && (transaction.environment === "Xcode"
      || !validTransaction(transaction, env, now)
      || !allowedNotificationEnvironments(env).has(transaction.environment))) {
      return jsonResponse({ error: "invalid transaction" }, 400);
    }
    if (renewal && (renewal.environment === "Xcode"
      || !PRODUCT_IDS.has(renewal.productId ?? "")
      || typeof renewal.originalTransactionId !== "string"
      || renewal.originalTransactionId.length === 0
      || renewal.originalTransactionId.length > MAX_APPLE_IDENTIFIER_LENGTH
      || !allowedNotificationEnvironments(env).has(renewal.environment))) {
      return jsonResponse({ error: "invalid renewal" }, 400);
    }
    if (notification.data?.environment && transaction && notification.data.environment !== transaction.environment) {
      return jsonResponse({ error: "notification environment mismatch" }, 400);
    }
    if (notification.data?.environment && renewal && notification.data.environment !== renewal.environment) {
      return jsonResponse({ error: "notification environment mismatch" }, 400);
    }
    if (transaction && renewal && transaction.originalTransactionId !== renewal.originalTransactionId) {
      return jsonResponse({ error: "notification transaction mismatch" }, 400);
    }
    if (transaction && renewal && transaction.environment !== renewal.environment) {
      return jsonResponse({ error: "notification environment mismatch" }, 400);
    }
    if (transaction && renewal && renewal.productId && transaction.productId !== renewal.productId) {
      return jsonResponse({ error: "notification product mismatch" }, 400);
    }
    await processAppleNotification(env, notification, transaction, renewal, now);
    const dedupKey = notificationKey(notification.notificationUUID);
    if (!await env.AUTH.get(dedupKey, "text")) {
      await env.AUTH.put(dedupKey, "1", { expirationTtl: NOTIFICATION_TTL_SECONDS });
    }
    return jsonResponse({ ok: true });
  } catch {
    return jsonResponse({ error: "notification could not be processed" }, 400);
  }
}
