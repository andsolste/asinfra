(() => {
    "use strict";

    const courseMap = document.querySelector("[data-course-map]");
    const currentWeekLink = document.querySelector("[data-current-week]");

    if (!courseMap || !currentWeekLink) return;

    const getIsoWeek = (date) => {
        const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const day = utcDate.getUTCDay() || 7;
        utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
        const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
        return {
            year: utcDate.getUTCFullYear(),
            week: Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7)
        };
    };

    const termYear = Number(courseMap.dataset.termYear);
    const firstWeek = Number(courseMap.dataset.weekStart);
    const lastWeek = Number(courseMap.dataset.weekEnd);
    const current = getIsoWeek(new Date());

    if (current.year !== termYear || current.week < firstWeek || current.week > lastWeek) return;

    const rows = [...document.querySelectorAll(`[data-week="${current.week}"]`)];
    if (!rows.length) return;

    rows.forEach((row) => row.classList.add("is-current"));

    const topics = rows
        .map((row) => row.querySelector("th")?.textContent.trim())
        .filter(Boolean);

    currentWeekLink.textContent = `Uke ${current.week} · ${topics.join(" / ")}`;
    currentWeekLink.hidden = false;
})();
