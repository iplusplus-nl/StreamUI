```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Evolution / I–X</title>
  <style>
    :root {
      --bg-color: #0a0a0a;
      --text-main: #f5f5f5;
      --text-sub: #a0a0a0;
      --accent: #d32f2f;
      --border-radius: 4px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: "Helvetica Neue", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-main);
      height: 100vh;
      overflow: hidden; /* Forces single viewport */
      display: flex;
      flex-direction: column;
      padding: 2vh 2vw;
    }

    /* Header & Navigation */
    header {
      text-align: center;
      flex-shrink: 0;
      margin-bottom: 2vh;
    }

    h1 {
      font-weight: 800;
      font-size: clamp(1.2rem, 3vh, 2rem);
      letter-spacing: 0.15em;
      text-transform: uppercase;
      margin-bottom: 0.5vh;
    }

    .disclaimer {
      font-size: clamp(0.55rem, 1.2vh, 0.75rem);
      color: var(--text-sub);
      margin-bottom: 1.5vh;
      font-weight: 300;
      font-style: italic;
    }

    .filters {
      display: flex;
      justify-content: center;
      gap: 1vw;
    }

    .filters button {
      background: transparent;
      border: 1px solid var(--text-sub);
      color: var(--text-sub);
      padding: 0.5vh 1vw;
      font-size: clamp(0.7rem, 1.5vh, 0.9rem);
      border-radius: 20px;
      cursor: pointer;
      transition: all 0.3s ease;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .filters button:hover,
    .filters button.active {
      background: var(--text-main);
      color: var(--bg-color);
      border-color: var(--text-main);
    }

    /* 2x2 Gallery Grid */
    .gallery {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-rows: repeat(2, minmax(0, 1fr));
      gap: 1.5vmin;
      flex-grow: 1;
      height: 100%;
      min-height: 0; /* Ensures grid doesn't overflow flex container */
    }

    .card {
      position: relative;
      border-radius: var(--border-radius);
      overflow: hidden;
      cursor: pointer;
      display: flex;
    }

    /* Used via JS to hide filtered out elements while keeping structural integrity if needed */
    .card.hidden {
      display: none;
    }

    .card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.4s ease;
    }

    .card:hover img {
      transform: scale(1.03);
    }

    figcaption {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      padding: clamp(8px, 1.5vh, 16px) clamp(10px, 2vw, 20px);
      display: flex;
      flex-direction: column;
      gap: 0.3vh;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      pointer-events: none;
    }

    .model-gen {
      font-size: clamp(0.8rem, 1.8vh, 1.1rem);
      font-weight: 600;
      color: var(--text-main);
      letter-spacing: 0.05em;
    }

    .credits {
      font-size: clamp(0.6rem, 1.3vh, 0.8rem);
      font-weight: 400;
      color: var(--text-sub);
    }

    /* Lightbox Overlay */
    .lightbox {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.95);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
    }

    .lightbox.active {
      opacity: 1;
      pointer-events: all;
    }

    .lightbox img {
      max-width: 90vw;
      max-height: 80vh;
      object-fit: contain;
      border-radius: var(--border-radius);
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }

    .lightbox-caption {
      margin-top: 2vh;
      text-align: center;
      color: var(--text-main);
    }

    .lightbox-caption .model-gen {
      font-size: 1.2rem;
      margin-bottom: 0.5vh;
    }

    .lightbox-caption .credits {
      font-size: 0.9rem;
    }

    .close-btn {
      position: absolute;
      top: 3vh;
      right: 3vw;
      background: transparent;
      color: #fff;
      border: 1px solid #fff;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      font-size: 1.5rem;
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: pointer;
      transition: background 0.2s, color 0.2s;
    }

    .close-btn:hover {
      background: #fff;
      color: #000;
    }
  </style>
</head>
<body>

  <header>
    <h1>Evolution / I–X</h1>
    <p class="disclaimer">Editorial Gallery: This material is for informational purposes and is not affiliated with or endorsed by Mitsubishi Motors.</p>
    <nav class="filters" aria-label="Gallery Filters">
      <button data-filter="all" class="active">All Generations</button>
      <button data-filter="iii">Evo III</button>
      <button data-filter="vi">Evo VI</button>
      <button data-filter="ix">Evo IX</button>
      <button data-filter="x">Evo X</button>
    </nav>
  </header>

  <main class="gallery" id="gallery">
    <!-- Evo III -->
    <figure class="card" data-category="iii" onclick="openLightbox(this)">
      <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/Mitsubishi_Lancer_Evolution_III_%281995%29_%2853619429931%29.jpg/1280px-Mitsubishi_Lancer_Evolution_III_%281995%29_%2853619429931%29.jpg" alt="Mitsubishi Lancer Evolution III" loading="eager">
      <figcaption>
        <span class="model-gen">Evolution III (1995)</span>
        <span class="credits">Photo: Charles from Port Chester, New York | License: CC BY 2.0</span>
      </figcaption>
    </figure>

    <!-- Evo VI -->
    <figure class="card" data-category="vi" onclick="openLightbox(this)">
      <img src="https://upload.wikimedia.org/wikipedia/commons/d/d3/Mitsubishi_Lancer_Evolution_VI.jpg" alt="Mitsubishi Lancer Evolution VI" loading="eager">
      <figcaption>
        <span class="model-gen">Evolution VI (1999–2001)</span>
        <span class="credits">Photo: Motoring Weapon R | License: CC BY-SA 3.0</span>
      </figcaption>
    </figure>

    <!-- Evo IX -->
    <figure class="card" data-category="ix" onclick="openLightbox(this)">
      <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/Mitsubishi_Lancer_Evolution_IX_%2831677018768%29.jpg/1280px-Mitsubishi_Lancer_Evolution_IX_%2831677018768%29.jpg" alt="Mitsubishi Lancer Evolution IX" loading="eager">
      <figcaption>
        <span class="model-gen">Evolution IX (2005–2007)</span>
        <span class="credits">Photo: FotoSleuth | License: CC BY 2.0</span>
      </figcaption>
    </figure>

    <!-- Evo X -->
    <figure class="card" data-category="x" onclick="openLightbox(this)">
      <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Mitsubishi_Lancer_EVO_X.jpg/1280px-Mitsubishi_Lancer_EVO_X.jpg" alt="Mitsubishi Lancer Evolution X" loading="eager">
      <figcaption>
        <span class="model-gen">Evolution X (2007–2016)</span>
        <span class="credits">Photo: IFCAR | License: Public Domain</span>
      </figcaption>
    </figure>
  </main>

  <div class="lightbox" id="lightbox">
    <button class="close-btn" aria-label="Close Lightbox" onclick="closeLightbox()">&times;</button>
    <img id="lightbox-img" src="" alt="">
    <div class="lightbox-caption" id="lightbox-caption"></div>
  </div>

  <script>
    // Filtering Logic
    const filterButtons = document.querySelectorAll('.filters button');
    const cards = document.querySelectorAll('.card');

    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        // Reset active state
        filterButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const filterVal = btn.getAttribute('data-filter');

        // Apply filter
        cards.forEach(card => {
          if (filterVal === 'all' || card.getAttribute('data-category') === filterVal) {
            card.classList.remove('hidden');
          } else {
            card.classList.add('hidden');
          }
        });
      });
    });

    // Lightbox Logic
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxCaption = document.getElementById('lightbox-caption');

    function openLightbox(cardElement) {
      const img = cardElement.querySelector('img');
      const caption = cardElement.querySelector('figcaption');

      lightboxImg.src = img.src;
      lightboxImg.alt = img.alt;
      lightboxCaption.innerHTML = caption.innerHTML;

      lightbox.classList.add('active');
    }

    function closeLightbox() {
      lightbox.classList.remove('active');
      // Delay source clearing slightly to allow fade out transition
      setTimeout(() => {
        if (!lightbox.classList.contains('active')) {
          lightboxImg.src = '';
          lightboxCaption.innerHTML = '';
        }
      }, 300);
    }

    // Close lightbox on outer background click
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) {
        closeLightbox();
      }
    });

    // Close lightbox on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('active')) {
        closeLightbox();
      }
    });
  </script>
</body>
</html>
```
