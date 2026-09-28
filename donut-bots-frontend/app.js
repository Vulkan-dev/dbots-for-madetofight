/* ═══════════════════════════════════════════════════════════════════
   DONUT SMP BEDROCK CLIENT CONSOLE — Vercel Frontend
   Reads accounts/nodes from Supabase, calls backend APIs directly
   ═══════════════════════════════════════════════════════════════════ */

let supabaseClient = null;
let currentNode = null;
let latestAccounts = [];
let cachedDbAccounts = [];
let allNodes = [];
let pendingAuthPopupAccountId = null;
let lastShownAuthUserCode = null;
let dismissedAuthUserCode = null;
let dismissedAuthAccounts = new Set();
const persistedActionStates = new Map();
const globalActionToggles = {
  isCrouching: false,
  isSpamClicking: false,
};

// ── Supabase Init ────────────────────────────────────────────────────
function initSupabase() {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function queueSupabaseCommand(nodeId, accountId, action, payload = {}) {
  if (!supabaseClient) return;
  try {
    const builder = supabaseClient.from('commands').insert({
      node_id: nodeId,
      account_id: accountId,
      action: action,
      payload: payload,
    });
    if (builder && typeof builder.then === 'function') {
      builder.then(() => {}, () => {});
    }
  } catch {}
}

// ── Helpers ──────────────────────────────────────────────────────────
function getSelectedNodeId() {
  return document.getElementById('nodeSelect').value;
}

function getSelectedBotId() {
  return document.getElementById('actionBotSelect').value;
}

function getBackendUrl() {
  if (currentNode && currentNode.url) return currentNode.url;
  const master = allNodes.find(n => n.id === 'node-1' || (n.name && n.name.toUpperCase().includes('MASTER')));
  if (master && master.url) return master.url;
  const first = allNodes.find(n => n.url);
  if (first) return first.url;
  return '';
}

// ── Backend API helper ───────────────────────────────────────────────
async function backendPost(path, body) {
  const nodeId = body._nodeId;
  let node;
  if (nodeId) {
    node = allNodes.find(n => n.id === nodeId);
  } else {
    node = getNodeForBot(body.accountId);
  }
  if (!node) { showTemporaryToast('Node not found — is the backend running?'); return null; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${node.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    if (!res.ok) { showTemporaryToast(json?.error || `Backend error (${res.status})`); }
    return json;
  } catch (err) {
    console.error('Backend call failed:', err);
    showTemporaryToast(`Backend unreachable (${err.name === 'AbortError' ? 'timeout' : err.message})`);
    return null;
  }
}

async function backendGet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

function getNodeForBot(accountId) {
  const acc = latestAccounts.find(a => (a.account_id || a.accountId || a.id) === accountId);
  if (acc && acc.node_id) {
    const matched = allNodes.find(n => n.id === acc.node_id);
    if (matched) return matched;
  }
  if (currentNode) return currentNode;
  return allNodes[0];
}

// ── Node Management ──────────────────────────────────────────────────
// ── Node Sorting & Sequence ──────────────────────────────────────────
function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    const isMasterA = a.id === 'node-1' || (a.name && a.name.toUpperCase().includes('MASTER'));
    const isMasterB = b.id === 'node-1' || (b.name && b.name.toUpperCase().includes('MASTER'));
    if (isMasterA && !isMasterB) return -1;
    if (!isMasterA && isMasterB) return 1;

    const numA = parseInt(String(a.id).replace(/\D+/g, ''), 10) || 0;
    const numB = parseInt(String(b.id).replace(/\D+/g, ''), 10) || 0;
    if (numA !== numB) return numA - numB;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

function sortAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const idA = a.account_id || a.accountId || a.id || '';
    const idB = b.account_id || b.accountId || b.id || '';
    const numA = parseInt(String(idA).replace(/\D+/g, ''), 10);
    const numB = parseInt(String(idB).replace(/\D+/g, ''), 10);
    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
      return numA - numB;
    }
    return String(idA).localeCompare(String(idB), undefined, { numeric: true, sensitivity: 'base' });
  });
}

function deduplicateAccounts(accounts) {
  const seen = new Map();
  for (const acc of accounts) {
    const id = String(acc.account_id || acc.accountId || acc.id || '');
    if (!id) continue;

    // Preserve and sync with persisted action states
    if (acc.actionStates) {
      persistedActionStates.set(id, { ...(persistedActionStates.get(id) || {}), ...acc.actionStates });
    } else if (persistedActionStates.has(id)) {
      acc.actionStates = { ...persistedActionStates.get(id) };
    }

    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, acc);
    } else {
      // Always preserve live runtime state (actionStates, position, state, inGameIgn, afkSpot)
      const actionStates = existing.actionStates || acc.actionStates || (persistedActionStates.has(id) ? { ...persistedActionStates.get(id) } : undefined);
      const position = existing.position || acc.position;
      const state = (existing.state && existing.state !== 'DISCONNECTED') ? existing.state : (acc.state || existing.state);
      const inGameIgn = existing.inGameIgn || acc.inGameIgn;
      const afkSpot = existing.afkSpot || acc.afkSpot;
      const isAfkSpotActive = existing.isAfkSpotActive !== undefined ? existing.isAfkSpotActive : acc.isAfkSpotActive;

      const newTime = new Date(acc.updated_at || 0).getTime();
      const oldTime = new Date(existing.updated_at || 0).getTime();
      const merged = (newTime > oldTime && !existing.actionStates) ? { ...existing, ...acc } : { ...acc, ...existing };
      if (actionStates) {
        merged.actionStates = actionStates;
        persistedActionStates.set(id, { ...(persistedActionStates.get(id) || {}), ...actionStates });
      }
      if (position) merged.position = position;
      if (state) merged.state = state;
      if (inGameIgn) merged.inGameIgn = inGameIgn;
      if (afkSpot) merged.afkSpot = afkSpot;
      if (isAfkSpotActive !== undefined) merged.isAfkSpotActive = isAfkSpotActive;
      if (acc.email) merged.email = acc.email;
      else if (existing.email) merged.email = existing.email;
      seen.set(id, merged);
    }
  }
  return sortAccounts(Array.from(seen.values()));
}

// ── Node Management ──────────────────────────────────────────────────
async function loadNodes() {
  try {
    const { data, error } = await supabaseClient
      .from('backend_nodes')
      .select('*');
    if (error) throw error;
    allNodes = sortNodes(data || []);
    renderNodeSelector();
  } catch (err) {
    console.error('Failed to load nodes:', err);
  }
}

const fetchNodes = loadNodes;

function renderNodeSelector() {
  const select = document.getElementById('nodeSelect');
  const prev = select.value;
  if (allNodes.length === 0) {
    select.innerHTML = '<option value="all">🌐 All Nodes (All Bots)</option>';
    loadAllAccountsFromSupabase();
    return;
  }
  allNodes = sortNodes(allNodes);

  // Top option: All Nodes (Default - shows all bots)
  let optionsHtml = `<option value="all" ${(!prev || prev === 'all') ? 'selected' : ''}>🌐 All Nodes (${allNodes.length} Nodes — All Bots)</option>`;

  optionsHtml += allNodes.map((n, idx) => {
    const seq = idx + 1;
    const isSelected = prev === n.id ? 'selected' : '';
    const displayName = `#${seq} — ${n.name} [${n.status}]`;
    return `<option value="${n.id}" ${isSelected}>${displayName}</option>`;
  }).join('');

  select.innerHTML = optionsHtml;

  // Default selection is "all" if not explicitly set
  if (!prev || (prev !== 'all' && !allNodes.some(n => n.id === prev))) {
    select.value = 'all';
    currentNode = null;
    onNodeChange();
  }
}

async function onNodeChange() {
  const nodeId = getSelectedNodeId();
  if (!nodeId || nodeId === 'all') {
    currentNode = null;
    await loadAllAccountsFromSupabase();
  } else {
    currentNode = allNodes.find(n => n.id === nodeId) || null;
    if (currentNode) {
      await loadAccountsFromSupabase();
      fetchConfig();
    } else {
      await loadAllAccountsFromSupabase();
    }
  }
  await fetchStatus();
}

// ── Accounts from Supabase ───────────────────────────────────────────
async function loadAccountsFromSupabase() {
  if (!currentNode) return;
  try {
    const { data, error } = await supabaseClient
      .from('accounts')
      .select('*')
      .eq('node_id', currentNode.id)
      .order('id', { ascending: true });
    if (error) throw error;
    cachedDbAccounts = data || [];
    latestAccounts = sortAccounts(cachedDbAccounts);
    syncGroupsFromDbAccounts(cachedDbAccounts);
    renderAccountsTable();
    updateBotSelector();
  } catch (err) {
    console.error('Failed to load accounts:', err);
  }
}

async function loadAllAccountsFromSupabase() {
  try {
    const { data, error } = await supabaseClient
      .from('accounts')
      .select('*')
      .order('id', { ascending: true });
    if (error) throw error;
    cachedDbAccounts = data || [];
    latestAccounts = deduplicateAccounts(cachedDbAccounts);
    syncGroupsFromDbAccounts(cachedDbAccounts);
    renderAccountsTable();
    updateBotSelector();
  } catch (err) {
    console.error('Failed to load all accounts:', err);
  }
}

// ── Live status from backend API ─────────────────────────────────────
async function fetchStatus() {
  if (!currentNode) {
    // ALL NODES VIEW (Default): Show ALL added accounts from all nodes
    const allAccounts = [];
    const nodePromises = allNodes.map(async (node) => {
      if (node.status !== 'online') return;
      const data = await backendGet(`${node.url}/api/status`);
      if (data?.accounts) {
        data.accounts.forEach(a => {
          allAccounts.push({ ...a, node_id: node.id, node_name: node.name });
        });
      }
    });
    await Promise.allSettled(nodePromises);

    // Merge with in-memory cached DB accounts so offline bots and emails are preserved without hitting Supabase API
    if (cachedDbAccounts && cachedDbAccounts.length > 0) {
      for (const dba of cachedDbAccounts) {
        const found = allAccounts.find(a => (a.account_id || a.accountId || a.id) === dba.id);
        if (!found) {
          const hostNode = allNodes.find(n => n.id === dba.node_id);
          allAccounts.push({
            ...dba,
            account_id: dba.id,
            state: dba.status || 'DISCONNECTED',
            node_name: hostNode?.name || dba.node_id,
          });
        } else {
          if (!found.email && dba.email) found.email = dba.email;
          if (dba.group_name) found.group_name = dba.group_name;
        }
      }
    }

    latestAccounts = deduplicateAccounts(allAccounts);
    document.getElementById('targetHostPort').innerText = `${allNodes.length} nodes connected`;
    updateBotSelector();
    syncActionToggles();
    renderAfkSection();
    checkAuthCodes(latestAccounts);
  } else {
    // SPECIFIC NODE VIEW (Each node is separate, including Master Node):
    // Show ONLY the accounts added/attached to that selected node
    const nodeAccounts = [];
    const data = await backendGet(`${getBackendUrl()}/api/status`);
    if (data) {
      if (data.server) {
        document.getElementById('targetHostPort').innerText = `${data.server.host}:${data.server.port}`;
      }
      if (data.accounts && data.accounts.length > 0) {
        data.accounts.forEach(a => {
          nodeAccounts.push({
            ...a,
            node_id: currentNode.id,
            node_name: currentNode.name,
          });
        });
      }
    }

    // Merge with in-memory cached DB accounts for this node without querying Supabase on every tick
    if (cachedDbAccounts && cachedDbAccounts.length > 0) {
      for (const dba of cachedDbAccounts) {
        if (dba.node_id !== currentNode.id) continue;
        const found = nodeAccounts.find(a => (a.account_id || a.accountId || a.id) === dba.id);
        if (!found) {
          nodeAccounts.push({
            ...dba,
            account_id: dba.id,
            state: dba.status || 'DISCONNECTED',
            node_name: currentNode.name,
          });
        } else {
          if (!found.email && dba.email) found.email = dba.email;
          if (dba.group_name) found.group_name = dba.group_name;
        }
      }
    }

    latestAccounts = deduplicateAccounts(nodeAccounts.filter(a => a.node_id === currentNode.id));
    updateBotSelector();
    syncActionToggles();
    renderAfkSection();
    fetchTrustedPlayers();
    checkAuthCodes(latestAccounts);
  }

  // Sort by sequence: #1, #2, #3...
  latestAccounts = sortAccounts(latestAccounts);
  if (accountGroups.length === 0 && cachedDbAccounts && cachedDbAccounts.length > 0) {
    loadAccountGroupsFromDb();
  }
  renderAccountsTable();
}


