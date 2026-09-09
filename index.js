/* index.js */
/* Frontend Controller for the Slovenian Sea Level Tracker */

// App State
let chartMode = 'level'; // 'level' or 'temp'
let periodHours = 24;   // 24, 72, or 168
let actualData = [];    // Loaded ARSO measurements
let currentChart = null; // Highcharts instance
let meteoForecastMap = new Map(); // Open-Meteo hourly pressure and wind map
let openMeteoHourlyForecast = []; // Global variable to store hourly forecast items
let activeHourlyDayOffset = null; // Track which day's hourly forecast is currently open
let arsoForecastData = null; // Currently active raw ARSO JSON forecast
let arsoForecastDataPortoroz = null; // Stored ARSO forecast for Portorož / Lucija
let arsoForecastDataPiran = null; // Stored ARSO forecast for Piran
let openMeteoDailyData = null; // Global variable to store daily Open-Meteo forecast fallback
let activeWeatherSource = 'portoroz'; // 'vida' or 'portoroz'
let activeMainTab = 'plimovanje';     // 'plimovanje', 'vreme', or 'navigacija'
let gpsWatchId = null;                // Geolocation watch ID
let lastGpsHeading = null;            // Last valid GPS heading
let weatherDataVida = null;       // Cached weather data from Vida buoy
let weatherDataPortoroz = null;   // Cached weather data from Portorož Airport
let currentMarineWaveHeight = null; // Cached current wave height from Open-Meteo forecast
let marineHourlyWaves = new Map();  // Map of timestamp (ms) -> wave height (m)
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbxoILNm85D58iHTxfbE8J_BawhREfiv2q1bUHSED_GqPT2LhUSyFxXjSXEx4cyk9eT8/exec';

// Datum offset constant (Srednja gladina morja / Mean sea level - SVS2010 reference datum is 217.0 cm above gauge zero)
const MEAN_SEA_LEVEL_OFFSET = 217.0;

let deferredPrompt = null;

// Helper to parse ISO strings without timezone (e.g. "2026-09-04T14:00") as exact local device time
function parseIsoLocal(isoStr) {
    if (!isoStr) return new Date();
    if (isoStr instanceof Date) return isoStr;
    const str = String(isoStr).trim();
    if (str.endsWith('Z') || str.includes('+') || (str.lastIndexOf('-') > 7)) {
        return new Date(str);
    }
    const parts = str.split(/[T\s]/);
    if (parts.length >= 2) {
        const dParts = parts[0].split('-').map(Number);
        const tParts = parts[1].split(':').map(Number);
        if (dParts.length === 3 && tParts.length >= 2) {
            return new Date(dParts[0], dParts[1] - 1, dParts[2], tParts[0], tParts[1], tParts[2] || 0);
        }
    }
    return new Date(str);
}

// Helper: Official Douglas Sea Scale
function getDouglasSeaState(heightM) {
    if (heightM === null || heightM === undefined || isNaN(heightM)) {
        return { code: null, text: "--", label: "--" };
    }
    const h = parseFloat(heightM);
    if (h < 0.05) return { code: 0, text: "Mirno morje", label: "Mirno (0)" };
    if (h <= 0.1) return { code: 1, text: "Mirno z zibanjem", label: "Mirno z zibanjem (1)" };
    if (h <= 0.5) return { code: 2, text: "Rahlo vzvalovano", label: "Rahlo vzvalovano (2)" };
    if (h <= 1.25) return { code: 3, text: "Zmerno vzvalovano", label: "Zmerno vzvalovano (3)" };
    if (h <= 2.5) return { code: 4, text: "Vzvalovano morje", label: "Vzvalovano (4)" };
    if (h <= 4.0) return { code: 5, text: "Močno vzvalovano", label: "Močno vzvalovano (5)" };
    if (h <= 6.0) return { code: 6, text: "Zelo močno vzvalovano", label: "Zelo močno vzvalovano (6)" };
    if (h <= 9.0) return { code: 7, text: "Visoko valovito", label: "Visoko valovito (7)" };
    if (h <= 14.0) return { code: 8, text: "Zelo visoko valovito", label: "Zelo visoko valovito (8)" };
    return { code: 9, text: "Izjemno valovito", label: "Izjemno valovito (9)" };
}

// Helper: Option A wave symbol and height
function getWaveIconHtml(heightM) {
    if (heightM === null || heightM === undefined || isNaN(heightM)) {
        return `<span style="color:var(--text-secondary);font-size:0.7rem;">--</span>`;
    }
    const h = parseFloat(heightM);
    if (h <= 0.5) {
        return `<span style="display:inline-flex;align-items:center;gap:3px;color:#22c55e;font-size:0.72rem;font-weight:600;" title="Rahlo vzvalovano (${h.toFixed(2)} m)">
            <svg style="width:13px;height:8px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;" viewBox="0 0 24 12"><path d="M0 6 Q6 0, 12 6 T24 6"/></svg>
            ${h.toFixed(2)} m
        </span>`;
    } else if (h <= 1.25) {
        return `<span style="display:inline-flex;align-items:center;gap:3px;color:#38bdf8;font-size:0.72rem;font-weight:600;" title="Zmerno vzvalovano (${h.toFixed(2)} m)">
            <svg style="width:13px;height:10px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;" viewBox="0 0 24 16"><path d="M0 5 Q6 0, 12 5 T24 5 M0 11 Q6 6, 12 11 T24 11"/></svg>
            ${h.toFixed(2)} m
        </span>`;
    } else if (h <= 2.5) {
        return `<span style="display:inline-flex;align-items:center;gap:3px;color:#f59e0b;font-size:0.72rem;font-weight:600;" title="Vzvalovano (${h.toFixed(2)} m)">
            <svg style="width:13px;height:12px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;" viewBox="0 0 24 20"><path d="M0 4 Q6 -2, 12 4 T24 4 M0 10 Q6 4, 12 10 T24 10 M0 16 Q6 10, 12 16 T24 16"/></svg>
            ${h.toFixed(2)} m
        </span>`;
    } else {
        return `<span style="display:inline-flex;align-items:center;gap:3px;color:#ef4444;font-size:0.72rem;font-weight:700;" title="Močno valovito (${h.toFixed(2)} m)">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:0.65rem;"></i>
            ${h.toFixed(2)} m
        </span>`;
    }
}

// Helper: Clean Unicode wind arrow pointing in direction the wind is blowing TO
function getWindArrowUnicode(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return "";
    // deg is direction wind is blowing FROM (0 = North). Wind blows TO (deg + 180).
    const toDeg = (parseFloat(deg) + 180) % 360;
    const arrows = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
    const idx = Math.round(toDeg / 45) % 8;
    return arrows[idx];
}

// Helper: Pure HTML/CSS wave badge for chart tooltip (100% SVG-free to prevent detachment on mobile)
function getWaveTooltipHtml(heightM) {
    if (heightM === null || heightM === undefined || isNaN(heightM)) return '';
    const h = parseFloat(heightM);
    let color = '#22c55e'; // Green <= 0.5m
    let icon = 'fa-water';
    if (h > 0.5 && h <= 1.25) {
        color = '#38bdf8'; // Blue 0.5 - 1.25m
    } else if (h > 1.25 && h <= 2.5) {
        color = '#f59e0b'; // Amber 1.25 - 2.5m
    } else if (h > 2.5) {
        color = '#ef4444'; // Red > 2.5m
        icon = 'fa-triangle-exclamation';
    }
    return `<span style="display:inline-flex; align-items:center; gap:4px; color:${color}; font-weight:600;"><i class="fa-solid ${icon}" style="font-size:10px;"></i> ${h.toFixed(2)} m</span>`;
}

// Helper: Get active forecast data based on selected location tab
function getActiveForecastData() {
    return (activeWeatherSource === 'vida') ? (arsoForecastDataPiran || arsoForecastDataPortoroz) : (arsoForecastDataPortoroz || arsoForecastDataPiran);
}

// Helper: Closest hourly wave height lookup
function getWaveHeightForTime(targetDate) {
    if (!targetDate || marineHourlyWaves.size === 0) return currentMarineWaveHeight || 0.2;
    const targetMs = targetDate.getTime();
    let closestHeight = currentMarineWaveHeight || 0.2;
    let minDiff = Infinity;
    for (const [timeMs, height] of marineHourlyWaves.entries()) {
        const diff = Math.abs(timeMs - targetMs);
        if (diff < minDiff) {
            minDiff = diff;
            closestHeight = height;
        }
    }
    return closestHeight;
}

// Helper: Maximum wave height for a calendar day (for daily forecast cards)
function getDayMaxWaveHeight(targetDate) {
    if (!targetDate || marineHourlyWaves.size === 0) return currentMarineWaveHeight;
    const targetY = targetDate.getFullYear();
    const targetM = targetDate.getMonth();
    const targetD = targetDate.getDate();
    
    let maxH = 0;
    let found = false;
    
    for (const [timeMs, height] of marineHourlyWaves.entries()) {
        const d = new Date(timeMs);
        if (d.getFullYear() === targetY && d.getMonth() === targetM && d.getDate() === targetD) {
            found = true;
            if (height > maxH) {
                maxH = height;
            }
        }
    }
    return found ? maxH : currentMarineWaveHeight;
}

// Helper: Beaufort scale & Slovene descriptions
function getBeaufortInfo(windSpeedKmh) {
    const kmh = parseFloat(windSpeedKmh) || 0;
    if (kmh < 1) return { bft: 0, text: "tišina" };
    if (kmh <= 5) return { bft: 1, text: "lahka sapa" };
    if (kmh <= 11) return { bft: 2, text: "lahek vetrič" };
    if (kmh <= 19) return { bft: 3, text: "zmeren veter" };
    if (kmh <= 28) return { bft: 4, text: "zmerno močan veter" };
    if (kmh <= 38) return { bft: 5, text: "svež veter" };
    if (kmh <= 49) return { bft: 6, text: "močan veter" };
    if (kmh <= 61) return { bft: 7, text: "zelo močan veter" };
    if (kmh <= 74) return { bft: 8, text: "vihar" };
    if (kmh <= 88) return { bft: 9, text: "močan vihar" };
    if (kmh <= 102) return { bft: 10, text: "polni vihar" };
    if (kmh <= 117) return { bft: 11, text: "orkanski vihar" };
    return { bft: 12, text: "orkan" };
}

// Toggle Sea Scale Legend
function toggleSeaLegend() {
    const content = document.getElementById('sea-legend-content');
    const arrow = document.getElementById('sea-legend-arrow');
    if (!content) return;
    const isHidden = content.style.display === 'none';
    content.style.display = isHidden ? 'block' : 'none';
    if (arrow) {
        arrow.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
    }
}
window.toggleSeaLegend = toggleSeaLegend;

document.addEventListener('DOMContentLoaded', () => {
    // Configure Highcharts to use local timezone globally
    if (typeof Highcharts !== 'undefined') {
        Highcharts.setOptions({
            time: {
                useUTC: false
            },
            lang: {
                weekdays: ['Nedelja', 'Ponedeljek', 'Torek', 'Sreda', 'Četrtek', 'Petek', 'Sobota'],
                shortWeekdays: ['Ned', 'Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob'],
                months: ['Januar', 'Februar', 'Marec', 'April', 'Maj', 'Junij', 'Julij', 'Avgust', 'September', 'Oktober', 'November', 'December'],
                shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Avg', 'Sep', 'Okt', 'Nov', 'Dec']
            }
        });
    }

    // Initialize Theme (Default is light unless saved as dark)
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.classList.remove('light-theme');
    } else {
        document.body.classList.add('light-theme');
    }
    updateThemeIcon();

    // Start clock display
    updateClock();
    setInterval(updateClock, 1000);
    
    // Update moon phase
    updateMoonPhase();
    setInterval(updateMoonPhase, 3600000); // refresh moon phase every hour

    // Load meteorological data from Bazdara Firebase & ARSO
    loadWeather();
    setInterval(loadWeather, 60000); // refresh weather every minute
    
    // Load tide data
    refreshData();
    setInterval(refreshData, 300000); // refresh water data every 5 minutes

    // Load weather forecast asynchronously (does not block tide data)
    loadArsoForecast();
    setInterval(loadArsoForecast, 600000); // refresh weather forecast every 10 minutes

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js')
                .then(reg => console.log('Service Worker registered successfully!', reg))
                .catch(err => console.log('Service Worker registration failed:', err));
        });
    }
    
    // Handle PWA Install Prompt
    const installBanner = document.getElementById('pwa-install-banner');
    const installBtn = document.getElementById('pwa-install-btn');
    
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        if (installBanner) {
            installBanner.style.display = 'flex';
        }
    });
    
    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                console.log(`User response to install prompt: ${outcome}`);
                deferredPrompt = null;
                if (installBanner) {
                    installBanner.style.display = 'none';
                }
            }
        });
    }
    
    window.addEventListener('appinstalled', (evt) => {
        console.log('App was installed successfully!');
        if (installBanner) {
            installBanner.style.display = 'none';
        }
    });

    // Auto-refresh when app comes to foreground (PWA resumes)
    let lastResumeTime = Date.now();
    
    const handleForegroundResume = () => {
        const now = Date.now();
        console.log("App brought to foreground. Checking staleness...");
        // If app was backgrounded for more than 2 minutes, force reset UI to "Nalaganje..."
        if (now - lastResumeTime > 2 * 60 * 1000) {
            weatherDataVida = null;
            weatherDataPortoroz = null;
            renderWeather();
            
            // Reset water values to loading
            document.getElementById('current-level-val').textContent = "Nalaganje...";
            document.getElementById('current-temp-val').textContent = "--";
            document.getElementById('relative-level-val').textContent = "Absolutna gladina: -- cm";
            const levelTimeEl = document.getElementById('level-time-val');
            if (levelTimeEl) levelTimeEl.textContent = "Osveževanje podatkov...";
        }
        lastResumeTime = now;
        refreshData();
        loadWeather(true);
        loadArsoForecast();
        if (activeMainTab === 'navigacija') {
            startGpsNavigation();
        }
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            handleForegroundResume();
        } else {
            lastResumeTime = Date.now();
            if (activeMainTab === 'navigacija') {
                stopGpsNavigation();
            }
        }
    });

    window.addEventListener('focus', () => {
        handleForegroundResume();
    });
});

function updateClock() {
    const timeDisplay = document.getElementById('current-time-display');
    const now = new Date();
    if (timeDisplay) {
        timeDisplay.textContent = now.toLocaleString('sl-SI', { 
            weekday: 'short', 
            day: '2-digit', 
            month: '2-digit', 
            year: 'numeric',
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
    }

    if (activeMainTab === 'navigacija' || isCruiseActive) {
        updateLiveRouteTelemetry();
    }
}

function setChartMode(mode) {
    if (chartMode === mode) return;
    chartMode = mode;
    
    // Update active button
    document.getElementById('mode-level').classList.toggle('active', mode === 'level');
    document.getElementById('mode-temp').classList.toggle('active', mode === 'temp');
    
    // Re-draw chart
    renderChart();
}

function setPeriod(hours) {
    periodHours = hours;
    
    // Update active button
    document.getElementById('period-24h').classList.toggle('active', hours === 24);
    document.getElementById('period-3d').classList.toggle('active', hours === 72);
    document.getElementById('period-7d').classList.toggle('active', hours === 168);
    const btn30 = document.getElementById('period-30d');
    if (btn30) btn30.classList.toggle('active', hours === 720);
    
    if (currentChart && actualData.length > 0) {
        const latestTimeVal = actualData[actualData.length - 1].time.getTime();
        const minTime = latestTimeVal - (periodHours * 60 * 60 * 1000);
        const maxTime = chartMode === 'level' ? latestTimeVal + (periodHours * 60 * 60 * 1000) : latestTimeVal;
        currentChart.xAxis[0].setExtremes(minTime, maxTime);
    }
}

// Custom Date parser for ARSO table string "DD.MM.YYYY HH:MM"
function parseArsoDate(dateStr) {
    const parts = dateStr.split(' ');
    if (parts.length < 2) return new Date();
    
    const dParts = parts[0].split('.');
    const tParts = parts[1].split(':');
    
    if (dParts.length < 3 || tParts.length < 2) return new Date();
    
    // Date arguments: Year, Month (0-11), Day, Hour, Minute
    return new Date(dParts[2], dParts[1] - 1, dParts[0], tParts[0], tParts[1], 0);
}

// Client-side HTML table parser for fallback requests
function parseArsoHtml(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    const rows = doc.querySelectorAll('table.podatki tbody tr');
    const parsedData = [];
    
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
            const time = cells[0].textContent.trim();
            const temp = parseFloat(cells[1].textContent.trim());
            const level = parseFloat(cells[2].textContent.trim());
            if (!isNaN(temp) && !isNaN(level)) {
                parsedData.push({ time, temp, level });
            }
        }
    });
    return parsedData;
}

