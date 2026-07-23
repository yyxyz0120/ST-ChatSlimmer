// Pure, ST-independent logic for ST-ChatSlimmer.
// Kept free of DOM / SillyTavern imports so it can be unit-tested in isolation.

export const CHAT_SLIMMER_VERSION = '0.3.1';

/** @typedef {{ start: string, end: string }} TextFilterRule */

export const DEFAULT_TEXT_FILTER_RULES = Object.freeze([
    { start: '<disclaimer>', end: '</disclaimer>' },
]);

// Fields written by reasoning-capable models (DeepSeek / Gemini thinking, etc.).
// `reasoning` holds the chain-of-thought text and is the dominant byte consumer.
export const REASONING_FIELDS = Object.freeze([
    'reasoning',
    'reasoning_duration',
    'reasoning_signature',
    'reasoning_type',
]);

export function clampInt(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(Math.max(Math.trunc(n), min), max);
}

export function computeCutoff(total, keepFloors) {
    const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
    const keep = clampInt(keepFloors, 0, safeTotal);
    return Math.max(0, safeTotal - keep);
}

export function byteLength(value) {
    try {
        const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(s).length;
        }
        return s.length;
    } catch {
        return 0;
    }
}

// A floor only counts as a reasoning target when it actually carries CoT text.
// The trailing metadata fields (duration/signature/type) are tiny and may exist
// as `null` even on floors with no chain-of-thought, so they must not drive the
// target count; they are still removed by stripReasoningFromMessage when present.
function extraHasReasoning(extra) {
    if (!extra || typeof extra !== 'object') return false;
    return typeof extra.reasoning === 'string' && extra.reasoning.trim().length > 0;
}

function collectReasoningBytes(extra) {
    if (!extra || typeof extra !== 'object') return 0;
    let bytes = 0;
    for (const f of REASONING_FIELDS) {
        if (extra[f] !== undefined) {
            bytes += byteLength(extra[f]) + f.length + 4;
        }
    }
    return bytes;
}

export function messageReasoningBytes(message) {
    let bytes = collectReasoningBytes(message?.extra);
    if (Array.isArray(message?.swipe_info)) {
        for (const si of message.swipe_info) {
            bytes += collectReasoningBytes(si?.extra);
        }
    }
    return bytes;
}

export function messageHasReasoning(message) {
    if (extraHasReasoning(message?.extra)) return true;
    if (Array.isArray(message?.swipe_info)) {
        return message.swipe_info.some(si => extraHasReasoning(si?.extra));
    }
    return false;
}

// Returns { total, cutoff, keepFloors, targets:[ids], bytes }
export function planReasoningStrip(chat, keepFloors) {
    const total = Array.isArray(chat) ? chat.length : 0;
    const cutoff = computeCutoff(total, keepFloors);
    const targets = [];
    let bytes = 0;
    for (let i = 0; i < cutoff; i++) {
        const m = chat[i];
        if (!m) continue;
        if (messageHasReasoning(m)) {
            targets.push(i);
            bytes += messageReasoningBytes(m);
        }
    }
    return { total, cutoff, keepFloors: total - cutoff, targets, bytes };
}

// --- Swipe cleanup -------------------------------------------------------
// Each message can carry a `swipes` array of alternate generations plus a
// parallel `swipe_info` array (gen params / per-swipe extra). For the vast
// majority of floors there is only one swipe, so `swipes[0]` is just a
// duplicate of `mes` — pure bloat. Cleaning keeps ONLY the currently displayed
// swipe (which equals `mes`) and drops the arrays entirely. This works on every
// floor regardless of whether it is rendered in the DOM, unlike swipe cleaners
// that walk the on-screen message elements.

function messageHasRedundantSwipes(message) {
    if (!message || typeof message !== 'object') return false;
    if (Array.isArray(message.swipes) && message.swipes.length > 0) return true;
    if (Array.isArray(message.swipe_info)) return true;
    if (message.swipe_id !== undefined && message.swipe_id !== null) return true;
    return false;
}

export function messageSwipeBytes(message) {
    if (!message || typeof message !== 'object') return 0;
    let bytes = 0;
    if (Array.isArray(message.swipes)) {
        bytes += byteLength(message.swipes) + 'swipes'.length + 4;
    }
    if (Array.isArray(message.swipe_info)) {
        bytes += byteLength(message.swipe_info) + 'swipe_info'.length + 4;
    }
    if (message.swipe_id !== undefined && message.swipe_id !== null) {
        bytes += byteLength(message.swipe_id) + 'swipe_id'.length + 4;
    }
    return bytes;
}

