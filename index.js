/**
 * Quick Chat Selector
 *
 * 1. Adds a "Chats" section to the character management drawer (after the tags,
 *    before the Creator's Notes) for quickly switching the character's chat.
 * 2. Shows the most recent chats as a single-line selector under each card in
 *    the character list (no wrapping, horizontally scrollable).
 * 3. Right-click / long-press the favorite star on a card to open a chat picker popup.
 *
 * Uses only public extension APIs (window.SillyTavern.getContext()); no core changes.
 */
(async function () {
    if (window.__quickChatSelectorLoaded) {
        return;
    }
    window.__quickChatSelectorLoaded = true;

    const EXTENSION_NAME = 'QuickChatSelector';
    const EXTENSION_FOLDER = 'scripts/extensions/third-party/QuickChatSelector';
    const MODULE_NAME = 'Quick Chat Selector';

    const CACHE_TTL_MS = 60000;
    const MAX_CONCURRENT_FETCHES = 4;
    const LONG_PRESS_MS = 500;
    const CHIP_MIN = 1;
    const CHIP_MAX = 10;
    const RENAME_MARKER_KEY = 'qcs_renamed_chats';
    const AI_RENAME_HEAD_MESSAGES = 10;
    const AI_RENAME_MAX_LENGTH = 90;
    const DESCRIPTION_METADATA_KEY = 'qcs_description';
    const DESCRIBE_PER_MESSAGE_CHARS = 1000;

    const DEFAULT_SETTINGS = {
        drawerSection: true,
        showCardLine: true,
        chipCount: 5,
        starPicker: true,
    };

    /** @type {import('../../../../scripts/st-context.js').Context} */
    let ctx = null;
    let settings = null;

    /**
     * The context object copies primitive values (characterId, groupId, chatId, ...)
     * at call time, so a cached reference goes stale. Always read primitives from a
     * fresh getContext(); only stable references (eventSource, functions, the
     * characters/groups arrays) may come from the cached ctx.
     */
    function getCtx() {
        return window.SillyTavern?.getContext?.() ?? ctx;
    }

    /** @type {Map<string, { ts: number, promise: Promise<object[]> }>} */
    const chatCache = new Map();
    /** old file name (no ext) -> actual new file name (no ext), from CHAT_RENAMED events */
    const renameEvents = new Map();
    let activeFetches = 0;
    /** @type {(() => void)[]} */
    const fetchQueue = [];

    // ------------------------------------------------------------------
    // Bootstrap helpers
    // ------------------------------------------------------------------

    function getContextSafe(retries = 40, interval = 250) {
        return new Promise((resolve) => {
            const attempt = (n) => {
                const context = window.SillyTavern?.getContext?.();
                if (context?.eventSource && context?.extensionSettings) {
                    return resolve(context);
                }
                if (n <= 0) {
                    return resolve(null);
                }
                setTimeout(() => attempt(n - 1), interval);
            };
            attempt(retries);
        });
    }

    function on(eventName, handler) {
        const types = ctx.eventTypes ?? ctx.event_types;
        const name = types?.[eventName];
        if (name) {
            ctx.eventSource.on(name, handler);
        } else {
            console.warn(`[${MODULE_NAME}] Unknown event: ${eventName}`);
        }
    }

    function clampChipCount(value) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(CHIP_MAX, Math.max(CHIP_MIN, Math.round(n))) : DEFAULT_SETTINGS.chipCount;
    }

    function loadSettings() {
        const store = ctx.extensionSettings;
        store[EXTENSION_NAME] = store[EXTENSION_NAME] || {};
        Object.assign(store[EXTENSION_NAME], { ...DEFAULT_SETTINGS, ...store[EXTENSION_NAME] });
        settings = store[EXTENSION_NAME];
    }

    // ------------------------------------------------------------------
    // Chat data layer
    // ------------------------------------------------------------------

    /**
     * @typedef {{ type: 'character', chid: number, avatar: string, name: string }} QcsCharacterEntity
     * @typedef {{ type: 'group', groupId: string, name: string }} QcsGroupEntity
     * @typedef {QcsCharacterEntity | QcsGroupEntity} QcsEntity
     */

    /** @param {QcsEntity} entity */
    function cacheKey(entity) {
        return entity.type === 'group' ? `group:${entity.groupId}` : `char:${entity.avatar}`;
    }

    function entityFromCard(card) {
        if (!ctx || !(card instanceof Element)) {
            return null;
        }
        if (card.classList.contains('group_select')) {
            const groupId = String(card.getAttribute('data-grid') ?? $(card).data('id') ?? '');
            const group = ctx.groups?.find((g) => g.id === groupId);
            return groupId ? { type: 'group', groupId, name: group?.name ?? 'Group' } : null;
        }
        if (!card.classList.contains('character_select')) {
            return null;
        }
        const chid = Number(card.getAttribute('data-chid'));
        const character = Number.isFinite(chid) ? ctx.characters?.[chid] : null;
        return character ? { type: 'character', chid, avatar: character.avatar, name: character.name } : null;
    }

    function currentOwnerKey() {
        const c = getCtx();
        if (!c) {
            return null;
        }
        if (c.groupId) {
            return `group:${c.groupId}`;
        }
        const chid = Number(c.characterId);
        const character = Number.isFinite(chid) ? c.characters?.[chid] : null;
        return character ? `char:${character.avatar}` : null;
    }

    function invalidateOwnerCache() {
        const key = currentOwnerKey();
        if (key) {
            chatCache.delete(key);
        }
    }

    function chatTime(chat) {
        try {
            const value = ctx.timestampToMoment ? ctx.timestampToMoment(chat.last_mes) : window.moment?.(chat.last_mes);
            const ms = value?.valueOf?.();
            if (Number.isFinite(ms)) {
                return ms;
            }
        } catch {
            // fall through
        }
        const n = Number(chat.last_mes);
        return Number.isFinite(n) ? n : 0;
    }

    function sortChats(chats) {
        return [...chats].sort((a, b) => chatTime(b) - chatTime(a));
    }

    async function fetchChats(entity) {
        if (entity.type === 'group') {
            const response = await fetch('/api/chats/search', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ query: '', group_id: entity.groupId }),
            });
            if (!response.ok) {
                throw new Error(`Chat search failed: ${response.status}`);
            }
            const list = await response.json();
            return Array.isArray(list) ? sortChats(list.map((chat) => ({ ...chat, description: '' }))) : [];
        }
        // Characters: single request that also returns each chat's metadata
        // (line 0 of the file), which carries our saved chat descriptions.
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: entity.avatar, metadata: true }),
        });
        if (!response.ok) {
            throw new Error(`Chat list failed: ${response.status}`);
        }
        const list = await response.json();
        if (!Array.isArray(list)) {
            return [];
        }
        return sortChats(list
            .filter((chat) => chat && chat.file_id)
            .map((chat) => ({
                file_name: chat.file_id,
                file_size: chat.file_size,
                message_count: chat.chat_items,
                last_mes: chat.last_mes,
                preview_message: typeof chat.mes === 'string' ? chat.mes.slice(0, 400) : '',
                description: typeof chat.chat_metadata?.[DESCRIPTION_METADATA_KEY] === 'string'
                    ? chat.chat_metadata[DESCRIPTION_METADATA_KEY]
                    : '',
            })));
    }

    /** Small semaphore so a list full of cards doesn't hammer the server. */
    async function withFetchSlot(fn) {
        if (activeFetches >= MAX_CONCURRENT_FETCHES) {
            await new Promise((resolve) => fetchQueue.push(resolve));
        }
        activeFetches++;
        try {
            return await fn();
        } finally {
            activeFetches--;
            fetchQueue.shift()?.();
        }
    }

    /** @returns {Promise<object[]>} sorted by last activity, cached per entity */
    function getChats(entity, { force = false } = {}) {
        const key = cacheKey(entity);
        const hit = chatCache.get(key);
        if (!force && hit && Date.now() - hit.ts < CACHE_TTL_MS) {
            return hit.promise;
        }
        const promise = withFetchSlot(() => fetchChats(entity)).catch((err) => {
            chatCache.delete(key);
            throw err;
        });
        chatCache.set(key, { ts: Date.now(), promise });
        return promise;
    }

    function isActiveChat(entity, fileName) {
        const c = getCtx();
        if (!c?.getCurrentChatId) {
            return false;
        }
        if (entity.type === 'group') {
            return c.groupId === entity.groupId && c.getCurrentChatId() === fileName;
        }
        return !c.groupId && Number(c.characterId) === entity.chid && c.getCurrentChatId() === fileName;
    }

    // ------------------------------------------------------------------
    // Presentation helpers
    // ------------------------------------------------------------------

    function chatTitle(chat, entity) {
        const name = String(chat.file_name ?? '');
        if (entity.type === 'group' && name.length > 13) {
            return `${name.slice(0, 13)}…`;
        }
        return name;
    }

    function formatDate(value) {
        try {
            const m = ctx.timestampToMoment ? ctx.timestampToMoment(value) : window.moment?.(value);
            if (m?.format) {
                return m.format('lll');
            }
        } catch {
            // fall through
        }
        const d = new Date(value);
        return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
    }

    function chatTooltip(chat, entity) {
        const lines = [chatTitle(chat, entity)];
        if (chat.description) {
            lines.push('', chat.description);
        }
        lines.push('', `${formatDate(chat.last_mes)} · ${chat.message_count ?? 0} messages`, chat.file_size ?? '');
        if (chat.preview_message) {
            lines.push('', chat.preview_message);
        }
        return lines.filter((x) => x !== '').join('\n');
    }

    // ------------------------------------------------------------------
    // Opening chats
    // ------------------------------------------------------------------

    let switching = false;

    async function openChat(entity, fileName) {
        if (switching) {
            return;
        }
        switching = true;
        try {
            if (entity.type === 'group') {
                await ctx.openGroupChat(entity.groupId, fileName);
            } else {
                const c = getCtx();
                const alreadyActive = !c.groupId && Number(c.characterId) === entity.chid;
                if (!alreadyActive) {
                    await ctx.selectCharacterById(entity.chid, { switchMenu: false });
                    const after = getCtx();
                    if (Number(after.characterId) !== entity.chid || after.groupId) {
                        window.toastr?.info('Please wait until the current chat is saved, then try again.', MODULE_NAME);
                        return;
                    }
                }
                await ctx.openCharacterChat(fileName);
            }
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to open chat:`, err);
            window.toastr?.error('Failed to open the chat. See console for details.', MODULE_NAME);
        } finally {
            switching = false;
        }
    }

    // ------------------------------------------------------------------
    // Feature A: drawer section (after tags, before Creator's Notes)
    // ------------------------------------------------------------------

    function injectDrawerSection() {
        if ($('#qcs_drawer_section').length > 0 || $('#spoiler_free_desc').length === 0) {
            return;
        }
        const section = $(`
            <div id="qcs_drawer_section" class="inline-drawer flex-container flexFlowColumn flexNoGap">
                <div class="inline-drawer-toggle inline-drawer-header padding0 gap5px standoutHeader">
                    <div class="title_restorable flexGap5 wide100p">
                        <span class="flex1" data-i18n="Chats">Chats</span>
                        <span id="qcs_drawer_count"></span>
                        <div id="qcs_drawer_ai_rename" class="margin0 menu_button fa-solid fa-wand-magic-sparkles fa-fw interactable" title="Rename chats with AI" data-i18n="[title]Rename chats with AI"></div>
                        <div id="qcs_drawer_manage" class="margin0 menu_button fa-solid fa-folder-open fa-fw interactable" title="Manage chat files" data-i18n="[title]Manage chat files"></div>
                        <div id="qcs_drawer_refresh" class="margin0 menu_button fa-solid fa-rotate fa-fw interactable" title="Refresh chat list" data-i18n="[title]Refresh chat list"></div>
                    </div>
                    <div class="flex-container widthFitContent">
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable"></div>
                    </div>
                </div>
                <div class="inline-drawer-content">
                    <div id="qcs_drawer_status" class="qcs_chat_hint"></div>
                    <div id="qcs_drawer_chat_list" class="qcs_chat_list"></div>
                </div>
            </div>
        `);
        $('#spoiler_free_desc').before(section);
        $('#qcs_drawer_manage').on('click', (e) => {
            e.stopPropagation();
            $('#option_select_chat').trigger('click');
        });
        $('#qcs_drawer_refresh').on('click', (e) => {
            e.stopPropagation();
            renderDrawerSection(true);
        });
        $('#qcs_drawer_ai_rename').on('click', (e) => {
            e.stopPropagation();
            aiRenameChats();
        });
    }

    function drawerTargetEntity() {
        if ($('#form_create').attr('actiontype') !== 'editcharacter') {
            return null;
        }
        const c = getCtx();
        const chid = Number(c.characterId);
        const character = Number.isFinite(chid) ? c.characters?.[chid] : null;
        return character ? { type: 'character', chid, avatar: character.avatar, name: character.name } : null;
    }

    async function renderDrawerSection(force = false) {
        const $section = $('#qcs_drawer_section');
        if ($section.length === 0) {
            return;
        }
        const entity = drawerTargetEntity();
        if (!settings.drawerSection || !entity) {
            $section.hide();
            return;
        }
        $section.show();
        const $list = $('#qcs_drawer_chat_list');
        $list.empty().append($('<div class="qcs_chat_hint">Loading chats…</div>'));
        $('#qcs_drawer_count').text('');
        let chats;
        try {
            chats = await getChats(entity, { force });
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to load chats for drawer:`, err);
            $list.empty().append($('<div class="qcs_chat_hint">Failed to load chats.</div>'));
            return;
        }
        if (drawerTargetEntity()?.chid !== entity.chid) {
            return; // drawer switched to another character while loading
        }
        $list.empty();
        $('#qcs_drawer_count').text(String(chats.length));
        if (chats.length === 0) {
            $list.append($('<div class="qcs_chat_hint">No chats yet.</div>'));
            return;
        }
        const renamedMap = getRenamedMap(entity.chid);
        for (const chat of chats) {
            const active = isActiveChat(entity, chat.file_name);
            const marked = !!renamedMap[chat.file_name];
            const row = document.createElement('div');
            row.className = `qcs_chat_row${active ? ' qcs_active' : ''}`;
            row.title = chatTooltip(chat, entity);
            const name = document.createElement('span');
            name.className = 'qcs_chat_row_name';
            name.textContent = chatTitle(chat, entity);
            const meta = document.createElement('span');
            meta.className = 'qcs_chat_row_meta';
            meta.textContent = `${formatDate(chat.last_mes)} · ${chat.message_count ?? 0}`;
            const marker = document.createElement('span');
            marker.className = `qcs_chat_row_marker fa-solid fa-tag interactable${marked ? ' qcs_marked' : ''}`;
            marker.title = marked
                ? 'Already renamed with AI — click to include it in the next AI rename'
                : 'Will be renamed by AI — click to mark it as already renamed';
            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleRenamedMarker(entity.chid, chat.file_name);
            });
            row.append(name, meta, marker);
            row.addEventListener('click', () => openChat(entity, chat.file_name));
            $list.append(row);
        }
    }

    // ------------------------------------------------------------------
    // Feature D: AI chat renaming (character editor Chats section)
    // ------------------------------------------------------------------

    /**
     * Marker map of chats already renamed by AI, persisted on the character
     * card at data.extensions.qcs_renamed_chats -> { [fileName]: true }.
     */
    function getRenamedMap(chid) {
        const map = ctx.characters?.[chid]?.data?.extensions?.[RENAME_MARKER_KEY];
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }

    async function saveRenamedMap(chid, map) {
        await ctx.writeExtensionField(chid, RENAME_MARKER_KEY, map);
    }

    async function toggleRenamedMarker(chid, fileName) {
        const map = getRenamedMap(chid);
        if (map[fileName]) {
            delete map[fileName];
        } else {
            map[fileName] = true;
        }
        await saveRenamedMap(chid, map);
        renderDrawerSection();
    }

    function setDrawerStatus(text) {
        $('#qcs_drawer_status').text(text ?? '');
    }

    /** Loads only the first few messages of a chat (header line is skipped). */
    async function fetchChatHead(entity, fileName) {
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: entity.avatar, file_name: fileName }),
        });
        if (!response.ok) {
            throw new Error(`Chat load failed: ${response.status}`);
        }
        const lines = await response.json();
        if (!Array.isArray(lines)) {
            return [];
        }
        return lines.slice(1, 1 + AI_RENAME_HEAD_MESSAGES);
    }

    function buildRenamePrompt(entity, messages) {
        const transcript = messages
            .map((m) => {
                const who = m.name || (m.is_user ? 'User' : entity.name);
                const text = String(m.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
                return `${who}: ${text}`;
            })
            .join('\n');
        return [
            'You name chat log files. Below are the first messages of a roleplay chat. Output a new file name for it.',
            'Rules:',
            '- Reply with ONLY the new file name. No quotes, no explanation, no trailing punctuation.',
            '- Format: Name - Description (name, space, hyphen, space, short description).',
            '- Name: the first name of the main FEMALE character if one appears in the messages; otherwise the first name of the main non-user character; otherwise the user persona name.',
            '- Description: what the chat is about (scenario, setting, relationship or theme) in at most 12 words. The shorter the better.',
            '- The name may be cut off at the end, so put the most identifying words first: name first, then the strongest keywords. Never end with filler.',
            '- Total length under 80 characters.',
            '',
            'Chat messages:',
            transcript,
        ].join('\n');
    }

    /** Strips everything the server-side file name sanitizer would strip. */
    function sanitizeChatName(raw) {
        return String(raw ?? '')
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .replace(/[\\/:*?"<>|]/g, '')
            .replace(/\s+/g, ' ')
            .replace(/^["'\s]+|["'\s.]+$/g, '')
            .trim()
            .slice(0, AI_RENAME_MAX_LENGTH)
            .replace(/[\s.]+$/, '')
            .trim();
    }

    /** Reasoning models occasionally refuse to summarize adult content; their
     *  refusal text must never be used as a chat name. */
    const REFUSAL_RE = /^\s*(i can'?t|i can not|i cannot|i'm sorry|i am sorry|sorry|i apologize|unfortunately|as an ai|i'm unable|i am unable|unable)\b/i;

    /**
     * One LLM call -> proposed file name for a chat, or null when there is nothing to summarize.
     * Uses generateRaw so only the naming prompt is sent — no chat history, no world info.
     * Reasoning models occasionally return an empty message; retry once before giving up.
     */
    async function proposeChatName(entity, fileName) {
        const messages = await fetchChatHead(entity, fileName);
        if (messages.length === 0) {
            return null;
        }
        const prompt = buildRenamePrompt(entity, messages);
        let name = '';
        for (let attempt = 0; attempt < 2 && !name; attempt++) {
            try {
                const result = await ctx.generateRaw({
                    prompt,
                    systemPrompt: 'You name chat log files. Follow the rules exactly and reply with only the file name.',
                });
                if (REFUSAL_RE.test(result)) {
                    throw new Error('LLM refused to name this chat');
                }
                name = sanitizeChatName(result);
            } catch (err) {
                if (attempt > 0) {
                    throw err;
                }
                console.debug(`[${MODULE_NAME}] Rename generation retry for "${fileName}":`, err);
            }
        }
        if (!name) {
            throw new Error('LLM returned an empty name');
        }
        return name;
    }

    let aiRenaming = false;

    async function aiRenameChats() {
        const entity = drawerTargetEntity();
        if (!entity || entity.type !== 'character' || aiRenaming) {
            return;
        }
        let chats;
        try {
            chats = await getChats(entity);
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to load chats for AI rename:`, err);
            window.toastr?.error('Failed to load chats. See console for details.', MODULE_NAME);
            return;
        }
        const renamedMap = getRenamedMap(entity.chid);
        const targets = chats.filter((chat) => !renamedMap[chat.file_name] && (Number(chat.message_count) || 0) > 0);
        if (targets.length === 0) {
            window.toastr?.info('No chats pending an AI rename. Unmark a chat (tag icon) to rename it again.', MODULE_NAME);
            return;
        }

        const result = await ctx.Popup.show.confirm(
            `Rename ${targets.length} chat${targets.length === 1 ? '' : 's'} with AI?`,
            'The first 10 messages of each unmarked chat are sent to the LLM to generate a short name (one call per chat). Original file names will be replaced. Renamed chats are marked and skipped next time.',
        );
        if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        aiRenaming = true;
        const $button = $('#qcs_drawer_ai_rename').addClass('fa-spin');
        let renamed = 0;
        let failed = 0;
        try {
            for (const [index, chat] of targets.entries()) {
                setDrawerStatus(`Renaming chats with AI: ${index + 1}/${targets.length}…`);
                try {
                    const proposed = await proposeChatName(entity, chat.file_name);
                    if (!proposed) {
                        continue; // empty chat, nothing to summarize; leave unmarked
                    }
                    let newName;
                    if (proposed.toLowerCase() === chat.file_name.toLowerCase()) {
                        newName = chat.file_name; // LLM kept the name; just mark it done
                    } else {
                        renameEvents.clear();
                        await ctx.renameChat(chat.file_name, proposed);
                        newName = renameEvents.get(chat.file_name);
                    }
                    if (!newName) {
                        throw new Error('Rename failed');
                    }
                    delete renamedMap[chat.file_name];
                    renamedMap[newName] = true;
                    await saveRenamedMap(entity.chid, renamedMap);
                    renamed++;
                } catch (err) {
                    failed++;
                    console.error(`[${MODULE_NAME}] AI rename failed for "${chat.file_name}":`, err);
                    if (index === 0) {
                        // First chat failing usually means no working API connection
                        window.toastr?.error('AI rename failed. Check that an API connection is configured and working.', MODULE_NAME);
                        break;
                    }
                    window.toastr?.warning(`Could not rename: ${chat.file_name}`, MODULE_NAME);
                }
            }
        } finally {
            aiRenaming = false;
            $button.removeClass('fa-spin');
            setDrawerStatus('');
            chatCache.delete(cacheKey(entity));
            renderDrawerSection(true);
        }
        if (renamed > 0) {
            window.toastr?.success(`Renamed ${renamed} chat${renamed === 1 ? '' : 's'} with AI${failed ? `, ${failed} failed` : ''}.`, MODULE_NAME);
        }
    }

    // ------------------------------------------------------------------
    // Feature E: LLM description of the current chat (extensions menu)
    // ------------------------------------------------------------------

    function injectExtensionsMenuButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!(menu instanceof HTMLElement) || document.getElementById('qcs_describe_button')) {
            return;
        }
        const button = document.createElement('div');
        button.id = 'qcs_describe_button';
        button.classList.add('list-group-item', 'flex-container', 'flexGap5');
        const icon = document.createElement('div');
        icon.classList.add('fa-solid', 'fa-file-pen', 'extensionsMenuExtensionButton');
        const label = document.createElement('span');
        label.textContent = 'Describe Current Chat';
        button.append(icon, label);
        button.title = 'Sends the current chat to the LLM for a short description, shown when hovering chats in the Chats overview.';
        button.addEventListener('click', () => describeCurrentChat());
        menu.appendChild(button);
    }

    function getCurrentChatEntity() {
        const c = getCtx();
        if (c.groupId) {
            const group = ctx.groups?.find((g) => g.id === c.groupId);
            return group ? { type: 'group', groupId: c.groupId, name: group.name } : null;
        }
        const chid = Number(c.characterId);
        const character = Number.isFinite(chid) ? c.characters?.[chid] : null;
        return character ? { type: 'character', chid, avatar: character.avatar, name: character.name } : null;
    }

    function buildDescribePrompt(entity) {
        const transcript = (ctx.chat ?? [])
            .filter((m) => m && !m.is_system)
            .map((m) => {
                const who = m.name || (m.is_user ? 'User' : entity.name);
                const text = String(m.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, DESCRIBE_PER_MESSAGE_CHARS);
                return `${who}: ${text}`;
            })
            .join('\n');
        return [
            'You write summaries of roleplay chats. Below is the full transcript of one chat. Write a summary of AT MOST 300 words that covers:',
            '1. What the chat is about: the premise, setting and ongoing storyline.',
            '2. The main characters: their names, who they are, and how they relate to each other.',
            '3. Where the chat left off: the most recent events and how the story currently stands.',
            'Write flowing prose without markdown, lists or headers. Do not address the reader.',
            '',
            'Chat transcript:',
            transcript,
        ].join('\n');
    }

    function cleanDescription(raw) {
        return String(raw ?? '')
            .replace(/\s+/g, ' ')
            .replace(/^["'\s]+|["'\s]+$/g, '')
            .trim()
            .slice(0, 2500)
            .trim();
    }

    let describing = false;

    async function describeCurrentChat() {
        if (describing) {
            return;
        }
        const entity = getCurrentChatEntity();
        if (!entity) {
            window.toastr?.info('No chat is currently open.', MODULE_NAME);
            return;
        }
        const messageCount = (ctx.chat ?? []).filter((m) => m && !m.is_system).length;
        if (messageCount === 0) {
            window.toastr?.info('The current chat is empty.', MODULE_NAME);
            return;
        }
        describing = true;
        const $icon = $('#qcs_describe_button .extensionsMenuExtensionButton').addClass('fa-spin');
        try {
            const prompt = buildDescribePrompt(entity);
            let description = '';
            for (let attempt = 0; attempt < 2 && !description; attempt++) {
                try {
                    const result = await ctx.generateRaw({
                        prompt,
                        systemPrompt: 'You summarize roleplay chat transcripts. Follow the instructions exactly and reply with the summary only.',
                    });
                    if (REFUSAL_RE.test(result)) {
                        throw new Error('LLM refused to describe this chat');
                    }
                    description = cleanDescription(result);
                } catch (err) {
                    if (attempt > 0) {
                        throw err;
                    }
                    console.debug(`[${MODULE_NAME}] Describe retry for current chat:`, err);
                }
            }
            if (!description) {
                throw new Error('LLM returned an empty description');
            }
            const c = getCtx();
            c.chatMetadata[DESCRIPTION_METADATA_KEY] = description;
            await c.saveMetadata();
            const key = currentOwnerKey();
            if (key) {
                chatCache.delete(key);
            }
            renderDrawerSection(true);
            // Show the result right away
            await ctx.Popup.show.text(
                `Chat Description — ${entity.name}`,
                description,
                { allowVerticalScrolling: true },
            );
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to describe current chat:`, err);
            window.toastr?.error('Failed to describe the chat. Check that an API connection is configured and working.', MODULE_NAME);
        } finally {
            describing = false;
            $icon.removeClass('fa-spin');
        }
    }

    // ------------------------------------------------------------------
    // Feature B: single-line chat selector under each card
    // ------------------------------------------------------------------

    const cardObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) {
                continue;
            }
            cardObserver.unobserve(entry.target);
            fillCardLine(entry.target);
        }
    }, { rootMargin: '200px 0px' });

    function onCharacterPageLoaded() {
        if (!settings.showCardLine) {
            return;
        }
        const list = document.getElementById('rm_print_characters_block');
        if (!list) {
            return;
        }
        for (const card of list.querySelectorAll('.character_select, .group_select')) {
            if (card.querySelector(':scope > .qcs_chat_line')) {
                continue;
            }
            const entity = entityFromCard(card);
            if (!entity) {
                continue;
            }
            card.dataset.qcsKey = cacheKey(entity);
            card.classList.add('qcs_has_line');
            const line = document.createElement('div');
            line.className = 'qcs_chat_line';
            card.appendChild(line);
            cardObserver.observe(card);
        }
    }

    async function fillCardLine(card) {
        if (!card.isConnected) {
            return;
        }
        const line = card.querySelector(':scope > .qcs_chat_line');
        const entity = entityFromCard(card);
        if (!line || !entity || !settings.showCardLine) {
            return;
        }
        let chats;
        try {
            chats = await getChats(entity);
        } catch (err) {
            console.warn(`[${MODULE_NAME}] Failed to load chats for card:`, err);
            line.innerHTML = '';
            return;
        }
        if (!card.isConnected) {
            return;
        }
        line.innerHTML = '';
        const top = chats.slice(0, clampChipCount(settings.chipCount));
        for (const chat of top) {
            const chip = document.createElement('div');
            chip.className = `qcs_chip${isActiveChat(entity, chat.file_name) ? ' qcs_active' : ''}`;
            chip.textContent = chatTitle(chat, entity);
            chip.title = chatTooltip(chat, entity);
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                openChat(entity, chat.file_name);
            });
            line.appendChild(chip);
        }
    }

    function removeAllCardLines() {
        cardObserver.disconnect();
        $('.qcs_chat_line').remove();
        $('.qcs_has_line').removeClass('qcs_has_line').removeAttr('data-qcs-key');
    }

    function refreshLinesForKey(key) {
        if (!key) {
            return;
        }
        for (const line of document.querySelectorAll('.qcs_chat_line')) {
            const card = line.parentElement;
            if (card?.dataset?.qcsKey === key) {
                line.innerHTML = '';
                fillCardLine(card);
            }
        }
    }

    // ------------------------------------------------------------------
    // Feature C: chat picker on the HotSwaps favorite avatars (custom context
    // menu, same pattern as the Quick Reply extension's ContextMenu)
    // ------------------------------------------------------------------

    let longPressTimer = null;
    let longPressFired = false;

    function closeChatCtxMenu() {
        document.getElementById('qcs-ctx-blocker')?.remove();
    }

    async function showChatCtxMenu(entity, x, y) {
        if (!entity) {
            return;
        }
        let chats;
        try {
            chats = await getChats(entity);
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to load chats for picker:`, err);
            window.toastr?.error('Failed to load chats. See console for details.', MODULE_NAME);
            return;
        }
        if (chats.length === 0) {
            window.toastr?.info('No chats found for this character.', MODULE_NAME);
            return;
        }

        closeChatCtxMenu();
        const blocker = document.createElement('div');
        blocker.id = 'qcs-ctx-blocker';
        const menu = document.createElement('ul');
        menu.className = 'list-group qcs-ctx-menu';

        const header = document.createElement('li');
        header.className = 'qcs-ctx-header';
        header.textContent = entity.name;
        menu.appendChild(header);

        for (const chat of chats) {
            const li = document.createElement('li');
            li.className = `list-group-item qcs-ctx-item${isActiveChat(entity, chat.file_name) ? ' qcs_active_chat' : ''}`;
            li.title = chatTooltip(chat, entity);
            const name = document.createElement('span');
            name.className = 'qcs-ctx-name';
            name.textContent = chatTitle(chat, entity);
            const meta = document.createElement('span');
            meta.className = 'qcs-ctx-meta';
            meta.textContent = formatDate(chat.last_mes);
            li.append(name, meta);
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                closeChatCtxMenu();
                openChat(entity, chat.file_name);
            });
            menu.appendChild(li);
        }

        // Close when clicking (or right-clicking) anywhere outside the menu
        blocker.addEventListener('click', closeChatCtxMenu);
        blocker.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            closeChatCtxMenu();
        });

        blocker.appendChild(menu);
        document.body.appendChild(blocker);

        // Anchor the menu at the cursor, clamped to the viewport
        const maxX = window.innerWidth - menu.offsetWidth - 8;
        const maxY = window.innerHeight - menu.offsetHeight - 8;
        menu.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
    }

    function bindHotswapPicker() {
        // Favorite avatars in the hotswap strip on top of the character management
        // drawer (core makes these .character_select/.group_select elements)
        const hotswapSelector = '#right-nav-panel .hotswap .avatar[data-type="character"], #right-nav-panel .hotswap .avatar[data-type="group"]';

        $(document).on('contextmenu', hotswapSelector, function (e) {
            if (!settings.starPicker) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (longPressFired) {
                // Long-press timer already opened the picker (Android fires both)
                return;
            }
            clearTimeout(longPressTimer);
            showChatCtxMenu(entityFromCard(this), e.clientX, e.clientY);
        });

        $(document).on('pointerdown', hotswapSelector, function (e) {
            if (!settings.starPicker || e.button !== 0) {
                return;
            }
            const avatar = this;
            const { clientX, clientY } = e;
            longPressFired = false;
            clearTimeout(longPressTimer);
            longPressTimer = setTimeout(() => {
                longPressFired = true;
                showChatCtxMenu(entityFromCard(avatar), clientX, clientY);
            }, LONG_PRESS_MS);
        });

        $(document).on('pointerup pointermove pointercancel', hotswapSelector, () => {
            clearTimeout(longPressTimer);
        });

        // Swallow the click that follows a long-press so the avatar doesn't open
        $(document).on('click', hotswapSelector, function (e) {
            if (longPressFired) {
                longPressFired = false;
                e.preventDefault();
                e.stopPropagation();
            }
        });
    }

    // ------------------------------------------------------------------
    // Settings UI
    // ------------------------------------------------------------------

    function wireSettingsUI() {
        $('#qcs_enable_drawer')
            .prop('checked', settings.drawerSection)
            .on('change', function () {
                settings.drawerSection = this.checked;
                ctx.saveSettingsDebounced();
                renderDrawerSection(true);
            });
        $('#qcs_enable_card_line')
            .prop('checked', settings.showCardLine)
            .on('change', function () {
                settings.showCardLine = this.checked;
                ctx.saveSettingsDebounced();
                if (this.checked) {
                    onCharacterPageLoaded();
                } else {
                    removeAllCardLines();
                }
            });
        $('#qcs_enable_star_picker')
            .prop('checked', settings.starPicker)
            .on('change', function () {
                settings.starPicker = this.checked;
                ctx.saveSettingsDebounced();
            });
        $('#qcs_chip_count')
            .val(settings.chipCount)
            .on('change', function () {
                settings.chipCount = clampChipCount(this.value);
                this.value = settings.chipCount;
                ctx.saveSettingsDebounced();
                for (const line of document.querySelectorAll('.qcs_chat_line')) {
                    line.innerHTML = '';
                    if (line.parentElement) {
                        fillCardLine(line.parentElement);
                    }
                }
            });
    }

    // ------------------------------------------------------------------
    // Event wiring / init
    // ------------------------------------------------------------------

    function refreshStaleUI() {
        const key = currentOwnerKey();
        invalidateOwnerCache();
        renderDrawerSection();
        refreshLinesForKey(key);
    }

    function wireEvents() {
        on('CHARACTER_PAGE_LOADED', () => onCharacterPageLoaded());
        on('CHARACTER_EDITOR_OPENED', () => renderDrawerSection());
        on('CHAT_CHANGED', refreshStaleUI);
        on('CHAT_CREATED', refreshStaleUI);
        on('CHAT_RENAMED', (/** @type {{ oldFileName?: string, newFileName?: string }} */ data) => {
            if (data?.oldFileName && data?.newFileName) {
                renameEvents.set(
                    String(data.oldFileName).replace(/\.jsonl$/, ''),
                    String(data.newFileName).replace(/\.jsonl$/, ''),
                );
            }
            refreshStaleUI();
        });
        on('CHAT_DELETED', refreshStaleUI);
        on('CHARACTER_DELETED', (/** @type {{ character?: { avatar?: string } }} */ data) => {
            if (data?.character?.avatar) {
                chatCache.delete(`char:${data.character.avatar}`);
            }
        });
    }

    async function init() {
        ctx = await getContextSafe();
        if (!ctx) {
            console.error(`[${MODULE_NAME}] SillyTavern context not available, extension disabled.`);
            return;
        }
        loadSettings();

        injectDrawerSection();
        injectExtensionsMenuButton();

        try {
            const settingsHtml = await $.get(`${EXTENSION_FOLDER}/settings.html`);
            $('#extensions_settings').append(settingsHtml);
            wireSettingsUI();
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to load settings UI:`, err);
        }

        bindHotswapPicker();
        wireEvents();
        renderDrawerSection();
        console.debug(`[${MODULE_NAME}] loaded.`);
    }

    $(document).ready(() => init().catch((err) => console.error(`[${MODULE_NAME}] Init failed:`, err)));
})();
