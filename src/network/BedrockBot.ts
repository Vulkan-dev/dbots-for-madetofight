import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import { createClient, Client } from 'bedrock-protocol';
import { AppConfig, AccountConfig } from '../config';
import { logger } from '../utils/logger';
import { Vector3D } from '../utils/MathUtils';
import '../auth/patchPrismarineAuth';
import { TokenStorage } from '../auth/TokenStorage';
import { MicrosoftAuthManager, AccountAuthStatus, XboxIdentity } from '../auth/MicrosoftAuthManager';
import { NotificationService } from '../notify/NotificationService';
import { PlayerMonitor } from '../features/PlayerMonitor';
import { ContainerMonitor } from '../features/ContainerMonitor';
import { AFKManager } from '../features/AFKManager';
import { DefensiveCombat } from '../features/DefensiveCombat';
import { PlayerHitResponse } from '../features/PlayerHitResponse';
import { AFKSpotTracker } from '../features/AFKSpotTracker';
import { AutoRespawn } from '../features/AutoRespawn';
import { ActionController } from '../features/ActionController';
import { discordLogger } from '../discord/DiscordLogger';
import { Watchdog } from './Watchdog';
import { KeepAliveEngine } from './KeepAliveEngine';
import { IgnoreListStorage } from '../storage/IgnoreListStorage';
import { sanitizeErrorMessage, isAzureWafBlock } from '../utils/ErrorSanitizer';

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  AUTH_FAILED = 'AUTH_FAILED',
}

export interface MsaCodeData {
  user_code: string;
  verification_uri: string;
  direct_verification_uri?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
}

export class BedrockBot extends EventEmitter {
  public readonly accountId: string;
  public xboxUsername: string = '';
  public inGameIgn: string = '';
  private accountConfig: AccountConfig;
  private appConfig: AppConfig;
  private client: Client | null = null;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  public authErrorMessage: string | null = null;
  public msaCodeData: MsaCodeData | null = null;

  // Position & entity tracking
  public currentPosition: Vector3D = { x: 0, y: 64, z: 0 };
  public runtimeEntityId: bigint | string = 0n;

  // Subsystem features
  public playerMonitor: PlayerMonitor;
  public containerMonitor: ContainerMonitor;
  public afkManager: AFKManager;
  public defensiveCombat: DefensiveCombat;
  public playerHitResponse: PlayerHitResponse;
  public afkSpotTracker: AFKSpotTracker;
  public autoRespawn: AutoRespawn;
  public watchdog: Watchdog;
  private lastTpacceptTime: number = 0;
  private lastTpacceptPlayer: string = '';
  public notificationService: NotificationService;
  public keepAliveEngine: KeepAliveEngine | null = null;
  public actionController: ActionController;
  public authManager: MicrosoftAuthManager;
  public selectedSlot: number = 0;
  public heldItem: any = { network_id: 0 };
  public inventory: any[] = [];
  // Maps item name (e.g. 'minecraft:ender_pearl') -> the runtime item_id used in this
  // session's inventory packets. Populated from start_game's itemstates palette, since
  // network_id in inventory slots is a per-session runtime id, not a stable item name.
  private itemNameToRuntimeId: Map<string, number> = new Map();
  private lastLoggedMsaUserCode: string | null = null;
  public lastHealth: number = 20;
  public shiftedToRdp: string | null = null;
  private connectionTimeoutTimer: NodeJS.Timeout | null = null;
  private reconnectScheduler?: (task: () => Promise<void>) => boolean;

  public setReconnectScheduler(scheduler: (task: () => Promise<void>) => boolean): void {
    this.reconnectScheduler = scheduler;
  }

  constructor(
    accountConfig: AccountConfig,
    appConfig: AppConfig,
    notificationService: NotificationService
  ) {
    super();
    this.accountId = accountConfig.id;
    this.accountConfig = accountConfig;
    this.appConfig = appConfig;
    this.notificationService = notificationService;

    // Initialize sub-modules
    this.playerMonitor = new PlayerMonitor(
      this.accountId,
      appConfig.monitoring.radiusChunks,
      appConfig.monitoring.positionThresholdBlocks,
      notificationService
    );

    this.containerMonitor = new ContainerMonitor(
      this.accountId,
      appConfig.monitoring.radiusChunks,
      notificationService
    );

    this.afkManager = new AFKManager(
      this.accountId,
      appConfig.afk.enabled,
      appConfig.afk.activityIntervalMs
    );

    this.defensiveCombat = new DefensiveCombat(
      this.accountId,
      appConfig.defensiveCombat.enabled,
      appConfig.defensiveCombat.allowedMobs,
      appConfig.defensiveCombat.mobBlacklist,
      appConfig.defensiveCombat.combatRange,
      notificationService
    );

    this.playerHitResponse = new PlayerHitResponse(
      this.accountId,
      appConfig.playerHitResponse.enabled,
      appConfig.playerHitResponse.crouchCount,
      appConfig.playerHitResponse.cooldownMs
    );

    this.afkSpotTracker = new AFKSpotTracker(
      this.accountId,
      this.appConfig.nodeId,
      appConfig.afk.checkIntervalMs ?? 300000,
      appConfig.afk.locationTolerance ?? 10.0
    );

    // Immediately restore persistent AFK spot from LocationStorage so it is never lost on restart
    try {
      const { LocationStorage } = require('../storage/LocationStorage');
      const savedSpot = LocationStorage.getLocation(this.accountId);
      if (savedSpot) {
        this.afkSpotTracker.restoreFromStorage(savedSpot);
      }
    } catch {}

    // Register bot identity in AccountManager
    try {
      const { AccountManager } = require('./AccountManager');
      AccountManager.registerBotName(this.accountId);
    } catch {}

    // Attach bot-check callback to PlayerMonitor so fellow bots are automatically ignored
    this.playerMonitor.setBotCheckCallback((name, runtimeId) => {
      if (this.isSelfEntity(runtimeId)) return true;
      try {
        const { AccountManager } = require('./AccountManager');
        return AccountManager.isKnownBot(name, runtimeId);
      } catch {
        return false;
      }
    });

    this.autoRespawn = new AutoRespawn(this.accountId);

    this.watchdog = new Watchdog(
      this.accountId,
      appConfig.watchdog.reconnectDelayMs
    );

    this.authManager = new MicrosoftAuthManager({
      accountId: this.accountId,
      profilesFolder: this.accountConfig.profilesFolder,
      offline: this.accountConfig.offline ?? this.appConfig.server.offline ?? false,
    });

    const initialIdent = this.authManager.getIdentity();
    if (initialIdent.gamertag) {
      this.xboxUsername = initialIdent.gamertag;
      const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
      this.inGameIgn = `${floodgatePrefix}${this.xboxUsername}`;
      try {
        const { AccountManager } = require('./AccountManager');
        AccountManager.registerBotName(this.xboxUsername);
        AccountManager.registerBotName(this.inGameIgn);
      } catch {}
    }

    this.authManager.on('msaCode', (codeData: any) => {
      this.handleMsaCode(codeData);
    });

    this.authManager.on('profileReady', (identity: XboxIdentity) => {
      if (identity.gamertag) {
        this.xboxUsername = identity.gamertag;
        const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
        this.inGameIgn = `${floodgatePrefix}${this.xboxUsername}`;
        try {
          const { AccountManager } = require('./AccountManager');
          AccountManager.registerBotName(this.xboxUsername);
          AccountManager.registerBotName(this.inGameIgn);
        } catch {}
      }
      this.emit('profileReady', identity);
    });

    this.authManager.on('profileRequired', (data: any) => {
      this.watchdog.stop();
      this.setState(ConnectionState.AUTH_FAILED);
      this.authErrorMessage = data.message;
      discordLogger.logAfkActivity(
        this.accountId,
        `⚠️ **Xbox Profile Required**: Microsoft account for bot [${this.accountId}] does not have an Xbox profile. Please create one at ${data.setupUrl}, then click 'Retry Profile Check'.`
      );
    });

    this.actionController = new ActionController(
      this.accountId,
      () => this.client,
      () => this.runtimeEntityId,
      () => this.currentPosition,
      () => this.keepAliveEngine,
      () => {
        // Attack nearby player/entity if within attack reach (3.5 blocks)
        if (!this.client || this.state !== ConnectionState.CONNECTED) return;
        const tracked = this.playerMonitor.getTrackedPlayers();
        for (const p of tracked) {
          const dist = Math.hypot(
            p.position.x - this.currentPosition.x,
            p.position.y - this.currentPosition.y,
            p.position.z - this.currentPosition.z
          );
          if (dist <= 3.5) {
            try {
              this.client.queue('inventory_transaction', {
                transaction: {
                  legacy: { legacy_request_id: 0, legacy_set_item_slots: [] },
                  transaction_type: 'item_use_on_entity',
                  actions: [],
                  transaction_data: {
                    entity_runtime_id: p.runtimeEntityId,
                    action_type: 'attack',
                    hotbar_slot: this.selectedSlot,
                    held_item: this.heldItem,
                    player_pos: this.currentPosition,
                    click_pos: { x: 0, y: 0, z: 0 },
                  },
                },
              });
              logger.debug(`Manual attack interaction sent against nearby entity ${p.username} (${p.runtimeEntityId})`, this.accountId);
            } catch (err) {
              logger.debug('Failed to send attack transaction on entity', this.accountId);
            }
            break; // Attack closest/first entity in range
          }
        }
      },
      () => ({ pitch: this.keepAliveEngine?.pitch ?? 0, yaw: this.keepAliveEngine?.yaw ?? 0 }),
      () => this.selectedSlot,
      () => this.heldItem,
      () => {
        // Right-click entity interact if within reach (3.5 blocks)
        if (!this.client || this.state !== ConnectionState.CONNECTED) return;
        const tracked = this.playerMonitor.getTrackedPlayers();
        for (const p of tracked) {
          const dist = Math.hypot(
            p.position.x - this.currentPosition.x,
            p.position.y - this.currentPosition.y,
            p.position.z - this.currentPosition.z
          );
          if (dist <= 3.5) {
            try {
              this.client.queue('inventory_transaction', {
                transaction: {
                  legacy: { legacy_request_id: 0, legacy_set_item_slots: [] },
                  transaction_type: 'item_use_on_entity',
                  actions: [],
                  transaction_data: {
                    entity_runtime_id: p.runtimeEntityId,
                    action_type: 'interact',
                    hotbar_slot: this.selectedSlot,
                    held_item: this.heldItem,
                    player_pos: this.currentPosition,
                    click_pos: { x: 0, y: 0, z: 0 },
                  },
                },
              });
              logger.debug(`Right-click entity interaction sent to ${p.username}`, this.accountId);
            } catch (err) {
              // ignore
            }
            break;
          }
        }
      },
      () => this.inventory,
      (slot: number) => {
        this.selectedSlot = slot;
        if (this.inventory[slot]) this.heldItem = this.inventory[slot];
        if (this.client && this.state === ConnectionState.CONNECTED) {
          try {
            this.client.queue('player_hotbar', {
              selected_slot: slot,
              window_id: 'inventory',
              select_slot: true,
            });
            this.client.queue('mob_equipment', {
              runtime_entity_id: this.runtimeEntityId,
              item: this.heldItem,
              slot: slot,
              selected_slot: slot,
              window_id: 0,
            });
          } catch {
            // ignore
          }
        }
      },
      (itemName: string) => this.findHotbarSlotForItem(itemName)
    );

    this.setupFeatureCallbacks();
  }

