Here is a polished, fully functional Pomodoro clock within a single file. It features an analog-inspired, tabular-numeric display, smooth mode transitions, session tracking, and keyboard shortcuts.

Save the following code as an `.html` file and open it in your browser.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Focus Clock</title>
    <style>
        :root {
            --bg-color: #0f0f13;
            --surface: #1c1c21;
            --text-main: #e0e0e0;
            --text-muted: #6b6b76;

            /* Mode Colors */
            --focus-color: #ff5e57;
            --short-color: #0fb9b1;
            --long-color: #487eb0;

            --current-color: var(--focus-color);
            --font-main: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            background-color: var(--bg-color);
            color: var(--text-main);
            font-family: var(--font-main);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            transition: background-color 0.5s ease;
        }

        .container {
            background-color: var(--surface);
            padding: 3rem;
            border-radius: 24px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05);
            width: 100%;
            max-width: 480px;
            display: flex;
            flex-direction: column;
            align-items: center;
            position: relative;
            overflow: hidden;
        }

        /* Subtle top glow based on mode */
        .container::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 4px;
            background-color: var(--current-color);
            transition: background-color 0.5s ease;
        }

        /* Modes */
        .modes {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 2.5rem;
            background: rgba(0,0,0,0.2);
            padding: 0.3rem;
            border-radius: 12px;
        }

        .mode-btn {
            background: none;
            border: none;
            color: var(--text-muted);
            padding: 0.6rem 1rem;
            border-radius: 8px;
            font-size: 0.85rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .mode-btn.active {
            background-color: var(--surface);
            color: var(--text-main);
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }

        kbd {
            background: rgba(255,255,255,0.1);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 0.65rem;
            font-family: monospace;
            color: var(--text-muted);
        }

        .mode-btn.active kbd { color: var(--current-color); }

        /* Timer Display */
        .timer {
            font-size: 6rem;
            font-weight: 800;
            letter-spacing: -2px;
            font-variant-numeric: tabular-nums;
            margin-bottom: 1.5rem;
            color: var(--current-color);
            text-shadow: 0 0 20px rgba(255, 255, 255, 0.05);
            transition: color 0.5s ease;
            display: flex;
            align-items: center;
        }

        .colon {
            margin: 0 -5px;
            padding-bottom: 15px; /* Visual alignment */
            opacity: 1;
            transition: opacity 0.1s;
        }

        .colon.blink {
            animation: blink 1s step-end infinite;
        }

        @keyframes blink { 50% { opacity: 0.2; } }

        /* Progress Dots */
        .progress {
            display: flex;
            gap: 12px;
            margin-bottom: 2.5rem;
        }

        .dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: 2px solid var(--text-muted);
            transition: all 0.3s ease;
        }

        .dot.filled {
            background-color: var(--current-color);
            border-color: var(--current-color);
            box-shadow: 0 0 10px var(--current-color);
        }

        .dot.active-session {
            border-color: var(--current-color);
            animation: pulse-border 2s infinite;
        }

        @keyframes pulse-border {
            0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.2); }
            70% { box-shadow: 0 0 0 8px rgba(255,255,255,0); }
            100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
        }

        /* Task Field */
        .task-input {
            width: 100%;
            background: none;
            border: none;
            border-bottom: 2px solid rgba(255,255,255,0.1);
            color: var(--text-main);
            font-size: 1rem;
            text-align: center;
            padding: 0.8rem;
            margin-bottom: 2.5rem;
            outline: none;
            transition: border-color 0.3s ease;
        }

        .task-input:focus {
            border-bottom-color: var(--current-color);
        }

        .task-input::placeholder { color: rgba(255,255,255,0.2); }

        /* Controls */
        .controls {
            display: flex;
            gap: 1rem;
            align-items: center;
        }

        .btn {
            border: none;
            cursor: pointer;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: transform 0.1s, opacity 0.2s, background-color 0.3s;
            font-weight: bold;
        }

        .btn:active { transform: scale(0.95); }

        .btn-main {
            background-color: var(--current-color);
            color: #fff;
            padding: 1rem 2.5rem;
            font-size: 1.1rem;
            min-width: 160px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        }

        .btn-main kbd { background: rgba(0,0,0,0.2); color: #fff; }

        .btn-icon {
            background-color: rgba(255,255,255,0.05);
            color: var(--text-muted);
            width: 50px;
            height: 50px;
            font-size: 1.2rem;
            position: relative;
        }

        .btn-icon:hover {
            background-color: rgba(255,255,255,0.1);
            color: var(--text-main);
        }

        .btn-icon kbd {
            position: absolute;
            bottom: -25px;
            font-size: 0.6rem;
            opacity: 0;
            transition: opacity 0.2s, bottom 0.2s;
        }

        .btn-icon:hover kbd {
            opacity: 1;
            bottom: -20px;
        }

    </style>
</head>
<body>

    <div class="container">
        <div class="modes">
            <button class="mode-btn active" data-mode="focus">Focus <kbd>1</kbd></button>
            <button class="mode-btn" data-mode="short">Short Break <kbd>2</kbd></button>
            <button class="mode-btn" data-mode="long">Long Break <kbd>3</kbd></button>
        </div>

        <div class="timer">
            <span id="min">25</span><span class="colon">:</span><span id="sec">00</span>
        </div>

        <div class="progress" id="dots-container">
            <div class="dot active-session"></div>
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
        </div>

        <input type="text" class="task-input" placeholder="What are you focusing on?" autocomplete="off">

        <div class="controls">
            <button class="btn btn-icon" id="reset-btn" title="Reset">↻ <kbd>R</kbd></button>
            <button class="btn btn-main" id="start-btn">Start <kbd>Space</kbd></button>
            <button class="btn btn-icon" id="skip-btn" title="Skip">⏭ <kbd>S</kbd></button>
        </div>
    </div>

    <script>
        const DURATIONS = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };
        const COLORS = { focus: '#ff5e57', short: '#0fb9b1', long: '#487eb0' };

        let currentMode = 'focus';
        let timeLeft = DURATIONS[currentMode];
        let timerId = null;
        let isRunning = false;
        let sessionsCompleted = 0;

        // DOM Elements
        const minEl = document.getElementById('min');
        const secEl = document.getElementById('sec');
        const colonEl = document.querySelector('.colon');
        const startBtn = document.getElementById('start-btn');
        const root = document.documentElement;
        const dots = document.querySelectorAll('.dot');
        const modeBtns = document.querySelectorAll('.mode-btn');

        // Functions
        function updateDisplay() {
            const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
            const s = (timeLeft % 60).toString().padStart(2, '0');
            minEl.textContent = m;
            secEl.textContent = s;
            document.title = `${m}:${s} - ${currentMode === 'focus' ? 'Focus' : 'Break'}`;
        }

        function toggleTimer() {
            if (isRunning) pauseTimer();
            else startTimer();
        }

        function startTimer() {
            isRunning = true;
            startBtn.innerHTML = 'Pause <kbd>Space</kbd>';
            colonEl.classList.add('blink');
            timerId = setInterval(() => {
                timeLeft--;
                updateDisplay();
                if (timeLeft <= 0) handleComplete();
            }, 1000);
        }

        function pauseTimer() {
            isRunning = false;
            startBtn.innerHTML = 'Start <kbd>Space</kbd>';
            colonEl.classList.remove('blink');
            clearInterval(timerId);
        }

        function resetTimer() {
            pauseTimer();
            timeLeft = DURATIONS[currentMode];
            updateDisplay();
        }

        function switchMode(mode) {
            currentMode = mode;
            root.style.setProperty('--current-color', COLORS[mode]);

            modeBtns.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });

            updateDotsDisplay();
            resetTimer();
        }

        function handleComplete() {
            if (currentMode === 'focus') {
                sessionsCompleted++;
                if (sessionsCompleted % 4 === 0) switchMode('long');
                else switchMode('short');
            } else {
                switchMode('focus');
            }
        }

        function updateDotsDisplay() {
            const cycleCount = sessionsCompleted % 4;

            dots.forEach((dot, index) => {
                dot.className = 'dot'; // Reset classes
                if (index < cycleCount) {
                    dot.classList.add('filled');
                } else if (index === cycleCount && currentMode === 'focus') {
                    dot.classList.add('active-session');
                }
            });

            // If a long break completes, empty the dots for the new cycle
            if (currentMode === 'focus' && cycleCount === 0 && sessionsCompleted > 0) {
                 dots.forEach(d => d.classList.remove('filled'));
                 dots[0].classList.add('active-session');
            }
        }

        // Event Listeners
        startBtn.addEventListener('click', toggleTimer);
        document.getElementById('reset-btn').addEventListener('click', resetTimer);
        document.getElementById('skip-btn').addEventListener('click', handleComplete);

        modeBtns.forEach(btn => {
            btn.addEventListener('click', () => switchMode(btn.dataset.mode));
        });

        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            // Disable shortcuts if typing in the task field
            if (document.activeElement.tagName === 'INPUT') return;

            if (e.code === 'Space') {
                e.preventDefault();
                toggleTimer();
            }
            if (e.key.toLowerCase() === 'r') resetTimer();
            if (e.key.toLowerCase() === 's') handleComplete();
            if (e.key === '1') switchMode('focus');
            if (e.key === '2') switchMode('short');
            if (e.key === '3') switchMode('long');
        });

        // Init
        updateDisplay();
        updateDotsDisplay();
    </script>
</body>
</html>
```
