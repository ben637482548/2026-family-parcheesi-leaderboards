(() => {
  "use strict";

  const PLAYERS = Object.freeze(["Ben", "Andrew", "Nathan", "Mom", "Dad"]);
  const HISTORY_PREVIEW_COUNT = 8;
  const FETCH_TIMEOUT_MS = 12_000;
  const PLACEHOLDER_URL = "PASTE_YOUR_PUBLISHED_CSV_URL_HERE";

  const HEADER_ALIASES = Object.freeze({
    date: ["date", "week", "gamedate", "weekdate"],
    winner: ["winner", "winningplayer"],
    nathanPlayed: ["nathanplayed", "nathanplay", "nathanattendance", "didnathanplay"],
    notes: ["notes", "note", "comments", "comment"]
  });

  const state = {
    games: [],
    issues: [],
    selectedYear: null,
    showAllHistory: false,
    fetchedAt: null,
    source: "live"
  };

  const elements = {};

  function normalizeHeader(value) {
    return String(value ?? "")
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  /**
   * RFC-4180-style CSV parser with support for quoted commas, escaped quotes,
   * embedded line breaks, CRLF, LF, and a UTF-8 byte-order mark.
   */
  function parseCsv(text) {
    if (typeof text !== "string") {
      throw new TypeError("CSV input must be text.");
    }

    const source = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];

      if (inQuotes) {
        if (character === '"') {
          if (source[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += character;
        }
        continue;
      }

      if (character === '"' && field.length === 0) {
        inQuotes = true;
      } else if (character === ",") {
        row.push(field);
        field = "";
      } else if (character === "\n" || character === "\r") {
        if (character === "\r" && source[index + 1] === "\n") {
          index += 1;
        }
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }

    if (inQuotes) {
      throw new Error("The CSV contains an unclosed quoted field.");
    }

    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows;
  }

  function findHeaderIndex(headers, aliases, required = true) {
    const normalizedHeaders = headers.map(normalizeHeader);
    const index = normalizedHeaders.findIndex((header) => aliases.includes(header));

    if (required && index === -1) {
      throw new Error(`Missing required column: ${aliases[0]}`);
    }

    return index;
  }

  function parseDateValue(rawValue) {
    const value = String(rawValue ?? "").trim();
    if (!value) return null;

    let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      return buildLocalDate(Number(match[1]), Number(match[2]), Number(match[3]), value);
    }

    match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
      return buildLocalDate(Number(match[3]), Number(match[1]), Number(match[2]), value);
    }

    match = value.match(/^(\d{4})-W(\d{1,2})$/i);
    if (match) {
      const year = Number(match[1]);
      const week = Number(match[2]);
      if (week < 1 || week > 53) return null;
      const date = saturdayOfIsoWeek(year, week);
      return { date, year, raw: value, isWeekLabel: true };
    }

    return null;
  }

  function buildLocalDate(year, month, day, raw) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return { date, year, raw, isWeekLabel: false };
  }

  function saturdayOfIsoWeek(year, week) {
    const januaryFourth = new Date(year, 0, 4, 12, 0, 0, 0);
    const dayNumber = januaryFourth.getDay() || 7;
    const monday = new Date(januaryFourth);
    monday.setDate(januaryFourth.getDate() - dayNumber + 1 + (week - 1) * 7);
    const saturday = new Date(monday);
    saturday.setDate(monday.getDate() + 5);
    return saturday;
  }

  function canonicalPlayer(rawValue) {
    const normalized = String(rawValue ?? "").trim().toLowerCase();
    return PLAYERS.find((player) => player.toLowerCase() === normalized) ?? null;
  }

  function parseNathanPlayed(rawValue, winner) {
    const normalized = String(rawValue ?? "").trim().toLowerCase();

    if (!normalized) {
      // Friendly default for old rows: the normal weekly game includes Nathan.
      return true;
    }

    if (["yes", "y", "true", "1", "played", "present"].includes(normalized)) {
      return true;
    }

    if (["no", "n", "false", "0", "absent", "did not play", "didnt play"].includes(normalized)) {
      return false;
    }

    return null;
  }

  function normalizeRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("The published CSV is empty.");
    }

    const headerRowIndex = rows.findIndex((row) =>
      row.some((cell) => HEADER_ALIASES.winner.includes(normalizeHeader(cell)))
    );

    if (headerRowIndex === -1) {
      throw new Error("Could not find the header row. Add Date, Winner, NathanPlayed, and Notes.");
    }

    const headers = rows[headerRowIndex];
    const indexes = {
      date: findHeaderIndex(headers, HEADER_ALIASES.date),
      winner: findHeaderIndex(headers, HEADER_ALIASES.winner),
      nathanPlayed: findHeaderIndex(headers, HEADER_ALIASES.nathanPlayed),
      notes: findHeaderIndex(headers, HEADER_ALIASES.notes, false)
    };

    const games = [];
    const issues = [];

    rows.slice(headerRowIndex + 1).forEach((row, offset) => {
      const sheetRow = headerRowIndex + offset + 2;
      const cells = row.map((cell) => String(cell ?? "").trim());
      if (cells.every((cell) => cell === "")) return;

      const dateInfo = parseDateValue(cells[indexes.date]);
      const winner = canonicalPlayer(cells[indexes.winner]);
      const nathanPlayed = parseNathanPlayed(cells[indexes.nathanPlayed], winner);
      const notes = indexes.notes === -1 ? "" : cells[indexes.notes];

      if (!dateInfo) {
        issues.push({ row: sheetRow, reason: "Date must be YYYY-MM-DD, M/D/YYYY, or YYYY-W##." });
        return;
      }

      if (!winner) {
        issues.push({ row: sheetRow, reason: "Winner must be Ben, Andrew, Nathan, Mom, or Dad." });
        return;
      }

      if (nathanPlayed === null) {
        issues.push({ row: sheetRow, reason: "NathanPlayed must be Yes or No." });
        return;
      }

      if (winner === "Nathan" && !nathanPlayed) {
        issues.push({ row: sheetRow, reason: "Nathan cannot be the winner when NathanPlayed is No." });
        return;
      }

      games.push({
        id: `${dateInfo.raw}-${sheetRow}`,
        date: dateInfo.date,
        dateRaw: dateInfo.raw,
        year: dateInfo.year,
        winner,
        nathanPlayed,
        notes,
        sheetRow
      });
    });

    games.sort((a, b) => a.date - b.date || a.sheetRow - b.sheetRow);
    return { games, issues };
  }

  function calculateStandings(games) {
    const records = new Map(
      PLAYERS.map((player, familyOrder) => [
        player,
        { player, familyOrder, gamesPlayed: 0, wins: 0, percentage: 0 }
      ])
    );

    games.forEach((game) => {
      PLAYERS.forEach((player) => {
        if (player !== "Nathan" || game.nathanPlayed) {
          records.get(player).gamesPlayed += 1;
        }
      });
      records.get(game.winner).wins += 1;
    });

    const standings = [...records.values()].map((record) => ({
      ...record,
      percentage: record.gamesPlayed > 0 ? (record.wins / record.gamesPlayed) * 100 : 0
    }));

    standings.sort((a, b) =>
      b.percentage - a.percentage ||
      b.wins - a.wins ||
      a.familyOrder - b.familyOrder
    );

    return standings;
  }

  function formatPercentage(value) {
    return new Intl.NumberFormat(undefined, {
      style: "percent",
      maximumFractionDigits: 1
    }).format(value / 100);
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    }).format(date);
  }

  function formatCheckedTime(date) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function pluralize(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderStandings(standings) {
    elements.standingsList.replaceChildren();

    standings.forEach((record, index) => {
      const item = createElement("li", "standing-row");
      const rank = createElement("span", "rank", String(index + 1));
      rank.setAttribute("aria-label", `Rank ${index + 1}`);

      const playerBlock = createElement("div", "player-block");
      const playerName = createElement("strong", "player-name", record.player);
      const barTrack = createElement("div", "bar-track");
      barTrack.setAttribute("aria-hidden", "true");
      const barFill = createElement("div", "bar-fill");
      barFill.style.setProperty("--bar-width", `${Math.max(0, Math.min(100, record.percentage))}%`);
      barTrack.append(barFill);
      playerBlock.append(playerName, barTrack);

      const stats = createElement("div", "player-stats");
      const rate = createElement("strong", "player-rate", formatPercentage(record.percentage));
      const recordText = createElement(
        "span",
        "player-record",
        `${record.wins}W · ${record.gamesPlayed} played`
      );
      stats.append(rate, recordText);

      item.setAttribute(
        "aria-label",
        `${index + 1}. ${record.player}, ${formatPercentage(record.percentage)}, ${pluralize(record.wins, "win")}, ${pluralize(record.gamesPlayed, "game")} played.`
      );
      item.append(rank, playerBlock, stats);
      elements.standingsList.append(item);
    });
  }

  function renderLeader(standings) {
    const leader = standings[0];
    const runnerUp = standings[1];

    if (!leader || leader.gamesPlayed === 0) {
      elements.leaderName.textContent = "No games yet";
      elements.leaderRate.textContent = "—";
      elements.leaderMargin.textContent = "Add the first result in Google Sheets";
      return;
    }

    elements.leaderName.textContent = leader.player;
    elements.leaderRate.textContent = formatPercentage(leader.percentage);

    const margin = runnerUp ? leader.percentage - runnerUp.percentage : leader.percentage;
    if (runnerUp && Math.abs(margin) < 0.0001) {
      elements.leaderMargin.textContent = "Tied on win percentage";
    } else {
      const formattedMargin = new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 1
      }).format(margin);
      elements.leaderMargin.textContent = `${formattedMargin} points ahead`;
    }
  }

  function renderHistory(games) {
    const newestFirst = [...games].sort((a, b) => b.date - a.date || b.sheetRow - a.sheetRow);
    const visibleGames = state.showAllHistory
      ? newestFirst
      : newestFirst.slice(0, HISTORY_PREVIEW_COUNT);

    elements.historyList.replaceChildren();

    if (visibleGames.length === 0) {
      elements.historyList.append(
        createElement("li", "empty-state", "No games have been recorded for this season yet.")
      );
    } else {
      visibleGames.forEach((game) => {
        const item = createElement("li", "history-card");
        const main = createElement("div", "history-main");
        const details = createElement("div");
        const date = createElement("div", "history-date", formatDate(game.date));
        const winner = createElement("div", "history-winner", `${game.winner} won`);
        details.append(date, winner);

        const attendance = createElement(
          "span",
          `attendance-badge${game.nathanPlayed ? "" : " absent"}`,
          game.nathanPlayed ? "Nathan played" : "Nathan absent"
        );
        main.append(details, attendance);
        item.append(main);

        if (game.notes) {
          item.append(createElement("p", "history-note", game.notes));
        }

        elements.historyList.append(item);
      });
    }

    elements.historyCount.textContent = pluralize(games.length, "game");
    const hasMore = newestFirst.length > HISTORY_PREVIEW_COUNT;
    elements.showMoreButton.hidden = !hasMore;
    elements.showMoreButton.textContent = state.showAllHistory
      ? "Show recent games only"
      : `Show all ${newestFirst.length} games`;
  }

  function renderSeason() {
    const games = state.games.filter((game) => game.year === state.selectedYear);
    const standings = calculateStandings(games);
    const latestGame = games.at(-1);

    renderLeader(standings);
    renderStandings(standings);
    renderHistory(games);

    elements.seasonSummary.textContent = pluralize(games.length, "game");
    elements.throughDate.textContent = latestGame
      ? `Through ${formatDate(latestGame.date)}`
      : `No ${state.selectedYear} results yet`;
    elements.checkedTime.textContent = state.fetchedAt
      ? `${state.source === "cache" ? "Saved data" : "Checked"} ${formatCheckedTime(state.fetchedAt)}`
      : "";
  }

  function populateSeasonSelect() {
    const years = [...new Set(state.games.map((game) => game.year))].sort((a, b) => b - a);
    elements.seasonSelect.replaceChildren();

    if (years.length === 0) {
      const currentYear = new Date().getFullYear();
      const option = new Option(String(currentYear), String(currentYear));
      elements.seasonSelect.add(option);
      elements.seasonSelect.disabled = true;
      state.selectedYear = currentYear;
      return;
    }

    years.forEach((year) => elements.seasonSelect.add(new Option(String(year), String(year))));
    state.selectedYear = years[0];
    elements.seasonSelect.value = String(state.selectedYear);
    elements.seasonSelect.disabled = years.length === 1;
  }

  function showStatus(message, kind = "warning") {
    elements.statusMessage.textContent = message;
    elements.statusMessage.dataset.kind = kind;
    elements.statusMessage.hidden = false;
  }

  function hideStatus() {
    elements.statusMessage.hidden = true;
    elements.statusMessage.textContent = "";
    delete elements.statusMessage.dataset.kind;
  }

  function renderLoadedData(parsed, fetchedAt, source) {
    state.games = parsed.games;
    state.issues = parsed.issues;
    state.fetchedAt = fetchedAt;
    state.source = source;
    state.showAllHistory = false;

    populateSeasonSelect();
    renderSeason();

    if (source === "cache") {
      showStatus("Showing saved scores because the latest Google Sheet could not be reached. Tap “Refresh scores” to try again.");
    } else if (parsed.issues.length > 0) {
      const count = parsed.issues.length;
      showStatus(`${pluralize(count, "spreadsheet row")} could not be included. Check the browser console for the row number and reason.`);
      parsed.issues.forEach((issue) => console.warn(`Parcheesi Sheet row ${issue.row}: ${issue.reason}`));
    } else {
      hideStatus();
    }
  }

  function getConfiguredUrl() {
    const value = window.PARCHEESI_CONFIG?.csvUrl;
    if (typeof value !== "string" || !value.trim() || value.trim() === PLACEHOLDER_URL) {
      return null;
    }
    return value.trim();
  }

  function buildFetchUrl(configuredUrl) {
    const url = new URL(configuredUrl, window.location.href);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error("The CSV URL must begin with https:// or http://.");
    }
    url.searchParams.set("_parcheesi_refresh", String(Date.now()));
    return url.toString();
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function cacheKey(url) {
    return `parcheesi-scores-v1-${hashString(url)}`;
  }

  function saveCache(url, csvText, fetchedAt) {
    try {
      localStorage.setItem(
        cacheKey(url),
        JSON.stringify({ csvText, fetchedAt: fetchedAt.toISOString() })
      );
    } catch (error) {
      console.info("Parcheesi scores could not be saved locally.", error);
    }
  }

  function readCache(url) {
    try {
      const raw = localStorage.getItem(cacheKey(url));
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (typeof cached.csvText !== "string" || !cached.fetchedAt) return null;
      const fetchedAt = new Date(cached.fetchedAt);
      if (Number.isNaN(fetchedAt.getTime())) return null;
      return { csvText: cached.csvText, fetchedAt };
    } catch (error) {
      console.info("Saved Parcheesi scores could not be read.", error);
      return null;
    }
  }

  async function fetchCsv(configuredUrl) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(buildFetchUrl(configuredUrl), {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
        headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" }
      });

      if (!response.ok) {
        throw new Error(`Google Sheets returned HTTP ${response.status}.`);
      }

      const csvText = await response.text();
      if (!csvText.trim()) {
        throw new Error("Google Sheets returned an empty file.");
      }
      return csvText;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function loadScores() {
    const configuredUrl = getConfiguredUrl();
    elements.retryButton.disabled = true;
    elements.retryButton.textContent = "Refreshing…";

    if (!configuredUrl) {
      const currentYear = new Date().getFullYear();
      state.games = [];
      state.issues = [];
      state.selectedYear = currentYear;
      state.fetchedAt = null;
      populateSeasonSelect();
      renderSeason();
      showStatus("Setup needed: paste your published Google Sheets CSV URL into config.js, then refresh this page.", "error");
      elements.retryButton.disabled = false;
      elements.retryButton.textContent = "Refresh scores";
      return;
    }

    try {
      const csvText = await fetchCsv(configuredUrl);
      const parsed = normalizeRows(parseCsv(csvText));
      const fetchedAt = new Date();
      saveCache(configuredUrl, csvText, fetchedAt);
      renderLoadedData(parsed, fetchedAt, "live");
    } catch (error) {
      console.error("Unable to load the latest Parcheesi scores.", error);
      const cached = readCache(configuredUrl);

      if (cached) {
        try {
          const parsed = normalizeRows(parseCsv(cached.csvText));
          renderLoadedData(parsed, cached.fetchedAt, "cache");
        } catch (cacheError) {
          console.error("The saved Parcheesi data was also invalid.", cacheError);
          showStatus("Unable to load the latest scores. Check the connection and published Sheet URL, then try again.", "error");
        }
      } else {
        showStatus("Unable to load the latest scores. Check the connection and published Sheet URL, then try again.", "error");
      }
    } finally {
      elements.retryButton.disabled = false;
      elements.retryButton.textContent = "Refresh scores";
    }
  }

  function bindElements() {
    Object.assign(elements, {
      seasonSelect: document.getElementById("season-select"),
      seasonSummary: document.getElementById("season-summary"),
      leaderName: document.getElementById("leader-name"),
      leaderRate: document.getElementById("leader-rate"),
      leaderMargin: document.getElementById("leader-margin"),
      standingsList: document.getElementById("standings-list"),
      throughDate: document.getElementById("through-date"),
      checkedTime: document.getElementById("checked-time"),
      statusMessage: document.getElementById("status-message"),
      historyList: document.getElementById("history-list"),
      historyCount: document.getElementById("history-count"),
      showMoreButton: document.getElementById("show-more-button"),
      retryButton: document.getElementById("retry-button")
    });
  }

  function bindEvents() {
    elements.seasonSelect.addEventListener("change", () => {
      state.selectedYear = Number(elements.seasonSelect.value);
      state.showAllHistory = false;
      renderSeason();
    });

    elements.showMoreButton.addEventListener("click", () => {
      state.showAllHistory = !state.showAllHistory;
      const games = state.games.filter((game) => game.year === state.selectedYear);
      renderHistory(games);
    });

    elements.retryButton.addEventListener("click", loadScores);
  }

  function initialize() {
    bindElements();
    bindEvents();
    loadScores();
  }

  // Expose pure functions for transparent local testing and future maintenance.
  window.ParcheesiScores = Object.freeze({
    parseCsv,
    normalizeRows,
    calculateStandings,
    parseDateValue,
    canonicalPlayer,
    parseNathanPlayed
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
