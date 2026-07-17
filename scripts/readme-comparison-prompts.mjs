const galleryImageInputs = `Use these Wikimedia Commons image inputs and credits:
- Evo III (1995), Charles from Port Chester, New York, CC BY 2.0: https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Mitsubishi_Lancer_Evolution_III_%281995%29_%2853619429931%29.jpg/1280px-Mitsubishi_Lancer_Evolution_III_%281995%29_%2853619429931%29.jpg
- Evo VI (1999–2001), Motoring Weapon R, CC BY-SA 3.0: https://upload.wikimedia.org/wikipedia/commons/d/d3/Mitsubishi_Lancer_Evolution_VI.jpg
- Evo IX (2005–2007), FotoSleuth, CC BY 2.0: https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/Mitsubishi_Lancer_Evolution_IX_%2831677018768%29.jpg/1280px-Mitsubishi_Lancer_Evolution_IX_%2831677018768%29.jpg
- Evo X (2007–2016), IFCAR, public domain: https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Mitsubishi_Lancer_EVO_X.jpg/1280px-Mitsubishi_Lancer_EVO_X.jpg`;

export const README_COMPARISON_EXAMPLES = [
  {
    slug: "pomodoro-clock",
    markdownImageHeight: 824,
    prompt:
      "Build a working Pomodoro clock set to 25:00. Include Start/Pause, Reset, skip, Focus/Short Break/Long Break modes, four session progress dots, and a compact task field. Use a bold analog-inspired countdown with subtle motion and keyboard hints. Keep it polished and focused; no web search."
  },
  {
    slug: "lancer-evolution-gallery",
    markdownImageHeight: 822,
    prompt: `Create a compact editorial gallery titled “Evolution / I–X” celebrating the Mitsubishi Lancer Evolution. Keep the complete 2-by-2 gallery, filters, captions, and credits visible within a single viewport. Use the four provided Wikimedia Commons images and load every image eagerly. Show model generation, year, photographer, and license on each card, with filters for III, VI, IX, and X and a click-to-expand lightbox. Do not imply endorsement; no web search.

${galleryImageInputs}`
  },
  {
    slug: "game-2048",
    markdownImageHeight: 588,
    prompt:
      "Build a playable 2048 mini-game with arrow-key and swipe controls, score and best counters, a new game button, and a clear visual hierarchy. The initial HTML itself must contain all 16 visible board cells and a plausible mid-game seed with the values 2, 4, 8, 16, 32, 64, and 128; JavaScript may take over for moves after load. Do not access browser storage; keep the best score only in memory for the current artifact. Keep it compact and polished; no web search."
  },
  {
    slug: "poster-studio",
    markdownImageHeight: 647,
    prompt:
      "Build an interactive typographic poster studio. Show a bold live poster preview with the editable headline “MOVE / WITH / INTENT”, controls for palette, type scale, grain, alignment, and a shuffle button. Use only CSS shapes and typography; no external assets. Make it editorial, expressive, and polished; no web search."
  },
  {
    slug: "bezier-playground",
    markdownImageHeight: 944,
    prompt:
      "Teach me how cubic Bezier curves work. Build an interactive playground with a large curve, adjustable control points, the formula, and three named easing presets. Keep it focused and polished; no web search."
  },
  {
    slug: "split-calculator",
    markdownImageHeight: 809,
    prompt:
      "Build a tip and split calculator for a EUR 186.50 dinner shared by 4 people. Include editable bill, tip, and party-size controls, update totals live, and show the calculation clearly. Keep it compact and polished; no web search."
  },
  {
    slug: "request-pipeline",
    markdownImageHeight: 628,
    prompt:
      "Explain what happens after I type https://example.com into a browser and press Enter. Make an annotated, animated-looking pipeline from DNS through TCP and TLS, HTTP, and rendering, with controls to step through each stage. No web search."
  },
  {
    slug: "color-lab",
    markdownImageHeight: 634,
    prompt:
      "Build an accessible color palette lab. Include HSL sliders, five live swatches with hex values, a foreground/background contrast checker, and AA/AAA status badges. Make it vivid, compact, and polished; no web search."
  }
];
