```jsx
import React, { useState, useEffect } from 'react';

const PALETTES = [
  { id: 'brutal', name: 'Brutal', bg: '#09090b', text: '#fafafa', accent: '#fbbf24', shape: '#27272a' },
  { id: 'swiss', name: 'Swiss', bg: '#ef4444', text: '#ffffff', accent: '#000000', shape: '#991b1b' },
  { id: 'print', name: 'Print', bg: '#ecead8', text: '#1c1917', accent: '#ea580c', shape: '#d6d3d1' },
  { id: 'yves', name: 'Klein', bg: '#002fa7', text: '#ffffff', accent: '#facc15', shape: '#1e3a8a' },
  { id: 'mono', name: 'Mono', bg: '#ffffff', text: '#000000', accent: '#a3a3a3', shape: '#e5e5e5' },
];

const ALIGNMENTS = [
  { id: 'flex-start', name: 'Left', css: 'items-start text-left' },
  { id: 'center', name: 'Center', css: 'items-center text-center' },
  { id: 'flex-end', name: 'Right', css: 'items-end text-right' },
];

// Pure CSS Icons for alignment
const AlignIcon = ({ type, isActive }) => {
  const lines = {
    'flex-start': ['w-full', 'w-3/4', 'w-5/6'],
    'center': ['w-3/4 mx-auto', 'w-full', 'w-5/6 mx-auto'],
    'flex-end': ['w-3/4 ml-auto', 'w-full ml-auto', 'w-5/6 ml-auto'],
  }[type];

  return (
    <div className={`flex flex-col gap-[3px] w-5 h-5 justify-center transition-colors ${isActive ? 'text-white' : 'text-zinc-500'}`}>
      {lines.map((c, i) => <div key={i} className={`h-[2px] bg-current rounded-full ${c}`} />)}
    </div>
  );
};

export default function PosterStudio() {
  const [text, setText] = useState("MOVE\nWITH\nINTENT");
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [scale, setScale] = useState(12); // Base cqw size
  const [grain, setGrain] = useState(0.4);
  const [alignIdx, setAlignIdx] = useState(0);

  const activePalette = PALETTES[paletteIdx];
  const activeAlign = ALIGNMENTS[alignIdx];

  const handleShuffle = () => {
    setPaletteIdx(Math.floor(Math.random() * PALETTES.length));
    setAlignIdx(Math.floor(Math.random() * ALIGNMENTS.length));
    setScale(Math.floor(Math.random() * 8) + 8); // 8 to 15
    setGrain(Math.random() * 0.8 + 0.1);
  };

  // SVG Data URI for noise
  const noiseSVG = `data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E`;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 font-sans p-4 md:p-8 flex flex-col items-center justify-center selection:bg-zinc-800">

      {/* App Header */}
      <div className="w-full max-w-6xl flex justify-between items-end mb-8 border-b border-zinc-800 pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Postera</h1>
          <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mt-1">Interactive Typographic Studio</p>
        </div>
        <button
          onClick={handleShuffle}
          className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest hover:text-white transition-colors group"
        >
          <span className="w-2 h-2 rounded-full bg-zinc-700 group-hover:bg-white transition-colors animate-pulse"></span>
          Shuffle state
        </button>
      </div>

      <div className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">

        {/* Left: Live Preview (Poster) */}
        <div className="lg:col-span-7 xl:col-span-8 flex justify-center">
          {/* Aspect ratio container with Container Queries (@container) */}
          <div className="w-full max-w-[600px] aspect-[3/4] @container relative overflow-hidden shadow-2xl ring-1 ring-white/10 rounded-sm">

            {/* Background & Transitions */}
            <div
              className="absolute inset-0 transition-colors duration-700 ease-in-out"
              style={{ backgroundColor: activePalette.bg }}
            >

              {/* CSS Geometric Shapes */}
              <div
                className="absolute -top-[10%] -right-[10%] w-[50%] h-[50%] rounded-full mix-blend-multiply opacity-50 transition-colors duration-700 ease-in-out blur-3xl"
                style={{ backgroundColor: activePalette.shape }}
              />
              <div
                className="absolute top-[20%] -left-[5%] w-[30%] h-[2px] transition-colors duration-700 ease-in-out"
                style={{ backgroundColor: activePalette.accent }}
              />
              <div
                className="absolute bottom-[10%] right-[10%] w-[10%] h-[10%] rounded-sm transition-colors duration-700 ease-in-out transform rotate-12"
                style={{ backgroundColor: activePalette.shape }}
              />

              {/* Grain Overlay */}
              <div
                className="absolute inset-0 pointer-events-none mix-blend-overlay transition-opacity duration-300"
                style={{ opacity: grain, backgroundImage: `url("${noiseSVG}")` }}
              />

              {/* Typography Layout */}
              <div className="absolute inset-0 p-[8cqw] flex flex-col justify-between z-10">

                {/* Meta Header */}
                <div
                  className="flex justify-between font-mono text-[2.5cqw] uppercase tracking-widest transition-colors duration-700"
                  style={{ color: activePalette.accent }}
                >
                  <span>Vol. {String(paletteIdx + 1).padStart(2, '0')}</span>
                  <span>{activePalette.name} Ed.</span>
                </div>

                {/* Main Headline */}
                <div
                  className={`flex flex-col whitespace-pre-line ${activeAlign.css} w-full transition-all duration-500 ease-out`}
                >
                  {text.split('\n').map((line, i) => (
                    <span
                      key={i}
                      className="font-black leading-[0.82] tracking-tighter uppercase break-words w-full"
                      style={{
                        fontSize: `${scale}cqw`,
                        color: activePalette.text,
                        transition: 'color 700ms ease-in-out, font-size 500ms cubic-bezier(0.4, 0, 0.2, 1)'
                      }}
                    >
                      {line || '\u00A0'}
                    </span>
                  ))}
                </div>

                {/* Meta Footer */}
                <div
                  className="font-sans font-bold text-[3cqw] uppercase tracking-widest transition-colors duration-700 border-t pt-4"
                  style={{ color: activePalette.text, borderColor: activePalette.shape }}
                >
                  Explorations in Form & Structure
                </div>
              </div>

            </div>
          </div>
        </div>

        {/* Right: Studio Controls */}
        <div className="lg:col-span-5 xl:col-span-4 bg-zinc-900/50 rounded-xl p-6 border border-zinc-800/50 backdrop-blur-sm flex flex-col gap-8">

          {/* Input */}
          <div className="flex flex-col gap-3">
            <label className="text-xs font-mono uppercase tracking-widest text-zinc-500">Headline</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 text-white font-black uppercase text-xl leading-snug resize-none focus:outline-none focus:border-zinc-600 transition-colors"
              rows={4}
              placeholder="Enter text..."
            />
          </div>

          {/* Palette */}
          <div className="flex flex-col gap-3">
            <label className="text-xs font-mono uppercase tracking-widest text-zinc-500">Color System</label>
            <div className="grid grid-cols-5 gap-2">
              {PALETTES.map((p, idx) => (
                <button
                  key={p.id}
                  onClick={() => setPaletteIdx(idx)}
                  className={`h-10 rounded-md border-2 transition-all group flex items-center justify-center overflow-hidden ${paletteIdx === idx ? 'border-white scale-105 shadow-lg' : 'border-transparent hover:border-zinc-700'}`}
                  style={{ backgroundColor: p.bg }}
                  title={p.name}
                >
                  <div className="w-1/2 h-full" style={{ backgroundColor: p.bg }}></div>
                  <div className="w-1/2 h-full" style={{ backgroundColor: p.text }}></div>
                </button>
              ))}
            </div>
          </div>

          {/* Alignment */}
          <div className="flex flex-col gap-3">
            <label className="text-xs font-mono uppercase tracking-widest text-zinc-500">Structure</label>
            <div className="flex bg-zinc-950 rounded-lg p-1 border border-zinc-800">
              {ALIGNMENTS.map((align, idx) => (
                <button
                  key={align.id}
                  onClick={() => setAlignIdx(idx)}
                  className={`flex-1 flex items-center justify-center py-2 rounded-md transition-colors ${alignIdx === idx ? 'bg-zinc-800 shadow-sm' : 'hover:bg-zinc-900'}`}
                  title={align.name}
                >
                  <AlignIcon type={align.id} isActive={alignIdx === idx} />
                </button>
              ))}
            </div>
          </div>

          {/* Scale */}
          <div className="flex flex-col gap-3">
            <div className="flex justify-between">
              <label className="text-xs font-mono uppercase tracking-widest text-zinc-500">Type Scale</label>
              <span className="text-xs font-mono text-zinc-400">{scale}vw</span>
            </div>
            <input
              type="range"
              min="6"
              max="18"
              step="0.5"
              value={scale}
              onChange={(e) => setScale(parseFloat(e.target.value))}
              className="w-full accent-white h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Grain */}
          <div className="flex flex-col gap-3">
            <div className="flex justify-between">
              <label className="text-xs font-mono uppercase tracking-widest text-zinc-500">Print Texture</label>
              <span className="text-xs font-mono text-zinc-400">{Math.round(grain * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={grain}
              onChange={(e) => setGrain(parseFloat(e.target.value))}
              className="w-full accent-white h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
            />
          </div>

        </div>
      </div>
    </div>
  );
}
```
