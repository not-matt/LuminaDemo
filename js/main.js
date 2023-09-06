import { AnalysisResults, toggleUploadDisplayHTML, PlaybackControls } from './viz.js';
import { preprocess, shortenAudio } from './audioUtils.js';

// import WaveSurfer from 'https://unpkg.com/wavesurfer.js@beta';
import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js'
import RegionsPlugin from 'https://unpkg.com/wavesurfer.js@beta/dist/plugins/regions.js';
import { segment } from './segmentation.js';
import { createLighting } from './lighting.js';

const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();
const KEEP_PERCENTAGE = 0.15; // keep only 15% of audio file


// REMOVE FOR PRODUCTION
// import { essentiaAnalysis } from './results/essentiaAnalysis.js';
// import { inferenceResults } from './results/inferenceResults.js';
let essentiaAnalysis;
let inferenceResults = [];

let essentia = null;
let featureExtractionWorker = null;
let lightingOutput = [];
const modelNames = ['mood_happy', 'mood_sad', 'mood_relaxed', 'mood_aggressive', 'danceability'];
let inferenceWorkers = {};

let socket = null;

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

const connectButton = document.getElementById('ws-connect');
connectButton.addEventListener('click', () => {
    if (socket) {
        socket.close();
        socket = null;
        connectButton.innerHTML = 'Connect';
    } else {
        const destinationInput = document.getElementById("ws-destination");
        const destination = destinationInput.value.trim();
    
        if (!destination) {
            alert("Please enter a valid destination for the WebSocket connection (eg. localhost:8080)");
            return;
        }
        
        socket = new WebSocket(`ws://${destination}`);
        socket.onopen = function() {
            setStatus("Connected");
            connectButton.innerHTML = 'Disconnect';
        };
    
        socket.onclose = function() {
            setStatus("Disconnected");
            connectButton.innerHTML = 'Connect';
        };

        socket.onerror = function(error) {
            console.error("WebSocket error:", error);
            setStatus("Error");
            connectButton.innerHTML = 'Connect';
        };

        socket.onmessage = function(event) {
            console.log("WebSocket message:", event.data);
        };

    }
});

function setStatus(status) {
    const statusElement = document.getElementById("ws-status");
    statusElement.textContent = `Status: ${status}`;
}


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

            essentiaAnalysis = await segment(essentia, prepocessedAudio, setProgress, setText);

            if (essentiaAnalysis == null) { return; }

            // show segmentation
            showSegmentation(essentiaAnalysis);
            // showAdvancedSegmentation(essentiaAnalysis);

            setText('Extracting audio features...');

            createFeatureExtractionWorker();
            setProgress(50);

            inferenceResults = await processSegments(setProgress, setText, prepocessedAudio);
            setProgress(100);
            setText('Analysis complete!');
            controls.toggleEnabled(true);
            console.log('All segments processed');
            console.log(inferenceResults);
            // showInferenceResults(inferenceResults);

            // clean up
            for (let i = 0; i < modelNames.length; i++) {
                inferenceWorkers[modelNames[i]].postMessage({ "dispose": true });
                inferenceWorkers[modelNames[i]].terminate();
            }
            featureExtractionWorker.terminate();

            // downloadResults(essentiaAnalysis);
            // downloadResults(inferenceResults);

            lightingOutput = createLighting(essentiaAnalysis, inferenceResults);
            createVisualiser();

            let previousFrameNumber = -1;
            wavesurfer.on('audioprocess', (time) => {
                // Calculate the current frame number based on the playback time
                const frameNumber = Math.floor(time * 30); // Assuming 30fps
                if (frameNumber !== previousFrameNumber) {
                    // Trigger your animation frame only if it's a new frame
                    sendFrame(frameNumber);
                    previousFrameNumber = frameNumber;
                }
            });

        });
    }).catch((error) => {
        console.error("Error resuming audio context:", error);
    });
}

