// Configuration
const CORS_PROXY = "https://api.allorigins.win/get?url=";
const METRIX_API = "https://discgolfmetrix.com/api.php?content=result&id=";
const METRIX_COURSE_API = "https://discgolfmetrix.com/api.php?content=course&code=XXX&id=";
const BAGTAG_API = "https://discgolfmetrix.com/api.php?content=bagtag_list&id=2";

// State
let appState = {
    gameId: null,
    courseData: null, // Holds RatingValue1, RatingResult1, etc.
    players: [], // { id, name, score, metrixRating, gameRating, tickets, selected, color }
    wheelSegments: [],
    winners: [],
    isSpinning: false
};

// DOM Elements
const els = {
    gameId: document.getElementById('gameId'),
    fetchGameBtn: document.getElementById('fetchGameBtn'),
    courseGroup: document.getElementById('courseInputGroup'),
    courseId: document.getElementById('courseId'),
    fetchCourseBtn: document.getElementById('fetchCourseBtn'),
    status: document.getElementById('status-message'),
    mainApp: document.getElementById('main-app'),
    playerList: document.getElementById('player-list'),
    genWheelBtn: document.getElementById('generateWheelBtn'),
    wheelCanvas: document.getElementById('wheelCanvas'),
    spinBtn: document.getElementById('spinBtn'),
    winnerBanner: document.getElementById('current-winner'),
    winnerList: document.getElementById('winner-list')
};

const ctx = els.wheelCanvas.getContext('2d');

// --- 1. Fetching Logic ---

els.fetchGameBtn.addEventListener('click', async () => {
    const id = els.gameId.value.trim();
    if (!id) return alert("Please enter a Game ID");
    
    appState.gameId = id;
    setStatus("Fetching game data...");
    
    try {
        const url = `${CORS_PROXY}${encodeURIComponent(METRIX_API + id)}`;
        const response = await fetch(url);
        const data = await response.json();
        const json = JSON.parse(data.contents); // allorigins returns JSON string in 'contents'

        if (!json || !json.Competition) throw new Error("Invalid Game Data");

        const competition = json.Competition;
        
        // Extract players (Standard Metrix API structure for Result)
        // Results are usually in competition.Results array
        if (!competition.Results) throw new Error("No results found in this game.");

        appState.players = competition.Results.map(r => ({
            id: r.UserID,
            name: r.Name,
            score: r.Sum, // Total score
            selected: true
        })).filter(p => p.score !== null && p.score !== ""); // Filter DNFs

        // Attempt to find Course Rating Params in the response
        // Sometimes they are in the competition object or tracks
        if (competition.CourseID) {
            els.courseId.value = competition.CourseID
           await fetchCourseData()
        } else {
            // If params missing, ask for Course ID
            setStatus("Course ID missing. Please provide Course ID.");
            els.courseGroup.classList.remove('hidden');
        }

    } catch (e) {
        console.error(e);
        setStatus("Error: " + e.message);
    }
});

els.fetchCourseBtn.addEventListener('click', fetchCourseData);

async function fetchCourseData() {
    const cid = els.courseId.value.trim();
    if (!cid) return;

    setStatus("Fetching course data...");
    try {
        const url = `${CORS_PROXY}${encodeURIComponent(METRIX_COURSE_API + cid)}`;
        const response = await fetch(url);
        const data = await response.json();
        const json = JSON.parse(data.contents);

        // Depending on API response structure for 'course'
        // Assuming json directly contains the params or is an object with them
        // This part is heuristic as Metrix API documentation is sparse
        let source = json.course || json; // Try to find the root
        
        if (checkCourseParams(source)) {
            appState.courseData = extractCourseParams(source);
            els.courseGroup.classList.add('hidden');
            await processPlayers();
        } else {
            throw new Error("Could not find rating calculation parameters (RatingValue1, etc) in course data.");
        }
    } catch (e) {
        setStatus("Error fetching course: " + e.message);
    }
}

function checkCourseParams(obj) {
    // Check for RatingValue1, RatingResult1...
    // Sometimes nested in 'Tracks' array
    if (obj.RatingValue1 && obj.RatingResult1) return true;
    if (obj.Tracks && obj.Tracks[0] && obj.Tracks[0].RatingValue1) return true;
    return false;
}

function extractCourseParams(obj) {
    if (obj.RatingValue1) return obj;
    if (obj.Tracks && obj.Tracks[0]) return obj.Tracks[0];
    return null;
}

// --- 2. Scraping & Calculation ---

async function processPlayers() {
    setStatus(`Found ${appState.players.length} players. Scraping Metrix ratings...`);
    
    const url = `${CORS_PROXY}${encodeURIComponent(BAGTAG_API)}`;
    const response = await fetch(url);
    const data = await response.json();
    const json = JSON.parse(data.contents);
    const playerList = json.players

    // Fetch ratings for all players
    // We do this in batches or parallel
    const promises = appState.players.map(async (p) => {
        p.metrixRating = playerList.find(item => item.Name === p.name)?.Rating ?? 0;
    });

    await Promise.all(promises);
    
    calculateProbabilities();
    renderPlayerList();
    
    setStatus("Ready to generate wheel!");
    els.mainApp.classList.remove('hidden');
    els.genWheelBtn.disabled = false;
}

