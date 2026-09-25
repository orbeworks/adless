export interface StatsStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction?<T>(callback: (transaction: StatsStorage) => Promise<T>): Promise<T>;
}

export interface DurableObjectStateLike {
  storage: StatsStorage;
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface SubscriptionAuthorityEvent {
  schemaVersion: 1;
  source: "record" | "transaction" | "notification";
  sourceId: string;
  reason: string;
  environment: "Production" | "Sandbox" | "Xcode";
  originalTransactionId: string;
  transactionId?: string;
  productId: string;
  status: "active" | "expired" | "revoked";
  accessUntil: number;
  inGracePeriod: boolean;
  isInBillingRetryPeriod: boolean;
  /** Orders subscription periods using the StoreKit transaction purchase date. */
  periodPurchaseDate: number;
  /** Distinguishes/records the entitlement window within the same purchase date. */
  periodExpiresDate: number;
  /** Orders Apple notification corrections to the same transaction period. */
  signedDate: number;
}

export interface KVNamespaceLike {
  get(key: string, type?: "json" | "text"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WorkerEnvironment {
  AUTH?: KVNamespaceLike;
  AUTH_TOKEN_DERIVATION_SECRET?: string;
  AUTHORITY?: DurableObjectNamespaceLike;
  STATS?: DurableObjectNamespaceLike;
  APPLE_BUNDLE_ID?: string;
  APPLE_APP_ID?: string;
  APPLE_ALLOWED_ENVIRONMENTS?: string;
  APPLE_NOTIFICATION_ENVIRONMENTS?: string;
  APPLE_TESTFLIGHT_BUILD_VERSIONS?: string;
  XCODE_STOREKIT_CERTIFICATE_SHA256?: string;
  CONFIGCAT_SDK_KEY?: string;
  DEPLOYMENT_ENV?: "production" | "development";
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
