/**
 * VoiceForge — audio-worker.js
 */

self.onmessage = function (e) {
    const { type, data, id } = e.data;

    if (type === 'applyNoiseGate') {
        const { channelData, thresholdDB, releaseMs, sampleRate } = data;
        const processed = applyNoiseGate(channelData, thresholdDB, releaseMs, sampleRate);
        self.postMessage({ type: 'noiseGateComplete', id, data: processed }, [processed.buffer]);
    }

    if (type === 'buildPeakPyramid') {
        const { channelData, bucketSizes } = data;
        const pyramid = buildPeakPyramid(channelData, bucketSizes || [64, 256, 1024, 4096]);
        self.postMessage({ type: 'peakPyramidComplete', id, data: pyramid });
    }
};

function applyNoiseGate(channelData, thresholdDB, releaseMs, sampleRate) {
    const len = channelData.length;
    const result = new Float32Array(len);
    const thresholdAmp = Math.pow(10, thresholdDB / 20);
    const attackSamples = Math.max(1, Math.floor(0.005 * sampleRate));
    const releaseSamples = Math.max(1, Math.floor((releaseMs / 1000) * sampleRate));
    const holdSamples = Math.max(1, Math.floor(0.02 * sampleRate));

    let envelope = 0;
    let gate = 0;
    let hold = 0;

    for (let i = 0; i < len; i++) {
        const sample = channelData[i];
        const abs = Math.abs(sample);

        if (abs > envelope) envelope += (abs - envelope) / attackSamples;
        else envelope += (abs - envelope) / releaseSamples;

        if (envelope >= thresholdAmp) {
            gate += (1 - gate) / attackSamples;
            hold = holdSamples;
        } else if (hold > 0) {
            hold--;
        } else {
            gate -= gate / releaseSamples;
        }

        result[i] = sample * gate;
    }

    return result;
}

function buildPeakPyramid(data, bucketSizes) {
    return bucketSizes.map((bucketSize) => {
        const peaks = [];
        for (let i = 0; i < data.length; i += bucketSize) {
            let max = 0;
            let min = 0;
            const end = Math.min(i + bucketSize, data.length);
            for (let j = i; j < end; j++) {
                const v = data[j];
                if (v > max) max = v;
                if (v < min) min = v;
            }
            peaks.push({ max, min });
        }
        return { bucketSize, peaks };
    });
}
