const UNIVERSE_SIZE = 512;
const FPS = 30;

// matches each function to a score for Danceable, Aggressive, Relaxed.
// 0 = low, 1 = high, null = not applicable
const animationScores = [
    [pulse, 1, null, null],
    [strobe, 1, null, null],
    [flicker, 1, null, null],
];

function pickAnimation(segmentInference) {
    // pick an animation function based on the scores
    // todo: this should be based on the inference results
    const aggressive = segmentInference.find((result) => result.model === 'mood_aggressive').predictions;
    const danceable = segmentInference.find((result) => result.model === 'danceability').predictions;
    const relaxed = segmentInference.find((result) => result.model === 'mood_relaxed').predictions;
    // if dancable or aggressive are higher than .6, choose randomly between strobe or flicker
    if (danceable > .6 || aggressive > .6) {
        return [strobe, burst][Math.floor(Math.random() * 2)];
    }
    // if relaxed is higher than .75, choose randomly between pulse or strobe
    if (relaxed > .75) {
        return [pulse, flicker][Math.floor(Math.random() * 2)];
    }
    // otherwise pick randomly
    return [pulse, flicker, strobe, burst][Math.floor(Math.random() * 4)];
}

export function createLighting(analysis, inference) {
    // for each segment, pick a random animation function based on the scores
    // then call the function with the audio data
    let output = [];
    let segmentInference;
    let segmentBeats;
    let startBeat = 0;
    let endBeat = 0;
    const beats = Object.values(analysis.beats);
    for (let i = 0; i < inference.length; i++) {
        // get audio data within the segment to pass to the animation function
        endBeat = analysis.peaks[i]; // todo -  fix peaks to include the first and last beat 
        segmentBeats = beats.slice(startBeat, endBeat + 1);
        // subtract the start beat from the segment beats to make the first beat 0
        if (startBeat === 0) {
            segmentBeats.unshift(0);
        } else {
            segmentBeats = segmentBeats.map((beat) => beat - segmentBeats[0]);
        }
        segmentInference = inference[i].inferenceResults;
        const animation = pickAnimation(segmentInference);
        const segmentAnimation = animation(segmentBeats, segmentInference);
        output = output.concat(segmentAnimation);
        startBeat = endBeat;
    }
    // return the output array
    return output;
}

// make output array based on the length of the segment
function makeOutputArray(segmentBeats) {
    const duration = segmentBeats[segmentBeats.length - 1];
    const frame_count = Math.floor(duration * FPS);
    let output = Array(frame_count).fill().map(() => new Uint8Array(UNIVERSE_SIZE));
    return output;
}

function timeToFrame(time) {
    return Math.floor(time * FPS);
}

// Pulse
// CNN Matches: High Danceable, Low Aggressive, High Relaxed
// Description: fade the universe on and off in sync with the beat. the range of the fade is based on the danceability score, so a dancability of 1 will fade from 0 to 255 and a danceability of 0 will fade from 64 to 192
function pulse(segmentBeats, segmentInference) {
    const output = makeOutputArray(segmentBeats);
    const danceability = segmentInference.find((result) => result.model === 'danceability').predictions;
    let startFrame = 0;
    let endFrame = 0;
    let beat = 0;
    for (let i = 1; i < segmentBeats.length; i++) {
        beat = segmentBeats[i];
        endFrame = timeToFrame(beat);
        const fadeRange = 255 * danceability;
        const fadeStart = i % 2 === 0 ? 128 - fadeRange / 2 : 128 + fadeRange / 2;
        const fadeStep = i % 2 === 0 ? fadeRange / (endFrame - startFrame) : -fadeRange / (endFrame - startFrame);
        let fadeValue = fadeStart;
        for (let j = startFrame; j < endFrame; j++) {
            output[j].fill(fadeValue);
            fadeValue += fadeStep;
        }
        startFrame = endFrame;
    }
    return output;
}

// Strobe
// CNN Matches: High Danceable, High Aggressive, Low Relaxed
// Description: Spotlights flash in sync with the beat, using the beat timing information. 
function strobe(segmentBeats, segmentInference) {
    const output = makeOutputArray(segmentBeats);
    let startFrame = 0;
    let endFrame = 0;
    let beat = 0;
    for (let i = 1; i < segmentBeats.length; i++) {
        beat = segmentBeats[i];
        endFrame = timeToFrame(beat);
        const strobeStart = 255;
        const strobeStep = -255 / (endFrame - startFrame);
        let strobeValue = strobeStart;
        for (let j = startFrame; j < endFrame; j++) {
            output[j].fill(strobeValue);
            strobeValue += strobeStep;
        }
        startFrame = endFrame;
    }
    return output;
}

function flicker(segmentBeats, segmentInference) {
    const output = makeOutputArray(segmentBeats);
    const relaxation = segmentInference.find((result) => result.model === 'mood_relaxed').predictions;
    const flickerIntensity = 1 - relaxation;
    let lastOutput = new Uint8Array(UNIVERSE_SIZE);
    const beatFrames = segmentBeats.map((beat) => timeToFrame(beat));
    for (let i = 0; i < output.length; i++) {
        // multiply the last output by 0.9 to make it fade out
        lastOutput = lastOutput.map((value) => value * 0.97);
        // if it's a beat, make some twinkles on random lights
        if (beatFrames.includes(i)) {
            for (let j = 0; j < UNIVERSE_SIZE; j++) {
                if (Math.random() < flickerIntensity) {
                    output[i][j] = 255;
                }
                else {
                    output[i][j] = lastOutput[j];
                }
            }
        } else {
            output[i] = lastOutput;
        }
        lastOutput = output[i];
    }
    return output;
}


