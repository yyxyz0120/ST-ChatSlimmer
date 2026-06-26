import {
    chat,
    saveChatConditional,
    updateMessageBlock,
    reloadCurrentChat,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import {
    CHAT_SLIMMER_VERSION,
    planReasoningStrip,
    planHiddenDelete,
    stripReasoningFromMessage,
    formatBytes,
    formatFloorRange,
    clampInt,
} from './core.js';

const MODULE_NAME = 'ST-ChatSlimmer';
const SETTINGS_KEY = 'chat_slimmer';
const MENU_BUTTON_ID = 'chat_slimmer_button';

const DEFAULT_SETTINGS = Object.freeze({
    reasoningKeepFloors: 10,
    hiddenKeepFloors: 10,
    protectOpening: true,
});

let popupContent = null;
let isBusy = false;

function getSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }
    const s = extension_settings[SETTINGS_KEY];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function saveSettings() {
    saveSettingsDebounced();
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

function recomputePreview() {
    if (!popupContent) return;
    const s = getSettings();
    const total = Array.isArray(chat) ? chat.length : 0;
    popupContent.find('#cs_total').text(String(total));

    const rPlan = planReasoningStrip(chat, s.reasoningKeepFloors);
    const hPlan = planHiddenDelete(chat, s.hiddenKeepFloors, s.protectOpening);

    popupContent.find('#cs_reasoning_preview').html(
        rPlan.targets.length
            ? `处理范围：楼层 #0 ~ #${rPlan.cutoff - 1}（保留最近 ${rPlan.keepFloors} 层）<br>`
              + `含思维链楼层：<b>${rPlan.targets.length}</b> 层 ｜ 预计释放 <b>${formatBytes(rPlan.bytes)}</b>`
            : `保留最近 ${rPlan.keepFloors} 层；更早楼层中没有可剥离的思维链。`,
    );

    popupContent.find('#cs_hidden_preview').html(
        hPlan.targets.length
            ? `处理范围：楼层 #0 ~ #${hPlan.cutoff - 1}（保留最近 ${hPlan.keepFloors} 层${hPlan.protectOpening ? '，保护开场白' : ''}）<br>`
              + `隐藏楼层：<b>${hPlan.targets.length}</b> 个（${formatFloorRange(hPlan.targets)}）｜ 预计释放 <b>${formatBytes(hPlan.bytes)}</b>`
            : `保留最近 ${hPlan.keepFloors} 层；更早楼层中没有隐藏楼层可删除。`,
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
        let changed = 0;
        for (const id of plan.targets) {
            if (stripReasoningFromMessage(chat[id])) {
                updateMessageBlock(id, chat[id]);
                changed++;
            }
        }
        if (changed) await saveChatConditional();
        notify('success', `已剥离 ${changed} 层思维链并保存。`);
        recomputePreview();
    } catch (err) {
        console.error(`[${MODULE_NAME}] reasoning strip failed`, err);
        notify('error', `剥离失败：${err?.message ?? err}`);
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
        await saveChatConditional();
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
                <div class="cs-card-title">② 删除隐藏楼层</div>
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

            <div class="cs-note">所有操作仅在点击按钮后执行，并会二次确认。删除隐藏楼层不可在 app 内撤销，请确认已备份聊天文件。</div>
        </div>
    `);

    content.on('input', '#cs_reasoning_keep', function () {
        getSettings().reasoningKeepFloors = clampInt($(this).val(), 0, 1e9);
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
    content.on('click', '#cs_reasoning_run', runReasoningStrip);
    content.on('click', '#cs_hidden_run', runHiddenDelete);

    return content;
}

function openPanel() {
    const s = getSettings();
    popupContent = buildPopupContent();
    popupContent.find('#cs_reasoning_keep').val(String(s.reasoningKeepFloors));
    popupContent.find('#cs_hidden_keep').val(String(s.hiddenKeepFloors));
    popupContent.find('#cs_protect_opening').prop('checked', Boolean(s.protectOpening));
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
                    <small>从扩展菜单（魔杖图标）打开「聊天瘦身」面板，可预览并手动执行：剥离历史楼层思维链、删除更早的隐藏楼层。</small>
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