// Load data with triple redundancy
async function loadWaterData(arsoPeriod) {
    const cb = new Date().getTime();
    const localUrl = `/api/data?period=${arsoPeriod}&cb=${cb}`;
    const publicUrl = `https://www.arso.gov.si/vode/podatki/amp/H9350_t_${arsoPeriod}.html?cb=${cb}`;
    
    const isLocalhost = (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
    
    // Attempt 1: Local server proxy (ONLY if running on localhost to avoid 3s network timeout on live web)
    if (isLocalhost) {
        try {
            const res = await fetch(localUrl);
            if (res.ok) {
                return await res.json();
            }
        } catch (e) {
            console.log(`Local API endpoint failed for period ${arsoPeriod}, trying direct public CORS proxy...`, e);
        }
    }
    
    // Attempt 2: Google Apps Script CORS proxy (completely free and reliable, hosted on Google Cloud)
    try {
        const proxyUrl = `${PROXY_URL}?url=${encodeURIComponent(publicUrl)}`;
        const res = await fetch(proxyUrl);
        if (res.ok) {
            const html = await res.text();
            return parseArsoHtml(html);
        }
    } catch (e) {
        console.log(`Google Apps Script proxy failed for period ${arsoPeriod}, trying backup proxy...`, e);
    }
    
    // Attempt 3: Backup CORS proxy (allorigins.win)
    try {
        const backupUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(publicUrl)}`;
        const res = await fetch(backupUrl);
        if (res.ok) {
            const json = await res.json();
            return parseArsoHtml(json.contents);
        }
    } catch (e) {
        console.error(`All proxies failed to fetch ARSO data for period ${arsoPeriod}`, e);
        throw e;
    }
}

// Load and merge both 24h and 30d tables to avoid lag in the 30d history table
async function loadMergedWaterData(onFirstData) {
    // 1. Fetch 24h table first for fast initial response
    const dayDataPromise = loadWaterData("1").then(dayDataRaw => {
        const dayData = dayDataRaw.map(item => ({
            time: parseArsoDate(item.time),
            temp: item.temp,
            level: item.level
        })).sort((a, b) => a.time - b.time);
        
        if (typeof onFirstData === 'function') {
            onFirstData(dayData);
        }
        return dayData;
    });
    
    // 2. In parallel, fetch 30-day history table
    const historyDataPromise = loadWaterData("30").then(historyDataRaw => {
        return historyDataRaw.map(item => ({
            time: parseArsoDate(item.time),
            temp: item.temp,
            level: item.level
        })).sort((a, b) => a.time - b.time);
    });
    
    const [dayData, historyData] = await Promise.all([dayDataPromise, historyDataPromise]);
    
    // Interpolate hourly history data into 10-minute steps so it matches 10-minute predictions exactly
    const interpolatedHistory = [];
    for (let i = 0; i < historyData.length; i++) {
        const current = historyData[i];
        interpolatedHistory.push(current);
        
        if (i < historyData.length - 1) {
            const next = historyData[i+1];
            const timeDiffMs = next.time.getTime() - current.time.getTime();
            
            // If gap is approximately 1 hour (between 45 and 75 minutes), fill in 10-minute intervals
            if (timeDiffMs > 15 * 60 * 1000 && timeDiffMs < 90 * 60 * 1000) {
                const steps = Math.round(timeDiffMs / (10 * 60 * 1000));
                for (let step = 1; step < steps; step++) {
                    const t = current.time.getTime() + step * 10 * 60 * 1000;
                    const w = step / steps;
                    
                    const interpolatedTemp = current.temp + w * (next.temp - current.temp);
                    const interpolatedLevel = current.level + w * (next.level - current.level);
                    
                    interpolatedHistory.push({
                        time: new Date(t),
                        temp: parseFloat(interpolatedTemp.toFixed(1)),
                        level: parseFloat(interpolatedLevel.toFixed(1))
                    });
                }
            }
        }
    }
    
    // Merge data: Day data (24h) overwrites history data (30d) for same timestamp
    const mergedMap = new Map();
    
    interpolatedHistory.forEach(item => {
        mergedMap.set(item.time.getTime(), item);
    });
    
    dayData.forEach(item => {
        mergedMap.set(item.time.getTime(), item);
    });
    
    return Array.from(mergedMap.values()).sort((a, b) => a.time - b.time);
}

// Convert degrees to Slovenian wind direction abbreviation
function getWindDirectionSlo(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return "--";
    const directions = ["S", "SV", "V", "JV", "J", "JZ", "Z", "SZ"];
    // Round to closest 45 degree sector (0-360)
    const idx = Math.round(deg / 45) % 8;
    return directions[idx];
}

// Generate HTML for rotated wind arrow indicating direction the wind is blowing to
function getWindArrowHtml(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return "";
    // Rotate to point in the direction the wind is blowing to (deg + 180)
    const rotation = (parseFloat(deg) + 180) % 360;
    return `<i class="fa-solid fa-arrow-up wind-arrow" style="transform: rotate(${rotation}deg); font-size: 0.65rem; margin-right: 4px;" title="Smer vetra: ${Math.round(deg)}°"></i>`;
}

// Convert Slovenian wind direction abbreviation (S, SV, V, JV, J, JZ, Z, SZ) to degrees
function getWindDegFromSlo(dirStr) {
    if (!dirStr) return 0;
    const str = dirStr.trim().toUpperCase();
    switch (str) {
        case "S": return 0;
        case "SV": return 45;
        case "V": return 90;
        case "JV": return 135;
        case "J": return 180;
        case "JZ": return 225;
        case "Z": return 270;
        case "SZ": return 315;
        default: return 0;
    }
}

// Store ARSO forecast raw data with proxy fallbacks (to bypass ad-blockers and CORS issues)
async function fetchWeatherWithFallback(targetUrl, isXml = false) {
    const directUrl = PROXY_URL + '?url=' + encodeURIComponent(targetUrl);
    
    // Try 1: Direct fetch to Google Apps Script (fastest ~50ms)
    try {
        const res = await fetch(directUrl);
        if (res.ok) {
            if (isXml) {
                const text = await res.text();
                if (text && text.includes('<metData>')) return text;
            } else {
                const json = await res.json();
                if (json && !json.error) return json;
            }
        }
    } catch (e) {
        console.warn("Direct Google Apps Script fetch failed, trying via CORS proxy fallback...", e);
    }
    
    // Try 2: Via corsproxy.io directly to targetUrl
    try {
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
        const res = await fetch(proxyUrl);
        if (res.ok) {
            if (isXml) {
                const text = await res.text();
                if (text && text.includes('<metData>')) return text;
            } else {
                const json = await res.json();
                if (json && !json.error) return json;
            }
        }
    } catch (e) {
        console.warn("CORS proxy fallback failed, trying via AllOrigins fallback...", e);
    }
    
    // Try 3: Via allorigins directly to targetUrl
    try {
        const backupUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
        const res = await fetch(backupUrl);
        if (res.ok) {
            const wrapper = await res.json();
            if (wrapper && wrapper.contents) {
                if (isXml) {
                    if (wrapper.contents.includes('<metData>')) return wrapper.contents;
                } else {
                    const json = typeof wrapper.contents === 'string' ? JSON.parse(wrapper.contents) : wrapper.contents;
                    if (json && !json.error) return json;
                }
            }
        }
    } catch (e) {
        console.error("All weather proxy fallbacks failed", e);
    }
    return null;
}

async function fetchArsoForecastViaProxy() {
    const targetUrl = 'https://vreme.arso.gov.si/api/1.0/location/?location=Piran&format=json';
    return await fetchWeatherWithFallback(targetUrl);
}

async function fetchWaveHeight() {
    try {
        const url = 'https://marine-api.open-meteo.com/v1/marine?latitude=45.527662&longitude=13.598006&hourly=wave_height&timezone=auto';
        const response = await fetch(url);
        if (!response.ok) throw new Error("Marine API response not ok");
        const json = await response.json();
        return json;
    } catch (e) {
        console.error("Could not fetch wave height:", e);
        return null;
    }
}

function mapArsoIconToFa(nnIcon) {
    if (!nnIcon) return { icon: "fa-sun", color: "#f59e0b" };
    const name = nnIcon.toLowerCase();
    
    // Storm, snow, rain, fog
    if (name.includes("ts") || name.includes("bolt") || name.includes("thunder") || name.includes("neviht")) {
        return { icon: "fa-cloud-bolt", color: "#38bdf8" }; // cloud/rain/storm icons are blue
    }
    if (name.includes("sn") || name.includes("snow") || name.includes("flake") || name.includes("sneg")) {
        return { icon: "fa-snowflake", color: "#38bdf8" }; // snow/flake is blue
    }
    if (name.includes("shra") || name.includes("shower") || name.includes("ploh")) {
        return { icon: "fa-cloud-showers-heavy", color: "#38bdf8" }; // showers is blue
    }
    if (name.includes("ra") || name.includes("rain") || name.includes("dz") || name.includes("dež") || name.includes("ros")) {
        return { icon: "fa-cloud-rain", color: "#38bdf8" }; // rain is blue
    }
    if (name.includes("fg") || name.includes("fog") || name.includes("smog") || name.includes("megl")) {
        return { icon: "fa-smog", color: "#38bdf8" }; // fog/smog is blue
    }
    
    // Night icons
    if (name.includes("night") || name.includes("noč")) {
        if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
            return { icon: "fa-cloud", color: "#38bdf8" }; // cloud is blue
        }
        if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy")) {
            return { icon: "fa-cloud-moon", color: "#38bdf8" }; // cloud-moon is blue
        }
        return { icon: "fa-moon", color: "#f59e0b" }; // moon is yellow
    }
    
    // Day icons / defaults
    if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
        return { icon: "fa-cloud", color: "#38bdf8" }; // cloud is blue
    }
    if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy")) {
        return { icon: "fa-cloud-sun", color: "#38bdf8" }; // cloud-sun is blue
    }
    
    return { icon: "fa-sun", color: "#f59e0b" }; // sun is yellow
}

function getWeatherIconHtml(nnIcon, sizeStyle = "") {
    if (!nnIcon) nnIcon = "clear";
    const name = nnIcon.toLowerCase();
    
    // Check type of weather
    let type = "sun";
    
    if (name.includes("ts") || name.includes("bolt") || name.includes("thunder") || name.includes("neviht")) {
        type = "cloud-bolt";
    } else if (name.includes("sn") || name.includes("snow") || name.includes("flake") || name.includes("sneg")) {
        type = "snowflake";
    } else if (name.includes("shra") || name.includes("shower") || name.includes("ploh")) {
        type = "cloud-rain";
    } else if (name.includes("ra") || name.includes("rain") || name.includes("dz") || name.includes("dež") || name.includes("ros")) {
        type = "cloud-rain";
    } else if (name.includes("fg") || name.includes("fog") || name.includes("smog") || name.includes("megl")) {
        type = "smog";
    } else if (name.includes("night") || name.includes("noč")) {
        if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
            type = "cloud";
        } else if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy")) {
            type = "cloud-moon";
        } else {
            type = "moon";
        }
    } else {
        if (name.includes("overcast") || name.includes("prevcloudy") || name.includes("oblač")) {
            type = "cloud";
        } else if (name.includes("partcloudy") || name.includes("modcloudy") || name.includes("delno") || name.includes("zmerno") || name.includes("slightcloudy") || name.includes("mostclear")) {
            type = "cloud-sun";
        } else {
            type = "sun";
        }
    }

    // Return HTML depending on type
    const size = sizeStyle ? `font-size: ${sizeStyle};` : "";
    
    switch (type) {
        case "sun":
            return `<i class="fa-solid fa-sun" style="color: #f59e0b; ${size}"></i>`;
        case "moon":
            return `<i class="fa-solid fa-moon" style="color: #f59e0b; ${size}"></i>`;
        case "cloud":
            return `<i class="fa-solid fa-cloud" style="color: #38bdf8; ${size}"></i>`;
        case "snowflake":
            return `<i class="fa-solid fa-snowflake" style="color: #38bdf8; ${size}"></i>`;
        case "smog":
            return `<i class="fa-solid fa-smog" style="color: #38bdf8; ${size}"></i>`;
        case "cloud-rain":
            return `<i class="fa-solid fa-cloud-rain" style="color: #38bdf8; ${size}"></i>`;
        case "cloud-sun":
            return `<i class="fa-solid fa-cloud-sun" style="color: #f59e0b; ${size}"></i>`;
        case "cloud-moon":
            return `<i class="fa-solid fa-cloud-moon" style="color: #f59e0b; ${size}"></i>`;
        case "cloud-bolt":
            return `<i class="fa-solid fa-cloud-bolt" style="color: #38bdf8; ${size}"></i>`;
    }
}

function updateOpenMeteoFallbackCards() {
    if (!openMeteoDailyData) return;
    try {
        const daily = openMeteoDailyData;
        const dTimes = daily.time;
        
        const getIndexForDate = (dateOffset) => {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + dateOffset);
            const targetStr = targetDate.getFullYear() + '-' + 
                              String(targetDate.getMonth() + 1).padStart(2, '0') + '-' + 
                              String(targetDate.getDate()).padStart(2, '0');
            return dTimes.indexOf(targetStr);
        };
        
        const idxTomorrow = getIndexForDate(1);
        const idxDayAfter = getIndexForDate(2);
        
        const updateForecastCard = (cardPrefix, idx) => {
            if (idx !== -1) {
                const wCode = daily.weather_code[idx];
                const tempMin = daily.temperature_2m_min[idx];
                const tempMax = daily.temperature_2m_max[idx];
                const windSpeed = daily.wind_speed_10m_max[idx];
                const windDir = daily.wind_direction_10m_dominant[idx];
                
                const weatherName = wCode === 0 || wCode === 1 ? "clear" : (wCode === 2 ? "partCloudy" : "overcast");
                const windArrow = getWindArrowHtml(windDir);
                
                const iconBox = document.getElementById(`${cardPrefix}-icon-box`);
                if (iconBox) {
                    iconBox.innerHTML = getWeatherIconHtml(weatherName, "1.5rem");
                }
                
                const tempEl = document.getElementById(`${cardPrefix}-temp`);
                if (tempEl) {
                    tempEl.textContent = `${Math.round(tempMin)} / ${Math.round(tempMax)} °C`;
                }
                
                const windEl = document.getElementById(`${cardPrefix}-wind`);
                if (windEl) {
                    const windDirStr = getWindDirectionSlo(windDir);
                    windEl.innerHTML = `${windArrow}${Math.round(windSpeed)} km/h (${windDirStr})`;
                }
            }
        };
        
        const idxToday = getIndexForDate(0);
        if (idxToday !== -1) {
            const wCode = daily.weather_code[idxToday];
            const weatherName = wCode === 0 || wCode === 1 ? "clear" : (wCode === 2 ? "partCloudy" : "overcast");
            const todayIconBox = document.getElementById('weather-icon-box');
            if (todayIconBox) {
                todayIconBox.innerHTML = getWeatherIconHtml(weatherName, "1.8rem");
            }
        }
        
        updateForecastCard('forecast-day-1', idxTomorrow);
        updateForecastCard('forecast-day-2', idxDayAfter);
    } catch (fallbackErr) {
        console.error("Error populating Open-Meteo fallback cards:", fallbackErr);
    }
}

async function loadArsoForecast() {
    try {
        // Fetch both Portorož and Piran ARSO JSON forecasts and Marine wave height in parallel
        const [portorozJson, piranJson, marineJson] = await Promise.all([
            fetchWeatherWithFallback('https://vreme.arso.gov.si/api/1.0/location/?location=Lucija&format=json'),
            fetchWeatherWithFallback('https://vreme.arso.gov.si/api/1.0/location/?location=Piran&format=json'),
            fetchWaveHeight()
        ]);
        
        if (portorozJson) arsoForecastDataPortoroz = portorozJson;
        if (piranJson) arsoForecastDataPiran = piranJson;
        arsoForecastData = getActiveForecastData();
        
        // Update wave height data & populate hourly marine map
        if (marineJson && marineJson.hourly) {
            try {
                marineHourlyWaves.clear();
                const now = new Date();
                const timeMs = now.getTime();
                let closestIdx = 0;
                let minDiff = Infinity;
                
                for (let i = 0; i < marineJson.hourly.time.length; i++) {
                    const itemTime = parseIsoLocal(marineJson.hourly.time[i]);
                    const whVal = marineJson.hourly.wave_height[i];
                    marineHourlyWaves.set(itemTime.getTime(), whVal);
                    
                    const diff = Math.abs(itemTime.getTime() - timeMs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = i;
                    }
                }
                
                const wh = marineJson.hourly.wave_height[closestIdx];
                currentMarineWaveHeight = wh;
                renderWeather(); // Update weather UI with new wave height if necessary
            } catch (whErr) {
                console.error("Error setting wave height from forecast:", whErr);
            }
        }
        
        renderArsoForecast();
        if (actualData.length > 0) {
            renderChart();
        }
    } catch (e) {
        console.error("Error loading ARSO forecast:", e);
        updateOpenMeteoFallbackCards();
    }
}

function renderArsoForecast() {
    const arsoForecastData = getActiveForecastData();
    
    // Update Forecast Title according to selected location
    const titleEl = document.getElementById('forecast-section-title');
    if (titleEl) {
        if (activeWeatherSource === 'vida') {
            titleEl.textContent = 'Vremenska napoved Piran (ARSO ALADIN)';
        } else {
            titleEl.textContent = 'Vremenska napoved Letališče Portorož (ARSO ALADIN)';
        }
    }
    
    // Set dynamic Slovenian names of days for Tomorrow and Day After
    const daysSloNominative = ["Nedelja", "Ponedeljek", "Torek", "Sreda", "Četrtek", "Petek", "Sobota"];
    const dateTomorrow = new Date();
    dateTomorrow.setDate(dateTomorrow.getDate() + 1);
    const dateDayAfter = new Date();
    dateDayAfter.setDate(dateDayAfter.getDate() + 2);
    
    const tomorrowDayName = daysSloNominative[dateTomorrow.getDay()];
    const dayAfterDayName = daysSloNominative[dateDayAfter.getDay()];
    
    const tomorrowNameEl = document.getElementById('forecast-day-1-name');
    if (tomorrowNameEl) tomorrowNameEl.textContent = tomorrowDayName;
    
    const dayAfterNameEl = document.getElementById('forecast-day-2-name');
    if (dayAfterNameEl) dayAfterNameEl.textContent = dayAfterDayName;
    
    // Update wave badges in daily cards (use maximum representative wave height for that day)
    const waveCard0 = document.getElementById('forecast-day-0-wave');
    if (waveCard0) waveCard0.innerHTML = getWaveIconHtml(getDayMaxWaveHeight(new Date()));
    
    const waveCard1 = document.getElementById('forecast-day-1-wave');
    if (waveCard1) waveCard1.innerHTML = getWaveIconHtml(getDayMaxWaveHeight(dateTomorrow));
    
    const waveCard2 = document.getElementById('forecast-day-2-wave');
    if (waveCard2) waveCard2.innerHTML = getWaveIconHtml(getDayMaxWaveHeight(dateDayAfter));
    
    let success = false;
    if (arsoForecastData && arsoForecastData.forecast24h?.features?.[0]?.properties?.days) {
        try {
            const days = arsoForecastData.forecast24h.features[0].properties.days;
            
            // Update Danes forecast icon from official ARSO forecast24h
            if (days[0] && days[0].timeline && days[0].timeline.length > 0) {
                const todayForecastIcon = days[0].timeline[0].clouds_icon_wwsyn_icon || "";
                const todayIconBox = document.getElementById('weather-icon-box');
                if (todayIconBox && todayForecastIcon) {
                    todayIconBox.innerHTML = getWeatherIconHtml(todayForecastIcon, "1.8rem");
                }
            }
            
            const updateCardFromArsoJson = (cardPrefix, dayData) => {
                if (!dayData || !dayData.timeline || dayData.timeline.length === 0) return false;
                const timeline = dayData.timeline[0];
                
                const tempMin = parseFloat(timeline.tnsyn);
                const tempMax = parseFloat(timeline.txsyn);
                const windSpeedKmh = parseFloat(timeline.ff_val || "0"); // already in km/h from ARSO API
                const windDir = timeline.dd_shortText || "";
                const windDirDeg = getWindDegFromSlo(windDir);
                const windArrow = getWindArrowHtml(windDirDeg);
                const iconName = timeline.clouds_icon_wwsyn_icon || "";
                
                const iconBox = document.getElementById(`${cardPrefix}-icon-box`);
                if (iconBox) {
                    iconBox.innerHTML = getWeatherIconHtml(iconName, "1.5rem");
                }
                
                const tempEl = document.getElementById(`${cardPrefix}-temp`);
                if (tempEl) {
                    tempEl.textContent = `${Math.round(tempMin)} / ${Math.round(tempMax)} °C`;
                }
                
                const windEl = document.getElementById(`${cardPrefix}-wind`);
                if (windEl) {
                    windEl.innerHTML = `${windArrow}${Math.round(windSpeedKmh)} km/h (${windDir})`;
                }
                return true;
            };
            
            const tomorrowSuccess = updateCardFromArsoJson('forecast-day-1', days[1]);
            const dayAfterSuccess = updateCardFromArsoJson('forecast-day-2', days[2]);
            success = tomorrowSuccess && dayAfterSuccess;
        } catch (jsonErr) {
            console.error("Error parsing ARSO daily forecast:", jsonErr);
        }
    }
    
    if (!success) {
        console.log("Using Open-Meteo daily forecast fallback");
        updateOpenMeteoFallbackCards();
    }
}

function renderArso1hForecast(dayOffset = 0) {
    const container = document.getElementById('hourly-scroll-container');
    const arsoForecastData = getActiveForecastData();
    if (!container || !arsoForecastData) return false;
    
    const days = arsoForecastData.forecast1h?.features?.[0]?.properties?.days;
    if (!days || days.length === 0) return false;
    
    container.innerHTML = '';
    
    // For "Danes" (dayOffset === 0), combine all available 1-hour timeline points across all available days (up to ~36h)
    let allTimeline = [];
    days.forEach(dayItem => {
        if (dayItem.timeline && Array.isArray(dayItem.timeline)) {
            allTimeline = allTimeline.concat(dayItem.timeline);
        }
    });
    
    const now = new Date();
    const nextHour = new Date(now.getTime());
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    
    // Filter out past hours of today, keep all upcoming hours
    const filtered = allTimeline.filter(item => {
        const itemDate = new Date(item.valid);
        return itemDate >= nextHour;
    });
    
    if (filtered.length === 0) {
        return false;
    }
    
    filtered.forEach(item => {
        const itemDate = new Date(item.valid);
        
        const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const itemDay = new Date(itemDate.getFullYear(), itemDate.getMonth(), itemDate.getDate());
        const dayDiff = Math.round((itemDay.getTime() - nowDay.getTime()) / 86400000);
        
        let dayPrefix = "";
        if (dayDiff === 1) {
            dayPrefix = `<span style="font-size:0.55rem;opacity:0.85;display:block;line-height:1;">Jutri</span>`;
        } else if (dayDiff === 2) {
            dayPrefix = `<span style="font-size:0.55rem;opacity:0.85;display:block;line-height:1;">Pojutr.</span>`;
        } else if (dayDiff > 2) {
            const daysSloShort = ["Ned", "Pon", "Tor", "Sre", "Čet", "Pet", "Sob"];
            dayPrefix = `<span style="font-size:0.55rem;opacity:0.85;display:block;line-height:1;">${daysSloShort[itemDate.getDay()]}</span>`;
        }
        
        const timeFormatted = itemDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        const timeDisplay = dayPrefix ? `${dayPrefix}${timeFormatted}` : timeFormatted;
        
        const tempVal = parseFloat(item.t);
        const windSpeedKmh = parseFloat(item.ff_val || "0"); // already in km/h from ARSO API
        const windDir = item.dd_shortText || "";
        const windDirDeg = getWindDegFromSlo(windDir);
        const windArrow = getWindArrowHtml(windDirDeg);
        const iconName = item.clouds_icon_wwsyn_icon || "";
        const rain = parseFloat(item.tp_acc || "0");
        const waveH = getWaveHeightForTime(itemDate);
        
        const itemEl = document.createElement('div');
        itemEl.className = 'hourly-item';
        itemEl.innerHTML = `
            <span class="hourly-time">${timeDisplay}</span>
            ${getWeatherIconHtml(iconName, "1.2rem")}
            <span class="hourly-temp">${Math.round(tempVal)}°C</span>
            <span class="hourly-wind">${windArrow}${Math.round(windSpeedKmh)} km/h</span>
            <span class="hourly-rain">${rain > 0 ? rain.toFixed(1) + ' mm' : '0 mm'}</span>
            <div style="margin-top:2px;">${getWaveIconHtml(waveH)}</div>
        `;
        container.appendChild(itemEl);
    });
    
    return true;
}

function renderArso3hForecast(dayOffset) {
    const container = document.getElementById('hourly-scroll-container');
    const arsoForecastData = getActiveForecastData();
    if (!container || !arsoForecastData) return false;
    
    const days = arsoForecastData.forecast3h?.features?.[0]?.properties?.days;
    if (!days) return false;
    
    // Find target day matching local calendar date
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    const targetDateStr = d.getFullYear() + '-' + 
                          String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                          String(d.getDate()).padStart(2, '0');
    
    const targetDay = days.find(item => item.date === targetDateStr);
    if (!targetDay) return false;
    
    const timeline = targetDay.timeline || [];
    container.innerHTML = '';
    
    if (timeline.length === 0) {
        return false;
    }
    
    timeline.forEach(item => {
        const itemDate = new Date(item.valid);
        const timeStr = itemDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        
        const tempVal = parseFloat(item.t);
        const windSpeedKmh = parseFloat(item.ff_val || "0"); // already in km/h from ARSO API
        const windDir = item.dd_shortText || "";
        const windDirDeg = getWindDegFromSlo(windDir);
        const windArrow = getWindArrowHtml(windDirDeg);
        const iconName = item.clouds_icon_wwsyn_icon || "";
        const rain = parseFloat(item.tp_acc || "0");
        const waveH = getWaveHeightForTime(itemDate);
        
        const itemEl = document.createElement('div');
        itemEl.className = 'hourly-item';
        itemEl.innerHTML = `
            <span class="hourly-time" style="font-size: 0.68rem; font-weight: 700;">${timeStr}</span>
            ${getWeatherIconHtml(iconName, "1.2rem")}
            <span class="hourly-temp">${Math.round(tempVal)}°C</span>
            <span class="hourly-wind">${windArrow}${Math.round(windSpeedKmh)} km/h</span>
            <span class="hourly-rain">${rain > 0 ? rain.toFixed(1) + ' mm' : '0 mm'}</span>
            <div style="margin-top:2px;">${getWaveIconHtml(waveH)}</div>
        `;
        container.appendChild(itemEl);
    });
    
    return true;
}

function toggleHourlyForecast(dayOffset) {
    const panel = document.getElementById('hourly-forecast-panel');
    const container = document.getElementById('hourly-scroll-container');
    const titleEl = document.getElementById('hourly-forecast-title');
    
    if (!panel || !container || !titleEl) return;
    
    if (activeHourlyDayOffset === dayOffset) {
        panel.style.display = 'none';
        const activeCard = document.getElementById(`forecast-card-${activeHourlyDayOffset}`);
        if (activeCard) activeCard.classList.remove('active');
        activeHourlyDayOffset = null;
        return;
    }
    
    if (activeHourlyDayOffset !== null) {
        const prevCard = document.getElementById(`forecast-card-${activeHourlyDayOffset}`);
        if (prevCard) prevCard.classList.remove('active');
    }
    
    activeHourlyDayOffset = dayOffset;
    const activeCard = document.getElementById(`forecast-card-${dayOffset}`);
    if (activeCard) activeCard.classList.add('active');
    
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + dayOffset);
    
    const daysSloNominative = ["Nedelja", "Ponedeljek", "Torek", "Sreda", "Četrtek", "Petek", "Sobota"];
    const daysSloAccusative = ["nedeljo", "ponedeljek", "torek", "sredo", "četrtek", "petek", "soboto"];
    
    let dayTitleText = `Podrobna napoved za danes`;
    if (dayOffset > 0) {
        dayTitleText = `Podrobna napoved za ${daysSloAccusative[targetDate.getDay()]}`;
    }
    titleEl.textContent = dayTitleText;
    
    // Attempt rendering using official ARSO JSON (1h for today 36h continuous track, 3h for tomorrow and day after tomorrow)
    let arsoSuccess = false;
    if (dayOffset === 0) {
        arsoSuccess = renderArso1hForecast(0);
    } else {
        arsoSuccess = renderArso3hForecast(dayOffset);
    }
    
    if (!arsoSuccess) {
        console.log("Using Open-Meteo fallback for detail widget");
        let filtered = [];
        const now = new Date();
        
        if (dayOffset === 0) {
            const nextHour = new Date(now.getTime());
            nextHour.setMinutes(0, 0, 0);
            nextHour.setHours(nextHour.getHours() + 1);
            
            const endOfToday = new Date(now.getTime());
            endOfToday.setHours(23, 59, 59, 999);
            
            filtered = openMeteoHourlyForecast.filter(item => item.time >= nextHour && item.time <= endOfToday);
        } else {
            const startOfDay = new Date(targetDate.getTime());
            startOfDay.setHours(0, 0, 0, 0);
            
            const endOfDay = new Date(targetDate.getTime());
            endOfDay.setHours(23, 59, 59, 999);
            
            filtered = openMeteoHourlyForecast.filter(item => item.time >= startOfDay && item.time <= endOfDay);
        }
        
        container.innerHTML = '';
        
        if (filtered.length === 0) {
            container.innerHTML = '<div style="font-size:0.8rem;color:var(--text-secondary);width:100%;text-align:center;padding:10px;">Podatki niso na voljo.</div>';
        } else {
            filtered.forEach(item => {
                const timeStr = item.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
                const weatherName = item.weatherCode === 0 || item.weatherCode === 1 ? "clear" : (item.weatherCode === 2 ? "partCloudy" : "overcast");
                const rain = item.rain || 0;
                const windArrow = getWindArrowHtml(item.windDir);
                
                const itemEl = document.createElement('div');
                itemEl.className = 'hourly-item';
                itemEl.innerHTML = `
                    <span class="hourly-time">${timeStr}</span>
                    ${getWeatherIconHtml(weatherName, "1.2rem")}
                    <span class="hourly-temp">${Math.round(item.temp)}°C</span>
                    <span class="hourly-wind">${windArrow}${Math.round(item.windSpeed)} km/h</span>
                    <span class="hourly-rain">${rain > 0 ? rain.toFixed(1) + ' mm' : '0 mm'}</span>
                `;
                container.appendChild(itemEl);
            });
        }
    }
    
    panel.style.display = 'block';
    container.scrollLeft = 0;
    setTimeout(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
}

window.toggleHourlyForecast = toggleHourlyForecast;

async function loadOpenMeteoPressures() {
    try {
        // Fetch 31 days of history and 3 days of forecast from Open-Meteo (including sunrise/sunset)
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=45.5469,42.6507&longitude=13.7294,18.0944&hourly=pressure_msl,weather_code,temperature_2m,wind_speed_10m,precipitation,wind_direction_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset&past_days=31&forecast_days=3&timezone=auto';
        const response = await fetch(url);
        if (!response.ok) throw new Error("Meteo API response not ok");
        const json = await response.json();
        
        if (json && json[0] && json[0].hourly && json[1] && json[1].hourly) {
            meteoForecastMap.clear();
            const times = json[0].hourly.time;
            const pressuresKoper = json[0].hourly.pressure_msl;
            const pressuresDubrovnik = json[1].hourly.pressure_msl;
            
            for (let i = 0; i < times.length; i++) {
                const date = parseIsoLocal(times[i]);
                const timeMs = date.getTime();
                meteoForecastMap.set(timeMs, {
                    pressureKoper: pressuresKoper[i],
                    pressureDubrovnik: pressuresDubrovnik[i]
                });
            }
            console.log(`Loaded ${meteoForecastMap.size} Open-Meteo dual-pressure weather points.`);
            
            // Parse and save hourly details for the slider widget (as fallback)
            openMeteoHourlyForecast = [];
            const hourly = json[0].hourly;
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            
            for (let i = 0; i < hourly.time.length; i++) {
                const date = parseIsoLocal(hourly.time[i]);
                if (date >= startOfToday) {
                    openMeteoHourlyForecast.push({
                        time: date,
                        temp: hourly.temperature_2m[i],
                        weatherCode: hourly.weather_code[i],
                        windSpeed: hourly.wind_speed_10m[i],
                        windDir: hourly.wind_direction_10m ? hourly.wind_direction_10m[i] : 0,
                        rain: hourly.precipitation ? hourly.precipitation[i] : 0
                    });
                }
            }
            
            // Save daily data for fallback cards
            openMeteoDailyData = json[0].daily || null;
            
            // Update sunrise and sunset widgets
            if (openMeteoDailyData && openMeteoDailyData.sunrise && openMeteoDailyData.sunset) {
                const parseTime = (isoStr) => {
                    if (!isoStr) return "--:--";
                    const d = new Date(isoStr);
                    if (isNaN(d.getTime())) return "--:--";
                    return d.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
                };
                
                // Open-Meteo daily arrays contain past_days=31, so today is at index 31.
                // We find it dynamically by matching today's date string in local time.
                const localToday = new Date();
                const todayStr = localToday.getFullYear() + '-' + 
                                 String(localToday.getMonth() + 1).padStart(2, '0') + '-' + 
                                 String(localToday.getDate()).padStart(2, '0');
                
                let todayIdx = openMeteoDailyData.time ? openMeteoDailyData.time.indexOf(todayStr) : -1;
                if (todayIdx === -1 || todayIdx >= openMeteoDailyData.sunrise.length) {
                    todayIdx = Math.min(31, openMeteoDailyData.sunrise.length - 1);
                    if (todayIdx < 0) todayIdx = 0;
                }
                
                document.getElementById('sunrise-time').textContent = parseTime(openMeteoDailyData.sunrise[todayIdx]);
                document.getElementById('sunset-time').textContent = parseTime(openMeteoDailyData.sunset[todayIdx]);
            }
        }
    } catch (e) {
        console.error("Error loading Open-Meteo pressure data:", e);
    }
}

async function refreshData() {
    try {
        // Fetch Open-Meteo dual-pressure data (crucial for chart)
        const meteoPromise = loadOpenMeteoPressures();
        
        const updateUIWithData = (dataList) => {
            if (!dataList || dataList.length === 0) return;
            const latest = dataList[dataList.length - 1];
            const relativeVal = latest.level - MEAN_SEA_LEVEL_OFFSET;
            const relativeSign = relativeVal >= 0 ? '+' : '';
            document.getElementById('current-level-val').textContent = `${relativeSign}${Math.round(relativeVal)}`;
            document.getElementById('relative-level-val').textContent = `Absolutna gladina: ${Math.round(latest.level)} cm`;
            updateWaterGauge(relativeVal);
            
            const timeStr = latest.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
            const timeEl = document.getElementById('level-time-val');
            if (timeEl) timeEl.textContent = `Meritev ARSO ob: ${timeStr}`;
            
            document.getElementById('current-temp-val').textContent = latest.temp.toFixed(1);
            
            // Check for flood warning (level >= 300 cm)
            const warningContainer = document.getElementById('warning-banner-container');
            const levelCard = document.getElementById('card-sea-level');
            
            if (latest.level >= 300.0) {
                if (levelCard) levelCard.classList.add('warning-active');
                if (warningContainer) {
                    warningContainer.innerHTML = `
                        <div class="warning-banner">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            <span>OPOZORILO: Gladina morja presega kritično mejo (300 cm)! Možnost poplavljanja obale.</span>
                        </div>
                    `;
                }
            } else {
                if (levelCard) levelCard.classList.remove('warning-active');
                if (warningContainer) warningContainer.innerHTML = '';
            }
            
            // Calculate sea level trend (raste / pada / stagnira) based on last 3 measurements
            const latestPoints = dataList.slice(-3);
            const trendBadge = document.getElementById('level-trend-badge');
            if (trendBadge && latestPoints.length >= 3) {
                const totalDiff = latestPoints[2].level - latestPoints[0].level;
                trendBadge.className = 'trend-badge'; // Reset state classes
                
                if (totalDiff > 0.4) {
                    trendBadge.innerHTML = '<i class="fa-solid fa-arrow-trend-up"></i> raste';
                    trendBadge.classList.add('trend-up');
                } else if (totalDiff < -0.4) {
                    trendBadge.innerHTML = '<i class="fa-solid fa-arrow-trend-down"></i> pada';
                    trendBadge.classList.add('trend-down');
                } else {
                    trendBadge.innerHTML = '<i class="fa-solid fa-arrows-left-right"></i> stagnira';
                    trendBadge.classList.add('trend-stable');
                }
            }
            
            // Calculate high/low tide predictions based on current device time
            calculateTideExtrema(new Date());
            
            // Draw the chart immediately
            renderChart();
        };

        // Load 24h table first for instant UI response, then full 30d history in background
        actualData = await loadMergedWaterData((quick24hData) => {
            actualData = quick24hData;
            updateUIWithData(actualData);
        });
        
        if (!actualData || actualData.length === 0) throw new Error("Data empty");
        
        // Wait for pressure data to finish loading (very fast)
        try {
            await meteoPromise;
        } catch (meteoErr) {
            console.error("Failed to load meteo pressures, continuing:", meteoErr);
        }
        
        // Cache full merged data to LocalStorage
        try {
            localStorage.setItem('arso_actual_data', JSON.stringify(actualData));
        } catch (e) {
            console.warn("Could not save to localStorage:", e);
        }
        
        // Update UI & Chart with full 30-day dataset
        updateUIWithData(actualData);
    } catch (err) {
        console.error("Error refreshing data:", err);
        // Show error indicator in cards
        document.getElementById('current-level-val').textContent = "Napaka";
        document.getElementById('current-temp-val').textContent = "Napaka";
    }
}

// Calculate the next high and low tides based on the physical model
function calculateTideExtrema(currentTime) {
    // Generate predictions for the next 36 hours at 5-minute intervals to find peak times precisely
    const start = new Date(currentTime.getTime());
    const end = new Date(currentTime.getTime() + (36 * 60 * 60 * 1000));
    const predictions = TideCalculator.getPredictionsForPeriod(start, end, 5);
    
    let nextHigh = null;
    let nextLow = null;
    
    // Search for peaks in the series
    for (let i = 1; i < predictions.length - 1; i++) {
        const prev = predictions[i-1].level;
        const curr = predictions[i].level;
        const next = predictions[i+1].level;
        
        // High tide peak (local maxima)
        if (curr > prev && curr > next) {
            if (!nextHigh && predictions[i].time > currentTime) {
                nextHigh = predictions[i];
            }
        }
        // Low tide peak (local minima)
        if (curr < prev && curr < next) {
            if (!nextLow && predictions[i].time > currentTime) {
                nextLow = predictions[i];
            }
        }
        
        if (nextHigh && nextLow) break;
    }
    
    console.log("calculateTideExtrema debug:", { 
        currentTime: currentTime.toString(), 
        predictionsLength: predictions.length, 
        nextHigh: nextHigh ? { time: nextHigh.time.toString(), level: nextHigh.level } : null,
        nextLow: nextLow ? { time: nextLow.time.toString(), level: nextLow.level } : null
    });
    
    const SLO_DAYS = ["NED", "PON", "TOR", "SRE", "ČET", "PET", "SOB"];
    
    // Update the widgets
    if (nextHigh) {
        const dayPrefix = SLO_DAYS[nextHigh.time.getDay()];
        const timeStr = nextHigh.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        const highTimeStr = `${dayPrefix} ${timeStr}`;
        document.getElementById('next-high-time').textContent = highTimeStr;
        const relativeVal = nextHigh.level;
        const relativeSign = relativeVal >= 0 ? '+' : '';
        document.getElementById('next-high-height').textContent = `Višina: ${relativeSign}${relativeVal.toFixed(0)} cm`;
    }
    
    if (nextLow) {
        const dayPrefix = SLO_DAYS[nextLow.time.getDay()];
        const timeStr = nextLow.time.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        const lowTimeStr = `${dayPrefix} ${timeStr}`;
        document.getElementById('next-low-time').textContent = lowTimeStr;
        const relativeVal = nextLow.level;
        const relativeSign = relativeVal >= 0 ? '+' : '';
        document.getElementById('next-low-height').textContent = `Višina: ${relativeSign}${relativeVal.toFixed(0)} cm`;
    }
}
function getArsoDescriptionFromIcon(iconName) {
    if (!iconName) return "jasno";
    const name = iconName.toLowerCase();
    
    if (name.includes("ts") || name.includes("bolt") || name.includes("thunder") || name.includes("neviht")) {
        return "nevihta";
    }
    if (name.includes("snow") || name.includes("sn") || name.includes("sneg")) {
        return "sneženje";
    }
    if (name.includes("shra") || name.includes("shower") || name.includes("ploh")) {
        return "ploha";
    }
    if (name.includes("rain") || name.includes("ra") || name.includes("dež") || name.includes("dz")) {
        return "dež";
    }
    if (name.includes("fog") || name.includes("fg") || name.includes("megl")) {
        return "megla";
    }
    if (name.includes("overcast") || name.includes("oblač")) {
        return "oblačno";
    }
    if (name.includes("prevcloudy")) {
        return "pretežno oblačno";
    }
    if (name.includes("modcloudy")) {
        return "zmerno oblačno";
    }
    if (name.includes("partcloudy") || name.includes("delno")) {
        return "delno oblačno";
    }
    if (name.includes("slightcloudy") || name.includes("rahlo")) {
        return "rahlo oblačno";
    }
    if (name.includes("mostclear")) {
        return "pretežno jasno";
    }
    if (name.includes("clear") || name.includes("jasno")) {
        return "jasno";
    }
    return "jasno";
}

// Helper to parse official ARSO AMS station XML feeds
async function parseArsoAmsXml(stationId, cb) {
    try {
        const targetUrl = `https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observationAms_${stationId}_latest.xml?cb=${cb}`;
        const xmlText = await fetchWeatherWithFallback(targetUrl, true);
        if (!xmlText || typeof xmlText !== 'string') return null;

        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const metData = xmlDoc.getElementsByTagName("metData")[0];
        if (!metData) return null;

        const getValue = (tagName, fallback = "") => {
            const node = metData.getElementsByTagName(tagName)[0];
            return node ? (node.textContent || "").trim() : fallback;
        };

        const rawT = getValue("t");
        const tempVal = rawT && !isNaN(parseFloat(rawT)) ? parseFloat(rawT) : null;
        
        const rawRh = getValue("rh");
        const rh = rawRh && !isNaN(parseFloat(rawRh)) ? parseFloat(rawRh) : null;

        // Wind calculations (both buoy and airport use m/s in ffavg_val and km/h in ffavg_val_kmh)
        let rawFfKmh = getValue("ffavg_val_kmh") || getValue("ff_val_kmh");
        let rawFfMs = getValue("ffavg_val") || getValue("ff_val");
        let windSpeedKmh = rawFfKmh && !isNaN(parseFloat(rawFfKmh)) ? parseFloat(rawFfKmh) : null;
        let windSpeedMs = rawFfMs && !isNaN(parseFloat(rawFfMs)) ? parseFloat(rawFfMs) : null;
        
        if (windSpeedKmh === null && windSpeedMs !== null) {
            windSpeedKmh = windSpeedMs * 3.6;
        } else if (windSpeedMs === null && windSpeedKmh !== null) {
            windSpeedMs = windSpeedKmh / 3.6;
        }

        let feelsLike = null;
        if (tempVal !== null && rh !== null && windSpeedMs !== null) {
            const e = (rh / 100.0) * 6.105 * Math.exp((17.27 * tempVal) / (237.7 + tempVal));
            feelsLike = tempVal + 0.33 * e - 0.7 * windSpeedMs - 4.0;
        }

        const rawDd = getValue("dd_val") || getValue("ddavg_val");
        const windDirDeg = rawDd && !isNaN(parseFloat(rawDd)) ? parseFloat(rawDd) : 0;
        let windDirStr = getValue("dd_shortText") || getValue("ddavg_shortText") || "";
        if (!windDirStr || /^\d+°?$/.test(windDirStr)) {
            windDirStr = (windSpeedKmh !== null && (windSpeedKmh > 0 || windSpeedMs > 0)) ? getWindDirectionSlo(windDirDeg) : "Brezvetrje";
        }

        const rawP = getValue("p") || getValue("msl");
        const pressure = rawP && !isNaN(parseFloat(rawP)) && parseFloat(rawP) > 800 ? parseFloat(rawP) : null;
        
        const iconName = getValue("nn_icon-wwsyn_icon") || getValue("clouds_icon_wwsyn_icon") || "";
        let desc = getValue("nn_shortText-wwsyn_longText") || getValue("clouds_shortText") || "";
        if (!desc && iconName) {
            desc = getArsoDescriptionFromIcon(iconName);
        }
        if (!desc) {
            desc = "jasno";
        }
        const validTime = getValue("valid") || "";

        return {
            description: desc,
            temp: tempVal,
            feelsLike: feelsLike,
            pressure: pressure,
            humidity: rh,
            windSpeedMs: windSpeedMs,
            windSpeedKmh: windSpeedKmh,
            windDirDeg: windDirDeg,
            windDirStr: windDirStr,
            iconName: iconName,
            validTime: validTime
        };
    } catch (e) {
        console.error(`Error parsing ARSO AMS XML for ${stationId}:`, e);
        return null;
    }
}

// Helper to manage persistent sensor values with the 60-minute fallback threshold rule
function processSensorValueWithThreshold(stationKey, sensorKey, currentValue, rowDate) {
    const storageValKey = `arso_${stationKey}_last_${sensorKey}`;
    const storageTimeKey = `arso_${stationKey}_last_${sensorKey}_time`;
    
    if (currentValue !== null && currentValue !== undefined && (typeof currentValue !== 'number' || !isNaN(currentValue))) {
        // Fresh measurement from XML
        try {
            localStorage.setItem(storageValKey, JSON.stringify(currentValue));
            localStorage.setItem(storageTimeKey, rowDate.toISOString());
        } catch (e) {}
        return {
            value: currentValue,
            staleNote: null,
            staleType: null,
            isFresh: true
        };
    }
    
    // Missing measurement - check persistent storage
    let lastVal = null;
    let lastTimeIso = null;
    try {
        const storedVal = localStorage.getItem(storageValKey);
        if (storedVal !== null && storedVal !== 'undefined') {
            lastVal = JSON.parse(storedVal);
        }
        lastTimeIso = localStorage.getItem(storageTimeKey);
    } catch (e) {}
    
    if (lastTimeIso && lastVal !== null) {
        const lastDate = new Date(lastTimeIso);
        const ageMinutes = Math.max(0, Math.round((rowDate.getTime() - lastDate.getTime()) / (60 * 1000)));
        const timeStr = lastDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        
        if (ageMinutes < 60) {
            // Under 60 min: retain last known value with amber warning note
            return {
                value: lastVal,
                staleNote: `Ni svežega podatka (zadnja posodobitev ARSO ob ${timeStr})`,
                staleType: 'warning',
                isFresh: false
            };
        } else {
            // 60 min or older: return null with red note
            return {
                value: null,
                staleNote: `Ni svežega podatka (zadnja posodobitev ARSO ob ${timeStr})`,
                staleType: 'error',
                isFresh: false
            };
        }
    }
    
    // No previous history found
    return {
        value: null,
        staleNote: 'Ni svežega podatka',
        staleType: 'error',
        isFresh: false
    };
}

let lastWeatherFetchTime = 0;

// Fetch weather conditions strictly from official ARSO station XML feeds (Piran Boja Vida & Letališče Portorož)
async function loadWeather(forceLoadingState = false) {
    const cb = Date.now();
    
    // Only reset to null if explicitly forced or if both are empty
    if (forceLoadingState || (!weatherDataVida && !weatherDataPortoroz)) {
        weatherDataVida = null;
        weatherDataPortoroz = null;
        renderWeather();
    }
    
    // Fetch official ARSO XML in parallel
    const fetchVidaXml = async () => {
        try {
            return await parseArsoAmsXml("PIRAN_OCEAN-BOJ", cb);
        } catch (e) {
            console.error("Error loading Vida buoy XML:", e);
            return null;
        }
    };

    const fetchPortorozXml = async () => {
        try {
            return await parseArsoAmsXml("PORTOROZ_SECOVLJE", cb);
        } catch (e) {
            console.error("Error loading Portorož Airport data:", e);
            return null;
        }
    };

    // Run XML fetches in parallel
    const [vidaData, portorozData] = await Promise.all([fetchVidaXml(), fetchPortorozXml()]);
    
    // 1. Process Letališče Portorož
    if (portorozData) {
        const portorozRowDate = parseArsoXmlDate(portorozData.validTime) || new Date();
        
        const pTemp = processSensorValueWithThreshold('portoroz', 'temp', portorozData.temp, portorozRowDate);
        const pRh = processSensorValueWithThreshold('portoroz', 'rh', portorozData.humidity, portorozRowDate);
        const pPressure = processSensorValueWithThreshold('portoroz', 'pressure', portorozData.pressure, portorozRowDate);
        
        let pWindInput = (portorozData.windSpeedKmh !== null) ? {
            speedKmh: portorozData.windSpeedKmh,
            speedMs: portorozData.windSpeedMs,
            dirDeg: portorozData.windDirDeg,
            dirStr: portorozData.windDirStr
        } : null;
        const pWind = processSensorValueWithThreshold('portoroz', 'wind', pWindInput, portorozRowDate);
        
        let pFeelsLike = null;
        if (pTemp.value !== null && pRh.value !== null) {
            const windMs = pWind.value ? (pWind.value.speedMs || 0) : 0;
            const e = (pRh.value / 100.0) * 6.105 * Math.exp((17.27 * pTemp.value) / (237.7 + pTemp.value));
            pFeelsLike = pTemp.value + 0.33 * e - 0.7 * windMs - 4.0;
        }

        weatherDataPortoroz = {
            ...portorozData,
            temp: pTemp.value,
            tempStaleNote: pTemp.staleNote,
            tempStaleType: pTemp.staleType,
            humidity: pRh.value,
            humidityStaleNote: pRh.staleNote,
            humidityStaleType: pRh.staleType,
            pressure: pPressure.value,
            pressureStaleNote: pPressure.staleNote,
            pressureStaleType: pPressure.staleType,
            windSpeedKmh: pWind.value ? pWind.value.speedKmh : null,
            windSpeedMs: pWind.value ? pWind.value.speedMs : null,
            windDirDeg: pWind.value ? pWind.value.dirDeg : 0,
            windDirStr: pWind.value ? pWind.value.dirStr : '',
            windStaleNote: pWind.staleNote,
            windStaleType: pWind.staleType,
            feelsLike: pFeelsLike,
            validTime: portorozData.validTime,
            waveHeight: currentMarineWaveHeight || 0.2
        };
    }

    // 2. Process Piran (Boja Vida)
    if (vidaData) {
        const vidaRowDate = parseArsoXmlDate(vidaData.validTime) || new Date();
        
        const vTemp = processSensorValueWithThreshold('vida', 'temp', vidaData.temp, vidaRowDate);
        const vRh = processSensorValueWithThreshold('vida', 'rh', vidaData.humidity, vidaRowDate);
        
        let vWindInput = (vidaData.windSpeedKmh !== null) ? {
            speedKmh: vidaData.windSpeedKmh,
            speedMs: vidaData.windSpeedMs,
            dirDeg: vidaData.windDirDeg,
            dirStr: vidaData.windDirStr
        } : null;
        const vWind = processSensorValueWithThreshold('vida', 'wind', vWindInput, vidaRowDate);
        
        let vFeelsLike = null;
        if (vTemp.value !== null && vRh.value !== null) {
            const windMs = vWind.value ? (vWind.value.speedMs || 0) : 0;
            const e = (vRh.value / 100.0) * 6.105 * Math.exp((17.27 * vTemp.value) / (237.7 + vTemp.value));
            vFeelsLike = vTemp.value + 0.33 * e - 0.7 * windMs - 4.0;
        }

        // Pressure for Boja Vida: ALWAYS borrowed from Portorož Airport!
        let vPress = null;
        let vPressStaleNote = null;
        let vPressStaleType = null;
        if (weatherDataPortoroz && weatherDataPortoroz.pressure !== null) {
            vPress = weatherDataPortoroz.pressure;
            vPressStaleNote = weatherDataPortoroz.pressureStaleNote;
            vPressStaleType = weatherDataPortoroz.pressureStaleType;
        } else if (vidaData.pressure) {
            vPress = vidaData.pressure;
        } else {
            const pStoredPress = processSensorValueWithThreshold('portoroz', 'pressure', null, vidaRowDate);
            vPress = pStoredPress.value || 1018;
            vPressStaleNote = pStoredPress.staleNote;
            vPressStaleType = pStoredPress.staleType;
        }

        const currentDesc = (vidaData.description && vidaData.description !== "jasno") ? vidaData.description : (weatherDataPortoroz ? weatherDataPortoroz.description : "jasno");
        const currentIcon = vidaData.iconName || (weatherDataPortoroz ? weatherDataPortoroz.iconName : "clear");

        weatherDataVida = {
            ...vidaData,
            temp: vTemp.value,
            tempStaleNote: vTemp.staleNote,
            tempStaleType: vTemp.staleType,
            humidity: vRh.value,
            humidityStaleNote: vRh.staleNote,
            humidityStaleType: vRh.staleType,
            windSpeedKmh: vWind.value ? vWind.value.speedKmh : null,
            windSpeedMs: vWind.value ? vWind.value.speedMs : null,
            windDirDeg: vWind.value ? vWind.value.dirDeg : 0,
            windDirStr: vWind.value ? vWind.value.dirStr : '',
            windStaleNote: vWind.staleNote,
            windStaleType: vWind.staleType,
            feelsLike: vFeelsLike,
            pressure: vPress,
            pressureStaleNote: vPressStaleNote,
            pressureStaleType: vPressStaleType,
            validTime: vidaData.validTime,
            description: currentDesc,
            iconName: currentIcon,
            waveHeight: currentMarineWaveHeight || 0.2
        };
    }

    if (weatherDataVida || weatherDataPortoroz) {
        lastWeatherFetchTime = Date.now();
    }
    
    // Re-render the active tab with updated station data
    renderWeather();
}

function parseArsoXmlDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.trim().split(/\s+/);
    if (parts.length >= 2) {
        const dateParts = parts[0].split('.');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length >= 2) {
            const day = parseInt(dateParts[0], 10);
            const month = parseInt(dateParts[1], 10) - 1;
            const year = parseInt(dateParts[2], 10);
            const hour = parseInt(timeParts[0], 10);
            const minute = parseInt(timeParts[1], 10);
            const second = timeParts.length > 2 ? parseInt(timeParts[2], 10) : 0;
            return new Date(year, month, day, hour, minute, second);
        }
    }
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(dateStr.trim())) {
        const now = new Date();
        const tParts = dateStr.trim().split(':');
        now.setHours(parseInt(tParts[0], 10), parseInt(tParts[1], 10), 0, 0);
        return now;
    }
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

// Find forecast point in ARSO timeline matching a specific time
function getForecastItemForTime(dateObj) {
    const fcData = getActiveForecastData();
    if (!fcData || !dateObj) return null;
    const timeMs = dateObj.getTime();
    
    // 1. Search 1h forecast timeline
    const days1h = fcData.forecast1h?.features?.[0]?.properties?.days;
    if (days1h) {
        let bestItem = null;
        let minDiff = 3600 * 1000 * 1.5;
        for (const day of days1h) {
            if (day.timeline) {
                for (const item of day.timeline) {
                    const itemMs = new Date(item.valid).getTime();
                    const diff = Math.abs(itemMs - timeMs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestItem = item;
                    }
                }
            }
        }
        if (bestItem) return bestItem;
    }
    
    // 2. Search 3h forecast timeline
    const days3h = fcData.forecast3h?.features?.[0]?.properties?.days;
    if (days3h) {
        let bestItem = null;
        let minDiff = 3600 * 1000 * 3.5;
        for (const day of days3h) {
            if (day.timeline) {
                for (const item of day.timeline) {
                    const itemMs = new Date(item.valid).getTime();
                    const diff = Math.abs(itemMs - timeMs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestItem = item;
                    }
                }
            }
        }
        if (bestItem) return bestItem;
    }
    
    // 3. Fallback to 24h daily timeline
    const days24h = fcData.forecast24h?.features?.[0]?.properties?.days;
    if (days24h) {
        let bestItem = null;
        let minDiff = 86400 * 1000 * 1.5;
        for (const day of days24h) {
            if (day.timeline && day.timeline.length > 0) {
                const itemDate = new Date(day.date);
                const diff = Math.abs(itemDate.getTime() - timeMs);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestItem = day.timeline[0];
                }
            }
        }
        if (bestItem) return bestItem;
    }
    return null;
}

function renderWeather() {
    // De-activate all tabs, activate current one
    const tabVida = document.getElementById('tab-vida');
    const tabPortoroz = document.getElementById('tab-portoroz');
    
    if (tabVida) tabVida.classList.remove('active');
    if (tabPortoroz) tabPortoroz.classList.remove('active');
    
    if (activeWeatherSource === 'vida') {
        if (tabVida) tabVida.classList.add('active');
    } else {
        if (tabPortoroz) tabPortoroz.classList.add('active');
    }

    const data = (activeWeatherSource === 'vida') ? weatherDataVida : weatherDataPortoroz;
    
    const timeBadge = document.getElementById('weather-time-badge');
    if (timeBadge) {
        if (data && data.validTime) {
            const mDate = parseArsoXmlDate(data.validTime);
            if (mDate) {
                const timeStr = mDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
                timeBadge.textContent = `Meritev ob ${timeStr}`;
                timeBadge.style.display = 'inline';
            } else {
                timeBadge.style.display = 'none';
            }
        } else {
            timeBadge.style.display = 'none';
        }
    }
    
    if (!data) {
        document.getElementById('weather-desc-val').textContent = 'Nalaganje...';
        document.getElementById('air-temp-val').textContent = '--°C';
        document.getElementById('current-air-temp-val').textContent = '--°C';
        document.getElementById('air-temp-feels-val').textContent = 'Obč. --';
        document.getElementById('current-feels-like-val').textContent = 'Obč. --°C';
        document.getElementById('air-pressure-val').textContent = '-- hPa';
        document.getElementById('humidity-val').textContent = '-- %';
        document.getElementById('wind-speed-val').textContent = '-- km/h';
        document.getElementById('wind-dir-val').textContent = '--';
        document.getElementById('wave-height-val').textContent = '-- m';
        const currentIconBox = document.getElementById('current-weather-icon-box');
        if (currentIconBox) {
            currentIconBox.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="color: var(--text-secondary); font-size: 2.4rem;"></i>';
        }
        return;
    }

    // Determine common weather condition description and icon name (buoy uses airport description as fallback)
    const descData = weatherDataPortoroz || data;
    const weatherDesc = descData.description || 'jasno';
    const weatherIconName = descData.iconName || '';

    // Populate description
    document.getElementById('weather-desc-val').textContent = weatherDesc;

    // Center weather icon box at the top of the sidebar card
    const currentIconBox = document.getElementById('current-weather-icon-box');
    if (currentIconBox) {
        currentIconBox.innerHTML = getWeatherIconHtml(weatherIconName, "2.8rem");
    }

    // Temperature & Apparent Temp (Emphasized and Bold)
    const elAirTemp = document.getElementById('current-air-temp-val');
    const elForecastAirTemp = document.getElementById('air-temp-val');

    if (data.temp !== null && !isNaN(data.temp)) {
        const formattedTemp = `${data.temp.toFixed(1)}°C`;
        if (elForecastAirTemp) elForecastAirTemp.textContent = formattedTemp;
        
        if (elAirTemp) {
            if (data.tempStaleNote) {
                const noteColor = data.tempStaleType === 'error' ? '#ef4444' : '#f59e0b';
                elAirTemp.innerHTML = `
                    <div style="text-align: right; line-height: 1.25;">
                        <div>${formattedTemp}</div>
                        <div style="font-size: 0.72rem; color: ${noteColor}; font-weight: 500; margin-top: 2px;">${data.tempStaleNote}</div>
                    </div>
                `;
            } else {
                elAirTemp.textContent = formattedTemp;
            }
        }
    } else {
        if (elForecastAirTemp) elForecastAirTemp.textContent = '--°C';
        
        if (elAirTemp) {
            if (data.tempStaleNote) {
                const noteColor = '#ef4444';
                elAirTemp.innerHTML = `
                    <div style="text-align: right; line-height: 1.25;">
                        <div>-- °C</div>
                        <div style="font-size: 0.72rem; color: ${noteColor}; font-weight: 500; margin-top: 2px;">${data.tempStaleNote}</div>
                    </div>
                `;
            } else {
                elAirTemp.textContent = '--°C';
            }
        }
    }
    
    // Feels Like
    const elFeelsLike = document.getElementById('current-feels-like-val');
    const elForecastFeelsLike = document.getElementById('air-temp-feels-val');
    if (data.feelsLike !== null && !isNaN(data.feelsLike)) {
        const feelsLikeStr = `Obč. ${Math.round(data.feelsLike)}°C`;
        if (elFeelsLike) elFeelsLike.textContent = feelsLikeStr;
        if (elForecastFeelsLike) elForecastFeelsLike.textContent = feelsLikeStr;
    } else {
        if (elFeelsLike) elFeelsLike.textContent = 'Obč. --';
        if (elForecastFeelsLike) elForecastFeelsLike.textContent = 'Obč. --';
    }

    // Pressure
    const elPressure = document.getElementById('air-pressure-val');
    if (elPressure) {
        if (data.pressure !== null && !isNaN(data.pressure)) {
            const formattedPress = `${Math.round(data.pressure)} hPa`;
            if (data.pressureStaleNote) {
                const noteColor = data.pressureStaleType === 'error' ? '#ef4444' : '#f59e0b';
                elPressure.innerHTML = `
                    <div style="text-align: right; line-height: 1.25;">
                        <div>${formattedPress}</div>
                        <div style="font-size: 0.72rem; color: ${noteColor}; font-weight: 500; margin-top: 2px;">${data.pressureStaleNote}</div>
                    </div>
                `;
            } else {
                elPressure.textContent = formattedPress;
            }
        } else {
            if (data.pressureStaleNote) {
                elPressure.innerHTML = `
                    <div style="text-align: right; line-height: 1.25;">
                        <div>-- hPa</div>
                        <div style="font-size: 0.72rem; color: #ef4444; font-weight: 500; margin-top: 2px;">${data.pressureStaleNote}</div>
                    </div>
                `;
            } else {
                elPressure.textContent = '-- hPa';
            }
        }
    }
    
    // Humidity
    const elHumidity = document.getElementById('humidity-val');
    if (elHumidity) {
        if (data.humidity !== null && !isNaN(data.humidity)) {
            const formattedRh = `${Math.round(data.humidity)}%`;
            if (data.humidityStaleNote) {
                const noteColor = data.humidityStaleType === 'error' ? '#ef4444' : '#f59e0b';
                elHumidity.innerHTML = `
                    <div style="text-align: right; line-height: 1.25;">
                        <div>${formattedRh}</div>
                        <div style="font-size: 0.72rem; color: ${noteColor}; font-weight: 500; margin-top: 2px;">${data.humidityStaleNote}</div>
                    </div>
                `;
            } else {
                elHumidity.textContent = formattedRh;
            }
        } else {
            if (data.humidityStaleNote) {
                elHumidity.innerHTML = `
                    <div style="text-align: right; line-height: 1.25;">
                        <div>-- %</div>
                        <div style="font-size: 0.72rem; color: #ef4444; font-weight: 500; margin-top: 2px;">${data.humidityStaleNote}</div>
                    </div>
                `;
            } else {
                elHumidity.textContent = '-- %';
            }
        }
    }

    // Wind (dual units + Beaufort scale display in separate line)
    const elWindSpeed = document.getElementById('wind-speed-val');
    const elWindDir = document.getElementById('wind-dir-val');

    if (data.windSpeedKmh !== null && !isNaN(data.windSpeedKmh)) {
        const windArrow = getWindArrowHtml(data.windDirDeg);
        const bft = getBeaufortInfo(data.windSpeedKmh);
        const speedMsVal = (data.windSpeedMs !== null && !isNaN(data.windSpeedMs)) ? data.windSpeedMs : 0;
        
        let noteHtml = '';
        if (data.windStaleNote) {
            const noteColor = data.windStaleType === 'error' ? '#ef4444' : '#f59e0b';
            noteHtml = `<div style="font-size: 0.72rem; color: ${noteColor}; font-weight: 500; margin-top: 2px;">${data.windStaleNote}</div>`;
        }

        if (elWindSpeed) {
            elWindSpeed.innerHTML = `
                <div style="text-align: right; line-height: 1.25;">
                    <div>${windArrow}${speedMsVal.toFixed(1)} m/s (${Math.round(data.windSpeedKmh)} km/h)</div>
                    <div style="font-size: 0.72rem; color: var(--text-secondary); font-weight: 500; margin-top: 2px;">${bft.bft} Bft - ${bft.text}</div>
                    ${noteHtml}
                </div>
            `;
        }
        if (elWindDir) {
            let windDirDisplay = data.windDirStr;
            if (!windDirDisplay || /^\d+°?$/.test(windDirDisplay)) {
                windDirDisplay = (data.windSpeedKmh > 0 || speedMsVal > 0) ? getWindDirectionSlo(data.windDirDeg) : 'Brezvetrje';
            }
            elWindDir.textContent = windDirDisplay;
        }
    } else {
        if (elWindSpeed) {
            if (data.windStaleNote) {
                elWindSpeed.innerHTML = `
                    <div style="text-align: right; line-height: 1.25;">
                        <div>-- km/h</div>
                        <div style="font-size: 0.72rem; color: #ef4444; font-weight: 500; margin-top: 2px;">${data.windStaleNote}</div>
                    </div>
                `;
            } else {
                elWindSpeed.textContent = '-- km/h';
            }
        }
        if (elWindDir) {
            elWindDir.textContent = '--';
        }
    }

    // Waves (Vida measurement or Open-Meteo model fallback for Portorož)
    let waveH = data.waveHeight;
    if ((waveH === null || waveH === undefined) && activeWeatherSource === 'portoroz') {
        waveH = weatherDataVida ? weatherDataVida.waveHeight : currentMarineWaveHeight;
    }
    if (waveH !== null && waveH !== undefined && !isNaN(waveH)) {
        const seaState = getDouglasSeaState(waveH);
        document.getElementById('wave-height-val').textContent = `${waveH.toFixed(2)} m - ${seaState.label}`;
    } else {
        document.getElementById('wave-height-val').textContent = '-- m';
    }
}

function updateWaterGauge(relativeLevel) {
    const fill = document.getElementById('water-gauge-fill');
    const pointer = document.getElementById('water-gauge-pointer');
    if (!fill || !pointer) return;
    
    // Scale range: -60 cm to +90 cm (150 cm total range)
    const minScale = -60;
    const maxScale = 90;
    const pct = Math.max(0, Math.min(100, ((relativeLevel - minScale) / (maxScale - minScale)) * 100));
    
    // Set heights
    fill.style.height = `${pct}%`;
    pointer.style.bottom = `${pct}%`;
    
    // Set color based on limits:
    // Green: -30 to +40
    // Yellow: -40 to -30 and +40 to +50
    // Red: below -40 or above +50
    let color = '#22c55e'; // green
    if ((relativeLevel >= -40 && relativeLevel < -30) || (relativeLevel > 40 && relativeLevel <= 50)) {
        color = '#eab308'; // yellow
    } else if (relativeLevel < -40 || relativeLevel > 50) {
        color = '#ef4444'; // red
    }
    
    fill.style.backgroundColor = color;
    pointer.style.borderLeftColor = color;
}

// User-facing function to switch sources
function setWeatherSource(source) {
    if (source === 'vida' || source === 'portoroz') {
        activeWeatherSource = source;
        arsoForecastData = getActiveForecastData();
        
        // Toggle tab button visual state immediately
        const btnPortoroz = document.getElementById('tab-portoroz');
        const btnVida = document.getElementById('tab-vida');
        if (btnPortoroz && btnVida) {
            if (source === 'vida') {
                btnVida.classList.add('active');
                btnPortoroz.classList.remove('active');
            } else {
                btnPortoroz.classList.add('active');
                btnVida.classList.remove('active');
            }
        }
        
        renderWeather();
        renderArsoForecast();
        if (activeHourlyDayOffset !== null) {
            if (activeHourlyDayOffset === 0) {
                renderArso1hForecast();
            } else {
                renderArso3hForecast(activeHourlyDayOffset);
            }
        }
        renderChart();
    }
}
window.setWeatherSource = setWeatherSource;

function renderChart() {
    if (actualData.length === 0) return;
    
    const startTime = actualData[0].time;
    const endTime = actualData[actualData.length - 1].time;
    
    // Predictions window: extend predictions 365 days into the future to see forecasted tides
    const forecastEnd = new Date(endTime.getTime() + (365 * 24 * 60 * 60 * 1000));
    
    // Generate astronomical predictions for the chart period (using 10-minute interval to align with ARSO measurements)
    const predictions = TideCalculator.getPredictionsForPeriod(startTime, forecastEnd, 10);
    
    let series = [];
    let yAxisTitle = '';
    let chartTitle = '';
    
    if (chartMode === 'level') {
        // Map actual levels into relative values
        const actualSeriesData = actualData.map(d => [d.time.getTime(), d.level - MEAN_SEA_LEVEL_OFFSET]);
        
        // Map predicted levels (already relative)
        const predictedSeriesData = predictions.map(d => [d.time.getTime(), d.level]);
        
        // Create a fast lookup map for astronomical predictions to optimize lookup speeds
        const predictionMap = new Map();
        predictions.forEach(p => {
            const roundedTimeMs = Math.round(p.time.getTime() / (10 * 60 * 1000)) * (10 * 60 * 1000);
            predictionMap.set(roundedTimeMs, p.level);
        });
        
        // Calculate rolling seasonal bias offset (Actual - Prediction - Weather) over the last 24 hours
        let totalDiffSum = 0;
        let diffCount = 0;
        
        const latestActualTime = actualData[actualData.length - 1].time;
        const oneDayAgoMs = latestActualTime.getTime() - (24 * 60 * 60 * 1000);
        
        actualData.forEach(d => {
            const timeMs = d.time.getTime();
            if (timeMs >= oneDayAgoMs) {
                const roundedTimeMs = Math.round(timeMs / (10 * 60 * 1000)) * (10 * 60 * 1000);
                const predRel = predictionMap.get(roundedTimeMs);
                
                if (predRel !== undefined) {
                    const hourMs = Math.round(timeMs / (3600 * 1000)) * (3600 * 1000);
                    const meteo = meteoForecastMap.get(hourMs);
                    
                    let meteoEffect = 0;
                    if (meteo) {
                        const pCorr = 1013.25 - meteo.pressureKoper;
                        const grad = meteo.pressureDubrovnik - meteo.pressureKoper;
                        const gradCorr = 2.0 * grad; // 2 cm of surge per hPa pressure difference
                        meteoEffect = pCorr + gradCorr;
                    }
                    
                    const actualRel = d.level - MEAN_SEA_LEVEL_OFFSET;
                    
                    // Difference after subtracting both astro prediction and meteo correction
                    const diff = actualRel - (predRel + meteoEffect);
                    totalDiffSum += diff;
                    diffCount++;
                }
            }
        });
        
        const biasOffset = diffCount > 0 ? (totalDiffSum / diffCount) : 0;
        console.log(`Calculated weather-corrected rolling bias: ${biasOffset.toFixed(2)} cm over ${diffCount} points.`);
        
        // Calculate hybrid predictions (astronomical tide + rolling bias + pressure-gradient weather correction)
        const hybridSeriesData = [];
        predictions.forEach(d => {
            const timeMs = d.time.getTime();
            
            // Find closest hourly weather data point (round to nearest hour)
            const hourMs = Math.round(timeMs / (3600 * 1000)) * (3600 * 1000);
            const meteo = meteoForecastMap.get(hourMs);
            
            if (meteo) {
                const pCorr = 1013.25 - meteo.pressureKoper;
                const grad = meteo.pressureDubrovnik - meteo.pressureKoper;
                const gradCorr = 2.0 * grad;
                const meteoEffect = pCorr + gradCorr;
                
                // Hybrid level = astronomical + seasonal bias + meteorological correction
                const hybridVal = d.level + biasOffset + meteoEffect;
                hybridSeriesData.push([timeMs, hybridVal]);
            }
        });
        
        series = [
            {
                name: 'Izmerjena gladina (ARSO)',
                data: actualSeriesData,
                type: 'spline',
                color: '#f97316', // High-contrast orange
                shadow: {
                    color: 'rgba(249, 115, 22, 0.35)',
                    width: 4,
                    offsetX: 0,
                    offsetY: 2
                },
                marker: { enabled: false, states: { hover: { enabled: true, radius: 5 } } }
            },
            {
                name: 'Napovedano plimovanje (NIB MBP)',
                data: predictedSeriesData,
                type: 'spline',
                color: '#10b981', // Distinct green
                dashStyle: 'ShortDash',
                opacity: 0.85,
                marker: { enabled: false }
            },
            {
                name: 'Hibridna napoved (astronomija + zračni tlak in veter)',
                data: hybridSeriesData,
                type: 'spline',
                color: '#eab308', // Vivid yellow
                dashStyle: 'ShortDot',
                opacity: 0.95,
                visible: true,
                marker: { enabled: false }
            }
        ];
        
        yAxisTitle = 'Relativna gladina morja (cm)';
        chartTitle = 'Primerjava izmerjene in napovedane gladine morja';
    } else {
        // Temperature Mode
        const tempSeriesData = actualData.map(d => [d.time.getTime(), d.temp]);
        series = [
            {
                name: 'Temperatura morja (ARSO)',
                data: tempSeriesData,
                type: 'spline',
                color: '#f43f5e',
                shadow: {
                    color: 'rgba(244, 63, 94, 0.4)',
                    width: 4,
                    offsetX: 0,
                    offsetY: 2
                },
                marker: { enabled: false, states: { hover: { enabled: true, radius: 5 } } }
            }
        ];
        
        yAxisTitle = 'Temperatura (°C)';
        chartTitle = 'Temperatura morja v zadnjem obdobju';
    }
    
    // Dynamic theme colors for Highcharts
    const isLight = document.body.classList.contains('light-theme');
    const titleColor = isLight ? '#0f172a' : '#f8fafc';
    const labelColor = isLight ? '#475569' : '#94a3b8';
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
    const zeroLineCol = isLight ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.2)';
    
    // Calculate visible extremes based on periodHours
    const latestTimeVal = endTime.getTime();
    const minTime = latestTimeVal - (periodHours * 60 * 60 * 1000);
    const maxTime = chartMode === 'level' ? latestTimeVal + (periodHours * 60 * 60 * 1000) : latestTimeVal;
    
    // Render Highcharts Stock
    currentChart = Highcharts.stockChart('sea-level-chart', {
        exporting: {
            enabled: false // Disable the exporting burger menu to prevent overlap with fullscreen button
        },
        chart: {
            style: { fontFamily: 'Inter' },
            spacingBottom: 5,
            panning: {
                enabled: true,
                type: 'x'
            },
            pinchType: 'x',
            zoomType: null
        },
        time: {
            useUTC: false
        },
        title: {
            text: null // Disable title entirely for cleaner UI and maximum vertical chart space
        },
        credits: { enabled: false },
        rangeSelector: {
            enabled: false // Custom HTML buttons control this
        },
        scrollbar: {
            enabled: false
        },
        navigator: {
            enabled: false
        },
        xAxis: {
            type: 'datetime',
            gridLineWidth: 1,
            labels: {
                style: { color: labelColor },
                formatter: function () {
                    const date = new Date(this.value);
                    const hours = date.getHours();
                    const minutes = date.getMinutes();
                    
                    // If it is midnight, display day name and date (e.g. Pon 10. 8.)
                    if (hours === 0 && minutes === 0) {
                        const days = ['Ned', 'Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob'];
                        const dayName = days[date.getDay()];
                        const day = date.getDate();
                        const month = date.getMonth() + 1;
                        return `<b>${dayName} ${day}. ${month}.</b>`;
                    }
                    
                    // Otherwise, display time
                    return Highcharts.dateFormat('%H:%M', this.value);
                }
            },
            min: minTime,
            max: maxTime,
            plotLines: [{
                value: endTime.getTime(),
                color: '#ef4444',
                width: 2,
                dashStyle: 'ShortDot',
                label: {
                    text: 'Sedaj',
                    align: 'right',
                    x: -8, // Shift to the left of the line so it doesn't clip on the right edge
                    y: 30, // Move lower to make it fully visible
                    style: { color: '#ef4444', fontWeight: 'bold' }
                },
                zIndex: 5
            }],
            ordinal: false
        },
        yAxis: {
            title: {
                text: yAxisTitle,
                style: { color: labelColor }
            },
            gridLineColor: gridColor,
            labels: { style: { color: labelColor } },
            plotLines: chartMode === 'level' ? [{
                value: 0,
                color: zeroLineCol,
                width: 1.5,
                dashStyle: 'Dash',
                label: {
                    text: 'Srednje morje (0 cm)',
                    align: 'left',
                    style: { color: isLight ? '#475569' : '#64748b', fontSize: '10px' },
                    x: 10
                },
                zIndex: 1
            }] : []
        },
        tooltip: {
            split: false,
            shared: true,
            crosshairs: true,
            useHTML: true,
            followTouchMove: false,
            outside: true,
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            borderWidth: 0,
            borderRadius: 0,
            shadow: false,
            padding: 0,
            style: {
                color: isLight ? '#0f172a' : '#f8fafc',
                fontSize: '11px',
                fontFamily: 'Inter, sans-serif',
                zIndex: 9999
            },
            formatter: function () {
                const days = ['Nedelja', 'Ponedeljek', 'Torek', 'Sreda', 'Četrtek', 'Petek', 'Sobota'];
                const dateObj = new Date(this.x);
                const dayName = days[dateObj.getDay()];
                const dayStr = String(dateObj.getDate()).padStart(2, '0') + '.' + String(dateObj.getMonth() + 1).padStart(2, '0') + '.';
                const timeStr = Highcharts.dateFormat('%H:%M', this.x);
                
                let s = `<div class="chart-custom-tooltip" style="
                    background: ${isLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(15, 23, 42, 0.96)'};
                    border: 1px solid ${isLight ? 'rgba(14, 165, 233, 0.45)' : 'rgba(56, 189, 248, 0.4)'};
                    border-radius: 12px;
                    padding: 8px 10px;
                    min-width: 155px;
                    box-shadow: 0 4px 16px ${isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.65)'};
                    color: ${isLight ? '#0f172a' : '#f8fafc'};
                    box-sizing: border-box;
                ">`;
                
                s += `<div style="font-weight:700; font-size:11px; margin-bottom:4px; color:${isLight ? '#0f172a' : '#f8fafc'}; border-bottom:1px solid ${isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.12)'}; padding-bottom:3px;">
                        ${dayName}, ${dayStr} ob ${timeStr}
                      </div>`;
                
                s += `<div style="display:flex; flex-direction:column; gap:2px; margin-bottom:3px;">`;
                this.points.forEach(point => {
                    if (chartMode === 'level') {
                        const relVal = Math.round(point.y);
                        const sign = relVal >= 0 ? '+' : '';
                        let prefix = 'Napoved';
                        if (point.series.name.includes('Izmerjena')) {
                            prefix = 'Meritev';
                        } else if (point.series.name.includes('Hibridna')) {
                            prefix = 'Hibrid';
                        }
                        s += `<div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
                                <span style="font-size:10px;"><span style="color:${point.color}; font-size:12px;">●</span> ${prefix}:</span>
                                <span style="font-weight:700; font-family:'Outfit', sans-serif;">${sign}${relVal} cm</span>
                              </div>`;
                    } else {
                        const val = point.y.toFixed(1);
                        s += `<div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
                                <span style="font-size:10px;"><span style="color:${point.color}; font-size:12px;">●</span> Temp:</span>
                                <span style="font-weight:700; font-family:'Outfit', sans-serif;">${val} °C</span>
                              </div>`;
                    }
                });
                s += `</div>`;
                
                // Weather preview lookup for this timestamp - ONLY for current and future points!
                const nowMs = Date.now();
                const pointTimeMs = dateObj.getTime();
                
                if (pointTimeMs >= nowMs - (30 * 60 * 1000)) {
                    const fcItem = getForecastItemForTime(dateObj);
                    if (fcItem) {
                        const tVal = Math.round(parseFloat(fcItem.t));
                        const iconName = fcItem.clouds_icon_wwsyn_icon || "";
                        const windSpeedKmh = Math.round(parseFloat(fcItem.ff_val || "0"));
                        const windDir = fcItem.dd_shortText || "";
                        const windDirDeg = getWindDegFromSlo(windDir);
                        const windArrow = getWindArrowUnicode(windDirDeg);
                        const waveH = getWaveHeightForTime(dateObj);
                        const waveHtml = getWaveTooltipHtml(waveH);
                        
                        s += `<div style="margin-top:8px; padding-top:6px; border-top:1px dashed ${isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.15)'}; display:flex; flex-direction:column; gap:5px;">
                                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                                    <div style="display:flex; align-items:center; gap:5px;">
                                        ${getWeatherIconHtml(iconName, "1.15rem")}
                                        <span style="font-weight:700; font-size:11px;">${tVal}°C</span>
                                    </div>
                                    <div style="font-size:10.5px; font-weight:600; display:flex; align-items:center; gap:4px;">
                                        <span style="font-weight:bold; font-size:12px;">${windArrow}</span><span>${windSpeedKmh} km/h</span>
                                    </div>
                                </div>
                                <div style="display:flex; align-items:center; justify-content:flex-end;">
                                    ${waveHtml}
                                </div>
                              </div>`;
                    }
                }
                
                s += `</div>`;
                return s;
            }
        },
        legend: {
            enabled: true,
            align: 'center',
            verticalAlign: 'bottom',
            layout: 'horizontal',
            margin: 5,
            padding: 2,
            itemDistance: 10,
            itemStyle: { color: labelColor, fontSize: '10px' },
            itemHoverStyle: { color: titleColor }
        },
        plotOptions: {
            spline: {
                lineWidth: 2.5
            },
            series: {
                dataGrouping: {
                    enabled: false
                }
            }
        },
        series: series
    });
}

