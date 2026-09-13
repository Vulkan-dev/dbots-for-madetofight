import { Client } from 'bedrock-protocol';
import { logger } from '../utils/logger';
import { Vector3D } from '../utils/MathUtils';
import { KeepAliveEngine } from '../network/KeepAliveEngine';

export interface ActionStates {
  isCrouching: boolean;
  isJumping: boolean;
  isLeftClicking: boolean;
  isRightClicking: boolean;
  isSpamClicking: boolean;
  spamMinDelay: number;
  spamMaxDelay: number;
}

export class ActionController {
  private accountId: string;
  private getClient: () => Client | null;
  private getRuntimeEntityId: () => any;
  private getPosition: () => Vector3D;
  private getKeepAliveEngine: () => KeepAliveEngine | null;
  private attackNearbyCallback?: () => void;
  private getRotation?: () => { pitch: number; yaw: number };
  private getHotbarSlot?: () => number;
  private getHeldItem?: () => any;
  private interactNearbyCallback?: () => void;
  private getInventory?: () => any[];
  private switchSlotCallback?: (slot: number) => void;
  private findItemSlotCallback?: (itemName: string) => number;

  public isCrouching: boolean = false;
  public isJumping: boolean = false;
  public isLeftClicking: boolean = false;
  public isRightClicking: boolean = false;
  public isSpamClicking: boolean = false;

  public spamMinDelay: number = 100;
  public spamMaxDelay: number = 250;

  private jumpInterval: NodeJS.Timeout | null = null;
  private rightClickInterval: NodeJS.Timeout | null = null;
  private spamClickTimeout: NodeJS.Timeout | null = null;

  constructor(
    accountId: string,
    getClient: () => Client | null,
    getRuntimeEntityId: () => any,
    getPosition: () => Vector3D,
    getKeepAliveEngine: () => KeepAliveEngine | null,
    attackNearbyCallback?: () => void,
    getRotation?: () => { pitch: number; yaw: number },
    getHotbarSlot?: () => number,
    getHeldItem?: () => any,
    interactNearbyCallback?: () => void,
    getInventory?: () => any[],
    switchSlotCallback?: (slot: number) => void,
    findItemSlotCallback?: (itemName: string) => number
  ) {
    this.accountId = accountId;
    this.getClient = getClient;
    this.getRuntimeEntityId = getRuntimeEntityId;
    this.getPosition = getPosition;
    this.getKeepAliveEngine = getKeepAliveEngine;
    this.attackNearbyCallback = attackNearbyCallback;
    this.getRotation = getRotation;
    this.getHotbarSlot = getHotbarSlot;
    this.getHeldItem = getHeldItem;
    this.interactNearbyCallback = interactNearbyCallback;
    this.getInventory = getInventory;
    this.switchSlotCallback = switchSlotCallback;
    this.findItemSlotCallback = findItemSlotCallback;
  }

  public getStates(): ActionStates {
    return {
      isCrouching: this.isCrouching,
      isJumping: this.isJumping,
      isLeftClicking: this.isLeftClicking,
      isRightClicking: this.isRightClicking,
      isSpamClicking: this.isSpamClicking,
      spamMinDelay: this.spamMinDelay,
      spamMaxDelay: this.spamMaxDelay,
    };
  }

  /**
   * Toggle Crouch (Sneak) with synchronized Geyser InputCache transition states
   */
  public toggleCrouch(enabled?: boolean): boolean {
    const targetState = enabled !== undefined ? enabled : !this.isCrouching;
    this.isCrouching = targetState;

    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    const engine = this.getKeepAliveEngine();

    // 1. Send Geyser/Bedrock 20Hz InputEngine sneak transition
    if (engine) {
      engine.setSneak(this.isCrouching);
    }

    // 2. Also send player_action start_sneak/stop_sneak for vanilla BDS compatibility
    if (client && runtimeId != null) {
      try {
        client.queue('player_action', {
          runtime_entity_id: runtimeId,
          action: this.isCrouching ? 'start_sneak' : 'stop_sneak',
          position: { x: 0, y: 0, z: 0 },
          result_position: { x: 0, y: 0, z: 0 },
          face: 0,
        });
      } catch (err) {
        logger.debug('Failed to send sneak player_action packet', this.accountId);
      }

      // 3. Send player_input packet for legacy Geyser/Bedrock input syncing
      try {
        client.queue('player_input', {
          motion_x: 0,
          motion_z: 0,
          jumping: false,
          sneaking: this.isCrouching,
        });
      } catch (err) {
        logger.debug('Failed to send sneak player_input packet', this.accountId);
      }
    }

    logger.info(`Crouch toggle: ${this.isCrouching ? 'ON' : 'OFF'}`, this.accountId);
    return this.isCrouching;
  }

