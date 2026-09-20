import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { Authflow, Titles } from 'prismarine-auth';
import { TokenStorage } from './TokenStorage';
import { logger } from '../utils/logger';

export enum AccountAuthStatus {
  IDLE = 'IDLE',
  AUTHENTICATING = 'AUTHENTICATING',
  AUTHENTICATED = 'AUTHENTICATED',
  CHECKING_XBOX_PROFILE = 'CHECKING_XBOX_PROFILE',
  XBOX_PROFILE_READY = 'XBOX_PROFILE_READY',
  XBOX_PROFILE_REQUIRED = 'XBOX_PROFILE_REQUIRED',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  AUTH_FAILED = 'AUTH_FAILED',
  VERIFICATION_REQUIRED = 'VERIFICATION_REQUIRED',
  READY = 'READY',
  CONNECTING = 'CONNECTING',
  ONLINE = 'ONLINE',
  DISCONNECTED = 'DISCONNECTED',
}

export interface MsaCodeInfo {
  user_code: string;
  verification_uri: string;
  direct_verification_uri?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
}

export interface XboxIdentity {
  accountId: string;
  xuid: string | null;
  gamertag: string | null;
  uuid?: string | null;
  status: AccountAuthStatus;
  authErrorMessage: string | null;
  setupUrl: string | null;
  msaCodeInfo: MsaCodeInfo | null;
}

export interface AuthManagerOptions {
  accountId: string;
  profilesFolder?: string;
  authTitle?: string;
  offline?: boolean;
  autoRetryIntervalMs?: number;
  maxRetryIntervalMs?: number;
}

export class MicrosoftAuthManager extends EventEmitter {
  public readonly accountId: string;
  private profilesFolder: string;
  private authTitle: string;
  private offline: boolean;
  private status: AccountAuthStatus = AccountAuthStatus.IDLE;
  private authErrorMessage: string | null = null;
  private setupUrl: string | null = null;
  private msaCodeInfo: MsaCodeInfo | null = null;
  private xuid: string | null = null;
  private gamertag: string | null = null;
  private uuid: string | null = null;

  private authflow: Authflow | null = null;
  private autoRetryTimer: NodeJS.Timeout | null = null;
  private currentRetryDelayMs: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private isChecking: boolean = false;

  constructor(options: AuthManagerOptions) {
    super();
    this.accountId = options.accountId;
    this.profilesFolder = TokenStorage.getLocalProfilesFolder(options.profilesFolder || this.accountId);
    this.authTitle = options.authTitle && options.authTitle !== '0000000048183522'
      ? options.authTitle
      : Titles.MinecraftNintendoSwitch;
    this.offline = Boolean(options.offline);
    this.initialRetryDelayMs = options.autoRetryIntervalMs ?? 60000; // 60s default
    this.maxRetryDelayMs = options.maxRetryIntervalMs ?? 300000; // 5 min default
    this.currentRetryDelayMs = this.initialRetryDelayMs;

    this.initSavedIdentityFromCache();
  }

  /**
   * Reads any previously cached identity (XUID, Gamertag) from disk if available
   */
  private initSavedIdentityFromCache(): void {
    try {
      const resolvedPath = path.isAbsolute(this.profilesFolder)
        ? this.profilesFolder
        : path.resolve(process.cwd(), this.profilesFolder);

      if (!fs.existsSync(resolvedPath)) return;

      TokenStorage.sanitizeDirectory(resolvedPath);
      const files = fs.readdirSync(resolvedPath);
      // Check bed cache for cached profile data
      const bedFile = files.find((f) => f.endsWith('_bed-cache.json'));
      if (bedFile) {
        const content = JSON.parse(fs.readFileSync(path.join(resolvedPath, bedFile), 'utf8'));
        if (content.mca?.chain && Array.isArray(content.mca.chain) && content.mca.chain.length > 1) {
          const jwt = content.mca.chain[1];
          const payloadPart = jwt.split('.')[1];
          if (payloadPart) {
            const parsed = JSON.parse(Buffer.from(payloadPart, 'base64').toString('utf8'));
            if (parsed?.extraData?.displayName) {
              this.gamertag = parsed.extraData.displayName;
            }
            if (parsed?.extraData?.XUID) {
              this.xuid = String(parsed.extraData.XUID);
            }
            if (parsed?.extraData?.identity) {
              this.uuid = parsed.extraData.identity;
            }
          }
        }
      }

      // Check xbl cache if gamertag or xuid not yet found
      if (!this.xuid) {
        const xblFile = files.find((f) => f.endsWith('_xbl-cache.json'));
        if (xblFile) {
          const content = JSON.parse(fs.readFileSync(path.join(resolvedPath, xblFile), 'utf8'));
          for (const key of Object.keys(content)) {
            if (content[key]?.userXUID) {
              this.xuid = String(content[key].userXUID);
              break;
            }
          }
        }
      }
    } catch {
      // Non-fatal if cache cannot be read initially
    }
  }

