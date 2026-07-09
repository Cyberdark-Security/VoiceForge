/**
 * VoiceForge — edit-stack.js (EDL e historial no destructivo)
 */

import {
    crossfadeSamples,
    mixSegmentWithFades,
    zeroCrossWindow,
    findZeroCrossing
} from './splice-utils.js';

const FADE_SEC = 0.015;

export class EditStack {
    constructor() {
        this.buffersPool = new Map();
        this.undoStack = [];
        this.redoStack = [];
        this.maxStackSize = 50;
        this.currentEDL = [];
        this.segmentIdCounter = 0;
        this.bufferIdCounter = 0;
        this.silenceBufferId = null;
        this.historyLog = [];
    }

    registerBuffer(audioBuffer) {
        const id = `buf_${++this.bufferIdCounter}`;
        this.buffersPool.set(id, audioBuffer);
        return id;
    }

    ensureSilenceBuffer(ctx, durationSec = 1) {
        if (this.silenceBufferId && this.buffersPool.has(this.silenceBufferId)) {
            const buf = this.buffersPool.get(this.silenceBufferId);
            if (buf.duration >= durationSec) return this.silenceBufferId;
        }
        const samples = Math.ceil(durationSec * ctx.sampleRate);
        const silence = ctx.createBuffer(1, samples, ctx.sampleRate);
        this.silenceBufferId = this.registerBuffer(silence);
        return this.silenceBufferId;
    }

    initialize(audioBuffer, label = 'Importar audio') {
        const bufferId = this.registerBuffer(audioBuffer);
        this.currentEDL = [{
            id: `seg_${++this.segmentIdCounter}`,
            bufferId,
            offset: 0,
            length: audioBuffer.duration,
            fadeIn: 0,
            fadeOut: 0
        }];
        this.undoStack = [];
        this.redoStack = [];
        this.historyLog = [label];
        this.collectGarbage();
    }

    getDuration() {
        return this.currentEDL.reduce((t, seg) => t + seg.length, 0);
    }

    cloneEDL() {
        return JSON.parse(JSON.stringify(this.currentEDL));
    }

    pushState(label) {
        this.undoStack.push(this.cloneEDL());
        if (this.undoStack.length > this.maxStackSize) this.undoStack.shift();
        this.redoStack = [];
        this.historyLog.push(label);
        if (this.historyLog.length > this.maxStackSize + 1) {
            this.historyLog.shift();
        }
    }

    undo() {
        if (this.undoStack.length === 0) return null;
        this.redoStack.push(this.cloneEDL());
        this.currentEDL = this.undoStack.pop();
        if (this.historyLog.length > 1) this.historyLog.pop();
        this.collectGarbage();
        return this.currentEDL;
    }