  /**
   * Toggle Continuous Jump
   */
  public toggleJump(enabled?: boolean): boolean {
    const targetState = enabled !== undefined ? enabled : !this.isJumping;
    this.isJumping = targetState;

    if (this.jumpInterval) {
      clearInterval(this.jumpInterval);
      this.jumpInterval = null;
    }

    const engine = this.getKeepAliveEngine();

    if (this.isJumping) {
      this.executeSingleJump();
      // Jump repeatedly every 750ms
      this.jumpInterval = setInterval(() => {
        this.executeSingleJump();
      }, 750);
    } else {
      if (engine) {
        engine.removeInputFlag('jumping');
        engine.removeInputFlag('jump_down');
        engine.removeInputFlag('start_jumping');
      }
    }

    logger.info(`Jump toggle: ${this.isJumping ? 'ON' : 'OFF'}`, this.accountId);
    return this.isJumping;
  }

  private executeSingleJump(): void {
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    const engine = this.getKeepAliveEngine();

    if (client && runtimeId != null) {
      try {
        client.queue('player_action', {
          runtime_entity_id: runtimeId,
          action: 'jump',
          position: { x: 0, y: 0, z: 0 },
          result_position: { x: 0, y: 0, z: 0 },
          face: 0,
        });
      } catch (err) {
        logger.debug('Failed to send jump player_action packet', this.accountId);
      }
    }

    if (engine) {
      engine.triggerJump();
    }
  }

  /**
   * Toggle Right Click (Continuous Item Use / Block Placing / Air Use)
   */
  public toggleRightClick(enabled?: boolean): boolean {
    const targetState = enabled !== undefined ? enabled : !this.isRightClicking;
    this.isRightClicking = targetState;

    if (this.rightClickInterval) {
      clearInterval(this.rightClickInterval);
      this.rightClickInterval = null;
    }

    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();

    if (this.isRightClicking) {
      this.executeSingleRightClick();
      this.rightClickInterval = setInterval(() => {
        this.executeSingleRightClick();
      }, 350);
    } else {
      if (client && runtimeId != null) {
        try {
          client.queue('player_action', {
            runtime_entity_id: runtimeId,
            action: 'stop_item_use_on',
            position: { x: 0, y: 0, z: 0 },
            result_position: { x: 0, y: 0, z: 0 },
            face: 0,
          });
        } catch (err) {
          logger.debug('Failed to send stop_item_use_on packet', this.accountId);
        }
      }
    }

    logger.info(`Right-click toggle: ${this.isRightClicking ? 'ON' : 'OFF'}`, this.accountId);
    return this.isRightClicking;
  }

  public executeSingleRightClick(): void {
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    if (!client || runtimeId == null) return;

    try {
      let heldItem = this.getHeldItem ? this.getHeldItem() : { network_id: 0 };
      let hotbarSlot = this.getHotbarSlot ? this.getHotbarSlot() : 0;

      // If current hand is empty, auto-select first hotbar slot (0-8) with an item
      if (!ActionController.hasValidItem(heldItem) && this.getInventory && this.switchSlotCallback) {
        const inv = this.getInventory();
        if (Array.isArray(inv)) {
          for (let s = 0; s < 9; s++) {
            if (ActionController.hasValidItem(inv[s])) {
              this.switchSlotCallback(s);
              hotbarSlot = s;
              heldItem = inv[s];
              break;
            }
          }
        }
      }

      this.sendUseItemInHand(hotbarSlot, heldItem);
    } catch (err) {
      logger.debug('Failed to send right-click (use item) packet', this.accountId);
    }
  }

