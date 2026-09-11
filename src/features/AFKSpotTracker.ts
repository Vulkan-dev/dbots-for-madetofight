import { Vector3D, MathUtils } from '../utils/MathUtils';
import { discordLogger } from '../discord/DiscordLogger';
import { LocationStorage } from '../storage/LocationStorage';
import { logger } from '../utils/logger';

export class AFKSpotTracker {
  private botName: string;
  private isAfkMode: boolean = false;
  private isPaused: boolean = false;
  private savedAfkSpot: Vector3D | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private executeCommandCallback: ((cmd: string) => void) | null = null;
  private getPositionCallback: (() => Vector3D) | null = null;
  private isConnectedCallback: (() => boolean) | null = null;

  private checkIntervalMs: number = 300000; // 5 minutes default
  private toleranceBlocks: number = 3.0; // 3.0 blocks tolerance default

  constructor(
    botName: string,
    checkIntervalMs: number = 300000,
    toleranceBlocks: number = 3.0
  ) {
    this.botName = botName;
    this.checkIntervalMs = checkIntervalMs;
    this.toleranceBlocks = toleranceBlocks;
  }

  public setCallbacks(
    executeCmd: (cmd: string) => void,
    getPos: () => Vector3D,
    isConnected?: () => boolean
  ): void {
    this.executeCommandCallback = executeCmd;
    this.getPositionCallback = getPos;
    if (isConnected) {
      this.isConnectedCallback = isConnected;
    }
  }

  /**
   * Activates AFK mode for the bot.
   * Runs /sethome 1 in-game, persists coordinates in location.js, and starts the check interval.
   */
  public activateAfkMode(customCoords?: Vector3D): void {
    if (!this.getPositionCallback || !this.executeCommandCallback) {
      logger.warn('Cannot activate AFK mode: Callbacks not set.', this.botName);
      return;
    }

    this.isAfkMode = true;
    this.isPaused = false;
    const currentPos = customCoords || this.getPositionCallback();
    this.savedAfkSpot = {
      x: Math.round(currentPos.x),
      y: Math.round(currentPos.y),
      z: Math.round(currentPos.z),
    };

    // 1. Execute in-game /sethome 1
    logger.info(`AFK Mode Activated. Issuing /sethome 1 at ${MathUtils.formatPos(this.savedAfkSpot)}`, this.botName);
    this.executeCommandCallback('/sethome 1');

    // 2. Persist in location.js
    LocationStorage.saveLocation(this.botName, this.savedAfkSpot);

    // 3. Log activity
    discordLogger.logAfkActivity(this.botName, `AFK Spot saved at ${MathUtils.formatPos(this.savedAfkSpot)}. Command /sethome 1 issued.`);

    // 4. Start periodic 5-minute check
    this.startPeriodicCheck();
  }

  /**
   * Restores AFK mode from persistent storage (location.js) on startup.
   * Does NOT re-issue /sethome 1 so server sethome isn't overwritten.
   */
  public restoreFromStorage(coords: Vector3D): void {
    this.isAfkMode = true;
    this.isPaused = false;
    this.savedAfkSpot = {
      x: Math.round(coords.x),
      y: Math.round(coords.y),
      z: Math.round(coords.z),
    };
    logger.info(`Restored AFK Spot from location.js at ${MathUtils.formatPos(this.savedAfkSpot)}`, this.botName);
    this.startPeriodicCheck();
  }

  /**
   * Resets the AFK location by executing /delhome 1 followed by /sethome 1,
   * saving new coordinates to location.js, and restarting the 5-minute check cycle.
   */
  public resetAfkLocation(customCoords?: Vector3D): void {
    if (!this.getPositionCallback || !this.executeCommandCallback) {
      logger.warn('Cannot reset AFK location: Callbacks not set.', this.botName);
      return;
    }

    // 1. Issue /delhome 1
    logger.info('Resetting AFK spot. Issuing /delhome 1...', this.botName);
    this.executeCommandCallback('/delhome 1');

    const currentPos = customCoords || this.getPositionCallback();
    this.savedAfkSpot = {
      x: Math.round(currentPos.x),
      y: Math.round(currentPos.y),
      z: Math.round(currentPos.z),
    };

    // 2. Issue /sethome 1 after a short delay so server processes delhome first
    setTimeout(() => {
      if (this.executeCommandCallback && this.savedAfkSpot) {
        logger.info(`Issuing /sethome 1 at ${MathUtils.formatPos(this.savedAfkSpot)}`, this.botName);
        this.executeCommandCallback('/sethome 1');
      }
    }, 500);

    // 3. Persist in location.js
    LocationStorage.saveLocation(this.botName, this.savedAfkSpot);

    // 4. Log activity
    discordLogger.logAfkActivity(
      this.botName,
      `AFK Spot reset to ${MathUtils.formatPos(this.savedAfkSpot)}. Issued /delhome 1 and /sethome 1.`
    );

    this.isAfkMode = true;
    this.isPaused = false;
    this.startPeriodicCheck();
  }