    redo() {
        if (this.redoStack.length === 0) return null;
        this.undoStack.push(this.cloneEDL());
        this.currentEDL = this.redoStack.pop();
        this.historyLog.push('Rehacer');
        this.collectGarbage();
        return this.currentEDL;
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    timeToSegmentIndex(time) {
        let cursor = 0;
        for (let i = 0; i < this.currentEDL.length; i++) {
            const seg = this.currentEDL[i];
            if (time < cursor + seg.length) {
                return { index: i, localTime: time - cursor, cursor };
            }
            cursor += seg.length;
        }
        return { index: this.currentEDL.length - 1, localTime: 0, cursor: this.getDuration() };
    }

    splitSegmentAt(segIndex, localTime) {
        const seg = this.currentEDL[segIndex];
        if (localTime <= 0.0001 || localTime >= seg.length - 0.0001) return;

        const right = {
            ...seg,
            id: `seg_${++this.segmentIdCounter}`,
            offset: seg.offset + localTime,
            length: seg.length - localTime,
            fadeIn: FADE_SEC,
            fadeOut: seg.fadeOut
        };

        seg.length = localTime;
        seg.fadeOut = FADE_SEC;
        this.currentEDL.splice(segIndex + 1, 0, right);
    }

    cut(start, end) {
        if (end <= start || start < 0) return false;
        this.pushState('Cortar selección');

        const total = this.getDuration();
        start = Math.max(0, Math.min(start, total));
        end = Math.max(0, Math.min(end, total));
        if (end <= start) return false;

        const newEDL = [];
        let cursor = 0;

        for (const seg of this.currentEDL) {
            const segStart = cursor;
            const segEnd = cursor + seg.length;

            if (segEnd <= start || segStart >= end) {
                newEDL.push({ ...seg });
            } else if (segStart >= start && segEnd <= end) {
                // eliminado
            } else if (segStart < start && segEnd > end) {
                const leftLen = start - segStart;
                const rightOffset = end - segStart;
                newEDL.push({
                    ...seg,
                    length: leftLen,
                    fadeOut: FADE_SEC
                });
                newEDL.push({
                    ...seg,
                    id: `seg_${++this.segmentIdCounter}`,
                    offset: seg.offset + rightOffset,
                    length: seg.length - rightOffset,
                    fadeIn: FADE_SEC,
                    fadeOut: seg.fadeOut
                });
            } else if (segStart < start && segEnd > start) {
                newEDL.push({
                    ...seg,
                    length: start - segStart,
                    fadeOut: FADE_SEC
                });
            } else if (segStart < end && segEnd > end) {
                const cutAmt = end - segStart;
                newEDL.push({
                    ...seg,
                    id: `seg_${++this.segmentIdCounter}`,
                    offset: seg.offset + cutAmt,
                    length: seg.length - cutAmt,
                    fadeIn: FADE_SEC,
                    fadeOut: seg.fadeOut
                });
            }

            cursor = segEnd;
        }

        this.currentEDL = this.mergeAdjacentSegments(newEDL);
        this.collectGarbage();
        return true;
    }

    mute(start, end, ctx) {
        if (end <= start || start < 0) return false;

        const total = this.getDuration();
        start = Math.max(0, Math.min(start, total));
        end = Math.max(0, Math.min(end, total));
        const muteLen = end - start;
        if (muteLen <= 0) return false;

        this.pushState('Silenciar selección');
        const silenceId = this.ensureSilenceBuffer(ctx, muteLen);
        const silenceSeg = {
            id: `seg_${++this.segmentIdCounter}`,
            bufferId: silenceId,
            offset: 0,
            length: muteLen,
            fadeIn: FADE_SEC,
            fadeOut: FADE_SEC
        };

        const left = this.extractEDLRange(0, start);
        const right = this.extractEDLRange(end, total);

        if (left.length && left[left.length - 1]) {
            left[left.length - 1].fadeOut = FADE_SEC;
        }
        if (right.length && right[0]) {
            right[0].fadeIn = FADE_SEC;
        }

        this.currentEDL = this.mergeAdjacentSegments([...left, silenceSeg, ...right]);
        this.collectGarbage();
        return true;
    }

    extractEDLRange(rangeStart, rangeEnd) {
        if (rangeEnd <= rangeStart) return [];

        const result = [];
        let cursor = 0;

        for (const seg of this.currentEDL) {
            const segStart = cursor;
            const segEnd = cursor + seg.length;
            cursor = segEnd;

            if (segEnd <= rangeStart || segStart >= rangeEnd) continue;

            const clipStart = Math.max(rangeStart, segStart);
            const clipEnd = Math.min(rangeEnd, segEnd);
            const offsetDelta = clipStart - segStart;

            result.push({
                ...seg,
                id: `seg_${++this.segmentIdCounter}`,
                offset: seg.offset + offsetDelta,
                length: clipEnd - clipStart,
                fadeIn: seg.fadeIn,
                fadeOut: seg.fadeOut
            });
        }

        return result;
    }

    locateInsertIndex(time) {
        let cursor = 0;
        for (let i = 0; i < this.currentEDL.length; i++) {
            const seg = this.currentEDL[i];
            if (time <= cursor + seg.length) {
                return { index: i, cursor };
            }
            cursor += seg.length;
        }
        return { index: this.currentEDL.length, cursor };
    }

    extractRange(start, end, ctx) {
        const materialized = this.materialize(ctx);
        if (!materialized) return null;

        const sr = materialized.sampleRate;
        const s0 = Math.floor(start * sr);
        const s1 = Math.floor(end * sr);
        const len = Math.max(0, s1 - s0);
        const out = ctx.createBuffer(1, len, sr);
        out.getChannelData(0).set(materialized.getChannelData(0).subarray(s0, s0 + len));
        return out;
    }

    paste(buffer, atTime, ctx) {
        if (!buffer) return false;
        this.pushState('Pegar audio');

        if (this.currentEDL.length === 0) {
            const bufferId = this.registerBuffer(buffer);
            this.currentEDL = [{
                id: `seg_${++this.segmentIdCounter}`,
                bufferId,
                offset: 0,
                length: buffer.duration,
                fadeIn: 0,
                fadeOut: 0
            }];
            this.collectGarbage();
            return true;
        }

        const { index, localTime } = this.timeToSegmentIndex(atTime);

        if (localTime > 0.0001) {
            this.splitSegmentAt(index, localTime);
        }

        const insertIndex = localTime > 0.0001 ? index + 1 : index;
        this.currentEDL.splice(insertIndex, 0, {
            id: `seg_${++this.segmentIdCounter}`,
            bufferId: this.registerBuffer(buffer),
            offset: 0,
            length: buffer.duration,
            fadeIn: FADE_SEC,
            fadeOut: FADE_SEC
        });

        this.collectGarbage();
        return true;
    }

    replaceWithBuffer(ctx, audioBuffer, label = 'Aplicar cambios') {
        this.pushState(label);
        const bufferId = this.registerBuffer(audioBuffer);
        this.currentEDL = [{
            id: `seg_${++this.segmentIdCounter}`,
            bufferId,
            offset: 0,
            length: audioBuffer.duration,
            fadeIn: 0,
            fadeOut: 0
        }];
        this.collectGarbage();
    }

    mergeAdjacentSegments(edl) {
        if (edl.length < 2) return edl;
        const merged = [{ ...edl[0] }];
        for (let i = 1; i < edl.length; i++) {
            const prev = merged[merged.length - 1];
            const cur = edl[i];
            if (
                prev.bufferId === cur.bufferId &&
                Math.abs((prev.offset + prev.length) - cur.offset) < 0.0001 &&
                prev.fadeOut === 0 && cur.fadeIn === 0
            ) {
                prev.length += cur.length;
                prev.fadeOut = cur.fadeOut;
            } else {
                merged.push({ ...cur });
            }
        }
        return merged;
    }

    collectGarbage() {
        const refs = new Set();
        const scan = (edl) => edl.forEach((s) => refs.add(s.bufferId));

        this.currentEDL.forEach((s) => refs.add(s.bufferId));
        this.undoStack.forEach(scan);
        this.redoStack.forEach(scan);
        if (this.silenceBufferId) refs.add(this.silenceBufferId);

        for (const key of [...this.buffersPool.keys()]) {
            if (!refs.has(key)) this.buffersPool.delete(key);
        }
    }

    materialize(ctx) {
        if (this.currentEDL.length === 0) return null;

        const sampleRate = ctx.sampleRate;
        const totalSamples = Math.ceil(this.getDuration() * sampleRate);
        const output = new Float32Array(totalSamples);
        let writePos = 0;
        const fadeSamples = crossfadeSamples(sampleRate);

        for (let s = 0; s < this.currentEDL.length; s++) {
            const seg = this.currentEDL[s];
            const buf = this.buffersPool.get(seg.bufferId);
            if (!buf) continue;

            const ch = buf.getChannelData(0);
            const readStart = Math.floor(seg.offset * buf.sampleRate);
            const readLen = Math.floor(seg.length * buf.sampleRate);
            const fadeIn = Math.floor((seg.fadeIn || 0) * sampleRate);
            const fadeOut = Math.floor((seg.fadeOut || 0) * sampleRate);

            const zcWin = zeroCrossWindow(buf.sampleRate);
            let adjStart = readStart;
            if (s > 0 && fadeIn > 0) {
                adjStart = findZeroCrossing(ch, readStart, zcWin);
            }

            const copied = mixSegmentWithFades(
                output,
                writePos,
                ch,
                adjStart,
                Math.min(readLen, ch.length - adjStart),
                fadeIn,
                fadeOut
            );
            writePos += copied;
        }

        const audioBuffer = ctx.createBuffer(1, writePos, sampleRate);
        audioBuffer.getChannelData(0).set(output.subarray(0, writePos));
        return audioBuffer;
    }
}
