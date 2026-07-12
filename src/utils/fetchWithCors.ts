/**
 * Shared CORS fetch utility for manga sources.
 *
 * Source implementations run in both extension context (content script)
 * and page context (viewer). This utility auto-detects the execution
 * context and routes the fetch through the background service worker
 * via the appropriate channel.
 */

export interface FetchInit {
  method?: 'GET' | 'POST';
  /** String body only (form-urlencoded etc.); must survive message serialization */
  body?: string;
  /** 'include' sends the user's cookies for the target site (host permission
   *  required). Lets sources behind bot walls reuse a clearance cookie the
   *  user earned by visiting the site in a normal tab. */
  credentials?: 'include' | 'omit' | 'same-origin';
  /** 'reload' bypasses Chrome's HTTP cache — required for probes that must
   *  observe the live site (a cached page hides an active bot wall). */
  cache?: 'reload' | 'no-store' | 'default';
}

/**
 * Fetch a URL through the background service worker to bypass CORS.
 * Auto-detects whether we're in extension context (chrome API) or
 * page context (bridge relay). The background spreads options into
 * fetch(), so method/body pass through.
 */
export async function fetchWithCors(url: string, headers: HeadersInit = {}, init: FetchInit = {}): Promise<Response> {
  const hasChrome = typeof chrome !== 'undefined' &&
                    typeof chrome.runtime !== 'undefined' &&
                    typeof chrome.runtime.sendMessage === 'function';

  if (hasChrome) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'FETCH',
          url,
          options: { headers, ...init },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (response.error) {
            reject(new Error(response.error));
            return;
          }

          const headerMap = response.headers || {};
          resolve({
            ok: response.ok,
            status: response.status,
            url: response.url,
            headers: { get: (name: string) => headerMap[name.toLowerCase()] ?? null } as Headers,
            text: () => Promise.resolve(response.body),
            json: () => Promise.resolve(JSON.parse(response.body)),
          } as Response);
        }
      );
    });
  } else {
    const { bridgeRuntime } = await import('@/utils/bridge');
    const response = await bridgeRuntime.sendMessage({
      type: 'FETCH',
      payload: {
        url,
        options: { headers, ...init },
      },
    });

    if (response.error) {
      throw new Error(response.error);
    }

    const headerMap = response.headers || {};
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      headers: { get: (name: string) => headerMap[name.toLowerCase()] ?? null } as Headers,
      text: () => Promise.resolve(response.body),
      json: () => Promise.resolve(JSON.parse(response.body)),
    } as Response;
  }
}
