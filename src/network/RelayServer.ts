import { Relay } from 'bedrock-protocol';
import { logger } from '../utils/logger';

export interface RelayServerOptions {
  listenHost?: string;
  listenPort?: number;
  destinationHost: string;
  destinationPort: number;
  offline?: boolean;
}

export class RelayServer {
  private relay: any = null;
  private options: RelayServerOptions;
  private isRunning: boolean = false;

  constructor(options: RelayServerOptions) {
    this.options = {
      listenHost: options.listenHost || '0.0.0.0',
      listenPort: options.listenPort || 19133,
      destinationHost: options.destinationHost,
      destinationPort: options.destinationPort || 19132,
      offline: options.offline ?? false,
    };
  }

  public start(): void {
    if (this.isRunning) return;
    try {
      const relayOpts: any = {
        host: this.options.listenHost || '0.0.0.0',
        port: this.options.listenPort || 19133,
        offline: Boolean(this.options.offline),
        destination: {
          host: this.options.destinationHost,
          port: this.options.destinationPort,
          offline: Boolean(this.options.offline),
        },
      };
      this.relay = new Relay(relayOpts);

      this.relay.on('connect', (client: any) => {
        logger.info('Client connected to Bedrock Relay Proxy: ' + (client?.address || 'unknown'));
      });

      this.relay.on('error', (err: any) => {
        logger.error('Bedrock Relay Proxy error: ' + (err?.message || err));
      });

      this.isRunning = true;
      logger.info('Bedrock Relay Proxy listening on ' + this.options.listenHost + ':' + this.options.listenPort + ' -> forwarding to ' + this.options.destinationHost + ':' + this.options.destinationPort);
    } catch (err: any) {
      logger.error('Failed to start Bedrock Relay Proxy: ' + (err?.message || err));
    }
  }

  public stop(): void {
    if (!this.isRunning || !this.relay) return;
    try {
      this.relay.close();
      this.isRunning = false;
      logger.info('Bedrock Relay Proxy stopped.');
    } catch (err) {
      // ignore
    }
  }

  public getStatus() {
    return {
      running: this.isRunning,
      listenHost: this.options.listenHost,
      listenPort: this.options.listenPort,
      destinationHost: this.options.destinationHost,
      destinationPort: this.options.destinationPort,
    };
  }
}