function calculateProbabilities() {
    const C = appState.courseData;
    // Parse strings to floats just in case
    const RV1 = parseFloat(C.RatingValue1);
    const RR1 = parseFloat(C.RatingResult1);
    const RV2 = parseFloat(C.RatingValue2);
    const RR2 = parseFloat(C.RatingResult2);

    appState.players.forEach(p => {
        // 1. Calculate Game Rating
        // Formula: Rating = (RV2 - RV1)*(Result - RR1)/(RR2 - RR1) + RV1
        if (!RV1 || !RV2 || !RR1 || !RR2) {
            p.gameRating = p.metrixRating; // Fallback if course data invalid
        } else {
            // Result is p.score
            const rawRating = (RV2 - RV1) * (parseFloat(p.score) - RR1) / (RR2 - RR1) + RV1;
            p.gameRating = Math.round(rawRating);
        }

        // 2. Calculate Tickets
        // Baseline 50.
        // Diff = GameRating - MetrixRating
        // Threshold +/- 100
        
        // Handle missing player rating (if new player, usually 0 or null)
        const playerRating = p.metrixRating || p.gameRating; // Default to game rating if unknown
        
        const diff = p.gameRating - playerRating;
        let tickets = 50;

        if (diff >= 100) {
            tickets = 100;
        } else if (diff <= -100) {
            tickets = 25;
        } else {
            // Linear interpolation
            if (diff > 0) {
                // 0 to 100 maps to 50 to 100
                // Slope = 0.5
                tickets = 50 + (diff * 0.5);
            } else {
                // -100 to 0 maps to 25 to 50
                // Slope = 0.25
                // e.g., diff -50. 50 + (-50 * 0.25) = 50 - 12.5 = 37.5
                tickets = 50 + (diff * 0.25);
            }
        }
        
        p.tickets = Math.round(tickets);
        p.color = getRandomColor(); // Assign a color for the wheel
    });
}

// --- 3. UI Rendering ---

function renderPlayerList() {
    els.playerList.innerHTML = '';
    
    appState.players.forEach((p, index) => {
        const div = document.createElement('div');
        div.className = 'player-item';
        
        // New HTML Structure: 4 distinct columns
        div.innerHTML = `
            <!-- Col 1: Checkbox -->
            <div class="p-select-col">
                <input type="checkbox" class="p-check" data-idx="${index}" ${p.selected ? 'checked' : ''}>
            </div>

            <!-- Col 2: Name & Details -->
            <div class="player-info">
                <strong>${p.name}</strong> 
                <div class="sub-info">
                    Score: ${p.score} | Rated: ${p.gameRating}
                </div>
            </div>

            <!-- Col 3: Editable Rating Input -->
            <div class="p-rating-col">
                <input type="number" class="p-rating-edit" data-idx="${index}" value="${p.metrixRating}">
            </div>

            <!-- Col 4: Tickets -->
            <span class="ticket-tag" id="tix-${index}">${p.tickets} tix</span>
        `;
        
        els.playerList.appendChild(div);
    });

    // --- EVENT LISTENERS ---

    // 1. Checkbox Listener
    document.querySelectorAll('.p-check').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const idx = e.target.getAttribute('data-idx');
            appState.players[idx].selected = e.target.checked;
        });
    });

    // 2. Rating Input Listener
    document.querySelectorAll('.p-rating-edit').forEach(input => {
        input.addEventListener('change', (e) => {
            const idx = e.target.getAttribute('data-idx');
            const newRating = parseFloat(e.target.value) || 0; 
            
            appState.players[idx].metrixRating = newRating;
            calculateProbabilities();

            // Update ticket UI
            appState.players.forEach((p, i) => {
                const tixEl = document.getElementById(`tix-${i}`);
                if (tixEl) tixEl.textContent = `${p.tickets} tix`;
            });
        });
    });
}

els.genWheelBtn.addEventListener('click', () => {
    // Filter players who are selected 
    const activePlayers = appState.players.filter(p => p.selected);
    
    if (activePlayers.length === 0) {
        alert("No players selected!");
        return;
    }

    setupWheel(activePlayers);
    drawWheel();
    appState.winners = []
    els.winnerList.innerHTML = ""
    els.spinBtn.disabled = false;
});

function setStatus(msg) {
    els.status.textContent = msg;
}

function getRandomColor() {
    // Generate nice pastel/vibrant colors
    const h = Math.floor(Math.random() * 360);
    return `hsl(${h}, 70%, 60%)`;
}

// --- 4. Wheel Logic & Animation ---

let wheelCtx = {
    segments: [], // { player, startAngle, endAngle }
    rotation: 0, // Current rotation in radians
    spinSpeed: 0,
    isSpinning: false,
    requestParams: null
};

