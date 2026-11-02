const INPUT_GAIN_RAMP_FRAMES = 882;

class PcmSourcePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.sourceCount = 0;
    this.currentGains = [];
    this.targetGains = [];
    this.gainRampFramesRemaining = 0;
    this.active = false;
    this.startContextFrame = 0;
    this.startSourceFrame = 0;
    this.endSourceFrame = 0;
    this.underrunReported = false;
    this.port.onmessage = ({ data }) => this.handleMessage(data);
  }

  handleMessage(message) {
    switch (message.type) {
      case "configure":
        this.sourceCount = message.sourceCount;
        this.currentGains = Array(this.sourceCount).fill(0);
        this.targetGains = Array(this.sourceCount).fill(0);
        break;
      case "chunk":
        this.chunks.push({
          startFrame: message.startFrame,
          frameCount: message.frameCount,
          samples: new Float32Array(message.samples),
        });
        this.chunks.sort((left, right) => left.startFrame - right.startFrame);
        break;
      case "gains":
        this.targetGains = [...message.gains];
        if (message.immediate) {
          this.currentGains = [...this.targetGains];
          this.gainRampFramesRemaining = 0;
        } else {
          this.gainRampFramesRemaining = INPUT_GAIN_RAMP_FRAMES;
        }
        break;
      case "start":
        this.startContextFrame = message.contextFrame;
        this.startSourceFrame = message.sourceFrame;
        this.endSourceFrame = message.endSourceFrame;
        this.active = true;
        this.underrunReported = false;
        break;
      case "pause":
        this.active = false;
        this.chunks = [];
        break;
    }
  }

  chunkForFrame(sourceFrame) {
    while (
      this.chunks.length > 1 &&
      this.chunks[0].startFrame + this.chunks[0].frameCount <= sourceFrame
    ) {
      this.chunks.shift();
    }
    const chunk = this.chunks[0];
    if (
      chunk === undefined ||
      sourceFrame < chunk.startFrame ||
      sourceFrame >= chunk.startFrame + chunk.frameCount
    ) {
      return null;
    }
    return chunk;
  }

  updateGains() {
    if (this.gainRampFramesRemaining <= 0) {
      return;
    }
    for (let index = 0; index < this.sourceCount; index += 1) {
      this.currentGains[index] +=
        (this.targetGains[index] - this.currentGains[index]) /
        this.gainRampFramesRemaining;
    }
    this.gainRampFramesRemaining -= 1;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1];
    for (let outputFrame = 0; outputFrame < left.length; outputFrame += 1) {
      this.updateGains();
      const contextFrame = currentFrame + outputFrame;
      if (!this.active || contextFrame < this.startContextFrame) {
        left[outputFrame] = 0;
        right[outputFrame] = 0;
        continue;
      }
      const sourceFrame =
        this.startSourceFrame + contextFrame - this.startContextFrame;
      if (sourceFrame >= this.endSourceFrame) {
        this.active = false;
        left[outputFrame] = 0;
        right[outputFrame] = 0;
        this.port.postMessage({ type: "ended" });
        continue;
      }
      const chunk = this.chunkForFrame(sourceFrame);
      if (chunk === null) {
        left[outputFrame] = 0;
        right[outputFrame] = 0;
        if (!this.underrunReported) {
          this.underrunReported = true;
          this.port.postMessage({ type: "underrun", sourceFrame });
        }
        continue;
      }
      const frameOffset = sourceFrame - chunk.startFrame;
      let leftSample = 0;
      let rightSample = 0;
      for (let sourceIndex = 0; sourceIndex < this.sourceCount; sourceIndex += 1) {
        const gain = this.currentGains[sourceIndex] ?? 0;
        if (gain === 0) {
          continue;
        }
        const sampleOffset =
          (sourceIndex * chunk.frameCount + frameOffset) * 2;
        leftSample += chunk.samples[sampleOffset] * gain;
        rightSample += chunk.samples[sampleOffset + 1] * gain;
      }
      left[outputFrame] = leftSample;
      right[outputFrame] = rightSample;
    }
    return true;
  }
}

registerProcessor("earcopy-pcm-source-playback", PcmSourcePlaybackProcessor);
