(() => {
    "use strict";

    const tabs = Array.from(document.querySelectorAll(".course-switcher-tab[role='tab']"));
    const panels = Array.from(document.querySelectorAll(".course-panel[role='tabpanel']"));

    if (tabs.length !== 2 || panels.length !== 2) return;

    const activateTab = (tab, { focus = false, updateHash = true } = {}) => {
        tabs.forEach((item) => {
            const isActive = item === tab;
            item.setAttribute("aria-selected", String(isActive));
            item.tabIndex = isActive ? 0 : -1;
        });

        panels.forEach((panel) => {
            panel.hidden = panel.id !== tab.getAttribute("aria-controls");
        });

        if (focus) tab.focus();

        if (updateHash) {
            const nextUrl = tab.id === "previous-courses-tab"
                ? `${window.location.pathname}${window.location.search}#tidligere-fag`
                : `${window.location.pathname}${window.location.search}`;
            window.history.replaceState(null, "", nextUrl);
        }
    };

    const activateFromHash = () => {
        const target = window.location.hash === "#tidligere-fag"
            ? document.getElementById("previous-courses-tab")
            : document.getElementById("active-courses-tab");
        if (target) activateTab(target, { updateHash: false });
    };

    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => activateTab(tab));
        tab.addEventListener("keydown", (event) => {
            let nextIndex = null;

            if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === "Home") nextIndex = 0;
            if (event.key === "End") nextIndex = tabs.length - 1;

            if (nextIndex === null) return;
            event.preventDefault();
            activateTab(tabs[nextIndex], { focus: true });
        });
    });

    window.addEventListener("hashchange", activateFromHash);
    activateFromHash();
})();
