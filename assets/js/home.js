// Decorative homepage-only motion. The photo travels at 20% of document scroll.
(() => {
    const scene = document.querySelector(".home-scene");
    if (!scene) return;

    const enabled = window.matchMedia("(min-width: 821px) and (prefers-reduced-motion: no-preference)");
    let sceneHeight = 0;
    let frame = null;
    let lastOffset = null;

    const render = () => {
        frame = null;
        // Compensate 80% of normal scrolling. The clipped, fixed-in-scene overlay
        // still protects text contrast and fades the photo into the page.
        const offset = Math.min(Math.max(0, window.scrollY), sceneHeight) * 0.8;
        if (offset === lastOffset) return;
        scene.style.setProperty("--home-parallax-offset", `${offset}px`);
        lastOffset = offset;
    };
    const schedule = () => {
        if (frame === null) frame = requestAnimationFrame(render);
    };
    const measure = () => {
        sceneHeight = scene.offsetHeight;
        schedule();
    };
    const configure = () => {
        window.removeEventListener("scroll", schedule);
        window.removeEventListener("resize", measure);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        lastOffset = null;
        scene.style.removeProperty("--home-parallax-offset");
        scene.classList.toggle("is-parallax", enabled.matches);
        if (!enabled.matches) return;

        measure();
        window.addEventListener("scroll", schedule, { passive: true });
        window.addEventListener("resize", measure);
    };

    enabled.addEventListener("change", configure);
    configure();
})();
