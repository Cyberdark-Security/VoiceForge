/**
 * VoiceForge AI — audio-recorder-processor.js
 * Envía bloques pequeños (~128 muestras) para waveform en vivo fluida
 */

class AudioRecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.postEvery = 128;
        this.buffer = new Float32Array(this.postEvery);
        this.bufferIndex = 0;

        this.port.onmessage = (e) => {
            if (e.data?.type === 'flush') this.flush();
        };
    }

    flush() {
        if (this.bufferIndex > 0) {
            this.port.postMessage({
                type: 'samples',
                samples: this.buffer.slice(0, this.bufferIndex)
            });
            this.buffer = new Float32Array(this.postEvery);
            this.bufferIndex = 0;
        }
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;

        const channelData = input[0];
        for (let i = 0; i < channelData.length; i++) {
            this.buffer[this.bufferIndex++] = channelData[i];
            if (this.bufferIndex >= this.postEvery) {
                this.port.postMessage({
                    type: 'samples',
                    samples: this.buffer.slice()
                });
                this.buffer = new Float32Array(this.postEvery);
                this.bufferIndex = 0;
            }
        }
        return true;
    }
}

registerProcessor('audio-recorder-processor', AudioRecorderProcessor);