function createVisualiser() {
    // get the output-visualiser div, give it a black background, and add 512 divs to it
    // the divs should take up the full width of the visualiser, and be 15px tall
    // they should be touching each other, and have a white background
    const visualiser = document.getElementById('output-visualiser');
    visualiser.style.backgroundColor = 'black';
    visualiser.style.display = 'flex';
    visualiser.style.flexDirection = 'row';
    visualiser.style.flexWrap = 'nowrap';
    visualiser.style.justifyContent = 'flex-start';
    visualiser.style.alignItems = 'flex-end';
    visualiser.style.height = '50px';
    visualiser.style.width = '90%';
    visualiser.style.padding = '20px';
    for (let i = 0; i < 512; i++) {
        const bar = document.createElement('div');
        bar.style.backgroundColor = 'white';
        bar.style.height = '10px';
        // set flex basis to 0 so that the flex-grow property can be used to set the width
        bar.style.flexBasis = '0';
        bar.style.flexGrow = '1';
        bar.style.flexShrink = '0';
        visualiser.appendChild(bar);
    }
}

function updateVisualiser(frame) {
    const visualiser = document.getElementById('output-visualiser');
    const bars = visualiser.children;
    for (let i = 0; i < bars.length; i++) {
        bars[i].style.height = `${frame[i]/255*10}px`;
        bars[i].style.backgroundColor = `rgb(${frame[i]}, ${frame[i]}, ${frame[i]})`;
    }
}

function updateWs(frame) {
    if (socket === null ||  
        socket.readyState !== 1) {
        return;
    }
    // turn the frame into a string of comma-separated values
    const frameString = frame.join(',');
    // send the frame to the websocket server
    socket.send(frameString);
}

function sendFrame(frameNumber) {
    if (frameNumber >= lightingOutput.length) {
        return;
    }
    const frame = lightingOutput[frameNumber];
    updateVisualiser(frame);
    updateWs(frame);
}


function downloadResults(data) {
    let jsonResults = JSON.stringify(data);
    let blob = new Blob([jsonResults], { type: 'application/json' });
    let url = URL.createObjectURL(blob);

    let link = document.createElement('a');
    link.href = url;
    link.download = 'results.json';
    link.click();
}

async function processSegments(setProgress, setText, prepocessedAudio) {
    let startSample = 0;
    let endSample = 0;
    let endBeat = 0;
    let audioData;
    let audioSegment;
    let results = [];

    for (let i = 0; i < essentiaAnalysis.peaks.length - 1; i++) {
        endBeat = essentiaAnalysis.peaks[i];
        endSample = Math.floor(essentiaAnalysis.beats[endBeat] * 16000);

        audioSegment = prepocessedAudio.resample_16khz.slice(startSample, endSample);
        audioData = shortenAudio(audioSegment, KEEP_PERCENTAGE, false);

        // Send the data to the feature extraction worker
        featureExtractionWorker.postMessage({
            idx: i,
            audio: audioData.buffer,
        }, [audioData.buffer]);

        const features = await new Promise((resolve) => {
            featureExtractionWorker.onmessage = function handleExtraction(msg) {
                if (msg.data.features && msg.data.idx === i) {
                    const features = msg.data.features;
                    console.log(`Features for segment ${i}:`, features);
                    resolve(features);
                }
            };
        });

        const inferenceResults = await Promise.all(
            modelNames.map((n) => {
                return new Promise((resolve) => {
                    inferenceWorkers[n].onmessage = function handleInference(msg) {
                        console.log('Inference message:', msg);
                        if (msg.data.predictions) {
                            const predictions = msg.data.predictions;
                            console.log(`${n} predictions:`, predictions);
                            resolve({ model: n, predictions });
                        }
                    };
                    inferenceWorkers[n].postMessage({
                        idx: i,
                        features: features
                    });
                });
            })
        );

        // Update the UI with the inference results before the next iteration
        // updateUI(inferenceResults);
        console.log(`Inference results for segment ${i}:`, inferenceResults);
        results.push({ i, features, inferenceResults });
        setProgress(50 + ((i + 1) / essentiaAnalysis.peaks.length) * 50);

        audioData = null;
        startSample = endSample;
    }

    return results;
}

