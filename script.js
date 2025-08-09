// Main Logic
const video = document.getElementById('video');
const statusText = document.getElementById('status-text');
const listeningWave = document.getElementById('listening-wave');
const promptBox = document.getElementById('prompt-box');
const promptText = document.getElementById('prompt-text');
const detectionInfoBox = document.getElementById('detection-info-box');
const detectionList = document.getElementById('detection-list');
const mapBox = document.getElementById('map-box');
const mapFrame = document.getElementById('map-frame');
const loadingSpinner = document.getElementById('loading-spinner');

const detectionCanvas = document.getElementById('detection-canvas');
const canvasContext = detectionCanvas.getContext('2d');

const startSound = document.getElementById('start-sound');

let model = null;
let cameraStream = null;
let isListening = false;
let isWakeWordMode = true; // New state: waiting for wake word or a specific command
let currentMode = null; // 'detection', 'navigation', 'awaiting_detection_confirm'
let cameraDeviceId = null;
let facingMode = 'environment'; // 'user' for front camera, 'environment' for back
let detectionInterval = null;
let navInterval = null;

// Speech Recognition and Synthesis setup
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const SpeechSynthesis = window.speechSynthesis;
const recognition = SpeechRecognition ? new SpeechRecognition() : null;
const synth = window.speechSynthesis;

if (recognition) {
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
}

const speak = (text, callback) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.onend = () => {
        if (callback) callback();
    };
    synth.speak(utterance);
};

const stopAll = () => {
    console.log("Stopping all functions.");
    if (detectionInterval) clearInterval(detectionInterval);
    if (navInterval) clearTimeout(navInterval);
    if (recognition) recognition.stop();
    if (synth) synth.cancel();
    
    statusText.textContent = "Say 'Hey Vision' to start";
    listeningWave.classList.remove('active');
    promptBox.style.display = 'none';
    detectionInfoBox.style.display = 'none';
    mapBox.style.display = 'none';
    isWakeWordMode = true;
    currentMode = null;
    isListening = false;
};

// Camera handling
const getCamera = async () => {
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
    }

    try {
        const constraints = {
            video: {
                facingMode: facingMode,
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        };

        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = cameraStream;
        video.play();
        cameraDeviceId = cameraStream.getVideoTracks()[0].getSettings().deviceId;
    } catch (err) {
        console.error("Error accessing camera: ", err);
        statusText.textContent = "Error: Camera access denied.";
        speak("Error: Camera access denied. Please grant permission to continue.");
    }
};

const switchCamera = async () => {
    // Save the current mode before switching
    const previousMode = currentMode;
    const wasListening = isListening;

    speak("Switching camera.");
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    
    // Stop all intervals and listening temporarily
    if (detectionInterval) clearInterval(detectionInterval);
    if (navInterval) clearTimeout(navInterval);
    if (recognition) recognition.stop();

    await getCamera();
    
    // Restore previous state after camera switch
    if (previousMode === 'detection') {
        currentMode = 'detection';
        statusText.textContent = "Camera switched. Starting detection...";
        startDetection();
    }
    
    if (wasListening) {
        startListening();
    }
};

// Object Detection Logic
const getBrightness = (video) => {
    if (video.videoWidth === 0 || video.videoHeight === 0) return 0;
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imageData.data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
        sum += data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
    }
    return sum / (tempCanvas.width * tempCanvas.height);
};

const getDistanceAndLocation = (box, videoWidth) => {
    const boxWidth = box[2];
    
    // New distance calculation: map normalized width to a 0-3 meter range
    const normalizedWidth = boxWidth / videoWidth;
    let distance = 3 * (1 - normalizedWidth);
    distance = Math.max(0, distance).toFixed(2);

    let direction = 'ahead';
    const center = box[0] + box[2] / 2;
    if (center < videoWidth / 3) {
        direction = 'on your left';
    } else if (center > videoWidth * 2 / 3) {
        direction = 'on your right';
    }
    return { distance, direction };
};

const startDetection = async () => {
    console.log("Starting detection.");
    detectionInfoBox.style.display = 'block';
    mapBox.style.display = 'none'; // Hide map if detection starts
    detectionList.innerHTML = '';
    canvasContext.clearRect(0, 0, detectionCanvas.width, detectionCanvas.height);
    statusText.textContent = "Detection mode active.";

    const detect = async () => {
        if (!model || video.readyState !== 4) return;

        const brightness = getBrightness(video);
        if (brightness < 20) {
            statusText.textContent = "It's totally dark, can't detect anything.";
            detectionList.innerHTML = '';
            return;
        } else if (brightness < 50) {
            statusText.textContent = "Low light detected. Trying to detect...";
        }

        try {
            const predictions = await model.detect(video);
            canvasContext.clearRect(0, 0, detectionCanvas.width, detectionCanvas.height);
            detectionList.innerHTML = '';
            
            if (predictions.length === 0) {
                statusText.textContent = "No objects detected.";
                return;
            } else {
                statusText.textContent = "Detection mode active.";
            }

            let spokenPredictions = new Set();
            predictions.forEach(prediction => {
                const [x, y, width, height] = prediction.bbox;
                const { distance, direction } = getDistanceAndLocation(prediction.bbox, video.videoWidth);

                canvasContext.beginPath();
                canvasContext.rect(x, y, width, height);
                canvasContext.lineWidth = 2;
                canvasContext.strokeStyle = '#00c6ff';
                canvasContext.fillStyle = '#00c6ff';
                canvasContext.stroke();
                canvasContext.font = '16px Arial';
                canvasContext.fillText(`${prediction.class} (${Math.round(prediction.score * 100)}%)`, x, y > 10 ? y - 5 : 10);

                const listItem = document.createElement('li');
                listItem.textContent = `• A ${prediction.class} is approximately ${distance} meters ${direction}.`;
                detectionList.appendChild(listItem);
                
                if (!spokenPredictions.has(prediction.class) && synth.speaking === false) {
                    speak(`A ${prediction.class} is approximately ${distance} meters ${direction}.`);
                    spokenPredictions.add(prediction.class);
                    setTimeout(() => spokenPredictions.delete(prediction.class), 5000);
                }
            });
        } catch (err) {
            console.error("Detection error:", err);
        }
    };

    detectionInterval = setInterval(detect, 1000);
};

