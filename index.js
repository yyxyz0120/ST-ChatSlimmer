import {
    chat,
    saveChat,
    saveChatConditional,
    reloadCurrentChat,
    isChatSaving,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { waitUntilCondition } from '../../../utils.js';
import { selected_group } from '../../../group-chats.js';
import {
    CHAT_SLIMMER_VERSION,
    planReasoningStrip,
    planHiddenDelete,
    planSwipeClean,
    planTextFilterClean,
    stripReasoningFromMessage,
    cleanSwipesFromMessage,
    applyTextFilterToMessage,
    normalizeTextFilterRules,
    DEFAULT_TEXT_FILTER_RULES,
    formatBytes,
    formatFloorRange,
    clampInt,
} from './core.js';

const MODULE_NAME = 'ST-ChatSlimmer';
const SETTINGS_KEY = 'chat_slimmer';
const MENU_BUTTON_ID = 'chat_slimmer_button';

const DEFAULT_SETTINGS = Object.freeze({
    reasoningKeepFloors: 10,
    swipeKeepFloors: 10,
    hiddenKeepFloors: 10,
    protectOpening: true,
    textFilterKeepFloors: 0,
    textFilterRules: DEFAULT_TEXT_FILTER_RULES.map(r => ({ ...r })),
});

let popupContent = null;
let isBusy = false;

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }
    const s = extension_settings[SETTINGS_KEY];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = Array.isArray(v) ? v.map(item => ({ ...item })) : v;
    }
    if (!Array.isArray(s.textFilterRules)) {
        s.textFilterRules = DEFAULT_TEXT_FILTER_RULES.map(r => ({ ...r }));
    }
    return s;
}

function saveSettings() {
    saveSettingsDebounced();
}

// Reliably persist the (already-mutated) in-memory chat to disk.
//
// We deliberately do NOT use saveChatConditional here: with a large chat on a
// slow server it can hit `waitUntilCondition(!isChatSaving)`, time out, and
// silently `return` without saving — while our UI still claims success. We also
// want to bypass the integrity check, since a bulk strip/delete is an
// intentional rewrite. So we wait for any in-flight save to settle, then call
// saveChat({ force: true }) directly (group chats fall back to the conditional
// path because saveChat refuses to run for groups).
async function persistChat() {
    try {
        await waitUntilCondition(() => !isChatSaving, 60000, 100);
    } catch {
        // Proceed anyway: attempting the save is better than skipping silently.
    }
    if (selected_group) {
        await saveChatConditional();
    } else {
        await saveChat({ force: true });
    }
}

function notify(kind, message) {
    if (typeof toastr !== 'undefined' && toastr[kind]) {
        toastr[kind](message, MODULE_NAME);
    } else {
        console.log(`[${MODULE_NAME}] ${message}`);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

async function confirmAction(message) {
    try {
        const res = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', {
            okButton: '确认执行',
            cancelButton: '取消',
        });
        return Boolean(res);
    } catch {
        return false;
    }
}

function readTextFilterRulesFromUi() {
    if (!popupContent) return normalizeTextFilterRules(getSettings().textFilterRules);
    const rules = [];
    popupContent.find('.cs-filter-rule').each(function () {
        const start = $(this).find('.cs-filter-start').val();
        const end = $(this).find('.cs-filter-end').val();
        rules.push({ start: String(start ?? ''), end: String(end ?? '') });
    });
    return normalizeTextFilterRules(rules);
}

function syncTextFilterRulesToSettings() {
    const rules = readTextFilterRulesFromUi();
    getSettings().textFilterRules = rules.map(r => ({ ...r }));
    saveSettings();
    return rules;
}

function formatTextFilterRuleSummary(rule) {
    if (rule.start && rule.end) return `${escapeHtml(rule.start)} → ${escapeHtml(rule.end)}`;
    if (rule.start) return `${escapeHtml(rule.start)}（无结束标记，删除起始文本）`;
    return `（文首）→ ${escapeHtml(rule.end)}`;
}

