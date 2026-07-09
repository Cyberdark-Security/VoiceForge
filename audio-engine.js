/**
 * VoiceForge — audio-engine.js
 */

import { AudioFilters } from './audio-filters.js';

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.playbackGain = null;
        this.outputGain = null;
        this.sourceNode = null;
        this.filterTail = null;
        this.analyserL = null;
        this.analyserR = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.playbackStartCtxTime = 0;
        this.playbackOffset = 0;
        this.playbackDuration = 0;
        this.onTimeUpdate = null;
        this.onEnded = null;
        this.rafId = null;
        this.eqPreset = 'flat';

        this.effects = {
            noiseReduction: false,
            reverb: false,
            eq: false,
            limiter: false
        };

        this.masterGainDb = -6;

        this.mediaStream = null;
        this.mediaStreamSource = null;
        this.workletNode = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.recordedBlobs = [];
        this.isRecording = false;
        this.isPausedRecording = false;
        this.useWorklet = true;
        this._flushResolve = null;
        this._onChunkReceived = null;
        this.captureSeq = 0;
        this.activeCaptureSessionId = 0;
        this.recordMonitorGain = null;
        this.recordInputAnalyser = null;
        this._playbackExtras = [];
        this.playSessionId = 0;
        this._playSeq = 0;

        this.SAMPLE_RATE = 48000;
    }

    getSampleRate() {
        return this.ctx?.sampleRate || this.SAMPLE_RATE;
    }

    /** Duración real en segundos según muestras y tasa del contexto */
    samplesToDuration(sampleCount) {
        const rate = this.getSampleRate();
        return sampleCount / rate;
    }

    async resampleBuffer(buffer, targetRate = null) {
        await this.initContext();
        const rate = targetRate || this.ctx.sampleRate;
        if (!buffer || buffer.sampleRate === rate) return buffer;

        const frames = Math.ceil(buffer.duration * rate);
        const offline = new OfflineAudioContext(1, frames, rate);
        const src = offline.createBufferSource();
        src.buffer = buffer;
        src.connect(offline.destination);
        src.start();
        return offline.startRendering();
    }

    async initContext() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.SAMPLE_RATE,
                latencyHint: 'interactive'
            });

            this.playbackGain = this.ctx.createGain();
            this.outputGain = this.ctx.createGain();
            this.setMasterGainDb(this.masterGainDb);

            this.analyserL = this.ctx.createAnalyser();
            this.analyserR = this.ctx.createAnalyser();
            this.analyserL.fftSize = 2048;
            this.analyserR.fftSize = 2048;

            this.playbackGain.connect(this.outputGain);
            this.outputGain.connect(this.analyserL);
            this.outputGain.connect(this.analyserR);
            this.outputGain.connect(this.ctx.destination);
        }

        if (this.ctx.state === 'suspended') await this.ctx.resume();
        return this.ctx;
    }

    setEqPreset(preset) {
        this.eqPreset = preset;
    }

    setEffects(effects) {
        this.effects = { ...this.effects, ...effects };
    }

    setMasterGainDb(db) {
        this.masterGainDb = db;
        if (this.outputGain) {
            this.outputGain.gain.value = Math.pow(10, db / 20);
        }
    }

    dbToGain(db) {
        return Math.pow(10, db / 20);
    }

    _fadeIn() {
        const t = this.ctx.currentTime;
        this.playbackGain.gain.cancelScheduledValues(t);
        this.playbackGain.gain.setValueAtTime(0, t);
        this.playbackGain.gain.linearRampToValueAtTime(1, t + 0.012);
    }

    _fadeOutAnd(callback) {
        const t = this.ctx.currentTime;
        this.playbackGain.gain.cancelScheduledValues(t);
        this.playbackGain.gain.setValueAtTime(this.playbackGain.gain.value, t);
        this.playbackGain.gain.linearRampToValueAtTime(0, t + 0.012);
        setTimeout(callback, 14);
    }

    _disconnectSource() {
        this._disconnectPlaybackGraph();
    }

    _disconnectPlaybackGraph() {
        if (this.sourceNode) {
            try { this.sourceNode.onended = null; } catch (_) { /* noop */ }
            try { this.sourceNode.stop(0); } catch (_) { /* noop */ }
            try { this.sourceNode.disconnect(); } catch (_) { /* noop */ }
            this.sourceNode = null;
        }
        if (this.filterTail) {
            try { this.filterTail.disconnect(); } catch (_) { /* noop */ }
            this.filterTail = null;
        }
        for (const node of this._playbackExtras) {
            try { node.disconnect(); } catch (_) { /* noop */ }
        }
        this._playbackExtras = [];
    }

    /** Corta reproducción al instante (seek, reinicio) — evita dos voces superpuestas */
    stopImmediate(resetPosition = false) {
        this._stopTimeLoop();
        this._disconnectPlaybackGraph();
        this.isPlaying = false;
        this.isPaused = false;
        if (resetPosition) this.playbackOffset = 0;
        if (this.ctx && this.playbackGain) {
            const t = this.ctx.currentTime;
            this.playbackGain.gain.cancelScheduledValues(t);
            this.playbackGain.gain.setValueAtTime(1, t);
        }
    }

    _startTimeLoop() {
        const tick = () => {
            if (!this.isPlaying || !this.ctx) return;
            const elapsed = this.ctx.currentTime - this.playbackStartCtxTime;
            const t = Math.min(this.playbackOffset + elapsed, this.playbackDuration);
            if (this.onTimeUpdate) this.onTimeUpdate(t);
            if (t >= this.playbackDuration - 0.001) {
                this.isPlaying = false;
                this.isPaused = false;
                if (this.onEnded) this.onEnded();
                return;
            }
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    _stopTimeLoop() {
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.playbackOffset;
        const elapsed = this.ctx.currentTime - this.playbackStartCtxTime;
        return Math.min(this.playbackOffset + elapsed, this.playbackDuration);
    }

    _hasActiveEffects() {
        const eqOn = this.effects.eq && this.eqPreset !== 'flat';
        return eqOn || this.effects.noiseReduction || this.effects.reverb || this.effects.limiter;
    }

    _scheduleEffectRegion(dryGain, wetGain, playbackStartSec, region) {
        const t0 = this.ctx.currentTime;
        const ramp = 0.01;
        const enterAt = Math.max(0, region.start - playbackStartSec);
        const exitAt = Math.max(0, region.end - playbackStartSec);

        dryGain.gain.setValueAtTime(1, t0);
        wetGain.gain.setValueAtTime(0, t0);

        if (exitAt <= 0 || region.end <= region.start) return;

        if (enterAt <= 0) {
            dryGain.gain.setValueAtTime(0, t0);
            wetGain.gain.setValueAtTime(1, t0);
        } else {
            if (enterAt > ramp) {
                dryGain.gain.setValueAtTime(1, t0 + enterAt - ramp);
                wetGain.gain.setValueAtTime(0, t0 + enterAt - ramp);
            }
            dryGain.gain.linearRampToValueAtTime(0, t0 + enterAt + ramp);
            wetGain.gain.linearRampToValueAtTime(1, t0 + enterAt + ramp);
        }

        if (exitAt > enterAt) {
            if (exitAt > ramp) {
                dryGain.gain.setValueAtTime(0, t0 + exitAt - ramp);
                wetGain.gain.setValueAtTime(1, t0 + exitAt - ramp);
            }
            dryGain.gain.linearRampToValueAtTime(1, t0 + exitAt + ramp);
            wetGain.gain.linearRampToValueAtTime(0, t0 + exitAt + ramp);
        }
    }

    async play(audioBuffer, startTime = 0, onTimeUpdate = null, onEnded = null, effectRegion = null) {
        await this.initContext();
        if (this.isCaptureActive()) {
            this.activeCaptureSessionId = ++this.captureSeq;
            this.isRecording = false;
            this.isPausedRecording = false;
            this._onChunkReceived = null;
            this._disconnectRecordGraph();
            this._stopMediaStream();
        }
        this.stopImmediate(false);

        if (!audioBuffer) return;

        const seq = ++this._playSeq;
        const sessionId = ++this.playSessionId;
        this.onTimeUpdate = onTimeUpdate;
        this.onEnded = onEnded;
        this.playbackOffset = startTime;
        this.playbackDuration = audioBuffer.duration;
        this.isPaused = false;

        this.sourceNode = this.ctx.createBufferSource();
        this.sourceNode.buffer = audioBuffer;

        const chainOpts = {
            eqPreset: this.eqPreset,
            noiseReduction: this.effects.noiseReduction,
            reverb: this.effects.reverb,
            eqEnabled: this.effects.eq,
            limiter: this.effects.limiter
        };

        const useRegion =
            effectRegion &&
            effectRegion.end > effectRegion.start &&
            this._hasActiveEffects();

        if (useRegion) {
            const dryGain = this.ctx.createGain();
            const wetGain = this.ctx.createGain();
            const chain = AudioFilters.createLiveEffectChain(this.ctx, this.sourceNode, chainOpts);
            this.sourceNode.connect(dryGain);
            chain.output.connect(wetGain);
            dryGain.connect(this.playbackGain);
            wetGain.connect(this.playbackGain);
            this._scheduleEffectRegion(dryGain, wetGain, startTime, effectRegion);
            this.filterTail = wetGain;
            this._playbackExtras = [dryGain, wetGain, ...chain.nodes];
        } else {
            const chain = AudioFilters.createLiveEffectChain(this.ctx, this.sourceNode, chainOpts);
            this.filterTail = chain.output;
            this.filterTail.connect(this.playbackGain);
            this._playbackExtras = [...chain.nodes];
        }

        this.sourceNode.onended = () => {
            if (sessionId !== this.playSessionId || !this.isPlaying) return;
            this.isPlaying = false;
            this._stopTimeLoop();
            if (this.onEnded) this.onEnded();
        };

        this._fadeIn();
        if (seq !== this._playSeq) {
            this._disconnectPlaybackGraph();
            return;
        }
        this.playbackStartCtxTime = this.ctx.currentTime;
        this.sourceNode.start(0, startTime);
        this.isPlaying = true;
        this._startTimeLoop();
    }

    pause() {
        if (!this.isPlaying) return;
        this.playbackOffset = this.getCurrentTime();
        this._fadeOutAnd(() => {
            this._disconnectSource();
            this.isPlaying = false;
            this.isPaused = true;
            this._stopTimeLoop();
        });
    }

    stop(resetPosition = true) {
        this._stopTimeLoop();
        this._playSeq++;
        this.playSessionId++;
        if (this.isPlaying) {
            this._fadeOutAnd(() => {
                this._disconnectSource();
                this.isPlaying = false;
                this.isPaused = false;
                if (resetPosition) this.playbackOffset = 0;
            });
        } else {
            this._disconnectSource();
            this.isPlaying = false;
            this.isPaused = false;
            if (resetPosition) this.playbackOffset = 0;
        }
    }

    async resume(audioBuffer, onTimeUpdate, onEnded) {
        if (!this.isPaused) return this.play(audioBuffer, 0, onTimeUpdate, onEnded);
        return this.play(audioBuffer, this.playbackOffset, onTimeUpdate, onEnded);
    }

    getAnalysers() {
        return { left: this.analyserL, right: this.analyserR };
    }

    getRecordAnalysers() {
        const a = this.recordInputAnalyser || this.analyserL;
        return { left: a, right: a };
    }

    isCaptureActive() {
        return this.isRecording || this.isPausedRecording;
    }

    _connectRecordMonitor(fromNode) {
        this.recordMonitorGain = this.ctx.createGain();
        this.recordMonitorGain.gain.value = 0;
        fromNode.connect(this.recordMonitorGain);
        this.recordMonitorGain.connect(this.ctx.destination);
    }

    _disconnectRecordGraph() {
        if (this.workletNode?.port) {
            this.workletNode.port.onmessage = null;
        }
        if (this.workletNode) {
            try { this.workletNode.disconnect(); } catch (_) { /* noop */ }
            this.workletNode = null;
        }
        if (this.recordMonitorGain) {
            try { this.recordMonitorGain.disconnect(); } catch (_) { /* noop */ }
            this.recordMonitorGain = null;
        }
        if (this.recordInputAnalyser) {
            try { this.recordInputAnalyser.disconnect(); } catch (_) { /* noop */ }
            this.recordInputAnalyser = null;
        }
        if (this.mediaStreamSource) {
            try { this.mediaStreamSource.disconnect(); } catch (_) { /* noop */ }
            this.mediaStreamSource = null;
        }
    }

    _invalidateCaptureSession() {
        this.activeCaptureSessionId = ++this.captureSeq;
        this.isRecording = false;
        this.isPausedRecording = false;
        this._onChunkReceived = null;
    }

    /** @deprecated */
    getAnalyser() {
        return this.analyserL;
    }

    pauseRecording() {
        if (!this.isRecording || this.isPausedRecording) return;
        if (this.mediaStreamSource) {
            try { this.mediaStreamSource.disconnect(); } catch (_) { /* noop */ }
        }
        if (this.mediaRecorder?.state === 'recording') {
            try { this.mediaRecorder.pause(); } catch (_) { /* noop */ }
        }
        this.isPausedRecording = true;
    }

    resumeRecording() {
        if (!this.isRecording || !this.isPausedRecording || !this.mediaStreamSource) return;
        if (this.workletNode) {
            this.mediaStreamSource.connect(this.workletNode);
        }
        if (this.recordInputAnalyser) {
            this.mediaStreamSource.connect(this.recordInputAnalyser);
        }
        if (this.mediaRecorder?.state === 'paused') {
            try { this.mediaRecorder.resume(); } catch (_) { /* noop */ }
        }
        this.isPausedRecording = false;
    }

    async startRecording(onChunkReceived) {
        await this.initContext();
        this._disconnectRecordGraph();
        this._stopMediaStream();

        const sessionId = ++this.captureSeq;
        this.activeCaptureSessionId = sessionId;
        this.recordedChunks = [];
        this.recordedBlobs = [];
        this._onChunkReceived = onChunkReceived;

        this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: this.SAMPLE_RATE
            }
        });

        if (sessionId !== this.activeCaptureSessionId) {
            this._stopMediaStream();
            return;
        }

        this.recordInputAnalyser = this.ctx.createAnalyser();
        this.recordInputAnalyser.fftSize = 2048;

        if (this.useWorklet && this.ctx.audioWorklet) {
            try {
                await this.ctx.audioWorklet.addModule('audio-recorder-processor.js');
                if (sessionId !== this.activeCaptureSessionId) {
                    this._stopMediaStream();
                    return;
                }

                this.mediaStreamSource = this.ctx.createMediaStreamSource(this.mediaStream);
                this.workletNode = new AudioWorkletNode(this.ctx, 'audio-recorder-processor');
                this.workletNode.port.onmessage = (e) => {
                    if (sessionId !== this.activeCaptureSessionId || this.isPausedRecording) return;
                    if (e.data.type === 'samples' && this._onChunkReceived) {
                        this._onChunkReceived(e.data.samples);
                    }
                    if (e.data.type === 'flushed' && this._flushResolve) {
                        this._flushResolve();
                        this._flushResolve = null;
                    }
                };

                this.mediaStreamSource.connect(this.workletNode);
                this.mediaStreamSource.connect(this.recordInputAnalyser);
                this._connectRecordMonitor(this.workletNode);

                this.isRecording = true;
                this.isPausedRecording = false;
                return;
            } catch (err) {
                console.warn('AudioWorklet no disponible, usando MediaRecorder:', err);
                this._disconnectRecordGraph();
            }
        }

        await this.startRecordingFallback(onChunkReceived, sessionId);
    }

    async startRecordingFallback(onChunkReceived, sessionId) {
        if (sessionId !== this.activeCaptureSessionId) {
            this._stopMediaStream();
            return;
        }

        this._onChunkReceived = onChunkReceived;
        this.mediaStreamSource = this.ctx.createMediaStreamSource(this.mediaStream);
        this.mediaStreamSource.connect(this.recordInputAnalyser);
        this._connectRecordMonitor(this.mediaStreamSource);

        this.mediaRecorder = new MediaRecorder(this.mediaStream, {
            mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/webm'
        });
        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.recordedBlobs.push(e.data);
        };
        this.mediaRecorder.start(250);
        this.isRecording = true;
        this.isPausedRecording = false;
    }

    async stopRecording() {
        if (!this.isRecording && !this.isPausedRecording) return null;

        const onChunk = this._onChunkReceived;
        const worklet = this.workletNode;

        this.isRecording = false;
        this.isPausedRecording = false;

        // Vaciar el worklet ANTES de cortar el micrófono (evita perder audio al final)
        if (worklet && onChunk) {
            await new Promise((resolve) => {
                const timeout = setTimeout(resolve, 600);
                const prevHandler = worklet.port.onmessage;
                worklet.port.onmessage = (e) => {
                    if (e.data?.type === 'samples') {
                        onChunk(e.data.samples);
                    }
                    if (e.data?.type === 'flushed') {
                        clearTimeout(timeout);
                        worklet.port.onmessage = prevHandler;
                        resolve();
                    }
                };
                worklet.port.postMessage({ type: 'flush' });
            });
        }

        this._onChunkReceived = null;
        this.activeCaptureSessionId = ++this.captureSeq;

        if (this.mediaStreamSource) {
            try { this.mediaStreamSource.disconnect(); } catch (_) { /* noop */ }
            this.mediaStreamSource = null;
        }
        this._stopMediaStream();

        if (worklet) {
            if (worklet.port) worklet.port.onmessage = null;
            try { worklet.disconnect(); } catch (_) { /* noop */ }
            this.workletNode = null;
        }

        if (this.recordMonitorGain) {
            try { this.recordMonitorGain.disconnect(); } catch (_) { /* noop */ }
            this.recordMonitorGain = null;
        }
        if (this.recordInputAnalyser) {
            try { this.recordInputAnalyser.disconnect(); } catch (_) { /* noop */ }
            this.recordInputAnalyser = null;
        }

        let decodedFallback = null;

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            await new Promise((resolve) => {
                this.mediaRecorder.onstop = resolve;
                this.mediaRecorder.stop();
            });
            const blob = new Blob(this.recordedBlobs, { type: this.mediaRecorder.mimeType });
            const arrayBuf = await blob.arrayBuffer();
            decodedFallback = await this.decodeAudioData(arrayBuf);
            this.mediaRecorder = null;
        }

        return decodedFallback;
    }

    _stopMediaStream() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((t) => t.stop());
            this.mediaStream = null;
        }
    }

    consolidateChunks(chunks) {
        if (!chunks.length) return null;
        const rate = this.getSampleRate();
        let total = 0;
        for (const c of chunks) total += c.length;
        const merged = new Float32Array(total);
        let off = 0;
        for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
        }
        const buf = this.ctx.createBuffer(1, merged.length, rate);
        buf.getChannelData(0).set(merged);
        return buf;
    }

    async decodeAudioData(arrayBuffer) {
        await this.initContext();
        const decoded = await this.ctx.decodeAudioData(arrayBuffer.slice(0));

        if (decoded.sampleRate === this.ctx.sampleRate && decoded.numberOfChannels === 1) {
            return decoded;
        }

        return this.resampleBuffer(decoded, this.ctx.sampleRate);
    }
}