  public getStatus(): AccountAuthStatus {
    return this.status;
  }

  public getAccountStatus(): AccountAuthStatus {
    return this.status;
  }

  public setStatus(newStatus: AccountAuthStatus): void {
    if (this.status !== newStatus) {
      const oldStatus = this.status;
      this.status = newStatus;
      logger.info(`Auth status changed: ${oldStatus} -> ${newStatus}`, this.accountId);
      this.emit('statusChanged', { oldStatus, newStatus, accountId: this.accountId });
    }
  }

  public getIdentity(): XboxIdentity {
    return {
      accountId: this.accountId,
      xuid: this.xuid,
      gamertag: this.gamertag,
      uuid: this.uuid,
      status: this.status,
      authErrorMessage: this.authErrorMessage,
      setupUrl: this.setupUrl,
      msaCodeInfo: this.msaCodeInfo,
    };
  }

  public getXboxIdentity(): XboxIdentity {
    return this.getIdentity();
  }

  public logoutAccount(): void {
    this.clearCache();
    try {
      if (this.profilesFolder && fs.existsSync(this.profilesFolder)) {
        fs.rmSync(this.profilesFolder, { recursive: true, force: true });
      }
      const folder = TokenStorage.getLocalProfilesFolder(this.profilesFolder);
      if (fs.existsSync(folder)) {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    } catch (err: any) {
      logger.debug(`logoutAccount rmSync error: ${err?.message}`, this.accountId);
    }
  }

  public getAuthflow(): Authflow | null {
    return this.authflow;
  }

  public setIdentity(gamertag?: string, xuid?: string, uuid?: string): void {
    if (gamertag) this.gamertag = gamertag;
    if (xuid) this.xuid = xuid;
    if (uuid) this.uuid = uuid;
  }

  /**
   * Initializes or returns the cached Authflow instance.
   */
  public getOrCreateAuthflow(): Authflow {
    if (this.authflow) return this.authflow;

    const absProfilesPath = TokenStorage.getLocalProfilesFolder(this.profilesFolder);

    const flowOptions: any = {
      flow: 'live',
      authTitle: this.authTitle,
      deviceType: 'Nintendo',
    };

    this.authflow = new Authflow(
      this.accountId,
      absProfilesPath,
      flowOptions,
      (data: any) => {
        this.msaCodeInfo = {
          user_code: data.user_code,
          verification_uri: data.verification_uri || 'https://www.microsoft.com/link',
          direct_verification_uri: data.direct_verification_uri || `http://microsoft.com/link?otc=${data.user_code}`,
          expires_in: data.expires_in,
          interval: data.interval,
          message: data.message,
        };
        this.setStatus(AccountAuthStatus.VERIFICATION_REQUIRED);
        this.emit('msaCode', this.msaCodeInfo);

        logger.info(
          `Microsoft interactive authentication required. Visit ${this.msaCodeInfo.verification_uri} and enter code ${this.msaCodeInfo.user_code}`,
          this.accountId
        );
      }
    );

    return this.authflow;
  }

  /**
   * Performs Microsoft authentication (Token cache or interactive device code)
   */
  public async authenticateAccount(): Promise<string | null> {
    if (this.offline) {
      this.setStatus(AccountAuthStatus.READY);
      return 'offline_token';
    }
    this.setStatus(AccountAuthStatus.AUTHENTICATING);
    const flow = this.getOrCreateAuthflow();
    try {
      const msaToken = await flow.getMsaToken();
      if (!msaToken) {
        this.setStatus(AccountAuthStatus.AUTH_REQUIRED);
        this.authErrorMessage = 'Microsoft authentication token not available.';
        return null;
      }
      this.setStatus(AccountAuthStatus.AUTHENTICATED);
      return msaToken;
    } catch (err: any) {
      this.handleAuthError(err);
      return null;
    }
  }

  /**
   * Checks whether the authenticated account has an active Xbox / Xbox Live profile
   */
  public async checkXboxProfile(forceRefresh: boolean = false): Promise<{ exists: boolean; xuid?: string | null; error?: string }> {
    if (this.offline) {
      return { exists: true, xuid: '0' };
    }
    this.setStatus(AccountAuthStatus.CHECKING_XBOX_PROFILE);
    const flow = this.getOrCreateAuthflow();
    try {
      // 1. Primary check: Query Xbox Live relying party (http://xboxlive.com)
      // This is the authoritative service that confirms the Xbox account & Gamertag exists
      const xblToken = await flow.getXboxToken('http://xboxlive.com', forceRefresh);
      if (xblToken && xblToken.userXUID) {
        this.xuid = String(xblToken.userXUID);
      }

      // Fetch real-time Gamertag from Xbox Live profile service
      if (xblToken?.userHash && xblToken?.XSTSToken) {
        try {
          let tag: string | undefined;
          const res = await fetch('https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag', {
            headers: {
              Authorization: `XBL3.0 x=${xblToken.userHash};${xblToken.XSTSToken}`,
              'x-xbl-contract-version': '2',
            },
          });
          if (res.ok) {
            const profileData: any = await res.json();
            tag = profileData.profileUsers?.[0]?.settings?.find((s: any) => s.id === 'Gamertag')?.value;
          }

          if (!tag && this.xuid) {
            const resXuid = await fetch(`https://profile.xboxlive.com/users/xuid(${this.xuid})/profile/settings?settings=Gamertag`, {
              headers: {
                Authorization: `XBL3.0 x=${xblToken.userHash};${xblToken.XSTSToken}`,
                'x-xbl-contract-version': '2',
              },
            });
            if (resXuid.ok) {
              const xuidData: any = await resXuid.json();
              tag = xuidData.profileUsers?.[0]?.settings?.find((s: any) => s.id === 'Gamertag')?.value;
            }
          }

          if (tag) {
            const previousTag = this.gamertag;
            this.gamertag = tag;
            if (previousTag !== tag) {
              logger.info(`Resolved real-time Xbox Gamertag: '${this.gamertag}' (XUID: ${this.xuid})`, this.accountId);
            }
          }
        } catch {
          // Non-fatal if profile API request fails
        }
      }

      // 2. Secondary check: Query Minecraft Bedrock multiplayer XSTS token
      const relyingParty = 'https://multiplayer.minecraft.net/';
      const mpToken = await flow.getXboxToken(relyingParty, forceRefresh);
      if (mpToken && mpToken.userXUID) {
        this.xuid = String(mpToken.userXUID);
      }

      if (!this.xuid && !xblToken?.userXUID) {
        throw new Error('Account has no active Xbox profile or GamerTag (Missing Xbox User ID (XUID)). Please visit https://account.xbox.com/profile to set up your profile.');
      }

      this.setStatus(AccountAuthStatus.XBOX_PROFILE_READY);
      this.setStatus(AccountAuthStatus.READY);
      this.stopAutoRetryTimer();
      this.currentRetryDelayMs = this.initialRetryDelayMs;
      this.emit('profileReady', this.getIdentity());
      return { exists: true, xuid: this.xuid };
    } catch (err: any) {
      this.handleAuthError(err);
      return { exists: false, error: this.authErrorMessage || err?.message };
    }
  }

  /**
   * Executes the full authentication & Xbox Live profile verification sequence:
   * Account Loaded -> Microsoft Authentication -> Xbox Live Profile Check -> Ready
   */
  public async authenticateAndVerify(forceRefresh: boolean = false): Promise<boolean> {
    if (this.offline) {
      this.setStatus(AccountAuthStatus.READY);
      return true;
    }

    if (this.isChecking) {
      logger.debug('Authentication check already in progress. Skipping duplicate check.', this.accountId);
      return false;
    }

    this.isChecking = true;
    this.authErrorMessage = null;
    this.setupUrl = null;

    try {
      logger.info('Authenticating Microsoft account...', this.accountId);
      const msaToken = await this.authenticateAccount();
      if (!msaToken) {
        this.isChecking = false;
        return false;
      }

      logger.info('Verifying Xbox Live profile presence...', this.accountId);
      const profileResult = await this.checkXboxProfile(forceRefresh);
      this.isChecking = false;
      return profileResult.exists;
    } catch (err: any) {
      this.isChecking = false;
      return this.handleAuthError(err);
    }
  }

  /**
   * Differentiates error conditions accurately (missing profile, under 18, rate limits, network errors).
   */
  public handleAuthError(err: any): boolean {
    const message = err?.message || String(err);
    const code = err?.XErr || err?.errorCode || '';

    logger.debug(`Auth error encountered (${code}): ${message}`, this.accountId);

    // 1. Missing Xbox Profile check (Error 2148916233)
    const isMissingXboxProfile =
      String(code) === '2148916233' ||
      message.includes('2148916233') ||
      message.includes('does not have an Xbox profile') ||
      message.includes('CreateAccount') ||
      message.includes('Missing Xbox User ID (XUID)');

    if (isMissingXboxProfile) {
      this.setStatus(AccountAuthStatus.XBOX_PROFILE_REQUIRED);
      this.setupUrl = 'https://account.xbox.com/profile';
      this.authErrorMessage =
        'This Microsoft account lacks an active Xbox Live / Minecraft profile. Please set up your Xbox profile at https://account.xbox.com/profile and ensure you can sign in to Minecraft.';

      logger.error(
        `\n====================================================================\n` +
        `  ❌ XBOX PROFILE REQUIRED FOR BOT [${this.accountId}]\n` +
        `  This Microsoft account lacks an active Xbox/Minecraft profile.\n` +
        `  1. Visit https://account.xbox.com/profile or https://signup.live.com/signup\n` +
        `  2. Sign in and create/confirm your Xbox Gamertag.\n` +
        `  3. Once finished, click 'Retry Profile Check' in Discord or Web GUI.\n` +
        `====================================================================\n`,
        this.accountId
      );

      this.emit('profileRequired', {
        accountId: this.accountId,
        setupUrl: this.setupUrl,
        message: this.authErrorMessage,
      });

      // Start automatic exponential backoff retry so when setup is complete, bot recovers automatically
      this.startAutoRetryTimer();
      return false;
    }

    // 1b. Bedrock multiplayer auth failure (401 on /multiplayer/bedrock/authentication)
    // Xbox profile exists but Bedrock entitlement missing or tokens corrupted
    const isBedrockAuthFailure =
      message.includes('/multiplayer/bedrock/authentication') ||
      message.includes('Ensure that you are able to sign-in to Minecraft with this account');

    if (isBedrockAuthFailure) {
      this.setStatus(AccountAuthStatus.XBOX_PROFILE_REQUIRED);
      this.setupUrl = 'https://account.xbox.com/profile';
      this.authErrorMessage =
        'Bedrock multiplayer authentication failed. Account may lack Bedrock entitlement. Complete profile at https://account.xbox.com/profile';
      logger.error(
        `\n====================================================================\n` +
        `  ❌ BEDROCK MULTIPLAYER AUTH FAILED [${this.accountId}]\n` +
        `  Account has Xbox profile but Bedrock multiplayer auth returned 401.\n` +
        `  Visit https://account.xbox.com/profile to verify entitlement.\n` +
        `====================================================================\n`,
        this.accountId
      );
      this.emit('profileRequired', {
        accountId: this.accountId,
        setupUrl: this.setupUrl,
      });
      this.startAutoRetryTimer();
      return false;
    }

    // 2. Child account / Under 18 restriction (Error 2148916238)
    if (String(code) === '2148916238' || message.includes('2148916238') || message.includes('under 18')) {
      this.setStatus(AccountAuthStatus.AUTH_FAILED);
      this.authErrorMessage = 'Account date of birth is under 18 and requires adult family consent at https://account.microsoft.com/family/';
      this.stopAutoRetryTimer();
      return false;
    }

    // 3. Banned from Xbox Live (Error 2148916227)
    if (String(code) === '2148916227' || message.includes('2148916227') || message.includes('banned')) {
      this.setStatus(AccountAuthStatus.AUTH_FAILED);
      this.authErrorMessage = 'Account has been banned by Xbox for violating Community Standards.';
      this.stopAutoRetryTimer();
      return false;
    }

    // 4. Rate limited / 429
    if (message.includes('429') || message.includes('Too Many Requests')) {
      this.setStatus(AccountAuthStatus.AUTH_FAILED);
      this.authErrorMessage = 'Rate limited by Microsoft / Xbox auth endpoints. Backing off before retrying.';
      this.startAutoRetryTimer();
      return false;
    }

    // 5. Expired / Invalid grant
    if (
      message.includes('invalid_grant') ||
      message.includes('401') ||
      message.includes('UNAUTHORIZED')
    ) {
      this.setStatus(AccountAuthStatus.AUTH_REQUIRED);
      this.authErrorMessage = 'Session expired or invalidated. Authentication renewal required.';
      return false;
    }

    // 6. Network failure / Outage
    if (
      message.includes('ENOTFOUND') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ECONNRESET') ||
      message.includes('fetch failed')
    ) {
      this.setStatus(AccountAuthStatus.AUTH_FAILED);
      this.authErrorMessage = `Network error connecting to Microsoft services: ${message.slice(0, 100)}`;
      this.startAutoRetryTimer();
      return false;
    }

    // Generic auth failure
    this.setStatus(AccountAuthStatus.AUTH_FAILED);
    this.authErrorMessage = `Xbox authentication failed: ${message.slice(0, 120)}`;
    return false;
  }

  /**
   * Starts safe periodic retry timer with exponential backoff for profile checking.
   */
  public startAutoRetryTimer(): void {
    if (this.autoRetryTimer) return;

    logger.info(`Scheduling background profile check retry in ${Math.round(this.currentRetryDelayMs / 1000)}s...`, this.accountId);

    this.autoRetryTimer = setTimeout(async () => {
      this.autoRetryTimer = null;
      if (this.status === AccountAuthStatus.XBOX_PROFILE_REQUIRED || this.status === AccountAuthStatus.AUTH_FAILED) {
        logger.info('Executing scheduled profile check retry...', this.accountId);
        const success = await this.authenticateAndVerify(true);
        if (!success) {
          // Exponential backoff
          this.currentRetryDelayMs = Math.min(this.currentRetryDelayMs * 1.5, this.maxRetryDelayMs);
          this.startAutoRetryTimer();
        }
      }
    }, this.currentRetryDelayMs);
  }

  public stopAutoRetryTimer(): void {
    if (this.autoRetryTimer) {
      clearTimeout(this.autoRetryTimer);
      this.autoRetryTimer = null;
    }
  }

  /**
   * Manually triggers a retry of the Xbox profile check.
   */
  public async retryProfileCheck(): Promise<boolean> {
    logger.info('Manual profile check retry initiated.', this.accountId);
    this.stopAutoRetryTimer();
    this.currentRetryDelayMs = this.initialRetryDelayMs;
    return this.authenticateAndVerify(true);
  }

  /**
   * Clears cached session tokens securely without printing tokens.
   */
  public clearCache(): void {
    logger.info('Clearing cached auth tokens...', this.accountId);
    this.stopAutoRetryTimer();
    TokenStorage.clearTokens(this.accountId).catch(() => { });
    this.authflow = null;
    this.xuid = null;
    this.gamertag = null;
    this.uuid = null;
    this.msaCodeInfo = null;
    this.authErrorMessage = null;
    this.setupUrl = null;
    this.setStatus(AccountAuthStatus.IDLE);
  }

  public dispose(): void {
    this.stopAutoRetryTimer();
    this.removeAllListeners();
  }
}
