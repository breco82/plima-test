/* index.js */
/* Frontend Controller for the Slovenian Sea Level Tracker & Nautical Navigation System */

// =========================================================================
// SECTION 1: GLOBAL STATE (Plimovanje, Vreme & Navigacija)
// =========================================================================
let chartMode = 'level'; // 'level' or 'temp'
let periodHours = 24;   // 24, 72, or 168
let actualData = [];    // Loaded ARSO measurements
let currentChart = null; // Highcharts instance
let meteoForecastMap = new Map(); // Open-Meteo hourly pressure and wind map
let openMeteoHourlyForecast = []; // Global variable to store hourly forecast items
let activeHourlyDayOffset = null; // Track which day's hourly forecast is currently open
let arsoForecastData = null; // Global variable to store raw ARSO Koper JSON forecast

// Datum offset constant (Srednja gladina morja / Mean sea level - SVS2010 reference datum is 217.0 cm above gauge zero)
const MEAN_SEA_LEVEL_OFFSET = 217.0;

let deferredPrompt = null;

// Weather Station active toggle state ('vida' for oceanographic buoy Vida, 'portoroz' for Portoroz Airport)
let activeWeatherSource = 'vida';
let weatherDataVida = null;
let weatherDataPortoroz = null;
let lastKnownVidaTemp = null;
let lastKnownVidaTempTime = null;
let lastKnownVidaRh = null;
let lastKnownVidaRhTime = null;
let currentMarineWaveHeight = 0.2;
let marineHourlyWaves = new Map();

// Navigation & Compass State
const MAGNETIC_DECLINATION_SLOVENIA = 4.0;
let phoneMagneticHeading = 0;
let orientationActive = false;
let lastGpsSpeedKnots = 0;
let currentDialAngle = 0;
let currentNeedleAngle = 0;
let lastGpsCoords = null;
let lastGpsHeading = null;
let hasCenteredInitialGps = false;
let plannedSpeedKnots = 5.0;
let gpsWatchId = null;

// Leaflet Map & Routing State
let navMap = null;
let navMapLayers = {};
let currentNavMapLayerType = 'osm';
let showDepthContours = true;
let nauticalChartLayerGroup = null;
let guide200mPolylineLayer = null;

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

// Active tab tracker ('plimovanje', 'vreme', 'navigacija')
let activeMainTab = 'plimovanje';

// =========================================================================
// SECTION 1B: PLIMOVANJE & VREME LOGIC (ARSO, BAZDARA, ALADIN, HIGHCHARTS)
// =========================================================================

function parseIsoLocal(isoStr) {
    if (!isoStr) return new Date();
    const cleanStr = isoStr.replace('Z', '');
    const parts = cleanStr.split(/[-T: ]/);
    if (parts.length >= 5) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const day = parseInt(parts[2], 10);
        const hour = parseInt(parts[3], 10);
        const minute = parseInt(parts[4], 10);
        const second = parts[5] ? parseInt(parts[5], 10) : 0;
        return new Date(year, month, day, hour, minute, second);
    }
    return new Date(isoStr);
}

function getDouglasSeaState(heightM) {
    if (heightM === null || heightM === undefined || isNaN(heightM)) {
        return { scale: '-', name: 'Neznano', icon: 'fa-water' };
    }
    const h = parseFloat(heightM);
    if (h < 0.1) return { scale: '0', name: 'Mirno (brez valov)', icon: 'fa-water' };
    if (h <= 0.5) return { scale: '1-2', name: 'Mirno do rahlo vzvalovano', icon: 'fa-water' };
    if (h <= 1.25) return { scale: '3', name: 'Zmerno vzvalovano', icon: 'fa-water' };
    if (h <= 2.5) return { scale: '4', name: 'Vzvalovano', icon: 'fa-water' };
    if (h <= 4.0) return { scale: '5', name: 'Močno vzvalovano', icon: 'fa-water' };
    if (h <= 6.0) return { scale: '6', name: 'Zelo vzvalovano', icon: 'fa-water' };
    return { scale: '7+', name: 'Viharno morje', icon: 'fa-triangle-exclamation' };
}

function getWaveIconHtml(heightM) {
    if (heightM === null || heightM === undefined || isNaN(heightM)) {
        return '<i class="fa-solid fa-water" style="color:#38bdf8;"></i>';
    }
    const h = parseFloat(heightM);
    if (h < 0.3) {
        return '<i class="fa-solid fa-water" style="color:#38bdf8; font-size:1.1rem;" title="Douglas 0-1: Zelo mirno morje (< 0.3m)"></i>';
    } else if (h < 0.8) {
        return '<i class="fa-solid fa-water" style="color:#0284c7; font-size:1.2rem;" title="Douglas 2: Rahlo vzvalovano (0.3 - 0.8m)"></i>';
    } else if (h < 1.5) {
        return '<i class="fa-solid fa-water" style="color:#f59e0b; font-size:1.25rem;" title="Douglas 3-4: Zmerno vzvalovano morje (0.8 - 1.5m)"></i>';
    } else {
        return '<i class="fa-solid fa-triangle-exclamation" style="color:#ef4444; font-size:1.3rem;" title="Douglas 5+: Močno vzvalovano morje (> 1.5m) - Previdnost!"></i>';
    }
}

function getWindArrowUnicode(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '•';
    const arrows = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];
    const idx = Math.round(deg / 45) % 8;
    return arrows[idx];
}

function getWaveTooltipHtml(heightM) {
    if (heightM === null || heightM === undefined || isNaN(heightM)) {
        return '<div class="wave-tooltip-box"><div class="wave-tt-title">Valovanje morja: Podatek ni na voljo</div></div>';
    }
    const h = parseFloat(heightM);
    const d = getDouglasSeaState(h);
    let color = '#38bdf8';
    if (h >= 1.5) color = '#ef4444';
    else if (h >= 0.8) color = '#f59e0b';
    
    return `
        <div class="wave-tooltip-box" style="border-left: 4px solid ${color};">
            <div class="wave-tt-title"><i class="fa-solid fa-water"></i> Douglas lestvica: Stopnja <b>${d.scale}</b></div>
            <div class="wave-tt-desc">Opis stanja: <b>${d.name}</b></div>
            <div class="wave-tt-val">Značilna višina valov: <b>${h.toFixed(1)} m</b></div>
        </div>
    `;
}

function getActiveForecastData() {
    return (arsoForecastData && arsoForecastData.days) ? arsoForecastData.days : openMeteoHourlyForecast;
}

function getWaveHeightForTime(targetDate) {
    const tMs = targetDate.getTime();
    if (marineHourlyWaves.has(tMs)) {
        return marineHourlyWaves.get(tMs);
    }
    let closestVal = currentMarineWaveHeight;
    let minDiff = Infinity;
    for (let [keyMs, val] of marineHourlyWaves.entries()) {
        const diff = Math.abs(keyMs - tMs);
        if (diff < minDiff && diff <= 3 * 3600 * 1000) {
            minDiff = diff;
            closestVal = val;
        }
    }
    return closestVal;
}

function getDayMaxWaveHeight(targetDate) {
    const targetDay = targetDate.getDate();
    const targetMonth = targetDate.getMonth();
    let maxH = -1;
    for (let [keyMs, val] of marineHourlyWaves.entries()) {
        const d = new Date(keyMs);
        if (d.getDate() === targetDay && d.getMonth() === targetMonth) {
            if (val > maxH) maxH = val;
        }
    }
    if (maxH >= 0) return maxH;
    return getWaveHeightForTime(targetDate);
}

function getBeaufortInfo(windSpeedKmh) {
    const s = parseFloat(windSpeedKmh) || 0;
    if (s < 2) return { f: 0, name: 'Bezveterje' };
    if (s <= 5) return { f: 1, name: 'Lahak vetrič' };
    if (s <= 11) return { f: 2, name: 'Vetrič' };
    if (s <= 19) return { f: 3, name: 'Rahli veter' };
    if (s <= 28) return { f: 4, name: 'Zmerni veter' };
    if (s <= 38) return { f: 5, name: 'Močni veter' };
    if (s <= 49) return { f: 6, name: 'Zelo močen veter' };
    if (s <= 61) return { f: 7, name: 'Hudi veter' };
    if (s <= 74) return { f: 8, name: 'Vihar' };
    if (s <= 88) return { f: 9, name: 'Močan vihar' };
    if (s <= 102) return { f: 10, name: 'Polni vihar' };
    if (s <= 117) return { f: 11, name: 'Orkanski vihar' };
    return { f: 12, name: 'Orkan' };
}

function toggleSeaLegend() {
    const legend = document.getElementById('sea-state-legend');
    if (!legend) return;
    const isHidden = legend.style.display === 'none' || !legend.style.display;
    legend.style.display = isHidden ? 'block' : 'none';
}
window.toggleSeaLegend = toggleSeaLegend;

function updateClock() {
    const now = new Date();
    const clockEl = document.getElementById('digital-clock') || document.getElementById('current-time-display');
    if (clockEl) {
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        clockEl.textContent = `${h}:${m}:${s}`;
    }
}

function parseArsoDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.trim().split(/[\s.]+/);
    if (parts.length >= 4) {
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const year = parseInt(parts[2], 10);
        const timeParts = parts[3].split(':');
        const hour = parseInt(timeParts[0], 10);
        const minute = parseInt(timeParts[1], 10);
        return new Date(year, month, day, hour, minute);
    }
    return null;
}

function parseArsoHtml(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');
    const rows = doc.querySelectorAll('table.vode tr, table tr');
    const parsedData = [];
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
            const dateStr = cells[0].textContent.trim();
            const dateObj = parseArsoDate(dateStr);
            if (dateObj) {
                const level = parseFloat(cells[1].textContent.replace(',', '.').trim());
                const temp = parseFloat(cells[2].textContent.replace(',', '.').trim());
                if (!isNaN(level)) {
                    parsedData.push({
                        time: dateObj.getTime(),
                        level: level,
                        temp: isNaN(temp) ? null : temp
                    });
                }
            }
        }
    });
    return parsedData.sort((a, b) => a.time - b.time);
}

async function loadWaterData(arsoPeriod) {
    const url = `https://meteo.arso.gov.si/uploads/probase/www/hidro/data/H9350_t_${arsoPeriod}.html`;
    try {
        const response = await fetch(url);
        if (response.ok) {
            const text = await response.text();
            return parseArsoHtml(text);
        }
    } catch (e) {
        console.warn(`ARSO fetch direct failed for period ${arsoPeriod}:`, e);
    }
    return [];
}

async function loadMergedWaterData(onFirstData) {
    let loadedData = [];
    try {
        const bazdaraUrl = 'https://plimovanje-morja-default-rtdb.europe-west1.firebasedatabase.app/arso/koper_water.json';
        const bazRes = await fetch(bazdaraUrl);
        if (bazRes.ok) {
            const bazJson = await bazRes.json();
            if (bazJson && Array.isArray(bazJson)) {
                loadedData = bazJson;
                if (onFirstData && loadedData.length > 0) {
                    onFirstData(loadedData);
                }
            }
        }
    } catch (err) {
        console.warn('Bazdara initial fetch error:', err);
    }

    try {
        const arsoData = await loadWaterData(periodHours <= 24 ? 1 : (periodHours <= 72 ? 7 : 30));
        if (arsoData && arsoData.length > 0) {
            loadedData = arsoData;
        }
    } catch (err) {
        console.warn('Live ARSO fetch error:', err);
    }

    return loadedData;
}

function getWindDirectionSlo(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '--';
    const directions = ['S', 'SSV', 'SV', 'VSV', 'V', 'VJV', 'JV', 'JJV', 'J', 'JJZ', 'JZ', 'ZJZ', 'Z', 'ZSZ', 'SZ', 'SSZ'];
    const idx = Math.round(deg / 22.5) % 16;
    return directions[idx];
}

function getWindArrowHtml(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '';
    return `<i class="fa-solid fa-arrow-up" style="transform: rotate(${deg}deg); display: inline-block;"></i>`;
}

function getWindDegFromSlo(dirStr) {
    if (!dirStr) return null;
    const map = {
        'S': 0, 'N': 0, 'SSV': 22.5, 'NNE': 22.5, 'SV': 45, 'NE': 45, 'VSV': 67.5, 'ENE': 67.5,
        'V': 90, 'E': 90, 'VJV': 112.5, 'ESE': 112.5, 'JV': 135, 'SE': 135, 'JJV': 157.5, 'SSE': 157.5,
        'J': 180, 'SSW': 202.5, 'JJZ': 202.5, 'JZ': 225, 'SW': 225, 'ZJZ': 247.5, 'WSW': 247.5,
        'Z': 270, 'W': 270, 'ZSZ': 292.5, 'WNW': 292.5, 'SZ': 315, 'NW': 315, 'SSZ': 337.5, 'NNW': 337.5
    };
    return map[dirStr.trim().toUpperCase()] || null;
}

async function fetchWeatherWithFallback(targetUrl, isXml = false) {
    try {
        const res = await fetch(targetUrl);
        if (res.ok) {
            return isXml ? await res.text() : await res.json();
        }
    } catch (e) {
        console.warn('Direct weather fetch failed:', targetUrl);
    }
    return null;
}

async function fetchArsoForecastViaProxy() {
    return null;
}

async function fetchWaveHeight() {
    try {
        const res = await fetch('https://plimovanje-morja-default-rtdb.europe-west1.firebasedatabase.app/arso/wave.json');
        if (res.ok) {
            const data = await res.json();
            if (data && data.wave_height !== undefined) {
                currentMarineWaveHeight = parseFloat(data.wave_height);
            }
        }
    } catch (e) {
        console.warn('Wave height fetch error:', e);
    }
}