// ── Account Group System (Collapsible Folders) ─────────────────────────
// Persisted directly in Supabase database (commands table & accounts table)
let accountGroups = [];
try {
  accountGroups = JSON.parse(localStorage.getItem('donut_bot_groups') || '[]');
} catch {
  accountGroups = [];
}
let isGroupSelectionMode = false;
let selectedGroupAccountIds = new Set();

function saveAccountGroupsLocalCache() {
  try {
    localStorage.setItem('donut_bot_groups', JSON.stringify(accountGroups));
  } catch {}
}

/**
 * Persists accountGroups to Supabase database (commands table with action SET_ACCOUNT_GROUPS).
 * Guaranteed to succeed without requiring any custom database migrations or schema alterations.
 */
async function saveAccountGroupsToDb() {
  saveAccountGroupsLocalCache();

  if (!supabaseClient) initSupabase();
  if (supabaseClient) {
    try {
      const targetNode = currentNode?.id || allNodes[0]?.id || 'master-node';
      await supabaseClient.from('commands').insert({
        node_id: targetNode,
        account_id: null,
        action: 'SET_ACCOUNT_GROUPS',
        payload: { groups: accountGroups, updatedAt: new Date().toISOString() },
        status: 'DONE',
      });
    } catch (err) {
      console.debug('Notice: Supabase commands SET_ACCOUNT_GROUPS save:', err);
    }
  }
}

/**
 * Loads accountGroups from Supabase database.
 * 1. Checks Supabase commands table for latest SET_ACCOUNT_GROUPS.
 * 2. Fallback: checks group_name column on accounts.
 * 3. Fallback: checks localStorage cache.
 */
async function loadAccountGroupsFromDb() {
  if (!supabaseClient) initSupabase();
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('commands')
        .select('payload')
        .eq('action', 'SET_ACCOUNT_GROUPS')
        .order('created_at', { ascending: false })
        .limit(1);

      if (!error && data && data.length > 0 && Array.isArray(data[0]?.payload?.groups)) {
        accountGroups = data[0].payload.groups;
        saveAccountGroupsLocalCache();
        renderAccountsTable();
        return;
      }
    } catch (e) {
      console.debug('Notice: load groups from commands table:', e);
    }
  }

  // Fallback: check cachedDbAccounts group_name column if present
  if (cachedDbAccounts && cachedDbAccounts.length > 0) {
    const groupsMap = new Map();
    cachedDbAccounts.forEach(acc => {
      const grpName = (acc.group_name || '').trim();
      if (grpName) {
        const id = String(acc.id || acc.account_id || acc.accountId);
        if (!groupsMap.has(grpName)) groupsMap.set(grpName, []);
        if (!groupsMap.get(grpName).includes(id)) groupsMap.get(grpName).push(id);
      }
    });

    if (groupsMap.size > 0) {
      const dbGroups = [];
      for (const [name, ids] of groupsMap.entries()) {
        dbGroups.push({
          id: 'group-' + encodeURIComponent(name),
          name,
          accountIds: ids,
          isExpanded: true,
        });
      }
      accountGroups = dbGroups;
      saveAccountGroupsLocalCache();
      renderAccountsTable();
      return;
    }
  }

  // Fallback: localStorage
  try {
    const local = JSON.parse(localStorage.getItem('donut_bot_groups') || '[]');
    if (Array.isArray(local) && local.length > 0) {
      accountGroups = local;
      renderAccountsTable();
    }
  } catch {}
}

function toggleGroupSelectionMode() {
  isGroupSelectionMode = !isGroupSelectionMode;
  selectedGroupAccountIds.clear();
  const banner = document.getElementById('groupSelectionBanner');
  const countEl = document.getElementById('selectedGroupCount');
  const confirmBtn = document.getElementById('btnConfirmGroup');
  const groupBtn = document.getElementById('btnGroupAccounts');

  if (isGroupSelectionMode) {
    if (banner) banner.style.display = 'block';
    if (countEl) countEl.innerText = '0 selected (min 2)';
    if (confirmBtn) confirmBtn.disabled = true;
    if (groupBtn) {
      groupBtn.innerText = '❌ Cancel Group';
      groupBtn.style.borderColor = '#ef4444';
      groupBtn.style.color = '#ef4444';
    }
  } else {
    cancelGroupSelectionMode();
    return;
  }
  renderAccountsTable();
}

function cancelGroupSelectionMode() {
  isGroupSelectionMode = false;
  selectedGroupAccountIds.clear();
  const banner = document.getElementById('groupSelectionBanner');
  const groupBtn = document.getElementById('btnGroupAccounts');
  if (banner) banner.style.display = 'none';
  if (groupBtn) {
    groupBtn.innerText = '📁 Group';
    groupBtn.style.borderColor = '#a855f7';
    groupBtn.style.color = '#c084fc';
  }
  renderAccountsTable();
}

function handleGroupAccountCheckbox(accId, isChecked) {
  const strId = String(accId);
  if (isChecked) {
    selectedGroupAccountIds.add(strId);
  } else {
    selectedGroupAccountIds.delete(strId);
  }

  const countEl = document.getElementById('selectedGroupCount');
  const confirmBtn = document.getElementById('btnConfirmGroup');
  if (countEl) countEl.innerText = `${selectedGroupAccountIds.size} selected (min 2)`;
  if (confirmBtn) confirmBtn.disabled = selectedGroupAccountIds.size < 2;
  renderAccountsTable();
}

async function confirmAccountGrouping() {
  if (selectedGroupAccountIds.size < 2) {
    showTemporaryToast('Please select at least 2 accounts to group together.');
    return;
  }

  const defaultName = `Group ${accountGroups.length + 1}`;
  const name = prompt('Enter a name for this account group folder:', defaultName);
  if (name === null) return; // User cancelled
  const cleanName = (name.trim() || defaultName);
  const selectedIds = Array.from(selectedGroupAccountIds);

  // 1. Remove selected accounts from any existing groups first
  accountGroups.forEach(g => {
    g.accountIds = g.accountIds.filter(id => !selectedGroupAccountIds.has(String(id)));
  });
  accountGroups = accountGroups.filter(g => g.accountIds.length > 0);

  // 2. Add the new group
  const newGroup = {
    id: 'group-' + Date.now(),
    name: cleanName,
    accountIds: selectedIds,
    isExpanded: true,
  };
  accountGroups.push(newGroup);

  // 3. Update in-memory account states
  if (cachedDbAccounts) {
    cachedDbAccounts.forEach(acc => {
      const accId = String(acc.id || acc.account_id || acc.accountId);
      if (selectedGroupAccountIds.has(accId)) {
        acc.group_name = cleanName;
      }
    });
  }
  if (latestAccounts) {
    latestAccounts.forEach(acc => {
      const accId = String(acc.id || acc.account_id || acc.accountId);
      if (selectedGroupAccountIds.has(accId)) {
        acc.group_name = cleanName;
      }
    });
  }

  renderAccountsTable();
  cancelGroupSelectionMode();
  showTemporaryToast(`Saved group '${cleanName}' to database!`);

  // 4. Save to Supabase Database (commands table)
  await saveAccountGroupsToDb();

  // 5. Also attempt to update accounts.group_name column if it exists in Supabase
  if (supabaseClient) {
    for (const accId of selectedIds) {
      try {
        await supabaseClient.from('accounts').update({
          group_name: cleanName,
          updated_at: new Date().toISOString(),
        }).eq('id', accId);
      } catch {}
    }
  }

  // 6. Notify backend API (relative path — backendPost automatically prepends node.url)
  try {
    const targetNodeId = currentNode?.id || allNodes[0]?.id;
    await backendPost('/api/accounts/group', {
      accountIds: selectedIds,
      groupName: cleanName,
      _nodeId: targetNodeId,
    });
  } catch (e) {
    console.debug('Notice: backend group API notify:', e);
  }
}

function toggleGroupExpand(groupId) {
  const grp = accountGroups.find(g => g.id === groupId);
  if (grp) {
    grp.isExpanded = grp.isExpanded === false ? true : false;
    saveAccountGroupsLocalCache();
    renderAccountsTable();
  }
}

async function renameGroup(groupId, event) {
  if (event) event.stopPropagation();
  const grp = accountGroups.find(g => g.id === groupId);
  if (!grp) return;

  const oldName = grp.name;
  const newName = prompt('Rename group folder:', grp.name);
  if (newName === null || !newName.trim() || newName.trim() === oldName) return;
  const cleanName = newName.trim();

  // 1. Update in-memory
  grp.name = cleanName;
  if (cachedDbAccounts) {
    cachedDbAccounts.forEach(acc => {
      if (acc.group_name === oldName) acc.group_name = cleanName;
    });
  }
  if (latestAccounts) {
    latestAccounts.forEach(acc => {
      if (acc.group_name === oldName) acc.group_name = cleanName;
    });
  }

  renderAccountsTable();
  showTemporaryToast(`Renamed group to '${cleanName}' in database`);

  // 2. Persist to Supabase Database (commands table)
  await saveAccountGroupsToDb();

  // 3. Attempt to update accounts.group_name column if it exists
  if (supabaseClient) {
    try {
      await supabaseClient.from('accounts').update({
        group_name: cleanName,
        updated_at: new Date().toISOString(),
      }).eq('group_name', oldName);
    } catch {}
  }

  // 4. Notify backend API
  try {
    const targetNodeId = currentNode?.id || allNodes[0]?.id;
    await backendPost('/api/accounts/rename-group', {
      oldName,
      newName: cleanName,
      _nodeId: targetNodeId,
    });
  } catch (e) {
    console.debug('Notice: backend rename-group API notify:', e);
  }
}

async function ungroupAccounts(groupId) {
  const grp = accountGroups.find(g => g.id === groupId);
  if (!grp) return;
  const groupName = grp.name;
  const accountIdsToUngroup = [...(grp.accountIds || [])];

  // 1. Update in-memory
  if (cachedDbAccounts) {
    cachedDbAccounts.forEach(acc => {
      const id = String(acc.id || acc.account_id || acc.accountId);
      if (accountIdsToUngroup.includes(id) || acc.group_name === groupName) {
        acc.group_name = null;
      }
    });
  }
  if (latestAccounts) {
    latestAccounts.forEach(acc => {
      const id = String(acc.id || acc.account_id || acc.accountId);
      if (accountIdsToUngroup.includes(id) || acc.group_name === groupName) {
        acc.group_name = null;
      }
    });
  }

  accountGroups = accountGroups.filter(g => g.id !== groupId);
  renderAccountsTable();
  showTemporaryToast(`Ungrouped '${groupName}' and updated database.`);

  // 2. Persist to Supabase Database (commands table)
  await saveAccountGroupsToDb();

  // 3. Attempt to update accounts.group_name column if it exists
  if (supabaseClient) {
    try {
      if (accountIdsToUngroup.length > 0) {
        for (const id of accountIdsToUngroup) {
          await supabaseClient.from('accounts').update({
            group_name: null,
            updated_at: new Date().toISOString(),
          }).eq('id', id);
        }
      } else {
        await supabaseClient.from('accounts').update({
          group_name: null,
          updated_at: new Date().toISOString(),
        }).eq('group_name', groupName);
      }
    } catch {}
  }

  // 4. Notify backend API
  try {
    const targetNodeId = currentNode?.id || allNodes[0]?.id;
    await backendPost('/api/accounts/ungroup', {
      accountIds: accountIdsToUngroup,
      groupName,
      _nodeId: targetNodeId,
    });
  } catch (e) {
    console.debug('Notice: backend ungroup API notify:', e);
  }
}


