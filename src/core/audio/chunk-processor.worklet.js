class ChunkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = [];
    this.frameSamples = options.processorOptions.frameSamples;
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    if (input) {
      this.buffer.push(...input);

      while (this.buffer.length >= this.frameSamples) {
        const frame = this.buffer.slice(0, this.frameSamples);
        this.buffer = this.buffer.slice(this.frameSamples);
        this.port.postMessage(frame);
      }
    }
    return true;
  }
}

registerProcessor("chunk-processor", ChunkProcessor);