  private static hasValidItem(it: any): boolean {
    return !!it &&
      ((typeof it.network_id === 'number' && it.network_id !== 0) ||
        (typeof it.id === 'number' && it.id !== 0) ||
        (typeof it.id === 'string' && it.id !== '' && it.id !== 'minecraft:air'));
  }

  private sendUseItemInHand(hotbarSlot: number, heldItem: any): void {
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    const pos = this.getPosition();
    if (!client || runtimeId == null) return;

    const formattedHeldItem = {
      network_id: typeof heldItem?.network_id === 'number' ? heldItem.network_id : (typeof heldItem?.id === 'number' ? heldItem.id : 0),
      count: heldItem?.count || 1,
      metadata: heldItem?.metadata || 0,
      has_stack_id: heldItem?.has_stack_id ? 1 : 0,
      block_runtime_id: heldItem?.block_runtime_id || 0,
      extra: heldItem?.extra || { has_nbt: 0, can_place_on: [], can_destroy: [] },
    };

    const engine = this.getKeepAliveEngine();
    if (engine) {
      engine.triggerItemUse();
    }

    client.queue('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0, legacy_set_item_slots: [] },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: {
          action_type: 'click_air',
          trigger_type: 'player_input',
          block_position: { x: 0, y: 0, z: 0 },
          face: 255,
          hotbar_slot: hotbarSlot,
          held_item: formattedHeldItem,
          player_pos: pos,
          click_pos: { x: 0, y: 0, z: 0 },
          block_runtime_id: 0,
          client_prediction: 'success',
          client_cooldown_state: 'off',
        },
      },
    });

    if (this.interactNearbyCallback) {
      this.interactNearbyCallback();
    }
  }

  public throwPearl(): boolean {
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    if (!client || runtimeId == null) return false;

    if (!this.findItemSlotCallback || !this.getInventory) {
      this.executeSingleRightClick();
      return true;
    }

    const pearlSlot = this.findItemSlotCallback('minecraft:ender_pearl');
    if (pearlSlot === -1) {
      const heldItem = this.getHeldItem ? this.getHeldItem() : null;
      const heldSlot = this.getHotbarSlot ? this.getHotbarSlot() : 0;
      if (ActionController.hasValidItem(heldItem)) {
        logger.warn('Ender pearl auto-detection failed — falling back to throwing whatever is currently held.', this.accountId);
        this.sendUseItemInHand(heldSlot, heldItem);
        return true;
      }
      logger.warn('Throw Pearl requested but no ender pearl found in hotbar.', this.accountId);
      return false;
    }

    try {
      const inv = this.getInventory();
      const pearlItem = Array.isArray(inv) ? inv[pearlSlot] : null;
      if (!ActionController.hasValidItem(pearlItem)) {
        return false;
      }

      const currentSlot = this.getHotbarSlot ? this.getHotbarSlot() : -1;
      if (currentSlot !== pearlSlot && this.switchSlotCallback) {
        this.switchSlotCallback(pearlSlot);
      }

      this.sendUseItemInHand(pearlSlot, pearlItem);
      logger.info(`Threw ender pearl from hotbar slot ${pearlSlot}.`, this.accountId);
      return true;
    } catch (err) {
      logger.debug('Failed to send throw pearl packet', this.accountId);
      return false;
    }
  }

  /**
   * Throw the item currently held in hand
   */
  public throwItem(): boolean {
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    if (!client || runtimeId == null) return false;

    let heldItem = this.getHeldItem ? this.getHeldItem() : null;
    let hotbarSlot = this.getHotbarSlot ? this.getHotbarSlot() : 0;
    const inv = this.getInventory ? this.getInventory() : [];

    // Fallback 1: If heldItem is empty, check currently selected hotbar slot in inventory
    if (!ActionController.hasValidItem(heldItem) && Array.isArray(inv) && inv[hotbarSlot]) {
      heldItem = inv[hotbarSlot];
    }

    // Fallback 2: If current slot is empty, search hotbar slots 0..8 for any valid item
    if (!ActionController.hasValidItem(heldItem) && Array.isArray(inv)) {
      for (let s = 0; s < 9; s++) {
        if (ActionController.hasValidItem(inv[s])) {
          hotbarSlot = s;
          heldItem = inv[s];
          if (this.switchSlotCallback) this.switchSlotCallback(s);
          break;
        }
      }
    }

    if (!ActionController.hasValidItem(heldItem)) {
      logger.debug('throwItem requested but hand and hotbar are empty.', this.accountId);
      return false;
    }

    const formattedItem = {
      network_id: typeof heldItem?.network_id === 'number' ? heldItem.network_id : (typeof heldItem?.id === 'number' ? heldItem.id : 0),
      count: heldItem?.count || 1,
      metadata: heldItem?.metadata || 0,
      has_stack_id: heldItem?.has_stack_id ? 1 : 0,
      block_runtime_id: heldItem?.block_runtime_id || 0,
      extra: heldItem?.extra || { has_nbt: 0, can_place_on: [], can_destroy: [] },
    };
    const emptyItem = { network_id: 0 };

    let sent = false;

    // 1. Primary: player_action drop_item (standard Bedrock drop packet)
    try {
      client.queue('player_action', {
        runtime_entity_id: runtimeId,
        action: 'drop_item',
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0,
      });
      sent = true;
    } catch (err: any) {
      logger.debug(`Failed to queue player_action drop: ${err?.message}`);
    }

    // 2. Secondary: inventory_transaction normal drop (container -> world_interaction, Geyser / Paper compatible)
    try {
      client.queue('inventory_transaction', {
        transaction: {
          legacy: { legacy_request_id: 0, legacy_set_item_slots: [] },
          transaction_type: 'normal',
          actions: [
            {
              source_type: 'container',
              inventory_id: 'inventory',
              slot: hotbarSlot,
              old_item: formattedItem,
              new_item: emptyItem,
            },
            {
              source_type: 'world_interaction',
              flags: 0,
              slot: 0,
              old_item: emptyItem,
              new_item: formattedItem,
            },
          ],
          transaction_data: undefined,
        },
      });
      sent = true;
    } catch (err: any) {
      logger.debug(`Failed to queue inventory_transaction drop: ${err?.message}`);
    }

    // 3. Tertiary: item_stack_request drop (Modern Bedrock 1.16+ ItemStackRequest system)
    try {
      client.queue('item_stack_request', {
        requests: [
          {
            request_id: -(Date.now() % 1000000),
            actions: [
              {
                type_id: 'drop',
                count: heldItem?.count || 1,
                source: {
                  slot_type: { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined },
                  slot: hotbarSlot,
                  stack_id: heldItem?.has_stack_id ? (heldItem.stack_id || 0) : 0,
                },
                randomly: false,
              },
            ],
            custom_names: [],
            cause: 'chat_public',
          },
        ],
      });
      sent = true;
    } catch (err: any) {
      logger.debug(`Failed to queue item_stack_request drop: ${err?.message}`);
    }

    logger.info(`Threw item from hotbar slot ${hotbarSlot} (${formattedItem.count}x network_id: ${formattedItem.network_id}).`, this.accountId);
    return sent;
  }

  /**
   * Throw entire inventory — all hotbar and main inventory slots.
   * Staggered over short intervals to avoid packet floods or anti-cheat rate-limits.
   */
  public throwAll(): boolean {
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    if (!client || runtimeId == null) return false;

    const inv = this.getInventory ? this.getInventory() : null;
    const emptyItem = { network_id: 0 };

    // Collect all slots to drop (0..8 hotbar, 9..35 main inventory)
    const slotsToDrop: { slot: number; isHotbar: boolean; item?: any }[] = [];

    // Always scan hotbar slots 0..8
    for (let slot = 0; slot < 9; slot++) {
      const it = (Array.isArray(inv) && inv[slot]) ? inv[slot] : null;
      slotsToDrop.push({ slot, isHotbar: true, item: it });
    }

    // Also scan remaining main inventory slots 9..35
    if (Array.isArray(inv) && inv.length > 9) {
      for (let slot = 9; slot < inv.length; slot++) {
        const it = inv[slot];
        if (ActionController.hasValidItem(it)) {
          slotsToDrop.push({ slot, isHotbar: false, item: it });
        }
      }
    }

    // Stagger drops across short intervals (40ms apart)
    slotsToDrop.forEach((entry, index) => {
      setTimeout(() => {
        if (!this.getClient()) return;
        const s = entry.slot;
        const currentInv = this.getInventory ? this.getInventory() : [];
        const item = entry.item || (Array.isArray(currentInv) ? currentInv[s] : null);

        const formattedItem = {
          network_id: typeof item?.network_id === 'number' ? item.network_id : (typeof item?.id === 'number' ? item.id : 0),
          count: item?.count || 1,
          metadata: item?.metadata || 0,
          has_stack_id: item?.has_stack_id ? 1 : 0,
          block_runtime_id: item?.block_runtime_id || 0,
          extra: item?.extra || { has_nbt: 0, can_place_on: [], can_destroy: [] },
        };

        if (entry.isHotbar) {
          // 1. Select hotbar slot
          try {
            client.queue('player_hotbar', {
              selected_slot: s,
              window_id: 'inventory',
              select_slot: true,
            });
          } catch {}

          // 2. Drop via player_action
          try {
            client.queue('player_action', {
              runtime_entity_id: runtimeId,
              action: 'drop_item',
              position: { x: 0, y: 0, z: 0 },
              result_position: { x: 0, y: 0, z: 0 },
              face: 0,
            });
          } catch {}
        }

        // 3. Drop via inventory_transaction normal (container -> world)
        try {
          client.queue('inventory_transaction', {
            transaction: {
              legacy: { legacy_request_id: 0, legacy_set_item_slots: [] },
              transaction_type: 'normal',
              actions: [
                {
                  source_type: 'container',
                  inventory_id: 'inventory',
                  slot: s,
                  old_item: formattedItem,
                  new_item: emptyItem,
                },
                {
                  source_type: 'world_interaction',
                  flags: 0,
                  slot: 0,
                  old_item: emptyItem,
                  new_item: formattedItem,
                },
              ],
              transaction_data: undefined,
            },
          });
        } catch {}

        // 4. Drop via item_stack_request
        try {
          client.queue('item_stack_request', {
            requests: [
              {
                request_id: -(Date.now() % 1000000) - index,
                actions: [
                  {
                    type_id: 'drop',
                    count: item?.count || 1,
                    source: {
                      slot_type: { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined },
                      slot: s,
                      stack_id: item?.has_stack_id ? (item.stack_id || 0) : 0,
                    },
                    randomly: false,
                  },
                ],
                custom_names: [],
                cause: 'chat_public',
              },
            ],
          });
        } catch {}
      }, index * 40);
    });

    logger.info(`Throw All: initiated staggered item drops across ${slotsToDrop.length} inventory slots.`, this.accountId);
    return true;
  }

  public moveForward(distanceBlocks: number): void {
    const engine = this.getKeepAliveEngine();
    if (!engine) {
      logger.debug('Move action failed: KeepAliveEngine not active', this.accountId);
      return;
    }
    const clamped = Math.max(0, Math.min(1, distanceBlocks || 0));
    if (clamped <= 0) return;

    engine.moveForward(clamped, 8);
    logger.info(`Moving forward ${clamped} block(s) in current look direction (Yaw: ${Math.round(engine.yaw)}°)`, this.accountId);
  }

  /**
   * Adjust bot look direction (up, down, left, right) smoothly
   */
  public look(direction: 'up' | 'down' | 'left' | 'right', degrees: number = 15): void {
    const engine = this.getKeepAliveEngine();
    if (!engine) {
      logger.debug('Look action failed: KeepAliveEngine not active', this.accountId);
      return;
    }

    let dPitch = 0;
    let dYaw = 0;

    switch (direction) {
      case 'up':
        dPitch = -degrees; // In Minecraft pitch, negative is UP
        break;
      case 'down':
        dPitch = degrees;  // Positive is DOWN
        break;
      case 'left':
        dYaw = -degrees;   // Negative yaw rotates counter-clockwise (LEFT)
        break;
      case 'right':
        dYaw = degrees;    // Positive yaw rotates clockwise (RIGHT)
        break;
    }

    engine.smoothLook(dPitch, dYaw, 5, 20);
    logger.info(`Look adjusted ${direction.toUpperCase()} by ${degrees}° (Pitch: ${Math.round(engine.pitch)}°, Yaw: ${Math.round(engine.yaw)}°)`, this.accountId);
  }

  /**
   * Toggle Left Click (Attack / Swing Arm)
   */
  public toggleLeftClick(enabled?: boolean): boolean {
    const targetState = enabled !== undefined ? enabled : !this.isLeftClicking;
    this.isLeftClicking = targetState;

    if (this.isLeftClicking) {
      this.executeSingleLeftClick();
    }

    logger.info(`Left-click action triggered (isLeftClicking: ${this.isLeftClicking})`, this.accountId);
    return this.isLeftClicking;
  }

  public executeSingleLeftClick(): void {
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    const engine = this.getKeepAliveEngine();

    if (engine) {
      engine.queueSwing();
    }

    if (!client || runtimeId == null) return;

    try {
      // 1. Swing arm animation
      client.queue('animate', {
        action_id: 'swing_arm',
        runtime_entity_id: runtimeId,
      });

      // 2. Send player_action missed_swing
      client.queue('player_action', {
        runtime_entity_id: runtimeId,
        action: 'missed_swing',
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0,
      });

      // 3. If there's an entity attack hook, trigger it
      if (this.attackNearbyCallback) {
        this.attackNearbyCallback();
      }
    } catch (err) {
      logger.debug('Failed to send left click swing packets', this.accountId);
    }
  }

  /**
   * Toggle Spam Left Click with configurable randomized delay between minDelay and maxDelay
   */
  public toggleSpamClick(enabled?: boolean, minDelay?: number, maxDelay?: number): boolean {
    if (minDelay !== undefined && !isNaN(minDelay) && minDelay >= 10) {
      this.spamMinDelay = Math.floor(minDelay);
    }
    if (maxDelay !== undefined && !isNaN(maxDelay) && maxDelay >= this.spamMinDelay) {
      this.spamMaxDelay = Math.floor(maxDelay);
    }

    const targetState = enabled !== undefined ? enabled : !this.isSpamClicking;
    this.isSpamClicking = targetState;

    if (this.spamClickTimeout) {
      clearTimeout(this.spamClickTimeout);
      this.spamClickTimeout = null;
    }

    if (this.isSpamClicking) {
      logger.info(`Spam Left Click STARTED (Delay: ${this.spamMinDelay}ms - ${this.spamMaxDelay}ms)`, this.accountId);
      this.runSpamClickLoop();
    } else {
      logger.info('Spam Left Click STOPPED', this.accountId);
    }

    return this.isSpamClicking;
  }

  private runSpamClickLoop(): void {
    if (!this.isSpamClicking) return;

    this.executeSingleLeftClick();

    // Randomize delay between spamMinDelay and spamMaxDelay
    const min = Math.min(this.spamMinDelay, this.spamMaxDelay);
    const max = Math.max(this.spamMinDelay, this.spamMaxDelay);
    const randomDelay = Math.floor(Math.random() * (max - min + 1)) + min;

    this.spamClickTimeout = setTimeout(() => {
      this.runSpamClickLoop();
    }, randomDelay);
  }

  /**
   * Stop all active loops and reset state (e.g. on disconnect or reset)
   */
  public stopAll(): void {
    if (this.jumpInterval) {
      clearInterval(this.jumpInterval);
      this.jumpInterval = null;
    }
    if (this.rightClickInterval) {
      clearInterval(this.rightClickInterval);
      this.rightClickInterval = null;
    }
    if (this.spamClickTimeout) {
      clearTimeout(this.spamClickTimeout);
      this.spamClickTimeout = null;
    }

    const engine = this.getKeepAliveEngine();
    if (engine) {
      engine.clearInputFlags();
    }

    this.isCrouching = false;
    this.isJumping = false;
    this.isLeftClicking = false;
    this.isRightClicking = false;
    this.isSpamClicking = false;
  }
}