function createFeatureExtractionWorker() {
    featureExtractionWorker = new Worker('./js/featureExtraction.js');
}

function createInferenceWorkers() {
    modelNames.forEach((n) => {
        inferenceWorkers[n] = new Worker('./js/inference.js');
        inferenceWorkers[n].postMessage({
            name: n
        });
    });
}

function showLoader(show) {
    const loader = document.querySelector('#loader');
    loader.style.display = show ? 'block' : 'none';
}

function showSegmentation(essentiaAnalysis) {
    // draw the segmentation regions
    let endBeat;
    let startBeat = 0;
    for (let i = 0; i < essentiaAnalysis.peaks.length; i++) {
        endBeat = essentiaAnalysis.beats[essentiaAnalysis.peaks[i]];
        // alternate shades of grey
        wsRegions.addRegion({
            start: startBeat,
            end: endBeat,
            color: `rgba(0, 0, 0, 0)`,
            drag: false,
            resize: false,
        });
        startBeat = endBeat;
    };
    // add the last region
    wsRegions.addRegion({
        start: startBeat,
        end: essentiaAnalysis.beats[essentiaAnalysis.beats.length - 1],
        color: `rgba(0, 0, 0, 0)`,
        drag: false,
        resize: false,
    });
    // add hover events to the segments
    for (let i = 0; i < wsRegions.regions.length; i++) {
        const region = wsRegions.regions[i];
        region.element.addEventListener('mouseenter', () => {
            region.element.style.backgroundColor = 'rgba(0, 0, 0, 0.1)';
            showInferenceResults(i);
        });
        region.element.addEventListener('mouseleave', () => {
            region.element.style.backgroundColor = 'rgba(0, 0, 0, 0)';
        });
    }
}

// function showInferenceResults(results) {
//     // add hover events to the regions to the segments
//     for (let i = 0; i < results.length; i++) {
//         const inferenceResults = results[i].inferenceResults;
//         const region = wsRegions.regions[i]; 

//         card.style.display = 'block';
//         region.element.addEventListener('mouseenter', () => {
//             card.innerHTML = '';
//             inferenceResults.forEach((r) => {
//                 const model = r.model;
//                 const predictions = r.predictions;
//                 const modelDiv = document.createElement('div');
//                 modelDiv.innerHTML = `<h4>${model}</h4><p>${Math.floor(predictions * 100)}%</p>`;
//                 card.appendChild(modelDiv);
//             });
//         });
// region.element.addEventListener('mouseleave', () => {
//     card.style.display = 'none';
// });
//     }
// }

function showInferenceResults(segmentIdx) {
    if (!inferenceResults) return;
    if (segmentIdx >= inferenceResults.length) return;
    const card = document.querySelector('#card');
    // update the progress bars representing the model predictions
    const cardHeader = document.querySelector('#card-header');

    //     <span class="right floated">
    //     start:end [duration s]   
    // </span>
    // Segment i
    const region = wsRegions.regions[segmentIdx];
    const start = region.start.toFixed(2);
    const end = region.end.toFixed(2);
    const duration = (region.end - region.start).toFixed(2);
    cardHeader.innerHTML = `Segment ${segmentIdx}<div class="meta">${start} - ${end} [${duration} s total]</div>`;

    const inferenceResultsForSegment = inferenceResults[segmentIdx].inferenceResults;
    const modelNames = inferenceResultsForSegment.map((r) => r.model);
    const predictions = inferenceResultsForSegment.map((r) => r.predictions);
    for (let i = 0; i < modelNames.length; i++) {
        const modelName = modelNames[i];
        const prediction = predictions[i];
        const progress = document.getElementById(`progress_${modelName}`);
        $(progress).progress("set progress", prediction * 100);
    }
}

function showAdvancedSegmentation(essentiaAnalysis) {
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