function renderTextFilterRules(rules) {
    if (!popupContent) return;
    const list = popupContent.find('#cs_filter_rules');
    list.empty();
    const rows = Array.isArray(rules) && rules.length ? rules : [{ start: '', end: '' }];
    for (const rule of rows) {
        list.append(buildTextFilterRuleRow({
            start: String(rule?.start ?? ''),
            end: String(rule?.end ?? ''),
        }));
    }
}

function buildTextFilterRuleRow(rule = { start: '', end: '' }) {
    return $(`
        <div class="cs-filter-rule">
            <input type="text" class="text_pole cs-filter-start" placeholder="起始标记，如 &lt;disclaimer&gt;" value="${escapeHtml(rule.start)}" />
            <span class="cs-filter-arrow" title="至">↓</span>
            <input type="text" class="text_pole cs-filter-end" placeholder="结束标记（可空）" value="${escapeHtml(rule.end)}" />
            <div class="menu_button cs-filter-del" title="删除此规则"><i class="fa-solid fa-xmark"></i></div>
        </div>
    `);
}

function recomputePreview() {
    if (!popupContent) return;
    const s = getSettings();
    const total = Array.isArray(chat) ? chat.length : 0;
    popupContent.find('#cs_total').text(String(total));

    const rPlan = planReasoningStrip(chat, s.reasoningKeepFloors);
    const swPlan = planSwipeClean(chat, s.swipeKeepFloors);
    const hPlan = planHiddenDelete(chat, s.hiddenKeepFloors, s.protectOpening);
    const tfRules = readTextFilterRulesFromUi();
    const tfPlan = planTextFilterClean(chat, s.textFilterKeepFloors, tfRules);

    popupContent.find('#cs_reasoning_preview').html(
        rPlan.targets.length
            ? `处理范围：楼层 #0 ~ #${rPlan.cutoff - 1}（保留最近 ${rPlan.keepFloors} 层）<br>`
              + `含思维链楼层：<b>${rPlan.targets.length}</b> 层 ｜ 预计释放 <b>${formatBytes(rPlan.bytes)}</b>`
            : `保留最近 ${rPlan.keepFloors} 层；更早楼层中没有可剥离的思维链。`,
    );

    popupContent.find('#cs_swipe_preview').html(
        swPlan.targets.length
            ? `处理范围：楼层 #0 ~ #${swPlan.cutoff - 1}（保留最近 ${swPlan.keepFloors} 层）<br>`
              + `含冗余 Swipe 楼层：<b>${swPlan.targets.length}</b> 层 ｜ 预计释放 <b>${formatBytes(swPlan.bytes)}</b>`
            : `保留最近 ${swPlan.keepFloors} 层；更早楼层中没有可清理的 Swipe。`,
    );

    popupContent.find('#cs_hidden_preview').html(
        hPlan.targets.length
            ? `处理范围：楼层 #0 ~ #${hPlan.cutoff - 1}（保留最近 ${hPlan.keepFloors} 层${hPlan.protectOpening ? '，保护开场白' : ''}）<br>`
              + `隐藏楼层：<b>${hPlan.targets.length}</b> 个（${formatFloorRange(hPlan.targets)}）｜ 预计释放 <b>${formatBytes(hPlan.bytes)}</b>`
            : `保留最近 ${hPlan.keepFloors} 层；更早楼层中没有隐藏楼层可删除。`,
    );

    const ruleSummary = tfPlan.rules.length
        ? tfPlan.rules.map((r, i) => `#${i + 1} ${formatTextFilterRuleSummary(r)}`).join('<br>')
        : '尚未配置有效规则（起始或结束标记至少填一项）。';

    popupContent.find('#cs_filter_preview').html(
        tfPlan.rules.length
            ? (tfPlan.targets.length
                ? `处理范围：楼层 #0 ~ #${tfPlan.cutoff - 1}（保留最近 ${tfPlan.keepFloors} 层）<br>`
                  + `规则：<br>${ruleSummary}<br>`
                  + `将修改楼层：<b>${tfPlan.targets.length}</b> 层（${formatFloorRange(tfPlan.targets)}）｜ 预计释放 <b>${formatBytes(tfPlan.bytes)}</b>`
                : `处理范围：楼层 #0 ~ #${tfPlan.cutoff - 1}（保留最近 ${tfPlan.keepFloors} 层）<br>`
                  + `规则：<br>${ruleSummary}<br>`
                  + `当前范围内没有匹配内容。`)
            : '请至少添加一条规则，并填写起始或结束标记。',
    );
}