// Mutates in place; returns true if anything was removed. Preserves the content
// of the currently selected swipe even if `mes` somehow drifted out of sync.
export function cleanSwipesFromMessage(message) {
    if (!message || typeof message !== 'object') return false;
    let changed = false;
    const swipes = message.swipes;
    if (Array.isArray(swipes) && swipes.length > 0) {
        const sid = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        const current = swipes[sid] ?? swipes[0];
        if (typeof current === 'string' && current.length > 0 && current !== message.mes) {
            message.mes = current;
        }
        delete message.swipes;
        changed = true;
    }
    if (Array.isArray(message.swipe_info)) {
        delete message.swipe_info;
        changed = true;
    }
    if (message.swipe_id !== undefined) {
        delete message.swipe_id;
        changed = true;
    }
    return changed;
}

// Returns { total, cutoff, keepFloors, targets:[ids], bytes }
export function planSwipeClean(chat, keepFloors) {
    const total = Array.isArray(chat) ? chat.length : 0;
    const cutoff = computeCutoff(total, keepFloors);
    const targets = [];
    let bytes = 0;
    for (let i = 0; i < cutoff; i++) {
        const m = chat[i];
        if (!m) continue;
        if (messageHasRedundantSwipes(m)) {
            targets.push(i);
            bytes += messageSwipeBytes(m);
        }
    }
    return { total, cutoff, keepFloors: total - cutoff, targets, bytes };
}

// Hidden floors are messages with is_system === true (covers both narrator
// messages and user-/AI-floors hidden via /hide). Optionally protect floor #0
// (the opening message) to avoid edge cases on load.
export function planHiddenDelete(chat, keepFloors, protectOpening = true) {
    const total = Array.isArray(chat) ? chat.length : 0;
    const cutoff = computeCutoff(total, keepFloors);
    const targets = [];
    let bytes = 0;
    for (let i = 0; i < cutoff; i++) {
        if (protectOpening && i === 0) continue;
        const m = chat[i];
        if (!m) continue;
        if (m.is_system === true) {
            targets.push(i);
            bytes += byteLength(m);
        }
    }
    return { total, cutoff, keepFloors: total - cutoff, targets, bytes, protectOpening };
}

// Mutates the message in place; returns true if anything was removed.
export function stripReasoningFromMessage(message) {
    if (!message || typeof message !== 'object') return false;
    let changed = false;
    const strip = (extra) => {
        if (!extra || typeof extra !== 'object') return;
        for (const f of REASONING_FIELDS) {
            if (extra[f] !== undefined) {
                delete extra[f];
                changed = true;
            }
        }
    };
    strip(message.extra);
    if (Array.isArray(message.swipe_info)) {
        for (const si of message.swipe_info) strip(si?.extra);
    }
    return changed;
}

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatFloorRange(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return '无';
    const min = targets[0];
    const max = targets[targets.length - 1];
    return min === max ? `#${min}` : `#${min} ~ #${max}`;
}

// --- Text filter (start/end marker stripping) -----------------------------

export function normalizeTextFilterRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules
        .map(r => ({
            start: String(r?.start ?? '').trim(),
            end: String(r?.end ?? '').trim(),
        }))
        .filter(r => r.start.length > 0 || r.end.length > 0);
}

/**
 * Remove text matching one rule from a string.
 * - start only: delete every literal occurrence of `start`
 * - start + end: delete from `start` through `end` (inclusive), repeatedly
 * - end only: delete from text start through first `end` (inclusive); for orphaned
 *   closing tags when preset regex already stripped the opening marker
 */
