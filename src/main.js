import { AnalysisResults, toggleUploadDisplayHTML, PlaybackControls } from './viz.js';
import { preprocess, shortenAudio } from './audioUtils.js';

import WaveSurfer from 'https://unpkg.com/wavesurfer.js@beta';
import RegionsPlugin from 'https://unpkg.com/wavesurfer.js@beta/dist/plugins/regions.js';
import { segment } from './segmentation.js';

const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();
const KEEP_PERCENTAGE = 0.15; // keep only 15% of audio file

let essentia = null;
let essentiaAnalysis;
let featureExtractionWorker = null;
let inferenceWorkers = {};
const modelNames = ['mood_happy', 'mood_sad', 'mood_relaxed', 'mood_aggressive', 'danceability'];
let inferenceResultPromises = [];

const resultsViz = new AnalysisResults(modelNames);
let controls;

// Create an instance of WaveSurfer
const wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: "#f18e1b",
    progressColor: "#ff5a59",
    cursorColor: "#a9aeb1",
    autoCenter: true,
    cursorWidth: 2,
    height: 128,
    barWidth: 4,
    barHeight: 0.7,
    barGap: 2,
    barRadius: 4,
    minPxPerSec: 100,
    scrollParent: true,
});

// Initialize the Regions plugin
const wsRegions = wavesurfer.registerPlugin(RegionsPlugin.create());

const dropInput = document.createElement('input');
dropInput.setAttribute('type', 'file');
dropInput.addEventListener('change', () => {
    processFileUpload(dropInput.files);
});

const dropArea = document.querySelector('#file-drop-area');
dropArea.addEventListener('dragover', (e) => { e.preventDefault(); });
dropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    processFileUpload(files);
});
dropArea.addEventListener('click', () => {
    dropInput.click();
});

function processFileUpload(files) {
    if (files.length > 1) {
        alert("Only single-file uploads are supported currently");
        throw Error("Multiple file upload attempted, cannot process.");
    } else if (files.length) {
        files[0].arrayBuffer().then((ab) => {
            decodeFile(ab);
            // reduce the size of the banner and crop the top and bottom
            document.getElementById('banner').style.height = '30%';
            document.getElementById('banner').style.objectFit = 'cover';
            toggleUploadDisplayHTML('display');
            const url = URL.createObjectURL(files[0]);
            wavesurfer.load(url);
            controls = new PlaybackControls(wavesurfer);
            controls.toggleEnabled(false);
        });
    }
}

function decodeFile(arrayBuffer) {
    const progressText = document.getElementById('loader-text');
    const progressBar = document.getElementById('loader');
    const setProgress = (percent) => { $(progressBar).progress("set progress", percent); };
    const setText = (text) => { progressText.innerHTML = text; };

    showLoader(true);
    setText('Decoding audio...');

    console.info("Decoding audio...");
    // toggleLoader();
    audioCtx.resume().then(() => {
        audioCtx.decodeAudioData(arrayBuffer).then(async function handleDecodedAudio(audioBuffer) {
            console.info("Done decoding audio!");

            const prepocessedAudio = preprocess(audioBuffer);
            console.log("Preprocessing complete!");
            await audioCtx.suspend();

            // pause for a moment to allow loader to show
            await new Promise((res) => {
                setTimeout(() => {
                    res();
                }, 100);
            });

            if (essentia == null) { return; }

            essentiaAnalysis = await segment(essentia, prepocessedAudio, setProgress, setText)

            if (essentiaAnalysis == null) { return; }

            // show segmentation
            showSegmentation(essentiaAnalysis);

            setText('Extracting audio features...');

            createFeatureExtractionWorker();
            setProgress(50);


            // for each segment, extract features
            let endFrame;
            let startFrame = 0;
            let audioData;
            let audioSegment;
            for (let i = 0; i < essentiaAnalysis.peaks.length; i++) {
                endFrame = essentiaAnalysis.peaks[i];
                // get the audio between the start and end frames
                audioSegment = prepocessedAudio.resample_16khz.slice(startFrame, endFrame);
                audioData = shortenAudio(audioSegment, KEEP_PERCENTAGE, false);
                // send for feature extraction
                featureExtractionWorker.postMessage({
                    audio: audioData.buffer
                }, [audioData.buffer]);
                audioData = null;
                // wait for feature extraction to complete
                await new Promise((res) => {
                    featureExtractionWorker.onmessage = function listenToFeatureExtractionWorker(msg) {
                        // feed to models
                        if (msg.data.features) {
                            modelNames.forEach((n) => {
                                // send features off to each of the models
                                inferenceWorkers[n].postMessage({
                                    features: msg.data.features
                                });
                            });
                            msg.data.features = null;
                        }
                        // free worker resource until next audio is uploaded
                        featureExtractionWorker.terminate();
                        res();
                    };
                }
                );
            };

            // reduce amount of audio to analyse
            // let audioData = shortenAudio(prepocessedAudio.resample_16khz, KEEP_PERCENTAGE, true); // <-- TRIMMED start/end

            // send for feature extraction
            

            // featureExtractionWorker.postMessage({
            //     audio: audioData.buffer
            // }, [audioData.buffer]);
            // audioData = null;
        });
    }).catch((error) => {
        console.error("Error resuming audio context:", error);
    });
}

function createFeatureExtractionWorker() {
    featureExtractionWorker = new Worker('./src/featureExtraction.js');
    featureExtractionWorker.onmessage = function listenToFeatureExtractionWorker(msg) {
        // feed to models
        if (msg.data.features) {
            modelNames.forEach((n) => {
                // send features off to each of the models
                inferenceWorkers[n].postMessage({
                    features: msg.data.features
                });
            });
            msg.data.features = null;
        }
        // free worker resource until next audio is uploaded
        featureExtractionWorker.terminate();
    };
}

