// Pure, ST-independent logic for ST-ChatSlimmer.
// Kept free of DOM / SillyTavern imports so it can be unit-tested in isolation.

export const CHAT_SLIMMER_VERSION = '0.1.3';

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