// Flow
// CNN Matches: High Danceable, Low Aggressive, Low Relaxed
// Description: The spotlights smoothly move across the array, creating a flowing effect. The speed of the movement is influenced by the danceability score, with high danceability resulting in faster and more energetic flow. The aggression and relaxation scores can affect the brightness intensity of the spotlights, creating variations in the visual output.
function flow(segmentBeats, segmentInference) {
    const output = makeOutputArray(segmentBeats);
    const danceability = segmentInference.find((result) => result.model === 'danceability').predictions;
    const aggression = segmentInference.find((result) => result.model === 'mood_aggressive').predictions;
    const relaxation = segmentInference.find((result) => result.model === 'mood_relaxed').predictions;

    const speed = 4 * (1 - danceability); // Adjust the speed based on danceability (higher danceability = faster flow)
    const brightness = 255 * (1 - aggression) * relaxation; // Adjust the brightness based on aggression and relaxation

    let currentPosition = 0;
    let currentFrame = 0;
    let beat = 0;

    for (let i = 1; i < segmentBeats.length; i++) {
        beat = segmentBeats[i];
        const targetPosition = Math.floor(beat * output.length);
        const direction = targetPosition > currentPosition ? 1 : -1;
        const distance = Math.abs(targetPosition - currentPosition);
        const stepSize = distance / (beat - segmentBeats[i - 1]) * speed;

        while (currentPosition !== targetPosition) {
            const intensity = Math.round(brightness * (1 - Math.abs((currentPosition - targetPosition) / distance)));

            output[currentFrame].fill(intensity);

            currentPosition += direction * stepSize;
            currentFrame = timeToFrame(currentPosition);
        }
    }
    return output;
}

function burst(segmentBeats, segmentInference) {
    const output = makeOutputArray(segmentBeats);
    const aggression = segmentInference.find((result) => result.model === 'mood_aggressive').predictions;
    const relaxation = segmentInference.find((result) => result.model === 'mood_relaxed').predictions;
    let lastOutput = new Array(UNIVERSE_SIZE / 2).fill(0);
    const beatFrames = segmentBeats.map((beat) => timeToFrame(beat));
    for (let i = 0; i < output.length; i++) {
        // multiply the last output by 0.9 to make it fade out
        lastOutput = lastOutput.map((value) => value * 0.98);
        // roll the last output to the right by 5 lights
        for (let j = 0; j < 5; j++) {
            lastOutput.unshift(lastOutput.pop());
            lastOutput[0] = lastOutput[1];
        }
        // if it's a beat, make some twinkles on random lights
        if (beatFrames.includes(i)) {
            lastOutput[0] = 255;
        }
        // mirror the last output onto left and right of the output universe 
        const centre = UNIVERSE_SIZE / 2;
        for (let j = 0; j < UNIVERSE_SIZE; j++) {
            output[i][centre - j - 1] = lastOutput[j];
            output[i][centre + j] = lastOutput[j];
        }
    }
    return output;
}

// Fade
// CNN Matches: Low Danceable, Low Aggressive, High Relaxed
// Description: The spotlights gradually fade in and out, creating a tranquil and calming ambiance. The fade duration and smoothness are influenced by the relaxation score, with high relaxation resulting in longer and smoother transitions. The danceability and aggression scores can determine the overall brightness or color temperature of the lights.

// Burst
// CNN Matches: Low Danceable, High Aggressive, High Relaxed
// Description: Spotlights burst or rapidly flash in a pattern, synchronized with the music. The burst frequency and intensity are influenced by the aggression score, with high aggression resulting in faster and more intense bursts. The relaxation score affects the spacing between bursts, with high relaxation providing more relaxed and spacious bursts.

// Twinkle
// CNN Matches: Low Danceable, Low Aggressive, Low Relaxed
// Description: The spotlights twinkle or flicker randomly, creating a subtle and delicate lighting effect. The twinkle rate and intensity can be influenced by the audio energy or spectral information, resulting in variations based on the audio characteristics. This effect adds a gentle sparkle to the environment.

// Sweep
// CNN Matches: Low Danceable, High Aggressive, Low Relaxed
// Description: Spotlights sweep across the array in a back-and-forth motion, synchronized with the beat. The speed and range of the sweep are influenced by the aggression score, with high aggression resulting in faster and wider sweeps. The relaxation score can affect the smoothness or sharpness of the motion, with high relaxation providing slower and smoother sweeps.

// Color Wave
// CNN Matches: Low Danceable, High Aggressive, High Relaxed
// Description: The spotlights change colors in a wave-like pattern, flowing across the array. The color transition speed and intensity are influenced by the aggression score, with high aggression resulting in faster and more vibrant color changes. The relaxation score can affect the smoothness or gentleness of the color transitions.

// Beat Sync
// CNN Matches: High Danceable, Low Aggressive, High Relaxed
// Description: Spotlights change brightness or intensity based on the beat positions, synchronized with the music. The danceability score influences the responsiveness and timing of the changes, with high danceability resulting in more pronounced variations. The aggression and relaxation scores can impact the color or overall visual style of the lighting changes.