async function runReasoningStrip() {
    if (isBusy) {
        notify('info', '正在处理上一个操作，请稍候。');
        return;
    }
    const s = getSettings();
    const plan = planReasoningStrip(chat, s.reasoningKeepFloors);
    if (!plan.targets.length) {
        notify('info', '没有需要剥离思维链的楼层。');
        return;
    }
    const ok = await confirmAction(
        `将从 ${plan.targets.length} 层剥离思维链（楼层 ${formatFloorRange(plan.targets)}），`
        + `预计释放 ${formatBytes(plan.bytes)}。\n\n会写入并保存当前聊天，建议先备份。是否继续？`,
    );
    if (!ok) return;

    isBusy = true;
    try {
        // Reasoning lives in metadata only; stripping it does not change the
        // visible `mes`, so we must NOT touch the DOM here. We also must NOT
        // reloadCurrentChat afterwards: reloading re-reads the chat from disk,
        // which can race the save and reload the *pre-strip* data back into the
        // in-memory `chat`, making it look like nothing changed. Instead we
        // mutate in memory, persist, and recompute from the (already-stripped)
        // in-memory array.
        let changed = 0;
        for (const id of plan.targets) {
            if (stripReasoningFromMessage(chat[id])) {
                changed++;
            }
        }
        if (changed) {
            await persistChat();
        }
        notify('success', `已剥离 ${changed} 层思维链并保存。`);
        recomputePreview();
    } catch (err) {
        console.error(`[${MODULE_NAME}] reasoning strip failed`, err);
        notify('error', `剥离失败：${err?.message ?? err}`);
    } finally {
        isBusy = false;
    }
}

async function runSwipeClean() {
    if (isBusy) {
        notify('info', '正在处理上一个操作，请稍候。');
        return;
    }
    const s = getSettings();
    const plan = planSwipeClean(chat, s.swipeKeepFloors);
    if (!plan.targets.length) {
        notify('info', '没有需要清理 Swipe 的楼层。');
        return;
    }
    const ok = await confirmAction(
        `将清理 ${plan.targets.length} 层的冗余 Swipe（楼层 ${formatFloorRange(plan.targets)}），`
        + `仅保留每层当前显示的内容，丢弃其它候选与生成元数据，预计释放 ${formatBytes(plan.bytes)}。\n\n`
        + `会写入并保存当前聊天，操作不可在 app 内撤销，建议先备份。是否继续？`,
    );
    if (!ok) return;

    isBusy = true;
    try {
        // Cleaning only touches metadata arrays (swipes / swipe_info / swipe_id)
        // and keeps the displayed `mes`, so the visible text is unchanged. As
        // with reasoning stripping we mutate in memory + persist, without
        // reloading from disk (which could race the save). Stale swipe counters
        // on any visible cleaned floor refresh on the next chat reload.
        let changed = 0;
        for (const id of plan.targets) {
            if (cleanSwipesFromMessage(chat[id])) {
                changed++;
            }
        }
        if (changed) {
            await persistChat();
        }
        notify('success', `已清理 ${changed} 层 Swipe 并保存。`);
        recomputePreview();
    } catch (err) {
        console.error(`[${MODULE_NAME}] swipe clean failed`, err);
        notify('error', `Swipe 清理失败：${err?.message ?? err}`);
    } finally {
        isBusy = false;
    }
}