  /**
   * Handles a Microsoft device-code auth prompt from either the AuthManager or the
   * underlying bedrock-protocol client. Both paths funnel here so the code is only
   * logged/broadcast ONCE per unique code, instead of re-printing on every retry
   * (device-code polling can re-invoke this several times while waiting for the user).
   */
  private handleMsaCode(data: MsaCodeData): void {
    this.msaCodeData = data;
    this.emit('msaCode', data);

    const code = data.user_code;
    if (code && code === this.lastLoggedMsaUserCode) {
      return;
    }
    this.lastLoggedMsaUserCode = code || null;

    const uri = data.verification_uri || 'https://www.microsoft.com/link';
    const directUri = data.direct_verification_uri || `http://microsoft.com/link?otc=${code}`;

    logger.info(`Microsoft auth required — code ${code} at ${uri} (direct: ${directUri})`, this.accountId);

    discordLogger.logAfkActivity(
      this.accountId,
      `🔑 **Microsoft Auth Required**: Open ${uri} and enter code \`${code}\` (Direct: ${directUri})`
    );
  }

  /**
   * Finds the hotbar slot (0-8) currently holding the given item, e.g. 'minecraft:ender_pearl'.
   * Returns -1 if the item's runtime_id isn't known yet (palette not received) or none of the
   * hotbar slots hold it.
   */
  public findHotbarSlotForItem(itemName: string): number {
    const runtimeId = this.itemNameToRuntimeId.get(itemName);
    if (runtimeId == null) {
      logger.warn(`findHotbarSlotForItem('${itemName}'): item not found in this session's palette.`, this.accountId);
      return -1;
    }
    if (!Array.isArray(this.inventory)) return -1;

    for (let slot = 0; slot < 9; slot++) {
      const it = this.inventory[slot];
      if (it && typeof it.network_id === 'number' && it.network_id === runtimeId) {
        return slot;
      }
    }

    const hotbarDump = this.inventory.slice(0, 9).map((it, i) => `[${i}]=${it ? JSON.stringify({ network_id: it.network_id, id: it.id, count: it.count }) : 'empty'}`).join(' ');
    logger.warn(`findHotbarSlotForItem('${itemName}'): expected network_id ${runtimeId}, but no hotbar slot matched. Hotbar contents: ${hotbarDump}`, this.accountId);
    return -1;
  }