function mapArsoIconToFa(nnIcon) {
    if (!nnIcon) return { icon: 'fa-sun', color: '#f59e0b' };
    const icon = nnIcon.toLowerCase();
    if (icon.includes('clear') || icon.includes('jasno') || icon.includes('soncno')) return { icon: 'fa-sun', color: '#f59e0b' };
    if (icon.includes('mostClear') || icon.includes('pretezno_jasno')) return { icon: 'fa-cloud-sun', color: '#f59e0b' };
    if (icon.includes('partlyCloudy') || icon.includes('delno_oblacno')) return { icon: 'fa-cloud-sun', color: '#94a3b8' };
    if (icon.includes('modCloudy') || icon.includes('zmerno_oblacno')) return { icon: 'fa-cloud', color: '#64748b' };
    if (icon.includes('prevCloudy') || icon.includes('pretezno_oblacno')) return { icon: 'fa-cloud', color: '#64748b' };
    if (icon.includes('overcast') || icon.includes('oblacno')) return { icon: 'fa-cloud', color: '#475569' };
    if (icon.includes('fg') || icon.includes('megla')) return { icon: 'fa-smog', color: '#94a3b8' };
    if (icon.includes('lightRain') || icon.includes('rahle_padavine') || icon.includes('rahlo_dezevalo')) return { icon: 'fa-cloud-rain', color: '#38bdf8' };
    if (icon.includes('rain') || icon.includes('dez')) return { icon: 'fa-cloud-showers-heavy', color: '#0284c7' };
    if (icon.includes('heavyRain') || icon.includes('mocan_dez')) return { icon: 'fa-cloud-showers-water', color: '#0369a1' };
    if (icon.includes('shower') || icon.includes('ploha')) return { icon: 'fa-cloud-sun-rain', color: '#0284c7' };
    if (icon.includes('tsShower') || icon.includes('nevihta') || icon.includes('ploha_z_nevihto')) return { icon: 'fa-cloud-bolt', color: '#eab308' };
    if (icon.includes('ts') || icon.includes('grmenje')) return { icon: 'fa-bolt', color: '#eab308' };
    if (icon.includes('snow') || icon.includes('sneg')) return { icon: 'fa-snowflake', color: '#e2e8f0' };
    return { icon: 'fa-cloud-sun', color: '#f59e0b' };
}

function getWeatherIconHtml(nnIcon, sizeStyle = '') {
    const mapped = mapArsoIconToFa(nnIcon);
    return `<i class="fa-solid ${mapped.icon}" style="color:${mapped.color}; ${sizeStyle}"></i>`;
}

function updateOpenMeteoFallbackCards() {
    const container = document.getElementById('forecast-container');
    if (!container) return;
    if (openMeteoHourlyForecast.length === 0) return;

    let html = '';
    const daysToShow = Math.min(3, openMeteoHourlyForecast.length);
    for (let i = 0; i < daysToShow; i++) {
        const item = openMeteoHourlyForecast[i];
        const dateObj = new Date(item.time || item.date);
        const dayName = dateObj.toLocaleDateString('sl-SI', { weekday: 'short', day: 'numeric', month: 'numeric' });
        const iconHtml = getWeatherIconHtml(item.icon || 'clear', 'font-size: 1.8rem;');
        const waveH = getDayMaxWaveHeight(dateObj);
        const waveIcon = getWaveIconHtml(waveH);

        html += `
            <div class="forecast-card" onclick="toggleHourlyForecast(${i})">
                <div class="fc-header">
                    <span class="fc-day">${dayName}</span>
                    <span class="fc-icon">${iconHtml}</span>
                </div>
                <div class="fc-body">
                    <div class="fc-temp"><b>${Math.round(item.temp_max || item.temp || 22)}°C</b> <small style="color:#94a3b8;">${Math.round(item.temp_min || item.temp || 16)}°C</small></div>
                    <div class="fc-wind"><i class="fa-solid fa-wind"></i> ${Math.round(item.wind_speed || 10)} km/h ${getWindDirectionSlo(item.wind_deg)}</div>
                    <div class="fc-wave">${waveIcon} <b>${waveH.toFixed(1)} m</b></div>
                </div>
            </div>
        `;
    }
    container.innerHTML = html;
}

async function loadArsoForecast() {
    try {
        const res = await fetch('https://plimovanje-morja-default-rtdb.europe-west1.firebasedatabase.app/arso/forecast_koper.json');
        if (res.ok) {
            const data = await res.json();
            if (data && (data.days || Array.isArray(data))) {
                arsoForecastData = data;
                renderArsoForecast();
                return;
            }
        }
    } catch (e) {
        console.warn('ARSO forecast json fetch error:', e);
    }
    updateOpenMeteoFallbackCards();
}

