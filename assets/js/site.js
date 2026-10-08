(() => {
    const root = document.documentElement;
    const sidebar = document.getElementById("site-sidebar");
    const sidebarToggle = document.getElementById("sidebar-toggle");
    const mobileMenuButton = document.getElementById("mobile-menu-button");
    const scrim = document.getElementById("sidebar-scrim");
    const pageShell = document.getElementById("page-shell");
    const sidebarNavigation = document.getElementById("primary-navigation");
    const mobileViewport = window.matchMedia("(max-width: 820px)");
    const siteScript = document.currentScript || Array.from(document.scripts).find((script) => /\/assets\/js\/site\.js(?:[?#]|$)/.test(script.src));

    if (!sidebar || !sidebarToggle || !mobileMenuButton || !scrim || !pageShell || !sidebarNavigation || !siteScript) {
        return;
    }

    const siteRoot = new URL("../../", siteScript.src);
    // A 404 base element resolves assets, but skip links must stay on the current URL.
    const skipLink = document.querySelector('.skip-link[href^="#"]');
    if (document.querySelector("base") && skipLink) {
        const skipTarget = new URL(window.location.href);
        skipTarget.hash = skipLink.getAttribute("href");
        skipLink.href = skipTarget.href;
    }
    const searchIndexUrl = new URL("assets/data/search-index.json", siteRoot);
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const shortcutLabel = isMac ? "⌘ K" : "Ctrl K";
    let menuReturnFocusTo = null;
    let searchReturnFocusTo = null;
    let searchEntries = [];
    let searchState = "loading";
    let visibleResults = [];
    let activeResultIndex = -1;

    const isMobile = () => mobileViewport.matches;
    const collapseStorageKey = "sidebar-collapsed";
    let desktopCollapsed = false;

    try {
        desktopCollapsed = localStorage.getItem(collapseStorageKey) === "true";
    } catch {
        // Navigation remains usable when browser storage is unavailable.
    }

    root.classList.add("sidebar-restoring");
    root.classList.toggle("sidebar-collapsed", !isMobile() && desktopCollapsed);

    const currentPath = window.location.pathname.toLowerCase();
    const relativePath = currentPath.startsWith(siteRoot.pathname.toLowerCase())
        ? currentPath.slice(siteRoot.pathname.length)
        : "";
    const activeSection = /^(about)(\/|$)/.test(relativePath) ? "about"
        : /^(projects)(\/|$)/.test(relativePath) ? "projects"
        : /^(education)(\/|$)/.test(relativePath) ? "fag"
        : /^(apps)(\/|$)/.test(relativePath) ? "apps"
        : null;
    const navigationPaths = {
        about: "about/",
        projects: "projects/",
        fag: "education/",
        apps: "apps/"
    };

    const brandLink = sidebar.querySelector("a.sidebar-brand");
    if (brandLink) brandLink.href = siteRoot.href;

    sidebarNavigation.querySelectorAll("[data-nav-section]").forEach((link) => {
        const section = link.dataset.navSection;
        if (!navigationPaths[section]) return;
        link.href = new URL(navigationPaths[section], siteRoot).href;
        link.removeAttribute("aria-current");
        if (section === activeSection) link.setAttribute("aria-current", "page");
    });

    const updateControls = () => {
        if (isMobile()) {
            const isOpen = root.classList.contains("sidebar-open");
            mobileMenuButton.setAttribute("aria-expanded", String(isOpen));
            sidebarToggle.setAttribute("aria-expanded", String(isOpen));
            sidebarToggle.setAttribute("aria-label", "Lukk meny");
            sidebarToggle.title = "Lukk meny";
            return;
        }

        const isExpanded = !root.classList.contains("sidebar-collapsed");
        sidebarToggle.setAttribute("aria-expanded", String(isExpanded));
        sidebarToggle.setAttribute("aria-label", isExpanded ? "Fold sammen meny" : "Fold ut meny");
        sidebarToggle.title = isExpanded ? "Fold sammen meny" : "Fold ut meny";
        mobileMenuButton.setAttribute("aria-expanded", "false");
    };

    const openMobileMenu = () => {
        if (!isMobile()) return;
        menuReturnFocusTo = document.activeElement;
        root.classList.add("sidebar-open");
        scrim.hidden = false;
        pageShell.setAttribute("inert", "");
        updateControls();
        requestAnimationFrame(() => sidebarToggle.focus());
    };

    const closeMobileMenu = (restoreFocus = true) => {
        root.classList.remove("sidebar-open");
        scrim.hidden = true;
        pageShell.removeAttribute("inert");
        updateControls();

        if (restoreFocus && menuReturnFocusTo instanceof HTMLElement) {
            menuReturnFocusTo.focus();
        }

        menuReturnFocusTo = null;
    };

    sidebarToggle.addEventListener("click", () => {
        if (isMobile()) {
            closeMobileMenu();
            return;
        }

        desktopCollapsed = !desktopCollapsed;
        root.classList.toggle("sidebar-collapsed", desktopCollapsed);
        try {
            localStorage.setItem(collapseStorageKey, String(desktopCollapsed));
        } catch {
            // Keep the in-memory preference for this page.
        }
        updateControls();
    });

    mobileMenuButton.addEventListener("click", openMobileMenu);
    scrim.addEventListener("click", () => closeMobileMenu());

    const activeSubjects = [
        {
            code: "DCST2001",
            label: "Nettverk",
            name: "Sammenkoblede nettverk og nettverkssikkerhet",
            slug: "dcst2001"
        },
        {
            code: "EXPH0300",
            label: "Exphil",
            name: "Examen philosophicum for naturvitenskap og teknologi",
            slug: "exph0300"
        },
        {
            code: "IDATT2202",
            label: "Operativsystemer",
            name: "Operativsystemer",
            slug: "idatt2202"
        },
        {
            code: "IT2810",
            label: "Webutvikling",
            name: "Webutvikling",
            slug: "it2810"
        }
    ];
    const subjectNavigation = document.createElement("nav");
    const subjectLabel = document.createElement("p");
    const subjectList = document.createElement("ul");

    subjectNavigation.className = "sidebar-subjects";
    subjectNavigation.setAttribute("aria-labelledby", "active-subjects-label");
    subjectLabel.className = "sidebar-subjects-label";
    subjectLabel.id = "active-subjects-label";
    subjectLabel.textContent = "Aktive fag";
    subjectList.className = "sidebar-subjects-list";

    activeSubjects.forEach((subject) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        const subjectDirectory = new URL(`education/active/${subject.slug}/`, siteRoot);

        link.className = "sidebar-subjects-link";
        link.href = subjectDirectory.href;
        link.textContent = subject.label;
        link.setAttribute("aria-label", `${subject.code} – ${subject.name}`);
        link.title = `${subject.code} – ${subject.name}`;

        if (currentPath === subjectDirectory.pathname.slice(0, -1).toLowerCase()
            || currentPath.startsWith(subjectDirectory.pathname.toLowerCase())) {
            link.setAttribute("aria-current", "location");
        }

        item.append(link);
        subjectList.append(item);
    });

    subjectNavigation.append(subjectLabel, subjectList);
    sidebarNavigation.after(subjectNavigation);

    sidebar.querySelectorAll("a").forEach((link) => {
        link.addEventListener("click", () => {
            if (isMobile()) closeMobileMenu(false);
        });
    });

    const searchControl = document.createElement("div");
    searchControl.className = "sidebar-search";
    searchControl.innerHTML = `
        <button class="sidebar-search-button" id="site-search-button" type="button" aria-haspopup="dialog" aria-controls="site-search-overlay" aria-expanded="false" title="Søk på nettsiden (${shortcutLabel})">
            <span class="sidebar-search-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><circle cx="10.75" cy="10.75" r="6.25"></circle><path d="m15.5 15.5 4.25 4.25"></path></svg>
            </span>
            <span class="sidebar-search-label">Søk</span>
            <kbd class="sidebar-search-shortcut">${shortcutLabel}</kbd>
        </button>
    `;
    sidebarNavigation.before(searchControl);

    const searchOverlay = document.createElement("div");
    searchOverlay.className = "search-overlay";
    searchOverlay.id = "site-search-overlay";
    searchOverlay.hidden = true;
    searchOverlay.innerHTML = `
        <section class="search-dialog" role="dialog" aria-modal="true" aria-labelledby="site-search-title">
            <h2 class="search-visually-hidden" id="site-search-title">Søk på nettsiden</h2>
            <div class="search-input-row">
                <span class="search-input-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><circle cx="10.75" cy="10.75" r="6.25"></circle><path d="m15.5 15.5 4.25 4.25"></path></svg>
                </span>
                <label class="search-visually-hidden" for="site-search-input">Søk på nettsiden</label>
                <input id="site-search-input" class="search-input" type="search" role="combobox" aria-autocomplete="list" aria-controls="site-search-results" aria-describedby="site-search-summary" aria-expanded="false" autocomplete="off" spellcheck="false" placeholder="Søk på nettsiden…">
                <button class="search-close-button" type="button" aria-label="Lukk søk" title="Lukk søk">
                    <span class="search-close-key">Esc</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>
                </button>
            </div>
            <div class="search-results-shell">
                <p class="search-summary" id="site-search-summary" aria-live="polite"></p>
                <ul class="search-results" id="site-search-results" role="listbox" aria-label="Søkeresultater"></ul>
                <p class="search-empty" hidden></p>
            </div>
            <footer class="search-footer" aria-hidden="true">
                <span><kbd>↑</kbd><kbd>↓</kbd> velg</span>
                <span><kbd>Enter</kbd> åpne</span>
                <span><kbd>Esc</kbd> lukk</span>
            </footer>
        </section>
    `;
    document.body.append(searchOverlay);

    const searchButton = document.getElementById("site-search-button");
    const searchInput = document.getElementById("site-search-input");
    const searchResults = document.getElementById("site-search-results");
    const searchSummary = document.getElementById("site-search-summary");
    const searchEmpty = searchOverlay.querySelector(".search-empty");
    const searchCloseButton = searchOverlay.querySelector(".search-close-button");

    const normalize = (value) => String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("nb-NO")
        .replace(/æ/g, "ae")
        .replace(/ø/g, "o")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    const prepareEntry = (entry) => {
        const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
        return {
            ...entry,
            keywords,
            normalized: {
                title: normalize(entry.title),
                code: normalize(entry.code),
                context: normalize(entry.context),
                description: normalize(entry.description),
                keywords: keywords.map(normalize)
            }
        };
    };

    const indexPromise = fetch(searchIndexUrl, { credentials: "same-origin", cache: "no-cache" })
        .then((response) => {
            if (!response.ok) throw new Error(`Search index returned ${response.status}`);
            return response.json();
        })
        .then((data) => {
            if (!data || !Array.isArray(data.entries)) throw new Error("Invalid search index");
            searchEntries = data.entries
                .filter((entry) => entry && entry.title && entry.type && entry.url)
                .map(prepareEntry);
            searchState = "ready";
        })
        .catch(() => {
            searchState = "error";
        });

    const wordsMatch = (field, token) => field.split(" ").some((word) => {
        if (word === token) return true;
        if (word.length < 4 || token.length < 4) return false;
        return word.startsWith(token) || token.startsWith(word);
    });

    const resolveEntryUrl = (path) => {
        const resolved = new URL(path, siteRoot);
        const staysInsideSite = resolved.origin === siteRoot.origin && resolved.pathname.startsWith(siteRoot.pathname);
        return staysInsideSite ? resolved.href : siteRoot.href;
    };

    const scoreEntry = (entry, query) => {
        const fields = entry.normalized;
        const tokens = query.split(" ").filter(Boolean);
        const chapterMatch = query.match(/^chapters?\s+(\d+)$/);
        let score = 0;

        if (query.length === 1) {
            const titleWordMatch = fields.title.split(" ").includes(query);
            const keywordWordMatch = fields.keywords.some(keyword => keyword.split(" ").includes(query));
            if (!titleWordMatch && fields.code !== query && !keywordWordMatch) return null;
            if (titleWordMatch) score += 700;
            if (fields.code === query) score += 650;
            if (keywordWordMatch) score += 500;
            if (entry.type === "Tema") score += 50;
            return score + Number(entry.priority || 0);
        }

        if (chapterMatch) {
            const chapterNumber = chapterMatch[1];
            const chapterText = [fields.title, fields.context, fields.description, ...fields.keywords].join(" ");
            const hasRequestedChapter = chapterText.includes("chapter " + chapterNumber)
                || chapterText.includes("chapters " + chapterNumber);
            if (!hasRequestedChapter) return null;
        }

        if (fields.title === query) score += 1600;
        else if (fields.title.startsWith(query)) score += 900;
        else if (fields.title.includes(query)) score += 650;

        if (fields.code === query) {
            score += 1500;
            if (entry.type === "Fag") score += 250;
        } else if (fields.code.startsWith(query) && query.length > 2) {
            score += 700;
        }

        if (fields.keywords.some((keyword) => keyword === query)) score += 520;
        else if (fields.keywords.some((keyword) => keyword.includes(query))) score += 300;
        if (fields.context.includes(query)) score += 180;
        if (fields.description.includes(query)) score += 100;

        for (const token of tokens) {
            let tokenScore = 0;

            if (fields.title.split(" ").includes(token)) tokenScore = Math.max(tokenScore, 260);
            else if (fields.title.includes(token)) tokenScore = Math.max(tokenScore, 190);
            else if (wordsMatch(fields.title, token)) tokenScore = Math.max(tokenScore, 130);

            if (fields.code === token) tokenScore = Math.max(tokenScore, 240);
            else if (fields.code.includes(token)) tokenScore = Math.max(tokenScore, 170);

            if (fields.keywords.some((keyword) => keyword === token)) tokenScore = Math.max(tokenScore, 180);
            else if (fields.keywords.some((keyword) => wordsMatch(keyword, token))) tokenScore = Math.max(tokenScore, 130);

            if (fields.context.includes(token) || wordsMatch(fields.context, token)) tokenScore = Math.max(tokenScore, 90);
            if (fields.description.includes(token) || wordsMatch(fields.description, token)) tokenScore = Math.max(tokenScore, 55);

            if (!tokenScore) return null;
            score += tokenScore;
        }

        score += Number(entry.priority || 0);
        return score;
    };

    const setActiveResult = (index, scrollIntoView = true) => {
        const resultLinks = Array.from(searchResults.querySelectorAll(".search-result"));

        if (!resultLinks.length) {
            activeResultIndex = -1;
            searchInput.removeAttribute("aria-activedescendant");
            return;
        }

        activeResultIndex = (index + resultLinks.length) % resultLinks.length;
        resultLinks.forEach((link, resultIndex) => {
            const isActive = resultIndex === activeResultIndex;
            link.classList.toggle("is-active", isActive);
            link.setAttribute("aria-selected", String(isActive));
        });

        const activeLink = resultLinks[activeResultIndex];
        searchInput.setAttribute("aria-activedescendant", activeLink.id);
        if (scrollIntoView) activeLink.scrollIntoView({ block: "nearest" });
    };

    const createResult = (entry, index) => {
        const item = document.createElement("li");
        item.className = "search-result-item";

        const link = document.createElement("a");
        link.className = "search-result";
        link.id = `site-search-result-${index}`;
        link.href = resolveEntryUrl(entry.url);
        link.setAttribute("role", "option");
        link.setAttribute("aria-selected", "false");
        link.tabIndex = -1;

        const metadata = document.createElement("span");
        metadata.className = "search-result-metadata";

        const type = document.createElement("span");
        type.className = "search-result-type";
        type.textContent = entry.type;
        metadata.append(type);

        if (entry.context) {
            const context = document.createElement("span");
            context.className = "search-result-context";
            context.textContent = entry.context;
            metadata.append(context);
        }

        const title = document.createElement("span");
        title.className = "search-result-title";
        title.textContent = entry.title;

        const description = document.createElement("span");
        description.className = "search-result-description";
        description.textContent = entry.description || "";

        link.append(metadata, title);
        if (entry.description) link.append(description);

        link.addEventListener("mouseenter", () => setActiveResult(index, false));
        link.addEventListener("click", () => closeSearch(false));
        item.append(link);
        return item;
    };

    const renderResults = () => {
        searchResults.replaceChildren();
        searchEmpty.hidden = true;
        searchEmpty.textContent = "";

        if (searchState === "loading") {
            visibleResults = [];
            searchSummary.textContent = "Laster søk…";
            setActiveResult(-1);
            return;
        }

        if (searchState === "error") {
            visibleResults = [];
            searchSummary.textContent = "";
            searchEmpty.textContent = "Søket kunne ikke lastes akkurat nå.";
            searchEmpty.hidden = false;
            setActiveResult(-1);
            return;
        }

        const rawQuery = searchInput.value.trim();
        const query = normalize(rawQuery);

        if (!query) {
            visibleResults = searchEntries
                .filter((entry) => entry.featured)
                .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
                .slice(0, 4);
            searchSummary.textContent = "Snarveier";
        } else {
            const ranked = searchEntries
                .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
                .filter((result) => result.score !== null)
                .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, "nb"));

            visibleResults = ranked.slice(0, 10).map((result) => result.entry);

            if (!visibleResults.length) {
                searchSummary.textContent = "";
                searchEmpty.textContent = `Ingen treff på «${rawQuery}»`;
                searchEmpty.hidden = false;
                setActiveResult(-1);
                return;
            }

            searchSummary.textContent = ranked.length > 10 ? `Viser 10 av ${ranked.length} treff` : `${ranked.length} treff`;
        }

        const fragment = document.createDocumentFragment();
        visibleResults.forEach((entry, index) => fragment.append(createResult(entry, index)));
        searchResults.append(fragment);
        setActiveResult(0, false);
    };

    const openSearch = () => {
        if (root.classList.contains("search-open")) return;

        const activeElement = document.activeElement;
        searchReturnFocusTo = isMobile()
            ? mobileMenuButton
            : activeElement instanceof HTMLElement && activeElement !== document.body
                ? activeElement
                : searchButton;

        if (root.classList.contains("sidebar-open")) closeMobileMenu(false);

        searchOverlay.hidden = false;
        root.classList.add("search-open");
        sidebar.setAttribute("inert", "");
        pageShell.setAttribute("inert", "");
        searchButton.setAttribute("aria-expanded", "true");
        searchInput.setAttribute("aria-expanded", "true");
        searchInput.value = "";
        renderResults();

        requestAnimationFrame(() => {
            searchInput.focus();
            searchInput.select();
        });

        indexPromise.then(() => {
            if (root.classList.contains("search-open")) renderResults();
        });
    };

    function closeSearch(restoreFocus = true) {
        if (!root.classList.contains("search-open")) return;

        root.classList.remove("search-open");
        searchOverlay.hidden = true;
        sidebar.removeAttribute("inert");
        pageShell.removeAttribute("inert");
        searchButton.setAttribute("aria-expanded", "false");
        searchInput.setAttribute("aria-expanded", "false");
        searchInput.removeAttribute("aria-activedescendant");
        visibleResults = [];
        activeResultIndex = -1;

        if (restoreFocus && searchReturnFocusTo instanceof HTMLElement && searchReturnFocusTo.isConnected) {
            searchReturnFocusTo.focus();
        }

        searchReturnFocusTo = null;
    }

    const activateSelectedResult = () => {
        const selected = searchResults.querySelector(".search-result.is-active");
        if (selected instanceof HTMLAnchorElement) selected.click();
    };

    searchButton.addEventListener("click", openSearch);
    searchCloseButton.addEventListener("click", () => closeSearch());
    searchOverlay.addEventListener("click", (event) => {
        if (event.target === searchOverlay) closeSearch();
    });
    searchInput.addEventListener("input", renderResults);
    searchInput.addEventListener("keydown", (event) => {
        if (event.isComposing) return;

        if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveResult(activeResultIndex + 1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveResult(activeResultIndex - 1);
        } else if (event.key === "Enter") {
            event.preventDefault();
            activateSelectedResult();
        }
    });

    document.addEventListener("keydown", (event) => {
        const isSearchShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";

        if (isSearchShortcut) {
            event.preventDefault();
            if (event.repeat) return;
            root.classList.contains("search-open") ? closeSearch() : openSearch();
            return;
        }

        if (event.key === "Escape") {
            if (root.classList.contains("search-open")) {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
            } else if (root.classList.contains("sidebar-open")) {
                closeMobileMenu();
            }
            return;
        }

        if (event.key === "Tab" && root.classList.contains("search-open")) {
            const focusable = [searchInput, searchCloseButton];
            const currentIndex = focusable.indexOf(document.activeElement);

            if (event.shiftKey && currentIndex <= 0) {
                event.preventDefault();
                searchCloseButton.focus();
            } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
                event.preventDefault();
                searchInput.focus();
            }
        }
    });

    const resetResponsiveState = () => {
        root.classList.toggle("sidebar-collapsed", !isMobile() && desktopCollapsed);
        root.classList.remove("sidebar-open");
        scrim.hidden = true;
        pageShell.removeAttribute("inert");
        menuReturnFocusTo = null;
        updateControls();

        if (root.classList.contains("search-open")) {
            sidebar.setAttribute("inert", "");
            pageShell.setAttribute("inert", "");
        }
    };

    if (typeof mobileViewport.addEventListener === "function") {
        mobileViewport.addEventListener("change", resetResponsiveState);
    } else {
        mobileViewport.addListener(resetResponsiveState);
    }

    resetResponsiveState();
    // Commit the restored layout without animating from the default width.
    sidebar.getBoundingClientRect();
    root.classList.remove("sidebar-restoring");
})();

