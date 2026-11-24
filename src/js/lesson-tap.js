/*
 * The lesson recorder's ear (see lesson.js).
 *
 * Runs on the browser's own audio thread, never on the one that draws the board,
 * so listening costs the pen nothing. It mixes the microphone down to one
 * channel and hands it over a tenth of a second at a time; the recorder turns
 * each piece into compressed sound straight away, so a long lesson never piles
 * up as raw audio in memory.
 *
 * While the recording is paused, the sound is simply dropped here.
 */
class GazBoardLessonTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buf = new Float32Array(this.size);
    this.fill = 0;
    this.paused = false;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.paused !== undefined) this.paused = !!m.paused;
      if (m.flush) { this.send(); this.port.postMessage({ flushed: true }); }
    };
  }

  send() {
    if (!this.fill) return;
    const out = this.buf.slice(0, this.fill);
    this.port.postMessage({ samples: out }, [out.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (this.paused || !input || !input.length || !input[0]) return true;
    const n = input[0].length, chs = input.length;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < chs; c++) v += input[c][i];
      this.buf[this.fill++] = v / chs;
      if (this.fill === this.size) this.send();
    }
    return true;
  }
}

registerProcessor('gazboard-lesson-tap', GazBoardLessonTap);
