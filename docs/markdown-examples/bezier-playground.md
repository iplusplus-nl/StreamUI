Cubic Bézier curves are the foundation of digital vector graphics and UI animation. They provide a predictable, mathematically elegant way to smoothly interpolate between values over time.

Here is a fully interactive playground to help you intuition-build and understand the math behind them.

```jsx project="bezier-playground" file="App.jsx"
import React, { useState, useEffect, useRef } from 'react';
import { Play } from 'lucide-react';

const App = () => {
  // SVG Coordinate mapping configuration
  const padX = 40;
  const padY = 80;
  const sizeX = 300;
  const sizeY = 300;

  // State for control points (normalized 0 to 1 scale)
  const [p1, setP1] = useState({ MathX: 0.25, MathY: 0.1 });
  const [p2, setP2] = useState({ MathX: 0.25, MathY: 1.0 });
  const [dragging, setDragging] = useState(null);

  // Animation state
  const [animating, setAnimating] = useState(false);
  const [key, setKey] = useState(0); // Used to re-trigger CSS animations

  const svgRef = useRef(null);

  // Coordinate Conversion Helpers
  const toSvgX = (x) => padX + x * sizeX;
  const toSvgY = (y) => padY + sizeY - (y * sizeY);

  const toMathX = (svgX) => (svgX - padX) / sizeX;
  const toMathY = (svgY) => (padY + sizeY - svgY) / sizeY;

  // Global Drag Handling
  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (e) => {
      if (!svgRef.current) return;

      const rect = svgRef.current.getBoundingClientRect();
      const rawMathX = toMathX(e.clientX - rect.left);
      const rawMathY = toMathY(e.clientY - rect.top);

      // CSS cubic-bezier requires X to be clamped between 0 and 1.
      // Y can go out of bounds (which creates bounce/overshoot effects).
      const clampedX = Math.max(0, Math.min(1, rawMathX));

      if (dragging === 'p1') {
        setP1({ MathX: clampedX, MathY: rawMathY });
      } else if (dragging === 'p2') {
        setP2({ MathX: clampedX, MathY: rawMathY });
      }
    };

    const handlePointerUp = () => setDragging(null);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragging]);

  const p1x = toSvgX(p1.MathX);
  const p1y = toSvgY(p1.MathY);
  const p2x = toSvgX(p2.MathX);
  const p2y = toSvgY(p2.MathY);
  const p0x = toSvgX(0);
  const p0y = toSvgY(0);
  const p3x = toSvgX(1);
  const p3y = toSvgY(1);

  const bezierString = `${p1.MathX.toFixed(2)}, ${p1.MathY.toFixed(2)}, ${p2.MathX.toFixed(2)}, ${p2.MathY.toFixed(2)}`;

  const presets = [
    { name: "Ease In-Out", p1: { MathX: 0.42, MathY: 0.0 }, p2: { MathX: 0.58, MathY: 1.0 } },
    { name: "Overshoot (Bounce)", p1: { MathX: 0.17, MathY: 0.88 }, p2: { MathX: 0.32, MathY: 1.27 } },
    { name: "Fast Out, Linear In", p1: { MathX: 0.0, MathY: 0.0 }, p2: { MathX: 0.2, MathY: 1.0 } },
  ];

  const handlePlay = () => {
    setAnimating(false);
    // Tiny timeout to allow DOM to register the class removal, resetting the animation
    setTimeout(() => {
      setKey(k => k + 1);
      setAnimating(true);
    }, 50);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-6 font-sans select-none flex flex-col md:flex-row gap-8">

      {/* Left Column: Interactive Graph */}
      <div className="flex-1 flex flex-col items-center max-w-lg">
        <div className="bg-slate-800 p-6 rounded-2xl shadow-2xl border border-slate-700 w-full relative">
          <svg
            ref={svgRef}
            width="380"
            height="460"
            className="block overflow-visible touch-none"
          >
            {/* Background Grid */}
            <rect x={padX} y={padY} width={sizeX} height={sizeY} fill="transparent" stroke="#334155" strokeWidth="2" strokeDasharray="4 4" />

            {/* Axis Labels */}
            <text x={padX} y={padY + sizeY + 24} fill="#94a3b8" fontSize="12" className="select-none">0 (Time)</text>
            <text x={padX + sizeX} y={padY + sizeY + 24} fill="#94a3b8" fontSize="12" textAnchor="end" className="select-none">1</text>
            <text x={padX - 12} y={padY + sizeY} fill="#94a3b8" fontSize="12" textAnchor="end" dominantBaseline="middle" className="select-none">0</text>
            <text x={padX - 12} y={padY} fill="#94a3b8" fontSize="12" textAnchor="end" dominantBaseline="middle" className="select-none">1 (Progression)</text>

            {/* Control Lines */}
            <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#0ea5e9" strokeWidth="2" strokeDasharray="5 5" />
            <line x1={p3x} y1={p3y} x2={p2x} y2={p2y} stroke="#d946ef" strokeWidth="2" strokeDasharray="5 5" />

            {/* The Bezier Curve */}
            <path
              d={`M ${p0x} ${p0y} C ${p1x} ${p1y}, ${p2x} ${p2y}, ${p3x} ${p3y}`}
              fill="transparent"
              stroke="#f8fafc"
              strokeWidth="4"
              strokeLinecap="round"
            />

            {/* Anchor Points */}
            <circle cx={p0x} cy={p0y} r="6" fill="#f8fafc" />
            <circle cx={p3x} cy={p3y} r="6" fill="#f8fafc" />

            {/* Draggable Control Handles */}
            <g
              transform={`translate(${p1x}, ${p1y})`}
              onPointerDown={(e) => { e.stopPropagation(); setDragging('p1'); }}
              className="cursor-grab active:cursor-grabbing"
            >
              <circle r="12" fill="transparent" stroke="transparent" /> {/* Large hit area */}
              <circle r="6" fill="#0ea5e9" stroke="#fff" strokeWidth="2" />
              <text x="12" y="4" fill="#0ea5e9" fontSize="12" fontWeight="bold">P1</text>
            </g>

            <g
              transform={`translate(${p2x}, ${p2y})`}
              onPointerDown={(e) => { e.stopPropagation(); setDragging('p2'); }}
              className="cursor-grab active:cursor-grabbing"
            >
              <circle r="12" fill="transparent" stroke="transparent" /> {/* Large hit area */}
              <circle r="6" fill="#d946ef" stroke="#fff" strokeWidth="2" />
              <text x="12" y="4" fill="#d946ef" fontSize="12" fontWeight="bold">P2</text>
            </g>
          </svg>
        </div>

        {/* Live Animation Demo */}
        <div className="mt-6 bg-slate-800 p-6 rounded-2xl shadow-xl border border-slate-700 w-full relative">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-slate-300 font-semibold tracking-wide uppercase text-sm">Visual Preview</h3>
            <button
              onClick={handlePlay}
              className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-bold py-1 px-3 rounded-full transition-colors"
            >
              <Play size={16} /> Run
            </button>
          </div>

          {/* Track */}
          <div className="w-full bg-slate-700 h-10 rounded-lg relative overflow-hidden">
            {/* Animated Box */}
            <div
              key={key}
              className="h-full bg-indigo-500 rounded-lg absolute left-0 top-0 shadow-lg"
              style={{
                width: '40px',
                transform: animating ? 'translateX(calc(100cqw - 40px))' : 'translateX(0)',
                transitionProperty: 'transform',
                transitionDuration: '1.2s',
                transitionTimingFunction: `cubic-bezier(${bezierString})`,
                containerType: 'inline-size' // using CSS container queries for accurate 100% track movement
              }}
            />
          </div>
        </div>
      </div>

      {/* Right Column: Educational Content & Formulas */}
      <div className="flex-1 max-w-xl flex flex-col gap-6">

        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Cubic Bézier Curves</h1>
          <p className="text-slate-400 text-lg leading-relaxed">
            In UI design and animation, cubic Bézier curves define how a value changes over time.
            They require four distinct points: <strong className="text-white">P0, P1, P2, and P3</strong>.
          </p>
        </div>

        <div className="bg-slate-800 p-5 rounded-2xl border border-slate-700 shadow-xl space-y-4">
          <h2 className="text-emerald-400 font-semibold text-lg flex items-center gap-2">
            The Math
          </h2>
          <p className="text-slate-400 text-sm leading-relaxed">
            A cubic Bézier curve interpolates between the points using a parameter <strong>t</strong> (ranging from 0 to 1).
            The beautiful part? It's just a sequence of weighted polynomial blends. Here is the mathematical formula:
          </p>

          <div className="bg-slate-900 p-4 rounded-xl font-mono text-sm overflow-x-auto text-emerald-300 shadow-inner">
            B(t) =
            <span className="text-slate-400">(1-t)³</span>P₀ +
            <span className="text-cyan-400">3(1-t)²t</span>P₁ +
            <span className="text-fuchsia-400">3(1-t)t²</span>P₂ +
            <span className="text-slate-400">t³</span>P₃
          </div>

          <p className="text-slate-400 text-sm leading-relaxed">
            Because UI animations almost always travel from <code className="bg-slate-900 px-1 rounded text-slate-300">0,0</code> to <code className="bg-slate-900 px-1 rounded text-slate-300">1,1</code>,
            <strong> P0</strong> and <strong>P3</strong> are fixed. You are only adjusting the "magnetic attraction" of the control points <strong>P1</strong> and <strong>P2</strong>.
          </p>
        </div>

        {/* Current CSS Value & Presets */}
        <div className="bg-slate-800 p-5 rounded-2xl border border-slate-700 shadow-xl">
          <h3 className="text-slate-300 font-semibold mb-3">CSS Equivalent</h3>

          <code className="block bg-slate-900 p-4 rounded-xl text-indigo-300 border border-slate-700 shadow-inner mb-6 text-center text-lg">
            cubic-bezier({bezierString})
          </code>

          <h3 className="text-slate-300 font-semibold mb-3">Easing Presets</h3>
          <div className="flex flex-col gap-2">
            {presets.map((preset) => (
              <button
                key={preset.name}
                onClick={() => {
                  setP1(preset.p1);
                  setP2(preset.p2);
                }}
                className="text-left bg-slate-700 hover:bg-slate-600 transition-colors p-3 rounded-lg flex justify-between items-center text-sm"
              >
                <span className="font-medium text-slate-200">{preset.name}</span>
                <span className="text-slate-400 font-mono text-xs">
                  {preset.p1.MathX.toFixed(2)}, {preset.p1.MathY.toFixed(2)}, {preset.p2.MathX.toFixed(2)}, {preset.p2.MathY.toFixed(2)}
                </span>
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};

export default App;
```

### How Cubic Bézier Curves Work In Animation:

1. **The Grid Space**: The horizontal X-axis represents **time** (from `0%` to `100%`). The vertical Y-axis represents the state of your **animation progression** (e.g., position, scale, opacity).
2. **Fixed Anchor Points**: In CSS easing, `P0` is firmly planted at `(0, 0)` which is the start, and `P3` is at `(1, 1)` which is your final animated state.
3. **Magnetic Control Points (`P1` and `P2`)**: These dictate the velocity of the curve.
    * Dragging `P1` to the right means time passes, but vertical progress stays near 0. This creates an **"Ease In"** (starting slow).
    * Dragging `P2` way above `1` on the Y-axis causes the animation to go past 100% before coming back down, creating a **"Bounce"** or **overshoot** effect.
4. **The Parameter `t`**: You can think of *t* in the formula as a tiny car driving from 0 to 1 point-by-point. The complex polynomial blends calculate the exact track coordinates based strictly on the four points you've established.
