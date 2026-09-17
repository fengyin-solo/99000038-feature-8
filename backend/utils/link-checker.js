/**
 * Check if a URL is reachable using fetch with timeout.
 *
 * Statuses are split into three outcomes so the UI can treat them differently:
 * - alive:  HTTP response with status < 400
 * - dead:   server responded with an HTTP error (4xx/5xx), the link itself is broken
 * - failed: no usable response (timeout, connection refused, DNS error, ...),
 *           the result is inconclusive and the link can be retried on its own
 *
 * Returns: { url, status, alive, error, outcome }
 */
function classifyResponse(httpStatus) {
  return {
    alive: httpStatus >= 200 && httpStatus < 400,
    outcome: httpStatus >= 400 ? 'dead' : 'alive',
  };
}

async function fetchOnce(url, method, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkUrl(url, timeoutMs = 8000) {
  try {
    let response;
    try {
      response = await fetchOnce(url, 'HEAD', timeoutMs);
    } catch (headErr) {
      // Network-level failure on HEAD: fall back to GET, as some servers
      // reject HEAD outright (and others refuse it with 403/405).
      if (headErr.name === 'AbortError') {
        // Do not spend another timeout window on a slow/unreachable host.
        throw headErr;
      }
      response = await fetchOnce(url, 'GET', timeoutMs);
    }

    // Some hosts answer HEAD with 403/405/501 even though GET works.
    if ([403, 405, 501].includes(response.status)) {
      response = await fetchOnce(url, 'GET', timeoutMs);
    }

    const { alive, outcome } = classifyResponse(response.status);
    return {
      url,
      status: response.status,
      alive,
      outcome,
      error: null,
    };
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    return {
      url,
      status: null,
      alive: false,
      outcome: 'failed',
      error: isTimeout ? 'Timeout' : (err.message || 'Network error'),
    };
  }
}

/**
 * Check multiple URLs one at a time.
 * @param {string[]} urls
 * @param {function} onProgress - callback(current, total, result)
 * @param {function} shouldCancel - optional predicate checked between links
 */
async function checkUrls(urls, onProgress = null, shouldCancel = null) {
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    if (shouldCancel && shouldCancel()) {
      break;
    }

    const result = await checkUrl(urls[i]);
    results.push(result);

    if (onProgress) {
      onProgress(i + 1, urls.length, result);
    }
  }

  return results;
}

module.exports = { checkUrl, checkUrls };
