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
        /** @type {{ query: string, avatar_url?: string, group_id?: string }} */
        const body = { query: '' };
        if (entity.type === 'group') {
            body.group_id = entity.groupId;
        } else {
            body.avatar_url = entity.avatar;
        }
        const response = await fetch('/api/chats/search', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`Chat search failed: ${response.status}`);
        }
        const list = await response.json();
        return Array.isArray(list) ? sortChats(list) : [];
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
        const lines = [
            chatTitle(chat, entity),
            formatDate(chat.last_mes),
            `${chat.message_count ?? 0} messages`,
            chat.file_size ?? '',
        ];
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
                        <div id="qcs_drawer_manage" class="margin0 menu_button fa-solid fa-folder-open fa-fw interactable" title="Manage chat files" data-i18n="[title]Manage chat files"></div>
                        <div id="qcs_drawer_refresh" class="margin0 menu_button fa-solid fa-rotate fa-fw interactable" title="Refresh chat list" data-i18n="[title]Refresh chat list"></div>
                    </div>
                    <div class="flex-container widthFitContent">
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable"></div>
                    </div>
                </div>
                <div class="inline-drawer-content">
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
        for (const chat of chats) {
            const active = isActiveChat(entity, chat.file_name);
            const row = document.createElement('div');
            row.className = `qcs_chat_row${active ? ' qcs_active' : ''}`;
            row.title = chatTooltip(chat, entity);
            const name = document.createElement('span');
            name.className = 'qcs_chat_row_name';
            name.textContent = chatTitle(chat, entity);
            const meta = document.createElement('span');
            meta.className = 'qcs_chat_row_meta';
            meta.textContent = `${formatDate(chat.last_mes)} · ${chat.message_count ?? 0}`;
            row.append(name, meta);
            row.addEventListener('click', () => openChat(entity, chat.file_name));
            $list.append(row);
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
    // Feature C: chat picker from the favorite star (custom context menu,
    // same pattern as the Quick Reply extension's ContextMenu)
    // ------------------------------------------------------------------

    let longPressTimer = null;
    let longPressFired = false;

    function closeChatCtxMenu() {
        document.getElementById('qcs-ctx-blocker')?.remove();
    }

    function starFor(card) {
        return card?.querySelector('.ch_fav_icon, .group_fav_icon');
    }

    async function showChatCtxMenu(card, x, y) {
        const entity = entityFromCard(card);
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

    function bindStarPicker() {
        const starSelector = '#rm_print_characters_block .ch_fav_icon, #rm_print_characters_block .group_fav_icon';
        const cardOf = (el) => el.closest('.character_select, .group_select');

        $(document).on('contextmenu', starSelector, function (e) {
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
            showChatCtxMenu(cardOf(this), e.clientX, e.clientY);
        });

        $(document).on('pointerdown', starSelector, function (e) {
            if (!settings.starPicker || e.button !== 0) {
                return;
            }
            const star = this;
            const { clientX, clientY } = e;
            longPressFired = false;
            clearTimeout(longPressTimer);
            longPressTimer = setTimeout(() => {
                longPressFired = true;
                showChatCtxMenu(cardOf(star), clientX, clientY);
            }, LONG_PRESS_MS);
        });

        $(document).on('pointerup pointermove pointercancel', starSelector, () => {
            clearTimeout(longPressTimer);
        });

        // Swallow the click that follows a long-press so the card doesn't open
        $(document).on('click', starSelector, function (e) {
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
        on('CHAT_RENAMED', refreshStaleUI);
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

        try {
            const settingsHtml = await $.get(`${EXTENSION_FOLDER}/settings.html`);
            $('#extensions_settings').append(settingsHtml);
            wireSettingsUI();
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to load settings UI:`, err);
        }

        bindStarPicker();
        wireEvents();
        renderDrawerSection();
        console.debug(`[${MODULE_NAME}] loaded.`);
    }

    $(document).ready(() => init().catch((err) => console.error(`[${MODULE_NAME}] Init failed:`, err)));
})();
