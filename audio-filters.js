/**
 * VoiceForge — audio-filters.js
 */

import { extractBufferRange, spliceProcessedRange } from './splice-utils.js';

export class AudioFilters {
    static _makeReverbIR(ctx, duration = 1.8, decay = 2.5) {
        const rate = ctx.sampleRate;
        const len = Math.floor(rate * duration);
        const ir = ctx.createBuffer(2, len, rate);
        for (let c = 0; c < 2; c++) {
            const ch = ir.getChannelData(c);
            for (let i = 0; i < len; i++) {
                ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
            }
        }
        return ir;
    }

    static createLiveEffectChain(ctx, sourceNode, options = {}) {
        const {
            eqPreset = 'flat',
            noiseReduction = false,
            reverb = false,
            eqEnabled = false,
            limiter = false
        } = options;

        let lastNode = sourceNode;
        const tail = [];

        if (noiseReduction) {
            const gate = ctx.createDynamicsCompressor();
            gate.threshold.value = -45;
            gate.knee.value = 0;
            gate.ratio.value = 20;
            gate.attack.value = 0.003;
            gate.release.value = 0.15;
            lastNode.connect(gate);
            lastNode = gate;
            tail.push(gate);
        }

        const useEq = eqEnabled && eqPreset !== 'flat';
        if (useEq) {
            lastNode = this._appendEqNodes(ctx, lastNode, eqPreset, tail);
        }

        if (reverb) {
            const convolver = ctx.createConvolver();
            convolver.buffer = this._makeReverbIR(ctx);
            const dry = ctx.createGain();
            const wet = ctx.createGain();
            dry.gain.value = 0.72;
            wet.gain.value = 0.28;
            lastNode.connect(dry);
            lastNode.connect(convolver);
            convolver.connect(wet);
            const merge = ctx.createGain();
            dry.connect(merge);
            wet.connect(merge);
            lastNode = merge;
            tail.push(convolver, dry, wet, merge);
        }

        if (limiter) {
            const lim = ctx.createDynamicsCompressor();
            lim.threshold.value = -1;
            lim.knee.value = 0;
            lim.ratio.value = 20;
            lim.attack.value = 0.001;
            lim.release.value = 0.08;
            lastNode.connect(lim);
            lastNode = lim;
            tail.push(lim);
        }

        return { output: lastNode, nodes: tail };
    }

    static _appendEqNodes(ctx, input, presetName, tail) {
        let lastNode = input;

        const lowCut = ctx.createBiquadFilter();
        lowCut.type = 'highpass';
        lowCut.frequency.value = presetName === 'radio' ? 100 : 80;
        lastNode.connect(lowCut);
        lastNode = lowCut;
        tail.push(lowCut);

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
        tail.push(peak);

        if (presetName === 'radio') {
            const shelf = ctx.createBiquadFilter();
            shelf.type = 'highshelf';
            shelf.frequency.value = 8000;
            shelf.gain.value = 1.5;
            lastNode.connect(shelf);
            lastNode = shelf;
            tail.push(shelf);
        }

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 6;
        comp.ratio.value = 3;
        comp.attack.value = 0.005;
        comp.release.value = 0.1;
        lastNode.connect(comp);
        tail.push(comp);
        return comp;
    }

    /** @deprecated use createLiveEffectChain */
    static createLiveFilterChain(ctx, sourceNode, presetName = 'flat') {
        return this.createLiveEffectChain(ctx, sourceNode, {
            eqEnabled: true,
            eqPreset: presetName
        }).output;
    }

    static async processOfflineEffects(sourceBuffer, options = {}) {
        const {
            eqPreset = 'flat',
            noiseReduction = false,
            reverb = false,
            eqEnabled = false,
            limiter = false,
            gateThreshold = -45,
            gateRelease = 150
        } = options;

        let buffer = sourceBuffer;

        if (eqEnabled && eqPreset !== 'flat') {
            buffer = await this.processOfflineEQ(buffer, eqPreset);
        }

        if (noiseReduction) {
            buffer = await this.applyNoiseGateMain(buffer, gateThreshold, gateRelease);
        }

        if (reverb) {
            buffer = await this.processOfflineReverb(buffer);
        }

        if (limiter) {
            buffer = await this.processOfflineLimiter(buffer);
        }

        return buffer;
    }

    /** Procesa solo [startSec, endSec) y reinserta en el buffer completo. */
    static async processOfflineEffectsOnRange(fullBuffer, startSec, endSec, ctx, options = {}) {
        const slice = extractBufferRange(ctx, fullBuffer, startSec, endSec);
        const processed = await this.processOfflineEffects(slice, options);
        return spliceProcessedRange(ctx, fullBuffer, startSec, endSec, processed);
    }

    static async processOfflineEQ(sourceBuffer, presetName = 'flat') {
        if (presetName === 'flat') return sourceBuffer;

        const sr = sourceBuffer.sampleRate;
        const frames = sourceBuffer.length;
        const offline = new OfflineAudioContext(1, frames, sr);
        const src = offline.createBufferSource();
        src.buffer = sourceBuffer;
        const { output } = this.createLiveEffectChain(offline, src, {
            eqEnabled: true,
            eqPreset: presetName
        });
        output.connect(offline.destination);
        src.start();
        return offline.startRendering();
    }

    static async processOfflineReverb(sourceBuffer) {
        const sr = sourceBuffer.sampleRate;
        const tailSec = 1.8;
        const frames = sourceBuffer.length + Math.floor(sr * tailSec);
        const offline = new OfflineAudioContext(1, frames, sr);
        const src = offline.createBufferSource();
        src.buffer = sourceBuffer;
        const { output } = this.createLiveEffectChain(offline, src, { reverb: true });
        output.connect(offline.destination);
        src.start();
        return offline.startRendering();
    }

    static async processOfflineLimiter(sourceBuffer) {
        const sr = sourceBuffer.sampleRate;
        const frames = sourceBuffer.length;
        const offline = new OfflineAudioContext(1, frames, sr);
        const src = offline.createBufferSource();
        src.buffer = sourceBuffer;
        const { output } = this.createLiveEffectChain(offline, src, { limiter: true });
        output.connect(offline.destination);
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
