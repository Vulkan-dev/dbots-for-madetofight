import { Dispatcher, Agent, ProxyAgent, setGlobalDispatcher } from 'undici';
import { logger } from '../utils/logger';

const BYPASS_KEYWORDS = [
  'minecraft',
  'mojang',
  'xbox',
  'live.com',
  'microsoft',
  'msftauth',
  'msauth',
  'playfab',
  'discord',
  'ngrok',
  'localhost',
  '127.0.0.1',
];

export class SmartProxyDispatcher extends Dispatcher {
  private directAgent: Agent;
  private proxyAgent: ProxyAgent;

  constructor(agentOptions: any) {
    super();
    this.directAgent = new Agent();
    this.proxyAgent = new ProxyAgent(agentOptions);
  }

  public dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    const origin = typeof options.origin === 'string'
      ? options.origin
      : options.origin?.toString() || '';

    const path = typeof options.path === 'string' ? options.path : '';
    const fullTarget = (origin + path).toLowerCase();

    // Critical: Never route Microsoft login/OAuth, Minecraft Services, or Discord through the proxy
    // Microsoft authentication, Mojang, Xbox, PlayFab, and Discord always connect directly
    const isBypassed = BYPASS_KEYWORDS.some((kw) => fullTarget.includes(kw));
    if (isBypassed) {
      return this.directAgent.dispatch(options, handler);
    }

    return this.proxyAgent.dispatch(options, handler);
  }

  public async close(): Promise<void> {
    await Promise.all([(this.directAgent as any).close(), (this.proxyAgent as any).close()]);
  }

  public destroy(): Promise<void>;
  public destroy(err: Error | null): Promise<void>;
  public destroy(callback: () => void): void;
  public destroy(err: Error | null, callback: () => void): void;
  public destroy(errOrCallback?: any, maybeCallback?: any): any {
    if (typeof errOrCallback === 'function') {
      return (this.proxyAgent as any).destroy(errOrCallback);
    }
    return (this.proxyAgent as any).destroy(errOrCallback, maybeCallback);
  }
}

let currentProxyUrl: string | null = null;
let currentDispatcher: SmartProxyDispatcher | null = null;

export class ProxyHelper {
  public static setOutboundProxy(proxyUrl?: string | null): boolean {
    const raw = proxyUrl?.trim() || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.OUTBOUND_PROXY || null;
    if (!raw) {
      if (currentDispatcher) {
        setGlobalDispatcher(new Agent());
        logger.info('Outbound HTTP/HTTPS proxy cleared. Using direct connection.');
        currentDispatcher = null;
        currentProxyUrl = null;
      }
      return false;
    }
    try {
      let formatted = raw;
      if (!formatted.startsWith('http://') && !formatted.startsWith('https://')) {
        formatted = 'http://' + formatted;
      }
      const parsed = new URL(formatted);
      let agentOptions: any = {
        uri: parsed.protocol + '//' + parsed.host,
      };
      if (parsed.username || parsed.password) {
        const user = decodeURIComponent(parsed.username || '');
        const pass = decodeURIComponent(parsed.password || '');
        const token = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
        agentOptions.token = token;
      }

      // Use SmartProxyDispatcher to enforce that Microsoft Auth & Discord are NEVER proxied
      const dispatcher = new SmartProxyDispatcher(agentOptions);
      setGlobalDispatcher(dispatcher);
      currentDispatcher = dispatcher;
      currentProxyUrl = formatted;
      const masked = raw.replace(/:([^:@]+)@/, ':****@');
      logger.info(`Outbound proxy configured with Microsoft Auth & Discord direct-bypass: ${masked}`);
      return true;
    } catch (err: any) {
      logger.error('Failed to configure outbound proxy: ' + (err?.message || err));
      return false;
    }
  }

  public static getCurrentProxy(): string | null {
    return currentProxyUrl;
  }
}
