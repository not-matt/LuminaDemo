class AnalysisResults {
    constructor(classifierNames) {
        this.analysisMeters = {};
        this.bpmBox = document.querySelector('#bpm-value');
        this.keyBox = document.querySelector('#key-value');
        if (classifierNames instanceof Array) {
            this.names = classifierNames;
            classifierNames.forEach((n) => {
                this.analysisMeters[n] = document.querySelector(`#${n} > .classifier-meter`);
            });
        } else {
            throw TypeError("List of classifier names provided is not of type Array");
        }
    }

    updateMeters(values) {
        this.names.forEach((n) => {
            this.analysisMeters[n].style.setProperty('--meter-width', values[n]*100);
        });
    }

    updateValueBoxes(essentiaAnalysis) {
        const stringBpm = essentiaAnalysis.bpm.toString();
        const formattedBpm = stringBpm.slice(0, stringBpm.indexOf('.') + 2); // keep 1 decimal places only
        this.bpmBox.textContent = formattedBpm;
        // this.keyBox.textContent = `${essentiaAnalysis.keyData.key} ${essentiaAnalysis.keyData.scale}`;
    }
}

function toggleUploadDisplayHTML(mode) {
    switch (mode) {
        case 'display':
            const fileDropArea = document.querySelector('#file-drop-area');
            const fileSelectArea = document.querySelector('#file-select-area');
            if (fileDropArea) {
                fileDropArea.remove();
            }

            const controls = document.querySelector('#playback-controls');
            controls.style.display = 'block';
            // fileSelectArea.appendChild(controlsTemplate.content.cloneNode(true));


        case 'upload':
            // remove #waveform
            // insert file-drop-area into file-select-area
    
        default:
            break;
    }
}

class PlaybackControls {
    constructor(wavesurferInstance) {
        this.controls = {
            backward: document.querySelector('#playback-controls #backward'),
            play: document.querySelector('#playback-controls #play'),
            forward: document.querySelector('#playback-controls #forward'),
            mute: document.querySelector('#playback-controls #mute'),
            zoom: document.querySelector('#playback-controls #zoom-slider')
        };

        // set click handlers
        this.controls.backward.onclick = () => { wavesurferInstance.skipBackward() };
        this.controls.play.onclick = () => { wavesurferInstance.playPause() };
        this.controls.forward.onclick = () => { wavesurferInstance.skipForward() };
        this.controls.mute.onclick = () => { wavesurferInstance.toggleMute() };

        // set zoom slider handler
        this.controls.zoom.addEventListener('input', function(e) {
          const minPxPerSec = e.target.valueAsNumber
          wavesurferInstance.zoom(minPxPerSec);
        });
    }

    toggleEnabled(isEnabled) {
        if (isEnabled) {
            for (let c in this.controls) {
                this.controls[c].removeAttribute('disabled');
            }
        } else {
            for (let c in this.controls) {
                this.controls[c].setAttribute('disabled', '');
            }
        }
    }
}

export { AnalysisResults, toggleUploadDisplayHTML, PlaybackControls };