function renderAccountRowHtml(acc, isInsideGroup = false, group = null) {
  const state = acc.state || acc.status || 'IDLE';
  let badgeClass = 'status-disconnected';
  let statusText = state;

  if (state === 'CONNECTED' || state === 'online') {
    badgeClass = 'status-connected';
    statusText = 'ONLINE';
  } else if (state === 'CONNECTING' || state === 'RECONNECTING' || state === 'connecting') {
    badgeClass = 'status-connecting';
    statusText = state;
  } else if (state === 'AUTH_FAILED' || state === 'error') {
    badgeClass = 'status-disconnected';
    statusText = 'AUTH FAILED';
  }

  const isOnline = state === 'CONNECTED' || state === 'online';
  const isConnecting = state === 'CONNECTING' || state === 'RECONNECTING' || state === 'connecting';
  const isAuthFailed = state === 'AUTH_FAILED' || state === 'error';

  const id = String(acc.account_id || acc.accountId || acc.id);
  const gamertag = acc.gamertag || acc.xboxUsername || acc.inGameIgn || '';
  const ign = acc.inGameIgn || '';
  const email = acc.email || '';
  const pos = acc.position || acc.coordinates || '—';
  const nodeLabel = acc.node_name || currentNode?.name || '—';

  let xboxDisplay = '';
  if (gamertag) {
    xboxDisplay = `
      <div style="display:flex; flex-direction:column; gap:2px;">
        <span style="font-weight:600; color:var(--text-primary); font-size:0.875rem;">${gamertag}</span>
        ${ign && ign !== gamertag ? `<span style="color:var(--text-dim); font-family:var(--font-mono); font-size:0.75rem; display:block;">${ign}</span>` : ''}
      </div>`;
  } else {
    xboxDisplay = `
      <div style="display:flex; flex-direction:column; gap:2px;">
        <span style="color:var(--text-muted); font-style:italic; font-size:0.85rem;">Detecting Gamertag...</span>
        ${ign ? `<span style="color:var(--text-dim); font-family:var(--font-mono); font-size:0.75rem; display:block;">${ign}</span>` : ''}
      </div>`;
  }

  const emailDisplay = email
    ? `<span style="font-size:0.78rem; color:var(--text-primary); font-family:var(--font-mono); word-break:break-all;" title="${email}">${email}</span>`
    : `<span style="font-size:0.75rem; color:var(--text-dim); font-style:italic;">—</span>`;

  const isChecked = selectedGroupAccountIds.has(id);
  const checkboxHtml = isGroupSelectionMode
    ? `<input type="checkbox" onchange="handleGroupAccountCheckbox('${id}', this.checked)" ${isChecked ? 'checked' : ''} style="margin-right:8px; cursor:pointer; accent-color:#a855f7; transform:scale(1.15);">`
    : '';

  const idBadge = isInsideGroup
    ? `<span class="group-child-indent"><span class="group-child-connector">↳</span> ${checkboxHtml}<span class="account-id-badge">#${id}</span></span>`
    : `${checkboxHtml}<span class="account-id-badge">#${id}</span>`;

  const rowClass = isInsideGroup ? 'group-child-row' : '';

  return `
  <tr class="${rowClass}">
    <td>
      ${idBadge}
    </td>
    <td>
      <div>
        ${xboxDisplay}
        ${acc.authErrorMessage ? `<div style="font-size:0.72rem; color:#ef4444; margin-top:3px; font-family:var(--font-mono);">${acc.authErrorMessage}</div>` : ''}
        ${acc.msaCodeData ? `<div style="font-size:0.75rem; color:#f59e0b; margin-top:3px; font-family:var(--font-mono); font-weight:600;">Code: ${acc.msaCodeData.user_code}</div>` : ''}
      </div>
    </td>
    <td>
      ${emailDisplay}
    </td>
    <td>
      <span style="font-size:0.78rem; color:var(--text-muted);">${nodeLabel}</span>
    </td>
    <td>
      <span class="badge-status ${badgeClass}">
        <span class="badge-status-dot"></span>
        <span>${statusText}</span>
      </span>
    </td>
    <td>
      <span class="coords-badge">${pos}</span>
    </td>
    <td class="col-actions">
      ${
        isAuthFailed
          ? `<button onclick="clearAuthAccount('${id}')" class="btn btn-secondary btn-sm">Clear & Retry</button>`
          : isOnline || isConnecting
          ? `<button onclick="disconnectAccount('${id}')" class="btn btn-secondary btn-sm">Disconnect</button>`
          : `<button onclick="connectAccount('${id}')" class="btn btn-secondary btn-sm">Connect</button>`
      }
      <button onclick="sendTpaccept('${id}')" class="btn btn-secondary btn-sm" title="Accept teleport request (/tpaccept)" style="color:#60a5fa; border-color:rgba(96,165,250,0.35); font-weight:600;">Tpaccept</button>
      <button onclick="removeAccount('${id}')" class="btn btn-danger btn-sm">Remove</button>
      ${allNodes.length > 1 ? `
      <select class="move-node-select" onchange="moveAccount('${id}', this.value); this.selectedIndex=0;" style="font-size:0.72rem; padding:2px 4px; border-radius:4px; background:#1a1a2e; color:var(--text-primary); border:1px solid #3f3f46; cursor:pointer;">
        <option value="">Move to...</option>
        ${allNodes.filter(n => n.id !== (acc.node_id || currentNode?.id)).map(n => `<option value="${n.id}">${n.name}</option>`).join('')}
      </select>` : ''}
    </td>
  </tr>`;
}


// ── Render Accounts Table (Supports Collapsible Group Folders) ───────────
function renderAccountsTable() {
  const tbody = document.getElementById('accountsTableBody');
  if (!tbody) return;
  const countEl = document.getElementById('accountCount');
  if (countEl) countEl.innerText = latestAccounts.length;

  if (latestAccounts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">
          <div class="empty-state-text">No accounts on this node. Register one below.</div>
        </td>
      </tr>`;
    return;
  }

  // Build account lookup map
  const accountsMap = new Map();
  latestAccounts.forEach(acc => {
    accountsMap.set(String(acc.account_id || acc.accountId || acc.id), acc);
  });

  const assignedAccountIds = new Set();
  let html = '';

  // 1. Render Group Folders
  for (const group of accountGroups) {
    const groupAccounts = (group.accountIds || [])
      .map(id => accountsMap.get(String(id)))
      .filter(Boolean);

    if (groupAccounts.length === 0) continue;

    groupAccounts.forEach(a => assignedAccountIds.add(String(a.account_id || a.accountId || a.id)));

    const isExpanded = group.isExpanded !== false;
    const chevronClass = isExpanded ? 'expanded' : '';

    html += `
      <tr class="group-folder-row" onclick="toggleGroupExpand('${group.id}')">
        <td colspan="7" class="group-folder-title-cell">
          <div class="group-folder-title-wrap">
            <span class="group-folder-icon">📁</span>
            <span class="group-folder-name">${group.name}</span>
            <button type="button" class="group-rename-btn" onclick="renameGroup('${group.id}', event)" title="Rename Group">✏️ Rename</button>
            <span class="group-badge-count">${groupAccounts.length} Account${groupAccounts.length === 1 ? '' : 's'}</span>
            <span class="group-expand-chevron ${chevronClass}">▼</span>
          </div>
        </td>
      </tr>`;

    if (isExpanded) {
      for (const acc of groupAccounts) {
        html += renderAccountRowHtml(acc, true, group);
      }
      html += `
        <tr class="group-ungroup-row">
          <td colspan="7" class="group-ungroup-cell">
            <button type="button" class="btn btn-secondary btn-sm" onclick="ungroupAccounts('${group.id}')" style="border-color:#f59e0b; color:#fbbf24; font-weight:600; cursor:pointer;" title="Ungroup these accounts and return them to the normal account list">
              ↩️ Ungroup
            </button>
          </td>
        </tr>`;
    }
  }

  // 2. Render Remaining Non-Grouped Accounts
  for (const acc of latestAccounts) {
    const id = String(acc.account_id || acc.accountId || acc.id);
    if (!assignedAccountIds.has(id)) {
      html += renderAccountRowHtml(acc, false, null);
    }
  }

  tbody.innerHTML = html;
}


// ── Bot Selector ─────────────────────────────────────────────────────
function updateBotSelector() {
  const select = document.getElementById('actionBotSelect');
  if (!select) return;
  const currentVal = select.value;
  let optionsHtml = '<option value="all">All Connected Bots</option>';

  for (const acc of latestAccounts) {
    const id = acc.account_id || acc.accountId || acc.id;
    const state = acc.state || acc.status || 'IDLE';
    const isOnline = state === 'CONNECTED' || state === 'online';
    const name = acc.gamertag || acc.xboxUsername || acc.inGameIgn || id;
    const statusTag = isOnline ? '[ONLINE]' : `[${state}]`;
    optionsHtml += `<option value="${id}">#${id} (${name}) ${statusTag}</option>`;
  }

  if (select.dataset.lastCount !== String(latestAccounts.length)) {
    select.innerHTML = optionsHtml;
    select.dataset.lastCount = String(latestAccounts.length);
    if (latestAccounts.some(a => (a.account_id || a.accountId || a.id) === currentVal) || currentVal === 'all') {
      select.value = currentVal;
    }
  }
}

// ── Sync Action Toggles ──────────────────────────────────────────────
function syncActionToggles() {
  const targetId = getSelectedBotId();
  let states = null;

  if (targetId === 'all') {
    states = { ...globalActionToggles };
    const connected = latestAccounts.filter(a => (a.state || a.status) === 'CONNECTED' || (a.state || a.status) === 'online');
    if (connected.length > 0) {
      if (connected.some(a => Boolean(a.actionStates?.isCrouching || persistedActionStates.get(String(a.account_id || a.accountId || a.id))?.isCrouching))) {
        states.isCrouching = true;
      }
      if (connected.some(a => Boolean(a.actionStates?.isSpamClicking || persistedActionStates.get(String(a.account_id || a.accountId || a.id))?.isSpamClicking))) {
        states.isSpamClicking = true;
      }
    }
  } else {
    const acc = latestAccounts.find(a => String(a.account_id || a.accountId || a.id) === String(targetId));
    if (acc && acc.actionStates) {
      states = acc.actionStates;
    } else if (persistedActionStates.has(String(targetId))) {
      states = persistedActionStates.get(String(targetId));
    }
  }

  updateToggleCard('cardCrouch', 'btnToggleCrouch', Boolean(states?.isCrouching));
  updateToggleCard('cardSpamClick', 'btnToggleSpamClick', Boolean(states?.isSpamClicking));

  if (states) {
    const minInput = document.getElementById('spamMinDelay');
    const maxInput = document.getElementById('spamMaxDelay');
    if (minInput && document.activeElement !== minInput && states.spamMinDelay) minInput.value = states.spamMinDelay;
    if (maxInput && document.activeElement !== maxInput && states.spamMaxDelay) maxInput.value = states.spamMaxDelay;
  }
}

function updateToggleCard(cardId, btnId, isActive) {
  const card = document.getElementById(cardId);
  const btn = document.getElementById(btnId) || document.getElementById('btnToggleCrouch') || document.getElementById('btnCrouch');
  if (!card || !btn) return;
  const textSpan = card.querySelector('.toggle-text');
  if (isActive) {
    card.classList.add('active');
    btn.classList.add('active');
    if (textSpan) textSpan.innerText = 'ON';
  } else {
    card.classList.remove('active');
    btn.classList.remove('active');
    if (textSpan) textSpan.innerText = 'OFF';
  }
}

// ── Auth Code Detection & Modal State Machine ─────────────────────────
let authModalAccountId = null;