  private setupFeatureCallbacks(): void {
    // AFK spot tracker callbacks
    this.afkSpotTracker.setCallbacks(
      (cmd) => this.sendChat(cmd),
      () => this.currentPosition,
      () => this.state === ConnectionState.CONNECTED,
      () => {
        if (this.keepAliveEngine) {
          this.keepAliveEngine.resetPhysicsAndClearTarget();
        }
        this.actionController.resetAllStates();
      }
    );

    // Auto-respawn callback (Instant respawn pipeline)
    this.autoRespawn.setRespawnCallback(() => {
      if (this.client && this.state === ConnectionState.CONNECTED) {
        try {
          logger.info('Executing instant auto-respawn (player_action + respawn state 2)...', this.accountId);

          // 1. Send player_action with action: 'respawn' (Action ID 7)
          this.client.queue('player_action', {
            runtime_entity_id: this.runtimeEntityId,
            action: 'respawn',
            position: { x: 0, y: 0, z: 0 },
            result_position: { x: 0, y: 0, z: 0 },
            face: 0,
          });

          // 2. Also send respawn packet with state: 2 (CLIENT_READY_TO_SPAWN) immediately
          // so server can instantly acknowledge and spawn the bot without waiting for client roundtrip
          this.client.queue('respawn', {
            position: this.currentPosition,
            state: 2, // CLIENT_READY_TO_SPAWN
            runtime_entity_id: this.runtimeEntityId,
          });

          // Reassert persistent crouch toggle stance after respawning
          setTimeout(() => {
            try {
              if (this.state === ConnectionState.CONNECTED) {
                this.actionController.reassertPersistentStates();
              }
            } catch {}
          }, 500);
        } catch (err) {
          logger.error('Failed to send auto-respawn packets', this.accountId, err);
        }
      }
    });

    // AFK activity callback - KeepAliveEngine handles anti-idle; no arm swinging
    this.afkManager.setActionCallback(() => {
      // Hand swing removed per user request: KeepAliveEngine at 20Hz maintains active presence without swinging hand
    });

    // Defensive Combat attack callback
    this.defensiveCombat.setAttackCallback((targetRuntimeId) => {
      if (this.client && this.state === ConnectionState.CONNECTED) {
        try {
          this.client.queue('animate', {
            action_id: 'swing_arm',
            runtime_entity_id: this.runtimeEntityId,
          });
          this.client.queue('inventory_transaction', {
            transaction: {
              legacy_request_id: 0,
              legacy_set_item_slots: [],
              actions: [],
              transaction_type: 'item_use_on_entity',
              entity_runtime_id: targetRuntimeId,
              action_type: 'attack',
              hotbar_slot: 0,
              held_item: { id: 0 },
              player_pos: this.currentPosition,
              click_pos: { x: 0, y: 0, z: 0 },
            },
          });
        } catch (err) {
          logger.debug('Failed to send attack transaction packet', this.accountId);
        }
      }
    });

    // Look and Crouch response callbacks for PlayerHitResponse
    this.playerHitResponse.setLookCallback((deltaPitch, deltaYaw) => {
      if (this.keepAliveEngine) {
        this.keepAliveEngine.smoothLook(deltaPitch, deltaYaw, 6, 20);
      }
    });

    this.playerHitResponse.setCrouchCallback((isSneaking: boolean, isCompleted?: boolean) => {
      // If user has Always Crouch toggled ON, never leave the bot uncrouched!
      if (this.actionController.isCrouching) {
        if (isCompleted) {
          this.actionController.reassertPersistentStates();
        }
        return;
      }
      if (this.keepAliveEngine) {
        this.keepAliveEngine.setSneak(isSneaking);
      }
      if (isCompleted) {
        this.actionController.reassertPersistentStates();
      }
    });



    // Watchdog auto-reconnect handler: Staggers reconnection through JoinScheduler to prevent auth rate-limits
    this.watchdog.setReconnectCallback(async () => {
      if (this.reconnectScheduler) {
        logger.info('Queuing watchdog reconnection via JoinScheduler to prevent auth rate-limits...', this.accountId);
        this.setState(ConnectionState.RECONNECTING);
        this.reconnectScheduler(async () => {
          if (
            this.state === ConnectionState.RECONNECTING ||
            this.state === ConnectionState.DISCONNECTED ||
            this.state === ConnectionState.AUTH_FAILED
          ) {
            await this.connect();
          }
        });
      } else {
        logger.info('Watchdog reconnect callback invoked. Re-establishing Bedrock connection...', this.accountId);
        this.setState(ConnectionState.RECONNECTING);
        await this.connect();
      }
    });
  }

  /**
   * True if the given entity id refers to THIS bot. Treats runtimeEntityId's default/unset
   * value (0n) as "not yet known" to prevent stale session IDs from matching after reconnect.
   */
  private isSelfEntity(entityId: any): boolean {
    if (entityId == null) return false;
    if (this.runtimeEntityId == null || this.runtimeEntityId === 0n || this.runtimeEntityId === '0') return false;
    return String(entityId) === String(this.runtimeEntityId);
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public get autoConnect(): boolean {
    return this.accountConfig.autoConnect ?? true;
  }

  public set autoConnect(val: boolean) {
    this.accountConfig.autoConnect = val;
  }

  private setState(newState: ConnectionState): void {
    this.state = newState;
    logger.info(`Connection state changed to: ${newState}`, this.accountId);
    this.emit('stateChanged', newState);
  }

  /**
   * Sends an in-game chat message or server command (e.g. /tpaccept, /sethome 1, Hi)
   */
  public sendChat(message: string): void {
    if (!this.client || this.state !== ConnectionState.CONNECTED) {
      logger.warn(`Cannot send chat/command '${message}': Client is not connected.`, this.accountId);
      return;
    }

    const trimmed = message.trim();
    if (!trimmed) return;

    try {
      if (trimmed.startsWith('/')) {
        logger.info(`Sending in-game command: ${trimmed}`, this.accountId);
        const uuid = randomUUID();
        this.client.queue('command_request', {
          command: trimmed,
          origin: {
            type: 'player',
            uuid,
            request_id: '',
            player_entity_id: 0n,
          },
          internal: false,
          version: 'latest',
        });
      } else {
        logger.info(`Sending in-game chat message: ${trimmed}`, this.accountId);
        this.client.queue('text', {
          type: 'chat',
          needs_translation: false,
          category: 'authored',
          source_name: this.xboxUsername || this.accountId,
          message: trimmed,
          xuid: '',
          platform_chat_id: '',
          has_filtered_message: false,
        });
      }
    } catch (err) {
      logger.error(`Failed to send in-game chat/command '${trimmed}'`, this.accountId, err);
    }
  }

  /**
   * Establishes connection to Minecraft Bedrock server (DonutSMP).
   * Permanent sessions stored in profile/<botname>/
   */
  public async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.CONNECTED) {
      logger.warn(`Connect requested but state is already ${this.state}. Skipping duplicate connect.`, this.accountId);
      return;
    }

    this.watchdog.start();
    this.authErrorMessage = null;
    this.msaCodeData = null;
    this.lastLoggedMsaUserCode = null;
    this.setState(ConnectionState.CONNECTING);
    const isOffline = this.accountConfig.offline ?? (process.env.OFFLINE_MODE === 'true' || this.appConfig.server.offline) ?? false;
    