function createInferenceWorkers() {
    modelNames.forEach((n) => {
        inferenceWorkers[n] = new Worker('./src/inference.js');
        inferenceWorkers[n].postMessage({
            name: n
        });
        inferenceWorkers[n].onmessage = function listenToWorker(msg) {
            // listen out for model output
            if (msg.data.predictions) {
                const preds = msg.data.predictions;
                // emmit event to PredictionCollector object
                inferenceResultPromises.push(new Promise((res) => {
                    res({ [n]: preds });
                }));
                collectPredictions();
                console.log(`${n} predictions: `, preds);
            }
        };
    });
}

function collectPredictions() {
    if (inferenceResultPromises.length == modelNames.length) {
        Promise.all(inferenceResultPromises).then((predictions) => {
            const allPredictions = {};
            Object.assign(allPredictions, ...predictions);
            resultsViz.updateMeters(allPredictions);
            resultsViz.updateValueBoxes(essentiaAnalysis);
            showLoader(false);
            controls.toggleEnabled(true);

            inferenceResultPromises = []; // clear array
        });
    }
}

function showLoader(show) {
    const loader = document.querySelector('#loader');
    show ? loader.style.display = 'block' : loader.style.display = 'none';
}

function showSegmentation(essentiaAnalysis) {
    // add beat regions to the waveform
    let changeScore;
    for (let i = 0; i < essentiaAnalysis.beats.length; i++) {
        changeScore = essentiaAnalysis.changeScores[i];
        wsRegions.addRegion({
            start: essentiaAnalysis.beats[i],
            // start: beat * downsamplingFactor,
            color: `rgba(0, 0, 0, ${changeScore})`,
            // color: `rgba(0, 0, 0, 1)`,
            drag: false,
        });
    };
    // add selected peaks in cyan
    let beatPos;
    for (let i = 0; i < essentiaAnalysis.peaks.length; i++) {
        beatPos = essentiaAnalysis.peaks[i];
        wsRegions.addRegion({
            start: essentiaAnalysis.beats[beatPos],
            color: `rgba(0, 255, 255, 1)`,
            drag: false,
        });
    };


    // for each row of the featureMatrix, add a small graph of the feature
    const featureMatrix = essentiaAnalysis.featureMatrix;
    const featureMatrixContainer = document.getElementById('feature-matrix-container');
    const featureMatrixCanvas = document.createElement('canvas');
    featureMatrixCanvas.setAttribute('id', 'feature-matrix-canvas');
    // featureMatrixCanvas.setAttribute('style', `width: ${featureMatrix[0].length}px; height: 50px`);
    featureMatrixCanvas.setAttribute('width', featureMatrix[0].length);
    featureMatrixCanvas.setAttribute('height', featureMatrix.length * 10);
    featureMatrixContainer.appendChild(featureMatrixCanvas);
    // set the container to scroll horizontally
    featureMatrixContainer.setAttribute('style', `overflow-x: scroll;`);

    const featureMatrixCtx = featureMatrixCanvas.getContext('2d');
    let featureVal;
    for (let i = 0; i < featureMatrix.length; i++) {
        for (let j = 0; j < featureMatrix[i].length; j++) {
            featureVal = featureMatrix[i][j];
            featureMatrixCtx.fillStyle = `rgba(0, 0, 0, ${featureVal})`;
            featureMatrixCtx.fillRect(j, i * 10, 1, 10);
        }
    }
    // add a small label for each feature, from the object keys
    const featureLabels = Object.keys(essentiaAnalysis.featureMatrix);
    let featureLabel;
    for (let i = 0; i < featureLabels.length; i++) {
        featureLabel = featureLabels[i];
        featureMatrixCtx.fillStyle = `rgba(0, 0, 0, 1)`;
        featureMatrixCtx.font = "10px Arial";
        featureMatrixCtx.fillText(featureLabel, 0, i * 10 + 10);
    }
    featureMatrixContainer.setAttribute('style', `width: 90%; height: ${featureMatrix.length * 10}px`);
    featureMatrixCanvas.setAttribute('style', `width: 100%; height: ${featureMatrix.length * 10}px`);


    // Synchronize zoom and scroll position on WaveSurfer events
    wavesurfer.on('zoom', function (zoomLevel) {
        // scale the horizontal scroll position to match the zoom level
        featureMatrixCanvas.style.width = `${zoomLevel * 10}%`;
        // featureMatrixCanvas.style.transform = `scale(${zoomLevel})`;
    });

    wavesurfer.on('scroll', function (scrollProgress) {
        const canvasParentWidth = featureMatrixCanvas.parentElement.offsetWidth;
        const canvasWidth = featureMatrixCanvas.width;
        const scrollOffset = (canvasParentWidth - canvasWidth) * scrollProgress;
        featureMatrixCanvas.style.marginRight = `${scrollOffset}px`;
    });

    wavesurfer.on('audioprocess', function (currentTime) {
        const duration = wavesurfer.getDuration();
        const canvasParentWidth = featureMatrixCanvas.parentElement.offsetWidth;
        const canvasWidth = featureMatrixCanvas.width;
        const progress = currentTime / duration;
        const scrollOffset = (canvasParentWidth - canvasWidth) * progress;
        featureMatrixCanvas.style.marginRight = `${scrollOffset}px`;
    });
}


window.onload = () => {
    createInferenceWorkers();
    EssentiaWASM().then((wasmModule) => {
        essentia = new wasmModule.EssentiaJS(false);
        essentia.arrayToVector = wasmModule.arrayToVector;
        essentia.vectorToArray = wasmModule.vectorToArray;
    });
};