async function runTextFilterClean() {
    if (isBusy) {
        notify('info', '正在处理上一个操作，请稍候。');
        return;
    }
    const s = getSettings();
    const rules = syncTextFilterRulesToSettings();
    if (!rules.length) {
        notify('warning', '请至少配置一条有效规则（起始或结束标记至少填一项）。');
        return;
    }
    const plan = planTextFilterClean(chat, s.textFilterKeepFloors, rules);
    if (!plan.targets.length) {
        notify('info', '当前范围内没有匹配规则的内容。');
        return;
    }
    const ruleLines = plan.rules
        .map((r, i) => {
            if (r.start && r.end) return `${i + 1}. ${r.start} → ${r.end}`;
            if (r.start) return `${i + 1}. ${r.start}（仅删除起始标记）`;
            return `${i + 1}. （文首）→ ${r.end}`;
        })
        .join('\n');
    const ok = await confirmAction(
        `将按 ${plan.rules.length} 条规则清理 ${plan.targets.length} 层正文（楼层 ${formatFloorRange(plan.targets)}），`
        + `删除起止标记之间的文本，预计释放 ${formatBytes(plan.bytes)}。\n\n`
        + `规则：\n${ruleLines}\n\n`
        + `会修改可见 mes 并保存，操作不可在 app 内撤销，建议先备份。是否继续？`,
    );
    if (!ok) return;

    isBusy = true;
    try {
        let changed = 0;
        for (const id of plan.targets) {
            if (applyTextFilterToMessage(chat[id], plan.rules)) {
                changed++;
            }
        }
        if (changed) {
            await persistChat();
            if (typeof reloadCurrentChat === 'function') {
                await reloadCurrentChat();
            }
        }
        notify('success', `已清理 ${changed} 层匹配文本并保存。`);
        renderTextFilterRules(getSettings().textFilterRules);
        recomputePreview();
    } catch (err) {
        console.error(`[${MODULE_NAME}] text filter clean failed`, err);
        notify('error', `文本过滤失败：${err?.message ?? err}`);
    } finally {
        isBusy = false;
    }
}

async function runHiddenDelete() {
    if (isBusy) {
        notify('info', '正在处理上一个操作，请稍候。');
        return;
    }
    const s = getSettings();
    const plan = planHiddenDelete(chat, s.hiddenKeepFloors, s.protectOpening);
    if (!plan.targets.length) {
        notify('info', '没有需要删除的隐藏楼层。');
        return;
    }
    const ok = await confirmAction(
        `将永久删除 ${plan.targets.length} 个隐藏楼层（楼层 ${formatFloorRange(plan.targets)}），`
        + `预计释放 ${formatBytes(plan.bytes)}。\n\n删除后无法在 app 内撤销，建议先备份聊天文件。是否继续？`,
    );
    if (!ok) return;

    isBusy = true;
    try {
        const descending = [...plan.targets].sort((a, b) => b - a);
        for (const id of descending) {
            chat.splice(id, 1);
        }
        await persistChat();
        // Deletion shifts indices, so the rendered DOM must be rebuilt. Reload
        // AFTER the forced save has committed, so it re-reads the shortened file
        // rather than racing the save and reverting to the pre-delete state.
        if (typeof reloadCurrentChat === 'function') {
            await reloadCurrentChat();
        }
        notify('success', `已删除 ${descending.length} 个隐藏楼层并保存。`);
        recomputePreview();
    } catch (err) {
        console.error(`[${MODULE_NAME}] hidden delete failed`, err);
        notify('error', `删除失败：${err?.message ?? err}`);
    } finally {
        isBusy = false;
    }
}

