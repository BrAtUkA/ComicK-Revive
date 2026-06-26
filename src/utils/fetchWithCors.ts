/**
 * Shared CORS fetch utility for manga sources.
 *
 * Source implementations run in both extension context (content script)
 * and page context (viewer). This utility auto-detects the execution
 * context and routes the fetch through the background service worker
 * via the appropriate channel.
 */

/**
 * Fetch a URL through the background service worker to bypass CORS.
 * Auto-detects whether we're in extension context (chrome API) or
 * page context (bridge relay).
 */
export async function fetchWithCors(url: string, headers: HeadersInit = {}): Promise<Response> {
  const hasChrome = typeof chrome !== 'undefined' &&
                    typeof chrome.runtime !== 'undefined' &&
                    typeof chrome.runtime.sendMessage === 'function';

  if (hasChrome) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'FETCH',
          url,
          options: { headers },
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
        options: { headers },
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
