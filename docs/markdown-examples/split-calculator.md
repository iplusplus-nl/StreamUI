Here is a complete, single-file solution using HTML, CSS, and JavaScript. It features a polished, compact UI, live updates, and explicitly breaks down the math for the user.

You can save this code as an `.html` file (e.g., `calculator.html`) and open it in any web browser.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tip & Split Calculator</title>
  <style>
    :root {
      --primary: #0ea5e9;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    body {
      background-color: var(--bg);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      color: var(--text-main);
      padding: 1rem;
    }

    .calculator {
      background-color: var(--card-bg);
      width: 100%;
      max-width: 360px;
      padding: 1.5rem;
      border-radius: 20px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
    }

    h2 {
      font-size: 1.25rem;
      text-align: center;
      margin-bottom: 1.5rem;
      color: var(--text-main);
    }

    .input-group {
      margin-bottom: 1.25rem;
    }

    .input-group label {
      display: block;
      font-size: 0.875rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--text-muted);
    }

    input[type="number"] {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 1rem;
      color: var(--text-main);
      outline: none;
      transition: border-color 0.2s;
    }

    input[type="number"]:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.1);
    }

    .flex-row {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    input[type="range"] {
      flex: 1;
      accent-color: var(--primary);
    }

    .tip-input {
      width: 80px !important;
    }

    .btn-control {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      width: 40px;
      height: 40px;
      display: flex;
      justify-content: center;
      align-items: center;
      font-size: 1.25rem;
      cursor: pointer;
      color: var(--text-main);
      transition: background 0.2s;
    }

    .btn-control:hover {
      background: #e2e8f0;
    }

    .btn-control:active {
      transform: scale(0.95);
    }

    .party-input {
      text-align: center;
    }

    .results {
      background: var(--bg);
      border-radius: 12px;
      padding: 1.25rem;
      margin-top: 1.5rem;
    }

    .result-row {
      display: flex;
      justify-content: space-between;
      font-size: 0.875rem;
      margin-bottom: 0.5rem;
      color: var(--text-muted);
    }

    .result-row.total {
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .result-row.highlight {
      font-size: 1.25rem;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 0;
      align-items: center;
    }

    .calculation-breakdown {
      margin-top: 1.25rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      text-align: center;
      line-height: 1.5;
      background: #f1f5f9;
      padding: 0.75rem;
      border-radius: 8px;
    }

    code {
      font-family: inherit;
      font-weight: 600;
      color: var(--text-main);
    }
  </style>
</head>
<body>

  <div class="calculator">
    <h2>Tip & Split Calculator</h2>

    <!-- Bill Input -->
    <div class="input-group">
      <label for="bill">Bill Amount (€)</label>
      <input type="number" id="bill" value="186.50" step="0.01" min="0">
    </div>

    <!-- Tip Input -->
    <div class="input-group">
      <label for="tipRange">Tip Percentage (%)</label>
      <div class="flex-row">
        <input type="range" id="tipRange" value="10" min="0" max="30" step="1">
        <input type="number" id="tipInput" value="10" min="0" class="tip-input">
      </div>
    </div>

    <!-- Party Size Input -->
    <div class="input-group">
      <label for="party">Party Size (People)</label>
      <div class="flex-row">
        <button class="btn-control" id="btnMinus">−</button>
        <input type="number" id="party" value="4" min="1" step="1" class="party-input">
        <button class="btn-control" id="btnPlus">+</button>
      </div>
    </div>

    <!-- Results Display -->
    <div class="results">
      <div class="result-row">
        <span>Tip Amount:</span>
        <span id="outTip">€0.00</span>
      </div>
      <div class="result-row total">
        <span>Total Bill (with tip):</span>
        <span id="outTotal">€0.00</span>
      </div>
      <div class="result-row highlight">
        <span>Per Person:</span>
        <span id="outPerPerson">€0.00</span>
      </div>
    </div>

    <!-- Explicit Calculation Breakdown -->
    <div class="calculation-breakdown" id="breakdown">
      <!-- Injected via JS -->
    </div>
  </div>

  <script>
    // Elements
    const billEl = document.getElementById('bill');
    const tipRangeEl = document.getElementById('tipRange');
    const tipInputEl = document.getElementById('tipInput');
    const partyEl = document.getElementById('party');

    const btnMinus = document.getElementById('btnMinus');
    const btnPlus = document.getElementById('btnPlus');

    const outTip = document.getElementById('outTip');
    const outTotal = document.getElementById('outTotal');
    const outPerPerson = document.getElementById('outPerPerson');
    const breakdownEl = document.getElementById('breakdown');

    // Format currency helper
    const formatEUR = (num) => `€${num.toFixed(2)}`;

    // Main calculation logic
    function calculate() {
      // Parse inputs, establish defaults for empty fields
      const bill = parseFloat(billEl.value) || 0;
      const tipPct = parseFloat(tipInputEl.value) || 0;
      let party = parseInt(partyEl.value) || 1;

      // Prevent division by zero
      if (party < 1) party = 1;

      // Math
      const tipAmount = bill * (tipPct / 100);
      const totalBill = bill + tipAmount;
      const perPerson = totalBill / party;

      // Update Output totals
      outTip.textContent = formatEUR(tipAmount);
      outTotal.textContent = formatEUR(totalBill);
      outPerPerson.textContent = formatEUR(perPerson);

      // Update Breakdown string
      breakdownEl.innerHTML = `
        Calculation: <br>
        <code>(${formatEUR(bill)} + ${formatEUR(tipAmount)} tip) ÷ ${party} people = ${formatEUR(perPerson)}</code>
      `;
    }

    // Sync range and number inputs for Tip
    tipRangeEl.addEventListener('input', (e) => {
      tipInputEl.value = e.target.value;
      calculate();
    });

    tipInputEl.addEventListener('input', (e) => {
      tipRangeEl.value = e.target.value;
      calculate();
    });

    // Handle + / - buttons for Party Size
    btnMinus.addEventListener('click', () => {
      let currentVal = parseInt(partyEl.value) || 1;
      if (currentVal > 1) {
        partyEl.value = currentVal - 1;
        calculate();
      }
    });

    btnPlus.addEventListener('click', () => {
      let currentVal = parseInt(partyEl.value) || 1;
      partyEl.value = currentVal + 1;
      calculate();
    });

    // Listeners for standard text input typing
    billEl.addEventListener('input', calculate);
    partyEl.addEventListener('input', calculate);

    // Initial calculation on load
    calculate();
  </script>
</body>
</html>
```
