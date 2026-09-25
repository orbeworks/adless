import * as configcat from "@configcat/sdk/cloudflare-worker";
import type { WorkerEnvironment } from "./types.js";

export const SUBSCRIPTION_REQUIRED_FLAG = "subscription_required";

const CACHE_TTL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 2_000;

export async function subscriptionIsRequired(env: WorkerEnvironment): Promise<boolean> {
  const sdkKey = env.CONFIGCAT_SDK_KEY;
  if (!sdkKey) return true;

  try {
    const client = configcat.getClient(sdkKey, configcat.PollingMode.LazyLoad, {
      cacheTimeToLiveSeconds: CACHE_TTL_SECONDS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    return await client.getValueAsync(SUBSCRIPTION_REQUIRED_FLAG, true);
  } catch {
    // Losing remote configuration must never grant access accidentally.
    return true;
  }
}