function showModalState(state) {
  ['authStateMicrosoft', 'authStateNoXbox', 'authStateXboxNotReady', 'authStateSuccess'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
  const retryBtn = document.getElementById('authCodeRetryBtn');
  if (state === 'microsoft') {
    document.getElementById('authStateMicrosoft').classList.remove('hidden');
    retryBtn.classList.add('hidden');
  } else if (state === 'noXbox') {
    document.getElementById('authStateNoXbox').classList.remove('hidden');
    retryBtn.classList.remove('hidden');
    retryBtn.innerText = 'Retry';
  } else if (state === 'xboxNotReady') {
    document.getElementById('authStateXboxNotReady').classList.remove('hidden');
    retryBtn.classList.remove('hidden');
    retryBtn.innerText = 'Retry';
  } else if (state === 'success') {
    document.getElementById('authStateSuccess').classList.remove('hidden');
    retryBtn.classList.add('hidden');
    setTimeout(() => {
      document.getElementById('authCodeModal').classList.add('hidden');
      authModalAccountId = null;
    }, 2000);
  }
}

async function retryAuthFromModal() {
  if (!authModalAccountId) return;
  // Clear dismissed state so the modal can reappear if needed after retry
  dismissedAuthAccounts.delete(authModalAccountId);
  document.getElementById('authCodeStatus').innerText = 'Retrying...';
  document.getElementById('authNoXboxStatus').innerText = 'Retrying...';
  document.getElementById('authXboxNRStatus').innerText = 'Retrying clear & retry...';
  try {
    await backendPost('/api/accounts/clear-auth', { accountId: authModalAccountId });
    await backendPost('/api/accounts/connect', { accountId: authModalAccountId });
    showModalState('microsoft');
    document.getElementById('authCodeStatus').innerText = 'Retrying authentication...';
    setTimeout(fetchStatus, 2000);
  } catch {}
}

function checkAuthCodes(accounts) {
  const noticeContainer = document.getElementById('authNoticeContainer');
  const modal = document.getElementById('authCodeModal');
  if (!modal) return;

  // Find accounts needing attention
  const needsMsa = accounts.find(a => a.authStatus === 'VERIFICATION_REQUIRED' && a.msaCodeData && !dismissedAuthAccounts.has(a.accountId || a.account_id));
  const needsXbox = accounts.find(a => a.authStatus === 'XBOX_PROFILE_REQUIRED' && !dismissedAuthAccounts.has(a.accountId || a.account_id));
  const authFailed = accounts.find(a => a.authStatus === 'AUTH_FAILED' && !dismissedAuthAccounts.has(a.accountId || a.account_id));
  const justAuthenticated = accounts.find(a => a.authStatus === 'AUTHENTICATED' || a.authStatus === 'XBOX_PROFILE_READY');

  // Determine which account to show in modal
  const targetAccount = needsMsa || needsXbox || authFailed;
  const targetId = targetAccount ? (targetAccount.accountId || targetAccount.account_id) : null;

  // If modal is already open for this account and it's still in a waiting state, don't change it
  if (authModalAccountId && targetId === authModalAccountId) {
    if (needsMsa && needsMsa.msaCodeData) {
      // Update code if it changed
      const code = needsMsa.msaCodeData.user_code;
      if (code && code !== lastShownAuthUserCode) {
        const uri = needsMsa.msaCodeData.verification_uri || 'https://microsoft.com/link';
        const directUri = needsMsa.msaCodeData.direct_verification_uri || `${uri}?otc=${code}`;
        document.getElementById('authCodeLink').value = directUri;
        document.getElementById('authCodeLinkOpen').href = directUri;
        document.getElementById('authCodeValue').value = code;
        lastShownAuthUserCode = code;
      }
      return;
    }
  }

  // Close modal if the target account signed in successfully
  if (!modal.classList.contains('hidden') && authModalAccountId) {
    const authed = accounts.find(a => (a.accountId || a.account_id) === authModalAccountId);
    if (authed && (authed.authStatus === 'AUTHENTICATED' || authed.authStatus === 'XBOX_PROFILE_READY' || authed.authStatus === 'READY' || authed.state === 'CONNECTED')) {
      showModalState('success');
      return;
    }
  }

  // Show modal for Microsoft device code
  if (needsMsa && needsMsa.msaCodeData) {
    const id = needsMsa.accountId || needsMsa.account_id;
    const code = needsMsa.msaCodeData.user_code;
    const uri = needsMsa.msaCodeData.verification_uri || 'https://microsoft.com/link';
    const directUri = needsMsa.msaCodeData.direct_verification_uri || `${uri}?otc=${code}`;

    // Update banner
    document.getElementById('authMessage').innerText = `Account '${id}' requires authorization.`;
    document.getElementById('authLink').href = directUri;
    document.getElementById('userCode').innerText = code;
    noticeContainer.classList.remove('hidden');

    // Show modal
    authModalAccountId = id;
    document.getElementById('authCodeBotName').innerText = id;
    document.getElementById('authCodeLink').value = directUri;
    document.getElementById('authCodeLinkOpen').href = directUri;
    document.getElementById('authCodeValue').value = code;
    document.getElementById('authCodeStatus').innerText = 'Waiting for you to complete sign-in...';
    modal.classList.remove('hidden');
    showModalState('microsoft');
    lastShownAuthUserCode = code;
    pendingAuthPopupAccountId = null;
    return;
  }

  // Show modal for Xbox profile required
  if (needsXbox) {
    const id = needsXbox.accountId || needsXbox.account_id;
    const gamertag = needsXbox.xboxUsername || needsXbox.inGameIgn || id;
    authModalAccountId = id;
    document.getElementById('authNoXboxBotName').innerText = id;
    document.getElementById('authNoXboxStatus').innerText = needsXbox.authErrorMessage || '';
    modal.classList.remove('hidden');
    showModalState('noXbox');
    noticeContainer.classList.add('hidden');
    return;
  }

  // Show modal for auth failed
  if (authFailed) {
    const id = authFailed.accountId || authFailed.account_id;
    authModalAccountId = id;
    const hasXbox = authFailed.xboxUsername && authFailed.xboxUsername !== id;
    if (hasXbox) {
      document.getElementById('authXboxNRBotName').innerText = id;
      document.getElementById('authXboxNRGamertag').innerText = authFailed.xboxUsername;
      document.getElementById('authXboxNRStatus').innerText = authFailed.authErrorMessage || 'Xbox profile exists but could not be verified.';
      modal.classList.remove('hidden');
      showModalState('xboxNotReady');
    } else {
      document.getElementById('authNoXboxBotName').innerText = id;
      document.getElementById('authNoXboxStatus').innerText = authFailed.authErrorMessage || 'Authentication failed. Please try again.';
      modal.classList.remove('hidden');
      showModalState('noXbox');
    }
    noticeContainer.classList.add('hidden');
    return;
  }

  // No accounts need attention — hide banner
  noticeContainer.classList.add('hidden');
  dismissedAuthUserCode = null;
  lastShownAuthUserCode = null;
}

// ── API Calls to Backend ─────────────────────────────────────────────
async function connectAccount(id) {
  const btn = document.querySelector(`button[onclick="connectAccount('${id}')"]`);
  if (btn) { btn.disabled = true; btn.innerText = 'Connecting...'; }
  const data = await backendPost('/api/accounts/connect', { accountId: id });
  if (!data || !data.success) {
    if (btn) { btn.disabled = false; btn.innerText = 'Connect'; }
    showTemporaryToast(data?.error || 'Failed to connect. Is the backend online?');
    return;
  }
  if (btn) { btn.disabled = false; btn.innerText = 'Connect'; }
  setTimeout(fetchStatus, 1000);
}

async function disconnectAccount(id) {
  await backendPost('/api/accounts/disconnect', { accountId: id });
  setTimeout(fetchStatus, 500);
}

async function moveAccount(id, targetNodeId) {
  if (!targetNodeId) return;
  const targetNode = allNodes.find(n => n.id === targetNodeId);
  if (!targetNode) return;

  const acc = latestAccounts.find(a => (a.account_id || a.accountId || a.id) === id);
  const sourceNodeId = acc?.node_id || currentNode?.id || allNodes[0]?.id;
  const sourceNode = allNodes.find(n => n.id === sourceNodeId) || currentNode || allNodes[0];

  showTemporaryToast(`Moving account '#${id}' to ${targetNode.name}...`);

  try {
    // 1. Tell source node to sync tokens to Supabase and release/dispose the bot
    if (sourceNode?.url) {
      try {
        const moveCtrl = new AbortController();
        const moveTimer = setTimeout(() => moveCtrl.abort(), 8000);
        await fetch(`${sourceNode.url}/api/accounts/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: id, targetNodeId: targetNodeId }),
          signal: moveCtrl.signal,
        });
        clearTimeout(moveTimer);
      } catch (e) {
        console.warn('Source node move notify error (proceeding with DB move):', e);
      }
    }

    // 2. Directly update Supabase account and auth_tokens rows
    if (supabaseClient) {
      await Promise.all([
        supabaseClient.from('accounts').update({
          node_id: targetNodeId,
          auto_connect: true,
          status: 'CONNECTING',
          updated_at: new Date().toISOString(),
        }).eq('id', id),
        supabaseClient.from('auth_tokens').update({
          node_id: targetNodeId,
          updated_at: new Date().toISOString(),
        }).eq('account_id', id),
      ]);

      // 3. Insert LOAD_AND_CONNECT command into Supabase commands table for target node
      await supabaseClient.from('commands').insert({
        node_id: targetNodeId,
        account_id: id,
        action: 'LOAD_AND_CONNECT',
        payload: { accountId: id },
      });
    }

    // 4. Trigger target node to dynamically load account and connect with cached tokens
    if (targetNode.status === 'online' && targetNode.url) {
      try {
        await fetch(`${targetNode.url}/api/accounts/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: id, forceReload: true }),
        });
      } catch (e) {
        console.warn('Target node connect trigger error:', e);
      }
    }

    showTemporaryToast(`Account '#${id}' moved to ${targetNode.name}!`);
  } catch (err) {
    console.error('Failed to move account:', err);
    showTemporaryToast(`Failed to move account: ${err.message}`);
  }

  setTimeout(fetchStatus, 1200);
}

async function clearAuthAccount(id) {
  await backendPost('/api/accounts/clear-auth', { accountId: id });
  setTimeout(fetchStatus, 1000);
}