function setupWheel(players) {
    const totalTickets = players.reduce((sum, p) => sum + p.tickets, 0);
    let currentAngle = 0;
    
    wheelCtx.segments = players.map(p => {
        const sliceAngle = (p.tickets / totalTickets) * 2 * Math.PI;
        const segment = {
            player: p,
            startAngle: currentAngle,
            endAngle: currentAngle + sliceAngle,
            color: p.color
        };
        currentAngle += sliceAngle;
        return segment;
    });
    
    wheelCtx.rotation = 0;
    els.winnerBanner.textContent = "";
}

function drawWheel() {
    const canvas = els.wheelCanvas;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = w / 2 - 10;

    ctx.clearRect(0, 0, w, h);
    
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(wheelCtx.rotation);

    wheelCtx.segments.forEach(seg => {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius, seg.startAngle, seg.endAngle);
        ctx.closePath();
        ctx.fillStyle = seg.color;
        ctx.fill();
        ctx.stroke();

        // Text
        ctx.save();
        ctx.rotate(seg.startAngle + (seg.endAngle - seg.startAngle) / 2);
        ctx.textAlign = "right";
        ctx.fillStyle = "#000";
        ctx.font = "bold 14px Arial";
        ctx.fillText(seg.player.name, radius - 20, 5);
        ctx.restore();
    });

    ctx.restore();

    // Draw Arrow/Pointer
    ctx.beginPath();
    ctx.fillStyle = "black";
    ctx.moveTo(cx + 10, 0); // Top center
    ctx.lineTo(cx - 10, 0);
    ctx.lineTo(cx, 25);
    ctx.fill();
}

els.spinBtn.addEventListener('click', () => {
    if (wheelCtx.isSpinning) return;
    if (wheelCtx.segments.length === 0) return;

    wheelCtx.isSpinning = true;
    els.spinBtn.disabled = true;
    
    // Random spin force
    // Minimum 3 full rotations (3 * 2PI) + random
    const baseRotations = Math.PI * 2 * 5; 
    const randomOffset = Math.random() * Math.PI * 2;
    const targetRotation = wheelCtx.rotation + baseRotations + randomOffset;
    
    let startTime = null;
    const duration = 5000; // 5 seconds spin

    function animate(timestamp) {
        if (!startTime) startTime = timestamp;
        const progress = timestamp - startTime;
        const t = Math.min(progress / duration, 1); // 0 to 1
        
        // Easing function (easeOutQuart)
        const ease = 1 - Math.pow(1 - t, 4);
        
        wheelCtx.rotation = (wheelCtx.rotation % (Math.PI * 2)) + (targetRotation - (wheelCtx.rotation % (Math.PI * 2))) * ease;
        
        // Actually, simple interp:
        // We can't easily interpolate accumulated rotation without keeping the total.
        // Better approach: 
        // current = start + (totalDelta * ease)
    }
    
    // Simplified animation loop
    let startRot = wheelCtx.rotation;
    let deltaRot = (baseRotations + randomOffset);

    function loop(timestamp) {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        
        if (elapsed < duration) {
            const t = elapsed / duration;
            const ease = 1 - Math.pow(1 - t, 4); // Ease out quart
            wheelCtx.rotation = startRot + deltaRot * ease;
            drawWheel();
            requestAnimationFrame(loop);
        } else {
            wheelCtx.rotation = startRot + deltaRot;
            drawWheel();
            wheelCtx.isSpinning = false;
            determineWinner();
        }
    }
    
    requestAnimationFrame(loop);
});

function determineWinner() {
    // Normalize rotation to 0-2PI
    // The pointer is at angle 0 (top), effectively 1.5*PI or similar depending on coord system.
    // In standard canvas arc, 0 is 3 o'clock. 
    // Pointer at top = 270 deg = 1.5 * PI.
    
    // However, we rotated the canvas. The Pointer is static at top.
    // To find the segment under the pointer, we need to calculate:
    // (PointerAngle - Rotation) % 2PI.
    
    const pointerAngle = 1.5 * Math.PI; // 270 degrees (Top)
    let effectiveAngle = (pointerAngle - wheelCtx.rotation) % (2 * Math.PI);
    if (effectiveAngle < 0) effectiveAngle += 2 * Math.PI;

    const winnerSegment = wheelCtx.segments.find(seg => 
        effectiveAngle >= seg.startAngle && effectiveAngle < seg.endAngle
    );

    if (winnerSegment) {
        const winner = winnerSegment.player;
        els.winnerBanner.textContent = `Winner: ${winner.name}!`;
        
        // Add to winner list
        appState.winners.push(winner.id);
        const li = document.createElement('li');
        li.textContent = `${appState.winners.length}. ${winner.name} (Tickets: ${winner.tickets})`;
        els.winnerList.appendChild(li);

        // Remove from wheel
        setTimeout(() => {
            const remainingPlayers = wheelCtx.segments
                .map(s => s.player)
                .filter(p => p.id !== winner.id);
            
            if (remainingPlayers.length > 0) {
                setupWheel(remainingPlayers);
                drawWheel();
                els.spinBtn.disabled = false;
            } else {
                els.winnerBanner.textContent += " (All players picked)";
                ctx.clearRect(0, 0, els.wheelCanvas.width, els.wheelCanvas.height);
            }
        }, 2000);
    }
}