function buildPopupContent() {
    const content = $(`
        <div class="chat-slimmer-popup">
            <h3 class="cs-title">聊天瘦身 · ST-ChatSlimmer <span class="cs-ver">v${escapeHtml(CHAT_SLIMMER_VERSION)}</span></h3>
            <div class="cs-total-line">当前总楼层：<b id="cs_total">0</b></div>

            <div class="cs-card">
                <div class="cs-card-title">① 剥离思维链（reasoning）</div>
                <label class="cs-row">
                    保留最近
                    <input type="number" id="cs_reasoning_keep" class="text_pole cs-num" min="0" step="1" />
                    层不动，剥离更早楼层的思维链
                </label>
                <div class="cs-preview" id="cs_reasoning_preview"></div>
                <div class="menu_button cs-btn" id="cs_reasoning_run">剥离思维链</div>
            </div>

            <div class="cs-card">
                <div class="cs-card-title">② 清理 Swipe（仅保留当前显示）</div>
                <label class="cs-row">
                    保留最近
                    <input type="number" id="cs_swipe_keep" class="text_pole cs-num" min="0" step="1" />
                    层不动，清理更早楼层的冗余 Swipe
                </label>
                <div class="cs-preview" id="cs_swipe_preview"></div>
                <div class="menu_button cs-btn" id="cs_swipe_run">清理 Swipe</div>
            </div>

            <div class="cs-card">
                <div class="cs-card-title">③ 删除隐藏楼层</div>
                <label class="cs-row">
                    保留最近
                    <input type="number" id="cs_hidden_keep" class="text_pole cs-num" min="0" step="1" />
                    层，删除更早的隐藏楼层
                </label>
                <label class="cs-row cs-check">
                    <input type="checkbox" id="cs_protect_opening" />
                    保护开场白（楼层 #0）
                </label>
                <div class="cs-preview" id="cs_hidden_preview"></div>
                <div class="menu_button cs-btn cs-danger" id="cs_hidden_run">删除隐藏楼层</div>
            </div>

            <div class="cs-card">
                <div class="cs-card-title">④ 文本过滤（起止标记）</div>
                <label class="cs-row">
                    保留最近
                    <input type="number" id="cs_filter_keep" class="text_pole cs-num" min="0" step="1" />
                    层不动，清理更早楼层 mes / swipes 中的匹配块
                </label>
                <div class="cs-filter-rules" id="cs_filter_rules"></div>
                <div class="cs-filter-actions">
                    <div class="menu_button cs-filter-add" id="cs_filter_add">+ 添加规则</div>
                    <div class="menu_button cs-filter-reset" id="cs_filter_reset">恢复默认规则</div>
                </div>
                <div class="cs-preview" id="cs_filter_preview"></div>
                <div class="menu_button cs-btn" id="cs_filter_run">清理匹配文本</div>
            </div>

            <div class="cs-note">所有操作仅在点击按钮后执行，并会二次确认。删除隐藏楼层、文本过滤不可在 app 内撤销，请确认已备份聊天文件。</div>
        </div>
    `);

    content.on('input', '#cs_reasoning_keep', function () {
        getSettings().reasoningKeepFloors = clampInt($(this).val(), 0, 1e9);
        saveSettings();
        recomputePreview();
    });
    content.on('input', '#cs_swipe_keep', function () {
        getSettings().swipeKeepFloors = clampInt($(this).val(), 0, 1e9);
        saveSettings();
        recomputePreview();
    });
    content.on('input', '#cs_hidden_keep', function () {
        getSettings().hiddenKeepFloors = clampInt($(this).val(), 0, 1e9);
        saveSettings();
        recomputePreview();
    });
    content.on('change', '#cs_protect_opening', function () {
        getSettings().protectOpening = Boolean($(this).prop('checked'));
        saveSettings();
        recomputePreview();
    });
    content.on('input', '#cs_filter_keep', function () {
        getSettings().textFilterKeepFloors = clampInt($(this).val(), 0, 1e9);
        saveSettings();
        recomputePreview();
    });
    content.on('input', '.cs-filter-start, .cs-filter-end', function () {
        syncTextFilterRulesToSettings();
        recomputePreview();
    });
    content.on('click', '.cs-filter-del', function () {
        $(this).closest('.cs-filter-rule').remove();
        if (!content.find('.cs-filter-rule').length) {
            content.find('#cs_filter_rules').append(buildTextFilterRuleRow());
        }
        syncTextFilterRulesToSettings();
        recomputePreview();
    });
    content.on('click', '#cs_filter_add', function () {
        content.find('#cs_filter_rules').append(buildTextFilterRuleRow());
        syncTextFilterRulesToSettings();
        recomputePreview();
    });
    content.on('click', '#cs_filter_reset', function () {
        const defaults = DEFAULT_TEXT_FILTER_RULES.map(r => ({ ...r }));
        getSettings().textFilterRules = defaults;
        saveSettings();
        renderTextFilterRules(defaults);
        recomputePreview();
    });
    content.on('click', '#cs_reasoning_run', runReasoningStrip);
    content.on('click', '#cs_swipe_run', runSwipeClean);
    content.on('click', '#cs_hidden_run', runHiddenDelete);
    content.on('click', '#cs_filter_run', runTextFilterClean);

    return content;
}