// Toggle custom CSS-based pseudo-fullscreen mode for mobile/desktop
function toggleFullscreen() {
    const chartCard = document.querySelector('.chart-container-card');
    const fsBtn = document.getElementById('fullscreen-btn');
    
    if (!chartCard) return;
    
    const isFullscreen = chartCard.classList.toggle('fullscreen-active');
    document.body.classList.toggle('fullscreen-open', isFullscreen); // Add/remove body layout override class
    
    if (isFullscreen) {
        fsBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
        fsBtn.title = "Izhod iz celozaslonskega načina";
    } else {
        fsBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        fsBtn.title = "Celozaslonski način";
    }
    
    if (currentChart) {
        setTimeout(() => {
            currentChart.reflow();
        }, 150); // Small timeout to allow CSS hide animations/transitions to finish before reflowing the chart size
    }
}

// Draw realistic dynamic moon sphere with exact astronomical terminator shading
function drawRealisticMoon(ageDays) {
    const canvas = document.getElementById('moon-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const r = (w / 2) - 3;
    const cx = w / 2;
    const cy = h / 2;
    
    ctx.clearRect(0, 0, w, h);
    
    // 1. Draw base dark sphere (night side of the Moon)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    
    // Dark surface gradient
    const darkGrad = ctx.createRadialGradient(cx - r*0.3, cy - r*0.3, r*0.1, cx, cy, r);
    darkGrad.addColorStop(0, '#2d3748');
    darkGrad.addColorStop(0.8, '#1e293b');
    darkGrad.addColorStop(1, '#0f172a');
    ctx.fillStyle = darkGrad;
    ctx.fill();
    
    // Subtle maria markings on dark side
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    ctx.arc(cx - r*0.25, cy - r*0.2, r*0.32, 0, Math.PI * 2);
    ctx.arc(cx + r*0.28, cy + r*0.15, r*0.24, 0, Math.PI * 2);
    ctx.arc(cx - r*0.1, cy + r*0.38, r*0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    
    // 2. Draw illuminated portion
    const synodic = 29.530588853;
    const phase = ((ageDays % synodic) + synodic) % synodic / synodic; // 0.0 to 1.0
    
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    
    ctx.beginPath();
    if (phase < 0.5) {
        // Waxing (Rastoča): Illuminated on the RIGHT (0 = new, 0.25 = 1st quarter, 0.5 = full)
        ctx.arc(cx, cy, r, -Math.PI/2, Math.PI/2, false);
        const k = Math.cos(phase * 2 * Math.PI); // 1 (new) -> 0 (1st quarter) -> -1 (full)
        ctx.ellipse(cx, cy, Math.max(0.1, Math.abs(r * k)), r, 0, Math.PI/2, -Math.PI/2, k > 0);
    } else {
        // Waning (Padajoča): Illuminated on the LEFT (0.5 = full, 0.75 = last quarter, 1.0 = new)
        ctx.arc(cx, cy, r, Math.PI/2, -Math.PI/2, false);
        const k = Math.cos(phase * 2 * Math.PI); // -1 (full) -> 0 (last quarter) -> 1 (new)
        ctx.ellipse(cx, cy, Math.max(0.1, Math.abs(r * k)), r, 0, -Math.PI/2, Math.PI/2, k > 0);
    }
    ctx.closePath();
    
    // Lit moon surface texture & gradient
    const litGrad = ctx.createRadialGradient(cx - r*0.3, cy - r*0.3, r*0.05, cx, cy, r);
    litGrad.addColorStop(0, '#ffffff');
    litGrad.addColorStop(0.3, '#f8fafc');
    litGrad.addColorStop(0.7, '#e2e8f0');
    litGrad.addColorStop(1, '#94a3b8');
    ctx.fillStyle = litGrad;
    ctx.fill();
    
    // Maria / crater textures on lit side
    ctx.fillStyle = 'rgba(100, 116, 139, 0.28)';
    ctx.beginPath();
    ctx.arc(cx - r*0.28, cy - r*0.22, r*0.3, 0, Math.PI * 2);
    ctx.arc(cx + r*0.25, cy + r*0.12, r*0.24, 0, Math.PI * 2);
    ctx.arc(cx - r*0.08, cy + r*0.35, r*0.22, 0, Math.PI * 2);
    ctx.arc(cx + r*0.15, cy - r*0.32, r*0.16, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
    
    // 3. Subtle outer rim glow / 3D sphere illusion
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
}

// Calculate moon phase client-side based on astronomical cycle
function updateMoonPhase() {
    const now = new Date();
    
    // Reference New Moon: Jan 6, 2000 18:14 UTC (947182440000 ms)
    const refNewMoon = 947182440000;
    const synodicMonth = 2551442977; // ms (29.530588853 days)
    
    const diffMs = now.getTime() - refNewMoon;
    const ageDays = ((diffMs % synodicMonth) + synodicMonth) % synodicMonth / 86400000;
    
    let phaseName = "";
    
    if (ageDays < 1.0 || ageDays >= 28.53) {
        phaseName = "Prazna Luna - Mlaj";
    } else if (ageDays < 6.38) {
        phaseName = "Rastoča Luna";
    } else if (ageDays < 8.38) {
        phaseName = "Prvi krajec";
    } else if (ageDays < 13.76) {
        phaseName = "Rastoča Luna";
    } else if (ageDays < 15.76) {
        phaseName = "Polna Luna - Ščip";
    } else if (ageDays < 21.15) {
        phaseName = "Padajoča Luna";
    } else if (ageDays < 23.15) {
        phaseName = "Zadnji krajec";
    } else {
        phaseName = "Padajoča Luna";
    }
    
    // Draw realistic dynamic moon sphere on Canvas
    drawRealisticMoon(ageDays);
    
    // Calculate Tide Coefficient (0 = Neap, 100 = Spring)
    // Spring tide occurs at New Moon (0) and Full Moon (14.765)
    const cyclePos = ageDays % 14.7654;
    const dist = Math.min(cyclePos, 14.7654 - cyclePos);
    const coeff = Math.round(100 - (dist / 7.3827) * 100);
    
    let coeffDesc = "";
    if (coeff >= 75) {
        coeffDesc = `<span class="coeff-spring">Močno plimovanje</span> (sizigijsko, ${coeff}%)`;
    } else if (coeff <= 25) {
        coeffDesc = `<span class="coeff-neap">Šibko plimovanje</span> (kvadraturno, ${coeff}%)`;
    } else {
        coeffDesc = `Srednje plimovanje (${coeff}%)`;
    }
    
    // Calculate the next principal phase (Mlaj, Prvi krajec, Ščip, Zadnji krajec)
    const cycleProgress = ((diffMs % synodicMonth) + synodicMonth) % synodicMonth / synodicMonth;
    const principalPhases = [
        { ratio: 0.0, name: "Prazna Luna - Mlaj", prefix: "Naslednja prazna luna - mlaj" },
        { ratio: 0.25, name: "Prvi krajec", prefix: "Naslednji prvi krajec" },
        { ratio: 0.5, name: "Polna Luna - Ščip", prefix: "Naslednja polna luna - ščip" },
        { ratio: 0.75, name: "Zadnji krajec", prefix: "Naslednji zadnji krajec" }
    ];
    
    // If we are currently experiencing a principal phase, announce the SUBSEQUENT one!
    let nextTargetRatio = null;
    if (phaseName === "Prazna Luna - Mlaj") nextTargetRatio = 0.25; // Next is Prvi krajec
    else if (phaseName === "Prvi krajec") nextTargetRatio = 0.5;   // Next is Ščip
    else if (phaseName === "Polna Luna - Ščip") nextTargetRatio = 0.75; // Next is Zadnji krajec
    else if (phaseName === "Zadnji krajec") nextTargetRatio = 0.0;     // Next is Mlaj
    
    let nextP = null;
    if (nextTargetRatio !== null) {
        nextP = principalPhases.find(p => p.ratio === nextTargetRatio);
    } else {
        let minDiff = 2.0;
        for (const p of principalPhases) {
            let diff = p.ratio - cycleProgress;
            if (diff <= 0.001) diff += 1.0; // Wrap around if we are past or at the phase
            if (diff < minDiff) {
                minDiff = diff;
                nextP = p;
            }
        }
    }
    
    let diffToNext = nextP.ratio - cycleProgress;
    if (diffToNext <= 0.001) diffToNext += 1.0;
    const timeToNextMs = diffToNext * synodicMonth;
    const nextPhaseDate = new Date(now.getTime() + timeToNextMs);
    
    const dayStr = String(nextPhaseDate.getDate()).padStart(2, '0') + '.' + 
                   String(nextPhaseDate.getMonth() + 1).padStart(2, '0') + '.' + 
                   nextPhaseDate.getFullYear();
    const hourStr = nextPhaseDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
    const nextPhaseText = `${nextP.prefix} ${dayStr} ob ${hourStr}`;
    
    // For principal phases, calculate the exact moment of the current phase
    let currentPhaseExactMoment = "";
    if (phaseName === "Prazna Luna - Mlaj" || phaseName === "Prvi krajec" || phaseName === "Polna Luna - Ščip" || phaseName === "Zadnji krajec") {
        let currentTargetRatio = 0.0;
        if (phaseName === "Prvi krajec") currentTargetRatio = 0.25;
        else if (phaseName === "Polna Luna - Ščip") currentTargetRatio = 0.5;
        else if (phaseName === "Zadnji krajec") currentTargetRatio = 0.75;
        
        let diffToCurrent = currentTargetRatio - cycleProgress;
        if (diffToCurrent > 0.5) diffToCurrent -= 1.0;
        if (diffToCurrent < -0.5) diffToCurrent += 1.0;
        
        const currentPhaseDate = new Date(now.getTime() + (diffToCurrent * synodicMonth));
        const cDayStr = String(currentPhaseDate.getDate()).padStart(2, '0') + '.' + 
                        String(currentPhaseDate.getMonth() + 1).padStart(2, '0') + '.';
        const cHourStr = currentPhaseDate.toLocaleTimeString('sl-SI', { hour: '2-digit', minute: '2-digit' });
        
        currentPhaseExactMoment = ` (${cDayStr} ob ${cHourStr})`;
    }
    
    // Update UI elements
    const phaseNameEl = document.getElementById('moon-phase-name');
    const coeffValEl = document.getElementById('moon-coeff-val');
    const nextPhaseEl = document.getElementById('moon-next-phase');
    
    if (phaseNameEl) phaseNameEl.textContent = `${phaseName}${currentPhaseExactMoment}`;
    if (coeffValEl) coeffValEl.innerHTML = `Tip: ${coeffDesc}`;
    if (nextPhaseEl) nextPhaseEl.textContent = nextPhaseText;
}

// Toggle between light and dark themes
function toggleTheme() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateThemeIcon();
    
    // Re-render chart to apply new theme colors
    renderChart();
}

function updateThemeIcon() {
    const icon = document.getElementById('theme-icon-indicator');
    if (!icon) return;
    
    if (document.body.classList.contains('light-theme')) {
        // In light theme, show a Moon icon (click to switch to dark theme)
        icon.className = 'fa-solid fa-moon';
        icon.style.color = '#475569';
    } else {
        // In dark theme, show a Sun icon (click to switch to light theme)
        icon.className = 'fa-solid fa-sun';
        icon.style.color = '#e2e8f0';
    }
}

// =========================================================================
// 3-Tab Main Navigation, GPS Marine Dashboard, Nautical Map & Multi-Waypoint Router
// =========================================================================

const MAGNETIC_DECLINATION_SLOVENIA = 4.0; // Stopinj proti vzhodu za slovensko morje / severni Jadran

let phoneMagneticHeading = 0;
let orientationActive = false;
let lastGpsSpeedKnots = 0;
let currentDialAngle = 0;
let currentNeedleAngle = 0;
let lastGpsCoords = null; // { latitude, longitude, speed, heading, accuracy }

// Nautical Map & Routing State
let navMap = null;
let navMapLayers = {};
let currentNavMapLayerType = 'osm';
let showDepthContours = false;
let depthWmsLayer = null;
let depthVectorLayerGroup = null;

let navBoatMarker = null;
let navPlannedRoutePolyline = null;
let navRecordedTrackPolyline = null;
let navPastCruisePolyline = null;
let navPastCruiseMarkers = [];

// Multi-Waypoint Planner State
let routeWaypoints = [
    { id: 'start', type: 'start', lat: null, lon: null, isGps: true, label: 'Moja lokacija (GPS)' },
    { id: 'dest', type: 'dest', lat: null, lon: null, label: 'Kliknite na karto za izbiro cilja' }
];
let activeWaypointTargetId = 'dest';
let intermediateWpCounter = 1;
let waypointMarkers = {};
let currentCalculatedRouteCoords = [];

// Cruise Recording & Telemetry State
let isCruiseActive = false;
let cruiseStartTime = null;
let cruiseDurationTimer = null;
let cruiseTrackPoints = [];
let cruiseTotalDistanceNm = 0;
let cruiseMaxSpeedKnots = 0;
let lastRecordedGpsPos = null;
let cruiseWakeLock = null;
let hasCenteredInitialGps = false;

// Haversine Distance in meters between two lat/lon coordinates
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Initial Bearing in degrees (0 - 360) from point 1 to point 2
function calculateBearing(lat1, lon1, lat2, lon2) {
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
    const theta = Math.atan2(y, x);
    return (theta * 180 / Math.PI + 360) % 360;
}

// Format duration in seconds to mm:ss or hh:mm:ss
function formatDuration(sec) {
    if (isNaN(sec) || sec < 0) return '--:--';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (hrs > 0) {
        return `${hrs}h ${String(mins).padStart(2, '0')}m`;
    }
    return `${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Complete Slovenian Coastline Closed Polygon (Accurate high-res shoreline - land is inside)
const SLO_COASTLINE_POLYGON = [
    [45.5975, 13.7230], // Lazaret IT border
    [45.5940, 13.7080],
    [45.5922, 13.7005],
    [45.5908, 13.6980], // Debeli rtic tip
    [45.5890, 13.7010],
    [45.5865, 13.7080],
    [45.5820, 13.7220], // Valdoltra
    [45.5780, 13.7310],
    [45.5710, 13.7430], // Sv. Katarina
    [45.5650, 13.7450],
    [45.5560, 13.7400], // Luka Koper
    [45.5520, 13.7340],
    [45.5485, 13.7285], // Koper Center
    [45.5468, 13.7250],
    [45.5455, 13.7180], // Semedela
    [45.5442, 13.7110], // Zusterna
    [45.5430, 13.6960],
    [45.5410, 13.6830],
    [45.5400, 13.6750], // Vilizan
    [45.5408, 13.6650], // Izola East
    [45.5425, 13.6610],
    [45.5448, 13.6555], // Izola Punta
    [45.5442, 13.6515],
    [45.5415, 13.6500],
    [45.5360, 13.6480], // San Simon
    [45.5345, 13.6430],
    [45.5360, 13.6330], // Bele skale
    [45.5370, 13.6230],
    [45.5385, 13.6120],
    [45.5408, 13.6060], // Rt Ronek
    [45.5395, 13.5990],
    [45.5365, 13.5970],
    [45.5315, 13.6010], // Strunjan
    [45.5285, 13.5950],
    [45.5258, 13.5855], // Pacug
    [45.5260, 13.5780], // Fiesa
    [45.5265, 13.5710],
    [45.5283, 13.5658], // Punta Piran
    [45.5286, 13.5650],
    [45.5278, 13.5645],
    [45.5255, 13.5670], // Piran Mandrac
    [45.5235, 13.5685],
    [45.5195, 13.5700], // Bernardin
    [45.5155, 13.5715],
    [45.5132, 13.5750],
    [45.5130, 13.5850], // Portoroz Center
    [45.5110, 13.5920],
    [45.5035, 13.5990], // Lucija
    [45.4980, 13.5980],
    [45.4970, 13.5915], // Rt Seca
    [45.4945, 13.5900],
    [45.4915, 13.5940],
    [45.4850, 13.6000], // Secovlje
    [45.4750, 13.6050],
    // Close through inland hinterland
    [45.4700, 13.6200],
    [45.4600, 13.7000],
    [45.5000, 13.7800],
    [45.5800, 13.8000],
    [45.6100, 13.7500],
    [45.5975, 13.7230]
];

// Accurate 200m Guide Nodes (Real measured 200m seaward offset buffer from Lazaret to Secovlje)
const SLO_COAST_200M_GUIDE_NODES = [
    [45.5990, 13.7200], // 0 Lazaret
    [45.5955, 13.7060], // 1 Debeli rtic NE
    [45.5938, 13.6990], // 2 Debeli rtic N
    [45.5920, 13.6945], // 3 Debeli rtic Tip W
    [45.5890, 13.6970], // 4 Debeli rtic SW
    [45.5865, 13.7050], // 5 Debeli rtic S
    [45.5835, 13.7190], // 6 Valdoltra
    [45.5740, 13.7380], // 7 Sv. Katarina
    [45.5600, 13.7340], // 8 Luka Koper N
    [45.5535, 13.7270], // 9 Luka Koper W
    [45.5510, 13.7225], // 10 Koper Mandrac Approach
    [45.5475, 13.7150], // 11 Semedela
    [45.5465, 13.7080], // 12 Zusterna W
    [45.5450, 13.6930], // 13 Rex
    [45.5430, 13.6800], // 14 Vilizan
    [45.5435, 13.6680], // 15 Izola Marina Approach E
    [45.5465, 13.6600], // 16 Izola N
    [45.5475, 13.6535], // 17 Izola Punta Apex (200m NW)
    [45.5455, 13.6485], // 18 Izola Punta SW
    [45.5425, 13.6475], // 19 Izola Mandrac / San Simon Approach
    [45.5380, 13.6450], // 20 San Simon
    [45.5385, 13.6360], // 21 Bele skale E
    [45.5395, 13.6240], // 22 Bele skale W
    [45.5410, 13.6140], // 23 Rt Ronek E
    [45.5430, 13.6065], // 24 Rt Ronek Apex (200m N of cliff)
    [45.5415, 13.5985], // 25 Mesecev zaliv W
    [45.5375, 13.5960], // 26 Strunjan bay entrance
    [45.5330, 13.5965], // 27 Strunjan Beach 200m
    [45.5285, 13.5835], // 28 Pacug (200m N)
    [45.5288, 13.5745], // 29 Fiesa (200m N)
    [45.5310, 13.5670], // 30 Punta Piran NE
    [45.5305, 13.5650], // 31 Punta Piran North (200m N of light)
    [45.5288, 13.5625], // 32 Punta Piran Apex West (200m W of tip)
    [45.5268, 13.5630], // 33 Punta Piran SW (200m SW)
    [45.5245, 13.5660], // 34 Piran Mandrac Approach S
    [45.5185, 13.5685], // 35 Fornace 200m
    [45.5145, 13.5695], // 36 Bernardin Apex 200m
    [45.5125, 13.5750], // 37 Bernardin S 200m
    [45.5118, 13.5850], // 38 Portoroz Center Beach 200m
    [45.5095, 13.5930], // 39 Portoroz East 200m
    [45.5020, 13.5940], // 40 Marina Portoroz Entrance 200m
    [45.4965, 13.5880], // 41 Rt Seca 200m
    [45.4835, 13.5960]  // 42 Secovlje / Dragonja 200m
];

// Precompute 100m dense interpolation along the 200m chain (~280 points)
function generateDenseCoastalChain(guideNodes, maxSpacingMeters) {
    const dense = [];
    for (let i = 0; i < guideNodes.length - 1; i++) {
        const pA = guideNodes[i];
        const pB = guideNodes[i + 1];
        const dist = haversineDistanceMeters(pA[0], pA[1], pB[0], pB[1]);
        const steps = Math.max(1, Math.ceil(dist / maxSpacingMeters));
        for (let s = 0; s < steps; s++) {
            const t = s / steps;
            const lat = pA[0] + t * (pB[0] - pA[0]);
            const lon = pA[1] + t * (pB[1] - pA[1]);
            dense.push([lat, lon]);
        }
    }
    dense.push(guideNodes[guideNodes.length - 1]);
    return dense;
}

const SLO_COAST_200M_CHAIN = generateDenseCoastalChain(SLO_COAST_200M_GUIDE_NODES, 100);

function segmentsIntersect2D(lat1, lon1, lat2, lon2, lat3, lon3, lat4, lon4) {
    function ccw(ax, ay, bx, by, cx, cy) {
        return ((cy - ay) * (bx - ax)) - ((by - ay) * (cx - ax));
    }
    const ccw1 = ccw(lon1, lat1, lon3, lat3, lon4, lat4);
    const ccw2 = ccw(lon2, lat2, lon3, lat3, lon4, lat4);
    const ccw3 = ccw(lon1, lat1, lon2, lat2, lon3, lat3);
    const ccw4 = ccw(lon1, lat1, lon2, lat2, lon4, lat4);
    return ((ccw1 * ccw2 < 0) && (ccw3 * ccw4 < 0));
}

function isPointInPolygon(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect = ((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function hasLineOfSight(lat1, lon1, lat2, lon2) {
    for (let i = 0; i < SLO_COASTLINE_POLYGON.length - 1; i++) {
        const pA = SLO_COASTLINE_POLYGON[i];
        const pB = SLO_COASTLINE_POLYGON[i + 1];
        if (segmentsIntersect2D(lat1, lon1, lat2, lon2, pA[0], pA[1], pB[0], pB[1])) {
            return false;
        }
    }
    for (let s = 1; s <= 4; s++) {
        const t = s / 5;
        const midLat = lat1 + t * (lat2 - lat1);
        const midLon = lon1 + t * (lon2 - lon1);
        if (isPointInPolygon(midLat, midLon, SLO_COASTLINE_POLYGON)) {
            return false;
        }
    }
    return true;
}

// Tangent Line-Of-Sight Visibility Route calculation between two nautical points
function getSafeMarineSegment(lat1, lon1, lat2, lon2, useRules) {
    if (!useRules) {
        return [[lat1, lon1], [lat2, lon2]];
    }

    // Direct line of sight check over open water
    if (hasLineOfSight(lat1, lon1, lat2, lon2)) {
        return [[lat1, lon1], [lat2, lon2]];
    }

    // Find nearest anchor points on the 200m buffer chain
    let idxA = 0, minDistA = Infinity;
    let idxB = 0, minDistB = Infinity;
    for (let i = 0; i < SLO_COAST_200M_CHAIN.length; i++) {
        const pt = SLO_COAST_200M_CHAIN[i];
        const dA = haversineDistanceMeters(lat1, lon1, pt[0], pt[1]);
        if (dA < minDistA && hasLineOfSight(lat1, lon1, pt[0], pt[1])) {
            minDistA = dA; idxA = i;
        }
        const dB = haversineDistanceMeters(lat2, lon2, pt[0], pt[1]);
        if (dB < minDistB && hasLineOfSight(lat2, lon2, pt[0], pt[1])) {
            minDistB = dB; idxB = i;
        }
    }

    if (minDistA === Infinity) {
        for (let i = 0; i < SLO_COAST_200M_CHAIN.length; i++) {
            const dA = haversineDistanceMeters(lat1, lon1, SLO_COAST_200M_CHAIN[i][0], SLO_COAST_200M_CHAIN[i][1]);
            if (dA < minDistA) { minDistA = dA; idxA = i; }
        }
    }
    if (minDistB === Infinity) {
        for (let i = 0; i < SLO_COAST_200M_CHAIN.length; i++) {
            const dB = haversineDistanceMeters(lat2, lon2, SLO_COAST_200M_CHAIN[i][0], SLO_COAST_200M_CHAIN[i][1]);
            if (dB < minDistB) { minDistB = dB; idxB = i; }
        }
    }

    const subChain = [];
    if (idxA <= idxB) {
        for (let i = idxA; i <= idxB; i++) subChain.push(SLO_COAST_200M_CHAIN[i]);
    } else {
        for (let i = idxA; i >= idxB; i--) subChain.push(SLO_COAST_200M_CHAIN[i]);
    }

    const route = [[lat1, lon1]];
    let currPos = [lat1, lon1];
    let currIdx = 0;

    let firstVisibleIdx = 0;
    for (let k = subChain.length - 1; k >= 0; k--) {
        if (hasLineOfSight(currPos[0], currPos[1], subChain[k][0], subChain[k][1])) {
            firstVisibleIdx = k;
            break;
        }
    }
    route.push(subChain[firstVisibleIdx]);
    currPos = subChain[firstVisibleIdx];
    currIdx = firstVisibleIdx;

    while (currIdx < subChain.length - 1) {
        if (hasLineOfSight(currPos[0], currPos[1], lat2, lon2)) {
            break;
        }

        let furthestIdx = currIdx + 1;
        for (let k = subChain.length - 1; k > currIdx; k--) {
            const cand = subChain[k];
            if (hasLineOfSight(currPos[0], currPos[1], cand[0], cand[1])) {
                furthestIdx = k;
                break;
            }
        }

        route.push(subChain[furthestIdx]);
        currPos = subChain[furthestIdx];
        currIdx = furthestIdx;
    }

    route.push([lat2, lon2]);
    return route;
}

// 3-Tab Main Tab Switching
function setActiveMainTab(tabName) {
    activeMainTab = tabName;
    
    // 1. Update Tab Bar Buttons
    const btnTides = document.getElementById('btn-tab-tides');
    const btnWeather = document.getElementById('btn-tab-weather');
    const btnNav = document.getElementById('btn-tab-nav');
    
    if (btnTides) btnTides.classList.toggle('active', tabName === 'plimovanje');
    if (btnWeather) btnWeather.classList.toggle('active', tabName === 'vreme');
    if (btnNav) btnNav.classList.toggle('active', tabName === 'navigacija');
    
    // 2. Update Tab Panes
    const paneTides = document.getElementById('pane-tides');
    const paneWeather = document.getElementById('pane-weather');
    const paneNav = document.getElementById('pane-navigation');
    
    if (paneTides) {
        paneTides.classList.toggle('active', tabName === 'plimovanje');
        paneTides.style.display = tabName === 'plimovanje' ? 'flex' : 'none';
    }
    if (paneWeather) {
        paneWeather.classList.toggle('active', tabName === 'vreme');
        paneWeather.style.display = tabName === 'vreme' ? 'flex' : 'none';
    }
    if (paneNav) {
        paneNav.classList.toggle('active', tabName === 'navigacija');
        paneNav.style.display = tabName === 'navigacija' ? 'flex' : 'none';
    }
    
    // 3. Manage GPS & Sensor Tracking Lifecycle
    if (tabName === 'navigacija') {
        startGpsNavigation(true);
        setTimeout(() => {
            initNavMap();
            if (navMap) {
                navMap.invalidateSize();
            }
        }, 120);
    } else if (!isCruiseActive) {
        stopGpsNavigation();
    }
    
    // 4. If returning to Plimovanje chart, trigger reflow to fix Highcharts sizing
    if (tabName === 'plimovanje' && currentChart) {
        setTimeout(() => {
            if (currentChart) {
                currentChart.reflow();
            }
        }, 60);
    }
}
window.setActiveMainTab = setActiveMainTab;

// Format decimal coordinates to Nautical DMM format: DD° MM.mmm' N/S & DDD° MM.mmm' E/W
function formatNauticalCoord(degDec, isLat) {
    if (degDec === null || degDec === undefined || isNaN(degDec)) {
        return isLat ? "--° --.---' N" : "---° --.---' E";
    }
    const absVal = Math.abs(degDec);
    const degrees = Math.floor(absVal);
    const minutes = (absVal - degrees) * 60;
    const hemisphere = isLat ? (degDec >= 0 ? 'N' : 'S') : (degDec >= 0 ? 'E' : 'W');
    const degStr = isLat ? String(degrees).padStart(2, '0') : String(degrees).padStart(3, '0');
    const minStr = minutes.toFixed(3).padStart(6, '0');
    return `${degStr}° ${minStr}' ${hemisphere}`;
}

// Calculate shortest angular difference between two angles in degrees (-180 to +180)
function getShortestAngleDelta(fromAngle, toAngle) {
    let diff = (toAngle - fromAngle) % 360;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return diff;
}

// Convert degrees to 16-point cardinal compass text
function getHeadingCardinal(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return "--";
    const cardinals = ["S", "SSV", "SV", "VSV", "V", "VJV", "JV", "JJV", "J", "JJZ", "JZ", "ZJZ", "Z", "ZSZ", "SZ", "SSZ"];
    const normalized = (deg % 360 + 360) % 360;
    const idx = Math.round(normalized / 22.5) % 16;
    return cardinals[idx];
}

// Device Orientation Tracker with Magnetic Declination Correction
function handleDeviceOrientation(event) {
    let heading = null;
    if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
        heading = event.webkitCompassHeading;
    } else if (event.alpha !== null && event.alpha !== undefined) {
        heading = (360 - event.alpha) % 360;
    }

    if (heading !== null && !isNaN(heading)) {
        phoneMagneticHeading = (heading + MAGNETIC_DECLINATION_SLOVENIA + 360) % 360;
        updateCompassOrientation();
    }
}

function updateCompassOrientation() {
    try {
        // 1. Rotate the compass dial smoothly with shortest-angle unwrapping
        const targetDial = -phoneMagneticHeading;
        currentDialAngle += getShortestAngleDelta(currentDialAngle, targetDial);
        const compassDial = document.getElementById('compass-dial-group');
        if (compassDial) {
            compassDial.style.transform = `rotate(${currentDialAngle}deg)`;
        }

        // 2. Rotate the GPS COG pointer relative to the dial
        const compassNeedle = document.getElementById('compass-needle-group');
        if (compassNeedle) {
            if (lastGpsHeading !== null && lastGpsSpeedKnots >= 0.4) {
                const targetNeedle = (lastGpsHeading - phoneMagneticHeading);
                currentNeedleAngle += getShortestAngleDelta(currentNeedleAngle, targetNeedle);
                compassNeedle.style.transform = `rotate(${currentNeedleAngle}deg)`;
                compassNeedle.style.opacity = '1';
            } else {
                compassNeedle.style.opacity = '0.35';
            }
        }

        // 3. In stationary mode (< 0.4 kt), show current phone magnetic heading on the compass center
        const headingDegEl = document.getElementById('nav-heading-deg');
        const headingCardEl = document.getElementById('nav-heading-cardinal');
        if (lastGpsSpeedKnots < 0.4 && headingDegEl) {
            if (phoneMagneticHeading !== null && !isNaN(phoneMagneticHeading)) {
                headingDegEl.textContent = `${Math.round(phoneMagneticHeading)}°`;
                headingDegEl.classList.remove('status-text');
                if (headingCardEl) {
                    headingCardEl.textContent = getHeadingCardinal(phoneMagneticHeading);
                }
            } else {
                headingDegEl.textContent = 'MIROVANJE';
                headingDegEl.classList.add('status-text');
                if (headingCardEl) headingCardEl.textContent = '';
            }
        }
    } catch (e) {
        console.warn('Compass orientation update error:', e);
    }
}

function requestCompassPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    startOrientationTracking();
                } else {
                    console.warn('Compass permission state:', permissionState);
                }
            })
            .catch(err => {
                console.warn('DeviceOrientation permission error:', err);
                startOrientationTracking();
            });
    } else {
        startOrientationTracking();
    }
}
window.requestCompassPermission = requestCompassPermission;