// Simulated Navigation Logic
const startNavigation = (destination) => {
    console.log(`Starting navigation to ${destination}.`);
    // Stop detection if it's running
    if (detectionInterval) {
        clearInterval(detectionInterval);
        detectionInfoBox.style.display = 'none';
    }

    mapBox.style.display = 'block';
    mapFrame.src = "https://www.openstreetmap.org/export/embed.html?bbox=72.50,23.00,72.65,23.15&layer=mapnik&marker=23.03,72.58";
    statusText.textContent = `Navigating to ${destination}.`;
    
    const directions = {
        'hospital': ["Proceed straight for 200 meters.", "Turn left at the next intersection.", "The hospital is on your right.", "You have reached your destination."],
        'medical store': ["Take 5 steps ahead.", "The medical store is on your left."],
        'home': ["Turn right at the end of the road.", "Take 10 steps ahead.", "Your home is in front of you."],
        'garden': ["Walk 5 steps ahead to the zebra crossing.", "Cross the road.", "The garden is on your right."],
    };
    
    let steps = directions[destination] || ["I'm sorry, I don't have directions for that destination."];
    let stepIndex = 0;

    const giveDirection = () => {
        if (stepIndex < steps.length) {
            const step = steps[stepIndex];
            speak(step, () => {
                stepIndex++;
                navInterval = setTimeout(giveDirection, 5000);
            });
        } else {
            speak("Navigation complete. I'm now waiting for your next command.");
            currentMode = null; // Go back to a neutral state
        }
    };
    giveDirection();
};

// Voice Command Handling
if (recognition) {
    recognition.onresult = (event) => {
        const transcript = event.results[event.results.length - 1][0].transcript.trim().toLowerCase();
        console.log("Heard:", transcript);
        
        if (transcript.includes('switch camera')) {
            switchCamera();
            return;
        }

        if (transcript.includes('stop')) {
            speak("Stopping all functions. I am now in standby mode.");
            stopAll();
            return;
        }

        // Simplified wake-up and detection flow
        if (transcript.includes('hey vision') || transcript.includes('hi vision') || transcript.includes('hello vision')) {
            startSound.play();
            speak("Yes? Do you want to start detection?", () => {
                promptBox.style.display = 'block';
                promptText.textContent = "Say 'yes' to start detection.";
            });
            currentMode = 'awaiting_detection_confirm';
            return;
        }

        if (currentMode === 'awaiting_detection_confirm' && transcript.includes('yes')) {
            currentMode = 'detection';
            promptBox.style.display = 'none';
            speak("Starting detection.", startDetection);
            return;
        }

        // Direct navigation commands
        if (transcript.includes('navigate')) {
            let destination = null;
            if (transcript.includes('hospital')) destination = 'hospital';
            else if (transcript.includes('store') || transcript.includes('medical store')) destination = 'medical store';
            else if (transcript.includes('home')) destination = 'home';
            else if (transcript.includes('garden')) destination = 'garden';

            if (destination) {
                currentMode = 'navigation';
                speak(`Navigating to the nearest ${destination}.`);
                startNavigation(destination);
                promptBox.style.display = 'none';
            } else {
                speak("Please specify a destination, like hospital, medical store, home, or garden.");
                promptBox.style.display = 'block';
                promptText.textContent = "Please specify a destination.";
            }
            return;
        }

        // If no specific command, and not in an active mode, just listen
        if (currentMode === null) {
            statusText.textContent = "Say 'Hey Vision' to start";
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        // Restart on common errors to maintain continuous listening
        if (event.error === 'network' || event.error === 'service-not-allowed' || event.error === 'no-speech') {
            if (isListening) {
                 recognition.start();
            }
        }
    };

    recognition.onend = () => {
        if (isListening) {
             recognition.start();
        }
    };
} else {
    statusText.textContent = "Speech recognition is not supported in this browser.";
    speak("I'm sorry, your browser does not support the Web Speech API.");
}

const startListening = () => {
  if (!isListening && recognition) {
    isListening = true;
    recognition.start();
    listeningWave.classList.add('active');
  }
};

video.addEventListener('loadeddata', () => {
    detectionCanvas.width = video.videoWidth;
    detectionCanvas.height = video.videoHeight;
});

// Main initialization function
const init = async () => {
    await getCamera();
    
    video.onloadedmetadata = async () => {
        loadingSpinner.style.display = 'flex';
        statusText.textContent = "Loading AI models...";
        
        try {
            model = await cocoSsd.load();
            loadingSpinner.style.display = 'none';
            statusText.textContent = "Models loaded. Say 'Hey Vision' to start.";
            startListening();
        } catch (err) {
            console.error("Failed to load COCO-SSD model:", err);
            loadingSpinner.style.display = 'none';
            statusText.textContent = "Error: Failed to load models.";
            speak("An error occurred while loading the AI models. Please try again later.");
        }
    };
};

init();