function openPanel() {
    const s = getSettings();
    popupContent = buildPopupContent();
    popupContent.find('#cs_reasoning_keep').val(String(s.reasoningKeepFloors));
    popupContent.find('#cs_swipe_keep').val(String(s.swipeKeepFloors));
    popupContent.find('#cs_hidden_keep').val(String(s.hiddenKeepFloors));
    popupContent.find('#cs_protect_opening').prop('checked', Boolean(s.protectOpening));
    popupContent.find('#cs_filter_keep').val(String(s.textFilterKeepFloors));
    renderTextFilterRules(s.textFilterRules);
    recomputePreview();

    callGenericPopup(popupContent, POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: '关闭',
    }).finally(() => {
        popupContent = null;
    });
}

function addMenuButton() {
    if ($(`#${MENU_BUTTON_ID}`).length) return;

    let menu = $('#extensionsMenu');
    if (!menu.length) menu = $('#options');
    if (!menu.length) {
        console.warn(`[${MODULE_NAME}] extensions menu not found`);
        return;
    }

    const button = $(`
        <div id="${MENU_BUTTON_ID}" class="list-group-item flex-container flexGap5 interactable" title="聊天瘦身">
            <div class="fa-solid fa-broom extensionsMenuExtensionButton"></div>
            <span>聊天瘦身</span>
        </div>
    `);
    button.on('click', openPanel);
    menu.append(button);
}

function renderSettingsHtml() {
    return `
        <div id="chat_slimmer_settings_container" class="chat-slimmer-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Chat Slimmer / 聊天瘦身</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small>从扩展菜单（魔杖图标）打开「聊天瘦身」面板，可预览并手动执行：剥离思维链、清理 Swipe、删除隐藏楼层、按起止标记过滤正文。</small>
                    <div class="menu_button" id="chat_slimmer_open_panel">打开瘦身面板</div>
                </div>
            </div>
        </div>
    `;
}

function bindSettingsEvents() {
    $(document).on('click', '#chat_slimmer_open_panel', openPanel);
}

function waitForMenuAndInit() {
    const timer = setInterval(() => {
        if ($('#extensionsMenu').length || $('#options').length) {
            addMenuButton();
            if (!$('#chat_slimmer_settings_container').length && $('#extensions_settings').length) {
                $('#extensions_settings').append(renderSettingsHtml());
                bindSettingsEvents();
            }
            clearInterval(timer);
            console.log(`[${MODULE_NAME}] loaded v${CHAT_SLIMMER_VERSION}`);
        }
    }, 500);
}

$(document).ready(waitForMenuAndInit);