function renderArsoForecast() {
    const container = document.getElementById('forecast-container');
    if (!container) return;
    if (!arsoForecastData || !arsoForecastData.days) {
        updateOpenMeteoFallbackCards();
        return;
    }

    let html = '';
    const days = arsoForecastData.days.slice(0, 3);
    days.forEach((day, idx) => {
        const dateObj = new Date(day.date);
        const dayName = dateObj.toLocaleDateString('sl-SI', { weekday: 'short', day: 'numeric', month: 'numeric' });
        const iconHtml = getWeatherIconHtml(day.icon, 'font-size: 1.8rem;');
        const waveH = getDayMaxWaveHeight(dateObj);
        const waveIcon = getWaveIconHtml(waveH);

        html += `
            <div class="forecast-card" onclick="toggleHourlyForecast(${idx})">
                <div class="fc-header">
                    <span class="fc-day">${dayName}</span>
                    <span class="fc-icon">${iconHtml}</span>
                </div>
                <div class="fc-body">
                    <div class="fc-temp"><b>${Math.round(day.temp_max)}°C</b> <small style="color:#94a3b8;">${Math.round(day.temp_min)}°C</small></div>
                    <div class="fc-wind"><i class="fa-solid fa-wind"></i> ${Math.round(day.wind_speed)} km/h ${getWindDirectionSlo(day.wind_deg)}</div>
                    <div class="fc-wave">${waveIcon} <b>${waveH.toFixed(1)} m</b></div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

function renderArso1hForecast(dayOffset = 0) {
    const hourlyBox = document.getElementById('hourly-forecast-list');
    if (!hourlyBox) return;
    if (!arsoForecastData || !arsoForecastData.days || !arsoForecastData.days[dayOffset]) {
        hourlyBox.innerHTML = '<div style="padding:10px; color:#94a3b8;">Podrobna urna napoved ni na voljo.</div>';
        return;
    }

    const day = arsoForecastData.days[dayOffset];
    const hours = day.hourly || [];
    let html = '';
    hours.forEach(h => {
        const timeStr = h.time || '00:00';
        const iconHtml = getWeatherIconHtml(h.icon, 'font-size: 1.2rem;');
        const waveH = h.wave_height !== undefined ? parseFloat(h.wave_height) : currentMarineWaveHeight;
        const waveIcon = getWaveIconHtml(waveH);

        html += `
            <div class="hourly-row">
                <div class="hr-time">${timeStr}</div>
                <div class="hr-icon">${iconHtml}</div>
                <div class="hr-temp"><b>${Math.round(h.temp)}°C</b></div>
                <div class="hr-wind"><i class="fa-solid fa-wind"></i> ${Math.round(h.wind_speed)} km/h ${getWindDirectionSlo(h.wind_deg)}</div>
                <div class="hr-wave">${waveIcon} ${waveH.toFixed(1)} m</div>
            </div>
        `;
    });
    hourlyBox.innerHTML = html;
}

function renderArso3hForecast(dayOffset) {
    renderArso1hForecast(dayOffset);
}

function toggleHourlyForecast(dayOffset) {
    const panel = document.getElementById('hourly-forecast-panel');
    if (!panel) return;

    if (activeHourlyDayOffset === dayOffset && panel.style.display !== 'none') {
        panel.style.display = 'none';
        activeHourlyDayOffset = null;
        return;
    }

    activeHourlyDayOffset = dayOffset;
    panel.style.display = 'block';
    renderArso1hForecast(dayOffset);
}
window.toggleHourlyForecast = toggleHourlyForecast;

async function loadOpenMeteoPressures() {
    try {
        const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=45.548&longitude=13.73&hourly=surface_pressure,wind_speed_10m,wind_direction_10m,wave_height&timezone=Europe%2FLjubljana');
        if (res.ok) {
            const data = await res.json();
            if (data && data.hourly && data.hourly.time) {
                data.hourly.time.forEach((tStr, idx) => {
                    const tMs = new Date(tStr).getTime();
                    meteoForecastMap.set(tMs, {
                        pressure: data.hourly.surface_pressure[idx],
                        wind_speed: data.hourly.wind_speed_10m[idx],
                        wind_deg: data.hourly.wind_direction_10m[idx]
                    });
                    if (data.hourly.wave_height && data.hourly.wave_height[idx] !== null) {
                        marineHourlyWaves.set(tMs, data.hourly.wave_height[idx]);
                    }
                });
            }
        }
    } catch (e) {
        console.warn('OpenMeteo pressure fetch error:', e);
    }
}

async function refreshData() {
    updateClock();
    await loadOpenMeteoPressures();
    await fetchWaveHeight();
    await loadArsoForecast();
    actualData = await loadMergedWaterData(data => {
        actualData = data;
        renderChart();
        updateWaterGauge();
    });
    renderChart();
    updateWaterGauge();
    updateMoonPhase();
}
window.refreshData = refreshData;

function calculateTideExtrema(currentTime) {
    return { high: '--', low: '--' };
}

function getArsoDescriptionFromIcon(iconName) {
    if (!iconName) return 'Jasno';
    const m = iconName.toLowerCase();
    if (m.includes('clear') || m.includes('jasno')) return 'Jasno';
    if (m.includes('cloud') || m.includes('oblacno')) return 'Oblačno';
    if (m.includes('rain') || m.includes('dez')) return 'Deževno';
    return 'Zmerno oblačno';
}

async function parseArsoAmsXml(stationId, cb) {
    const url = `https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observationAms_${stationId}_latest.xml`;
    try {
        const res = await fetch(url);
        if (res.ok) {
            const xmlText = await res.text();
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
            if (cb) cb(xmlDoc);
        }
    } catch (e) {
        console.warn('AMS XML fetch error:', e);
    }
}

async function loadWeather(forceLoadingState = false) {
    await fetchWaveHeight();
    await loadArsoForecast();
    renderWeather();
}
window.loadWeather = loadWeather;

function parseArsoXmlDate(dateStr) {
    return parseArsoDate(dateStr);
}

function getForecastItemForTime(dateObj) {
    return null;
}

function renderWeather() {
    const waveEl = document.getElementById('weather-wave-val');
    const waveIconEl = document.getElementById('weather-wave-icon');
    if (waveEl) waveEl.textContent = `${currentMarineWaveHeight.toFixed(1)} m`;
    if (waveIconEl) waveIconEl.innerHTML = getWaveIconHtml(currentMarineWaveHeight);
}

function updateWaterGauge(relativeLevel) {
    if (actualData.length === 0) return;
    const latest = actualData[actualData.length - 1];
    const relVal = (latest.level - MEAN_SEA_LEVEL_OFFSET);
    const relSign = relVal >= 0 ? `+${relVal.toFixed(1)}` : relVal.toFixed(1);
    
    const gaugeValEl = document.getElementById('water-gauge-val');
    const gaugeAbsEl = document.getElementById('water-gauge-abs');
    const gaugeTempEl = document.getElementById('water-gauge-temp');
    
    if (gaugeValEl) gaugeValEl.textContent = `${relSign} cm`;
    if (gaugeAbsEl) gaugeAbsEl.textContent = `Absolutna višina: ${latest.level.toFixed(1)} cm`;
    if (gaugeTempEl && latest.temp !== null) gaugeTempEl.textContent = `Temperatura morja: ${latest.temp.toFixed(1)}°C`;
}

function setWeatherSource(source) {
    activeWeatherSource = source;
    const btnVida = document.getElementById('btn-source-vida');
    const btnPort = document.getElementById('btn-source-portoroz');
    if (btnVida) btnVida.classList.toggle('active', source === 'vida');
    if (btnPort) btnPort.classList.toggle('active', source === 'portoroz');
    loadWeather();
}
window.setWeatherSource = setWeatherSource;

function setPeriod(hours) {
    periodHours = hours;
    document.querySelectorAll('.period-btn').forEach(btn => btn.classList.remove('active'));
    const btn = document.getElementById(`period-${hours}`);
    if (btn) btn.classList.add('active');
    renderChart();
}
window.setPeriod = setPeriod;

function setChartMode(mode) {
    chartMode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    const btn = document.getElementById(`mode-${mode}`);
    if (btn) btn.classList.add('active');
    renderChart();
}
window.setChartMode = setChartMode;

function renderChart() {
    const chartContainer = document.getElementById('chart-container');
    if (!chartContainer || typeof Highcharts === 'undefined') return;

    const isLight = document.body.classList.contains('light-theme');
    const textColor = isLight ? '#1e293b' : '#f8fafc';
    const gridColor = isLight ? '#e2e8f0' : 'rgba(255, 255, 255, 0.08)';

    const seriesData = [];
    actualData.forEach(pt => {
        const yVal = chartMode === 'level' ? (pt.level - MEAN_SEA_LEVEL_OFFSET) : pt.temp;
        if (yVal !== null && !isNaN(yVal)) {
            seriesData.push([pt.time, yVal]);
        }
    });

    const series = [{
        name: chartMode === 'level' ? 'Relativna gladina (SVS2010)' : 'Temperatura morja',
        data: seriesData,
        color: chartMode === 'level' ? '#0284c7' : '#f59e0b',
        type: 'spline',
        lineWidth: 2.5
    }];

    currentChart = Highcharts.chart('chart-container', {
        chart: {
            backgroundColor: 'transparent',
            style: { fontFamily: 'inherit' }
        },
        title: { text: null },
        credits: { enabled: false },
        xAxis: {
            type: 'datetime',
            labels: { style: { color: textColor } },
            lineColor: gridColor,
            tickColor: gridColor
        },
        yAxis: {
            title: { text: chartMode === 'level' ? 'Višina (cm)' : 'Temperatura (°C)', style: { color: textColor } },
            labels: { style: { color: textColor } },
            gridLineColor: gridColor,
            plotLines: chartMode === 'level' ? [{
                value: 0,
                color: '#ef4444',
                width: 1.5,
                dashStyle: 'ShortDash',
                label: { text: 'Srednja gladina morja (0 cm)', style: { color: '#ef4444', fontSize: '10px' } }
            }] : []
        },
        legend: { enabled: false },
        tooltip: {
            shared: true,
            useHTML: true,
            formatter: function () {
                let s = `<div style="font-size:12px;"><b>${Highcharts.dateFormat('%A, %e. %b %Y, %H:%M', this.x)}</b><br/>`;
                this.points.forEach(point => {
                    s += `<span style="color:${point.color}">●</span> ${point.series.name}: <b>${point.y.toFixed(1)} ${chartMode === 'level' ? 'cm' : '°C'}</b><br/>`;
                });
                s += `</div>`;
                return s;
            }
        },
        series: series
    });
}

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
    
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    
    const darkGrad = ctx.createRadialGradient(cx - r*0.3, cy - r*0.3, r*0.1, cx, cy, r);
    darkGrad.addColorStop(0, '#2d3748');
    darkGrad.addColorStop(0.8, '#1e293b');
    darkGrad.addColorStop(1, '#0f172a');
    ctx.fillStyle = darkGrad;
    ctx.fill();
    ctx.restore();
    
    const synodic = 29.530588853;
    const phase = ((ageDays % synodic) + synodic) % synodic / synodic;
    
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    
    ctx.beginPath();
    if (phase < 0.5) {
        ctx.arc(cx, cy, r, -Math.PI/2, Math.PI/2, false);
        const k = Math.cos(phase * 2 * Math.PI);
        ctx.ellipse(cx, cy, Math.max(0.1, Math.abs(r * k)), r, 0, Math.PI/2, -Math.PI/2, k > 0);
    } else {
        ctx.arc(cx, cy, r, Math.PI/2, -Math.PI/2, false);
        const k = Math.cos(phase * 2 * Math.PI);
        ctx.ellipse(cx, cy, Math.max(0.1, Math.abs(r * k)), r, 0, -Math.PI/2, Math.PI/2, k > 0);
    }
    ctx.closePath();
    
    const litGrad = ctx.createRadialGradient(cx - r*0.3, cy - r*0.3, r*0.05, cx, cy, r);
    litGrad.addColorStop(0, '#ffffff');
    litGrad.addColorStop(0.3, '#f8fafc');
    litGrad.addColorStop(0.7, '#e2e8f0');
    litGrad.addColorStop(1, '#94a3b8');
    ctx.fillStyle = litGrad;
    ctx.fill();
    ctx.restore();
    
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
}

function updateMoonPhase() {
    const now = new Date();
    const refNewMoon = 947182440000;
    const synodicMonth = 2551442977;
    
    const diffMs = now.getTime() - refNewMoon;
    const ageDays = ((diffMs % synodicMonth) + synodicMonth) % synodicMonth / 86400000;
    
    let phaseName = '';
    let coeffDesc = 'Normalno plimovanje';
    
    if (ageDays < 1.0 || ageDays >= 28.53) {
        phaseName = 'Prazna Luna - Mlaj';
        coeffDesc = 'Močno plimovanje (Sizigij)';
    } else if (ageDays < 6.38) {
        phaseName = 'Rastoča Luna';
    } else if (ageDays < 8.38) {
        phaseName = 'Prvi krajec';
        coeffDesc = 'Šibko plimovanje (Kvadratura)';
    } else if (ageDays < 13.76) {
        phaseName = 'Naraščajoča Luna';
    } else if (ageDays < 15.76) {
        phaseName = 'Polna Luna - Ščip';
        coeffDesc = 'Močno plimovanje (Sizigij)';
    } else if (ageDays < 21.14) {
        phaseName = 'Upadajoča Luna';
    } else if (ageDays < 23.14) {
        phaseName = 'Zadnji krajec';
        coeffDesc = 'Šibko plimovanje (Kvadratura)';
    } else {
        phaseName = 'Prazneča Luna';
    }
    
    drawRealisticMoon(ageDays);
    
    const phaseNameEl = document.getElementById('moon-phase-name');
    const coeffValEl = document.getElementById('moon-coeff-val');
    if (phaseNameEl) phaseNameEl.textContent = phaseName;
    if (coeffValEl) coeffValEl.innerHTML = `Tip: ${coeffDesc}`;
}

function toggleTheme() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateThemeIcon();
    renderChart();
}
window.toggleTheme = toggleTheme;

function updateThemeIcon() {
    const icon = document.getElementById('theme-icon-indicator');
    if (!icon) return;
    if (document.body.classList.contains('light-theme')) {
        icon.className = 'fa-solid fa-moon';
        icon.style.color = '#475569';
    } else {
        icon.className = 'fa-solid fa-sun';
        icon.style.color = '#e2e8f0';
    }
}

// =========================================================================
// SECTION 2: NAUTICAL ENGINE & GEOMETRY CONSTANTS
// =========================================================================

function getShortestAngleDelta(fromAngle, toAngle) {
    return ((toAngle - fromAngle) % 360 + 540) % 360 - 180;
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function calculateBearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
}

function formatDuration(sec) {
    if (isNaN(sec) || sec <= 0) return '00:00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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

function getHeadingCardinal(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return '--';
    const cardinals = ['S', 'SSV', 'SV', 'VSV', 'V', 'VJV', 'JV', 'JJV', 'J', 'JJZ', 'JZ', 'ZJZ', 'Z', 'ZSZ', 'SZ', 'SSZ'];
    const normalized = (deg % 360 + 360) % 360;
    const idx = Math.round(normalized / 22.5) % 16;
    return cardinals[idx];
}

const SLO_COAST_200M_GUIDE_NODES = [
    [45.594560, 13.720400],
    [45.593786, 13.718967],
    [45.594435, 13.715360],
    [45.595396, 13.710560],
    [45.595007, 13.706276],
    [45.593502, 13.702531],
    [45.589501, 13.700685],
    [45.585941, 13.705510],
    [45.582904, 13.711294],
    [45.581717, 13.716564],
    [45.578180, 13.724363],
    [45.578115, 13.728455],
    [45.573179, 13.732743],
    [45.572556, 13.739323],
    [45.568104, 13.737157],
    [45.562189, 13.731849],
    [45.552214, 13.724362],
    [45.549799, 13.720293],
    [45.546639, 13.721603],
    [45.544708, 13.718903],
    [45.548610, 13.711700],
    [45.549265, 13.705626],
    [45.550165, 13.691433],
    [45.546855, 13.676613],
    [45.542018, 13.670182],
    [45.541174, 13.667549],
    [45.542556, 13.667035],
    [45.544069, 13.664312],
    [45.543676, 13.655941],
    [45.542575, 13.653442],
    [45.539267, 13.652564],
    [45.538055, 13.651645],
    [45.537724, 13.648538],
    [45.535516, 13.644758],
    [45.535287, 13.638965],
    [45.534727, 13.636008],
    [45.535014, 13.632409],
    [45.536455, 13.627692],
    [45.537744, 13.623997],
    [45.538943, 13.622039],
    [45.540280, 13.620473],
    [45.541783, 13.618348],
    [45.542159, 13.613606],
    [45.541775, 13.611261],
    [45.539297, 13.601081],
    [45.536961, 13.598593],
    [45.534158, 13.598232],
    [45.530889, 13.597427],
    [45.528267, 13.600487],
    [45.527674, 13.599782],
    [45.528088, 13.598228],
    [45.528394, 13.595803],
    [45.528363, 13.593658],
    [45.528120, 13.590806],
    [45.527962, 13.589501],
    [45.528369, 13.586217],
    [45.527751, 13.582433],
    [45.527130, 13.581031],
    [45.527909, 13.580058],
    [45.529630, 13.576925],
    [45.531043, 13.573428],
    [45.531559, 13.570629],
    [45.532412, 13.566540],
    [45.532644, 13.563513],
    [45.531609, 13.560444],
    [45.529912, 13.559867],
    [45.528250, 13.561703],
    [45.527468, 13.563728],
    [45.526055, 13.563911],
    [45.524503, 13.564127],
    [45.521811, 13.563541],
    [45.519399, 13.564652],
    [45.515977, 13.566164],
    [45.513087, 13.569936],
    [45.511871, 13.572993],
    [45.513336, 13.576169],
    [45.513843, 13.577335],
    [45.512303, 13.580328],
    [45.511458, 13.582658],
    [45.510755, 13.587434],
    [45.510599, 13.589365],
    [45.510546, 13.591050],
    [45.508670, 13.590728],
    [45.507332, 13.592042],
    [45.506464, 13.592067],
    [45.505369, 13.591794],
    [45.505108, 13.591199],
    [45.504917, 13.588373],
    [45.503385, 13.585435],
    [45.501920, 13.584209],
    [45.500497, 13.583928],
    [45.499450, 13.582395],
    [45.497862, 13.581808],
    [45.495526, 13.584108],
    [45.494240, 13.585576],
    [45.492375, 13.585607],
    [45.490621, 13.587525],
    [45.488732, 13.589453],
    [45.486646, 13.589527],
    [45.484172, 13.589854],
    [45.482396, 13.588688],
    [45.481762, 13.586959],
    [45.480198, 13.584447],
];


// High-precision Slovenian Coastline Closed Polygon (OSM Verified)
const SLO_COASTLINE_POLYGON = [
    [45.60370, 13.79734],
    [45.60236, 13.79222],
    [45.60218, 13.79052],
    [45.60188, 13.79031],
    [45.60154, 13.79038],
    [45.60121, 13.79008],
    [45.60092, 13.79048],
    [45.60125, 13.78830],
    [45.60013, 13.78647],
    [45.59943, 13.78571],
    [45.59845, 13.78570],
    [45.59795, 13.78587],
    [45.59784, 13.78546],
    [45.59870, 13.78416],
    [45.59861, 13.78236],
    [45.59982, 13.78004],
    [45.59946, 13.77976],
    [45.59951, 13.77961],
    [45.59973, 13.77976],
    [45.59966, 13.77948],
    [45.60015, 13.77878],
    [45.60118, 13.77779],
    [45.60141, 13.77800],
    [45.60146, 13.77769],
    [45.60195, 13.77779],
    [45.60198, 13.77752],
    [45.60203, 13.77781],
    [45.60256, 13.77781],
    [45.60281, 13.77617],
    [45.60338, 13.77658],
    [45.60422, 13.77500],
    [45.60364, 13.77430],
    [45.60401, 13.77345],
    [45.60424, 13.77363],
    [45.60445, 13.77292],
    [45.60429, 13.77276],
    [45.60432, 13.77249],
    [45.60476, 13.77202],
    [45.60484, 13.77160],
    [45.60447, 13.77094],
    [45.60446, 13.77009],
    [45.60413, 13.77004],
    [45.60412, 13.76980],
    [45.60451, 13.76983],
    [45.60470, 13.76903],
    [45.60500, 13.76917],
    [45.60471, 13.76897],
    [45.60492, 13.76848],
    [45.60503, 13.76854],
    [45.60506, 13.76819],
    [45.60520, 13.76828],
    [45.60520, 13.76811],
    [45.60567, 13.76794],
    [45.60565, 13.76779],
    [45.60713, 13.76725],
    [45.60715, 13.76617],
    [45.60709, 13.76720],
    [45.60510, 13.76790],
    [45.60491, 13.76783],
    [45.60475, 13.76802],
    [45.60473, 13.76747],
    [45.60491, 13.76730],
    [45.60494, 13.76776],
    [45.60533, 13.76762],
    [45.60522, 13.76708],
    [45.60563, 13.76683],
    [45.60581, 13.76734],
    [45.60564, 13.76657],
    [45.60622, 13.76551],
    [45.60655, 13.76585],
    [45.60674, 13.76661],
    [45.60660, 13.76581],
    [45.60623, 13.76542],
    [45.60638, 13.76442],
    [45.60630, 13.76393],
    [45.60696, 13.76156],
    [45.60715, 13.75923],
    [45.60734, 13.75906],
    [45.60760, 13.75749],
    [45.60848, 13.75656],
    [45.60886, 13.75668],
    [45.60940, 13.75383],
    [45.61012, 13.75184],
    [45.61001, 13.75176],
    [45.60989, 13.75208],
    [45.60965, 13.75190],
    [45.60959, 13.75206],
    [45.60977, 13.75219],
    [45.60976, 13.75247],
    [45.60930, 13.75377],
    [45.60881, 13.75632],
    [45.60718, 13.75584],
    [45.60723, 13.75498],
    [45.60605, 13.75359],
    [45.60632, 13.75367],
    [45.60707, 13.75439],
    [45.60721, 13.75317],
    [45.60692, 13.75297],
    [45.60753, 13.75120],
    [45.60863, 13.75129],
    [45.60921, 13.75171],
    [45.60877, 13.75128],
    [45.60927, 13.74987],
    [45.61064, 13.75137],
    [45.61040, 13.75260],
    [45.61059, 13.75255],
    [45.61079, 13.75169],
    [45.61068, 13.75119],
    [45.60901, 13.74949],
    [45.60907, 13.74892],
    [45.60855, 13.74696],
    [45.60853, 13.74394],
    [45.60873, 13.74304],
    [45.60875, 13.74182],
    [45.60894, 13.74184],
    [45.60897, 13.74162],
    [45.60880, 13.74151],
    [45.60904, 13.74065],
    [45.60942, 13.74100],
    [45.60949, 13.74074],
    [45.60906, 13.74061],
    [45.60909, 13.74051],
    [45.60931, 13.74064],
    [45.60940, 13.74037],
    [45.60930, 13.74028],
    [45.60980, 13.73926],
    [45.61057, 13.73695],
    [45.61062, 13.73470],
    [45.60997, 13.73257],
    [45.60840, 13.73090],
    [45.60802, 13.73076],
    [45.60806, 13.73052],
    [45.60748, 13.72984],
    [45.60729, 13.72980],
    [45.60639, 13.72837],
    [45.60601, 13.72726],
    [45.60598, 13.72690],
    [45.60619, 13.72685],
    [45.60596, 13.72581],
    [45.60616, 13.72447],
    [45.60606, 13.72387],
    [45.60577, 13.72354],
    [45.60580, 13.72302],
    [45.60550, 13.72262],
    [45.60555, 13.72225],
    [45.60542, 13.72236],
    [45.60536, 13.72211],
    [45.60554, 13.72203],
    [45.60541, 13.72167],
    [45.60550, 13.72089],
    [45.60582, 13.71997],
    [45.60573, 13.71914],
    [45.60474, 13.71905],
    [45.60293, 13.71950],
    [45.60200, 13.72039],
    [45.60090, 13.72103],
    [45.60075, 13.72093],
    [45.60052, 13.71991],
    [45.59970, 13.72030],
    [45.59961, 13.71996],
    [45.59802, 13.72072],
    [45.59808, 13.72107],
    [45.59726, 13.72145],
    [45.59734, 13.72177],
    [45.59650, 13.72200],
    [45.59681, 13.72213],
    [45.59731, 13.72188],
    [45.59750, 13.72252],
    [45.59676, 13.72295],
    [45.59665, 13.72253],
    [45.59667, 13.72317],
    [45.59599, 13.72342],
    [45.59498, 13.72330],
    [45.59481, 13.72298],
    [45.59489, 13.72240],
    [45.59472, 13.72282],
    [45.59433, 13.72319],
    [45.59428, 13.72298],
    [45.59359, 13.72305],
    [45.59318, 13.72351],
    [45.59249, 13.72325],
    [45.59216, 13.72283],
    [45.59196, 13.72216],
    [45.59153, 13.72192],
    [45.59119, 13.72080],
    [45.59134, 13.72047],
    [45.59153, 13.72059],
    [45.59181, 13.72047],
    [45.59194, 13.71992],
    [45.59079, 13.71969],
    [45.59068, 13.71955],
    [45.59066, 13.71811],
    [45.59156, 13.71528],
    [45.59218, 13.71455],
    [45.59251, 13.71470],
    [45.59256, 13.71501],
    [45.59238, 13.71517],
    [45.59254, 13.71513],
    [45.59285, 13.71394],
    [45.59301, 13.71405],
    [45.59290, 13.71391],
    [45.59336, 13.71248],
    [45.59364, 13.71266],
    [45.59339, 13.71240],
    [45.59368, 13.70845],
    [45.59247, 13.70448],
    [45.59201, 13.70407],
    [45.59095, 13.70357],
    [45.58994, 13.70338],
    [45.58867, 13.70535],
    [45.58819, 13.70686],
    [45.58767, 13.70709],
    [45.58773, 13.70675],
    [45.58735, 13.70730],
    [45.58755, 13.70705],
    [45.58766, 13.70717],
    [45.58736, 13.70785],
    [45.58746, 13.70774],
    [45.58764, 13.70800],
    [45.58748, 13.70876],
    [45.58686, 13.70932],
    [45.58671, 13.70908],
    [45.58682, 13.70943],
    [45.58519, 13.71132],
    [45.58439, 13.71280],
    [45.58330, 13.71835],
    [45.58300, 13.71878],
    [45.58291, 13.71928],
    [45.58312, 13.71973],
    [45.58248, 13.72132],
    [45.58210, 13.72119],
    [45.58261, 13.72146],
    [45.58261, 13.72164],
    [45.58193, 13.72372],
    [45.58133, 13.72451],
    [45.58093, 13.72481],
    [45.58084, 13.72468],
    [45.58037, 13.72510],
    [45.58004, 13.72506],
    [45.57973, 13.72551],
    [45.57974, 13.72586],
    [45.57978, 13.72563],
    [45.58037, 13.72564],
    [45.58036, 13.72584],
    [45.58015, 13.72569],
    [45.58014, 13.72583],
    [45.58036, 13.72587],
    [45.58048, 13.72652],
    [45.58052, 13.72799],
    [45.58012, 13.72920],
    [45.57923, 13.73066],
    [45.57866, 13.73122],
    [45.57824, 13.73157],
    [45.57792, 13.73070],
    [45.57820, 13.73159],
    [45.57681, 13.73245],
    [45.57664, 13.73243],
    [45.57636, 13.73164],
    [45.57659, 13.73242],
    [45.57540, 13.73325],
    [45.57458, 13.73432],
    [45.57430, 13.73408],
    [45.57426, 13.73417],
    [45.57468, 13.73459],
    [45.57429, 13.73602],
    [45.57443, 13.73704],
    [45.57470, 13.73765],
    [45.57418, 13.74062],
    [45.57365, 13.74165],
    [45.57290, 13.74242],
    [45.57274, 13.74244],
    [45.57263, 13.74224],
    [45.57174, 13.74273],
    [45.57113, 13.74185],
    [45.57188, 13.74329],
    [45.57152, 13.74350],
    [45.57058, 13.74217],
    [45.57074, 13.74093],
    [45.57028, 13.74002],
    [45.57058, 13.74077],
    [45.57053, 13.74230],
    [45.56962, 13.74279],
    [45.56875, 13.74242],
    [45.56853, 13.74199],
    [45.56798, 13.74170],
    [45.56796, 13.74088],
    [45.56795, 13.74653],
    [45.56764, 13.74639],
    [45.56729, 13.74649],
    [45.56720, 13.74626],
    [45.56636, 13.74630],
    [45.56631, 13.74650],
    [45.56606, 13.74649],
    [45.56598, 13.74563],
    [45.56567, 13.74566],
    [45.56569, 13.74622],
    [45.56544, 13.74678],
    [45.56431, 13.74626],
    [45.56404, 13.73966],
    [45.56374, 13.73650],
    [45.56307, 13.73583],
    [45.56303, 13.73486],
    [45.56272, 13.73426],
    [45.55965, 13.73284],
    [45.55946, 13.73329],
    [45.55960, 13.73969],
    [45.55919, 13.73971],
    [45.55925, 13.74226],
    [45.55967, 13.74224],
    [45.55967, 13.74239],
    [45.55941, 13.74288],
    [45.55924, 13.74289],
    [45.55919, 13.74422],
    [45.55867, 13.74590],
    [45.55833, 13.74599],
    [45.55839, 13.74496],
    [45.55822, 13.74494],
    [45.55815, 13.74463],
    [45.55837, 13.74462],
    [45.55836, 13.74405],
    [45.55804, 13.74407],
    [45.55802, 13.74357],
    [45.55776, 13.74316],
    [45.55757, 13.73650],
    [45.55727, 13.73652],
    [45.55739, 13.73885],
    [45.55707, 13.73886],
    [45.55703, 13.73691],
    [45.55730, 13.73628],
    [45.55724, 13.73335],
    [45.55620, 13.73167],
    [45.55525, 13.73079],
    [45.55521, 13.72883],
    [45.55311, 13.72896],
    [45.55339, 13.73789],
    [45.55365, 13.73787],
    [45.55364, 13.73799],
    [45.55338, 13.73835],
    [45.55337, 13.73797],
    [45.55319, 13.73799],
    [45.55321, 13.73839],
    [45.55296, 13.73833],
    [45.55284, 13.73849],
    [45.55266, 13.73851],
    [45.55265, 13.73820],
    [45.55247, 13.73821],
    [45.55248, 13.73851],
    [45.55225, 13.73863],
    [45.55047, 13.73403],
    [45.55031, 13.72866],
    [45.55059, 13.72782],
    [45.55076, 13.72813],
    [45.55085, 13.72597],
    [45.55050, 13.72568],
    [45.55080, 13.72600],
    [45.55072, 13.72760],
    [45.55041, 13.72763],
    [45.55038, 13.72696],
    [45.55038, 13.72763],
    [45.55021, 13.72766],
    [45.55019, 13.72745],
    [45.55012, 13.72766],
    [45.55008, 13.72692],
    [45.55019, 13.72688],
    [45.55003, 13.72689],
    [45.55001, 13.72654],
    [45.55045, 13.72648],
    [45.55049, 13.72661],
    [45.55047, 13.72633],
    [45.55028, 13.72635],
    [45.54990, 13.72586],
    [45.54959, 13.72515],
    [45.54976, 13.72482],
    [45.54903, 13.72293],
    [45.54841, 13.72204],
    [45.54832, 13.72219],
    [45.54882, 13.72292],
    [45.54895, 13.72349],
    [45.54879, 13.72450],
    [45.54823, 13.72454],
    [45.54814, 13.72377],
    [45.54816, 13.72457],
    [45.54792, 13.72458],
    [45.54792, 13.72498],
    [45.54807, 13.72512],
    [45.54797, 13.72525],
    [45.54774, 13.72534],
    [45.54762, 13.72506],
    [45.54695, 13.72530],
    [45.54778, 13.72462],
    [45.54688, 13.72521],
    [45.54647, 13.72466],
    [45.54702, 13.72407],
    [45.54780, 13.72384],
    [45.54780, 13.72372],
    [45.54700, 13.72401],
    [45.54644, 13.72461],
    [45.54295, 13.71985],
    [45.54287, 13.71881],
    [45.54399, 13.71713],
    [45.54392, 13.71657],
    [45.54562, 13.71409],
    [45.54582, 13.71410],
    [45.54601, 13.71384],
    [45.54573, 13.71353],
    [45.54573, 13.71298],
    [45.54680, 13.71050],
    [45.54670, 13.71010],
    [45.54694, 13.70934],
    [45.54683, 13.70854],
    [45.54711, 13.70719],
    [45.54717, 13.70532],
    [45.54736, 13.70533],
    [45.54717, 13.70529],
    [45.54722, 13.70491],
    [45.54739, 13.70496],
    [45.54737, 13.70527],
    [45.54742, 13.70494],
    [45.54723, 13.70489],
    [45.54808, 13.70118],
    [45.54801, 13.69355],
    [45.54827, 13.69155],
    [45.54820, 13.69082],
    [45.54616, 13.68318],
    [45.54584, 13.68029],
    [45.54505, 13.67797],
    [45.54448, 13.67722],
    [45.54266, 13.67573],
    [45.54198, 13.67495],
    [45.54052, 13.67197],
    [45.53913, 13.67021],
    [45.53890, 13.66922],
    [45.53883, 13.66856],
    [45.53986, 13.66454],
    [45.53997, 13.66484],
    [45.54001, 13.66453],
    [45.54001, 13.66490],
    [45.54005, 13.66456],
    [45.54224, 13.66450],
    [45.54223, 13.66435],
    [45.54159, 13.66438],
    [45.54164, 13.66395],
    [45.54132, 13.66382],
    [45.54150, 13.66317],
    [45.54161, 13.66307],
    [45.54169, 13.66326],
    [45.54203, 13.66321],
    [45.54218, 13.66296],
    [45.54215, 13.66221],
    [45.54186, 13.66145],
    [45.54214, 13.65978],
    [45.54198, 13.65879],
    [45.54210, 13.65855],
    [45.54193, 13.65848],
    [45.54171, 13.65707],
    [45.54174, 13.65594],
    [45.54148, 13.65576],
    [45.54100, 13.65627],
    [45.54024, 13.65618],
    [45.53975, 13.65640],
    [45.53940, 13.65636],
    [45.53933, 13.65513],
    [45.53921, 13.65515],
    [45.53928, 13.65632],
    [45.53872, 13.65610],
    [45.53745, 13.65411],
    [45.53716, 13.65223],
    [45.53704, 13.65212],
    [45.53695, 13.65232],
    [45.53731, 13.65415],
    [45.53852, 13.65612],
    [45.53846, 13.65642],
    [45.53876, 13.65632],
    [45.53890, 13.65643],
    [45.53892, 13.65699],
    [45.53849, 13.65718],
    [45.53835, 13.65689],
    [45.53839, 13.65646],
    [45.53824, 13.65674],
    [45.53741, 13.65725],
    [45.53676, 13.65876],
    [45.53578, 13.65788],
    [45.53580, 13.65753],
    [45.53533, 13.65714],
    [45.53540, 13.65695],
    [45.53531, 13.65714],
    [45.53501, 13.65686],
    [45.53487, 13.65693],
    [45.53502, 13.65617],
    [45.53492, 13.65592],
    [45.53473, 13.65599],
    [45.53487, 13.65584],
    [45.53407, 13.65385],
    [45.53364, 13.65396],
    [45.53344, 13.65345],
    [45.53365, 13.65276],
    [45.53378, 13.65102],
    [45.53418, 13.65102],
    [45.53420, 13.64996],
    [45.53584, 13.64990],
    [45.53646, 13.65367],
    [45.53637, 13.65384],
    [45.53649, 13.65391],
    [45.53663, 13.65373],
    [45.53606, 13.64970],
    [45.53478, 13.64968],
    [45.53449, 13.64943],
    [45.53450, 13.64978],
    [45.53403, 13.64972],
    [45.53391, 13.64875],
    [45.53411, 13.64862],
    [45.53386, 13.64863],
    [45.53385, 13.64657],
    [45.53328, 13.64631],
    [45.53236, 13.64520],
    [45.53213, 13.64525],
    [45.53186, 13.64426],
    [45.53245, 13.64118],
    [45.53322, 13.63958],
    [45.53334, 13.63893],
    [45.53323, 13.63798],
    [45.53281, 13.63690],
    [45.53274, 13.63556],
    [45.53299, 13.63260],
    [45.53362, 13.62973],
    [45.53549, 13.62468],
    [45.53534, 13.62400],
    [45.53623, 13.62207],
    [45.53773, 13.61955],
    [45.53876, 13.61852],
    [45.53977, 13.61700],
    [45.54000, 13.61370],
    [45.53971, 13.61297],
    [45.53884, 13.61261],
    [45.53813, 13.61202],
    [45.53762, 13.61104],
    [45.53746, 13.60941],
    [45.53781, 13.60785],
    [45.53794, 13.60614],
    [45.53772, 13.60427],
    [45.53731, 13.60252],
    [45.53693, 13.60184],
    [45.53576, 13.60225],
    [45.53475, 13.60192],
    [45.53339, 13.60097],
    [45.53241, 13.60064],
    [45.53238, 13.60043],
    [45.53234, 13.60064],
    [45.53120, 13.60077],
    [45.53105, 13.60042],
    [45.53109, 13.60101],
    [45.53076, 13.60125],
    [45.53080, 13.60137],
    [45.53036, 13.60153],
    [45.52881, 13.60310],
    [45.52831, 13.60338],
    [45.52817, 13.60334],
    [45.52817, 13.60303],
    [45.52801, 13.60371],
    [45.52787, 13.60368],
    [45.52789, 13.60315],
    [45.52664, 13.60220],
    [45.52672, 13.60189],
    [45.52658, 13.60225],
    [45.52643, 13.60215],
    [45.52649, 13.60191],
    [45.52597, 13.60167],
    [45.52588, 13.60087],
    [45.52541, 13.59974],
    [45.52558, 13.59907],
    [45.52607, 13.59817],
    [45.52642, 13.59629],
    [45.52651, 13.59255],
    [45.52610, 13.59137],
    [45.52573, 13.59097],
    [45.52569, 13.59057],
    [45.52617, 13.58868],
    [45.52628, 13.58742],
    [45.52622, 13.58399],
    [45.52588, 13.58343],
    [45.52569, 13.58248],
    [45.52550, 13.58274],
    [45.52538, 13.58251],
    [45.52516, 13.58105],
    [45.52552, 13.57986],
    [45.52857, 13.57401],
    [45.52991, 13.56860],
    [45.53024, 13.56631],
    [45.53038, 13.56633],
    [45.53047, 13.56520],
    [45.53060, 13.56505],
    [45.53040, 13.56302],
    [45.53016, 13.56297],
    [45.52867, 13.56594],
    [45.52752, 13.56691],
    [45.52723, 13.56690],
    [45.52711, 13.56674],
    [45.52704, 13.56686],
    [45.52619, 13.56628],
    [45.52614, 13.56641],
    [45.52746, 13.56730],
    [45.52741, 13.56755],
    [45.52750, 13.56732],
    [45.52800, 13.56754],
    [45.52817, 13.56783],
    [45.52805, 13.56810],
    [45.52737, 13.56785],
    [45.52740, 13.56764],
    [45.52700, 13.56853],
    [45.52644, 13.56863],
    [45.52546, 13.56761],
    [45.52616, 13.56676],
    [45.52570, 13.56718],
    [45.52429, 13.56666],
    [45.52299, 13.56673],
    [45.52245, 13.56640],
    [45.52186, 13.56628],
    [45.52114, 13.56641],
    [45.51876, 13.56799],
    [45.51872, 13.56818],
    [45.51672, 13.56883],
    [45.51583, 13.57009],
    [45.51569, 13.57001],
    [45.51582, 13.57041],
    [45.51545, 13.57093],
    [45.51490, 13.57147],
    [45.51465, 13.57146],
    [45.51393, 13.57250],
    [45.51376, 13.57299],
    [45.51417, 13.57396],
    [45.51461, 13.57348],
    [45.51437, 13.57333],
    [45.51430, 13.57272],
    [45.51450, 13.57258],
    [45.51481, 13.57298],
    [45.51482, 13.57340],
    [45.51448, 13.57401],
    [45.51466, 13.57404],
    [45.51520, 13.57470],
    [45.51509, 13.57488],
    [45.51542, 13.57569],
    [45.51570, 13.57563],
    [45.51591, 13.57756],
    [45.51577, 13.57751],
    [45.51595, 13.57767],
    [45.51588, 13.57795],
    [45.51567, 13.57779],
    [45.51585, 13.57799],
    [45.51511, 13.57972],
    [45.51396, 13.58157],
    [45.51347, 13.58291],
    [45.51330, 13.58260],
    [45.51317, 13.58298],
    [45.51327, 13.58285],
    [45.51345, 13.58298],
    [45.51302, 13.58454],
    [45.51285, 13.58666],
    [45.51295, 13.58799],
    [45.51270, 13.58807],
    [45.51296, 13.58805],
    [45.51304, 13.58858],
    [45.51280, 13.58869],
    [45.51304, 13.58863],
    [45.51341, 13.58918],
    [45.51352, 13.59037],
    [45.51254, 13.58969],
    [45.51249, 13.58982],
    [45.51349, 13.59052],
    [45.51328, 13.59278],
    [45.51247, 13.59372],
    [45.51201, 13.59396],
    [45.51128, 13.59402],
    [45.50962, 13.59336],
    [45.50886, 13.59358],
    [45.50800, 13.59487],
    [45.50774, 13.59431],
    [45.50795, 13.59488],
    [45.50740, 13.59482],
    [45.50707, 13.59553],
    [45.50706, 13.59877],
    [45.50613, 13.60124],
    [45.50591, 13.60104],
    [45.50602, 13.60030],
    [45.50686, 13.59871],
    [45.50694, 13.59474],
    [45.50557, 13.59469],
    [45.50554, 13.59457],
    [45.50543, 13.59521],
    [45.50548, 13.59499],
    [45.50686, 13.59505],
    [45.50686, 13.59543],
    [45.50577, 13.59545],
    [45.50571, 13.59534],
    [45.50571, 13.59562],
    [45.50686, 13.59550],
    [45.50685, 13.59594],
    [45.50577, 13.59593],
    [45.50572, 13.59580],
    [45.50571, 13.59612],
    [45.50577, 13.59600],
    [45.50685, 13.59601],
    [45.50685, 13.59663],
    [45.50549, 13.59664],
    [45.50550, 13.59585],
    [45.50532, 13.59583],
    [45.50546, 13.59592],
    [45.50545, 13.59664],
    [45.50533, 13.59682],
    [45.50525, 13.59650],
    [45.50520, 13.59696],
    [45.50507, 13.59693],
    [45.50507, 13.59583],
    [45.50503, 13.59692],
    [45.50469, 13.59746],
    [45.50456, 13.59738],
    [45.50450, 13.59763],
    [45.50450, 13.59736],
    [45.50442, 13.59760],
    [45.50412, 13.59744],
    [45.50449, 13.59589],
    [45.50470, 13.59593],
    [45.50433, 13.59576],
    [45.50445, 13.59587],
    [45.50406, 13.59748],
    [45.50356, 13.59723],
    [45.50395, 13.59561],
    [45.50411, 13.59564],
    [45.50383, 13.59551],
    [45.50393, 13.59560],
    [45.50353, 13.59721],
    [45.50312, 13.59701],
    [45.50351, 13.59540],
    [45.50363, 13.59539],
    [45.50338, 13.59527],
    [45.50348, 13.59537],
    [45.50308, 13.59700],
    [45.50274, 13.59682],
    [45.50312, 13.59521],
    [45.50324, 13.59520],
    [45.50299, 13.59508],
    [45.50309, 13.59518],
    [45.50270, 13.59680],
    [45.50237, 13.59664],
    [45.50269, 13.59521],
    [45.50232, 13.59674],
    [45.50206, 13.59658],
    [45.50231, 13.59545],
    [45.50277, 13.59438],
    [45.50470, 13.59532],
    [45.50511, 13.59516],
    [45.50535, 13.59451],
    [45.50389, 13.59382],
    [45.50360, 13.59350],
    [45.50293, 13.59440],
    [45.50278, 13.59433],
    [45.50321, 13.59379],
    [45.50308, 13.59377],
    [45.50313, 13.59356],
    [45.50326, 13.59368],
    [45.50305, 13.59033],
    [45.50318, 13.59031],
    [45.50320, 13.58998],
    [45.50254, 13.58813],
    [45.50182, 13.58714],
    [45.50128, 13.58668],
    [45.50077, 13.58659],
    [45.50010, 13.58702],
    [45.49967, 13.58664],
    [45.49811, 13.58440],
    [45.49489, 13.58888],
    [45.49454, 13.58854],
    [45.49302, 13.58804],
    [45.49179, 13.58955],
    [45.49220, 13.59029],
    [45.48894, 13.59240],
    [45.48525, 13.59233],
    [45.48512, 13.59280],
    [45.48332, 13.59292],
    [45.48340, 13.59245],
    [45.47929, 13.58989],
    [45.47921, 13.58967],
    [45.48007, 13.58846],
    [45.47849, 13.58573],
    [45.47454, 13.59039],
    [45.47329, 13.59225],
    [45.47228, 13.59041],
    [45.47228, 13.59006],
    [45.47268, 13.58987],
    [45.47305, 13.58937],
    [45.47308, 13.58802],
    [45.47383, 13.58792],
    [45.47405, 13.58768],
    [45.47433, 13.58636],
    [45.47518, 13.58622],
    [45.47605, 13.58528],
    [45.47602, 13.58475],
    [45.47571, 13.58403],
    [45.47608, 13.58351],
    [45.47631, 13.58204],
    [45.47652, 13.58189],
    [45.47724, 13.58268],
    [45.47757, 13.58263],
    [45.47751, 13.58110],
    [45.47776, 13.58077],
    [45.47831, 13.58100],
    [45.47850, 13.58081],
    [45.47867, 13.58029],
    [45.47864, 13.57901],
    [45.47883, 13.57876],
    [45.47988, 13.57841],
    [45.48005, 13.57714],
    [45.48088, 13.57591],
    [45.48057, 13.57488],
    [45.48096, 13.57456],
    [45.48114, 13.57367],
    [45.48207, 13.57332],
    [45.48274, 13.57086],
    [45.48334, 13.57021],
    [45.48467, 13.56724],
    [45.48512, 13.56712],
    [45.48537, 13.56665],
    [45.48548, 13.56681],
    [45.48537, 13.56646],
    [45.48556, 13.56604],
    [45.48574, 13.56622],
    [45.48566, 13.56586],
    [45.48684, 13.56263],
    [45.48717, 13.56181],
    [45.48752, 13.56161],
    [45.48766, 13.56125],
    [45.48795, 13.55957],
    [45.48819, 13.55926],
    [45.48833, 13.55939],
    [45.48863, 13.55881],
    [45.48940, 13.55815],
    [45.49015, 13.55684],
    [45.49260, 13.55038],
    [45.49360, 13.54565],
    [45.49487, 13.54194],
    [45.49548, 13.54080],
    [45.49579, 13.53950],
    [45.49653, 13.53789],
    [45.49789, 13.53364],
    [45.49883, 13.53175],
    [45.49870, 13.53131],
    [45.49917, 13.53096],
    [45.50003, 13.52905],
    [45.50029, 13.52768],
    [45.50021, 13.52729],
    [45.50038, 13.52674],
    [45.50066, 13.52665],
    [45.50084, 13.52625],
    [45.50068, 13.52487],
    [45.50149, 13.52356],
    [45.50167, 13.52248],
    [45.45000, 13.65000],
    [45.45000, 13.95000],
    [45.62000, 13.95000],
    [45.60500, 13.79734],
    [45.60370, 13.79734],
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

const SLO_COAST_200M_CHAIN = generateDenseCoastalChain(SLO_COAST_200M_GUIDE_NODES, 50);

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

// Zagotovi, da to�ka ni na suhem (�e je uporabnik kliknil na kopno/obalo, jo projicira v vodo)
function ensureWaterPoint(lat, lon) {
    if (!isPointInPolygon(lat, lon, SLO_COASTLINE_POLYGON)) return [lat, lon];
    const mPerLat = 111139.0;
    const mPerLon = 77900.0;
    for (let d = 20; d <= 400; d += 20) {
        for (let ang = 0; ang < 360; ang += 15) {
            const r = ang * Math.PI / 180.0;
            const tLat = lat + (Math.sin(r) * d) / mPerLat;
            const tLon = lon + (Math.cos(r) * d) / mPerLon;
            if (!isPointInPolygon(tLat, tLon, SLO_COASTLINE_POLYGON)) {
                return [tLat, tLon];
            }
        }
    }
    return [lat, lon];
}

// Izra�un varne pomorske poti z uporabo 103-to�kovne 200m razmejitvene linije
function getSafeMarineSegment(lat1, lon1, lat2, lon2, useRules) {
    if (!useRules) {
        return [[lat1, lon1], [lat2, lon2]];
    }

    const pStart = ensureWaterPoint(lat1, lon1);
    const pDest = ensureWaterPoint(lat2, lon2);

    // �e med to�kama obstaja neovirana direktna linija po odprtem morju, pluje direktno
    if (hasLineOfSight(pStart[0], pStart[1], pDest[0], pDest[1])) {
        return [pStart, pDest];
    }

    const nodes = SLO_COAST_200M_GUIDE_NODES;

    // 1. Poi��i najbli�jo vidno to�ko na 200m liniji iz za�etne lokacije (najkraj�a pot do meje)
    let idxA = -1;
    let minDA = Infinity;
    for (let i = 0; i < nodes.length; i++) {
        const dA = haversineDistanceMeters(pStart[0], pStart[1], nodes[i][0], nodes[i][1]);
        if (hasLineOfSight(pStart[0], pStart[1], nodes[i][0], nodes[i][1])) {
            if (dA < minDA) {
                minDA = dA;
                idxA = i;
            }
        }
    }
    if (idxA === -1) {
        for (let i = 0; i < nodes.length; i++) {
            const dA = haversineDistanceMeters(pStart[0], pStart[1], nodes[i][0], nodes[i][1]);
            if (dA < minDA) { minDA = dA; idxA = i; }
        }
    }

    // 2. Poi��i najbli�jo vidno to�ko na 200m liniji do ciljne lokacije (izstop z meje)
    let idxB = -1;
    let minDB = Infinity;
    for (let i = 0; i < nodes.length; i++) {
        const dB = haversineDistanceMeters(pDest[0], pDest[1], nodes[i][0], nodes[i][1]);
        if (hasLineOfSight(pDest[0], pDest[1], nodes[i][0], nodes[i][1])) {
            if (dB < minDB) {
                minDB = dB;
                idxB = i;
            }
        }
    }
    if (idxB === -1) {
        for (let i = 0; i < nodes.length; i++) {
            const dB = haversineDistanceMeters(pDest[0], pDest[1], nodes[i][0], nodes[i][1]);
            if (dB < minDB) { minDB = dB; idxB = i; }
        }
    }

    // Podveriga to�k od vstopa (idxA) do izstopa (idxB)
    const subChain = [];
    const step = (idxA <= idxB) ? 1 : -1;
    for (let i = idxA; i !== idxB + step; i += step) {
        subChain.push(nodes[i]);
    }

    const route = [pStart];
    route.push(subChain[0]);
    let currPos = subChain[0];
    let currIdx = 0;

    // Vodenje po 200m liniji:
    // - V konveksnih delih (okoli rtov) je pogled �ez kopno blokiran -> sledi to�kam okoli rta
    // - V konkavnih delih (�ez zalive) je pogled odprt -> pluje direktno �ez zaliv do najbolj oddaljene vidne to�ke
    while (currIdx < subChain.length - 1) {
        // �e je cilj �e neposredno viden z odprtega morja, zapusti mejo in pluj naravnost na cilj!
        if (hasLineOfSight(currPos[0], currPos[1], pDest[0], pDest[1])) {
            break;
        }

        let furthestIdx = currIdx + 1;
        for (let k = subChain.length - 1; k > currIdx + 1; k--) {
            if (hasLineOfSight(currPos[0], currPos[1], subChain[k][0], subChain[k][1])) {
                furthestIdx = k;
                break;
            }
        }
        route.push(subChain[furthestIdx]);
        currPos = subChain[furthestIdx];
        currIdx = furthestIdx;
    }

    route.push(pDest);
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

// Format decimal coordinates to Nautical DMM format: DD� MM.mmm' N/S & DDD� MM.mmm' E/W

// Calculate shortest angular difference between two angles in degrees (-180 to +180)

// Convert degrees to 16-point cardinal compass text

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
                headingDegEl.textContent = `${Math.round(phoneMagneticHeading)}�`;
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
        alert('GPS lokacija �e ni pridobljena. Preverite, da je GPS vklopljen.');
        return;
    }
    const lat = lastGpsCoords.latitude;
    const lon = lastGpsCoords.longitude;
    const dmmLat = formatNauticalCoord(lat, true);
    const dmmLon = formatNauticalCoord(lon, false);
    const mapsUrl = `https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
    const shareText = `Moja trenutna lokacija na morju:\n${dmmLat}, ${dmmLon}\n(${lat.toFixed(5)}�, ${lon.toFixed(5)}�)\n${mapsUrl}`;

    if (navigator.share) {
        navigator.share({
            title: 'Moja lokacija na morju',
            text: `Moja lokacija: ${dmmLat}, ${dmmLon}`,
            url: mapsUrl
        }).catch(err => {
            if (err.name !== 'AbortError') {
                copyTextToClŠčipboard(shareText);
            }
        });
    } else {
        copyTextToClŠčipboard(shareText);
    }
}

function copyTextToClŠčipboard(text) {
    if (navigator.clŠčipboard && navigator.clŠčipboard.writeText) {
        navigator.clŠčipboard.writeText(text).then(() => {
            alert('Lokacija s koordinatami in povezavo je kopirana v odlo�i��e!');
        }).catch(() => {
            prompt('Kopirajte koordinate:', text);
        });
    } else {
        prompt('Kopirajte koordinate:', text);
    }
}
window.shareCurrentLocation = shareCurrentLocation;

// Verified Local Vector Bathymetry Dataset (100% in Seča, 0 Coastline Intersections)
const SLO_BATHYMETRY_ISOBATHS = [
    {
        depth: 2,
        color: '#38bdf8',
        weight: 1.2,
        dashArray: '4, 4',
        coords: [
            [45.5985, 13.7170], [45.5960, 13.7080], [45.5940, 13.7000], [45.5920, 13.6950], 
            [45.5890, 13.6960], [45.5860, 13.7040], [45.5840, 13.7120], [45.5810, 13.7220], 
            [45.5750, 13.7280], [45.5650, 13.7260], [45.5560, 13.7200], [45.5505, 13.7150], 
            [45.5480, 13.7100], [45.5495, 13.7020], [45.5485, 13.6900], [45.5465, 13.6760], 
            [45.5455, 13.6660], [45.5465, 13.6590], [45.5475, 13.6530], [45.5465, 13.6490], 
            [45.5435, 13.6460], [45.5390, 13.6430], [45.5395, 13.6320], [45.5410, 13.6190], 
            [45.5425, 13.6080], [45.5415, 13.5990], [45.5380, 13.5960], [45.5335, 13.5950], 
            [45.5290, 13.5830], [45.5295, 13.5730], [45.5315, 13.5650], [45.5305, 13.5620], 
            [45.5285, 13.5605], [45.5260, 13.5615], [45.5235, 13.5650], [45.5190, 13.5670], 
            [45.5150, 13.5675], [45.5125, 13.5710], [45.5115, 13.5790], [45.5110, 13.5860], 
            [45.5080, 13.5910], [45.5030, 13.5870], [45.4985, 13.5840], [45.4960, 13.5835], 
            [45.4880, 13.5900]
        ]
    },
    {
        depth: 5,
        color: '#00f0ff',
        weight: 1.3,
        dashArray: null,
        coords: [
            [45.6010, 13.7140], [45.5975, 13.7060], [45.5950, 13.6960], [45.5930, 13.6900], 
            [45.5880, 13.6920], [45.5840, 13.7020], [45.5810, 13.7130], [45.5750, 13.7220], 
            [45.5600, 13.7190], [45.5520, 13.7110], [45.5490, 13.6960], [45.5470, 13.6800], 
            [45.5460, 13.6640], [45.5485, 13.6520], [45.5475, 13.6460], [45.5420, 13.6420], 
            [45.5410, 13.6260], [45.5435, 13.6100], [45.5430, 13.5970], [45.5390, 13.5930], 
            [45.5340, 13.5920], [45.5295, 13.5800], [45.5300, 13.5700], [45.5330, 13.5630], 
            [45.5315, 13.5590], [45.5280, 13.5580], [45.5250, 13.5600], [45.5200, 13.5640], 
            [45.5140, 13.5650], [45.5115, 13.5690], [45.5095, 13.5780], [45.5090, 13.5860], 
            [45.5065, 13.5890], [45.5010, 13.5840], [45.4950, 13.5810], [45.4850, 13.5880]
        ]
    },
    {
        depth: 10,
        color: '#0ea5e9',
        weight: 1.4,
        dashArray: null,
        coords: [
            [45.6030, 13.7150], [45.5980, 13.6950], [45.5940, 13.6870], [45.5860, 13.6890], 
            [45.5780, 13.7080], [45.5680, 13.7160], [45.5560, 13.7110], [45.5500, 13.6950], 
            [45.5480, 13.6700], [45.5495, 13.6500], [45.5460, 13.6380], [45.5430, 13.6200], 
            [45.5450, 13.6020], [45.5410, 13.5900], [45.5340, 13.5820], [45.5330, 13.5650], 
            [45.5280, 13.5550], [45.5180, 13.5580], [45.5110, 13.5630], [45.5080, 13.5740], 
            [45.4980, 13.5800], [45.4850, 13.5850]
        ]
    },
    {
        depth: 15,
        color: '#0284c7',
        weight: 1.5,
        dashArray: null,
        coords: [
            [45.6060, 13.7050], [45.5990, 13.6780], [45.5840, 13.6760], [45.5720, 13.6950], 
            [45.5600, 13.7020], [45.5530, 13.6850], [45.5500, 13.6550], [45.5505, 13.6380], 
            [45.5465, 13.6100], [45.5470, 13.5920], [45.5410, 13.5780], [45.5350, 13.5600], 
            [45.5250, 13.5500], [45.5140, 13.5520], [45.5040, 13.5650], [45.4850, 13.5750]
        ]
    },
    {
        depth: 20,
        color: '#2563eb',
        weight: 1.6,
        dashArray: null,
        coords: [
            [45.6120, 13.6950], [45.6020, 13.6650], [45.5850, 13.6550], [45.5700, 13.6700], 
            [45.5580, 13.6550], [45.5530, 13.6200], [45.5500, 13.5850], [45.5440, 13.5600], 
            [45.5390, 13.5450], [45.5240, 13.5420], [45.5100, 13.5450], [45.4950, 13.5550]
        ]
    },
    {
        depth: 25,
        color: '#4338ca',
        weight: 1.6,
        dashArray: null,
        coords: [
            [45.6180, 13.6800], [45.6050, 13.6450], [45.5880, 13.6300], [45.5720, 13.6350], 
            [45.5580, 13.6000], [45.5530, 13.5650], [45.5460, 13.5350], [45.5260, 13.5300], 
            [45.5010, 13.5350]
        ]
    },
    {
        depth: 30,
        color: '#6366f1',
        weight: 1.8,
        dashArray: null,
        coords: [
            [45.6250, 13.6600], [45.6100, 13.6200], [45.5900, 13.6000], [45.5700, 13.5800], 
            [45.5500, 13.5400], [45.5300, 13.5100], [45.5000, 13.5100], [45.4850, 13.5200]
        ]
    },
];

const SLO_BATHYMETRY_SOUNDINGS = [
    { label: '1.6m', lat: 45.5910, lon: 13.6980, name: 'Debeli rti? greben' },
    { label: '4.5m', lat: 45.5830, lon: 13.7140, name: 'Valdoltra' },
    { label: '7.2m', lat: 45.5720, lon: 13.7250, name: 'Ankaran zaliv' },
    { label: '14.5m', lat: 45.5560, lon: 13.7220, name: 'Luka Koper plovni kanal' },
    { label: '4.2m', lat: 45.5490, lon: 13.7170, name: 'Koper Mandra?' },
    { label: '2.4m', lat: 45.5490, lon: 13.7050, name: '?usterna' },
    { label: '6.5m', lat: 45.5440, lon: 13.6760, name: 'Vili?an' },
    { label: '5.2m', lat: 45.5460, lon: 13.6520, name: 'Izola severni greben' },
    { label: '4.0m', lat: 45.5440, lon: 13.6560, name: 'Izola marina vstop' },
    { label: '3.1m', lat: 45.5380, lon: 13.6420, name: 'Simonov zaliv' },
    { label: '8.5m', lat: 45.5400, lon: 13.6260, name: 'Bele skale' },
    { label: '14.0m', lat: 45.5420, lon: 13.6050, name: 'Rt Ronek klif' },
    { label: '6.8m', lat: 45.5370, lon: 13.6000, name: 'Mese?ev zaliv' },
    { label: '2.8m', lat: 45.5340, lon: 13.5960, name: 'Strunjan soline vhod' },
    { label: '5.0m', lat: 45.5290, lon: 13.5820, name: 'Pacug' },
    { label: '6.2m', lat: 45.5295, lon: 13.5720, name: 'Fiesa' },
    { label: '2.1m', lat: 45.5290, lon: 13.5620, name: 'Punta Piran greben' },
    { label: '6.5m', lat: 45.5315, lon: 13.5600, name: 'Punta Piran bojna linija' },
    { label: '4.8m', lat: 45.5260, lon: 13.5660, name: 'Piran mandra? vhod' },
    { label: '5.5m', lat: 45.5160, lon: 13.5680, name: 'Bernardin pomol' },
    { label: '2.6m', lat: 45.5130, lon: 13.5820, name: 'Portoro? centralna pla?a' },
    { label: '3.5m', lat: 45.5040, lon: 13.5900, name: 'Marina Portoro? vhod' },
    { label: '2.2m', lat: 45.4975, lon: 13.5840, name: 'Rt Se?a greben' },
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
        poly.bindPopup(`<b>Izobata ${iso.depth} m</b><br>Globinska �rta slovenskega morja (${iso.depth} m)`);
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
                bannerText.textContent = '�asovna omejitev GPS signala';
            } else {
                bannerText.textContent = 'Napaka pri branju GPS podatkov';
            }
        }
        if (toggleBtn) {
            toggleBtn.style.display = 'inline-block';
            toggleBtn.textContent = (err.code === 1) ? 'Omogo�i GPS' : 'Poskusi znova';
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
                        <span class="wp-label">Vmesna to�ka ${idx + 1}</span>
                        <span class="wp-coord-text">${wp.label}</span>
                    </div>
                    <button type="button" class="wp-action-btn delete-btn" onclick="removeWaypointRow('${wp.id}', event)" title="Izbri�i to�ko">
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
        targetWp.label = `Za�etek: ${formatted}`;
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
        marker.bindPopup(`<b>${wp.type === 'start' ? 'Za�etek' : wp.type === 'dest' ? 'Cilj' : 'To�ka ' + idx}</b><br><small>${wp.lat.toFixed(4)}� N, ${wp.lon.toFixed(4)}� E</small>`);
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
    updateNavigationGuidanceWidget(coords.latitude, coords.longitude, speedKnots, heading);
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
    if (brgEl) brgEl.textContent = '--�';
    if (brgCardEl) brgCardEl.textContent = '--';
}

// plannedSpeedKnots already declared

function onPlannedSpeedChange() {
    const inputEl = document.getElementById('input-planned-speed');
    if (inputEl) {
        const val = parseFloat(inputEl.value);
        if (!isNaN(val) && val > 0) {
            plannedSpeedKnots = val;
            updateLiveRouteTelemetry();
    updateNavigationGuidanceWidget(coords.latitude, coords.longitude, speedKnots, heading);
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
    if (text) text.textContent = 'Zaklju�i';

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
        `PLOVBA ZAKLJU�ENA\n` +
        `-----------------------------\n` +
        `� Relacija: ${destLabel}\n` +
        `� �as plovbe: ${formatDuration(sec)}\n` +
        `� Prepluto: ${cruiseTotalDistanceNm.toFixed(2)} NM (${distKm} km)\n` +
        `� Povpre�na hitrost: ${avgSpeed.toFixed(1)} kt\n` +
        `� Najvi�ja hitrost: ${cruiseMaxSpeedKnots.toFixed(1)} kt\n\n` +
        `Ali �elite to plovbo shraniti v Dnevnik plovb?`
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
    updateNavigationGuidanceWidget(coords.latitude, coords.longitude, speedKnots, heading);

    const btn = document.getElementById('btn-cruise-toggle');
    const icon = document.getElementById('cruise-btn-icon');
    const text = document.getElementById('cruise-btn-text');
    if (btn) btn.classList.remove('active');
    if (icon) icon.className = 'fa-solid fa-play';
    if (text) text.textContent = 'Za�ni';

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
    if (!confirm('Ali res �elite izbrisati ta zapis iz dnevnika?')) return;
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
                    <strong style="color:var(--text-primary); font-size:0.85rem;"><i class="fa-solid fa-shŠčip" style="color:var(--accent-blue); margin-right:4px;"></i> ${item.destName || 'Plovba'}</strong>
                    <span style="color:var(--text-secondary); font-size:0.72rem;">${item.date} � ${formatDuration(item.durationSec)}</span>
                    <span style="color:var(--text-primary); font-size:0.75rem; font-weight:600;">${item.distanceNm.toFixed(2)} NM (${distKm} km) � O ${item.avgSpeedKnots.toFixed(1)} kt � MAX ${(item.maxSpeedKnots || 0).toFixed(1)} kt</span>
                </div>
                <button type="button" class="logbook-item-btn" onclick="event.stopPropagation(); deleteCruiseFromIndexedDB('${item.id}')" title="Izbri�i zapis">
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

    const mStart = L.marker(startPt, { icon: startIcon }).addTo(navMap).bindPopup(`<b>Za�etek plovbe</b><br>${cruise.date}`);
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
            headingDegEl.textContent = `${Math.round(heading)}�`;
            headingDegEl.classList.remove('status-text');
        }
        if (headingCardEl) {
            headingCardEl.textContent = getHeadingCardinal(heading);
        }
    } else if (lastGpsHeading !== null) {
        if (headingDegEl) {
            headingDegEl.textContent = `${Math.round(lastGpsHeading)}�`;
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
    updateNavigationGuidanceWidget(coords.latitude, coords.longitude, speedKnots, heading);
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





// Tactical Cruise Navigation Guidance Compass & Target Steering Arrow Widget
function updateNavigationGuidanceWidget(boatLat, boatLon, currentSogKnots, currentHeadingDeg) {
    const widget = document.getElementById('map-guidance-widget');
    if (!widget) return;

    if (!isCruiseActive) {
        widget.style.display = 'none';
        return;
    }
    widget.style.display = 'flex';

    const isMoving = (currentSogKnots !== null && !isNaN(currentSogKnots) && currentSogKnots >= 0.4);
    
    // Effective reference heading: GPS COG if moving, else Phone Magnetic orientation
    let effectiveHeading = 0;
    if (isMoving && currentHeadingDeg !== null && !isNaN(currentHeadingDeg)) {
        effectiveHeading = currentHeadingDeg;
    } else if (phoneMagneticHeading !== null && !isNaN(phoneMagneticHeading)) {
        effectiveHeading = phoneMagneticHeading;
    }

    // Find the next target waypoint along currentCalculatedRouteCoords
    let targetBearing = null;
    if (currentCalculatedRouteCoords && currentCalculatedRouteCoords.length > 0) {
        // Find next point ahead of boat
        let targetPt = null;
        for (let i = 0; i < currentCalculatedRouteCoords.length; i++) {
            const pt = currentCalculatedRouteCoords[i];
            const d = haversineDistanceMeters(boatLat, boatLon, pt[0], pt[1]);
            if (d > 25) { // More than 25m ahead
                targetPt = pt;
                break;
            }
        }
        if (!targetPt && currentCalculatedRouteCoords.length > 0) {
            targetPt = currentCalculatedRouteCoords[currentCalculatedRouteCoords.length - 1];
        }
        if (targetPt) {
            targetBearing = calculateBearing(boatLat, boatLon, targetPt[0], targetPt[1]);
        }
    }

    if (targetBearing === null) {
        // Fallback to destination waypoint
        const destWp = routeWaypoints.find(w => w.type === 'dest');
        if (destWp && destWp.lat !== undefined && destWp.lon !== undefined) {
            targetBearing = calculateBearing(boatLat, boatLon, destWp.lat, destWp.lon);
        }
    }

    // Relative angle delta between current course and bearing to next target
    let relDelta = 0;
    if (targetBearing !== null) {
        relDelta = getShortestAngleDelta(effectiveHeading, targetBearing);
    }
    const absDelta = Math.abs(relDelta);

    // Determine status color based on relative deviation
    // <= 5 deg -> Green, <= 30 deg -> Yellow/Amber, > 30 deg -> Red
    let statusColor = '#22c55e'; // Green
    if (absDelta > 30) {
        statusColor = '#ef4444'; // Red
    } else if (absDelta > 5) {
        statusColor = '#f59e0b'; // Yellow
    }

    // Outer Circle Ring: White during stationary (< 0.4 kt), dynamic status color when moving
    const ringEl = document.getElementById('guidance-ring');
    if (ringEl) {
        ringEl.setAttribute('stroke', isMoving ? statusColor : '#ffffff');
    }

    // Outer Rim Marker PŠčip: Shows GPS course during motion, top of phone / orientation during stationary
    const rimMarker = document.getElementById('guidance-rim-marker');
    if (rimMarker) {
        rimMarker.style.transform = 'rotate(0deg)';
        const rimPŠčip = document.getElementById('guidance-rim-pŠčip');
        if (rimPŠčip) {
            rimPŠčip.setAttribute('fill', isMoving ? statusColor : '#ffffff');
        }
    }

    // Central Guidance Arrow: Points towards target waypoint relative to current heading
    const arrowGroup = document.getElementById('guidance-target-arrow');
    const arrowPoly = document.getElementById('guidance-arrow-poly');
    if (arrowGroup && arrowPoly) {
        arrowGroup.style.transform = `rotate(${relDelta}deg)`;
        arrowPoly.setAttribute('fill', statusColor);
    }

    // Digital text badge
    const deltaTextEl = document.getElementById('guidance-delta-text');
    if (deltaTextEl) {
        deltaTextEl.style.color = statusColor;
        if (absDelta <= 2) {
            deltaTextEl.textContent = '? 0�';
        } else if (relDelta > 0) {
            deltaTextEl.textContent = `${Math.round(absDelta)}� ?`;
        } else {
            deltaTextEl.textContent = `? ${Math.round(absDelta)}�`;
        }
    }
}


// Official Nautical Chart Feature Datasets (ENC / IHO S-52 Standard)
// 1. Unobtrusive Depth Soundings (Drobne, nemoteče poševne številke globin po uradnih hidrografskih kartah)
const NAUTICAL_SOUNDINGS = [
    // Koprski zaliv & Debeli rtič
    { lat: 45.5925, lon: 13.6980, depth: '1.6', name: 'Greben Debeli rtič' },
    { lat: 45.5960, lon: 13.7080, depth: '3.8', name: 'Debeli rtič V' },
    { lat: 45.5880, lon: 13.7050, depth: '4.5', name: 'Valdoltra pličina' },
    { lat: 45.5820, lon: 13.7140, depth: '6.2', name: 'Valdoltra zaliv' },
    { lat: 45.5740, lon: 13.7250, depth: '7.5', name: 'Ankaran zaliv' },
    { lat: 45.5650, lon: 13.7200, depth: '12.0', name: 'Luka Koper zunanji bazen' },
    { lat: 45.5560, lon: 13.7220, depth: '14.5', name: 'Luka Koper plovni kanal' },
    { lat: 45.5490, lon: 13.7170, depth: '4.2', name: 'Koper Mandrač vhod' },
    { lat: 45.5485, lon: 13.7050, depth: '2.4', name: 'Žusterna' },
    { lat: 45.5550, lon: 13.6950, depth: '9.8', name: 'Koprski zaliv - Rex' },
    { lat: 45.5680, lon: 13.6800, depth: '18.5', name: 'Koprski zaliv sredina' },
    { lat: 45.5800, lon: 13.6600, depth: '20.2', name: 'Koprski zaliv zahod' },

    // Izola & Rt Ronek
    { lat: 45.5440, lon: 13.6760, depth: '6.5', name: 'Viližan' },
    { lat: 45.5460, lon: 13.6520, depth: '5.2', name: 'Izola severni greben' },
    { lat: 45.5420, lon: 13.6560, depth: '3.8', name: 'Izola marina vhod' },
    { lat: 45.5390, lon: 13.6420, depth: '3.1', name: 'Simonov zaliv' },
    { lat: 45.5410, lon: 13.6260, depth: '8.5', name: 'Bele skale' },
    { lat: 45.5430, lon: 13.6050, depth: '14.2', name: 'Rt Ronek klif' },
    { lat: 45.5490, lon: 13.6300, depth: '16.5', name: 'Pred Izolo odprto' },
    { lat: 45.5550, lon: 13.6000, depth: '21.0', name: 'Severno od Roneka' },

    // Strunjanski zaliv & Fiesa
    { lat: 45.5370, lon: 13.6000, depth: '6.8', name: 'Mesečev zaliv' },
    { lat: 45.5340, lon: 13.5960, depth: '2.8', name: 'Strunjan soline' },
    { lat: 45.5360, lon: 13.5850, depth: '11.2', name: 'Strunjanski zaliv sredina' },
    { lat: 45.5290, lon: 13.5820, depth: '5.0', name: 'Pacug' },
    { lat: 45.5300, lon: 13.5720, depth: '6.2', name: 'Fiesa zaliv' },
    { lat: 45.5380, lon: 13.5650, depth: '18.0', name: 'Severno od Fiese' },

    // Piran & Bernardin
    { lat: 45.5295, lon: 13.5615, depth: '2.1', name: 'Punta Piran greben' },
    { lat: 45.5320, lon: 13.5590, depth: '7.5', name: 'Punta Piran bojna linija' },
    { lat: 45.5270, lon: 13.5660, depth: '4.8', name: 'Piran mandrač' },
    { lat: 45.5220, lon: 13.5620, depth: '9.5', name: 'Jugozahodno od Pirana' },
    { lat: 45.5160, lon: 13.5680, depth: '5.5', name: 'Bernardin pomol' },
    { lat: 45.5140, lon: 13.5750, depth: '6.8', name: 'Portoroški zaliv sever' },

    // Piranski zaliv, Portorož & Seča
    { lat: 45.5130, lon: 13.5820, depth: '2.6', name: 'Portorož centralna plaža' },
    { lat: 45.5040, lon: 13.5900, depth: '3.5', name: 'Marina Portorož vhod' },
    { lat: 45.4975, lon: 13.5840, depth: '2.2', name: 'Rt Seča greben' },
    { lat: 45.4880, lon: 13.5900, depth: '1.8', name: 'Krajinski park Sečovlje vhod' },
    { lat: 45.4950, lon: 13.5780, depth: '7.2', name: 'Piranski zaliv jug' },
    { lat: 45.5050, lon: 13.5650, depth: '12.4', name: 'Piranski zaliv sredina' },
    { lat: 45.5120, lon: 13.5480, depth: '16.8', name: 'Piranski zaliv zahod' },
    { lat: 45.4900, lon: 13.5600, depth: '14.5', name: 'Pred Savudrijo / meja' },

    // Odprto morje / Globoke vode (18-32m)
    { lat: 45.6050, lon: 13.6600, depth: '22.5', name: 'Tržaški zaliv - sever' },
    { lat: 45.5800, lon: 13.6200, depth: '24.8', name: 'Odprto morje KP-PI' },
    { lat: 45.5600, lon: 13.5600, depth: '26.5', name: 'Odprto morje pred Ronekom' },
    { lat: 45.5450, lon: 13.5350, depth: '28.2', name: 'Odprto morje pred Piranom' },
    { lat: 45.5250, lon: 13.5200, depth: '31.5', name: 'Odprto morje globoko' },
    { lat: 45.5000, lon: 13.5100, depth: '32.0', name: 'Odprto morje JZ' }
];

// 2. Dangerous Obstructions, Shoals & Reefs (Nevarne ovire, čeri in plitvine s črtkano mejo)
const NAUTICAL_HAZARDS = [
    {
        name: 'Greben Debeli rtič',
        type: 'Plitvina & skalni greben',
        badge: '< 1.5 m',
        center: [45.5925, 13.6965],
        coords: [
            [45.5940, 13.6950], [45.5920, 13.6930],
            [45.5890, 13.6960], [45.5910, 13.7010],
            [45.5940, 13.6950]
        ],
        desc: 'Nevaren plitev skalnati greben pred Debelim rtičem. Globina manj kot 1.5 m.'
    },
    {
        name: 'Greben Punta Piran',
        type: 'Podvodni greben & čeri',
        badge: '< 2.0 m',
        center: [45.5295, 13.5605],
        coords: [
            [45.5310, 13.5610], [45.5290, 13.5585],
            [45.5275, 13.5605], [45.5285, 13.5630],
            [45.5310, 13.5610]
        ],
        desc: 'Podvodne čeri in plitvina, ki se razteza z rta Punta Piran. Prepovedana plovba v neposredni bližini rta.'
    },
    {
        name: 'Čeri pod klifom Rt Ronek',
        type: 'Podvodne skale & klif',
        badge: 'Čeri',
        center: [45.5425, 13.6070],
        coords: [
            [45.5440, 13.6120], [45.5425, 13.6020],
            [45.5395, 13.5990], [45.5410, 13.6140],
            [45.5440, 13.6120]
        ],
        desc: 'Skalne podvodne čeri in krušenje pod flišnim klifom Ronek v Krajinskem parku Strunjan.'
    },
    {
        name: 'Plitvina Rt Seča',
        type: 'Plitvina & solinski nasip',
        badge: '< 1.2 m',
        center: [45.4960, 13.5825],
        coords: [
            [45.4985, 13.5830], [45.4960, 13.5790],
            [45.4920, 13.5820], [45.4950, 13.5860],
            [45.4985, 13.5830]
        ],
        desc: 'Izrazita blatna plitvina na vhodu v kanal sv. Jerneja in Sečoveljske soline.'
    }
];

// 3. Official Shipwrecks (Potopljene ladje in razbitine)
const NAUTICAL_WRECKS = [
    {
        lat: 45.5489,
        lon: 13.6920,
        name: 'Razbitina SS Rex',
        type: 'Čezoceanska potopljena ladja (1944)',
        depth: '8 – 11 m',
        desc: 'Največja italijanska čezoceanska potniška ladja Rex, potopljena 8. septembra 1944. Podvodno arheološko najdišče in nevarnost za sidranje.'
    },
    {
        lat: 45.5312,
        lon: 13.5580,
        name: 'Razbitina tovorne ladje pred Piranom',
        type: 'Potopljena razbitina',
        depth: '12 – 14 m',
        desc: 'Potopljeni ostanki tovorne ladje severozahodno od Punte Piran. Prepovedano sidranje.'
    },
    {
        lat: 45.5185,
        lon: 13.5615,
        name: 'Potopljena razbitina v Piranskem zalivu',
        type: 'Podvodna ovira',
        depth: '10 m',
        desc: 'Potopljena lesena barkasa / ovira na morskem dnu.'
    }
];

// 4. Submarine Pipelines and Cables (Podmorski izpusti in kabli z uradnimi vijoličnimi črtkanimi linijami)
const NAUTICAL_PIPELINES_CABLES = [
    {
        name: 'Podmorski izpust CKČN Piran (3.5 km)',
        type: 'Podvodni kanalizacijski cevovod',
        color: '#c026d3', // Official nautical magenta
        dashArray: '8, 6',
        coords: [
            [45.5285, 13.5650],
            [45.5340, 13.5530],
            [45.5410, 13.5410],
            [45.5460, 13.5320]
        ],
        desc: 'Glavni podmorski izpust Centralne čistilne naprave Piran dolžine 3,5 km. Na koncu sta nameščena globokomorska difuzorja. Prepovedano sidranje in ribolov z vlečnimi mrežami.'
    },
    {
        name: 'Podmorski izpust CČN Koper',
        type: 'Podvodni izpust čistilne naprave',
        color: '#c026d3',
        dashArray: '8, 6',
        coords: [
            [45.5495, 13.7080],
            [45.5580, 13.6950],
            [45.5660, 13.6820]
        ],
        desc: 'Podmorski izpust komunalne čistilne naprave Koper v Koprski zaliv. Prepovedano sidranje.'
    },
    {
        name: 'Podvodni komunikacijski kabel Piranski zaliv',
        type: 'Podvodni elektro/komunikacijski kabel',
        color: '#9333ea',
        dashArray: '4, 6',
        coords: [
            [45.5150, 13.5680],
            [45.5060, 13.5550],
            [45.4980, 13.5420]
        ],
        desc: 'Podvodni energetski in komunikacijski kabel na morskem dnu.'
    }
];

// 5. Mariculture / Shellfish & Fish Farming Restricted Zones
const NAUTICAL_MARICULTURE = [
    {
        name: 'Školjčišče Debeli rtič (sv. Jernej)',
        type: 'Marikultura - školjčišče',
        center: [45.5870, 13.7080],
        coords: [
            [45.5890, 13.7060], [45.5850, 13.7100],
            [45.5840, 13.7060], [45.5880, 13.7020],
            [45.5890, 13.7060]
        ],
        desc: 'Zavarovano območje gojenja šškoljk. Označeno z rumenimi specialnimi navigacijskimi bojami. Prepovedana plovba in sidranje med vrvmi.'
    },
    {
        name: 'Školjčišče Strunjan',
        type: 'Marikultura - školjčišče',
        center: [45.5340, 13.5980],
        coords: [
            [45.5355, 13.5960], [45.5325, 13.6000],
            [45.5315, 13.5970], [45.5345, 13.5930],
            [45.5355, 13.5960]
        ],
        desc: 'Gojišče šškoljk v Strunjanskem zalivu. Prepovedano sidranje.'
    },
    {
        name: 'Ribogojnica & školjčišče Fonda (Seča)',
        type: 'Marikultura - ribogojnica in školjčišče',
        center: [45.4930, 13.5800],
        coords: [
            [45.4955, 13.5780], [45.4905, 13.5820],
            [45.4895, 13.5780], [45.4945, 13.5740],
            [45.4955, 13.5780]
        ],
        desc: 'Morska ribogojnica piranskega brancina in školjčišče Fonda. Zavarovano območje z rumenimi navigacijskimi bojami.'
    }
];

function buildNauticalChartLayer() {
    if (nauticalChartLayerGroup) return nauticalChartLayerGroup;
    nauticalChartLayerGroup = L.layerGroup([]);

    // 1. Unobtrusive Depth Soundings (Crisp, italicized numbers directly on water)
    NAUTICAL_SOUNDINGS.forEach(snd => {
        const icon = L.divIcon({
            className: 'nautical-sounding-divicon',
            html: `<div class="nautical-sounding-num">${snd.depth}</div>`,
            iconSize: [28, 16],
            iconAnchor: [14, 8]
        });
        const marker = L.marker([snd.lat, snd.lon], { icon: icon });
        marker.bindPopup(`<b>Globina: ${snd.depth} m</b><br><small>${snd.name}</small>`);
        nauticalChartLayerGroup.addLayer(marker);
    });

    // 2. Dangerous Obstructions, Shoals & Reefs (Dashed perimeters with hazard badges)
    NAUTICAL_HAZARDS.forEach(haz => {
        const poly = L.polygon(haz.coords, {
            color: '#ef4444',
            weight: 2,
            dashArray: '5, 5',
            fillColor: '#ef4444',
            fillOpacity: 0.12
        });
        poly.bindPopup(`<b><i class="fa-solid fa-triangle-exclamation" style="color:#ef4444;"></i> ${haz.name}</b><br>Tip: <b>${haz.type}</b><br>${haz.desc}`);
        nauticalChartLayerGroup.addLayer(poly);

        // Center danger badge
        const hazIcon = L.divIcon({
            className: 'nautical-hazard-divicon',
            html: `<div class="nautical-hazard-badge">${haz.badge}</div>`,
            iconSize: [52, 18],
            iconAnchor: [26, 9]
        });
        const hazMarker = L.marker(haz.center, { icon: hazIcon });
        hazMarker.bindPopup(`<b>${haz.name}</b><br>${haz.desc}`);
        nauticalChartLayerGroup.addLayer(hazMarker);
    });

    // 3. Official Shipwrecks (Razbitine)
    NAUTICAL_WRECKS.forEach(wrk => {
        const wreckIconHtml = `
            <div class="nautical-wreck-marker" title="${wrk.name}">
                <svg viewBox="0 0 32 32" width="26" height="26">
                    <circle cx="16" cy="16" r="14" fill="rgba(15, 23, 42, 0.75)" stroke="#ef4444" stroke-width="2" stroke-dasharray="3, 3"/>
                    <line x1="8" y1="16" x2="24" y2="16" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
                    <line x1="11" y1="12" x2="11" y2="20" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
                    <line x1="16" y1="10" x2="16" y2="22" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
                    <line x1="21" y1="12" x2="21" y2="20" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
                    <line x1="13" y1="9" x2="19" y2="9" stroke="#ef4444" stroke-width="1.8"/>
                </svg>
            </div>
        `;
        const wrkIcon = L.divIcon({
            className: 'nautical-wreck-divicon',
            html: wreckIconHtml,
            iconSize: [26, 26],
            iconAnchor: [13, 13]
        });
        const m = L.marker([wrk.lat, wrk.lon], { icon: wrkIcon });
        m.bindPopup(`
            <div style="font-size:0.85rem;">
                <b style="color:#ef4444;"><i class="fa-solid fa-anchor"></i> ${wrk.name}</b><br>
                <span>Tip: <b>${wrk.type}</b></span><br>
                <span>Globina: <b>${wrk.depth}</b></span><br>
                <p style="margin:4px 0 0 0; font-size:0.75rem; color:#475569;">${wrk.desc}</p>
            </div>
        `);
        nauticalChartLayerGroup.addLayer(m);
    });

    // 4. Submarine Pipelines & Cables (Magenta dashed lines)
    NAUTICAL_PIPELINES_CABLES.forEach(pipe => {
        const line = L.polyline(pipe.coords, {
            color: pipe.color,
            weight: 2.5,
            dashArray: pipe.dashArray,
            opacity: 0.95
        });
        line.bindPopup(`
            <div style="font-size:0.85rem;">
                <b style="color:${pipe.color};"><i class="fa-solid fa-bolt"></i> ${pipe.name}</b><br>
                <span>Tip: <b>${pipe.type}</b></span><br>
                <p style="margin:4px 0 0 0; font-size:0.75rem; color:#475569;">${pipe.desc}</p>
            </div>
        `);
        nauticalChartLayerGroup.addLayer(line);

        // Diffuser / End Point Marker
        const endPt = pipe.coords[pipe.coords.length - 1];
        const endIcon = L.divIcon({
            className: 'nautical-pipe-end-divicon',
            html: `<div style="width:10px; height:10px; border-radius:50%; background:${pipe.color}; border:2px solid #ffffff; box-shadow:0 0 6px ${pipe.color};"></div>`,
            iconSize: [10, 10],
            iconAnchor: [5, 5]
        });
        const endMarker = L.marker(endPt, { icon: endIcon });
        endMarker.bindPopup(`<b>Konec izpusta / difuzor</b><br>${pipe.name}`);
        nauticalChartLayerGroup.addLayer(endMarker);
    });

    // 5. Mariculture / Shellfish & Fish Farming Zones
    NAUTICAL_MARICULTURE.forEach(mari => {
        const poly = L.polygon(mari.coords, {
            color: '#f59e0b',
            weight: 2,
            dashArray: '6, 6',
            fillColor: '#f59e0b',
            fillOpacity: 0.15
        });
        poly.bindPopup(`<b><i class="fa-solid fa-fish" style="color:#f59e0b;"></i> ${mari.name}</b><br>${mari.desc}`);
        nauticalChartLayerGroup.addLayer(poly);

        // Yellow Special Buoy Marker
        const buoyIcon = L.divIcon({
            className: 'nautical-buoy-divicon',
            html: `<div style="display:flex; align-items:center; gap:3px; background:rgba(245,158,11,0.9); color:#000000; font-weight:800; font-size:9px; padding:1px 5px; border-radius:4px; border:1px solid #ffffff; box-shadow:0 2px 5px rgba(0,0,0,0.4);"><i class="fa-solid fa-xmark"></i> MARIKULTURA</div>`,
            iconSize: [85, 18],
            iconAnchor: [42, 9]
        });
        const buoyMarker = L.marker(mari.center, { icon: buoyIcon });
        buoyMarker.bindPopup(`<b>${mari.name}</b><br>${mari.desc}`);
        nauticalChartLayerGroup.addLayer(buoyMarker);
    });

    return nauticalChartLayerGroup;
}

// Toggle Nautical Chart Layer (Soundings, Wrecks, Pipelines, Hazards)
function toggleNauticalChartLayer() {
    if (!navMap) initNavMap();
    showDepthContours = !showDepthContours;
    const btn = document.getElementById('pill-layer-depth');
    if (btn) btn.classList.toggle('active', showDepthContours);

    const chartLayer = buildNauticalChartLayer();
    if (showDepthContours) {
        chartLayer.addTo(navMap);
    } else if (navMap.hasLayer(chartLayer)) {
        navMap.removeLayer(chartLayer);
    }
}
window.toggleNauticalChartLayer = toggleNauticalChartLayer;
window.toggleDepthContours = toggleNauticalChartLayer; // alias


// =========================================================================
// SECTION 4: APP INITIALIZATION LIFECYCLE
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
    // 1. Theme initialization
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }
    updateThemeIcon();

    // 2. Tab switcher buttons
    const btnTides = document.getElementById('btn-tab-tides');
    const btnWeather = document.getElementById('btn-tab-weather');
    const btnNav = document.getElementById('btn-tab-nav');

    if (btnTides) btnTides.addEventListener('click', () => setActiveMainTab('plimovanje'));
    if (btnWeather) btnWeather.addEventListener('click', () => setActiveMainTab('vreme'));
    if (btnNav) btnNav.addEventListener('click', () => setActiveMainTab('navigacija'));

    // 3. Compass tap-to-center
    const compassContainer = document.getElementById('compass-container');
    if (compassContainer) {
        compassContainer.addEventListener('click', () => {
            if (lastGpsCoords && navMap) {
                navMap.setView([lastGpsCoords.latitude, lastGpsCoords.longitude], Math.max(navMap.getZoom(), 15));
            }
        });
    }

    // 4. Start clock and load live data
    setInterval(updateClock, 1000);
    refreshData();

    // 5. Default tab
    setActiveMainTab('plimovanje');
});

