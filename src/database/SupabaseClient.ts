import * as Db from './DatabaseClient';

export function getSupabaseClient(): any {
  return Db.getDbPool();
}

export async function initSupabaseSchema(): Promise<void> {
  return Db.initDatabaseSchema();
}

export const registerNode = Db.registerNode;
export const heartbeatNode = Db.heartbeatNode;
export const markNodeOffline = Db.markNodeOffline;
export const getAllNodes = Db.getAllNodes;

export const getAccountsForNode = Db.getAccountsForNode;
export const getAllAccounts = Db.getAllAccounts;
export const getAccountById = Db.getAccountById;
export const upsertAccount = Db.upsertAccount;
export const updateAccountFields = Db.updateAccountFields;
export const setAccountGroup = Db.setAccountGroup;
export const renameAccountGroup = Db.renameAccountGroup;
export const ungroupAccounts = Db.ungroupAccounts;
export const deleteAccount = Db.deleteAccount;

export const saveAuthToken = Db.saveAuthToken;
export const loadAuthToken = Db.loadAuthToken;
export const deleteAuthToken = Db.deleteAuthToken;
export const transferAuthToken = Db.transferAuthToken;

export const getPendingCommands = Db.getPendingCommands;
export const markCommandDone = Db.markCommandDone;
export const insertCommand = Db.insertCommand;

export const getNodeSettings = Db.getNodeSettings;
export const upsertNodeSettings = Db.upsertNodeSettings;

export const getPermissions = Db.getPermissions;
export const addPermission = Db.addPermission;
export const removePermission = Db.removePermission;

export const getIgnoreList = Db.getIgnoreList;
export const addToIgnoreList = Db.addToIgnoreList;
export const removeFromIgnoreList = Db.removeFromIgnoreList;

export const getRegisteredNodeCategories = Db.getRegisteredNodeCategories;
export const exportAllBackupData = Db.exportAllBackupData;
export const importAllBackupData = Db.importAllBackupData;

export const getSecondarySupabaseClient = Db.getSecondarySupabaseClient;
export const getLastSecondarySyncStatus = Db.getLastSecondarySyncStatus;
export const syncToSecondarySupabase = Db.syncToSecondarySupabase;
export const loadFromSecondarySupabase = Db.loadFromSecondarySupabase;
export const clearDatabaseTables = Db.clearDatabaseTables;