function startOrientationTracking() {
    if (orientationActive) return;

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    window.addEventListener('deviceorientation', handleDeviceOrientation, true);
                    orientationActive = true;
                }
            })
            .catch(err => console.warn('DeviceOrientation permission request deferred:', err));
    } else if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
        window.addEventListener('deviceorientation', handleDeviceOrientation, true);
        orientationActive = true;
    } else if ('ondeviceorientation' in window) {
        window.addEventListener('deviceorientation', handleDeviceOrientation, true);
        orientationActive = true;
    }
}

function stopOrientationTracking() {
    if (!orientationActive) return;
    window.removeEventListener('deviceorientationabsolute', handleDeviceOrientation, true);
    window.removeEventListener('deviceorientation', handleDeviceOrientation, true);
    orientationActive = false;
}

// Share current nautical coordinates via native Web Share API
function shareCurrentLocation() {
    if (!lastGpsCoords) {
        alert('GPS lokacija še ni pridobljena. Preverite, da je GPS vklopljen.');
        return;
    }
    const lat = lastGpsCoords.latitude;
    const lon = lastGpsCoords.longitude;
    const dmmLat = formatNauticalCoord(lat, true);
    const dmmLon = formatNauticalCoord(lon, false);
    const mapsUrl = `https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
    const shareText = `Moja trenutna lokacija na morju:\n${dmmLat}, ${dmmLon}\n(${lat.toFixed(5)}°, ${lon.toFixed(5)}°)\n${mapsUrl}`;

    if (navigator.share) {
        navigator.share({
            title: 'Moja lokacija na morju',
            text: `Moja lokacija: ${dmmLat}, ${dmmLon}`,
            url: mapsUrl
        }).catch(err => {
            if (err.name !== 'AbortError') {
                copyTextToClipboard(shareText);
            }
        });
    } else {
        copyTextToClipboard(shareText);
    }
}

function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            alert('Lokacija s koordinatami in povezavo je kopirana v odložišče!');
        }).catch(() => {
            prompt('Kopirajte koordinate:', text);
        });
    } else {
        prompt('Kopirajte koordinate:', text);
    }
}
window.shareCurrentLocation = shareCurrentLocation;

/// Local Vector Bathymetry Dataset (Authentic smooth isobaths 2m - 30m & soundings for Slovenian waters)
const SLO_BATHYMETRY_ISOBATHS = [
    // 2m Isobath (Shallows & coastal shelf, ~50-100m offshore)
    {
        depth: 2,
        color: '#38bdf8',
        weight: 1.2,
        dashArray: '4, 4',
        coords: [
            [45.5975, 13.7215], [45.5925, 13.6990], [45.5908, 13.6965], [45.5865, 13.7090],
            [45.5780, 13.7310], [45.5580, 13.7330], [45.5490, 13.7240], [45.5450, 13.7110],
            [45.5410, 13.6760], [45.5435, 13.6560], [45.5450, 13.6520], [45.5360, 13.6450],
            [45.5370, 13.6260], [45.5410, 13.6060], [45.5320, 13.5980], [45.5265, 13.5840],
            [45.5270, 13.5730], [45.5285, 13.5650], [45.5255, 13.5665], [45.5160, 13.5700],
            [45.5125, 13.5820], [45.5010, 13.5930], [45.4960, 13.5880], [45.4850, 13.5970]
        ]
    },
    // 5m Isobath (~200-300m offshore)
    {
        depth: 5,
        color: '#00f0ff',
        weight: 1.3,
        dashArray: null,
        coords: [
            [45.5990, 13.7180], [45.5940, 13.6960], [45.5915, 13.6940], [45.5845, 13.7120],
            [45.5720, 13.7320], [45.5580, 13.7270], [45.5505, 13.7190], [45.5460, 13.7050],
            [45.5415, 13.6740], [45.5445, 13.6540], [45.5465, 13.6520], [45.5375, 13.6430],
            [45.5385, 13.6240], [45.5420, 13.6040], [45.5335, 13.5960], [45.5280, 13.5820],
            [45.5285, 13.5720], [45.5300, 13.5640], [45.5250, 13.5650], [45.5150, 13.5680],
            [45.5115, 13.5820], [45.5005, 13.5920], [45.4955, 13.5870], [45.4850, 13.5950]
        ]
    },
    // 10m Isobath (Shelf break)
    {
        depth: 10,
        color: '#0ea5e9',
        weight: 1.4,
        dashArray: null,
        coords: [
            [45.6020, 13.7120], [45.5960, 13.6880], [45.5880, 13.6880], [45.5780, 13.7100],
            [45.5680, 13.7200], [45.5580, 13.7180], [45.5510, 13.7080], [45.5465, 13.6900],
            [45.5440, 13.6680], [45.5475, 13.6480], [45.5410, 13.6350], [45.5415, 13.6200],
            [45.5440, 13.6000], [45.5360, 13.5900], [45.5305, 13.5780], [45.5315, 13.5630],
            [45.5240, 13.5590], [45.5140, 13.5620], [45.5080, 13.5750], [45.4980, 13.5820],
            [45.4850, 13.5880]
        ]
    },
    // 15m Isobath (Channel entrance)
    {
        depth: 15,
        color: '#0284c7',
        weight: 1.5,
        dashArray: null,
        coords: [
            [45.6060, 13.7050], [45.5990, 13.6780], [45.5840, 13.6760], [45.5720, 13.6950],
            [45.5600, 13.7020], [45.5530, 13.6850], [45.5480, 13.6550], [45.5490, 13.6380],
            [45.5450, 13.6100], [45.5460, 13.5920], [45.5380, 13.5780], [45.5340, 13.5600],
            [45.5230, 13.5500], [45.5120, 13.5520], [45.5020, 13.5650], [45.4850, 13.5750]
        ]
    },
    // 20m Isobath (Trieste Gulf Deep Channel)
    {
        depth: 20,
        color: '#2563eb',
        weight: 1.6,
        dashArray: null,
        coords: [
            [45.6120, 13.6950], [45.6020, 13.6650], [45.5850, 13.6550], [45.5700, 13.6700],
            [45.5580, 13.6550], [45.5520, 13.6200], [45.5490, 13.5850], [45.5420, 13.5600],
            [45.5380, 13.5450], [45.5220, 13.5420], [45.5080, 13.5450], [45.4850, 13.5600]
        ]
    },
    // 25m Isobath
    {
        depth: 25,
        color: '#4338ca',
        weight: 1.6,
        dashArray: null,
        coords: [
            [45.6180, 13.6800], [45.6050, 13.6450], [45.5880, 13.6300], [45.5720, 13.6350],
            [45.5580, 13.6000], [45.5520, 13.5650], [45.5450, 13.5350], [45.5250, 13.5300],
            [45.5000, 13.5350], [45.4850, 13.5450]
        ]
    },
    // 30m Isobath (Adriatic deep trench)
    {
        depth: 30,
        color: '#6366f1',
        weight: 1.8,
        dashArray: null,
        coords: [
            [45.6250, 13.6600], [45.6100, 13.6200], [45.5900, 13.6000], [45.5700, 13.5800],
            [45.5500, 13.5400], [45.5300, 13.5100], [45.5000, 13.5100], [45.4850, 13.5200]
        ]
    }
];

const SLO_BATHYMETRY_SOUNDINGS = [
    { label: '1.6m', lat: 45.5910, lon: 13.6980, name: 'Debeli rtič greben' },
    { label: '4.5m', lat: 45.5830, lon: 13.7140, name: 'Valdoltra' },
    { label: '7.2m', lat: 45.5720, lon: 13.7250, name: 'Ankaran zaliv' },
    { label: '14.5m', lat: 45.5560, lon: 13.7220, name: 'Luka Koper plovni kanal' },
    { label: '4.2m', lat: 45.5490, lon: 13.7170, name: 'Koper Mandrač' },
    { label: '2.4m', lat: 45.5450, lon: 13.7050, name: 'Žusterna' },
    { label: '6.5m', lat: 45.5410, lon: 13.6760, name: 'Viližan' },
    { label: '5.2m', lat: 45.5450, lon: 13.6520, name: 'Izola severni greben' },
    { label: '4.0m', lat: 45.5420, lon: 13.6560, name: 'Izola marina vstop' },
    { label: '3.1m', lat: 45.5360, lon: 13.6420, name: 'Simonov zaliv' },
    { label: '8.5m', lat: 45.5390, lon: 13.6260, name: 'Bele skale' },
    { label: '14.0m', lat: 45.5420, lon: 13.6050, name: 'Rt Ronek klif' },
    { label: '6.8m', lat: 45.5370, lon: 13.6000, name: 'Mesečev zaliv' },
    { label: '2.8m', lat: 45.5320, lon: 13.5960, name: 'Strunjan soline vhod' },
    { label: '5.0m', lat: 45.5280, lon: 13.5820, name: 'Pacug' },
    { label: '6.2m', lat: 45.5280, lon: 13.5720, name: 'Fiesa' },
    { label: '2.1m', lat: 45.5295, lon: 13.5640, name: 'Punta Piran greben' },
    { label: '6.5m', lat: 45.5315, lon: 13.5600, name: 'Punta Piran bojna linija' },
    { label: '4.8m', lat: 45.5260, lon: 13.5660, name: 'Piran mandrač vhod' },
    { label: '5.5m', lat: 45.5160, lon: 13.5680, name: 'Bernardin pomol' },
    { label: '2.6m', lat: 45.5130, lon: 13.5820, name: 'Portorož centralna plaža' },
    { label: '3.5m', lat: 45.5020, lon: 13.5920, name: 'Marina Portorož vhod' },
    { label: '2.2m', lat: 45.4970, lon: 13.5870, name: 'Rt Seča greben' },
    { label: '16.5m', lat: 45.5100, lon: 13.5450, name: 'Piranski zaliv sredina' },
    { label: '19.2m', lat: 45.5650, lon: 13.6700, name: 'Koprski zaliv sredina' },
    { label: '26.8m', lat: 45.5450, lon: 13.5400, name: 'Odprto morje pred Piranom' }
];

function buildBathymetryLayer() {
    if (depthVectorLayerGroup) return depthVectorLayerGroup;
    depthVectorLayerGroup = L.layerGroup([]);

    // 1. Smooth, crisp isobath contour lines
    SLO_BATHYMETRY_ISOBATHS.forEach(iso => {
        const poly = L.polyline(iso.coords, {
            color: iso.color,
            weight: iso.weight,
            dashArray: iso.dashArray,
            opacity: 0.85
        });
        poly.bindPopup(`<b>Izobata ${iso.depth} m</b><br>Globinska črta slovenskega morja (${iso.depth} m)`);
        depthVectorLayerGroup.addLayer(poly);

        // Add discrete depth label badges along the isobath line
        if (iso.coords && iso.coords.length > 5) {
            const mid1 = iso.coords[Math.floor(iso.coords.length * 0.35)];
            const mid2 = iso.coords[Math.floor(iso.coords.length * 0.75)];
            [mid1, mid2].forEach(pt => {
                const lblIcon = L.divIcon({
                    className: 'bathy-sounding-divicon',
                    html: `<div class="bathy-isobath-label">${iso.depth}m</div>`,
                    iconSize: [28, 14],
                    iconAnchor: [14, 7]
                });
                const lblMarker = L.marker(pt, { icon: lblIcon, interactive: false });
                depthVectorLayerGroup.addLayer(lblMarker);
            });
        }
    });

    // 2. Sounding Badges with depth in meters
    SLO_BATHYMETRY_SOUNDINGS.forEach(snd => {
        const icon = L.divIcon({
            className: 'bathy-sounding-divicon',
            html: `<div class="bathy-sounding-badge">${snd.label}</div>`,
            iconSize: [38, 18],
            iconAnchor: [19, 9]
        });
        const marker = L.marker([snd.lat, snd.lon], { icon: icon });
        marker.bindPopup(`<b>${snd.name}</b><br>Globina morja: <b>${snd.label}</b>`);
        depthVectorLayerGroup.addLayer(marker);
    });

    return depthVectorLayerGroup;
}

// Start GPS hardware tracking with immediate fallback and high accuracy
function startGpsNavigation(isUserGesture = false) {
    const banner = document.getElementById('nav-status-banner');
    const bannerText = document.getElementById('nav-status-text');
    const toggleBtn = document.getElementById('nav-gps-toggle-btn');

    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        if (banner) banner.className = 'nav-status-banner error';
        if (bannerText) bannerText.textContent = 'GPS zahteva HTTPS varno povezavo';
        if (toggleBtn) toggleBtn.style.display = 'none';
        return;
    }

    if (!('geolocation' in navigator)) {
        if (banner) banner.className = 'nav-status-banner error';
        if (bannerText) bannerText.textContent = 'GPS ni podprt v tem brskalniku';
        if (toggleBtn) toggleBtn.style.display = 'none';
        return;
    }

    if (banner) banner.className = 'nav-status-banner';
    if (bannerText) bannerText.textContent = 'Iskanje GPS signala...';
    if (toggleBtn) toggleBtn.style.display = 'none';

    startOrientationTracking();

    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }

    // Stage 1: Fast initial location (Wi-Fi/Cell)
    navigator.geolocation.getCurrentPosition(
        updateGpsUI,
        () => {},
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
    );

    // Stage 2: High accuracy satellite GPS fix
    if (isUserGesture) {
        navigator.geolocation.getCurrentPosition(
            updateGpsUI,
            handleGpsError,
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }

    // Continuous watch with high accuracy
    try {
        gpsWatchId = navigator.geolocation.watchPosition(
            updateGpsUI,
            handleGpsError,
            { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
        );
    } catch (e) {
        console.warn('Geolocation error starting watch:', e);
    }
}
window.startGpsNavigation = startGpsNavigation;

// Stop GPS tracking to conserve device battery
function stopGpsNavigation() {
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    stopOrientationTracking();
}

function handleGpsError(err) {
    console.warn('GPS Error:', err);
    const banner = document.getElementById('nav-status-banner');
    const bannerText = document.getElementById('nav-status-text');
    const toggleBtn = document.getElementById('nav-gps-toggle-btn');

    if (banner) {
        banner.className = 'nav-status-banner error';
        if (bannerText) {
            if (err.code === 1) {
                bannerText.textContent = 'Dostop do lokacije je zavrnjen v nastavitvah';
            } else if (err.code === 2) {
                bannerText.textContent = 'Iskanje GPS satelitov (preverite pogled v nebo)...';
            } else if (err.code === 3) {
                bannerText.textContent = 'Časovna omejitev GPS signala';
            } else {
                bannerText.textContent = 'Napaka pri branju GPS podatkov';
            }
        }
        if (toggleBtn) {
            toggleBtn.style.display = 'inline-block';
            toggleBtn.textContent = (err.code === 1) ? 'Omogoči GPS' : 'Poskusi znova';
        }
    }
}

// Leaflet Nautical Map Initialization
function initNavMap() {
    if (navMap) return;
    const mapContainer = document.getElementById('nav-map');
    if (!mapContainer || typeof L === 'undefined') return;

    const initialLat = lastGpsCoords ? lastGpsCoords.latitude : 45.545;
    const initialLon = lastGpsCoords ? lastGpsCoords.longitude : 13.650;

    navMap = L.map('nav-map', {
        center: [initialLat, initialLon],
        zoom: 12,
        zoomControl: true,
        attributionControl: false
    });

    // Dedicated High Z-Index Panes so seamarks and depth lines NEVER get hidden under Satellite tiles
    const seamarksPane = navMap.createPane('seamarksPane');
    seamarksPane.style.zIndex = '450';
    seamarksPane.style.pointerEvents = 'none';

    const depthPane = navMap.createPane('depthPane');
    depthPane.style.zIndex = '420';

    // Base Tile Layers
    navMapLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        crossOrigin: true
    });

    navMapLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 18,
        crossOrigin: true
    });

    // OpenSeaMap Seamarks in dedicated seamarksPane (always on top)
    navMapLayers.seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
        maxZoom: 18,
        crossOrigin: true,
        pane: 'seamarksPane'
    });

    // Default: OSM + OpenSeaMap
    navMapLayers.osm.addTo(navMap);
    navMapLayers.seamarks.addTo(navMap);

    // Map click handler for waypoint placement
    navMap.on('click', function(e) {
        handleMapClickForWaypoint(e.latlng.lat, e.latlng.lng);
    });

    // Custom boat icon with neon glow
    const boatIconHtml = `
        <div id="leaflet-boat-icon" style="transform-origin: center; transition: transform 0.3s ease; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;">
            <svg viewBox="0 0 40 40" width="34" height="34" style="filter: drop-shadow(0 0 6px rgba(56,189,248,0.9));">
                <circle cx="20" cy="20" r="18" fill="rgba(14, 165, 233, 0.25)" stroke="#38bdf8" stroke-width="2"/>
                <polygon points="20,4 32,34 20,26 8,34" fill="#0284c7" stroke="#ffffff" stroke-width="1.5"/>
                <circle cx="20" cy="20" r="3.5" fill="#38bdf8"/>
            </svg>
        </div>
    `;

    const boatIcon = L.divIcon({
        className: 'leaflet-boat-divicon',
        html: boatIconHtml,
        iconSize: [34, 34],
        iconAnchor: [17, 17]
    });

    navBoatMarker = L.marker([initialLat, initialLon], { icon: boatIcon, zIndexOffset: 1000 }).addTo(navMap);

    // Polylines
    navPlannedRoutePolyline = L.polyline([], {
        color: '#0284c7',
        weight: 4,
        dashArray: '8, 8',
        opacity: 0.9
    }).addTo(navMap);

    navRecordedTrackPolyline = L.polyline([], {
        color: '#22c55e',
        weight: 5,
        opacity: 0.95
    }).addTo(navMap);

    renderLogbook();
}

// Layer Switching (Zemljevid / Satelit with permanent Seamarks)
function setNavMapLayer(layerType) {
    if (!navMap) return;
    currentNavMapLayerType = layerType;

    const btnOsm = document.getElementById('pill-layer-osm');
    const btnSat = document.getElementById('pill-layer-satellite');
    if (btnOsm) btnOsm.classList.toggle('active', layerType === 'osm');
    if (btnSat) btnSat.classList.toggle('active', layerType === 'satellite');

    if (navMap.hasLayer(navMapLayers.osm)) navMap.removeLayer(navMapLayers.osm);
    if (navMap.hasLayer(navMapLayers.satellite)) navMap.removeLayer(navMapLayers.satellite);

    if (layerType === 'satellite') {
        navMapLayers.satellite.addTo(navMap);
    } else {
        navMapLayers.osm.addTo(navMap);
    }

    // Keep seamarks on top via seamarksPane
    if (!navMap.hasLayer(navMapLayers.seamarks)) {
        navMapLayers.seamarks.addTo(navMap);
    }
}
window.setNavMapLayer = setNavMapLayer;

// Toggle Bathymetry Depth Contours & Soundings
function toggleDepthContours() {
    if (!navMap) initNavMap();
    showDepthContours = !showDepthContours;
    const btn = document.getElementById('pill-layer-depth');
    if (btn) btn.classList.toggle('active', showDepthContours);

    const bathyLayer = buildBathymetryLayer();
    if (showDepthContours) {
        bathyLayer.addTo(navMap);
    } else if (navMap.hasLayer(bathyLayer)) {
        navMap.removeLayer(bathyLayer);
    }
}
window.toggleDepthContours = toggleDepthContours;

// Fullscreen Map Controller (Native + CSS Mobile Overlay Fallback)
function toggleMapFullscreen() {
    const wrapper = document.getElementById('nav-map-wrapper');
    const icon = document.getElementById('map-fullscreen-icon');
    if (!wrapper) return;

    const isNativeFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const isCssFull = wrapper.classList.contains('is-fullscreen');

    if (!isNativeFull && !isCssFull) {
        if (wrapper.requestFullscreen) {
            wrapper.requestFullscreen().catch(() => {});
        } else if (wrapper.webkitRequestFullscreen) {
            wrapper.webkitRequestFullscreen();
        }
        wrapper.classList.add('is-fullscreen');
        if (icon) icon.className = 'fa-solid fa-compress';
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
        wrapper.classList.remove('is-fullscreen');
        if (icon) icon.className = 'fa-solid fa-expand';
    }
    setTimeout(() => { if (navMap) navMap.invalidateSize(); }, 250);
}
window.toggleMapFullscreen = toggleMapFullscreen;

// Synchronize fullscreen exit on ESC or system gesture
document.addEventListener('fullscreenchange', () => {
    const wrapper = document.getElementById('nav-map-wrapper');
    const icon = document.getElementById('map-fullscreen-icon');
    if (!document.fullscreenElement && wrapper) {
        wrapper.classList.remove('is-fullscreen');
        if (icon) icon.className = 'fa-solid fa-expand';
        if (navMap) setTimeout(() => navMap.invalidateSize(), 200);
    }
});

function centerMapOnBoat() {
    if (!navMap) initNavMap();
    if (lastGpsCoords && navMap) {
        navMap.setView([lastGpsCoords.latitude, lastGpsCoords.longitude], 15, { animate: true });
    } else {
        startGpsNavigation(true);
        if (navMap) {
            navMap.setView([45.545, 13.650], 12, { animate: true });
        }
    }
}
window.centerMapOnBoat = centerMapOnBoat;

// Multi-Waypoint Planner Interactions
function setActiveWaypointTarget(id) {
    activeWaypointTargetId = id;
    updateWaypointRowsUI();
}
window.setActiveWaypointTarget = setActiveWaypointTarget;

function resetStartToGps(event) {
    if (event) event.stopPropagation();
    const startWp = routeWaypoints.find(w => w.type === 'start');
    if (startWp) {
        startWp.isGps = true;
        startWp.lat = lastGpsCoords ? lastGpsCoords.latitude : null;
        startWp.lon = lastGpsCoords ? lastGpsCoords.longitude : null;
        startWp.label = 'Moja lokacija (GPS)';
    }
    updateWaypointRowsUI();
    updateWaypointMarkersOnMap();
    recalculateCurrentRoute();
}
window.resetStartToGps = resetStartToGps;

function clearWaypointTarget(id, event) {
    if (event) event.stopPropagation();
    const wp = routeWaypoints.find(w => w.id === id);
    if (wp) {
        wp.lat = null;
        wp.lon = null;
        wp.label = (wp.type === 'dest') ? 'Kliknite na karto za izbiro cilja' : 'Kliknite na karto za izbiro';
    }
    updateWaypointRowsUI();
    updateWaypointMarkersOnMap();
    recalculateCurrentRoute();
}
window.clearWaypointTarget = clearWaypointTarget;

function addWaypointRow() {
    const newId = 'wp_' + Date.now() + '_' + intermediateWpCounter++;
    const newWp = {
        id: newId,
        type: 'intermediate',
        lat: null,
        lon: null,
        label: 'Kliknite na karto za izbiro'
    };
    const destIdx = routeWaypoints.findIndex(w => w.type === 'dest');
    if (destIdx !== -1) {
        routeWaypoints.splice(destIdx, 0, newWp);
    } else {
        routeWaypoints.push(newWp);
    }
    setActiveWaypointTarget(newId);
    updateWaypointRowsUI();
}
window.addWaypointRow = addWaypointRow;

function removeWaypointRow(id, event) {
    if (event) event.stopPropagation();
    routeWaypoints = routeWaypoints.filter(w => w.id !== id);
    if (activeWaypointTargetId === id) {
        activeWaypointTargetId = 'dest';
    }
    updateWaypointRowsUI();
    updateWaypointMarkersOnMap();
    recalculateCurrentRoute();
}
window.removeWaypointRow = removeWaypointRow;

function updateWaypointRowsUI() {
    const startText = document.getElementById('wp-text-start');
    const startRow = document.getElementById('wp-row-start');
    const destText = document.getElementById('wp-text-dest');
    const destRow = document.getElementById('wp-row-dest');
    const interContainer = document.getElementById('wp-intermediate-container');

    const startWp = routeWaypoints.find(w => w.type === 'start');
    const destWp = routeWaypoints.find(w => w.type === 'dest');

    if (startText && startWp) startText.textContent = startWp.label;
    if (startRow) startRow.classList.toggle('active', activeWaypointTargetId === 'start');

    if (destText && destWp) destText.textContent = destWp.label;
    if (destRow) destRow.classList.toggle('active', activeWaypointTargetId === 'dest');

    if (interContainer) {
        let html = '';
        const interWps = routeWaypoints.filter(w => w.type === 'intermediate');
        interWps.forEach((wp, idx) => {
            const isActive = activeWaypointTargetId === wp.id;
            html += `
                <div class="waypoint-row ${isActive ? 'active' : ''}" onclick="setActiveWaypointTarget('${wp.id}')">
                    <span class="wp-icon intermediate-icon"><b>${idx + 1}</b></span>
                    <div class="wp-details">
                        <span class="wp-label">Vmesna točka ${idx + 1}</span>
                        <span class="wp-coord-text">${wp.label}</span>
                    </div>
                    <button type="button" class="wp-action-btn delete-btn" onclick="removeWaypointRow('${wp.id}', event)" title="Izbriši točko">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            `;
        });
        interContainer.innerHTML = html;
    }
}

function handleMapClickForWaypoint(lat, lon) {
    const targetWp = routeWaypoints.find(w => w.id === activeWaypointTargetId);
    if (!targetWp) return;

    targetWp.lat = lat;
    targetWp.lon = lon;
    const formatted = `${formatNauticalCoord(lat, true)}, ${formatNauticalCoord(lon, false)}`;

    if (targetWp.type === 'start') {
        targetWp.isGps = false;
        targetWp.label = `Začetek: ${formatted}`;
    } else if (targetWp.type === 'dest') {
        targetWp.label = `Cilj: ${formatted}`;
    } else {
        targetWp.label = formatted;
    }

    updateWaypointRowsUI();
    updateWaypointMarkersOnMap();
    recalculateCurrentRoute();

    const unassigned = routeWaypoints.find(w => w.lat === null && w.type !== 'start');
    if (unassigned) {
        setActiveWaypointTarget(unassigned.id);
    }
}

function updateWaypointMarkersOnMap() {
    if (!navMap) return;

    for (const id in waypointMarkers) {
        if (waypointMarkers[id]) {
            navMap.removeLayer(waypointMarkers[id]);
        }
    }
    waypointMarkers = {};

    routeWaypoints.forEach((wp, idx) => {
        if (wp.lat === null || wp.lon === null) return;
        if (wp.type === 'start' && wp.isGps) return;

        let iconHtml = '';
        if (wp.type === 'start') {
            iconHtml = `<div style="font-size:22px; color:#22c55e; filter:drop-shadow(0 2px 5px rgba(0,0,0,0.5)); transform:translate(-2px,-6px);"><i class="fa-solid fa-location-dot"></i></div>`;
        } else if (wp.type === 'dest') {
            iconHtml = `<div style="font-size:24px; color:#ef4444; filter:drop-shadow(0 2px 5px rgba(0,0,0,0.5)); transform:translate(-2px,-8px);"><i class="fa-solid fa-flag-checkered"></i></div>`;
        } else {
            iconHtml = `<div style="width:22px; height:22px; border-radius:50%; background:#0284c7; border:2px solid #ffffff; color:#ffffff; font-size:11px; font-weight:800; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,0.4);">${idx}</div>`;
        }

        const icon = L.divIcon({
            className: 'wp-map-divicon',
            html: iconHtml,
            iconSize: [24, 24],
            iconAnchor: [12, 24]
        });

        const marker = L.marker([wp.lat, wp.lon], { icon: icon }).addTo(navMap);
        marker.bindPopup(`<b>${wp.type === 'start' ? 'Začetek' : wp.type === 'dest' ? 'Cilj' : 'Točka ' + idx}</b><br><small>${wp.lat.toFixed(4)}° N, ${wp.lon.toFixed(4)}° E</small>`);
        waypointMarkers[wp.id] = marker;
    });
}

function recalculateCurrentRoute() {
    if (!navMap) return;

    const chkRules = document.getElementById('chk-route-rules');
    const useRules = (chkRules && chkRules.type === 'checkbox') ? chkRules.checked : true;

    const activePoints = [];
    const startWp = routeWaypoints.find(w => w.type === 'start');
    if (startWp) {
        if (startWp.isGps) {
            if (lastGpsCoords) {
                activePoints.push({ lat: lastGpsCoords.latitude, lon: lastGpsCoords.longitude });
            } else if (navBoatMarker) {
                const pos = navBoatMarker.getLatLng();
                activePoints.push({ lat: pos.lat, lon: pos.lng });
            } else {
                activePoints.push({ lat: 45.545, lon: 13.650 });
            }
        } else if (startWp.lat !== null && startWp.lon !== null) {
            activePoints.push({ lat: startWp.lat, lon: startWp.lon });
        }
    }

    const intermediateWps = routeWaypoints.filter(w => w.type === 'intermediate' && w.lat !== null && w.lon !== null);
    intermediateWps.forEach(w => activePoints.push({ lat: w.lat, lon: w.lon }));

    const destWp = routeWaypoints.find(w => w.type === 'dest');
    if (destWp && destWp.lat !== null && destWp.lon !== null) {
        activePoints.push({ lat: destWp.lat, lon: destWp.lon });
    }

    if (activePoints.length < 2) {
        currentCalculatedRouteCoords = [];
        if (navPlannedRoutePolyline) navPlannedRoutePolyline.setLatLngs([]);
        const clearBtn = document.getElementById('map-clear-btn');
        if (clearBtn) clearBtn.style.display = 'none';
        resetRouteTelemetryDisplay();
        return;
    }

    const fullRoute = [];
    for (let i = 0; i < activePoints.length - 1; i++) {
        const seg = getSafeMarineSegment(
            activePoints[i].lat, activePoints[i].lon,
            activePoints[i+1].lat, activePoints[i+1].lon,
            useRules
        );
        if (i === 0) {
            fullRoute.push(...seg);
        } else {
            fullRoute.push(...seg.slice(1));
        }
    }

    currentCalculatedRouteCoords = fullRoute;
    if (navPlannedRoutePolyline) {
        navPlannedRoutePolyline.setLatLngs(currentCalculatedRouteCoords);
    }

    const clearBtn = document.getElementById('map-clear-btn');
    if (clearBtn) clearBtn.style.display = 'flex';

    if (fullRoute.length > 0) {
        const bounds = L.latLngBounds(fullRoute);
        navMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }

    updateLiveRouteTelemetry();
}
window.recalculateCurrentRoute = recalculateCurrentRoute;

function clearNavRoute() {
    routeWaypoints = [
        { id: 'start', type: 'start', lat: null, lon: null, isGps: true, label: 'Moja lokacija (GPS)' },
        { id: 'dest', type: 'dest', lat: null, lon: null, label: 'Kliknite na karto za izbiro cilja' }
    ];
    activeWaypointTargetId = 'dest';
    currentCalculatedRouteCoords = [];

    if (navPlannedRoutePolyline) navPlannedRoutePolyline.setLatLngs([]);
    if (navPastCruisePolyline && navMap) {
        navMap.removeLayer(navPastCruisePolyline);
        navPastCruisePolyline = null;
    }
    navPastCruiseMarkers.forEach(m => navMap && navMap.removeLayer(m));
    navPastCruiseMarkers = [];

    updateWaypointRowsUI();
    updateWaypointMarkersOnMap();

    const clearBtn = document.getElementById('map-clear-btn');
    if (clearBtn) clearBtn.style.display = 'none';

    resetRouteTelemetryDisplay();
}
window.clearNavRoute = clearNavRoute;

function resetRouteTelemetryDisplay() {
    const dtgEl = document.getElementById('telem-dtg');
    const dtgKmEl = document.getElementById('telem-dtg-km');
    const ttgEl = document.getElementById('telem-ttg');
    const etaEl = document.getElementById('telem-eta');
    const brgEl = document.getElementById('telem-brg');
    const brgCardEl = document.getElementById('telem-brg-card');

    if (dtgEl) dtgEl.textContent = '--';
    if (dtgKmEl) dtgKmEl.textContent = '-- km';
    if (ttgEl) ttgEl.textContent = '--';
    if (etaEl) etaEl.textContent = 'ETA: --:--';
    if (brgEl) brgEl.textContent = '--°';
    if (brgCardEl) brgCardEl.textContent = '--';
}

let plannedSpeedKnots = 6.0;

function onPlannedSpeedChange() {
    const inputEl = document.getElementById('input-planned-speed');
    if (inputEl) {
        const val = parseFloat(inputEl.value);
        if (!isNaN(val) && val > 0) {
            plannedSpeedKnots = val;
            updateLiveRouteTelemetry();
        }
    }
}
window.onPlannedSpeedChange = onPlannedSpeedChange;

function updatePlannedSpeedRowVisibility() {
    const speedRow = document.getElementById('planner-speed-row');
    if (!speedRow) return;
    const currentSpeedKnots = lastGpsSpeedKnots || 0;
    if (isCruiseActive && currentSpeedKnots >= 0.4) {
        speedRow.style.display = 'none';
    } else {
        speedRow.style.display = 'flex';
    }
}

function updateLiveRouteTelemetry() {
    updatePlannedSpeedRowVisibility();
    if (!currentCalculatedRouteCoords || currentCalculatedRouteCoords.length < 2) {
        resetRouteTelemetryDisplay();
        return;
    }

    const currentSpeedKnots = lastGpsSpeedKnots || 0;

    let totalDtgM = 0;
    for (let i = 0; i < currentCalculatedRouteCoords.length - 1; i++) {
        totalDtgM += haversineDistanceMeters(
            currentCalculatedRouteCoords[i][0], currentCalculatedRouteCoords[i][1],
            currentCalculatedRouteCoords[i+1][0], currentCalculatedRouteCoords[i+1][1]
        );
    }

    const dtgNm = totalDtgM / 1852;
    const dtgKm = totalDtgM / 1000;

    const dtgEl = document.getElementById('telem-dtg');
    const dtgKmEl = document.getElementById('telem-dtg-km');
    if (dtgEl) dtgEl.textContent = `${dtgNm.toFixed(2)} NM`;
    if (dtgKmEl) dtgKmEl.textContent = `${dtgKm.toFixed(2)} km`;

    // BRG to immediate next waypoint on active leg
    const nextWp = currentCalculatedRouteCoords[1];
    const boatLat = (lastGpsCoords && isCruiseActive) ? lastGpsCoords.latitude : currentCalculatedRouteCoords[0][0];
    const boatLon = (lastGpsCoords && isCruiseActive) ? lastGpsCoords.longitude : currentCalculatedRouteCoords[0][1];
    const brg = calculateBearing(boatLat, boatLon, nextWp[0], nextWp[1]);
    const brgEl = document.getElementById('telem-brg');
    const brgCardEl = document.getElementById('telem-brg-card');
    if (brgEl) brgEl.textContent = `${Math.round(brg)}°`;
    if (brgCardEl) brgCardEl.textContent = getHeadingCardinal(brg);

    // TTG & ETA:
    // If moving actively (>= 0.4 kt), TTG & ETA use real GPS speed.
    // If stationary (< 0.4 kt), TTG is estimated using planned speed, but ETA advances with current real-time clock!
    const ttgEl = document.getElementById('telem-ttg');
    const etaEl = document.getElementById('telem-eta');
    const effectiveSpeedKnots = (isCruiseActive && currentSpeedKnots >= 0.4) ? currentSpeedKnots : (plannedSpeedKnots > 0 ? plannedSpeedKnots : 6.0);

    if (effectiveSpeedKnots >= 0.3) {
        const ttgHours = dtgNm / effectiveSpeedKnots;
        const ttgSec = Math.round(ttgHours * 3600);
        if (ttgEl) ttgEl.textContent = formatDuration(ttgSec);

        const etaDate = new Date(Date.now() + ttgSec * 1000);
        const etaH = String(etaDate.getHours()).padStart(2, '0');
        const etaM = String(etaDate.getMinutes()).padStart(2, '0');
        if (etaEl) etaEl.textContent = `ETA: ${etaH}:${etaM}`;
    } else {
        if (ttgEl) ttgEl.textContent = '--';
        if (etaEl) etaEl.textContent = 'ETA: --:--';
    }
}

// Screen Wake Lock API
async function requestCruiseWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            cruiseWakeLock = await navigator.wakeLock.request('screen');
            cruiseWakeLock.addEventListener('release', () => {
                cruiseWakeLock = null;
            });
        } catch (e) {
            console.warn('Wake Lock request failed:', e);
        }
    }
}

function releaseCruiseWakeLock() {
    if (cruiseWakeLock !== null) {
        cruiseWakeLock.release().then(() => {
            cruiseWakeLock = null;
        }).catch(() => {});
    }
}

// Cruise Tracking Controller
function toggleCruiseRecording() {
    if (!isCruiseActive) {
        startCruise();
    } else {
        stopCruisePrompt();
    }
}
window.toggleCruiseRecording = toggleCruiseRecording;

function startCruise() {
    isCruiseActive = true;
    cruiseStartTime = Date.now();
    cruiseTrackPoints = [];
    cruiseTotalDistanceNm = 0;
    cruiseMaxSpeedKnots = lastGpsSpeedKnots || 0;

    startGpsNavigation(true);

    if (lastGpsCoords) {
        lastRecordedGpsPos = { lat: lastGpsCoords.latitude, lon: lastGpsCoords.longitude };
        cruiseTrackPoints.push([lastGpsCoords.latitude, lastGpsCoords.longitude]);
    } else {
        lastRecordedGpsPos = null;
    }

    if (navRecordedTrackPolyline) {
        navRecordedTrackPolyline.setLatLngs(cruiseTrackPoints);
    }

    requestCruiseWakeLock();

    updatePlannedSpeedRowVisibility();

    const btn = document.getElementById('btn-cruise-toggle');
    const icon = document.getElementById('cruise-btn-icon');
    const text = document.getElementById('cruise-btn-text');
    if (btn) btn.classList.add('active');
    if (icon) icon.className = 'fa-solid fa-stop';
    if (text) text.textContent = 'Zaključi';

    if (cruiseDurationTimer) clearInterval(cruiseDurationTimer);
    cruiseDurationTimer = setInterval(() => {
        if (!isCruiseActive || !cruiseStartTime) return;
        const sec = Math.floor((Date.now() - cruiseStartTime) / 1000);
        const durationEl = document.getElementById('telem-duration');
        if (durationEl) durationEl.textContent = formatDuration(sec);

        const hrs = sec / 3600;
        const avgSpeed = (hrs > 0 && cruiseTotalDistanceNm > 0) ? (cruiseTotalDistanceNm / hrs) : 0;
        const avgSpeedEl = document.getElementById('telem-avg-speed');
        if (avgSpeedEl) avgSpeedEl.textContent = `${avgSpeed.toFixed(1)} kt`;
    }, 1000);
}

async function stopCruisePrompt() {
    const sec = cruiseStartTime ? Math.floor((Date.now() - cruiseStartTime) / 1000) : 0;
    const hrs = sec / 3600;
    const avgSpeed = (hrs > 0 && cruiseTotalDistanceNm > 0) ? (cruiseTotalDistanceNm / hrs) : 0;
    const distKm = (cruiseTotalDistanceNm * 1.852).toFixed(2);

    const destWp = routeWaypoints.find(w => w.type === 'dest');
    const destLabel = (destWp && destWp.lat !== null) ? destWp.label : 'Prosta plovba';

    const saveConfirmed = confirm(
        `PLOVBA ZAKLJUČENA\n` +
        `-----------------------------\n` +
        `• Relacija: ${destLabel}\n` +
        `• Čas plovbe: ${formatDuration(sec)}\n` +
        `• Prepluto: ${cruiseTotalDistanceNm.toFixed(2)} NM (${distKm} km)\n` +
        `• Povprečna hitrost: ${avgSpeed.toFixed(1)} kt\n` +
        `• Najvišja hitrost: ${cruiseMaxSpeedKnots.toFixed(1)} kt\n\n` +
        `Ali želite to plovbo shraniti v Dnevnik plovb?`
    );

    if (saveConfirmed) {
        await saveCruiseToIndexedDB({
            id: 'cruise_' + Date.now(),
            timestamp: Date.now(),
            date: new Date().toLocaleDateString('sl-SI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
            durationSec: sec,
            distanceNm: cruiseTotalDistanceNm,
            avgSpeedKnots: avgSpeed,
            maxSpeedKnots: cruiseMaxSpeedKnots,
            destName: destLabel,
            trackPoints: [...cruiseTrackPoints]
        });
        renderLogbook();
    }

    endCruiseState();
}

function endCruiseState() {
    isCruiseActive = false;
    cruiseStartTime = null;
    if (cruiseDurationTimer) {
        clearInterval(cruiseDurationTimer);
        cruiseDurationTimer = null;
    }
    releaseCruiseWakeLock();

    // Show planned speed row again for planning
    const speedRow = document.getElementById('planner-speed-row');
    if (speedRow) speedRow.style.display = 'flex';
    updateLiveRouteTelemetry();

    const btn = document.getElementById('btn-cruise-toggle');
    const icon = document.getElementById('cruise-btn-icon');
    const text = document.getElementById('cruise-btn-text');
    if (btn) btn.classList.remove('active');
    if (icon) icon.className = 'fa-solid fa-play';
    if (text) text.textContent = 'Začni';

    if (activeMainTab !== 'navigacija') {
        stopGpsNavigation();
    }
}

// Local IndexedDB Database Management (with Persistent Storage API)
const DB_NAME = 'PlimaNautikaDB';
const DB_VERSION = 1;
const STORE_NAME = 'cruises';

function openNautikaDB() {
    return new Promise((resolve) => {
        if (!window.indexedDB) {
            resolve(null);
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function(e) {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = function(e) {
            const db = e.target.result;
            if (navigator.storage && navigator.storage.persist) {
                navigator.storage.persist().catch(() => {});
            }
            resolve(db);
        };
        request.onerror = function() {
            resolve(null);
        };
    });
}

async function saveCruiseToIndexedDB(record) {
    const db = await openNautikaDB();
    if (db) {
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put(record);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } else {
        try {
            const list = JSON.parse(localStorage.getItem('plima_cruise_logbook') || '[]');
            list.unshift(record);
            localStorage.setItem('plima_cruise_logbook', JSON.stringify(list));
        } catch (e) {}
    }
}

async function getAllCruisesFromIndexedDB() {
    const db = await openNautikaDB();
    if (db) {
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => {
                const list = req.result || [];
                list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                resolve(list);
            };
            req.onerror = () => resolve([]);
        });
    } else {
        try {
            return JSON.parse(localStorage.getItem('plima_cruise_logbook') || '[]');
        } catch (e) {
            return [];
        }
    }
}

async function deleteCruiseFromIndexedDB(id) {
    if (!confirm('Ali res želite izbrisati ta zapis iz dnevnika?')) return;
    const db = await openNautikaDB();
    if (db) {
        await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.delete(id);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } else {
        try {
            let list = JSON.parse(localStorage.getItem('plima_cruise_logbook') || '[]');
            list = list.filter(item => item.id !== id);
            localStorage.setItem('plima_cruise_logbook', JSON.stringify(list));
        } catch (e) {}
    }
    renderLogbook();
}
window.deleteCruiseFromIndexedDB = deleteCruiseFromIndexedDB;

function toggleLogbookDrawer() {
    const listEl = document.getElementById('logbook-list');
    const chevron = document.getElementById('logbook-chevron');
    if (!listEl) return;
    const isHidden = listEl.style.display === 'none';
    listEl.style.display = isHidden ? 'flex' : 'none';
    if (chevron) {
        chevron.className = isHidden ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    }
    if (isHidden) {
        renderLogbook();
    }
}
window.toggleLogbookDrawer = toggleLogbookDrawer;

async function renderLogbook() {
    const container = document.getElementById('logbook-list');
    if (!container) return;
    const list = await getAllCruisesFromIndexedDB();

    if (list.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:12px; color:var(--text-secondary); font-size:0.8rem;">Dnevnik je prazen. Shranjene plovbe se bodo prikazale tukaj.</div>`;
        return;
    }

    let html = '';
    list.forEach(item => {
        const distKm = (item.distanceNm * 1.852).toFixed(1);
        html += `
            <div class="logbook-item" onclick="drawLoggedCruiseOnMap('${item.id}')" title="Kliknite za prikaz poti na karti">
                <div style="display:flex; flex-direction:column; gap:2px; flex:1;">
                    <strong style="color:var(--text-primary); font-size:0.85rem;"><i class="fa-solid fa-ship" style="color:var(--accent-blue); margin-right:4px;"></i> ${item.destName || 'Plovba'}</strong>
                    <span style="color:var(--text-secondary); font-size:0.72rem;">${item.date} • ${formatDuration(item.durationSec)}</span>
                    <span style="color:var(--text-primary); font-size:0.75rem; font-weight:600;">${item.distanceNm.toFixed(2)} NM (${distKm} km) • Ø ${item.avgSpeedKnots.toFixed(1)} kt • MAX ${(item.maxSpeedKnots || 0).toFixed(1)} kt</span>
                </div>
                <button type="button" class="logbook-item-btn" onclick="event.stopPropagation(); deleteCruiseFromIndexedDB('${item.id}')" title="Izbriši zapis">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `;
    });
    container.innerHTML = html;
}

