export const diagnosticsSource = `      const replaceBrokenImage = (image) => {
        if (!image || image.dataset.streamuiImageFailed === "true") {
          return;
        }
        image.dataset.streamuiImageFailed = "true";
        const fallback = document.createElement("div");
        fallback.className = "streamui-image-fallback";
        fallback.setAttribute("role", "img");
        const alt = (image.getAttribute("alt") || "").trim();
        fallback.setAttribute("aria-label", alt || "Image unavailable");
        fallback.textContent = alt ? "Image unavailable - " + alt : "Image unavailable";
        const width = Number(image.getAttribute("width"));
        const height = Number(image.getAttribute("height"));
        if (width > 0 && height > 0) {
          fallback.style.aspectRatio = String(width) + " / " + String(height);
        }
        image.replaceWith(fallback);
        scheduleMeasure();
      };
      window.addEventListener("error", (event) => {
        if (event.target instanceof HTMLImageElement) {
          replaceBrokenImage(event.target);
          return;
        }
        if (isExtensionNoise(event.message, event.filename)) {
          return;
        }
        const detail =
          event.error && (event.error.stack || event.error.message)
            ? String(event.error.stack || event.error.message)
            : "";
        const message =
          detail && (!event.message || event.message === "Script error.")
            ? detail
            : event.message;
        post("runtime", message, { filename: event.filename || "" });
      }, true);
      window.addEventListener("unhandledrejection", (event) => {
        const reason =
          event.reason && (event.reason.stack || event.reason.message)
            ? event.reason.stack || event.reason.message
            : event.reason;
        if (isExtensionNoise(reason || "")) {
          return;
        }
        post("runtime", reason || "Unhandled promise rejection");
      });
      const originalError = console.error;
      console.error = (...args) => {
        const message = args.map(String).join(" ");
        if (!isExtensionNoise(message)) {
          post("console", message);
        }
        originalError.apply(console, args);
      };
      const refreshSelectionUi = () => {
        if (selectionHoverTarget) {
          updateSelectionHover(selectionHoverTarget);
        }
        renderSelectedSelectionTargets();
        renderBusySelectionTargets();
        updateTextSelectionToolbar();
      };
      const scheduleSelectionUiRefresh = () => {
        requestAnimationFrame(refreshSelectionUi);
      };
      window.addEventListener("load", scheduleMeasure);
      window.addEventListener("resize", scheduleMeasure);
      window.addEventListener("load", scheduleMathTypeset);
      window.addEventListener("load", scheduleSelectionUiRefresh);
      window.addEventListener("resize", scheduleSelectionUiRefresh);
      document.addEventListener("scroll", scheduleSelectionUiRefresh, true);
      document.addEventListener("toggle", scheduleMeasure, true);
      document.addEventListener("transitionend", scheduleMeasure, true);
      document.addEventListener("animationend", scheduleMeasure, true);
      document.addEventListener("transitionend", scheduleSelectionUiRefresh, true);
      document.addEventListener("animationend", scheduleSelectionUiRefresh, true);
      const resizeObserver = new ResizeObserver(scheduleMeasure);
      const observeBody = () => {
        if (document.body) {
          resizeObserver.observe(document.body);
        }
      };
      resizeObserver.observe(document.documentElement);
      observeBody();
      window.addEventListener("load", observeBody);
      new MutationObserver(() => {
        scheduleMathTypeset();
        scheduleMeasure();
      }).observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
      });
      scheduleMathTypeset();
      scheduleMeasure();
    })();
`;
