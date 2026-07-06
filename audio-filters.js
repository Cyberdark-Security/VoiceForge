/**
 * VoiceForge AI — audio-filters.js
 */

export class AudioFilters {
    static createLiveFilterChain(ctx, sourceNode, presetName = 'flat') {
        let lastNode = sourceNode;
        if (presetName === 'flat') return lastNode;

        const lowCut = ctx.createBiquadFilter();
        lowCut.type = 'highpass';
        lowCut.frequency.value = presetName === 'radio' ? 100 : 80;
        lastNode.connect(lowCut);
        lastNode = lowCut;

        const peak = ctx.createBiquadFilter();
        peak.type = 'peaking';
        if (presetName === 'podcast') {
            peak.frequency.value = 3000;
            peak.Q.value = 1.0;
            peak.gain.value = 2.0;
        } else {
            peak.frequency.value = 2500;
            peak.Q.value = 1.2;
            peak.gain.value = 3.0;
        }
        lastNode.connect(peak);
        lastNode = peak;

        if (presetName === 'radio') {
            const shelf = ctx.createBiquadFilter();
            shelf.type = 'highshelf';
            shelf.frequency.value = 8000;
            shelf.gain.value = 1.5;
            lastNode.connect(shelf);
            lastNode = shelf;
        }

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 6;
        comp.ratio.value = 3;
        comp.attack.value = 0.005;
        comp.release.value = 0.1;
        lastNode.connect(comp);
        return comp;
    }

    static async processOfflineEQ(sourceBuffer, presetName = 'flat') {
        if (presetName === 'flat') return sourceBuffer;

        const sr = sourceBuffer.sampleRate;
        const frames = sourceBuffer.length;
        const offline = new OfflineAudioContext(1, frames, sr);
        const src = offline.createBufferSource();
        src.buffer = sourceBuffer;
        const tail = this.createLiveFilterChain(offline, src, presetName);
        tail.connect(offline.destination);
        src.start();
        return offline.startRendering();
    }

    static async applyNoiseGateMain(audioBuffer, thresholdDB, releaseMs) {
        const channel = audioBuffer.getChannelData(0).slice();

        return new Promise((resolve, reject) => {
            const worker = new Worker('audio-worker.js');
            const id = Date.now();

            worker.onmessage = (e) => {
                if (e.data.type === 'noiseGateComplete' && e.data.id === id) {
                    const offline = new OfflineAudioContext(1, e.data.data.length, audioBuffer.sampleRate);
                    const buf = offline.createBuffer(1, e.data.data.length, audioBuffer.sampleRate);
                    buf.getChannelData(0).set(e.data.data);
                    worker.terminate();
                    resolve(buf);
                }
            };
            worker.onerror = (err) => {
                worker.terminate();
                reject(err);
            };
            worker.postMessage({
                type: 'applyNoiseGate',
                id,
                data: {
                    channelData: channel,
                    thresholdDB,
                    releaseMs,
                    sampleRate: audioBuffer.sampleRate
                }
            }, [channel.buffer]);
        });
    }
}