  /**
   * Deactivates AFK mode, stops the 5-minute monitoring, optionally issues /delhome 1, and removes location from storage.
   */
  public deactivateAfkMode(deleteHome: boolean = false): void {
    if (deleteHome && this.executeCommandCallback) {
      logger.info('UnAFK executed. Issuing /delhome 1...', this.botName);
      this.executeCommandCallback('/delhome 1');
      discordLogger.logAfkActivity(this.botName, 'UnAFK executed: Issued /delhome 1 and stopped 5-minute AFK monitoring.');
    }

    this.isAfkMode = false;
    this.isPaused = false;
    this.savedAfkSpot = null;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    if (deleteHome) {
      LocationStorage.removeLocation(this.botName);
    }
    logger.info('AFK Mode Deactivated.', this.botName);
  }

  private startPeriodicCheck(): void {
    if (this.checkInterval) clearInterval(this.checkInterval);

    // Check position every configured interval (default 5 minutes / 300,000 ms)
    this.checkInterval = setInterval(() => {
      this.checkPositionAndEnforceHome();
    }, this.checkIntervalMs);
  }

  public checkPositionAndEnforceHome(): void {
    if (this.isPaused || !this.isAfkMode || !this.savedAfkSpot || !this.getPositionCallback || !this.executeCommandCallback) {
      return;
    }

    // Skip if bot is currently offline
    if (this.isConnectedCallback && !this.isConnectedCallback()) {
      logger.debug('Skipping AFK spot check: bot is currently offline.', this.botName);
      return;
    }

    const currentPos = this.getPositionCallback();
    const distanceMoved = MathUtils.euclideanDistance(this.savedAfkSpot, currentPos);

    logger.debug(`AFK spot check: Moved ${distanceMoved.toFixed(2)} blocks from saved spot (tolerance: ${this.toleranceBlocks}).`, this.botName);

    // If bot has moved more than tolerance blocks from the AFK spot
    if (distanceMoved > this.toleranceBlocks) {
      const logMsg = `Bot Is Not On Afk Spot (drift: ${distanceMoved.toFixed(1)} blocks). Going Home 1.`;
      logger.warn(logMsg, this.botName);

      // Execute in-game /home 1
      this.executeCommandCallback('/home 1');

      // Send alert to Discord log channel
      discordLogger.logAfkActivity(this.botName, logMsg);
    }
  }

  public isActive(): boolean {
    return this.isAfkMode;
  }

  /**
   * Pauses the 5-minute drift monitor WITHOUT deleting the saved AFK spot.
   */
  public pauseMonitoring(): void {
    this.isPaused = true;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('AFK monitoring paused (spot kept — click again to resume).', this.botName);
    discordLogger.logAfkActivity(this.botName, 'AFK monitoring paused. Spot kept — click again to resume.');
  }

  /**
   * Resumes the 5-minute drift monitor after pauseMonitoring().
   */
  public resumeMonitoring(): void {
    if (!this.savedAfkSpot) {
      logger.warn('Cannot resume AFK monitoring: no AFK spot has been set yet.', this.botName);
      return;
    }
    this.isPaused = false;
    this.isAfkMode = true;
    this.startPeriodicCheck();
    logger.info('AFK monitoring resumed.', this.botName);
    discordLogger.logAfkActivity(this.botName, 'AFK monitoring resumed.');
  }

  public isMonitoringPaused(): boolean {
    return this.isPaused;
  }

  public getSavedSpot(): Vector3D | null {
    return this.savedAfkSpot;
  }

  public dispose(): void {
    this.deactivateAfkMode(false);
    this.executeCommandCallback = null;
    this.getPositionCallback = null;
    this.isConnectedCallback = null;
  }
}
