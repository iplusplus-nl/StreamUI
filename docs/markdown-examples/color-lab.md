An elegant, self-contained interactive color palette lab. It features dynamically colored sliders, intelligent text-color flipping for the hex readouts, and a real-time WCAG contrast calculator.

Save the following code as an `.html` file and open it in any browser.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vivid Palette Lab</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

  :root {
    --bg-color: #0f1115;
    --panel-bg: #1a1d24;
    --border: #2c313c;
    --text-main: #e2e8f0;
    --text-muted: #94a3b8;
    --accent: #6366f1;
    --pass: #10b981;
    --fail: #ef4444;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }

  body {
    background-color: var(--bg-color);
    color: var(--text-main);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 20px;
  }

  .lab-container {
    background: var(--panel-bg);
    width: 100%;
    max-width: 480px;
    border-radius: 20px;
    padding: 24px;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5), 0 0 0 1px var(--border);
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.5px; }

  /* Palette Swatches */
  .palette {
    display: flex;
    gap: 8px;
    height: 90px;
  }

  .swatch {
    flex: 1;
    border-radius: 12px;
    cursor: pointer;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 12px;
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), flex 0.2s;
    position: relative;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
  }

  .swatch.active {
    flex: 1.5;
    transform: translateY(-4px);
    box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3), inset 0 0 0 2px rgba(255,255,255,0.8);
  }

  .hex-label {
    font-size: 0.75rem;
    font-family: monospace;
    font-weight: 700;
    text-transform: uppercase;
    pointer-events: none;
  }

  /* Sliders */
  .controls {
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: rgba(0,0,0,0.2);
    padding: 16px;
    border-radius: 12px;
  }

  .slider-group {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .slider-group label {
    width: 20px;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .slider-group span {
    width: 32px;
    text-align: right;
    font-size: 0.75rem;
    font-family: monospace;
    color: var(--text-muted);
  }

  input[type=range] {
    -webkit-appearance: none;
    width: 100%;
    height: 8px;
    border-radius: 4px;
    background: var(--track-bg, #333);
    outline: none;
  }

  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    cursor: ew-resize;
    box-shadow: 0 0 0 2px rgba(0,0,0,0.2);
  }

  /* Contrast Checker */
  .contrast-section {
    border-top: 1px solid var(--border);
    padding-top: 24px;
  }

  .section-title {
    font-size: 0.85rem;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 700;
    margin-bottom: 16px;
    letter-spacing: 0.5px;
  }

  .checker-ui {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .select-group { display: flex; flex-direction: column; gap: 6px; }
  .select-group label { font-size: 0.75rem; color: var(--text-muted); }

  select {
    background: rgba(0,0,0,0.2);
    color: var(--text-main);
    border: 1px solid var(--border);
    padding: 8px;
    border-radius: 8px;
    outline: none;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .preview-area {
    grid-column: 1 / -1;
    height: 80px;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    font-size: 1.5rem;
    font-weight: 600;
    transition: background 0.3s, color 0.3s;
    position: relative;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.2);
  }

  .small-text-preview {
    font-size: 0.85rem;
    font-weight: 400;
    margin-top: 4px;
  }

  .results {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: rgba(0,0,0,0.2);
    padding: 12px 16px;
    border-radius: 12px;
  }

  .ratio-wrapper { display: flex; align-items: baseline; gap: 4px; }
  .ratio-value { font-size: 1.5rem; font-weight: 700; font-family: monospace; }
  .ratio-label { font-size: 0.75rem; color: var(--text-muted); }

  .badges {
    display: flex;
    gap: 8px;
  }

  .badge {
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: #333;
    color: #888;
    display: flex;
    flex-direction: column;
    align-items: center;
    line-height: 1.2;
  }

  .badge span { font-size: 0.55rem; opacity: 0.8; font-weight: 500; }
  .badge.pass { background: rgba(16, 185, 129, 0.15); color: var(--pass); border: 1px solid rgba(16,185,129,0.3); }
  .badge.fail { background: rgba(239, 68, 68, 0.15); color: var(--fail); border: 1px solid rgba(239,68,68,0.3); }

</style>
</head>
<body>

<div class="lab-container">
  <div class="header">
    <h1>Vivid Palette Lab</h1>
  </div>

  <div class="palette" id="palette">
    <!-- Swatches injected via JS -->
  </div>

  <div class="controls">
    <div class="slider-group">
      <label>H</label>
      <input type="range" id="hue" min="0" max="360" value="0">
      <span id="h-val">0</span>
    </div>
    <div class="slider-group">
      <label>S</label>
      <input type="range" id="sat" min="0" max="100" value="0">
      <span id="s-val">0</span>
    </div>
    <div class="slider-group">
      <label>L</label>
      <input type="range" id="lit" min="0" max="100" value="0">
      <span id="l-val">0</span>
    </div>
  </div>

  <div class="contrast-section">
    <div class="section-title">Contrast Checker</div>
    <div class="checker-ui">

      <div class="select-group">
        <label>Foreground Text</label>
        <select id="fg-select">
          <option value="0">Color 1</option>
          <option value="1">Color 2</option>
          <option value="2">Color 3</option>
          <option value="3">Color 4</option>
          <option value="4" selected>Color 5</option>
        </select>
      </div>

      <div class="select-group">
        <label>Background</label>
        <select id="bg-select">
          <option value="0" selected>Color 1</option>
          <option value="1">Color 2</option>
          <option value="2">Color 3</option>
          <option value="3">Color 4</option>
          <option value="4">Color 5</option>
        </select>
      </div>

      <div class="preview-area" id="preview">
        Hello World
        <div class="small-text-preview">Legibility matters.</div>
      </div>

      <div class="results">
        <div class="ratio-wrapper">
          <span class="ratio-value" id="ratio-display">1.00</span>
          <span class="ratio-label">: 1</span>
        </div>
        <div class="badges">
          <div class="badge" id="badge-aa">AA <span>Normal</span></div>
          <div class="badge" id="badge-aa-lg">AA <span>Large</span></div>
          <div class="badge" id="badge-aaa">AAA <span>Normal</span></div>
        </div>
      </div>

    </div>
  </div>
</div>

<script>
  // State
  let colors = [
    { h: 250, s: 80, l: 60 }, // Vivid Purple
    { h: 320, s: 90, l: 65 }, // Hot Pink
    { h: 35,  s: 95, l: 55 }, // Orange
    { h: 220, s: 40, l: 15 }, // Dark Navy
    { h: 210, s: 20, l: 96 }  // Off White
  ];
  let activeIdx = 0;

  // DOM Elements
  const paletteEl = document.getElementById('palette');
  const hueInput = document.getElementById('hue');
  const satInput = document.getElementById('sat');
  const litInput = document.getElementById('lit');
  const hVal = document.getElementById('h-val');
  const sVal = document.getElementById('s-val');
  const lVal = document.getElementById('l-val');

  const fgSelect = document.getElementById('fg-select');
  const bgSelect = document.getElementById('bg-select');
  const previewArea = document.getElementById('preview');
  const ratioDisplay = document.getElementById('ratio-display');

  const badgeAA = document.getElementById('badge-aa');
  const badgeAALg = document.getElementById('badge-aa-lg');
  const badgeAAA = document.getElementById('badge-aaa');

  // Math Utilities
  function hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
  }

  function rgbToHex(r, g, b) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
  }

  function getLuminance(r, g, b) {
    let a = [r, g, b].map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  }

  function getContrast(rgb1, rgb2) {
    const lum1 = getLuminance(rgb1[0], rgb1[1], rgb1[2]);
    const lum2 = getLuminance(rgb2[0], rgb2[1], rgb2[2]);
    const lightest = Math.max(lum1, lum2);
    const darkest = Math.min(lum1, lum2);
    return (lightest + 0.05) / (darkest + 0.05);
  }

  // Determine if text on a color should be black or white
  function getBestTextColor(r, g, b) {
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#ffffff';
  }

  // UI Updates
  function initSwatches() {
    paletteEl.innerHTML = '';
    colors.forEach((c, idx) => {
      const el = document.createElement('div');
      el.className = `swatch ${idx === activeIdx ? 'active' : ''}`;
      el.innerHTML = `<span class="hex-label"></span>`;
      el.onclick = () => setActiveSwatch(idx);
      paletteEl.appendChild(el);
    });
    updateAll();
  }

  function setActiveSwatch(idx) {
    activeIdx = idx;
    Array.from(paletteEl.children).forEach((el, i) => {
      el.classList.toggle('active', i === activeIdx);
    });
    const c = colors[activeIdx];
    hueInput.value = c.h;
    satInput.value = c.s;
    litInput.value = c.l;
    updateSliderVisuals();
  }

  function updateSliderVisuals() {
    const c = colors[activeIdx];
    hVal.innerText = c.h;
    sVal.innerText = c.s;
    lVal.innerText = c.l;

    // Rainbow background for Hue
    hueInput.style.setProperty('--track-bg', 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)');

    // Saturation background (grey to full color at current lightness)
    const satSt = rgbToHex(...hslToRgb(c.h, 0, c.l));
    const satEd = rgbToHex(...hslToRgb(c.h, 100, c.l));
    satInput.style.setProperty('--track-bg', `linear-gradient(to right, ${satSt}, ${satEd})`);

    // Lightness background (black to color to white)
    const litMid = rgbToHex(...hslToRgb(c.h, c.s, 50));
    litInput.style.setProperty('--track-bg', `linear-gradient(to right, #000, ${litMid}, #fff)`);
  }

  function updateAll() {
    updateSliderVisuals();

    // Update Swatches
    colors.forEach((c, idx) => {
      const rgb = hslToRgb(c.h, c.s, c.l);
      const hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
      const swatch = paletteEl.children[idx];
      swatch.style.background = hex;

      const label = swatch.querySelector('.hex-label');
      label.innerText = hex;
      label.style.color = getBestTextColor(rgb[0], rgb[1], rgb[2]);

      // Update Dropdown labels silently
      fgSelect.options[idx].text = `C${idx+1} (${hex})`;
      bgSelect.options[idx].text = `C${idx+1} (${hex})`;
    });

    // Update Contrast Checker
    const fgIdx = parseInt(fgSelect.value);
    const bgIdx = parseInt(bgSelect.value);

    const fgRgb = hslToRgb(colors[fgIdx].h, colors[fgIdx].s, colors[fgIdx].l);
    const bgRgb = hslToRgb(colors[bgIdx].h, colors[bgIdx].s, colors[bgIdx].l);

    previewArea.style.color = rgbToHex(fgRgb[0], fgRgb[1], fgRgb[2]);
    previewArea.style.backgroundColor = rgbToHex(bgRgb[0], bgRgb[1], bgRgb[2]);

    const ratio = getContrast(fgRgb, bgRgb);
    ratioDisplay.innerText = ratio.toFixed(2);

    // Badges logic
    const setBadge = (el, condition) => {
      el.className = `badge ${condition ? 'pass' : 'fail'}`;
    };

    setBadge(badgeAA, ratio >= 4.5);
    setBadge(badgeAALg, ratio >= 3.0);
    setBadge(badgeAAA, ratio >= 7.0);
  }

  // Event Listeners
  [hueInput, satInput, litInput].forEach(input => {
    input.addEventListener('input', (e) => {
      colors[activeIdx][e.target.id.charAt(0)] = parseInt(e.target.value);
      updateAll();
    });
  });

  fgSelect.addEventListener('change', updateAll);
  bgSelect.addEventListener('change', updateAll);

  // Boot
  initSwatches();
  setActiveSwatch(0);
</script>

</body>
</html>
```