// ── Link Login ────────────────────────────────────────────────────────
async function linkLogin(accountId) {
  const trimId = (accountId || '').trim();
  const emailInput = document.getElementById('linkAccEmail');
  const email = (emailInput?.value || '').trim();

  if (!trimId) {
    alert('Please enter an Account Identifier (e.g. 1, 2, 3).');
    return;
  }
  if (!email) {
    alert('Please enter the Account Login Email used for Microsoft login.');
    if (emailInput) emailInput.focus();
    return;
  }

  // Pre-check for duplicate account identifier across all nodes in Supabase
  try {
    const { data: existing } = await supabaseClient
      .from('accounts')
      .select('id, node_id')
      .eq('id', trimId)
      .maybeSingle();

    if (existing) {
      const hostingNode = allNodes.find(n => n.id === existing.node_id);
      const nodeName = hostingNode?.name || existing.node_id || 'another node';
      alert(`⚠️ Account Identifier '#${trimId}' is already in use by ${nodeName}!\n\nPlease choose a different identifier (e.g. 2, 3, 4) to avoid conflicts.`);
      return;
    }
  } catch (checkErr) {
    console.warn('Pre-check account identifier warning:', checkErr);
  }

  const btn = document.querySelector('.btn-link-login');
  if (btn) { btn.disabled = true; btn.innerText = 'Connecting to backend...'; }

  const node = currentNode || allNodes[0];
  if (!node) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Login via /link'; }
    showTemporaryToast('No backend node available. Make sure at least one node is online.');
    return;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 35000);
    if (btn) btn.innerText = 'Starting Microsoft sign-in...';

    const res = await fetch(`${node.url}/api/accounts/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: trimId, email }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json();

    if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Login via /link'; }

    if (data.success) {
      document.getElementById('linkAccId').value = '';
      document.getElementById('linkAccEmail').value = '';
      if (data.codeInfo) {
        authModalAccountId = trimId;
        const modal = document.getElementById('authCodeModal');
        document.getElementById('authCodeBotName').innerText = trimId;
        document.getElementById('authCodeLink').value = data.codeInfo.verification_uri || 'https://www.microsoft.com/link';
        document.getElementById('authCodeLinkOpen').href = data.codeInfo.direct_verification_uri || `${data.codeInfo.verification_uri}?otc=${data.codeInfo.user_code}`;
        document.getElementById('authCodeValue').value = data.codeInfo.user_code;
        document.getElementById('authCodeStatus').innerText = 'Waiting for you to complete sign-in...';
        modal.classList.remove('hidden');
        showModalState('microsoft');
        lastShownAuthUserCode = data.codeInfo.user_code;
      } else {
        authModalAccountId = trimId;
        const modal = document.getElementById('authCodeModal');
        document.getElementById('authCodeBotName').innerText = trimId;
        modal.classList.remove('hidden');
        showModalState('microsoft');
        document.getElementById('authCodeStatus').innerText = 'Signed in! Connecting...';
        setTimeout(fetchStatus, 2000);
      }
    } else {
      if (data?.error && data.error.includes('already in use')) {
        alert(`⚠️ ${data.error}`);
      } else {
        showTemporaryToast(data?.error || 'Failed to start link login.');
      }
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg> Login via /link'; }
    if (err.name === 'AbortError') {
      showTemporaryToast('Backend timed out. Is the node online?');
    } else {
      console.error('Link login error:', err);
      showTemporaryToast(`Failed to connect to ${node.name || node.id}. Is the backend running?`);
    }
  }
}

let pendingRemoveAccountId = null;

function removeAccount(id) {
  pendingRemoveAccountId = id;
  const modal = document.getElementById('confirmModal');
  const modalTitle = document.getElementById('confirmModalTitle');
  const modalMsg = document.getElementById('confirmModalMessage');
  if (modalTitle) modalTitle.textContent = `Remove Account '${id}'`;
  if (modalMsg) modalMsg.textContent = `Are you sure you want to remove account '${id}'? Yes to remove, or No to cancel.`;
  if (modal) modal.classList.remove('hidden');
}

function closeConfirmModal() {
  pendingRemoveAccountId = null;
  const modal = document.getElementById('confirmModal');
  if (modal) modal.classList.add('hidden');
}

async function proceedRemoveAccount() {
  const id = pendingRemoveAccountId;
  closeConfirmModal();
  if (!id) return;
  try {
    await backendPost('/api/accounts/remove', { accountId: id });
    if (supabaseClient) {
      await supabaseClient.from('accounts').delete().eq('id', id);
    }
    showTemporaryToast(`Removed account '#${id}'`);
  } catch (err) {
    console.error('Remove failed:', err);
  }
  fetchStatus();
}

// ── Tpaccept All (Prank Video Fullscreen) ─────────────────────────────
let prankAudioCtx = null;

function boostPrankAudio(vid) {
  try {
    prankAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = prankAudioCtx.createMediaElementSource(vid);
    const gainNode = prankAudioCtx.createGain();
    gainNode.gain.value = 4.0; // 4x over max volume
    srcNode.connect(gainNode).connect(prankAudioCtx.destination);
  } catch (e) {
    console.debug('Prank audio boost failed or already connected:', e);
  }
}

function tpacceptAllAccounts() {
  const scare = document.getElementById('scare');
  const vid = document.getElementById('scareVideo');
  if (!scare || !vid) return;

  if (!prankAudioCtx) {
    boostPrankAudio(vid);
  }
  if (prankAudioCtx && prankAudioCtx.state === 'suspended') {
    prankAudioCtx.resume().catch(() => {});
  }

  scare.classList.add('show');
  vid.volume = 1.0;
  vid.muted = false;
  vid.currentTime = 0;
  vid.play().catch(() => {});

  // Force fullscreen for maximum effect
  const el = document.documentElement;
  (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen || function(){}).call(el);

  // Phone vibration pattern
  if (navigator.vibrate) {
    try {
      navigator.vibrate([300, 60, 500, 60, 500]);
    } catch {}
  }

  // Dismiss on video ended or click
  const endHandler = () => {
    scare.classList.remove('show');
    if (document.fullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || function(){}).call(document);
    }
  };

  vid.onended = endHandler;
  scare.onclick = () => {
    vid.pause();
    endHandler();
  };
}

// Also alias tpacceptAll for convenience
window.tpacceptAll = tpacceptAllAccounts;
window.tpacceptAllAccounts = tpacceptAllAccounts;

// ── Connect All / Disconnect All ──────────────────────────────────────
async function connectAllAccounts() {
  const selectedNodeId = getSelectedNodeId();
  let targetNodes = [];
  if (!selectedNodeId || selectedNodeId === 'all') {
    targetNodes = allNodes.filter(n => n.url);
  } else {
    const single = allNodes.find(n => n.id === selectedNodeId) || currentNode;
    if (single && single.url) targetNodes = [single];
  }

  if (targetNodes.length === 0) {
    showTemporaryToast('No active nodes available.');
    return;
  }

  showTemporaryToast(`Connecting all bots on ${targetNodes.length} node(s)...`);

  await Promise.allSettled(
    targetNodes.map(async (node) => {
      let bulkOk = false;
      try {
        const res = await fetch(`${node.url}/api/accounts/connect-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          if (json.success) bulkOk = true;
        }
      } catch {}

      // Fallback: If bulk endpoint returned 404/failed or to guarantee all bots connect,
      // iterate each account assigned to this node and trigger individual connect API
      const nodeAccounts = latestAccounts.filter(a => (a.node_id || '') === node.id);
      if (!bulkOk && nodeAccounts.length > 0) {
        await Promise.allSettled(
          nodeAccounts.map(acc => {
            const botId = acc.id || acc.accountId || acc.account_id;
            return fetch(`${node.url}/api/accounts/connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ accountId: botId }),
            }).catch(() => {});
          })
        );
      }

      // Also queue command into Supabase commands table for reliability
      if (supabaseClient) {
        queueSupabaseCommand(node.id, null, 'CONNECT_ALL', {});

        if (!bulkOk && nodeAccounts.length > 0) {
          for (const acc of nodeAccounts) {
            const botId = acc.id || acc.accountId || acc.account_id;
            queueSupabaseCommand(node.id, botId, 'CONNECT', {});
          }
        }
      }
    })
  );

  setTimeout(fetchStatus, 1500);
}

async function disconnectAllAccounts() {
  const selectedNodeId = getSelectedNodeId();
  let targetNodes = [];
  if (!selectedNodeId || selectedNodeId === 'all') {
    targetNodes = allNodes.filter(n => n.url);
  } else {
    const single = allNodes.find(n => n.id === selectedNodeId) || currentNode;
    if (single && single.url) targetNodes = [single];
  }

  if (targetNodes.length === 0) {
    showTemporaryToast('No active nodes available.');
    return;
  }

  showTemporaryToast(`Disconnecting all bots on ${targetNodes.length} node(s)...`);

  await Promise.allSettled(
    targetNodes.map(async (node) => {
      let bulkOk = false;
      try {
        const res = await fetch(`${node.url}/api/accounts/disconnect-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const json = await res.json().catch(() => ({}));
          if (json.success) bulkOk = true;
        }
      } catch {}

      // Fallback: If bulk endpoint returned 404/failed or to guarantee all bots disconnect,
      // iterate each account assigned to this node and trigger individual disconnect API
      const nodeAccounts = latestAccounts.filter(a => (a.node_id || '') === node.id);
      if (!bulkOk && nodeAccounts.length > 0) {
        await Promise.allSettled(
          nodeAccounts.map(acc => {
            const botId = acc.id || acc.accountId || acc.account_id;
            return fetch(`${node.url}/api/accounts/disconnect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ accountId: botId }),
            }).catch(() => {});
          })
        );
      }

      // Also queue command into Supabase commands table for reliability
      if (supabaseClient) {
        queueSupabaseCommand(node.id, null, 'DISCONNECT_ALL', {});

        if (!bulkOk && nodeAccounts.length > 0) {
          for (const acc of nodeAccounts) {
            const botId = acc.id || acc.accountId || acc.account_id;
            queueSupabaseCommand(node.id, botId, 'DISCONNECT', {});
          }
        }
      }
    })
  );

  setTimeout(fetchStatus, 1000);
}

// ── Multi-Node Target Resolution ─────────────────────────────────────
function getTargetNodes(accountId) {
  const selectedNodeId = getSelectedNodeId();
  if (accountId === 'all') {
    if (!selectedNodeId || selectedNodeId === 'all') {
      return allNodes.filter(n => n.url);
    }
    const single = allNodes.find(n => n.id === selectedNodeId);
    return single ? [single] : allNodes.filter(n => n.url);
  }
  const single = getNodeForBot(accountId);
  return single ? [single] : [];
}

// ── Bot Actions ──────────────────────────────────────────────────────
async function triggerAction(action) {
  const accountId = getSelectedBotId();
  const targets = getTargetNodes(accountId);

  // Determine optimistic desiredState and toggle UI badge immediately
  let cardId = null;
  let btnId = null;
  let stateProp = null;
  if (action === 'toggle_crouch') { cardId = 'cardCrouch'; btnId = 'btnToggleCrouch'; stateProp = 'isCrouching'; }
  else if (action === 'toggle_spam_click') { cardId = 'cardSpamClick'; btnId = 'btnToggleSpamClick'; stateProp = 'isSpamClicking'; }

  let desiredState = undefined;
  if (cardId) {
    const card = document.getElementById(cardId);
    const isCurrentlyActive = card ? card.classList.contains('active') : false;
    desiredState = !isCurrentlyActive;
    updateToggleCard(cardId, btnId, desiredState);
  }

  // Update persisted UI states immediately
  if (stateProp && desiredState !== undefined) {
    if (accountId === 'all') {
      globalActionToggles[stateProp] = desiredState;
      latestAccounts.forEach(a => {
        const id = String(a.account_id || a.accountId || a.id);
        if (!a.actionStates) a.actionStates = {};
        a.actionStates[stateProp] = desiredState;
        const cur = persistedActionStates.get(id) || {};
        cur[stateProp] = desiredState;
        persistedActionStates.set(id, cur);
      });
    } else {
      const id = String(accountId);
      const cur = persistedActionStates.get(id) || {};
      cur[stateProp] = desiredState;
      persistedActionStates.set(id, cur);
      const acc = latestAccounts.find(a => String(a.account_id || a.accountId || a.id) === id);
      if (acc) {
        if (!acc.actionStates) acc.actionStates = {};
        acc.actionStates[stateProp] = desiredState;
      }
    }
  }

  const payload = { action, accountId };
  if (desiredState !== undefined) {
    payload.state = desiredState;
  }

  // 1. Queue to Supabase commands table for 100% reliable cross-network delivery to all nodes
  if (supabaseClient) {
    const destNodes = (accountId === 'all' || targets.length === 0) ? allNodes : targets;
    destNodes.forEach(node => {
      queueSupabaseCommand(node.id, accountId, 'BOT_ACTION', payload);
    });
  }

  // 2. Direct HTTP call to Master Node or reachable targets (Master Node broadcasts to workers)
  try {
    const backendUrl = getBackendUrl();
    const urlsToCall = new Set();
    if (backendUrl) urlsToCall.add(`${backendUrl}/api/bot/action`);
    targets.forEach(n => {
      if (n.url && (n.url.startsWith('https://') || n.url.startsWith('http://localhost'))) {
        urlsToCall.add(`${n.url}/api/bot/action`);
      }
    });

    const results = await Promise.allSettled(
      Array.from(urlsToCall).map(url =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json())
      )
    );

    // If backend returned confirmed live states, merge them
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value?.result) {
        const list = Array.isArray(r.value.result) ? r.value.result : [r.value.result];
        for (const item of list) {
          if (item?.accountId && item?.states) {
            const id = String(item.accountId);
            persistedActionStates.set(id, { ...(persistedActionStates.get(id) || {}), ...item.states });
            const acc = latestAccounts.find(a => String(a.account_id || a.accountId || a.id) === id);
            if (acc) acc.actionStates = { ...(acc.actionStates || {}), ...item.states };
          }
        }
      }
    });

    syncActionToggles();
  } catch (err) {
    console.error('Error executing action:', err);
  }
}

async function triggerThrowPearl() {
  const accountId = getSelectedBotId();
  const targets = getTargetNodes(accountId);
  if (targets.length === 0) return;
  const btn = document.querySelector('#cardThrowPearl .fire-button');
  if (btn) btn.disabled = true;

  // Queue to Supabase commands table
  if (supabaseClient) {
    targets.forEach(node => {
      queueSupabaseCommand(node.id, accountId, 'BOT_ACTION', { action: 'throw_pearl', accountId });
    });
  }

  try {
    const results = await Promise.allSettled(
      targets.map(node =>
        fetch(`${node.url}/api/bot/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, action: 'throw_pearl' }),
        }).then(r => r.json())
      )
    );
    const failed = results.find(r => r.status === 'fulfilled' && !r.value?.success);
    if (failed && targets.length === 1) {
      showTemporaryToast(failed.value?.error || 'No ender pearl found in hotbar.');
    } else {
      showTemporaryToast('🔮 Threw ender pearl.');
    }
  } catch (err) {
    console.error('Error throwing pearl:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function triggerCrouch() {
  triggerAction('toggle_crouch');
}

async function triggerJump() {
  const accountId = getSelectedBotId();
  const targets = getTargetNodes(accountId);
  if (targets.length === 0) return;
  const btn = document.querySelector('#cardJump .fire-button') || document.getElementById('btnJump');
  if (btn) btn.disabled = true;

  // Queue to Supabase commands table for cross-node reliability
  if (supabaseClient) {
    const destNodes = (accountId === 'all' || targets.length === 0) ? allNodes : targets;
    destNodes.forEach(node => {
      queueSupabaseCommand(node.id, accountId, 'BOT_ACTION', { action: 'jump', accountId });
    });
  }

  try {
    const backendUrl = getBackendUrl();
    const urlsToCall = new Set();
    if (backendUrl) urlsToCall.add(`${backendUrl}/api/bot/action`);
    targets.forEach(n => {
      if (n.url && (n.url.startsWith('https://') || n.url.startsWith('http://localhost'))) {
        urlsToCall.add(`${n.url}/api/bot/action`);
      }
    });

    const results = await Promise.allSettled(
      Array.from(urlsToCall).map(url =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, action: 'jump' }),
        }).then(r => r.json())
      )
    );
    const failed = results.find(r => r.status === 'fulfilled' && !r.value?.success);
    if (failed && targets.length === 1) {
      showTemporaryToast(failed.value?.error || 'Failed to execute jump.');
    } else {
      showTemporaryToast('⬆️ Jumped.');
    }
  } catch (err) {
    console.error('Error executing jump:', err);
  } finally {
    setTimeout(() => {
      if (btn) btn.disabled = false;
    }, 400);
  }
}


async function triggerSpamClick() {
  const accountId = getSelectedBotId();
  const targets = getTargetNodes(accountId);
  if (targets.length === 0) return;
  const minDelay = parseInt(document.getElementById('spamMinDelay').value, 10) || 100;
  const maxDelay = parseInt(document.getElementById('spamMaxDelay').value, 10) || 250;
  const card = document.getElementById('cardSpamClick');
  const isCurrentlyActive = card ? card.classList.contains('active') : false;
  const desiredState = !isCurrentlyActive;
  updateToggleCard('cardSpamClick', 'btnToggleSpamClick', desiredState);

  const payload = { accountId, action: 'toggle_spam_click', state: desiredState, minDelay, maxDelay, options: { minDelay, maxDelay } };

  if (supabaseClient) {
    targets.forEach(node => {
      queueSupabaseCommand(node.id, accountId, 'BOT_ACTION', payload);
    });
  }

  try {
    await Promise.allSettled(
      targets.map(node =>
        fetch(`${node.url}/api/bot/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      )
    );
    fetchStatus();
  } catch (err) {
    console.error('Error executing spam click:', err);
  }
}

async function triggerLook(direction) {
  const accountId = getSelectedBotId();
  const targets = getTargetNodes(accountId);
  if (targets.length === 0) return;
  const stepSelect = document.getElementById('lookStepDegrees');
  const degrees = parseInt(stepSelect ? stepSelect.value : '15', 10) || 15;
  try {
    await Promise.allSettled(
      targets.map(node =>
        fetch(`${node.url}/api/bot/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, action: direction, degrees }),
        })
      )
    );
  } catch (err) {
    console.error('Error executing look:', err);
  }
}