async function drawLoggedCruiseOnMap(id) {
    if (!navMap) initNavMap();
    const list = await getAllCruisesFromIndexedDB();
    const cruise = list.find(item => item.id === id);
    if (!cruise || !cruise.trackPoints || cruise.trackPoints.length === 0) {
        alert('Ta plovba nima shranjenih koordinat poti.');
        return;
    }

    if (navPastCruisePolyline && navMap) {
        navMap.removeLayer(navPastCruisePolyline);
        navPastCruisePolyline = null;
    }
    navPastCruiseMarkers.forEach(m => navMap && navMap.removeLayer(m));
    navPastCruiseMarkers = [];

    navPastCruisePolyline = L.polyline(cruise.trackPoints, {
        color: '#f59e0b',
        weight: 5,
        opacity: 0.95
    }).addTo(navMap);

    const startPt = cruise.trackPoints[0];
    const endPt = cruise.trackPoints[cruise.trackPoints.length - 1];

    const startIcon = L.divIcon({
        className: 'wp-start-icon',
        html: `<div style="font-size:20px; color:#22c55e;"><i class="fa-solid fa-play"></i></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });
    const endIcon = L.divIcon({
        className: 'wp-end-icon',
        html: `<div style="font-size:20px; color:#ef4444;"><i class="fa-solid fa-flag-checkered"></i></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });

    const mStart = L.marker(startPt, { icon: startIcon }).addTo(navMap).bindPopup(`<b>Začetek plovbe</b><br>${cruise.date}`);
    const mEnd = L.marker(endPt, { icon: endIcon }).addTo(navMap).bindPopup(`<b>Konec plovbe</b><br>${cruise.distanceNm.toFixed(2)} NM`);
    navPastCruiseMarkers.push(mStart, mEnd);

    const clearBtn = document.getElementById('map-clear-btn');
    if (clearBtn) clearBtn.style.display = 'flex';

    navMap.fitBounds(navPastCruisePolyline.getBounds(), { padding: [40, 40], maxZoom: 15 });
}
window.drawLoggedCruiseOnMap = drawLoggedCruiseOnMap;