    // Clear any pending connection timeout
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }

    // NOTE: the 30s connection-handshake timeout is intentionally started further below,
    // AFTER Microsoft authentication succeeds — not here. Device-code sign-in can take the
    // user several minutes (open browser, log in, type the code).

    // Ensure profile/<botname>/ directory exists for permanent session caching
    const profilesPath = await TokenStorage.ensureProfilesFolder(this.accountId);

    try {
      if (!isOffline) {
        // Check if account is in XBOX_PROFILE_REQUIRED state
        if (this.authManager.getAccountStatus() === AccountAuthStatus.XBOX_PROFILE_REQUIRED) {
          logger.warn(
            `Account '${this.accountId}' requires an Xbox profile setup before connecting. Pausing reconnect loop. Setup URL: https://account.xbox.com/profile`,
            this.accountId
          );
          this.watchdog.stop();
          this.setState(ConnectionState.AUTH_FAILED);
          return;
        }

        // Run explicit Microsoft Authentication & Xbox Profile verification (always connects directly, bypassing proxy)
        const authOk = await this.authManager.authenticateAndVerify();
        if (!authOk) {
          const ident = this.authManager.getIdentity();
          this.handleConnectionFailure(ident.authErrorMessage || 'Authentication or Xbox profile verification failed');
          return;
        }

        this.emit('authenticated');

        const ident = this.authManager.getIdentity();
        if (ident.gamertag) {
          this.xboxUsername = ident.gamertag;
          const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
          this.inGameIgn = `${floodgatePrefix}${this.xboxUsername}`;
        }
      } else {
        this.xboxUsername = this.accountId;
        this.inGameIgn = this.accountId;
        logger.info(`Operating in Offline / Direct mode for bot [${this.accountId}]. Microsoft login bypassed.`, this.accountId);
      }

      const connectHost = this.appConfig.server.host;
      const connectPort = this.appConfig.server.port;

      logger.info(
        `Initiating Bedrock connection to ${connectHost}:${connectPort} (Session: ${profilesPath})...`,
        this.accountId
      );

        // Authentication (if any) is done — NOW start the 30s handshake timeout
        this.connectionTimeoutTimer = setTimeout(() => {
          if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.RECONNECTING) {
            logger.warn('Connection attempt timed out after 30 seconds without joining. Re-triggering reconnect...', this.accountId);
            this.handleConnectionFailure('Connection handshake timeout');
          }
        }, 30000);

        const clientOptions: any = {
          host: this.appConfig.server.host,
          port: this.appConfig.server.port,
          profilesFolder: profilesPath,
          username: this.accountId,
          offline: isOffline,
          ...(!isOffline ? { authflow: this.authManager.getOrCreateAuthflow() } : {}),
          onMsaCode: (data: MsaCodeData) => {
            this.handleMsaCode(data);
          },
        };

      this.client = createClient(clientOptions);

      // Intercept readPacket to gracefully skip non-fatal packet deserialization errors
      // (such as Geyser block_entity_data piston/sign NBT parser desyncs from DonutSMP)
      const rawClient = this.client as any;
      if (typeof rawClient.readPacket === 'function') {
        const originalReadPacket = rawClient.readPacket.bind(rawClient);
        rawClient.readPacket = (packet: any) => {
          try {
            rawClient.deserializer.parsePacketBuffer(packet);
          } catch (err: any) {
            const packetId = packet && packet.length > 0 ? packet[0] : 0;
            const hexId = '0x' + Number(packetId).toString(16);
            logger.debug(`Safely skipped unparseable server packet (${hexId}): ${err?.message || err}`, this.accountId);
            return; // Skip packet silently so bot never disconnects on decorative server NBT desyncs
          }

          try {
            originalReadPacket(packet);
          } catch (err: any) {
            logger.debug(`Suppressed readPacket processing error: ${err?.message || err}`, this.accountId);
          }
        };
      }

      this.registerPacketHandlers();
    } catch (error) {
      logger.error('Failed to create Bedrock client', this.accountId, error);
      this.handleConnectionFailure('Client creation error');
    }
  }

  private registerPacketHandlers(): void {
    if (!this.client) return;

    // Remove bedrock-protocol's default unscaled network_stack_latency listener
    this.client.removeAllListeners('network_stack_latency');
    this.client.on('network_stack_latency', (packet: any) => {
      if (this.keepAliveEngine) return; // handled by KeepAliveEngine once running
      try {
        const rawTs = BigInt(packet.timestamp);
        const scaledTs = rawTs * 1000000n;
        this.client?.queue('network_stack_latency', { timestamp: scaledTs, needs_response: 0 });
        this.client?.queue('network_stack_latency', { timestamp: rawTs, needs_response: 0 });
      } catch {
        // ignore
      }
    });

    // Listen to session event to auto-detect Xbox Gamertag
    this.client.on('session', (profile: any) => {
      this.msaCodeData = null;
      this.lastLoggedMsaUserCode = null;
      if (profile && profile.name) {
        this.xboxUsername = profile.name;
        const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
        this.inGameIgn = `${floodgatePrefix}${this.xboxUsername}`;
        logger.info(`Auto-detected Xbox Live Gamertag: '${this.xboxUsername}' (In-Game IGN: '${this.inGameIgn}')`, this.accountId);
      }
    });

    // Connection lifecycle events
    this.client.on('join', () => {
      if (this.connectionTimeoutTimer) {
        clearTimeout(this.connectionTimeoutTimer);
        this.connectionTimeoutTimer = null;
      }
      this.msaCodeData = null;
      this.lastLoggedMsaUserCode = null;
      const nameToUse =
        this.xboxUsername ||
        (this.client as any)?.username ||
        (this.client as any)?.profile?.name ||
        this.accountId;

      this.xboxUsername = nameToUse;
      const floodgatePrefix = process.env.FLOODGATE_PREFIX || '.';
      this.inGameIgn = `${floodgatePrefix}${this.xboxUsername}`;

      logger.info(`Successfully joined Bedrock server as Xbox User '${this.xboxUsername}' (IGN: ${this.inGameIgn})!`, this.accountId);
      this.setState(ConnectionState.CONNECTED);
      this.watchdog.onConnected();
      this.afkManager.start();

      // Log join event to Discord DISCORD_JOIN_LOG_CHANNEL_ID
      discordLogger.logBotJoin(this.accountId, this.inGameIgn, this.appConfig.server.host);
    });

    this.client.on('start_game', (packet: any) => {
      if (packet.player_position) {
        this.currentPosition = {
          x: packet.player_position.x || 0,
          y: packet.player_position.y || 0,
          z: packet.player_position.z || 0,
        };
      }
      const selfRuntimeId = packet.runtime_entity_id ?? packet.runtime_id ?? packet.entity_id ?? (this.client as any)?.clientRuntimeId;
      if (selfRuntimeId != null) {
        this.runtimeEntityId = selfRuntimeId;
        try {
          const { AccountManager } = require('./AccountManager');
          AccountManager.registerBotRuntimeId(this.runtimeEntityId);
        } catch {}
      }
      logger.info(`World initialized. Spawn Position: ${this.currentPosition.x}, ${this.currentPosition.y}, ${this.currentPosition.z}`, this.accountId);

      // Build the item name -> runtime_id lookup from this session's item palette
      const itemStates = packet.itemstates || packet.item_states;
      if (Array.isArray(itemStates)) {
        this.itemNameToRuntimeId.clear();
        for (const entry of itemStates) {
          if (entry && typeof entry.name === 'string' && typeof entry.runtime_id === 'number') {
            this.itemNameToRuntimeId.set(entry.name, entry.runtime_id);
          }
        }
        logger.debug(
          `Item palette loaded: ${this.itemNameToRuntimeId.size} entries. Ender pearl runtime_id: ${this.itemNameToRuntimeId.get('minecraft:ender_pearl')}`,
          this.accountId
        );
      } else {
        logger.warn('start_game packet did not include an itemstates array — pearl auto-detection will not work.', this.accountId);
      }

      // Start 20Hz KeepAlive & Input Engine to prevent Boar anticheat timeouts
      if (this.client) {
        if (this.keepAliveEngine) {
          this.keepAliveEngine.stop();
        }
        this.keepAliveEngine = new KeepAliveEngine(
          this.client,
          this.accountId,
          this.currentPosition,
          () => this.runtimeEntityId
        );
        if (packet.rotation) {
          const initPitch = typeof packet.rotation.x === 'number' ? packet.rotation.x : 0;
          const initYaw = typeof packet.rotation.z === 'number' ? packet.rotation.z : 0;
          this.keepAliveEngine.updateRotation(initPitch, initYaw, initYaw);
        }
        this.keepAliveEngine.start();
      }

      // Ensure action controller toggles and physics inputs are cleanly reset on initial connect
      if (!this.actionController.isCrouching) {
        this.actionController.resetAllStates();
      } else {
        // Re-apply active crouch toggle to newly spawned KeepAliveEngine
        this.keepAliveEngine?.setSneak(true);
      }

      // If a saved AFK spot exists in tracker or LocationStorage, restore and enforce 5-minute AFK monitoring
      try {
        const { LocationStorage } = require('../storage/LocationStorage');
        const savedSpot = this.afkSpotTracker.getSavedSpot() || LocationStorage.getLocation(this.accountId);
        if (savedSpot) {
          this.afkSpotTracker.restoreFromStorage(savedSpot);
          setTimeout(() => {
            if (this.state === ConnectionState.CONNECTED) {
              this.afkSpotTracker.checkPositionAndEnforceHome();
            }
          }, 3000);
        }
      } catch {
        // ignore
      }
    });

    this.client.on('move_player', (packet: any) => {
      const runtimeId = packet.runtime_id ?? packet.runtime_entity_id ?? packet.entity_id;
      const isSelf = this.isSelfEntity(runtimeId);

      if (isSelf) {
        if (packet.position) {
          const prevBlockX = Math.round(this.currentPosition.x);
          const prevBlockY = Math.round(this.currentPosition.y);
          const prevBlockZ = Math.round(this.currentPosition.z);

          const isTeleport =
            packet.mode === 'teleport' ||
            packet.mode === 1 ||
            packet.mode === 2 ||
            packet.teleportation_cause != null ||
            Math.hypot(packet.position.x - this.currentPosition.x, packet.position.z - this.currentPosition.z) > 4;

          this.currentPosition.x = packet.position.x;
          this.currentPosition.y = packet.position.y;
          this.currentPosition.z = packet.position.z;

          if (isTeleport) {
            let groundTargetY: number | undefined = undefined;
            const savedSpot = this.afkSpotTracker.getSavedSpot();
            if (savedSpot) {
              const distToSpot = Math.hypot(packet.position.x - savedSpot.x, packet.position.z - savedSpot.z);
              if (distToSpot <= 10) {
                groundTargetY = savedSpot.y;
              }
            }
            if (this.keepAliveEngine) {
              this.keepAliveEngine.handleTeleportLanding(this.currentPosition, groundTargetY, packet.on_ground);
            }
            this.actionController.resetAllStates();
          } else if (this.keepAliveEngine) {
            this.keepAliveEngine.updatePosition(this.currentPosition);
            if (packet.on_ground !== undefined) {
              this.keepAliveEngine.setGrounded(Boolean(packet.on_ground));
            }
          }

          if (this.keepAliveEngine && packet.pitch != null && packet.yaw != null) {
            this.keepAliveEngine.updateRotation(packet.pitch, packet.yaw, packet.head_yaw);
          }

          const newBlockX = Math.round(this.currentPosition.x);
          const newBlockY = Math.round(this.currentPosition.y);
          const newBlockZ = Math.round(this.currentPosition.z);

          // Only emit positionChanged when the bot moves by at least 1 whole block,
          // preventing continuous timer and Discord embed queue churning on float jitter
          if (prevBlockX !== newBlockX || prevBlockY !== newBlockY || prevBlockZ !== newBlockZ) {
            this.emit('positionChanged', this.currentPosition);
          }
        }
      } else {
        if (this.isSelfEntity(runtimeId)) return;
        try {
          const { AccountManager } = require('./AccountManager');
          if (AccountManager.isKnownBot(undefined, runtimeId)) return;
        } catch {}
        this.playerMonitor.handlePlayerMove(
          runtimeId,
          packet.position,
          this.currentPosition
        );
      }
    });

    // Handle incoming entity motion (knockback from attacks, explosions, or collision push from other players)
    this.client.on('set_entity_motion', (packet: any) => {
      const runtimeId = packet.runtime_entity_id ?? packet.runtime_id ?? packet.entity_id;
      if (this.isSelfEntity(runtimeId)) {
        if (packet.velocity) {
          logger.debug(`Applying incoming entity motion: vx=${packet.velocity.x}, vy=${packet.velocity.y}, vz=${packet.velocity.z}`, this.accountId);
          this.keepAliveEngine?.applyMotion(packet.velocity);
        }
      }
    });

    this.client.on('add_player', (packet: any) => {
      // In Bedrock protocol, packet_add_player uses `runtime_id`. Check runtime_id with fallbacks.
      const runtimeId = packet.runtime_id ?? packet.runtime_entity_id ?? packet.entity_id;
      if (this.isSelfEntity(runtimeId)) return;
      try {
        const { AccountManager } = require('./AccountManager');
        if (AccountManager.isKnownBot(packet.username, runtimeId)) {
          return;
        }
      } catch {}
      this.playerMonitor.handlePlayerAdd(
        runtimeId,
        packet.uuid || '',
        packet.username || 'Unknown',
        packet.position,
        this.currentPosition
      );
    });

    this.client.on('remove_actor', (packet: any) => {
      const entityId = packet.entity_unique_id ?? packet.runtime_entity_id ?? packet.runtime_id ?? packet.entity_id;
      if (entityId != null) {
        this.playerMonitor.handlePlayerRemove(entityId);
        this.defensiveCombat.handleEntityDeath(entityId);
      }
    });

    // 1. Bedrock death_info packet
    this.client.on('death_info', (packet: any) => {
      const cause = packet.cause || 'Unknown';
      const msg = Array.isArray(packet.messages) ? packet.messages.join(' ') : '';
      logger.warn(`Bot death detected via death_info packet! Cause: ${cause} ${msg}`, this.accountId);
      this.autoRespawn.handleDeath(`death_info: ${cause}`);
    });

    // 2. Bedrock set_health packet (damage & death)
    this.client.on('set_health', (packet: any) => {
      if (typeof packet.health === 'number') {
        if (packet.health <= 0) {
          logger.warn(`Bot death detected via set_health packet! Health: ${packet.health}`, this.accountId);
          this.autoRespawn.handleDeath('health_zero');
        } else {
          if (packet.health > 0 && this.autoRespawn.getIsDead()) {
            this.autoRespawn.reset();
          }
          if (packet.health < this.lastHealth) {
            logger.info(`Bot took damage (health: ${this.lastHealth} -> ${packet.health})`, this.accountId);
            this.playerHitResponse.handlePlayerHit();
          }
        }
        this.lastHealth = packet.health;
      }
    });

    // 3. Bedrock actor_event & entity_event packets (damage & death animation)
    const handleEntityEvent = (packet: any) => {
      const entityId = packet.runtime_entity_id ?? packet.runtime_entity_id ?? packet.entity_id;
      const isSelf = this.isSelfEntity(entityId);

      const eventId = packet.event_id;
      const isHurt =
        eventId === 2 ||
        eventId === 'hurt' ||
        eventId === 'hurt_animation';
      const isDeath =
        eventId === 3 ||
        eventId === 'death' ||
        eventId === 'death_animation' ||
        eventId === 61 ||
        eventId === 'death_smoke_cloud';

      if (isHurt && isSelf) {
        logger.info('Bot was damaged!', this.accountId);
        this.playerHitResponse.handlePlayerHit();
      } else if (isDeath && isSelf) {
        if (!this.autoRespawn.getIsDead()) {
          logger.warn(`Bot death detected via entity/actor event (${eventId})!`, this.accountId);
        } else {
          logger.debug(`Duplicate death particle/event (${eventId}) for the same death — ignoring.`, this.accountId);
        }
        this.autoRespawn.handleDeath(`event: ${eventId}`);
      }
    };

    this.client.on('actor_event', handleEntityEvent);
    this.client.on('entity_event', handleEntityEvent);

    // 4. Server-initiated respawn packet handshake.
    this.client.on('respawn', (packet: any) => {
      const state = packet.state;
      logger.debug(`Server sent respawn packet (state: ${state}).`, this.accountId);

      if (packet.position) {
        this.currentPosition = {
          x: packet.position.x ?? this.currentPosition.x,
          y: packet.position.y ?? this.currentPosition.y,
          z: packet.position.z ?? this.currentPosition.z,
        };
        if (this.keepAliveEngine) {
          this.keepAliveEngine.updatePosition(this.currentPosition);
        }
      }

      const isReadyToSpawn = state === 1 || state === 'ready_to_spawn' || state === 'server_ready_to_spawn' || state === 0 || state === 'searching_for_spawn';

      if (isReadyToSpawn || this.autoRespawn.getIsDead()) {
        logger.info(`Acknowledging server respawn (state: ${state}) with CLIENT_READY_TO_SPAWN (2)...`, this.accountId);
        this.lastHealth = 20;
        this.autoRespawn.reset();
        try {
          this.client?.queue('respawn', {
            position: this.currentPosition,
            state: 2, // CLIENT_READY_TO_SPAWN
            runtime_entity_id: this.runtimeEntityId,
          });
        } catch (err) {
          logger.debug('Failed to send respawn acknowledgment packet', this.accountId);
        }
      } else if (state === 2 || state === 'client_ready_to_spawn') {
        this.lastHealth = 20;
        this.autoRespawn.reset();
      }
    });

    this.client.on('inventory_content', (packet: any) => {
      const isPlayerInv =
        packet.window_id === 'inventory' ||
        packet.window_id === 0 ||
        packet.window_id === '0' ||
        packet.window_id === 119 ||
        packet.window_id === '119' ||
        (Array.isArray(packet.input) && packet.input.length >= 36);
      if (isPlayerInv && Array.isArray(packet.input)) {
        this.inventory = packet.input;
        if (this.inventory[this.selectedSlot]) {
          this.heldItem = this.inventory[this.selectedSlot];
        }
      }
    });

    this.client.on('player_hotbar', (packet: any) => {
      if (packet.selected_slot != null) {
        this.selectedSlot = packet.selected_slot;
        if (this.inventory && this.inventory[this.selectedSlot]) {
          this.heldItem = this.inventory[this.selectedSlot];
        }
      }
    });

    this.client.on('mob_equipment', (packet: any) => {
      const entityId = packet.runtime_entity_id ?? packet.runtime_entity_id ?? packet.entity_id;
      if (this.isSelfEntity(entityId)) {
        if (packet.selected_slot != null) this.selectedSlot = packet.selected_slot;
        if (packet.item != null) this.heldItem = packet.item;
        if (this.inventory && packet.slot != null && packet.item != null) {
          this.inventory[packet.slot] = packet.item;
        }
      }
    });

    this.client.on('inventory_slot', (packet: any) => {
      const isPlayerInv =
        packet.window_id === 'inventory' ||
        packet.window_id === 0 ||
        packet.window_id === '0' ||
        packet.window_id === 119 ||
        packet.window_id === '119';
      if (isPlayerInv) {
        if (this.inventory && packet.slot != null && packet.item != null) {
          this.inventory[packet.slot] = packet.item;
        }
        if (packet.slot === this.selectedSlot && packet.item != null) {
          this.heldItem = packet.item;
        }
      }
    });

    // Container & Chest Monitor: correlates container events with nearby players
    const handleContainerDetection = (type: string, coords: any) => {
      if (!coords || typeof coords.x !== 'number') return;
      
      const chestPos: Vector3D = {
        x: Math.round(coords.x),
        y: Math.round(coords.y),
        z: Math.round(coords.z),
      };

      // Find closest player to the chest
      const tracked = this.playerMonitor.getTrackedPlayers();
      let closestPlayer: any = null;
      let minDistance = 6.0; // Chest interaction reach limit (~5-6 blocks)

      for (const p of tracked) {
        const d = Math.hypot(p.position.x - chestPos.x, p.position.y - chestPos.y, p.position.z - chestPos.z);
        if (d < minDistance) {
          minDistance = d;
          closestPlayer = p;
        }
      }

      const playerName = closestPlayer ? closestPlayer.username : 'Unknown Player';
      const playerPos = closestPlayer ? closestPlayer.position : undefined;

      this.containerMonitor.handleContainerInteraction(
        this.currentPosition,
        type,
        chestPos,
        playerName,
        playerPos
      );
    };

    this.client.on('container_open', (packet: any) => {
      const coords = packet.coordinates || this.currentPosition;
      const type = packet.window_type || 'Chest';
      handleContainerDetection(type, coords);
    });

    // Bedrock block_event: type 1 (change_state) data 1 indicates chest open lid animation
    this.client.on('block_event', (packet: any) => {
      if ((packet.type === 1 || packet.type === 'change_state') && packet.data === 1 && packet.position) {
        handleContainerDetection('Chest', packet.position);
      }
    });

    // In-game chat and command output handling
    this.client.on('command_output', (packet: any) => {
      try {
        const outputs = packet.output;
        if (Array.isArray(outputs)) {
          for (const item of outputs) {
            const msg = item.message_id || '';
            const params = item.parameters ? item.parameters.join(' ') : '';
            const formatted = `${msg} ${params}`.trim();
            if (formatted) {
              logger.info(`[SERVER COMMAND OUTPUT] ${formatted}`, this.accountId);
              discordLogger.logAfkActivity(this.accountId, `Command Response: ${formatted}`);
            }
          }
        }
      } catch (err) {
        logger.debug('Error processing command_output packet', this.accountId);
      }
    });

    this.client.on('text', (packet: any) => {
      try {
        const sender = packet.source_name || packet.type || 'SERVER';
        const message = packet.message || (packet.parameters ? packet.parameters.join(' ') : '');
        if (message) {
          logger.info(`[CHAT] [${sender}]: ${message}`, this.accountId);
          this.handleTeleportRequest(packet);
        }
      } catch (err) {
        logger.debug('Error processing incoming text packet', this.accountId);
      }
    });

    // Disconnect & Error Handling
    this.client.on('disconnect', (packet: any) => {
      const reason = packet.reason || packet.message || 'Server disconnect packet received';
      this.handleConnectionFailure(reason);
    });

    this.client.on('error', (err: any) => {
      const rawMessage = err?.message || err?.toString() || 'Protocol Error';
      // Suppress non-fatal deserialization / unparseable packet errors so they never trigger disconnects
      if (
        rawMessage.includes('Read error') ||
        rawMessage.includes('Invalid tag') ||
        rawMessage.includes('Deserialization') ||
        rawMessage.includes('PartialReadError')
      ) {
        logger.debug(`Ignored non-fatal protocol read/deserialization error: ${rawMessage}`, this.accountId);
        return;
      }
      const cleanMessage = sanitizeErrorMessage(err);
      logger.error(`Socket / protocol error encountered: ${cleanMessage}`, this.accountId);
      this.handleConnectionFailure(cleanMessage);
    });

    this.client.on('close', () => {
      logger.info('Connection socket closed.', this.accountId);
      if (this.watchdog.isRunning() && this.state !== ConnectionState.DISCONNECTED) {
        this.handleConnectionFailure('Socket closed');
      }
    });
  }

  /**
   * Automatically accepts incoming teleport requests from trusted / whitelisted players or fellow bots.
   * Executes '/tpaccept <PlayerName>' immediately and falls back to '/tpaccept'.
   */
  public handleTeleportRequest(packet: any): void {
    try {
      const rawMessage = packet.message || '';
      const params = Array.isArray(packet.parameters) ? packet.parameters : [];
      const combinedText = `${rawMessage} ${params.join(' ')}`;
      const cleanText = combinedText
        .replace(/§[0-9a-fk-or]/gi, '')
        .replace(/&[0-9a-fk-or]/gi, '')
        .trim();

      let requestingPlayer: string | null = null;

      // Extract text if rawMessage is a JSON component
      let parsedCleanText = cleanText;
      if (rawMessage.trim().startsWith('{') || rawMessage.trim().startsWith('[')) {
        try {
          const json = JSON.parse(rawMessage);
          const extractText = (obj: any): string => {
            if (!obj) return '';
            if (typeof obj === 'string') return obj;
            let res = obj.text || '';
            if (Array.isArray(obj.extra)) {
              res += obj.extra.map(extractText).join('');
            }
            return res;
          };
          const jsonText = extractText(json);
          if (jsonText) {
            parsedCleanText = `${jsonText} ${cleanText}`
              .replace(/§[0-9a-fk-or]/gi, '')
              .replace(/&[0-9a-fk-or]/gi, '')
              .trim();
          }
        } catch {}
      }

      // 1. Standard DonutSMP / EssentialsX / Paper / CMI patterns (TPA & TPAHERE)
      const match1 = parsedCleanText.match(/([a-zA-Z0-9_.*]+)\s+(?:has requested to teleport|has requested that you teleport|has requested you to teleport|has requested you teleport|wants to teleport|wants you to teleport|sent a teleport request|sent you a teleport request|sent a teleport here request|sent you a teleport here request|sent a tpahere request|has sent a request to teleport you)/i);
      if (match1 && match1[1]) {
        requestingPlayer = match1[1];
      }

      // 2. Pattern: "Teleport request from <player>", "tpa from <player>", "tpahere from <player>"
      if (!requestingPlayer) {
        const match2 = parsedCleanText.match(/(?:teleport request from|tpa request from|tpa from|teleport here request from|tpahere request from|tpahere from)\s+([a-zA-Z0-9_.*]+)/i);
        if (match2 && match2[1]) {
          requestingPlayer = match2[1];
        }
      }

      // 3. Pattern: "[!] <player> wants to teleport" or "[Teleport] <player> has requested..."
      if (!requestingPlayer) {
        const match3 = parsedCleanText.match(/\[(?:!|teleport|tpa|tpahere)\]\s*([a-zA-Z0-9_.*]+)\s+(?:wants to teleport|wants you to teleport|has requested|sent a)/i);
        if (match3 && match3[1]) {
          requestingPlayer = match3[1];
        }
      }

      // 4. Pattern: "/tpaccept <player>", "/tpahere accept", "/tpaccept" in instruction text
      if (!requestingPlayer) {
        const match4 = parsedCleanText.match(/\/(?:tpaccept|tpahere|tpyes)\s+([a-zA-Z0-9_.*]+)/i);
        if (match4 && match4[1] && !['to', 'type', 'accept', 'here'].includes(match4[1].toLowerCase())) {
          requestingPlayer = match4[1];
        }
      }

      // 5. Pattern: "<player> wants to teleport to your location" or "<player> wants you to teleport to their location"
      if (!requestingPlayer) {
        const match5 = parsedCleanText.match(/([a-zA-Z0-9_.*]+)\s+(?:wants to teleport to your location|wants you to teleport to their location|requested you to teleport|requested you teleport|requested to teleport here)/i);
        if (match5 && match5[1]) {
          requestingPlayer = match5[1];
        }
      }

      // 6. Parameterized translation or generic /tpaccept / /tpahere notice
      if (!requestingPlayer && (parsedCleanText.toLowerCase().includes('/tpaccept') || parsedCleanText.toLowerCase().includes('/tpahere') || parsedCleanText.toLowerCase().includes('teleport'))) {
        for (const p of params) {
          const strippedP = String(p).replace(/§[0-9a-fk-or]/gi, '').replace(/&[0-9a-fk-or]/gi, '').trim();
          if (/^[a-zA-Z0-9_.*]{3,20}$/.test(strippedP) && strippedP.toLowerCase() !== 'server') {
            requestingPlayer = strippedP;
            break;
          }
        }
        if (!requestingPlayer && packet.source_name && /^[a-zA-Z0-9_.*]{3,20}$/.test(packet.source_name) && packet.source_name.toLowerCase() !== 'server') {
          requestingPlayer = packet.source_name;
        }
      }

      if (!requestingPlayer) return;

      const cleanPlayer = requestingPlayer.trim();
      const isTrusted = IgnoreListStorage.isIgnored(cleanPlayer);
      let isBot = false;
      try {
        const { AccountManager } = require('./AccountManager');
        isBot = AccountManager.isKnownBot(cleanPlayer);
      } catch {}

      if (!isTrusted && !isBot) {
        logger.debug(`Ignored teleport request from untrusted player: '${cleanPlayer}'`, this.accountId);
        return;
      }

      // Debounce duplicate requests within 2 seconds
      const now = Date.now();
      if (now - this.lastTpacceptTime < 2000 && this.lastTpacceptPlayer.toLowerCase() === cleanPlayer.toLowerCase()) {
        return;
      }
      this.lastTpacceptTime = now;
      this.lastTpacceptPlayer = cleanPlayer;

      logger.info(`[AUTO-TPACCEPT] Auto-accepting teleport request (TPA/TPAHERE) from trusted player: '${cleanPlayer}'`, this.accountId);

      // Execute in-game commands: /tpaccept <player>, fallback /tpaccept, /tpahere accept, /tpa accept, /tpyes
      this.sendChat(`/tpaccept ${cleanPlayer}`);

      setTimeout(() => {
        try {
          if (this.client && this.state === ConnectionState.CONNECTED) {
            this.sendChat('/tpaccept');
          }
        } catch {}
      }, 250);

      setTimeout(() => {
        try {
          if (this.client && this.state === ConnectionState.CONNECTED) {
            this.sendChat('/tpahere accept');
          }
        } catch {}
      }, 500);

      setTimeout(() => {
        try {
          if (this.client && this.state === ConnectionState.CONNECTED) {
            this.sendChat('/tpa accept');
          }
        } catch {}
      }, 750);

      setTimeout(() => {
        try {
          if (this.client && this.state === ConnectionState.CONNECTED) {
            this.sendChat('/tpyes');
          }
        } catch {}
      }, 1000);
    } catch (err: any) {
      logger.debug(`Error handling teleport request: ${err?.message}`, this.accountId);
    }
  }

  private handleConnectionFailure(reason: string, minDelayMs?: number): void {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }

    // If manual disconnect was requested by user, do not auto-reconnect
    if (!this.watchdog.isRunning()) {
      return;
    }

    // Normalize and clean up reason string for user-facing logs
    let cleanReason = sanitizeErrorMessage(reason);
    if (!cleanReason || cleanReason.toLowerCase() === 'unknown' || cleanReason === 'undefined') {
      cleanReason = 'Connection lost / Server kick';
    }

    // Log leave event to Discord DISCORD_LEFT_LOG_CHANNEL_ID
    discordLogger.logBotLeft(this.accountId, this.inGameIgn || this.xboxUsername || this.accountId, cleanReason);

    // Check for fatal missing Xbox profile error
    const isMissingXboxProfile =
      reason.includes('does not have an Xbox profile') ||
      reason.includes('2148916233') ||
      reason.includes('CreateAccount') ||
      reason.includes('Missing Xbox User ID (XUID)');

    if (isMissingXboxProfile) {
      this.watchdog.stop(); // Stop infinite reconnect loop!
      this.setState(ConnectionState.AUTH_FAILED);
      this.authManager.setStatus(AccountAuthStatus.XBOX_PROFILE_REQUIRED);
      this.authErrorMessage = 'Microsoft account lacks an active Xbox Live / Minecraft profile. Please visit https://account.xbox.com/profile or https://signup.live.com/signup to set up your Gamertag, then click "Retry Profile Check".';
      logger.error(
        `\n====================================================================\n` +
        `  ❌ XBOX / MINECRAFT PROFILE REQUIRED FOR BOT [${this.accountId}]\n` +
        `  This Microsoft account lacks an active Xbox Live / Minecraft profile.\n` +
        `  1. Visit https://account.xbox.com/profile or https://signup.live.com/signup\n` +
        `  2. Sign in with this account and create/confirm your Xbox Gamertag.\n` +
        `  3. Once created, click "Retry Profile Check" in Discord or the web dashboard.\n` +
        `====================================================================\n`,
        this.accountId
      );
      discordLogger.logAfkActivity(
        this.accountId,
        `⚠️ **Xbox Profile Required**: Microsoft account for bot [${this.accountId}] lacks an active Xbox Live profile. Please create one at https://account.xbox.com/profile, then click "Retry Profile Check".`
      );
      this.cleanupSession();
      return;
    }

    // Check for Bedrock multiplayer auth failure (401 on /multiplayer/bedrock/authentication)
    // This means the Xbox profile exists but Bedrock entitlement is missing or expired
    const isBedrockAuthFailure =
      reason.includes('/multiplayer/bedrock/authentication') ||
      (reason.includes('UNAUTHORIZED') && reason.includes('bedrock'));

    if (isBedrockAuthFailure) {
      this.watchdog.stop();
      this.setState(ConnectionState.AUTH_FAILED);
      this.authManager.setStatus(AccountAuthStatus.AUTH_FAILED);
      this.authErrorMessage = 'Bedrock multiplayer authentication failed. The account may not own Minecraft Bedrock Edition or the entitlement has expired. Try clearing cached tokens and reconnecting, or verify the account has Bedrock access.';
      logger.error(
        `\n====================================================================\n` +
        `  ❌ BEDROCK MULTIPLAYER AUTH FAILED [${this.accountId}]\n` +
        `  Account has Xbox profile but Bedrock multiplayer auth returned 401.\n` +
        `  Possible causes:\n` +
        `    - Account doesn't own Minecraft Bedrock Edition\n` +
        `    - Game Pass / Bedrock entitlement expired\n` +
        `    - Cached tokens are corrupted\n` +
        `  Try: Click "Re-authenticate" in web dashboard or Discord.\n` +
        `====================================================================\n`,
        this.accountId
      );
      discordLogger.logAfkActivity(
        this.accountId,
        `❌ **Bedrock Auth Failed**: Bot [${this.accountId}] — 401 on Bedrock multiplayer auth. Account may lack Bedrock entitlement.`
      );
      // Clear cached tokens so next attempt gets fresh ones
      this.clearAuthToken();
      this.cleanupSession();
      return;
    }

    // Check for max-accounts error → auto-shift to another RDP
    const isMaxAccounts =
      reason.toLowerCase().includes('max number of accounts online') ||
      reason.toLowerCase().includes('max accounts') ||
      reason.toLowerCase().includes('too many accounts') ||
      reason.toLowerCase().includes('account limit reached');

    if (isMaxAccounts) {
      logger.warn(`Account '${this.accountId}' hit max-accounts error. Attempting auto-shift...`, this.accountId);

      // Try to get account shifter from global reference
      const accountShifter = (global as any).__accountShifter;
      if (accountShifter) {
        // Fire-and-forget: shift runs in background
        accountShifter.handleMaxAccountsError(
          this.accountId,
          reason,
          async () => { await this.disconnect(); },
          () => {
            try {
              const botFile = require('fs').readFileSync(
                require('path').resolve(process.cwd(), 'bot', `${this.accountId}.txt`),
                'utf8'
              );
              const lines = botFile.trim().split('\n');
              return { email: lines[0] || '', password: lines[1] || '' };
            } catch {
              return null;
            }
          }
        ).then((shifted: boolean) => {
          if (shifted) {
            this.watchdog.stop();
            this.setState(ConnectionState.DISCONNECTED);
            this.cleanupSession();
          }
        }).catch(() => {});

        this.watchdog.stop();
        this.setState(ConnectionState.DISCONNECTED);
        this.cleanupSession();
        return;
      }

      // Fall through to normal reconnect if shift failed
      logger.warn(`Auto-shift failed for '${this.accountId}'. Falling back to reconnect...`, this.accountId);
    }

    const isWaf = isAzureWafBlock(cleanReason);
    if (isWaf) {
      // Azure WAF IP rate limit: back off by 3-5 minutes (180s-300s) with account jitter
      // so all bots don't slam the Microsoft endpoint at the exact same moment
      const numericId = parseInt(this.accountId.replace(/\D/g, ''), 10) || 1;
      const jitterMs = (numericId % 10) * 15000;
      const wafBackoffMs = Math.min(300000, 180000 + jitterMs);
      minDelayMs = Math.max(minDelayMs || 0, wafBackoffMs);
      logger.warn(
        `Azure WAF rate-limit detected for account [${this.accountId}]. Backing off reconnect for ${Math.round(minDelayMs / 1000)}s to allow IP block to clear.`,
        this.accountId
      );
    }

    const isAuthError =
      cleanReason.includes('401') ||
      cleanReason.includes('403') ||
      cleanReason.includes('Forbidden') ||
      cleanReason.includes('UNAUTHORIZED') ||
      cleanReason.includes('invalid_grant') ||
      isWaf;

    if (isAuthError) {
      this.authErrorMessage = `Authentication issue (${cleanReason.slice(0, 100)}). Will attempt reconnect with stored tokens.`;
      logger.warn(`Authentication issue noticed: ${cleanReason}. Retrying connection using session tokens in ./profile/${this.accountId}...`, this.accountId);
      this.setState(ConnectionState.AUTH_FAILED);
    } else {
      this.setState(ConnectionState.DISCONNECTED);
    }

    this.cleanupSession();

    // If we're still waiting on the user to finish the Microsoft device-code sign-in,
    // do NOT let the watchdog fire an aggressive reconnect.
    if (this.authManager && this.authManager.getStatus() === AccountAuthStatus.VERIFICATION_REQUIRED) {
      logger.debug('Skipping watchdog reconnect — still awaiting Microsoft device-code sign-in.', this.accountId);
      return;
    }

    // Reconnect on ALL kicks / disconnects / errors after configured time
    this.watchdog.handleDisconnect(cleanReason, minDelayMs);
  }

  public clearAuthToken(): void {
    logger.info(`Purging cached authentication tokens...`, this.accountId);
    if (this.authManager) {
      this.authManager.clearCache();
    } else {
      TokenStorage.clearTokens(this.accountId);
    }
    this.authErrorMessage = null;
    this.msaCodeData = null;
    this.lastLoggedMsaUserCode = null;
    this.xboxUsername = '';
    this.inGameIgn = '';
  }

  private cleanupSession(): void {
    // Reset to "unknown" sentinel (0n) so no packet handler can mistake a leftover id
    // from THIS session for the bot's identity in the NEXT session.
    this.runtimeEntityId = 0n;
    if (this.keepAliveEngine) {
      this.keepAliveEngine.stop();
      this.keepAliveEngine = null;
    }
    this.afkManager.stop();
    this.afkSpotTracker.pauseForDisconnect();
    this.autoRespawn.cancel();
    this.actionController.resetAllStates();
    this.playerMonitor.clear();
    this.containerMonitor.clear();
    this.defensiveCombat.clearTarget();

    if (this.client) {
      const clientToClose = this.client;
      this.client = null;
      try {
        (clientToClose as any).readPacket = () => {};
      } catch {
        // ignore
      }
      try {
        clientToClose.close();
      } catch (err) {
        // Ignore close errors during cleanup
      }
      // Re-attach no-op error handler since client.close() calls removeAllListeners(),
      // preventing unhandled 'error' events on trailing socket packets
      try {
        clientToClose.on('error', () => {});
      } catch {
        // ignore
      }
    }
  }

  public async disconnect(): Promise<void> {
    logger.info('Manually disconnecting account...', this.accountId);
    this.autoConnect = false;
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
    this.watchdog.stop();
    this.setState(ConnectionState.DISCONNECTED);
    this.cleanupSession();
  }

  public async dispose(): Promise<void> {
    logger.info('Disposing BedrockBot instance...', this.accountId);
    await this.disconnect();
    if (this.authManager) {
      this.authManager.dispose();
      this.authManager.clearCache();
    }
    this.afkSpotTracker.dispose();
    this.xboxUsername = '';
    this.inGameIgn = '';
    this.removeAllListeners();
  }
}
