/**
 * VoiceForge AI — splice-utils.js
 * Zero-crossing, crossfades y Smart Silence Truncation
 */

export const CROSSFADE_MS = 15;
export const ZERO_CROSS_WINDOW_MS = 15;

export function crossfadeSamples(sampleRate, ms = CROSSFADE_MS) {
    return Math.max(1, Math.floor((ms / 1000) * sampleRate));
}

export function zeroCrossWindow(sampleRate, ms = ZERO_CROSS_WINDOW_MS) {
    return Math.max(1, Math.floor((ms / 1000) * sampleRate));
}

export function findZeroCrossing(channelData, startIndex, searchWindow) {
    let bestIndex = startIndex;
    let minVal = 1.0;

    const start = Math.max(0, startIndex - Math.floor(searchWindow / 2));
    const end = Math.min(channelData.length - 1, startIndex + Math.floor(searchWindow / 2));

    for (let i = start; i <= end; i++) {
        const val = Math.abs(channelData[i]);
        if (val === 0) return i;

        if (i > 0 && (
            (channelData[i] >= 0 && channelData[i - 1] < 0) ||
            (channelData[i] < 0 && channelData[i - 1] >= 0)
        )) {
            return i;
        }

        if (val < minVal) {
            minVal = val;
            bestIndex = i;
        }
    }

    return bestIndex;
}

export function applyCrossfadeToJoin(output, writePos, tailA, headB, fadeSamples) {
    const fade = Math.min(fadeSamples, tailA.length, headB.length);
    if (fade <= 1) {
        output.set(headB, writePos);
        return headB.length;
    }

    for (let i = 0; i < fade; i++) {
        const wB = i / (fade - 1);
        const wA = 1 - wB;
        output[writePos + i] = tailA[i] * wA + headB[i] * wB;
    }

    if (headB.length > fade) {
        output.set(headB.subarray(fade), writePos + fade);
    }

    return headB.length;
}

export function mixSegmentWithFades(
    output,
    writePos,
    channelData,
    readStart,
    readLength,
    fadeInSamples,
    fadeOutSamples
) {
    const len = Math.min(readLength, channelData.length - readStart);
    for (let i = 0; i < len; i++) {
        let gain = 1;
        if (fadeInSamples > 0 && i < fadeInSamples) {
            gain = i / fadeInSamples;
        }
        if (fadeOutSamples > 0 && i >= len - fadeOutSamples) {
            const t = (len - 1 - i) / fadeOutSamples;
            gain = Math.min(gain, Math.max(0, t));
        }
        output[writePos + i] = channelData[readStart + i] * gain;
    }
    return len;
}

export function truncateSilences(ctx, audioBuffer, thresholdDB = -45, minSilenceSec = 0.4, targetSilenceSec = 0.15) {
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.getChannelData(0);
    const thresholdAmp = Math.pow(10, thresholdDB / 20);
    const minSilenceSamples = Math.floor(minSilenceSec * sampleRate);
    const targetSilenceSamples = Math.floor(targetSilenceSec * sampleRate);
    const blockSize = 512;
    const blockCount = Math.ceil(channelData.length / blockSize);
    const isSilence = new Uint8Array(blockCount);

    for (let b = 0; b < blockCount; b++) {
        const start = b * blockSize;
        const end = Math.min(start + blockSize, channelData.length);
        let sumSquares = 0;
        for (let i = start; i < end; i++) {
            sumSquares += channelData[i] * channelData[i];
        }
        const rms = Math.sqrt(sumSquares / (end - start || 1));
        isSilence[b] = rms < thresholdAmp ? 1 : 0;
    }

    const silenceRanges = [];
    let inSilence = false;
    let silenceStartBlock = 0;

    for (let b = 0; b < blockCount; b++) {
        if (isSilence[b] === 1 && !inSilence) {
            inSilence = true;
            silenceStartBlock = b;
        } else if (isSilence[b] === 0 && inSilence) {
            inSilence = false;
            const startSample = silenceStartBlock * blockSize;
            const endSample = b * blockSize;
            if (endSample - startSample >= minSilenceSamples) {
                silenceRanges.push({ start: startSample, end: endSample });
            }
        }
    }

    if (inSilence) {
        const startSample = silenceStartBlock * blockSize;
        const endSample = channelData.length;
        if (endSample - startSample >= minSilenceSamples) {
            silenceRanges.push({ start: startSample, end: endSample });
        }
    }

    if (silenceRanges.length === 0) return audioBuffer;

    const segments = [];
    let lastCopied = 0;

    for (const range of silenceRanges) {
        if (range.start > lastCopied) {
            segments.push({ start: lastCopied, end: range.start, isSilence: false });
        }
        segments.push({ start: range.start, end: range.start + targetSilenceSamples, isSilence: true });
        lastCopied = range.end;
    }

    if (lastCopied < channelData.length) {
        segments.push({ start: lastCopied, end: channelData.length, isSilence: false });
    }

    let totalSamples = 0;
    for (const seg of segments) {
        totalSamples += seg.isSilence ? targetSilenceSamples : (seg.end - seg.start);
    }

    const newBuffer = ctx.createBuffer(1, totalSamples, sampleRate);
    const out = newBuffer.getChannelData(0);
    let writeIndex = 0;

    const fade = crossfadeSamples(sampleRate);

    for (let s = 0; s < segments.length; s++) {
        const seg = segments[s];
        if (seg.isSilence) {
            writeIndex += targetSilenceSamples;
            continue;
        }

        const slice = channelData.subarray(seg.start, seg.end);
        const prev = s > 0 ? segments[s - 1] : null;
        const next = s < segments.length - 1 ? segments[s + 1] : null;
        const fadeIn = prev?.isSilence ? 0 : fade;
        const fadeOut = next?.isSilence ? 0 : fade;

        mixSegmentWithFades(out, writeIndex, channelData, seg.start, seg.end - seg.start, fadeIn, fadeOut);
        writeIndex += seg.end - seg.start;
    }

    return newBuffer;
}

export function computeLevels(channelData) {
    if (!channelData || channelData.length === 0) {
        return { peak: 0, rms: 0, peakDb: -Infinity, rmsDb: -Infinity };
    }

    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < channelData.length; i++) {
        const abs = Math.abs(channelData[i]);
        if (abs > peak) peak = abs;
        sumSquares += channelData[i] * channelData[i];
    }

    const rms = Math.sqrt(sumSquares / channelData.length);
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

    return { peak, rms, peakDb, rmsDb };
}

export function normalizeBuffer(ctx, audioBuffer, targetPeakDb = -1) {
    const data = audioBuffer.getChannelData(0);
    const { peak } = computeLevels(data);
    if (peak <= 0) return audioBuffer;

    const targetPeak = Math.pow(10, targetPeakDb / 20);
    const gain = targetPeak / peak;

    const out = ctx.createBuffer(1, data.length, audioBuffer.sampleRate);
    const outData = out.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        outData[i] = Math.max(-1, Math.min(1, data[i] * gain));
    }
    return out;
}
