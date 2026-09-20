import {
  Client,
  GatewayIntentBits,
  Events,
} from 'discord.js';
import { AccountManager } from '../network/AccountManager';
import { discordLogger } from './DiscordLogger';
import { AppConfig } from '../config';
import { logger } from '../utils/logger';

export class DiscordBot {
  private client: Client;
  private manager: AccountManager;
  private appConfig?: AppConfig;
  private token: string;
  private isStarted: boolean = false;

  constructor(manager: AccountManager, appConfig?: AppConfig) {
    this.manager = manager;
    this.appConfig = appConfig;
    this.token = (process.env.DISCORD_TOKEN || '').trim();

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
    });

    discordLogger.setClient(this.client);
    this.setupEvents();
  }

  private setupEvents(): void {
    this.client.on(Events.ClientReady, async () => {
      logger.info(`Discord Bot logged in as ${this.client.user?.tag} (Realtime Logging Mode)`);
      discordLogger.setClient(this.client);
    });

    this.client.on(Events.Error, (err) => {
      logger.debug(`Discord Client Error: ${err?.message}`);
    });
  }

  public async start(): Promise<void> {
    if (!this.token) {
      logger.warn('DiscordBot: DISCORD_TOKEN is empty. Skipping Discord client start.');
      return;
    }
    if (this.isStarted) return;

    try {
      await this.client.login(this.token);
      this.isStarted = true;
      logger.info('Discord client logged in successfully for realtime event logging');
    } catch (err: any) {
      logger.error(`Discord login failed: ${err?.message}`);
    }
  }

  public async stop(): Promise<void> {
    if (!this.isStarted) return;
    try {
      this.client.destroy();
      this.isStarted = false;
      logger.info('Discord client stopped cleanly');
    } catch (err: any) {
      logger.debug(`Discord client stop error: ${err?.message}`);
    }
  }

  public getClient(): Client {
    return this.client;
  }

  // Retained as clean no-op for backward compatibility
  public async registerNodeCategory(_nodeId: string, _categoryId: string): Promise<void> {
    // Per-node channels removed
  }
}
