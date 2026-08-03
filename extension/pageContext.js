/**
 * Run fetch / read ytInitialPlayerResponse inside a real YouTube tab.
 * Service-worker fetch often gets empty timedtext; page context has cookies + correct client.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('YouTube tab load timeout'));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
        return;
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

/**
 * Use an existing watch tab for videoId, or open a background tab and close it after.
 * @param {string} videoId
 * @param {(tabId: number) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withYoutubeTab(videoId, fn) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://m.youtube.com/*'] });
  let tab = tabs.find((t) => typeof t.url === 'string' && t.url.includes(`v=${videoId}`));
  let created = false;

  if (!tab) {
    tab = await chrome.tabs.create({ url: watchUrl, active: false });
    created = true;
    await waitTabComplete(tab.id);
    // allow ytInitialPlayerResponse to populate
    await sleep(2000);
  }

  try {
    return await fn(tab.id);
  } finally {
    if (created && tab?.id != null) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

export async function getCaptionTracksFromTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const tracks =
        window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer
          ?.captionTracks || null;
      return tracks;
    },
  });
  return result || null;
}

export async function fetchTextInTab(tabId, url) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (fetchUrl) => {
      try {
        const res = await fetch(fetchUrl, { credentials: 'include' });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text, len: text.length };
      } catch (e) {
        return { ok: false, status: 0, text: '', len: 0, error: e.message };
      }
    },
    args: [url],
  });
  if (!result) throw new Error('Page-context fetch returned no result');
  if (result.error) throw new Error(`Page-context fetch: ${result.error}`);
  if (!result.ok) throw new Error(`Page-context fetch failed: ${result.status}`);
  return result.text || '';
}
