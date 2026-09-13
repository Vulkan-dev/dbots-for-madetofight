/**
 * Sanitizes and normalizes error messages, stripping raw HTML error pages
 * (such as Azure Front Door WAF 403 blocks) and returning human-readable summaries.
 */
export function sanitizeErrorMessage(rawError: any): string {
  if (!rawError) return 'Unknown error';

  let str =
    typeof rawError === 'string'
      ? rawError
      : rawError?.message || rawError?.toString() || '';

  // If error has an AggregateError with multiple sub-errors, combine their messages
  if (rawError && Array.isArray(rawError.errors) && rawError.errors.length > 0) {
    str = rawError.errors.map((e: any) => e?.message || String(e)).join('; ');
  }

  // 1. Check for Microsoft / Azure Front Door WAF blocks
  if (
    str.includes('The request is blocked') ||
    str.includes('16656fcbc') || // Azure Front Door errorref prefix
    (str.includes('403') && (str.includes('Forbidden') || str.includes('<!DOCTYPE')))
  ) {
    const refMatch = str.match(/<span>\s*([0-9A-Za-z_-]+)\s*<\/span>/i);
    const refId = refMatch ? refMatch[1].trim() : '';
    return `Microsoft / Xbox Live Auth blocked by Azure WAF (HTTP 403 Forbidden - IP rate-limited${refId ? ` | Ref: ${refId}` : ''})`;
  }

  // 2. Check for general HTML dumps (e.g. Cloudflare / Nginx / IIS error pages)
  if (str.includes('<!DOCTYPE') || str.includes('<html') || str.includes('<html>')) {
    const titleMatch = str.match(/<title>([^<]+)<\/title>/i);
    const h1Match = str.match(/<h[12]>([^<]+)<\/h[12]>/i);
    const summary = titleMatch ? titleMatch[1].trim() : (h1Match ? h1Match[1].trim() : 'HTML error page');
    const statusMatch = str.match(/(\b\d{3}\b\s+[A-Za-z ]+)/);
    return `HTTP error (${statusMatch ? statusMatch[1].trim() : summary})`;
  }

  // 3. Normalize common cryptic Bedrock / socket errors
  if (str === 'Socket closed' || str.toLowerCase() === 'socket closed') {
    return 'Socket closed by remote server';
  }
  if (str === 'Server disconnect packet received') {
    return 'Server closed connection / Proxy kick';
  }
  if (str === 'Received one or more errors') {
    return 'Multiple network operations failed';
  }

  // 4. Truncate any other excessively long error string to prevent log flood
  if (str.length > 250) {
    return str.slice(0, 247) + '...';
  }

  return str.trim();
}

/**
 * Checks whether an error is specifically an Azure WAF / 403 rate-limit block
 */
export function isAzureWafBlock(error: any): boolean {
  const str =
    typeof error === 'string'
      ? error
      : error?.message || error?.toString() || '';
  return (
    str.includes('The request is blocked') ||
    str.includes('Azure WAF') ||
    (str.includes('403') && (str.includes('Forbidden') || str.includes('<!DOCTYPE')))
  );
}