export function applyTextFilterRule(text, rule) {
    const start = String(rule?.start ?? '').trim();
    const end = String(rule?.end ?? '').trim();
    if ((!start && !end) || typeof text !== 'string' || text.length === 0) {
        return { text, changed: false, bytesRemoved: 0 };
    }

    let result = text;
    if (!start && end) {
        const endIdx = result.indexOf(end);
        if (endIdx === -1) {
            return { text, changed: false, bytesRemoved: 0 };
        }
        const removed = result.slice(0, endIdx + end.length);
        result = result.slice(endIdx + end.length);
        return {
            text: result,
            changed: true,
            bytesRemoved: byteLength(removed),
        };
    }

    if (!end) {
        if (!result.includes(start)) {
            return { text, changed: false, bytesRemoved: 0 };
        }
        const parts = result.split(start);
        result = parts.join('');
        return {
            text: result,
            changed: true,
            bytesRemoved: byteLength(text) - byteLength(result),
        };
    }

    let bytesRemoved = 0;
    let changed = false;
    let searchFrom = 0;
    while (searchFrom < result.length) {
        const startIdx = result.indexOf(start, searchFrom);
        if (startIdx === -1) break;
        const endIdx = result.indexOf(end, startIdx + start.length);
        if (endIdx === -1) break;
        const removed = result.slice(startIdx, endIdx + end.length);
        bytesRemoved += byteLength(removed);
        result = result.slice(0, startIdx) + result.slice(endIdx + end.length);
        changed = true;
        searchFrom = startIdx;
    }
    return { text: result, changed, bytesRemoved };
}

export function applyTextFilterRules(text, rules) {
    const normalized = normalizeTextFilterRules(rules);
    if (!normalized.length || typeof text !== 'string') {
        return { text, changed: false, bytesRemoved: 0 };
    }
    let result = text;
    let changed = false;
    let bytesRemoved = 0;
    for (const rule of normalized) {
        const applied = applyTextFilterRule(result, rule);
        result = applied.text;
        changed = changed || applied.changed;
        bytesRemoved += applied.bytesRemoved;
    }
    return { text: result, changed, bytesRemoved };
}

export function messageTextFilterBytes(message, rules) {
    if (!message || typeof message !== 'object') return 0;
    let bytes = 0;
    if (typeof message.mes === 'string') {
        bytes += applyTextFilterRules(message.mes, rules).bytesRemoved;
    }
    if (Array.isArray(message.swipes)) {
        for (const swipe of message.swipes) {
            if (typeof swipe === 'string') {
                bytes += applyTextFilterRules(swipe, rules).bytesRemoved;
            }
        }
    }
    return bytes;
}

export function messageWouldChangeByTextFilter(message, rules) {
    if (!message || typeof message !== 'object') return false;
    if (typeof message.mes === 'string' && applyTextFilterRules(message.mes, rules).changed) {
        return true;
    }
    if (Array.isArray(message.swipes)) {
        return message.swipes.some(
            swipe => typeof swipe === 'string' && applyTextFilterRules(swipe, rules).changed,
        );
    }
    return false;
}

/** Mutates message in place; returns true if mes or any swipe changed. */
export function applyTextFilterToMessage(message, rules) {
    if (!message || typeof message !== 'object') return false;
    let changed = false;
    if (typeof message.mes === 'string') {
        const applied = applyTextFilterRules(message.mes, rules);
        if (applied.changed) {
            message.mes = applied.text;
            changed = true;
        }
    }
    if (Array.isArray(message.swipes)) {
        for (let i = 0; i < message.swipes.length; i++) {
            const swipe = message.swipes[i];
            if (typeof swipe !== 'string') continue;
            const applied = applyTextFilterRules(swipe, rules);
            if (applied.changed) {
                message.swipes[i] = applied.text;
                changed = true;
            }
        }
    }
    return changed;
}

/**
 * @returns {{ total, cutoff, keepFloors, targets:number[], bytes, rules: TextFilterRule[] }}
 */
export function planTextFilterClean(chat, keepFloors, rules) {
    const normalized = normalizeTextFilterRules(rules);
    const total = Array.isArray(chat) ? chat.length : 0;
    const cutoff = computeCutoff(total, keepFloors);
    const targets = [];
    let bytes = 0;
    if (!normalized.length) {
        return { total, cutoff, keepFloors: total - cutoff, targets, bytes, rules: normalized };
    }
    for (let i = 0; i < cutoff; i++) {
        const m = chat[i];
        if (!m) continue;
        if (messageWouldChangeByTextFilter(m, normalized)) {
            targets.push(i);
            bytes += messageTextFilterBytes(m, normalized);
        }
    }
    return { total, cutoff, keepFloors: total - cutoff, targets, bytes, rules: normalized };
}
