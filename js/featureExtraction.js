importScripts('./lib/essentia.js-model.umd.js');
importScripts('./lib/essentia-wasm.module.js');
const EssentiaWASM = Module;

const extractor = new EssentiaModel.EssentiaTFInputExtractor(EssentiaWASM, 'musicnn', false);

function outputFeatures(idx, f) {
    postMessage({
        idx: idx,
        features: f
    });
}

function computeFeatures(audioData) {
    const featuresStart = Date.now();
    const features = extractor.computeFrameWise(audioData, 256);
    console.info(`Feature extraction took: ${Date.now() - featuresStart}`);
    return features;
}

onmessage = function listenToMainThread(msg) {
    if (msg.data.audio) {
        const idx = msg.data.idx;
        const audio = new Float32Array(msg.data.audio);
        console.log(`From FE worker: Received segment ${idx}`);
        const features = computeFeatures(audio);
        outputFeatures(idx, features);
    }
};