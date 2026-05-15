/**
 * icons.js — Favicon Fetching & Caching Service
 *
 * Fetches and caches service favicons (small icons/logos) for each credential entry.
 * Uses Google's Favicon API as primary source, with favicon.im as fallback.
 * Icons are cached as base64 data URIs in localStorage with 7-day expiry.
 */

// ===== Constants =====

const ICON_CACHE_PREFIX = 'pv_icon_';
const ICON_CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ICON_PREFETCH_BATCH_SIZE = 3;
const ICON_PREFETCH_DELAY_MS = 500; // delay between batches

// ===== Internal Helpers =====

/**
 * Extract the hostname from a URL string.
 * @param {string} url - Full URL (e.g., "https://github.com/login")
 * @returns {string|null} Domain hostname or null
 */
function extractDomain(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.hostname || null;
  } catch (e) {
    return null;
  }
}

/**
 * Convert a Blob to a base64 data URI string.
 * @param {Blob} blob - The blob to convert
 * @returns {Promise<string|null>} Data URI string or null on failure
 */
function blobToDataUri(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string' && reader.result.length > 0) {
        resolve(reader.result);
      } else {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    try {
      reader.readAsDataURL(blob);
    } catch (e) {
      resolve(null);
    }
  });
}

// ===== Core Functions =====

/**
 * Fetch a single favicon as base64 data URI.
 * Tries Google Favicon API first, then favicon.im as fallback.
 *
 * @param {string} url - The service URL (e.g., "https://github.com")
 * @returns {Promise<string|null>} Data URI string or null on failure
 */
async function fetchIcon(url) {
  const domain = extractDomain(url);
  if (!domain) return null;

  // Try Google Favicon API first (sz=64 for larger icons)
  try {
    const googleUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
    const resp = await fetch(googleUrl, { mode: 'cors', credentials: 'omit' });
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 0) {
        const dataUri = await blobToDataUri(blob);
        if (dataUri) return dataUri;
      }
    }
  } catch (e) {
    // Google API failed, try fallback
  }

  // Fallback: favicon.im (sometimes better quality / larger icons)
  try {
    const fallbackUrl = `https://favicon.im/${encodeURIComponent(domain)}`;
    const resp = await fetch(fallbackUrl, { mode: 'cors', credentials: 'omit' });
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 0) {
        const dataUri = await blobToDataUri(blob);
        if (dataUri) return dataUri;
      }
    }
  } catch (e) {
    // Fallback also failed
  }

  return null;
}

/**
 * Get a cached icon or fetch it if not cached / expired.
 *
 * @param {string} serviceId - The service identifier (e.g., "github")
 * @param {string} loginUrl - The login URL to extract domain from
 * @returns {Promise<string|null>} Data URI string or null
 */
async function getIcon(serviceId, loginUrl) {
  // Check cache first
  const cached = getCachedIcon(serviceId);
  if (cached) return cached;

  // Not cached or expired — fetch it
  const dataUri = await fetchIcon(loginUrl);
  if (dataUri) {
    // Store in cache
    try {
      const entry = JSON.stringify({
        dataUri: dataUri,
        fetchedAt: Date.now()
      });
      localStorage.setItem(ICON_CACHE_PREFIX + serviceId, entry);
    } catch (e) {
      // localStorage might be full — silently ignore
    }
    return dataUri;
  }

  return null;
}

/**
 * Prefetch icons for all services in batches.
 * Called once on app init (throttled to once per day via pv_icons_prefetched_at).
 *
 * @param {Array} services - The SERVICES array from services.js
 * @returns {Promise<void>}
 */
async function prefetchAllIcons(services) {
  if (!services || !Array.isArray(services)) return;

  // Throttle: only prefetch once per day
  try {
    const lastPrefetch = parseInt(localStorage.getItem('pv_icons_prefetched_at') || '0', 10);
    const now = Date.now();
    if (now - lastPrefetch < 24 * 60 * 60 * 1000) {
      return; // Already prefetched today
    }
  } catch (e) {
    // Continue with prefetch
  }

  // Filter services that have a loginUrl and are not already cached
  const toFetch = services.filter(svc => {
    if (!svc.loginUrl && !svc.domain) return false;
    return !isIconCached(svc.id);
  });

  // Process in batches of ICON_PREFETCH_BATCH_SIZE
  for (let i = 0; i < toFetch.length; i += ICON_PREFETCH_BATCH_SIZE) {
    const batch = toFetch.slice(i, i + ICON_PREFETCH_BATCH_SIZE);
    const promises = batch.map(svc => {
      const url = svc.loginUrl || (svc.domain ? `https://${svc.domain}` : null);
      if (!url) return Promise.resolve(null);
      return getIcon(svc.id, url).catch(() => null);
    });
    await Promise.all(promises);

    // Delay between batches to avoid overwhelming the network
    if (i + ICON_PREFETCH_BATCH_SIZE < toFetch.length) {
      await new Promise(resolve => setTimeout(resolve, ICON_PREFETCH_DELAY_MS));
    }
  }

  // Mark prefetch timestamp
  try {
    localStorage.setItem('pv_icons_prefetched_at', String(Date.now()));
  } catch (e) {
    // Ignore
  }
}

/**
 * Clear all cached icons from localStorage.
 */
function clearIconCache() {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(ICON_CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
    // Also clear prefetch timestamp
    localStorage.removeItem('pv_icons_prefetched_at');
  } catch (e) {
    // Ignore
  }
}

/**
 * Check if an icon is cached and not expired.
 *
 * @param {string} serviceId - The service identifier
 * @returns {boolean} True if cached and not expired
 */
function isIconCached(serviceId) {
  try {
    const raw = localStorage.getItem(ICON_CACHE_PREFIX + serviceId);
    if (!raw) return false;
    const entry = JSON.parse(raw);
    if (!entry || !entry.fetchedAt || !entry.dataUri) return false;
    // Check expiry
    if (Date.now() - entry.fetchedAt > ICON_CACHE_EXPIRY_MS) return false;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Return cached icon data URI or null.
 *
 * @param {string} serviceId - The service identifier
 * @returns {string|null} Data URI string or null
 */
function getCachedIcon(serviceId) {
  try {
    if (!isIconCached(serviceId)) return null;
    const raw = localStorage.getItem(ICON_CACHE_PREFIX + serviceId);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    return (entry && entry.dataUri) ? entry.dataUri : null;
  } catch (e) {
    return null;
  }
}

// ===== Global exports =====

window.fetchIcon = fetchIcon;
window.getIcon = getIcon;
window.prefetchAllIcons = prefetchAllIcons;
window.clearIconCache = clearIconCache;
window.isIconCached = isIconCached;
window.getCachedIcon = getCachedIcon;

export {
  fetchIcon,
  getIcon,
  prefetchAllIcons,
  clearIconCache,
  isIconCached,
  getCachedIcon
};
