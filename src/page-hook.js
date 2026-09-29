/**
 * Runs in the page's MAIN world (the DOM carries no card id). Wraps window.fetch
 * to read WikiMasters API responses, extracts every object shaped like a card
 * ({ id, wikipedia_title, category }) and forwards them to the content script.
 * The response seen by the site is never altered: we only read a clone.
 */
(() => {
  const MESSAGE_SOURCE = 'wmio-page-hook';
  const MAX_VISITED_NODES = 50000;

  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function' || originalFetch.__wmioWrapped) return;

  function collectCards(root) {
    const cards = [];
    const stack = [root];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_VISITED_NODES) {
      const node = stack.pop();
      visited++;
      if (!Array.isArray(node) && typeof node.id === 'string' && typeof node.wikipedia_title === 'string') {
        cards.push({
          id: node.id,
          title: node.wikipedia_title,
          category: typeof node.category === 'string' ? node.category : '',
        });
      }
      for (const value of Object.values(node)) {
        if (value !== null && typeof value === 'object') stack.push(value);
      }
    }
    return cards;
  }

  function isSiteApi(response) {
    try {
      const url = new URL(response.url, window.location.href);
      return url.origin === window.location.origin && url.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  }

  async function inspect(response) {
    try {
      if (!(response.headers.get('content-type') || '').includes('application/json')) return;
      const body = await response.json();
      if (body === null || typeof body !== 'object') return;
      const cards = collectCards(body);
      if (cards.length > 0) {
        window.postMessage({ source: MESSAGE_SOURCE, type: 'cards', cards }, window.location.origin);
      }
    } catch {
      // Unreadable body: the site handles its own responses, nothing to do here.
    }
  }

  function wrappedFetch(...args) {
    const promise = originalFetch.apply(this, args);
    // Registered before the caller's handlers, so the body is cloned before the site reads it.
    promise.then((response) => {
      if (isSiteApi(response)) inspect(response.clone());
    }, () => {});
    return promise;
  }
  wrappedFetch.__wmioWrapped = true;
  window.fetch = wrappedFetch;
})();