// Process GPS position and update gauges, coordinates, boat marker and telemetry
function updateGpsUI(pos) {
    if (!pos || !pos.coords) return;
    const coords = pos.coords;
    lastGpsCoords = coords;

    // Status Banner update
    const banner = document.getElementById('nav-status-banner');
    const bannerText = document.getElementById('nav-status-text');
    const toggleBtn = document.getElementById('nav-gps-toggle-btn');
    if (banner) banner.className = 'nav-status-banner connected';
    if (bannerText) bannerText.textContent = 'GPS signal aktiven';
    if (toggleBtn) toggleBtn.style.display = 'none';

    // 1. SPEED (SOG)
    let speedMs = coords.speed;
    let speedKnots = 0;
    let speedKmh = 0;

    if (speedMs !== null && !isNaN(speedMs) && speedMs >= 0) {
        speedKnots = speedMs * 1.943844;
        speedKmh = speedMs * 3.6;
    }
    lastGpsSpeedKnots = speedKnots;

    if (isCruiseActive && speedKnots > cruiseMaxSpeedKnots) {
        cruiseMaxSpeedKnots = speedKnots;
    }

    const clampedKnots = Math.min(Math.max(speedKnots, 0), 20);
    const speedRatio = clampedKnots / 20;

    const maxArcDash = 447.67;
    const currentOffset = maxArcDash * (1 - speedRatio);
    const speedArcEl = document.getElementById('speed-gauge-arc');
    if (speedArcEl) {
        speedArcEl.style.strokeDashoffset = currentOffset;
    }

    const needleDeg = -135 + (speedRatio * 270);
    const speedNeedle = document.getElementById('speed-needle-group');
    if (speedNeedle) {
        speedNeedle.style.transform = `rotate(${needleDeg}deg)`;
    }

    const knotsValEl = document.getElementById('nav-speed-knots');
    const kmhValEl = document.getElementById('nav-speed-kmh');
    if (knotsValEl) knotsValEl.textContent = speedKnots.toFixed(1);
    if (kmhValEl) kmhValEl.textContent = `${speedKmh.toFixed(1)} km/h`;

    // Max speed in telemetry
    const maxSpeedEl = document.getElementById('telem-max-speed');
    const maxSpeedKmhEl = document.getElementById('telem-max-speed-kmh');
    if (maxSpeedEl) maxSpeedEl.textContent = `${cruiseMaxSpeedKnots.toFixed(1)} kt`;
    if (maxSpeedKmhEl) maxSpeedKmhEl.textContent = `${(cruiseMaxSpeedKnots * 1.852).toFixed(1)} km/h`;

    // 2. HEADING (COG / Hibridni Kompas)
    let heading = coords.heading;
    const headingDegEl = document.getElementById('nav-heading-deg');
    const headingCardEl = document.getElementById('nav-heading-cardinal');

    if (speedKnots < 0.4) {
        if (headingDegEl) {
            headingDegEl.textContent = 'MIROVANJE';
            headingDegEl.classList.add('status-text');
        }
        if (headingCardEl) {
            headingCardEl.textContent = '';
        }
    } else if (heading !== null && !isNaN(heading) && heading >= 0) {
        lastGpsHeading = heading;
        if (headingDegEl) {
            headingDegEl.textContent = `${Math.round(heading)}°`;
            headingDegEl.classList.remove('status-text');
        }
        if (headingCardEl) {
            headingCardEl.textContent = getHeadingCardinal(heading);
        }
    } else if (lastGpsHeading !== null) {
        if (headingDegEl) {
            headingDegEl.textContent = `${Math.round(lastGpsHeading)}°`;
            headingDegEl.classList.remove('status-text');
        }
        if (headingCardEl) {
            headingCardEl.textContent = getHeadingCardinal(lastGpsHeading);
        }
    } else {
        if (headingDegEl) {
            headingDegEl.textContent = 'MIROVANJE';
            headingDegEl.classList.add('status-text');
        }
        if (headingCardEl) {
            headingCardEl.textContent = '';
        }
    }

    updateCompassOrientation();

    // 3. NAUTICAL COORDINATES (DMM)
    const latValEl = document.getElementById('nav-lat-val');
    const lonValEl = document.getElementById('nav-lon-val');
    if (latValEl) latValEl.textContent = formatNauticalCoord(coords.latitude, true);
    if (lonValEl) lonValEl.textContent = formatNauticalCoord(coords.longitude, false);

    // Auto-center map on initial GPS fix
    if (!hasCenteredInitialGps && navMap) {
        navMap.setView([coords.latitude, coords.longitude], 15, { animate: true });
        hasCenteredInitialGps = true;
    }

    // Update GPS Start point in planner if start is set to GPS
    const startWp = routeWaypoints.find(w => w.type === 'start');
    if (startWp && startWp.isGps) {
        startWp.lat = coords.latitude;
        startWp.lon = coords.longitude;
        const startTextEl = document.getElementById('wp-text-start');
        if (startTextEl && activeWaypointTargetId !== 'start') {
            startTextEl.textContent = 'Moja lokacija (' + formatNauticalCoord(coords.latitude, true) + ', ' + formatNauticalCoord(coords.longitude, false) + ')';
        }
    }

    // 4. MAP BOAT MARKER UPDATE
    if (navMap) {
        if (!navBoatMarker) {
            initNavMap();
        }
        if (navBoatMarker) {
            navBoatMarker.setLatLng([coords.latitude, coords.longitude]);
            const boatIconEl = document.getElementById('leaflet-boat-icon');
            if (boatIconEl && (heading !== null || lastGpsHeading !== null)) {
                const rot = (heading !== null && !isNaN(heading)) ? heading : (lastGpsHeading || 0);
                boatIconEl.style.transform = `rotate(${rot}deg)`;
            }
        }
    }

    // 5. CRUISE RECORDING TRACK ACCUMULATION
    if (isCruiseActive) {
        if (lastRecordedGpsPos) {
            const deltaMeters = haversineDistanceMeters(lastRecordedGpsPos.lat, lastRecordedGpsPos.lon, coords.latitude, coords.longitude);
            if (deltaMeters >= 3) {
                const deltaNm = deltaMeters / 1852;
                cruiseTotalDistanceNm += deltaNm;
                cruiseTrackPoints.push([coords.latitude, coords.longitude]);
                lastRecordedGpsPos = { lat: coords.latitude, lon: coords.longitude };
                if (navRecordedTrackPolyline) {
                    navRecordedTrackPolyline.setLatLngs(cruiseTrackPoints);
                }
            }
        } else {
            lastRecordedGpsPos = { lat: coords.latitude, lon: coords.longitude };
            cruiseTrackPoints.push([coords.latitude, coords.longitude]);
            if (navRecordedTrackPolyline) {
                navRecordedTrackPolyline.setLatLngs(cruiseTrackPoints);
            }
        }

        const distEl = document.getElementById('telem-dist');
        const distKmEl = document.getElementById('telem-dist-km');
        if (distEl) distEl.textContent = `${cruiseTotalDistanceNm.toFixed(2)} NM`;
        if (distKmEl) distKmEl.textContent = `${(cruiseTotalDistanceNm * 1.852).toFixed(2)} km`;
    }

    // 6. ROUTE TELEMETRY UPDATE
    updateLiveRouteTelemetry();
}

// Pause GPS & orientation on app minimize/background and resume when foregrounded (keeps running if cruise recording is active)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (!isCruiseActive) {
            stopGpsNavigation();
        }
    } else {
        if (activeMainTab === 'navigacija' || isCruiseActive) {
            startGpsNavigation(false);
            if (isCruiseActive) {
                requestCruiseWakeLock();
            }
            if (navMap) {
                setTimeout(() => navMap.invalidateSize(), 100);
            }
        }
    }
});


