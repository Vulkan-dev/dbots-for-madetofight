import { Client } from 'bedrock-protocol';
import { logger } from '../utils/logger';
import { KeepAliveEngine, Vector3D } from '../network/KeepAliveEngine';
import { PersistentActionStorage } from '../storage/PersistentActionStorage';

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
  public persistentCrouch: boolean = false;
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

    // Restore persistent crouch stance from storage if previously enabled
    if (this.accountId) {
      this.persistentCrouch = PersistentActionStorage.isCrouched(this.accountId);
      this.isCrouching = this.persistentCrouch;
    }
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
   * Toggle Crouch (Sneak) with synchronized Geyser InputCache transition states.
   * Stays persistently active across deaths, TPAs, and world changes until explicitly toggled off.
   */
  public toggleCrouch(enabled?: boolean | string): boolean {
    const boolState = typeof enabled === 'string' ? enabled === 'true' : (typeof enabled === 'boolean' ? enabled : undefined);
    const targetState = boolState !== undefined ? boolState : !this.persistentCrouch;
    if (boolState !== undefined && this.persistentCrouch === targetState && this.isCrouching === targetState) {
      return this.persistentCrouch;
    }
    this.persistentCrouch = targetState;
    this.isCrouching = targetState;
    PersistentActionStorage.setCrouch(this.accountId, targetState);

    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    const engine = this.getKeepAliveEngine();
    const pos = this.getPosition ? this.getPosition() : { x: 0, y: 0, z: 0 };
    const blockPos = {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
    };

    // 1. Send Geyser/Bedrock 20Hz InputEngine sneak transition
    if (engine) {
      engine.setSneak(this.persistentCrouch, this.persistentCrouch);
    }

    // 2. Also send player_action start_sneak/stop_sneak for vanilla BDS compatibility
    if (client) {
      try {
        const entityId = (runtimeId != null && runtimeId !== 0n && runtimeId !== '0') ? BigInt(runtimeId) : 1n;
        client.queue('player_action', {
          runtime_entity_id: entityId,
          action: this.persistentCrouch ? 'start_sneak' : 'stop_sneak',
          position: blockPos,
          result_position: blockPos,
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
          sneaking: this.persistentCrouch,
        });
      } catch (err) {
        logger.debug('Failed to send sneak player_input packet', this.accountId);
      }
    }

    logger.info(`Crouch toggle: ${this.persistentCrouch ? 'ON' : 'OFF'} (locked: ${this.persistentCrouch})`, this.accountId);
    return this.persistentCrouch;
  }

  /**
   * Reasserts persistent crouch stance following death, respawn, or teleport.
   */
  public reassertPersistentStates(): void {
    if (!this.persistentCrouch) return;
    this.isCrouching = true;
    const engine = this.getKeepAliveEngine();
    if (engine) {
      engine.setSneak(true, true);
    }
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    const pos = this.getPosition ? this.getPosition() : { x: 0, y: 0, z: 0 };
    const blockPos = {
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
    };
    if (client && runtimeId != null && runtimeId !== 0n && runtimeId !== '0') {
      try {
        const entityId = BigInt(runtimeId);
        client.queue('player_action', {
          runtime_entity_id: entityId,
          action: 'start_sneak',
          position: blockPos,
          result_position: blockPos,
          face: 0,
        });
        client.queue('player_input', {
          motion_x: 0,
          motion_z: 0,
          jumping: false,
          sneaking: true,
        });
      } catch {}
    }
  }

  /**
   * One-shot jump action.
   * Smoothly synchronized with KeepAliveEngine jump physics.
   */
  public jump(): boolean {
    const engine = this.getKeepAliveEngine();
    if (engine) {
      engine.triggerJump();
      logger.info(`Jump executed`, this.accountId);
      return true;
    }
    logger.warn(`Jump failed: KeepAliveEngine not available`, this.accountId);
    return false;
  }

  /**
   * Toggle Continuous Jump.
   * Default OFF; smoothly synchronized with KeepAliveEngine jump physics.
   */
  public toggleJump(enabled?: boolean | string): boolean {
    const boolState = typeof enabled === 'string' ? enabled === 'true' : (typeof enabled === 'boolean' ? enabled : undefined);
    const targetState = boolState !== undefined ? boolState : !this.isJumping;
    if (this.isJumping === targetState) {
      return this.isJumping;
    }
    this.isJumping = targetState;

    const engine = this.getKeepAliveEngine();
    if (engine) {
      engine.setJump(this.isJumping);
      if (this.isJumping) {
        engine.triggerJump();
      }
    }

    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    if (client && runtimeId != null && this.isJumping) {
      try {
        const entityId = (runtimeId !== 0n && runtimeId !== '0') ? BigInt(runtimeId) : 1n;
        client.queue('player_action', {
          runtime_entity_id: entityId,
          action: 'jump',
          position: { x: 0, y: 0, z: 0 },
          result_position: { x: 0, y: 0, z: 0 },
          face: 0,
        });
      } catch {}
    }

    logger.info(`Jump toggle: ${this.isJumping ? 'ON' : 'OFF'}`, this.accountId);
    return this.isJumping;
  }

  /**
   * Toggle Right Click (Continuous Item Use / Block Placing / Air Use)
   */
  public toggleRightClick(enabled?: boolean): boolean {
    const targetState = enabled !== undefined ? enabled : !this.isRightClicking;
    if (this.isRightClicking === targetState) {
      return this.isRightClicking;
    }
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
   * Throw the item currently held in hand.
   * Sends vanilla player_action drop_item (always works on all Bedrock servers),
   * plus ItemStackRequest and inventory_transaction normal drops for full stack clearing.
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

    // 1. Primary: ALWAYS queue player_action drop_item (standard vanilla Bedrock Q drop)
    try {
      client.queue('player_action', {
        runtime_entity_id: runtimeId,
        action: 'drop_item',
        position: { x: 0, y: 0, z: 0 },
        result_position: { x: 0, y: 0, z: 0 },
        face: 0,
      });
    } catch (err: any) {
      logger.debug(`Failed to queue player_action drop: ${err?.message}`);
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

    // 2. Secondary: item_stack_request drop (Modern Bedrock 1.16+ ItemStackRequest system)
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
    } catch (err: any) {
      logger.debug(`Failed to queue item_stack_request drop: ${err?.message}`);
    }

    // 3. Tertiary: inventory_transaction normal drop (container -> world_interaction, Geyser / Paper compatible)
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
    } catch (err: any) {
      logger.debug(`Failed to queue inventory_transaction drop: ${err?.message}`);
    }

    logger.info(`Threw item from hotbar slot ${hotbarSlot}.`, this.accountId);
    return true;
  }

  /**
   * Throw entire inventory — all hotbar (0..8) and main inventory (9..35) slots.
   * Automatically cycles through all 36 slots, issuing player_action drop_item,
   * ItemStackRequest drops, and normal inventory transaction drops staggered over short intervals.
   */
  public throwAll(): boolean {
    const client = this.getClient();
    const runtimeId = this.getRuntimeEntityId();
    if (!client || runtimeId == null) return false;

    const inv = this.getInventory ? this.getInventory() : [];
    const emptyItem = { network_id: 0 };

    // Scan all 36 inventory slots (0..8 hotbar, 9..35 main inventory)
    const totalSlots = 36;
    for (let slot = 0; slot < totalSlots; slot++) {
      setTimeout(() => {
        if (!this.getClient()) return;
        const currentInv = this.getInventory ? this.getInventory() : [];
        const item = Array.isArray(currentInv) ? currentInv[slot] : null;

        const formattedItem = {
          network_id: typeof item?.network_id === 'number' ? item.network_id : (typeof item?.id === 'number' ? item.id : 0),
          count: item?.count || 1,
          metadata: item?.metadata || 0,
          has_stack_id: item?.has_stack_id ? 1 : 0,
          block_runtime_id: item?.block_runtime_id || 0,
          extra: item?.extra || { has_nbt: 0, can_place_on: [], can_destroy: [] },
        };

        // If hotbar slot (0..8), switch to slot, update mob_equipment, and issue player_action drop_item
        if (slot < 9) {
          try {
            client.queue('player_hotbar', {
              selected_slot: slot,
              window_id: 'inventory',
              select_slot: true,
            });
            client.queue('mob_equipment', {
              runtime_entity_id: runtimeId,
              item: formattedItem,
              slot: slot,
              selected_slot: slot,
              window_id: 0,
            });
            client.queue('player_action', {
              runtime_entity_id: runtimeId,
              action: 'drop_item',
              position: { x: 0, y: 0, z: 0 },
              result_position: { x: 0, y: 0, z: 0 },
              face: 0,
            });
          } catch {}
        }

        // Drop via item_stack_request (full count stack drop)
        try {
          client.queue('item_stack_request', {
            requests: [
              {
                request_id: -(Date.now() % 1000000) - slot,
                actions: [
                  {
                    type_id: 'drop',
                    count: item?.count || 64,
                    source: {
                      slot_type: { container_id: 'hotbar_and_inventory', dynamic_container_id: undefined },
                      slot: slot,
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

        // Drop via inventory_transaction normal (container -> world)
        try {
          client.queue('inventory_transaction', {
            transaction: {
              legacy: { legacy_request_id: 0, legacy_set_item_slots: [] },
              transaction_type: 'normal',
              actions: [
                {
                  source_type: 'container',
                  inventory_id: 'inventory',
                  slot: slot,
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
      }, slot * 40);
    }

    logger.info(`Throw All: initiated staggered inventory drop across all 36 slots.`, this.accountId);
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
    if (this.isLeftClicking === targetState) {
      return this.isLeftClicking;
    }
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
    if (this.isSpamClicking === targetState && this.spamClickTimeout) {
      return this.isSpamClicking;
    }
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
      engine.setSneak(false, false);
      engine.setJump(false);
    }

    this.isJumping = false;
    this.isLeftClicking = false;
    this.isRightClicking = false;
    this.isSpamClicking = false;
    this.isCrouching = false;
    this.persistentCrouch = false;
    if (this.accountId) {
      PersistentActionStorage.setCrouch(this.accountId, false);
    }
  }

  /**
   * Reset transient actions and physics engine inputs to safe defaults.
   * Preserves persistent crouch toggle across deaths, respawns, and teleports.
   */
  public resetAllStates(): void {
    // Stop transient physics actions
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
      engine.setSneak(this.persistentCrouch, this.persistentCrouch);
      engine.setJump(false);
    }

    this.isJumping = false;
    this.isLeftClicking = false;
    this.isRightClicking = false;
    this.isSpamClicking = false;
    this.isCrouching = this.persistentCrouch;

    if (this.persistentCrouch) {
      this.reassertPersistentStates();
    } else {
      const client = this.getClient();
      const runtimeId = this.getRuntimeEntityId();
      if (client) {
        try {
          const entityId = (runtimeId != null && runtimeId !== 0n && runtimeId !== '0') ? BigInt(runtimeId) : 1n;
          const pos = this.getPosition ? this.getPosition() : { x: 0, y: 0, z: 0 };
          const blockPos = {
            x: Math.floor(pos.x),
            y: Math.floor(pos.y),
            z: Math.floor(pos.z),
          };
          client.queue('player_action', {
            runtime_entity_id: entityId,
            action: 'stop_sneak',
            position: blockPos,
            result_position: blockPos,
            face: 0,
          });
          client.queue('player_input', {
            motion_x: 0,
            motion_z: 0,
            jumping: false,
            sneaking: false,
          });
        } catch {}
      }
    }
  }
}
