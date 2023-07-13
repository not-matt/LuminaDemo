export async function segment(essentia, audioSignal, setProgress, setText) {
    let arraySignal = audioSignal.resample_41khz;
    let vectorSignal = essentia.arrayToVector(arraySignal);
    setText('Extracting rhythm...');
    await new Promise(resolve => setTimeout(resolve, 10));
    const beats = essentia.RhythmExtractor2013(vectorSignal, 208, 'degara', 40);
    setText('Identifying segments...');
    // const keyData = essentia.KeyExtractor(vectorSignal, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate', 44100, 0.0001, 440, 'cosine', 'hann');
    const beatGrid = essentia.vectorToArray(beats.ticks);

    // feature extraction
    const features = {};
    features.energy = [];
    features.loudness = [];
    features.zcr = [];
    // features.centroid = [];
    // features.rolloff = [];
    // features.pitch = [];
    // features.pitchConfidence = [];
    features.pitchSalience = [];
    const frameSize = 1024;
    const frames = essentia.FrameGenerator(arraySignal, frameSize, frameSize * 0.5);
    let percentComplete = 0;
    let percent = 0;
    for (let i = 0; i < frames.size(); i++) {
        const audioVector = frames.get(i);
        const windowedFrame = essentia.Windowing(audioVector, true, frameSize, "hann", 0, true).frame;

        // segmentation features
        const energy = essentia.Energy(windowedFrame).energy;
        const loudness = essentia.Loudness(windowedFrame).loudness;
        const zcr = essentia.ZeroCrossingRate(windowedFrame, 0).zeroCrossingRate;
        // const centroid = essentia.Centroid(windowedFrame, 1).centroid;
        // const rolloff = essentia.RollOff(windowedFrame, 0.85, 44100).rollOff;
        // const pitch = essentia.PitchYin(windowedFrame, frameSize, true, 22050, 20, 44100, 0.15);
        const pitchSalience = essentia.PitchSalience(windowedFrame, 5000, 100, 44100).pitchSalience;

        // NOTE: try LowLevelSpectralExtractor
        // use this to extract a ton of audio features for each BEAT from rhythm extractor
        // const extracted = essentia.LowLevelSpectralExtractor(windowedFrame, 2048, 1024, 44100)

        features.energy.push(energy);
        features.loudness.push(loudness);
        features.zcr.push(zcr);
        // features.centroid.push(centroid);
        // features.rolloff.push(rolloff);
        // features.pitch.push(pitch.pitch);
        // features.pitchConfidence.push(pitch.pitchConfidence);
        features.pitchSalience.push(pitchSalience);

        percent = Math.floor(i / frames.size() * 100);
        if (percent > percentComplete) {
            percentComplete = percent;
            setProgress(percentComplete / 2);
            // sleep the thread for 1ms to allow the UI thread to update
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    setProgress(50);

    // Convert the features object to a 2D array
    const featureMatrix = Object.values(features);
    // normalize the feature matrix 0-1
    const numFeatures = featureMatrix.length;
    const numFrames = featureMatrix[0].length;
    for (let i = 0; i < numFeatures; i++) {
        // Step 1: Find the minimum and maximum values of the row
        const minVal = Math.min(...featureMatrix[i]);
        const maxVal = Math.max(...featureMatrix[i]);
        // Step 2: Subtract the minimum value from each element of the row
        for (let j = 0; j < numFrames; j++) {
            featureMatrix[i][j] -= minVal;
        }
        // Step 3: Divide each element of the row by the range
        const range = maxVal - minVal;
        if (range !== 0) {
            for (let j = 0; j < numFrames; j++) {
                featureMatrix[i][j] /= range;
            }
        }
    }

    const { changeScores, peaks } = segmentFeatureMatrix(featureMatrix, beatGrid, frameSize, frameSize * 0.5);

    return {
        featureMatrix: featureMatrix,
        keyData: null,
        bpm: beats.bpm,
        // sbic: sbic,
        beats: beatGrid,
        changeScores: changeScores,
        peaks: peaks,
    };
}

function segmentFeatureMatrix(featureMatrix, beatGrid, frameSize = 1024, hopSize = 512, sampleRate = 44100) {
    const numFeatures = featureMatrix.length;
    const numFrames = featureMatrix[0].length;

    // normalise each row of the feature matrix
    for (let i = 0; i < numFeatures; i++) {
        const feature = featureMatrix[i];
        const min = Math.min(...feature);
        const max = Math.max(...feature);
        const range = max - min;
        for (let j = 0; j < numFrames; j++) {
            feature[j] = (feature[j] - min) / range;
        }
    }


    // Initialize comparison array
    const changeScores = [];

    const timePerFrame = sampleRate / hopSize;

    // Calculate the frame index for each beat
    const beatFrames = beatGrid.map(beatTime => Math.floor(beatTime * timePerFrame));

    // Perform rolling window comparison using the beat grid
    const windowSize = 4; // Number of beats for the rolling window

    // Pre-calculate means and variances for each beat
    const beatMeans = [];
    const beatVariances = [];

    for (let i = 0; i < beatFrames.length - 1; i++) {
        const startFrame = beatFrames[i];
        const endFrame = beatFrames[i + 1];

        let beatMean = [];
        let beatVariance = [];

        // Calculate the mean and variance for each feature within the window
        for (let feature = 0; feature < numFeatures; feature++) {
            const featureData = featureMatrix[feature].slice(startFrame, endFrame);
            const mean = calculateMean(featureData);
            const variance = calculateVariance(featureData, mean);
            beatMean.push(mean);
            beatVariance.push(variance);
        }

        beatMeans.push(beatMean);
        beatVariances.push(beatVariance);
    }

    // Perform rolling window comparison
    for (let i = 0; i < beatFrames.length - windowSize; i++) {
        const windowStartLeft = i;
        const windowStartRight = i + windowSize / 2;

        // Initialize arrays to accumulate means and variances
        let leftMeans = Array(numFeatures).fill(0);
        let rightMeans = Array(numFeatures).fill(0);
        let leftVariances = Array(numFeatures).fill(0);
        let rightVariances = Array(numFeatures).fill(0);

        // Accumulate means and variances on each side of the window
        for (let j = 0; j < windowSize / 2; j++) {
            for (let feature = 0; feature < numFeatures; feature++) {
                leftMeans[feature] += beatMeans[windowStartLeft + j][feature];
                rightMeans[feature] += beatMeans[windowStartRight + j][feature];
                leftVariances[feature] += beatVariances[windowStartLeft + j][feature];
                rightVariances[feature] += beatVariances[windowStartRight + j][feature];
            }
        }

        // Combine the means and variances into vectors
        const leftVector = [...leftMeans, ...leftVariances];
        const rightVector = [...rightMeans, ...rightVariances];

        // Calculate the Euclidean distance between left and right vectors
        const changeScore = calculateEuclideanDistance(leftVector, rightVector);

        // if nan or inf, set to 0
        if (isNaN(changeScore) || !isFinite(changeScore)) {
            changeScores.push(0);
        } else {
            changeScores.push(changeScore);
        }
    }

    // Normalize the change scores to 0-1
    const minVal = Math.min(...changeScores);
    const maxVal = Math.max(...changeScores);
    const range = maxVal - minVal;
    if (range !== 0) {
        for (let i = 0; i < changeScores.length; i++) {
            changeScores[i] -= minVal;
            changeScores[i] /= range;
        }
    }

    // pad the beginning and end of the array with half the window size to account for the rolling window
    const padding = Math.floor(windowSize / 2);
    for (let i = 0; i < padding; i++) {
        changeScores.unshift(0);
        changeScores.push(0);
    }

    // Perform peak picking on the change scores
    const peaks = performPeakPicking(changeScores);

    return { changeScores, peaks };
}

function calculateMean(data) {
    const sum = data.reduce((acc, val) => acc + val, 0);
    return sum / data.length;
}

function calculateVariance(data, mean) {
    const squaredDifferences = data.map(val => (val - mean) ** 2);
    const sumOfSquaredDiff = squaredDifferences.reduce((acc, val) => acc + val, 0);
    return sumOfSquaredDiff / data.length;
}

function calculateEuclideanDistance(vec1, vec2) {
    const squaredDifferences = vec1.map((val, i) => (val - vec2[i]) ** 2);
    const sumOfSquaredDiff = squaredDifferences.reduce((acc, val) => acc + val, 0);
    return Math.sqrt(sumOfSquaredDiff);
}

function performPeakPicking(scores, windowSize = 16, zScoreThreshold = 1.5) {
    const peaks = [];
    for (let i = 0; i < scores.length - windowSize + 1; i++) {
        const window = scores.slice(i, i + windowSize);
        const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
        const standardDeviation = Math.sqrt(window.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / window.length);
        const middleIndex = Math.floor(windowSize / 2);
        const zScore = (window[middleIndex] - mean) / standardDeviation;
        if (zScore > zScoreThreshold) {
            peaks.push(i + middleIndex);
        }
    }
    // if any peaks are within 4 indices of each other, remove the lower one
    const trimmedPeaks = [];
    for (let i = 0; i < peaks.length - 1; i++) {
        const peak = peaks[i];
        const nextPeak = peaks[i + 1];
        if (nextPeak - peak > 4 || scores[peak] > scores[nextPeak]) {
            trimmedPeaks.push(peak);
        } 
    }
    return trimmedPeaks;
}