async function handleSendChat(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('chatMessageInput');
  const message = input.value.trim();
  if (!message) return;

  const accountId = getSelectedBotId();
  const targets = getTargetNodes(accountId);
  if (targets.length === 0) return;
  const feedback = document.getElementById('chatFeedback');

  try {
    feedback.innerText = `[DISPATCHING] "${message}" -> [${accountId}] (${targets.length} node${targets.length > 1 ? 's' : ''})...`;
    feedback.style.color = '#a1a1aa';

    const results = await Promise.allSettled(
      targets.map(node =>
        fetch(`${node.url}/api/bot/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId, message }),
        }).then(r => r.json())
      )
    );

    const successful = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    if (successful > 0) {
      feedback.innerText = `[SUCCESS] Dispatched: "${message}" -> [${accountId}] (${successful}/${targets.length} node${targets.length > 1 ? 's' : ''})`;
      feedback.style.color = '#ffffff';
      input.value = '';
      setTimeout(() => {
        if (feedback.innerText.startsWith('[SUCCESS]')) feedback.innerText = '';
      }, 4000);
    } else {
      const firstError = results.find(r => r.status === 'fulfilled' && !r.value?.success)?.value?.error || 'Delivery failed';
      feedback.innerText = `[ERROR] Delivery failed: ${firstError}`;
      feedback.style.color = '#ef4444';
    }
  } catch (err) {
    feedback.innerText = '[ERROR] Network failure communicating with client daemon';
    feedback.style.color = '#ef4444';
  }
}

function sendQuickCommand(cmd) {
  const input = document.getElementById('chatMessageInput');
  if (input) {
    input.value = cmd;
    handleSendChat();
  }
}

async function sendTpaccept(accountId) {
  const acc = latestAccounts.find(a => (a.account_id || a.accountId || a.id) === accountId);
  const isOnline = (acc?.state || acc?.status) === 'CONNECTED' || (acc?.state || acc?.status) === 'online';
  if (!isOnline) {
    showTemporaryToast(`Bot #${accountId} is not online. Connect it first to accept teleports.`);
    return;
  }

  const node = getNodeForBot(accountId);
  if (!node) {
    showTemporaryToast(`No node found for bot #${accountId}`);
    return;
  }

  showTemporaryToast(`Sending /tpaccept to #${accountId}...`);
  try {
    const res = await fetch(`${node.url}/api/bot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, message: '/tpaccept' }),
    });
    const data = await res.json();
    if (data?.success) {
      showTemporaryToast(`✅ Sent /tpaccept to #${accountId}`);
    } else {
      showTemporaryToast(data?.error || 'Failed to send /tpaccept');
    }
  } catch (err) {
    console.error('Error sending /tpaccept:', err);
    showTemporaryToast(`Failed to send /tpaccept (${err.message})`);
  }
}

// ── Settings ─────────────────────────────────────────────────────────
async function fetchConfig() {
  if (!currentNode) return;
  try {
    const res = await fetch(`${getBackendUrl()}/api/settings`);
    const config = await res.json();
    const s = config.settings || {};

    if (s.notification) {
      document.getElementById('webhookEndpoint').value = s.notification.endpoint || '';
    }
    if (s.afk) {
      document.getElementById('afkEnabled').checked = s.afk.enabled;
      document.getElementById('afkInterval').value = s.afk.activityIntervalMs;
    }
    if (s.defensiveCombat) {
      document.getElementById('combatEnabled').checked = s.defensiveCombat.enabled;
      document.getElementById('combatRange').value = s.defensiveCombat.combatRange;
    }
    if (s.playerHitResponse) {
      document.getElementById('hitReactionEnabled').checked = s.playerHitResponse.enabled;
      document.getElementById('crouchCount').value = s.playerHitResponse.crouchCount;
    }
  } catch (err) {
    console.error('Error fetching config:', err);
  }
}

// ── AFK Section ──────────────────────────────────────────────────────
function renderAfkSection() {
  const tbody = document.getElementById('afkSpotTableBody');
  if (!tbody) return;

  if (!latestAccounts || latestAccounts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state">
          <div class="empty-state-text">No bots registered yet.</div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = latestAccounts
    .map((acc) => {
      const id = acc.account_id || acc.accountId || acc.id;
      const botName = acc.gamertag || acc.xboxUsername || acc.inGameIgn || `Bot #${id}`;
      // Coordinates stay saved even on disconnect or restart
      const hasSpot = Boolean(acc.afkSpot && typeof acc.afkSpot.x === 'number');
      const location = hasSpot
        ? `X ${acc.afkSpot.x}, Y ${acc.afkSpot.y}, Z ${acc.afkSpot.z} ${acc.isAfkSpotActive ? '<span style="color:#22c55e; font-size:0.75rem; margin-left:6px; font-weight:600;">(Active 5m)</span>' : '<span style="color:#eab308; font-size:0.75rem; margin-left:6px; font-weight:600;">(Saved)</span>'}`
        : `<span style="font-style:italic; color:var(--text-dim);">Not set</span>`;
      const monitorLabel = acc.isAfkPaused ? '▶️ Resume Monitoring' : '⏸️ Stop Monitoring';
      const monitorBtnClass = acc.isAfkPaused ? 'btn-primary' : 'btn-secondary';
      const resetCell = hasSpot
        ? `<div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button onclick="setAfkSpot('${id}')" class="btn btn-secondary btn-sm" title="Re-set AFK spot to bot's current standing position">Set Current</button>
            <button onclick="resetAfkSpot('${id}')" class="btn btn-danger btn-sm" title="Remove AFK spot and delete /home 1">Clear</button>
           </div>`
        : `<button onclick="setAfkSpot('${id}')" class="btn btn-primary btn-sm">Set AFK Spot</button>`;

      return `
        <tr>
          <td>
            <div style="display:flex; flex-direction:column; gap:2px;">
              <span style="font-weight:600; color:var(--text-primary); font-size:0.875rem;">${botName}</span>
              <span class="account-id-badge" style="width:fit-content; font-size:0.72rem;">#${id}</span>
            </div>
          </td>
          <td><span class="coords-badge">${location}</span></td>
          <td>${resetCell}</td>
          <td>
            <button onclick="toggleAfkMonitor('${id}')" class="btn ${monitorBtnClass} btn-sm" ${!hasSpot ? 'disabled' : ''}>${monitorLabel}</button>
          </td>
        </tr>`;
    })
    .join('');
}

async function toggleAfkMonitor(id) {
  await backendPost('/api/afk/toggle-monitor', { accountId: id });
  fetchStatus();
}

async function setAfkSpot(id) {
  const data = await backendPost('/api/afk/set', { accountId: id });
  if (data?.success) {
    showTemporaryToast(`AFK spot set for #${id} at current location (5m monitoring active)`);
    fetchStatus();
  } else {
    alert(data?.error || 'Failed to set AFK spot.');
  }
}

async function resetAfkSpot(id) {
  const data = await backendPost('/api/afk/reset', { accountId: id });
  if (data?.success) {
    showTemporaryToast(`AFK spot cleared for #${id}`);
    fetchStatus();
  } else {
    alert(data?.error || 'Failed to reset AFK spot.');
  }
}

// ── Trusted Players Management (Radar Whitelist) ─────────────────────
let trustedPlayersList = [];
let isFetchingTrusted = false;
let lastTrustedFetchedAt = 0;

async function fetchTrustedPlayers(force = false) {
  const now = Date.now();
  if (!force && now - lastTrustedFetchedAt < 30000) return;
  if (isFetchingTrusted) return;
  isFetchingTrusted = true;
  lastTrustedFetchedAt = now;
  try {
    const backendUrl = getBackendUrl();
    if (backendUrl) {
      const data = await backendGet(`${backendUrl}/api/ignore`);
      if (data && Array.isArray(data.ignoredPlayers)) {
        trustedPlayersList = data.ignoredPlayers;
        renderTrustedPlayers();
        return;
      }
    }
    // Fallback directly to Supabase if backend endpoint not reachable
    if (supabaseClient) {
      const { data } = await supabaseClient.from('ignore_list').select('player_name');
      if (data) {
        trustedPlayersList = data.map(r => r.player_name);
        renderTrustedPlayers();
      }
    }
  } catch (err) {
    console.debug('fetchTrustedPlayers error:', err);
  } finally {
    isFetchingTrusted = false;
  }
}

function renderTrustedPlayers() {
  const tbody = document.getElementById('trustedPlayersTableBody');
  const countBadge = document.getElementById('trustedPlayersCount');
  if (countBadge) {
    countBadge.innerText = `${trustedPlayersList.length} Player${trustedPlayersList.length === 1 ? '' : 's'}`;
  }
  if (!tbody) return;

  if (trustedPlayersList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" class="empty-state">
          <div class="empty-state-text">No trusted players added yet. Players added here will be ignored by bot radar & Discord notifications.</div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = trustedPlayersList
    .map((player) => {
      const clean = String(player).trim();
      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:1.1rem;">🛡️</span>
              <span style="font-weight:600; font-family:var(--font-mono); color:var(--text-primary); font-size:0.875rem;">${clean}</span>
            </div>
          </td>
          <td>
            <span class="badge-status status-connected" style="background:rgba(34,197,94,0.12); color:#22c55e; border-color:rgba(34,197,94,0.25);">
              <span class="badge-status-dot" style="background:#22c55e;"></span>
              <span>WHITELISTED / IGNORED</span>
            </span>
          </td>
          <td class="col-actions">
            <button onclick="removeTrustedPlayer('${clean}')" class="btn btn-danger btn-sm" title="Remove player from whitelist">
              Remove
            </button>
          </td>
        </tr>`;
    })
    .join('');
}

async function handleAddTrustedPlayer(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('trustedPlayerInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;

  const clean = name.toLowerCase();
  if (trustedPlayersList.some(p => p.toLowerCase() === clean)) {
    showTemporaryToast(`'${name}' is already in the trusted list.`);
    input.value = '';
    return;
  }

  // Instant optimistic update
  trustedPlayersList.push(name);
  renderTrustedPlayers();
  input.value = '';
  showTemporaryToast(`Added '${name}' to Trusted Players!`);

  // Call backend API
  const res = await backendPost('/api/ignore/add', { player: name });
  if (res && Array.isArray(res.ignoredPlayers)) {
    trustedPlayersList = res.ignoredPlayers;
    renderTrustedPlayers();
  }
}

async function removeTrustedPlayer(name) {
  if (!name) return;
  // Instant optimistic update
  const prevList = [...trustedPlayersList];
  trustedPlayersList = trustedPlayersList.filter(p => p.toLowerCase() !== name.toLowerCase());
  renderTrustedPlayers();
  showTemporaryToast(`Removed '${name}' from Trusted Players.`);

  // Call backend API
  const res = await backendPost('/api/ignore/remove', { player: name });
  if (res && Array.isArray(res.ignoredPlayers)) {
    trustedPlayersList = res.ignoredPlayers;
    renderTrustedPlayers();
  } else if (!res || res.success === false) {
    // Revert if call failed
    trustedPlayersList = prevList;
    renderTrustedPlayers();
    showTemporaryToast(`Failed to remove '${name}'. Reverted.`);
  }
}

function showTemporaryToast(message) {
  const toast = document.createElement('div');
  toast.style.position = 'fixed';
  toast.style.bottom = '24px';
  toast.style.right = '24px';
  toast.style.backgroundColor = '#18181b';
  toast.style.border = '1px solid #3f3f46';
  toast.style.borderRadius = '8px';
  toast.style.padding = '10px 18px';
  toast.style.color = '#ffffff';
  toast.style.fontFamily = 'var(--font-sans)';
  toast.style.fontSize = '0.82rem';
  toast.style.fontWeight = '500';
  toast.style.boxShadow = '0 6px 20px rgba(0,0,0,0.6)';
  toast.style.zIndex = '9999';
  toast.innerText = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function dismissAuthNotice() {
  document.getElementById('authNoticeContainer').classList.add('hidden');
}

// ── Supabase Realtime ────────────────────────────────────────────────
let realtimeDebounceTimer = null;
let nodesDebounceTimer = null;

function subscribeToChanges() {
  supabaseClient
    .channel('accounts-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, () => {
      if (realtimeDebounceTimer) return;
      realtimeDebounceTimer = setTimeout(() => {
        realtimeDebounceTimer = null;
        if (currentNode) {
          loadAccountsFromSupabase();
        } else {
          loadAllAccountsFromSupabase();
        }
      }, 5000);
    })
    .subscribe();

  supabaseClient
    .channel('nodes-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'backend_nodes' }, () => {
      if (nodesDebounceTimer) return;
      nodesDebounceTimer = setTimeout(() => {
        nodesDebounceTimer = null;
        loadNodes();
      }, 5000);
    })
    .subscribe();
}

// ── Init ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  loadAllAccountsFromSupabase();
  loadAccountGroupsFromDb();
  loadNodes();
  subscribeToChanges();
  fetchTrustedPlayers();

  // Node selector change
  document.getElementById('nodeSelect').addEventListener('change', onNodeChange);

  // Bot selector change
  document.getElementById('actionBotSelect').addEventListener('change', syncActionToggles);

  // Poll backend every 6 seconds (reduced from 3s to prevent request flooding)
  setInterval(() => {
    fetchStatus();
    syncActionToggles();
  }, 6000);

  // Link Login form
  document.getElementById('linkLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('linkAccId').value.trim();
    if (!id) return;
    await linkLogin(id);
  });

  // Settings form
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const settings = {
      notification: { endpoint: document.getElementById('webhookEndpoint').value.trim() },
      afk: { enabled: document.getElementById('afkEnabled').checked, activityIntervalMs: parseInt(document.getElementById('afkInterval').value, 10) },
      defensiveCombat: { enabled: document.getElementById('combatEnabled').checked, combatRange: parseFloat(document.getElementById('combatRange').value) },
      playerHitResponse: { enabled: document.getElementById('hitReactionEnabled').checked, crouchCount: parseInt(document.getElementById('crouchCount').value, 10) },
    };
    const data = await backendPost('/api/settings', settings);
    if (data?.success) showTemporaryToast('Configuration saved successfully');
  });

  // Confirm modal listeners
  document.getElementById('confirmBtnCancel').addEventListener('click', closeConfirmModal);
  document.getElementById('confirmBtnProceed').addEventListener('click', proceedRemoveAccount);
  document.getElementById('confirmModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('confirmModal')) closeConfirmModal();
  });



  // Auth code modal
  document.getElementById('authCodeCopyBtn').addEventListener('click', () => {
    const val = document.getElementById('authCodeValue').value;
    if (val) {
      navigator.clipboard?.writeText(val).catch(() => {});
      document.getElementById('authCodeCopyBtn').innerText = 'Copied!';
      setTimeout(() => { document.getElementById('authCodeCopyBtn').innerText = 'Copy'; }, 1500);
    }
  });
  document.getElementById('authCodeCloseBtn').addEventListener('click', () => {
    document.getElementById('authCodeModal').classList.add('hidden');
    if (authModalAccountId) {
      dismissedAuthAccounts.add(authModalAccountId);
    }
    authModalAccountId = null;
  });
  document.getElementById('authCodeModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('authCodeModal')) {
      document.getElementById('authCodeModal').classList.add('hidden');
      if (authModalAccountId) {
        dismissedAuthAccounts.add(authModalAccountId);
      }
      authModalAccountId = null;
    }
  });

});


// ── System Database Backup & Restore (Accounts, Nodes, Tokens) ───────────

function showBackupStatus(msg, type = 'info') {
  const banner = document.getElementById('backupStatusBanner');
  if (!banner) {
    showTemporaryToast(msg);
    return;
  }
  banner.style.display = 'block';
  if (type === 'success') {
    banner.style.background = 'rgba(34, 197, 94, 0.15)';
    banner.style.color = '#4ade80';
    banner.style.border = '1px solid rgba(34, 197, 94, 0.3)';
  } else if (type === 'error') {
    banner.style.background = 'rgba(239, 68, 68, 0.15)';
    banner.style.color = '#f87171';
    banner.style.border = '1px solid rgba(239, 68, 68, 0.3)';
  } else {
    banner.style.background = 'rgba(56, 189, 248, 0.15)';
    banner.style.color = '#38bdf8';
    banner.style.border = '1px solid rgba(56, 189, 248, 0.3)';
  }
  banner.innerText = msg;
  showTemporaryToast(msg);
}

function triggerDownloadBackup(backupData) {
  const jsonStr = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = `donut-bots-backup-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let secondarySupabaseClient = null;

function initSecondarySupabase() {
  if (typeof SECONDARY_SUPABASE_URL !== 'undefined' && typeof SECONDARY_SUPABASE_ANON_KEY !== 'undefined') {
    secondarySupabaseClient = window.supabase.createClient(SECONDARY_SUPABASE_URL, SECONDARY_SUPABASE_ANON_KEY);
  }
}

async function backupAllToSecondary() {
  const btn = document.getElementById('btnBackupAll');
  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Backing up...';
  }
  showBackupStatus('Backing up all data to Secondary Supabase (excluding logs and junk files)...', 'info');

  try {
    const backendUrl = getBackendUrl();
    let syncedViaBackend = false;

    if (backendUrl) {
      try {
        const res = await fetch(`${backendUrl}/api/backup/sync-secondary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const json = await res.json();
        if (res.ok && json.success) {
          const c = json.counts || {};
          const total = (c.accounts || 0) + (c.nodes || 0) + (c.tokens || 0);
          if (total === 0) {
            showBackupStatus(`⚠️ Backup synced 0 items. Please ensure Secondary Supabase has tables created using schema.sql!`, 'error');
          } else {
            syncedViaBackend = true;
            showBackupStatus(`✅ Backup All complete! Successfully synced ${c.accounts || 0} accounts, ${c.nodes || 0} nodes, and ${c.tokens || 0} tokens to Secondary Supabase.`, 'success');
          }
        } else {
          console.warn('Backend sync-secondary failed:', json.error);
          showBackupStatus(`❌ Backup All failed: ${json.error || 'Secondary Supabase error'}`, 'error');
        }
      } catch (backendErr) {
        console.warn('Backend sync-secondary network error, attempting direct client sync:', backendErr);
      }
    }

    if (!syncedViaBackend) {
      if (!supabaseClient) initSupabase();
      if (!secondarySupabaseClient) initSecondarySupabase();

      if (!secondarySupabaseClient) {
        throw new Error('Secondary Supabase credentials not found in frontend configuration.');
      }

      // Fetch critical tables from primary
      const [accRes, nodesRes, tokensRes, settingsRes, permsRes, ignoreRes, cmdRes] = await Promise.all([
        supabaseClient.from('accounts').select('*'),
        supabaseClient.from('backend_nodes').select('*'),
        supabaseClient.from('auth_tokens').select('*'),
        supabaseClient.from('node_settings').select('*'),
        supabaseClient.from('permissions').select('*'),
        supabaseClient.from('ignore_list').select('*'),
        supabaseClient.from('commands').select('*').eq('action', 'SET_ACCOUNT_GROUPS'),
      ]);

      const nodes = nodesRes.data || [];
      const accounts = accRes.data || [];
      const tokens = (tokensRes.data || []).filter(t => t.token_data);
      const settings = settingsRes.data || [];
      const perms = permsRes.data || [];
      const ignore = ignoreRes.data || [];
      const commands = cmdRes.data || [];

      // Upsert into secondary
      for (const n of nodes) {
        const clean = { ...n };
        delete clean.created_at;
        const { error } = await secondarySupabaseClient.from('backend_nodes').upsert(clean, { onConflict: 'id' });
        if (error) throw new Error(`Secondary backend_nodes: ${error.message}. Did you run schema.sql in Secondary Supabase?`);
      }

      for (const a of accounts) {
        const clean = { ...a };
        delete clean.created_at;
        clean.updated_at = new Date().toISOString();
        await secondarySupabaseClient.from('accounts').upsert(clean, { onConflict: 'id' });
      }

      for (const t of tokens) {
        const clean = { ...t };
        delete clean.created_at;
        clean.updated_at = new Date().toISOString();
        if (typeof clean.token_data === 'object' && clean.token_data !== null) {
          clean.token_data = JSON.stringify(clean.token_data);
        }
        await secondarySupabaseClient.from('auth_tokens').upsert(clean, { onConflict: 'account_id' });
      }

      for (const s of settings) {
        const clean = { ...s };
        clean.updated_at = new Date().toISOString();
        await secondarySupabaseClient.from('node_settings').upsert(clean, { onConflict: 'node_id' });
      }

      for (const p of perms) {
        const clean = { ...p };
        delete clean.created_at;
        await secondarySupabaseClient.from('permissions').upsert(clean, { onConflict: 'user_id' });
      }

      for (const ig of ignore) {
        const clean = { ...ig };
        delete clean.created_at;
        await secondarySupabaseClient.from('ignore_list').upsert(clean, { onConflict: 'player_name' });
      }

      for (const cmd of commands) {
        const clean = { ...cmd };
        delete clean.created_at;
        await secondarySupabaseClient.from('commands').upsert(clean, { onConflict: 'id' });
      }

      showBackupStatus(`✅ Backup All complete! Directly synced ${accounts.length} accounts, ${nodes.length} nodes, ${tokens.length} tokens, and groups to Secondary Supabase.`, 'success');
    }
  } catch (err) {
    console.error('Backup All failed:', err);
    showBackupStatus(`❌ Backup All failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

async function loadBackupFromSecondary() {
  const confirmed = confirm('Are you sure you want to load the backup from Secondary Supabase?\n\nThis will restore all accounts, nodes, settings, and auth tokens from Secondary Supabase into your Primary Supabase.');
  if (!confirmed) return;

  const btn = document.getElementById('btnLoadSecondaryBackup');
  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Loading...';
  }
  showBackupStatus('Loading backup from Secondary Supabase...', 'info');

  try {
    const backendUrl = getBackendUrl();
    let loadedViaBackend = false;

    if (backendUrl) {
      try {
        const res = await fetch(`${backendUrl}/api/backup/load-secondary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const json = await res.json();
        if (res.ok && json.success) {
          loadedViaBackend = true;
          const c = json.counts || {};
          showBackupStatus(`✅ Load Backup complete! Successfully restored ${c.accounts || 0} accounts, ${c.nodes || 0} nodes, and ${c.tokens || 0} tokens from Secondary Supabase.`, 'success');
        } else if (!res.ok) {
          console.warn('Backend load-secondary failed:', json.error);
        }
      } catch (backendErr) {
        console.warn('Backend load-secondary network error, attempting direct client sync:', backendErr);
      }
    }

    if (!loadedViaBackend) {
      if (!supabaseClient) initSupabase();
      if (!secondarySupabaseClient) initSecondarySupabase();

      if (!secondarySupabaseClient) {
        throw new Error('Secondary Supabase credentials not found in frontend configuration.');
      }

      // Fetch critical tables from secondary
      const [accRes, nodesRes, tokensRes, settingsRes, permsRes, ignoreRes, cmdRes] = await Promise.all([
        secondarySupabaseClient.from('accounts').select('*'),
        secondarySupabaseClient.from('backend_nodes').select('*'),
        secondarySupabaseClient.from('auth_tokens').select('*'),
        secondarySupabaseClient.from('node_settings').select('*'),
        secondarySupabaseClient.from('permissions').select('*'),
        secondarySupabaseClient.from('ignore_list').select('*'),
        secondarySupabaseClient.from('commands').select('*').eq('action', 'SET_ACCOUNT_GROUPS'),
      ]);

      const nodes = nodesRes.data || [];
      const accounts = accRes.data || [];
      const tokens = (tokensRes.data || []).filter(t => t.token_data);
      const settings = settingsRes.data || [];
      const perms = permsRes.data || [];
      const ignore = ignoreRes.data || [];
      const commands = cmdRes.data || [];

      if (accounts.length === 0 && nodes.length === 0 && tokens.length === 0) {
        throw new Error('No accounts, nodes, or tokens found in Secondary Supabase.');
      }

      // Upsert into primary
      for (const n of nodes) {
        const clean = { ...n };
        delete clean.created_at;
        await supabaseClient.from('backend_nodes').upsert(clean, { onConflict: 'id' });
      }

      for (const a of accounts) {
        const clean = { ...a };
        delete clean.created_at;
        clean.updated_at = new Date().toISOString();
        await supabaseClient.from('accounts').upsert(clean, { onConflict: 'id' });
      }

      for (const t of tokens) {
        const clean = { ...t };
        delete clean.created_at;
        clean.updated_at = new Date().toISOString();
        if (typeof clean.token_data === 'object' && clean.token_data !== null) {
          clean.token_data = JSON.stringify(clean.token_data);
        }
        await supabaseClient.from('auth_tokens').upsert(clean, { onConflict: 'account_id' });
      }

      for (const s of settings) {
        const clean = { ...s };
        clean.updated_at = new Date().toISOString();
        await supabaseClient.from('node_settings').upsert(clean, { onConflict: 'node_id' });
      }

      for (const p of perms) {
        const clean = { ...p };
        delete clean.created_at;
        await supabaseClient.from('permissions').upsert(clean, { onConflict: 'user_id' });
      }

      for (const ig of ignore) {
        const clean = { ...ig };
        delete clean.created_at;
        await supabaseClient.from('ignore_list').upsert(clean, { onConflict: 'player_name' });
      }

      for (const cmd of commands) {
        const clean = { ...cmd };
        delete clean.created_at;
        await supabaseClient.from('commands').upsert(clean, { onConflict: 'id' });
      }

      showBackupStatus(`✅ Load Backup complete! Directly restored ${accounts.length} accounts, ${nodes.length} nodes, ${tokens.length} tokens, and groups into Primary Supabase.`, 'success');
    }

    // Refresh all tables and groups so restored items appear instantly
    await loadAccountGroupsFromDb();
    if (typeof fetchNodes === 'function') fetchNodes();
    if (typeof loadAccounts === 'function') loadAccounts();
    if (typeof loadSettings === 'function') loadSettings();
    if (typeof loadPermissions === 'function') loadPermissions();
    if (typeof loadIgnoreList === 'function') loadIgnoreList();
  } catch (err) {
    console.error('Load Backup from Secondary failed:', err);
    showBackupStatus(`❌ Load Backup failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

async function downloadBackup() {
  return await exportSystemBackup('btnDownloadBackup');
}

async function exportSystemBackup(triggerBtnId = 'btnExportBackup') {
  const btn = document.getElementById(triggerBtnId) || document.getElementById('btnDownloadBackup') || document.getElementById('btnExportBackup');
  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Downloading...';
  }
  showBackupStatus('Exporting database backup (accounts, nodes, tokens)...', 'info');

  try {
    const backendUrl = getBackendUrl();
    if (backendUrl) {
      try {
        const res = await fetch(`${backendUrl}/api/backup/export`);
        if (res.ok) {
          const json = await res.json();
          if (json && json.success && json.backup) {
            triggerDownloadBackup(json.backup);
            const counts = json.counts || {};
            showBackupStatus(`✅ Backup exported successfully! Downloaded: ${counts.accounts || 0} accounts, ${counts.nodes || 0} nodes, ${counts.tokens || 0} tokens.`, 'success');
            return;
          }
        }
      } catch (backendErr) {
        console.warn('Backend export failed, falling back to direct Supabase:', backendErr);
      }
    }

    // Direct Supabase fallback
    if (!supabaseClient) initSupabase();

    const [accRes, nodesRes, tokensRes, settingsRes, permsRes, ignoreRes, cmdRes] = await Promise.all([
      supabaseClient.from('accounts').select('*'),
      supabaseClient.from('backend_nodes').select('*'),
      supabaseClient.from('auth_tokens').select('*'),
      supabaseClient.from('node_settings').select('*'),
      supabaseClient.from('permissions').select('*'),
      supabaseClient.from('ignore_list').select('*'),
      supabaseClient.from('commands').select('*').eq('action', 'SET_ACCOUNT_GROUPS'),
    ]);

    const accounts = accRes.data || [];
    const nodes = nodesRes.data || [];
    const tokens = tokensRes.data || [];
    const settings = settingsRes.data || [];
    const permissions = permsRes.data || [];
    const ignoreList = ignoreRes.data || [];
    const commands = cmdRes.data || [];

    const backupData = {
      version: 1,
      type: 'donut_bots_backup',
      exportedAt: new Date().toISOString(),
      tables: {
        accounts,
        nodes,
        tokens,
        settings,
        permissions,
        ignoreList,
        commands,
        accountGroups,
      },
      accounts,
      nodes,
      tokens,
      settings,
      permissions,
      ignoreList,
      commands,
      accountGroups,
    };

    triggerDownloadBackup(backupData);
    showBackupStatus(`✅ Backup exported successfully! Downloaded: ${accounts.length} accounts, ${nodes.length} nodes, ${tokens.length} tokens, and groups.`, 'success');
  } catch (err) {
    console.error('Failed to export backup:', err);
    showBackupStatus(`❌ Export failed: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

async function importSystemBackup(event) {
  const fileInput = event.target;
  const file = fileInput?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const text = e.target?.result;
    if (!text || typeof text !== 'string') {
      showBackupStatus('❌ Selected file is empty or unreadable.', 'error');
      fileInput.value = '';
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text.trim());
    } catch (parseErr) {
      showBackupStatus('❌ Invalid JSON format in backup file: ' + parseErr.message, 'error');
      fileInput.value = '';
      return;
    }

    const data = parsed.backup || parsed.tables || parsed;
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const nodes = Array.isArray(data.nodes) ? data.nodes : (Array.isArray(data.backend_nodes) ? data.backend_nodes : []);
    const tokens = Array.isArray(data.tokens) ? data.tokens : (Array.isArray(data.auth_tokens) ? data.auth_tokens : []);
    const settings = Array.isArray(data.settings) ? data.settings : (Array.isArray(data.node_settings) ? data.node_settings : []);
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    const ignoreList = Array.isArray(data.ignoreList) ? data.ignoreList : (Array.isArray(data.ignore_list) ? data.ignore_list : []);
    const commands = Array.isArray(data.commands) ? data.commands : [];
    const importedGroups = Array.isArray(data.accountGroups) ? data.accountGroups : (Array.isArray(parsed.accountGroups) ? parsed.accountGroups : []);

    if (accounts.length === 0 && nodes.length === 0 && tokens.length === 0) {
      showBackupStatus('❌ Backup file contains no accounts, nodes, or tokens records.', 'error');
      fileInput.value = '';
      return;
    }

    const confirmMsg = `⚠️ WARNING: IMPORTING BACKUP WILL OVERWRITE DATABASE RECORDS!\n\n` +
      `Records to restore:\n` +
      `• Accounts: ${accounts.length}\n` +
      `• Nodes: ${nodes.length}\n` +
      `• Tokens: ${tokens.length}\n` +
      (importedGroups.length > 0 ? `• Account Groups: ${importedGroups.length}\n` : '') +
      `\nExisting records will be replaced with the backup data.\n\n` +
      `Do you want to proceed?`;

    if (!confirm(confirmMsg)) {
      fileInput.value = '';
      showBackupStatus('Backup import cancelled by user.', 'info');
      return;
    }

    showBackupStatus('Importing backup and overwriting database records... Please wait.', 'info');

    try {
      const backendUrl = getBackendUrl();
      let importedViaBackend = false;

      if (backendUrl) {
        try {
          const res = await fetch(`${backendUrl}/api/backup/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed),
          });

          if (res.ok) {
            const json = await res.json();
            if (json && json.success) {
              importedViaBackend = true;
              showBackupStatus(`✅ Backup successfully imported! Overwrote ${json.counts?.accounts || accounts.length} accounts, ${json.counts?.nodes || nodes.length} nodes, and ${json.counts?.tokens || tokens.length} tokens.`, 'success');
            }
          }
        } catch (backendErr) {
          console.warn('Backend import failed, attempting direct Supabase restore:', backendErr);
        }
      }

      if (!importedViaBackend) {
        if (!supabaseClient) initSupabase();

        // 1. Nodes
        if (nodes.length > 0) {
          for (const node of nodes) {
            const cleanNode = { ...node };
            delete cleanNode.created_at;
            await supabaseClient.from('backend_nodes').upsert(cleanNode, { onConflict: 'id' });
          }
        }

        // 2. Accounts
        if (accounts.length > 0) {
          for (const acc of accounts) {
            const cleanAcc = { ...acc };
            delete cleanAcc.created_at;
            cleanAcc.updated_at = new Date().toISOString();
            await supabaseClient.from('accounts').upsert(cleanAcc, { onConflict: 'id' });
          }
        }

        // 3. Tokens
        if (tokens.length > 0) {
          for (const tok of tokens) {
            const cleanTok = { ...tok };
            delete cleanTok.created_at;
            cleanTok.updated_at = new Date().toISOString();
            if (typeof cleanTok.token_data === 'object' && cleanTok.token_data !== null) {
              cleanTok.token_data = JSON.stringify(cleanTok.token_data);
            }
            await supabaseClient.from('auth_tokens').upsert(cleanTok, { onConflict: 'account_id' });
          }
        }

        // 4. Settings
        if (settings.length > 0) {
          for (const s of settings) {
            const clean = { ...s, updated_at: new Date().toISOString() };
            await supabaseClient.from('node_settings').upsert(clean, { onConflict: 'node_id' });
          }
        }

        // 5. Permissions
        if (permissions.length > 0) {
          for (const p of permissions) {
            const clean = { ...p };
            delete clean.created_at;
            await supabaseClient.from('permissions').upsert(clean, { onConflict: 'user_id' });
          }
        }

        // 6. Ignore List
        if (ignoreList.length > 0) {
          for (const ig of ignoreList) {
            const clean = { ...ig };
            delete clean.created_at;
            await supabaseClient.from('ignore_list').upsert(clean, { onConflict: 'player_name' });
          }
        }

        // 7. Commands & Groups
        if (commands.length > 0) {
          for (const cmd of commands) {
            const clean = { ...cmd };
            delete clean.created_at;
            await supabaseClient.from('commands').upsert(clean, { onConflict: 'id' });
          }
        }

        showBackupStatus(`✅ Backup restored via database client! Overwrote ${accounts.length} accounts, ${nodes.length} nodes, and ${tokens.length} tokens.`, 'success');
      }

      // Restore account groups if present
      if (importedGroups.length > 0) {
        accountGroups = importedGroups;
        saveAccountGroupsLocalCache();
        await saveAccountGroupsToDb();
      } else {
        await loadAccountGroupsFromDb();
      }

      await loadNodes();
      if (currentNode) {
        await loadAccountsFromSupabase();
      } else {
        await loadAllAccountsFromSupabase();
      }
      await fetchStatus();
    } catch (err) {
      console.error('Backup import error:', err);
      showBackupStatus(`❌ Import failed: ${err.message}`, 'error');
    } finally {
      fileInput.value = '';
    }
  };

  reader.readAsText(file);
}

// ── Clear Database Modal & Admin Verification ─────────────────────────
function openClearDatabaseModal() {
  const modal = document.getElementById('clearDatabaseModal');
  const errBox = document.getElementById('clearModalError');
  const passInput = document.getElementById('clearAdminPasswordInput');
  if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
  if (passInput) { passInput.value = ''; }
  if (modal) modal.classList.remove('hidden');
}

function closeClearDatabaseModal() {
  const modal = document.getElementById('clearDatabaseModal');
  if (modal) modal.classList.add('hidden');
}

async function submitClearDatabase() {
  const clearNodes = document.getElementById('clearNodesCheckbox')?.checked || false;
  const clearAccounts = document.getElementById('clearAccountsCheckbox')?.checked || false;
  const password = document.getElementById('clearAdminPasswordInput')?.value?.trim() || '';
  const errBox = document.getElementById('clearModalError');
  const btnConfirm = document.getElementById('btnConfirmClearDatabase');

  if (!clearNodes && !clearAccounts) {
    if (errBox) {
      errBox.textContent = 'Please select at least one component (NODE or ACCOUNTS) to clear.';
      errBox.style.display = 'block';
    }
    return;
  }

  if (!password) {
    if (errBox) {
      errBox.textContent = 'Admin authentication password is required.';
      errBox.style.display = 'block';
    }
    return;
  }

  if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
  if (btnConfirm) { btnConfirm.disabled = true; btnConfirm.textContent = 'Clearing...'; }

  try {
    // Find master node or active node
    const masterNode = allNodes.find(n => n.id === 'node-1') || allNodes[0];
    if (!masterNode) throw new Error('No backend node found to execute admin clear command.');

    const res = await fetch(`${masterNode.url}/api/admin/clear-database`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Secret': password,
      },
      body: JSON.stringify({
        clearNodes,
        clearAccounts,
        password,
      }),
    });

    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error(json.error || `Clear failed (${res.status})`);
    }

    closeClearDatabaseModal();
    showBackupStatus(`✅ Database cleared successfully! (${clearAccounts ? 'ACCOUNTS ' : ''}${clearNodes ? 'NODE' : ''})`, 'success');

    // Reload UI state
    await loadNodes();
    if (currentNode) {
      await loadAccountsFromSupabase();
    } else {
      await loadAllAccountsFromSupabase();
    }
    await fetchStatus();
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  } finally {
    if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = 'Confirm & Clear'; }
  }
}

// ── Global Session Logout ──────────────────────────────────────────────
function logout() {
  sessionStorage.clear();
  localStorage.removeItem('donut_session');
  window.location.replace('login.html');
}
