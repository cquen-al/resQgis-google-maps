'use strict';

(async function bootResQGIS() {
    await GIS.load();
    window.L = GIS;


// ============================================================
// HELPERS
// ============================================================

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const escapeHTML = value =>
    String(value ?? '').replace(
        /[&<>"']/g,
        c => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[c])
    );

const names = {
    hospital: 'Hospital',
    fire_station: 'Fire station',
    police: 'Police station',
};

const icons = {
    hospital: 'hospital',
    fire_station: 'flame',
    police: 'shield',

    flood: 'waves',
    fire: 'flame',
    accident: 'car',
    medical: 'heart-pulse',
    other: 'triangle-alert'
};

const colors = {
    hospital: '#168980',
    fire_station: '#d17833',
    police: '#5278bf',
};

const facilityTypeLabels = {
    all: 'All Facilities',
    hospital: 'Hospitals',
    fire_station: 'Fire Stations',
    police: 'Police Stations'
};


// ============================================================
// APPLICATION STATE
// ============================================================

const state = {
    csrf: '',
    admin: false,
    type: '',
    facilities: [],
    reports: [],
    adminFacilities: [],
    point: null,
    picking: null,
    accessibilityResults: null,
    accessibilityType: '',
    accessibilityThresholdKm: null,
    meta: null,
    request: 0,
    analysisRequest: 0
};


// ============================================================
// ICON HELPERS
// ============================================================

const icon = name =>
    `<i data-lucide="${name}"></i>`;

function refreshIcons() {
    if (window.lucide) {
        lucide.createIcons();
    }
}


// ============================================================
// NOTIFICATIONS
// ============================================================

function toast(message) {

    const element = $('#toast');

    if (!element) {
        console.warn(message);
        return;
    }

    element.textContent = message;
    element.hidden = false;

    clearTimeout(toast.timer);

    toast.timer = setTimeout(() => {
        element.hidden = true;
    }, 6500);
}


function feedback(id, message, ok = false) {

    const el = $(id);

    if (!el) return;

    el.className = ok
        ? 'feedback-success'
        : 'feedback-error';

    el.textContent = message;
}


// ============================================================
// API HELPER
// ============================================================

async function api(url, options = {}) {

    const headers = {
        ...options.headers
    };

    if (
        options.method &&
        options.method !== 'GET'
    ) {
        headers['X-CSRF-Token'] =
            state.csrf;
    }

    if (
        options.body &&
        !(options.body instanceof FormData)
    ) {

        headers['Content-Type'] =
            'application/json';

        options.body =
            JSON.stringify(options.body);
    }

    const response = await fetch(
        url,
        {
            ...options,
            headers
        }
    );

    let result;

    try {
        result = await response.json();
    } catch {
        throw new Error(
            'The server returned an unreadable response. Try again.'
        );
    }

    if (!response.ok) {
        throw new Error(
            result.error ||
            'This request could not be completed.'
        );
    }

    return result;
}


async function busy(button, work) {

    if (!button) return;

    button.disabled = true;

    try {
        await work();
    } catch (error) {
        toast(error.message);
    } finally {
        button.disabled = false;
    }
}


// ============================================================
// GOOGLE MAP
// ============================================================

const map = L.map(
    'map',
    {
        zoomControl: false,
        minZoom: 9,
        maxZoom: 19
    }
).setView(
    [8.947, 125.535],
    13
);


// ============================================================
// MAP LAYERS
// ============================================================

// These are the main application-managed map layers:
// - facilityLayer: interactive hospital, fire station, and police markers
// - incidentLayer: verified incident markers
// - cityLayer/barangayLayer: boundary polygons
// - analysisLayer: routes, buffers, and accessibility polygons
// - selectionLayer: temporary user/device selections
// Keeping them separate lets controls toggle or clear one concern at a time.
const facilityLayer =
    L.layerGroup().addTo(map);

const incidentLayer =
    L.layerGroup().addTo(map);

const cityLayer =
    L.geoJSON(
        null,
        {
            style: {
                color: '#5f9290',
                weight: 2,
                fill: false,
                dashArray: '5 6'
            }
        }
    ).addTo(map);

const barangayLayer =
    L.geoJSON(
        null,
        {
            style: {
                color: '#7192ac',
                weight: 1.5,
                fillColor: '#a3c7dc',
                fillOpacity: .13
            },

            onEachFeature: (feature, layer) => {

                // Hovering an available barangay boundary identifies the
                // polygon without requiring a click or an analysis run.
                layer.bindTooltip(
                    '<strong>Barangay:</strong> ' +
                    escapeHTML(
                        feature.properties.name ||
                        'Unnamed barangay'
                    )
                );

                layer.bindPopup(
                    escapeHTML(
                        feature.properties.name
                    )
                );

                layer.on(
                    'click',
                    event => {

                        const result =
                            state.accessibilityResults?.find(
                                row =>
                                    String(row.id) ===
                                    String(feature.properties.id)
                            );

                        if (
                            !result ||
                            !layer.info
                        ) {
                            return;
                        }

                        const threshold =
                            state.accessibilityThresholdKm;

                        const within =
                            result.nearest_m !== null &&
                            Number(result.nearest_m) <=
                            threshold * 1000;

                        const resultLabel =
                            result.nearest_m === null
                                ? 'No data'
                                : within
                                    ? 'Within threshold'
                                    : 'Beyond threshold';

                        layer.info.setContent(
                            accessibilityPopupHtml(
                                result,
                                state.accessibilityType,
                                threshold,
                                resultLabel
                            )
                        );

                        if (event.latlng) {
                            layer.info.setPosition(
                                event.latlng
                            );
                        }

                        layer.info.open({
                            map: layer.map
                        });
                    }
                );
            }
        }
    );

const analysisLayer =
    L.layerGroup().addTo(map);

const selectionLayer =
    L.layerGroup().addTo(map);

let wmsLayer = null;
let analysisAddedBarangayLayer = false;
let barangayLayerWasVisibleBeforeAnalysis = false;
let barangayCheckboxWasCheckedBeforeAnalysis = false;

function accessibilityPopupHtml(
    row,
    type,
    thresholdKm,
    resultLabel
) {

    return `
        <strong>Barangay:</strong>
        ${escapeHTML(row.name)}<br>
        <strong>Facility type:</strong>
        ${escapeHTML(facilityTypeLabels[type] || type)}<br>
        <strong>Nearest facility:</strong>
        ${escapeHTML(row.nearest_facility || 'No data')}<br>
        <strong>Distance:</strong>
        ${
            row.nearest_m === null
                ? 'No data'
                : (Number(row.nearest_m) / 1000).toFixed(2) + ' km'
        }<br>
        <strong>Maximum distance:</strong>
        ${thresholdKm} km<br>
        <strong>Result:</strong>
        ${resultLabel}
    `;
}

// ============================================================
// MARKERS
// ============================================================

function markerIcon(type, incident = false) {

    // Marker appearance is selected by facility type; incidents use the
    // additional "incident" class for their distinct visual style.
    return L.divIcon({
        className:
            'map-marker ' +
            (incident ? 'incident' : type),

        html:
            icon(
                icons[type] ||
                'map-pin'
            ),

        iconSize: [33, 33],
        iconAnchor: [16, 35]
    });
}


function statusBadge(status) {

    return `
        <span class="status ${escapeHTML(status)}">
            ${escapeHTML(
                status.charAt(0).toUpperCase() +
                status.slice(1)
            )}
        </span>
    `;
}


function empty(
    title,
    body,
    symbol = 'search'
) {

    return `
        <div class="empty-state">

            ${icon(symbol)}

            <strong>
                ${escapeHTML(title)}
            </strong>

            <small>
                ${escapeHTML(body)}
            </small>

        </div>
    `;
}


// ============================================================
// VIEW NAVIGATION
// ============================================================

function displayView(view) {

    const previous =
        $('.panel.active')?.id;

    $$('.panel').forEach(el => {

        el.classList.toggle(
            'active',
            el.id === view + '-panel'
        );
    });

    $$('[data-view]').forEach(el => {

        el.classList.toggle(
            'active',
            el.dataset.view === view
        );
    });

    const sidebar = $('.sidebar');

    if (sidebar) {
        sidebar.classList.remove(
            'collapsed'
        );

        sidebar.inert = false;
    }

    if (
        previous !== view + '-panel'
    ) {

        const active =
            $('.panel.active');

        if (active) {
            active.scrollTop = 0;
        }
    }

    const mobileToggle =
        $('#mobile-panel-toggle');

    if (mobileToggle) {

        mobileToggle.innerHTML =
            icon('map') +
            'Show full map';
    }

    refreshIcons();

    if (
        state.picking &&
        state.picking !== view
    ) {
        cancelPick();
    }
}


$$('[data-view]').forEach(
    element => {

        element.addEventListener(
            'click',
            () => {
                displayView(
                    element.dataset.view
                );
            }
        );
    }
);


// ============================================================
// MOBILE PANEL
// ============================================================

const mobilePanelToggle =
    $('#mobile-panel-toggle');

const sidebarToggle =
    $('#sidebar-toggle');

if (sidebarToggle) {
    sidebarToggle.hidden = true;
}

function toggleSidebar() {

    // The floating map-edge control is the reopen path after the sidebar is
    // collapsed; the in-sidebar button remains the close path.
    const sidebar =
        $('.sidebar');

    if (!sidebar) return;

    const collapsed =
        sidebar.classList.toggle(
            'collapsed'
        );

    sidebar.inert =
        collapsed;

    if (sidebarToggle) {
        sidebarToggle.hidden =
            !collapsed;
    }

    refreshIcons();
}

if (sidebarToggle) {
    sidebarToggle.onclick =
        toggleSidebar;
}

if (mobilePanelToggle) {

    mobilePanelToggle.onclick = () => {

        const sidebar =
            $('.sidebar');

        if (!sidebar) return;

        toggleSidebar();

        const isCollapsed =
            sidebar.classList.contains(
                'collapsed'
            );

        mobilePanelToggle.innerHTML =
            icon(
                isCollapsed
                    ? 'list-filter'
                    : 'map'
            )
            +
            (
                isCollapsed
                    ? 'Show map tools'
                    : 'Show full map'
            );

        refreshIcons();
    };
}


const collapsePanel =
    $('#collapse-panel');

if (collapsePanel) {

    collapsePanel.onclick =
        () => toggleSidebar();
}


function collapseMobile() {

    if (innerWidth <= 760) {

        const sidebar =
            $('.sidebar');

        if (!sidebar) return;

        sidebar.classList.add(
            'collapsed'
        );

        sidebar.inert = true;

        const toggle =
            $('#mobile-panel-toggle');

        if (toggle) {

            toggle.innerHTML =
                icon('list-filter') +
                'Show map tools';
        }

        refreshIcons();
    }
}


window.addEventListener(
    'resize',
    () => {

        const sidebar =
            $('.sidebar');

        if (
            innerWidth > 760 &&
            sidebar
        ) {

            sidebar.inert = false;

            sidebar.classList.remove(
                'collapsed'
            );
        }

        map.invalidateSize();
    }
);


// ============================================================
// MAP CONTROLS
// ============================================================

const zoomIn =
    $('#zoom-in');

if (zoomIn) {
    zoomIn.onclick =
        () => map.zoomIn();
}


const zoomOut =
    $('#zoom-out');

if (zoomOut) {
    zoomOut.onclick =
        () => map.zoomOut();
}


const fitCity =
    $('#fit-city');

if (fitCity) {

    fitCity.onclick = () => {

        if (
            cityLayer
                .getLayers()
                .length
        ) {

            map.fitBounds(
                cityLayer.getBounds(),
                {
                    padding: [35, 35]
                }
            );
        }
    };
}


// ============================================================
// DEVICE LOCATION
// ============================================================

const locateMe =
    $('#locate-me');

if (locateMe) {

    locateMe.onclick = () => {

        if (
            !navigator.geolocation
        ) {

            return toast(
                'Location access is unavailable in this browser.'
            );
        }

        navigator.geolocation
            .getCurrentPosition(

                position => {

                    const lat =
                        position.coords.latitude;

                    const lon =
                        position.coords.longitude;

                    map.setView(
                        [lat, lon],
                        15
                    );

                    selectionLayer
                        .clearLayers();

                    L.circleMarker(
                        [lat, lon],
                        {
                            radius: 7,
                            color: '#fff',
                            fillColor: '#2468ca',
                            fillOpacity: 1,
                            weight: 3
                        }
                    ).addTo(
                        selectionLayer
                    );

                    toast(
                        'Your device location is shown. ' +
                        'It is not submitted as a report.'
                    );
                },

                () => {

                    toast(
                        'Location access was denied or unavailable. ' +
                        'Select a location on the map instead.'
                    );
                },

                {
                    timeout: 10000
                }
            );
    };
}


// ============================================================
// LAYERS PANEL
// ============================================================

const layersButton =
    $('#layers-button');

const layersPanel =
    $('#layers-panel');

const mapType =
    $('#map-type');

if (mapType) {

    mapType.onchange =
        event => {

            map.native.setOptions({
                mapTypeId:
                    event.target.value
            });
        };
}

if (
    layersButton &&
    layersPanel
) {

    layersButton.onclick = () => {

        layersPanel.hidden =
            !layersPanel.hidden;

        layersButton.setAttribute(
            'aria-expanded',
            !layersPanel.hidden
        );
    };
}


[
    ['facilities', facilityLayer],
    ['incidents', incidentLayer],
    ['city', cityLayer],
    ['barangays', barangayLayer]
].forEach(
    ([name, layer]) => {

        const checkbox =
            $('#layer-' + name);

        if (!checkbox) return;

        checkbox.onchange =
            event => {

                if (
                    event.target.checked
                ) {

                    map.addLayer(
                        layer
                    );

                } else {

                    map.removeLayer(
                        layer
                    );
                }
            };
    }
);


const geoserverCheckbox =
    $('#layer-geoserver');

if (geoserverCheckbox) {

    geoserverCheckbox.onchange =
        event => {

            if (!wmsLayer) return;

            if (
                event.target.checked
            ) {

                map.addLayer(
                    wmsLayer
                );

            } else {

                map.removeLayer(
                    wmsLayer
                );
            }
        };
}


// ============================================================
// FACILITY CARD
// ============================================================

function facilityCard(feature) {

    const p =
        feature.properties;

    return `
        <button
            class="facility-card ${p.facility_type}"
            data-facility="${p.id}"
        >

            <span class="facility-icon">
                ${icon(
                    icons[
                        p.facility_type
                    ]
                )}
            </span>

            <span class="card-body">

                <span class="card-name">
                    ${escapeHTML(p.name)}
                </span>

                <span
                    class="card-location"
                    style="display:block"
                >
                    ${escapeHTML(
                        p.barangay ||
                        p.address ||
                        'Butuan City'
                    )}
                </span>

                <span class="card-meta">

                    <span class="card-type">
                        ${names[
                            p.facility_type
                        ] || p.facility_type}
                    </span>

                

                </span>

            </span>

            ${icon('chevron-right')}

        </button>
    `;
}


// ============================================================
// LOAD FACILITIES
// ============================================================

function renderFacilityMarkers(type = '') {

    // This is the main facility-marker renderer. It reuses the API response
    // in state.facilities and rebuilds only the facility layer when filters or
    // an analysis mode changes the visible facility type.
    facilityLayer.clearLayers();

    state.facilities
        .filter(
            feature =>
                !type ||
                feature.properties.facility_type === type
        )
        .forEach(
            feature => {

                const [lon, lat] =
                    feature.geometry.coordinates;

                L.marker(
                    [lat, lon],
                    {
                        icon:
                            markerIcon(
                                feature.properties.facility_type
                            ),
                        title:
                            feature.properties.name
                    }
                )
                    .bindTooltip(
                        escapeHTML(
                            feature.properties.name
                        )
                    )
                    .on(
                        'click',
                        () => showFacility(feature)
                    )
                    .addTo(facilityLayer);
            }
        );
}

// Fetches the current facility features, updates the left-side result list,
// and then calls renderFacilityMarkers() to draw their map markers.
async function loadFacilities() {

    const id =
        ++state.request;

    const search =
        $('#search');

    const barangay =
        $('#barangay-filter');

    const params =
        new URLSearchParams({
            q:
                search
                    ? search.value
                    : '',

            facility_type:
                state.type,

            barangay_id:
                barangay
                    ? barangay.value
                    : '',

        });

    try {

        const result =
            await api(
                '/api/facilities?' +
                params
            );

        if (
            id !== state.request
        ) return;

        state.facilities =
            result.features;

        const countElement =
            $('#result-count');

        if (countElement) {

            countElement.textContent =
                `${result.features.length} ` +
                (
                    result.features.length === 1
                        ? 'facility'
                        : 'facilities'
                ) +
                ' found';
        }

        const facilityList =
            $('#facility-list');

        if (facilityList) {

            facilityList.innerHTML =
                result.features.length

                    ? result.features
                        .map(
                            facilityCard
                        )
                        .join('')

                    : empty(
                        'No matching facilities',
                        'Try a different filter. Missing data does not mean no facilities exist.',
                        'hospital'
                    );

            facilityList.scrollTop = 0;
        }

        renderFacilityMarkers();

        $$('[data-facility]')
            .forEach(
                element => {

                    element.onclick =
                        () => {

                            showFacility(
                                state.facilities
                                    .find(
                                        feature =>
                                            feature
                                                .properties
                                                .id
                                            ===
                                            Number(
                                                element
                                                    .dataset
                                                    .facility
                                            )
                                    )
                            );
                        };
                }
            );

        refreshIcons();

    } catch (error) {

        if (
            id !== state.request
        ) return;

        const countElement =
            $('#result-count');

        if (countElement) {
            countElement.textContent =
                'Facilities unavailable';
        }

        const list =
            $('#facility-list');

        if (list) {

            list.innerHTML =
                empty(
                    'Could not load facilities',
                    error.message,
                    'wifi-off'
                );
        }

        refreshIcons();
    }
}


// ============================================================
// FACILITY CARD
// ============================================================

function facilityCard(feature) {

    const p =
        feature.properties;

    return `
        <button
            class="facility-card ${p.facility_type}"
            data-facility="${p.id}"
        >

            <span class="facility-icon">
                ${icon(
                    icons[
                        p.facility_type
                    ]
                )}
            </span>

            <span class="card-body">

                <span class="card-name">
                    ${escapeHTML(p.name)}
                </span>

                <span
                    class="card-location"
                    style="display:block"
                >
                    ${escapeHTML(
                        p.barangay ||
                        p.address ||
                        'Butuan City'
                    )}
                </span>

                <span class="card-meta">

                    <span class="card-type">
                        ${names[
                            p.facility_type
                        ] || p.facility_type}
                    </span>

                </span>

            </span>

            ${icon('chevron-right')}

        </button>
    `;
}


// ============================================================
// LOAD FACILITIES
// ============================================================

async function loadFacilities() {

    const id =
        ++state.request;

    const search =
        $('#search');

    const barangay =
        $('#barangay-filter');

    const params =
        new URLSearchParams({
            q:
                search
                    ? search.value
                    : '',

            facility_type:
                state.type,

            barangay_id:
                barangay
                    ? barangay.value
                    : '',

        });

    try {

        const result =
            await api(
                '/api/facilities?' +
                params
            );

        if (
            id !== state.request
        ) return;

        state.facilities =
            result.features;

        const countElement =
            $('#result-count');

        if (countElement) {

            countElement.textContent =
                `${result.features.length} ` +
                (
                    result.features.length === 1
                        ? 'facility'
                        : 'facilities'
                ) +
                ' found';
        }

        const facilityList =
            $('#facility-list');

        if (facilityList) {

            facilityList.innerHTML =
                result.features.length

                    ? result.features
                        .map(
                            facilityCard
                        )
                        .join('')

                    : empty(
                        'No matching facilities',
                        'Try a different filter. Missing data does not mean no facilities exist.',
                        'hospital'
                    );
        }

        renderFacilityMarkers();

        $$('[data-facility]')
            .forEach(
                element => {

                    element.onclick =
                        () => {

                            showFacility(
                                state.facilities
                                    .find(
                                        feature =>
                                            feature
                                                .properties
                                                .id
                                            ===
                                            Number(
                                                element
                                                    .dataset
                                                    .facility
                                            )
                                    )
                            );
                        };
                }
            );

        refreshIcons();

    } catch (error) {

        if (
            id !== state.request
        ) return;

        const countElement =
            $('#result-count');

        if (countElement) {
            countElement.textContent =
                'Facilities unavailable';
        }

        const list =
            $('#facility-list');

        if (list) {

            list.innerHTML =
                empty(
                    'Could not load facilities',
                    error.message,
                    'wifi-off'
                );
        }

        refreshIcons();
    }
}


// ============================================================
// FACILITY DETAILS
// ============================================================

function showFacility(feature) {

    if (!feature) return;

    const p =
        feature.properties;

    const [lon, lat] =
        feature.geometry.coordinates;

    map.flyTo(
        [lat, lon],
        16,
        {
            duration: .6
        }
    );

    collapseMobile();

    const card =
        $('#detail-card');

    if (!card) return;

    card.innerHTML = `

        <button
            class="icon-button"
            id="close-detail"
            aria-label="Close facility details"
        >
            ${icon('x')}
        </button>

        <span class="facility-icon ${p.facility_type}">
            ${icon(
                icons[
                    p.facility_type
                ]
            )}
        </span>

        <h3>
            ${escapeHTML(p.name)}
        </h3>

        <p>
            ${escapeHTML(
                p.address ||
                'Street address not recorded'
            )}
            <br>

            ${escapeHTML(
                p.barangay ||
                'Barangay boundary not available at this location'
            )}
        </p>

        <p>
            ${escapeHTML(
                p.contact_number ||
                'Contact number not recorded'
            )}
        </p>

        <p>
            ${escapeHTML(
                p.location_method ||
                'Mapped location'
            )}
        </p>

        ${
            p.source_url
                ? `
                    <a
                        href="${escapeHTML(p.source_url)}"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        View Google Maps source ↗
                    </a>
                `
                : ''
        }

        <button
            class="button primary full"
            id="analyze-here"
        >
            ${icon('scan-line')}
            Analyze from this location
        </button>
    `;

    card.hidden = false;

    const close =
        $('#close-detail');

    if (close) {

        close.onclick =
            () => {
                card.hidden = true;
            };
    }

    const analyze =
        $('#analyze-here');

    if (analyze) {

        analyze.onclick =
            async () => {

                card.hidden = true;

                displayView(
                    'analysis'
                );

                await selectPoint(
                    {
                        lat,
                        lng: lon
                    },
                    'analysis'
                );
            };
    }

    refreshIcons();
}

// ============================================================
// FACILITY FILTERS
// ============================================================

let searchTimer;

const searchInput =
    $('#search');

if (searchInput) {

    searchInput.oninput = () => {

        clearTimeout(
            searchTimer
        );

        searchTimer =
            setTimeout(
                loadFacilities,
                220
            );
    };
}


$$('.type-filter')
    .forEach(
        button => {

            button.onclick =
                () => {

                    state.type =
                        button.dataset.type;

                    $$('.type-filter')
                        .forEach(
                            b => {

                                b.classList
                                    .toggle(
                                        'selected',
                                        b === button
                                    );
                            }
                        );

                    loadFacilities();
                };
        }
    );


const barangayFilter =
    $('#barangay-filter');

if (barangayFilter) {
    barangayFilter.onchange =
        loadFacilities;
}


const resetFilters =
    $('#reset-filters');

if (resetFilters) {

    resetFilters.onclick = () => {

        if (searchInput) {
            searchInput.value = '';
        }

        if (barangayFilter) {
            barangayFilter.value = '';
        }

        if (statusFilter) {
            statusFilter.value = '';
        }

        state.type = '';

        $$('.type-filter')
            .forEach(
                button => {

                    button.classList.toggle(
                        'selected',
                        !button.dataset.type
                    );
                }
            );

        loadFacilities();
    };
}


// ============================================================
// LOAD INCIDENTS
// ============================================================
// Incident markers are created in loadIncidents() and kept separate from
// facility markers so the Layers panel can toggle them independently.

async function loadIncidents() {

    try {

        const result =
            await api(
                '/api/incidents'
            );

        state.reports =
            result.features;

        incidentLayer
            .clearLayers();

        const incidentCount =
            $('#incident-count');

        if (incidentCount) {
            incidentCount.textContent =
                result.features.length;
        }

        const incidentList =
            $('#incident-list');

        if (incidentList) {

            incidentList.innerHTML =
                result.features.length

                    ? result.features
                        .map(
                            feature => {

                                const p =
                                    feature.properties;

                                return `
                                    <button
                                        class="facility-card"
                                        data-incident="${p.id}"
                                    >

                                        <span class="facility-icon">
                                            ${icon(
                                                icons[
                                                    p.incident_type
                                                ]
                                            )}
                                        </span>

                                        <span class="card-body">

                                            <span class="card-name">
                                                ${
                                                    escapeHTML(
                                                        p.incident_type
                                                            .charAt(0)
                                                            .toUpperCase()
                                                        +
                                                        p.incident_type
                                                            .slice(1)
                                                    )
                                                }
                                                · #${p.id}
                                            </span>

                                            <span
                                                class="card-location"
                                                style="display:block"
                                            >
                                                ${escapeHTML(
                                                    p.barangay ||
                                                    'Barangay not determined'
                                                )}
                                            </span>

                                            <span class="card-meta">
                                                ${statusBadge(
                                                    p.status
                                                )}
                                            </span>

                                        </span>

                                    </button>
                                `;
                            }
                        )
                        .join('')

                    : empty(
                        'No verified active reports',
                        'New reports appear after administrator review. This is not confirmation that no incidents exist.',
                        'radio'
                    );
        }

        result.features.forEach(
            feature => {

                const p =
                    feature.properties;

                const [lon, lat] =
                    feature.geometry.coordinates;

                L.marker(
                    [lat, lon],
                    {
                        icon:
                            markerIcon(
                                p.incident_type,
                                true
                            ),

                        title:
                            p.incident_type +
                            ' incident'
                    }
                )
                    .bindPopup(
                        `
                            <strong>
                                ${escapeHTML(
                                    p.incident_type
                                )}
                                · #${p.id}
                            </strong>

                            <p>
                                ${escapeHTML(
                                    p.description
                                )}
                            </p>

                            ${statusBadge(
                                p.status
                            )}
                        `
                    )
                    .addTo(
                        incidentLayer
                    );
            }
        );

        $$('[data-incident]')
            .forEach(
                button => {

                    button.onclick =
                        () => {

                            const feature =
                                state.reports
                                    .find(
                                        x =>
                                            x.properties.id
                                            ===
                                            +button.dataset.incident
                                    );

                            if (!feature) return;

                            map.setView(
                                [
                                    ...feature
                                        .geometry
                                        .coordinates
                                ].reverse(),
                                16
                            );

                            collapseMobile();
                        };
                }
            );

        refreshIcons();

    } catch (error) {

        const list =
            $('#incident-list');

        if (list) {

            list.innerHTML =
                empty(
                    'Reports unavailable',
                    error.message,
                    'wifi-off'
                );
        }

        refreshIcons();
    }
}


// ============================================================
// MAP POINT SELECTION
// ============================================================

function startPick(type) {

    state.picking =
        type;

    const banner =
        $('#selection-banner');

    if (banner) {
        banner.hidden = false;
    }

    const workspace =
        $('.workspace');

    if (workspace) {
        workspace.classList.add(
            'picking'
        );
    }

    const detail =
        $('#detail-card');

    if (detail) {
        detail.hidden = true;
    }

    collapseMobile();

    const facilityDialog =
        $('#facility-dialog');

    if (
        type === 'facility' &&
        facilityDialog
    ) {
        facilityDialog.close();
    }

}


function cancelPick() {

    const type =
        state.picking;

    state.picking =
        null;

    const banner =
        $('#selection-banner');

    if (banner) {
        banner.hidden = true;
    }

    const workspace =
        $('.workspace');

    if (workspace) {
        workspace.classList.remove(
            'picking'
        );
    }

    const facilityDialog =
        $('#facility-dialog');

    if (
        type === 'facility' &&
        facilityDialog &&
        !facilityDialog.open
    ) {
        facilityDialog.showModal();
    }
}


const cancelPickButton =
    $('#cancel-pick');

if (cancelPickButton) {
    cancelPickButton.onclick =
        cancelPick;
}


const analysisPick =
    $('#analysis-pick');

if (analysisPick) {
    analysisPick.onclick =
        () => startPick('analysis');
}


const reportPick =
    $('#report-pick');

if (reportPick) {
    reportPick.onclick =
        () => startPick('report');
}


const facilityPick =
    $('#facility-pick');

if (facilityPick) {
    facilityPick.onclick =
        () => startPick('facility');
}


// ============================================================
// SELECT POINT
// ============================================================

async function selectPoint(
    latlng,
    type
) {

    const point = {
        latitude: latlng.lat,
        longitude: latlng.lng
    };

    try {

        const result =
            await api(
                '/api/location',
                {
                    method: 'POST',
                    body: point
                }
            );

        selectionLayer
            .clearLayers();

        L.circleMarker(
            latlng,
            {
                radius: 7,
                color: '#fff',
                weight: 3,
                fillColor: '#112c39',
                fillOpacity: 1
            }
        ).addTo(
            selectionLayer
        );

        const label =
            $('#' + type + '-point-label');

        if (label) {
            label.textContent =
                result.message;
        }

        if (
            type === 'analysis'
        ) {

            state.point =
                point;

            updatePreview();

        } else {

            const form =
                $('#' + type + '-form');

            if (form) {

                if (
                    form.elements.latitude
                ) {

                    form.elements.latitude.value =
                        latlng.lat.toFixed(6);
                }

                if (
                    form.elements.longitude
                ) {

                    form.elements.longitude.value =
                        latlng.lng.toFixed(6);
                }
            }
        }

        cancelPick();

        if (
            type !== 'facility'
        ) {
            displayView(type);
        }

    } catch (error) {

        toast(
            error.message
        );
    }
}


map.on(
    'click',
    event => {

        if (state.picking) {

            selectPoint(
                event.latlng,
                state.picking
            );
        }
    }
);


// ============================================================
// ANALYSIS PREVIEW
// ============================================================

function updatePreview() {

    if (!state.point) return;

    selectionLayer
        .clearLayers();

    const latlng = [
        state.point.latitude,
        state.point.longitude
    ];

    L.circleMarker(
        latlng,
        {
            radius: 7,
            color: '#fff',
            weight: 3,
            fillColor: '#112c39',
            fillOpacity: 1
        }
    ).addTo(
        selectionLayer
    );

    if (
        window.turf
    ) {

        const circle =
            turf.circle(
                [
                    state.point.longitude,
                    state.point.latitude
                ],
                .15,
                {
                    units: 'kilometers',
                    steps: 48
                }
            );

        L.geoJSON(
            circle,
            {
                style: {
                    color: '#117d76',
                    weight: 1,
                    dashArray: '3 5',
                    fillOpacity: .07
                },

                interactive: false
            }
        ).addTo(
            selectionLayer
        );
    }
}


// ============================================================
// ANALYSIS CONTROLS
// ============================================================

const analysisMode =
    $('#analysis-mode');

if (analysisMode) {

    analysisMode.onchange =
        () => {

            const nearest =
                analysisMode.value
                === 'nearest';

            const location =
                $('#analysis-location');

            const count =
                $('#count-field');

            const radius =
                $('#radius-field');

            if (location) {
                location.hidden =
                    !nearest;
            }

            if (count) {
                count.hidden =
                    !nearest;
            }

            if (radius) {
                radius.hidden =
                    nearest;

                const radiusLabel =
                    $('#radius-label');

                if (radiusLabel) {
                    radiusLabel.textContent =
                        analysisMode.value === 'accessibility'
                            ? 'Maximum distance'
                            : 'Buffer radius';
                }

                if (
                    nearest
                ) {
                    renderFacilityMarkers();
                }
            };

        };

    analysisMode.onchange();
}


const clearAnalysis =
    $('#clear-analysis');

if (clearAnalysis) {

    clearAnalysis.onclick =
        () => {

            state.analysisRequest++;

            analysisLayer
                .clearLayers();

            selectionLayer
                .clearLayers();

            // Accessibility temporarily enables the normal barangay layer
            // so its outlines remain visible under the analysis polygons.
            // Remove it only when the user did not have it enabled before
            // running the analysis.
            if (
                analysisAddedBarangayLayer &&
                !barangayLayerWasVisibleBeforeAnalysis
            ) {
                map.removeLayer(
                    barangayLayer
                );
            }

            const barangayCheckbox =
                $('#layer-barangays');

            if (
                barangayCheckbox &&
                !barangayCheckboxWasCheckedBeforeAnalysis
            ) {
                barangayCheckbox.checked = false;
            }

            analysisAddedBarangayLayer = false;
            barangayLayerWasVisibleBeforeAnalysis = false;
            barangayCheckboxWasCheckedBeforeAnalysis = false;

            const accessibilityLegend =
                $('#accessibility-legend');

            if (accessibilityLegend) {
                accessibilityLegend.hidden = true;
            }

            renderFacilityMarkers();
            state.accessibilityResults = null;
            state.accessibilityType = '';
            state.accessibilityThresholdKm = null;

            const results =
                $('#analysis-results');

            if (results) {
                results.innerHTML = '';
            }
        };
}


const runAnalysis =
    $('#run-analysis');

if (runAnalysis) {

    runAnalysis.onclick =
        () => busy(
            runAnalysis,
            async () => {

                const mode =
                    $('#analysis-mode')
                        ?.value;

                if (
                    mode === 'nearest' &&
                    !state.point
                ) {
                    throw new Error(
                        'Select a location on the map first.'
                    );
                }

                const requestId =
                    ++state.analysisRequest;

                const type =
                    $('#analysis-type')
                        ?.value ||
                    'hospital';

                if (
                    mode === 'coverage' ||
                    mode === 'accessibility'
                ) {
                    renderFacilityMarkers(
                        type === 'all'
                            ? ''
                            : type
                    );
                }

                const body = {

                    facility_type:
                        type,

                    radius_km:
                        Number(
                            $('#analysis-radius')
                                ?.value ||
                            3
                        ),

                    count:
                        Number(
                            $('#analysis-count')
                                ?.value ||
                            3
                        ),

                    ...(state.point || {})
                };

                const result =
                    await api(
                        '/api/analysis/' +
                        mode,
                        {
                            method: 'POST',
                            body
                        }
                    );

                if (
                    requestId !==
                    state.analysisRequest
                ) return;

                analysisLayer
                    .clearLayers();

                const accessibilityLegend =
                    $('#accessibility-legend');

                if (accessibilityLegend) {
                    accessibilityLegend.hidden =
                        mode !== 'accessibility';
                }

                let html = `
                    <div class="eyebrow">
                        ${
                            mode === 'nearest'
                                ? 'NEAREST FACILITIES'
                                : mode === 'coverage'
                                    ? 'COVERAGE RESULTS'
                                    : 'BARANGAY RESULTS'
                        }
                    </div>
                `;


                // ============================================
                // NEAREST FACILITY
                // ============================================

                if (
                    mode === 'nearest'
                ) {

                    html +=
                        result.features.length

                            ? result.features
                                .map(
                                    (
                                        feature,
                                        index
                                    ) => {

                                        const p =
                                            feature.properties;

                                        if (
                                            p.road_route_available &&
                                            feature.geometry.type ===
                                            'LineString'
                                        ) {
                                            L.polyline(
                                                feature.geometry.coordinates
                                                    .map(
                                                        coordinate => [
                                                            coordinate[1],
                                                            coordinate[0]
                                                        ]
                                                    ),
                                                {
                                                    color:
                                                        colors[type],
                                                    weight: 2,
                                                    dashArray:
                                                        '6 7'
                                                }
                                            ).addTo(
                                                analysisLayer
                                            );
                                        }

                                        return `
                                            <div class="analysis-result">

                                                <strong>
                                                    ${index + 1}.
                                                    ${escapeHTML(
                                                        p.name
                                                    )}
                                                </strong>

                                                <b>
                                                    ${
                                                        p.road_route_available
                                                            ? (
                                                                p.road_distance_m /
                                                                1000
                                                            ).toFixed(2) +
                                                            ' km'
                                                            : 'Route unavailable'
                                                    }
                                                </b>

                                                ${statusBadge(
                                                    p.status
                                                )}

                                                <span>
                                                    ${
                                                        p.road_route_available
                                                            ? 'Google driving route'
                                                            : 'Straight-line fallback'
                                                    }
                                                </span>

                                            </div>
                                        `;
                                    }
                                )
                                .join('')

                            : empty(
                                'No eligible facilities',
                                'Choose another facility type or location.'
                            );
                }


                // ============================================
                // COVERAGE
                // ============================================

                else if (
                    mode === 'coverage'
                ) {

                    L.geoJSON(
                        result,
                        {
                            style: {
                                color:
                                    colors[type],

                                fillColor:
                                    colors[type],

                                weight: 1.5,

                                fillOpacity:
                                    .13
                            },

                            onEachFeature:
                                (
                                    feature,
                                    layer
                                ) => {

                                    layer.bindTooltip(
                                        escapeHTML(
                                            feature
                                                .properties
                                                .name
                                        )
                                        +
                                        ' · '
                                        +
                                        body.radius_km
                                        +
                                        ' km'
                                    );
                                }
                        }
                    ).addTo(
                        analysisLayer
                    );

                    html += `
                        <div class="analysis-result">

                            <strong>
                                ${result.features.length}
                                facility buffers
                            </strong>

                            <b>
                                ${body.radius_km}
                                km radius
                            </b>

                            <span>
                                Active facilities only.
                                These areas show proximity,
                                not guaranteed service.
                            </span>

                        </div>
                    `;

                    if (
                        !result.features.length
                    ) {

                        html += empty(
                            'No eligible facilities',
                            'Choose another facility type or location.'
                        );
                    }
                }


                // ============================================
                // ACCESSIBILITY
                // ============================================

                else {

                    const thresholdKm =
                        body.radius_km;

                    const accessibilityResults =
                        result.results || [];

                    state.accessibilityResults =
                        accessibilityResults;
                    state.accessibilityType =
                        type;
                    state.accessibilityThresholdKm =
                        thresholdKm;

                    const withinCount =
                        accessibilityResults.filter(
                            row =>
                                row.nearest_m !== null &&
                                Number(row.nearest_m) <=
                                thresholdKm * 1000
                        ).length;

                    const beyondCount =
                        accessibilityResults.filter(
                            row =>
                                row.nearest_m !== null &&
                                Number(row.nearest_m) >
                                thresholdKm * 1000
                        ).length;

                    const noDataCount =
                        accessibilityResults.length -
                        withinCount -
                        beyondCount;

                    L.geoJSON(
                        {
                            type: 'FeatureCollection',
                            features:
                                accessibilityResults
                                    .filter(row => row.geometry)
                                    .map(
                                    row => ({
                                        type: 'Feature',
                                        geometry: row.geometry,
                                        properties: row
                                    })
                                )
                        },
                        {
                            style: feature => {
                                const row =
                                    feature.properties;

                                const within =
                                    row.nearest_m !== null &&
                                    Number(row.nearest_m) <=
                                    thresholdKm * 1000;

                                const beyond =
                                    row.nearest_m !== null &&
                                    Number(row.nearest_m) >
                                    thresholdKm * 1000;

                                return {
                                    color:
                                        within
                                            ? '#147a4b'
                                            : beyond
                                                ? '#b45309'
                                                : '#5b6470',
                                    fillColor:
                                        within
                                            ? '#35a86f'
                                            : beyond
                                                ? '#e58a32'
                                                : '#a5adb6',
                                    weight: 2,
                                    fillOpacity: .30
                                };
                            },
                            onEachFeature: (feature, layer) => {
                                const row =
                                    feature.properties;

                                const within =
                                    row.nearest_m !== null &&
                                    Number(row.nearest_m) <=
                                    thresholdKm * 1000;

                                const beyond =
                                    row.nearest_m !== null &&
                                    Number(row.nearest_m) >
                                    thresholdKm * 1000;

                                const resultLabel =
                                    within
                                        ? 'Within threshold'
                                        : beyond
                                            ? 'Beyond threshold'
                                            : 'No data';

                                layer.bindPopup(
                                    accessibilityPopupHtml(
                                        row,
                                        type,
                                        thresholdKm,
                                        resultLabel
                                    )
                                );
                            }
                        }
                    ).addTo(analysisLayer);

                    html += `
                        <p
                            class="help-text"
                            style="margin:0"
                        >
                            Barangays analyzed:
                            ${accessibilityResults.length}
                            · Within threshold:
                            ${withinCount}
                            · Beyond threshold:
                            ${beyondCount}
                            · No data:
                            ${noDataCount}
                            <br>
                            Selected facility type:
                            ${escapeHTML(facilityTypeLabels[type] || type)}
                            · Maximum distance:
                            ${thresholdKm} km
                        </p>
                    `;

                    html +=
                        accessibilityResults
                            .map(
                                row => `

                                    <div class="analysis-result">

                                        <strong>
                                            ${escapeHTML(
                                                row.name
                                            )}
                                        </strong>

                                        <b>
                                            ${
                                                row.nearest_m === null
                                                    ? 'No data'
                                                    : Number(row.nearest_m) <= thresholdKm * 1000
                                                        ? 'Within threshold'
                                                        : 'Beyond threshold'
                                            }
                                        </b>

                                        <span>
                                            Nearest:
                                            ${
                                                row.nearest_facility
                                                    ? escapeHTML(row.nearest_facility)
                                                    : 'No eligible facility'
                                            }
                                            <br>
                                            Distance:
                                            ${
                                                row.nearest_m === null
                                                    ? 'No data'
                                                    : (Number(row.nearest_m) / 1000).toFixed(2) + ' km'
                                            }
                                        </span>

                                    </div>
                                `
                            )
                            .join('');

                    const checkbox =
                        $('#layer-barangays');

                    const layerWasVisible =
                        barangayLayer.map ===
                        map.native;

                    if (!layerWasVisible) {
                        barangayLayerWasVisibleBeforeAnalysis =
                            false;
                        analysisAddedBarangayLayer =
                            true;
                        map.addLayer(
                            barangayLayer
                        );
                    } else {
                        barangayLayerWasVisibleBeforeAnalysis =
                            true;
                    }

                    if (checkbox) {
                        barangayCheckboxWasCheckedBeforeAnalysis =
                            checkbox.checked;
                        checkbox.checked = true;
                    }
                }


                html += `
                    <p
                        class="help-text"
                        style="margin:18px 0 0"
                    >
                        ${escapeHTML(
                            result.method
                        )}
                    </p>
                `;

                const results =
                    $('#analysis-results');

                if (results) {
                    results.innerHTML =
                        html;
                }

                refreshIcons();

                toast(
                    'Analysis complete. Results are below the controls.'
                );
            }
        );
}


// ============================================================
// REPORT INCIDENT
// ============================================================

const reportForm =
    $('#report-form');

if (reportForm) {

    reportForm.onsubmit =
        async event => {

            event.preventDefault();

            const button =
                event.submitter;

            if (button) {
                button.disabled = true;
            }

            feedback(
                '#report-feedback',
                ''
            );

            try {

                const result =
                    await api(
                        '/api/incidents',
                        {
                            method: 'POST',
                            body:
                                new FormData(
                                    event.target
                                )
                        }
                    );

                feedback(
                    '#report-feedback',
                    `Report #${result.id} received. ${result.message}`,
                    true
                );

                event.target.reset();

                const label =
                    $('#report-point-label');

                if (label) {

                    label.textContent =
                        'Choose the actual location on the map';
                }

                selectionLayer
                    .clearLayers();

            } catch (error) {

                feedback(
                    '#report-feedback',
                    error.message
                );

            } finally {

                if (button) {
                    button.disabled =
                        false;
                }
            }
        };
}


// ============================================================
// DIALOG CLOSE BUTTONS
// ============================================================

$$('[data-close]')
    .forEach(
        button => {

            button.onclick =
                () => {

                    const dialog =
                        $(
                            '#' +
                            button.dataset.close
                        );

                    if (
                        dialog &&
                        dialog.close
                    ) {
                        dialog.close();
                    }
                };
        }
    );


// ============================================================
// ABOUT
//
// IMPORTANT FIX:
// Do not attach .onclick directly if the element
// does not exist in index.html.
// ============================================================

const aboutButton =
    $('#about-button');

if (aboutButton) {

    aboutButton.onclick =
        () => {

            const dialog =
                $('#about-dialog');

            if (dialog) {
                dialog.showModal();
            }
        };
}


// ============================================================
// ADMIN BUTTON
// ============================================================

const adminButton =
    $('#admin-button');

if (adminButton) {

    adminButton.onclick =
        () => {

            if (state.admin) {

                openAdmin();

            } else {

                const loginDialog =
                    $('#login-dialog');

                if (loginDialog) {
                    loginDialog.showModal();
                }
            }
        };
}


// ============================================================
// LOGIN
// ============================================================

const loginForm =
    $('#login-form');

if (loginForm) {

    loginForm.onsubmit =
        async event => {

            event.preventDefault();

            const button =
                event.submitter;

            if (button) {
                button.disabled = true;
            }

            feedback(
                '#login-feedback',
                ''
            );

            try {

                const result =
                    await api(
                        '/api/login',
                        {
                            method: 'POST',

                            body:
                                Object.fromEntries(
                                    new FormData(
                                        event.target
                                    )
                                )
                        }
                    );

                Object.assign(
                    state,
                    result
                );

                event.target.reset();

                const dialog =
                    $('#login-dialog');

                if (dialog) {
                    dialog.close();
                }

                await openAdmin();

            } catch (error) {

                feedback(
                    '#login-feedback',
                    error.message
                );

            } finally {

                if (button) {
                    button.disabled =
                        false;
                }
            }
        };
}


// ============================================================
// LOGOUT
// ============================================================

const logoutButton =
    $('#logout');

if (logoutButton) {

    logoutButton.onclick =
        () => busy(
            logoutButton,
            async () => {

                await api(
                    '/api/logout',
                    {
                        method: 'POST'
                    }
                );

                state.admin =
                    false;

                const adminDialog =
                    $('#admin-dialog');

                if (adminDialog) {
                    adminDialog.close();
                }

                Object.assign(
                    state,
                    await api(
                        '/api/session'
                    )
                );

                toast(
                    'Signed out.'
                );
            }
        );
}


// ============================================================
// ADMIN FACILITIES
// ============================================================

function renderAdminFacilities() {

    const adminSearch =
        $('#admin-search');

    const table =
        $('#admin-facilities');

    if (!table) return;

    const q =
        (
            adminSearch?.value ||
            ''
        ).toLowerCase();

    table.innerHTML =
        state.adminFacilities
            .filter(
                feature =>
                    feature.properties.name
                        .toLowerCase()
                        .includes(q)
            )
            .map(
                feature => {

                    const p =
                        feature.properties;

                    return `
                        <tr>

                            <td>
                                ${escapeHTML(
                                    p.name
                                )}
                            </td>

                            <td>
                                ${
                                    names[
                                        p.facility_type
                                    ] ||
                                    p.facility_type
                                }
                            </td>

                            <td>
                                ${statusBadge(
                                    p.status
                                )}
                            </td>

                            <td>

                                <div class="inline-actions">

                                    <button
                                        class="text-button"
                                        data-edit="${p.id}"
                                    >
                                        Edit
                                    </button>

                                    <button
                                        class="text-button"
                                        data-delete="${p.id}"
                                        aria-label="Delete ${escapeHTML(p.name)}"
                                    >
                                        Delete
                                    </button>

                                </div>

                            </td>

                        </tr>
                    `;
                }
            )
            .join('')
        ||
        `
            <tr>
                <td colspan="4">
                    No facilities match.
                </td>
            </tr>
        `;


    $$('[data-edit]')
        .forEach(
            button => {

                button.onclick =
                    () => {

                        editFacility(
                            state.adminFacilities
                                .find(
                                    feature =>
                                        feature
                                            .properties
                                            .id
                                        ===
                                        +button.dataset.edit
                                )
                        );
                    };
        }
    );


    $$('[data-delete]')
        .forEach(
            button => {

                button.onclick =
                    () => {

                        const feature =
                            state.adminFacilities
                                .find(
                                    item =>
                                        item
                                            .properties
                                            .id
                                        ===
                                        +button.dataset.delete
                                );

                        if (!feature) return;

                        const description =
                            $('#delete-description');

                        if (description) {
                            description.textContent =
                                feature.properties.name;
                        }

                        const dialog =
                            $('#confirm-dialog');

                        if (dialog) {
                            dialog.showModal();
                        }

                        const confirm =
                            $('#confirm-delete');

                        if (confirm) {

                            confirm.onclick =
                                () => busy(
                                    confirm,
                                    async () => {

                                        await api(
                                            '/api/facilities/' +
                                            feature.properties.id,
                                            {
                                                method:
                                                    'DELETE'
                                            }
                                        );

                                        if (dialog) {
                                            dialog.close();
                                        }

                                        await openAdmin();

                                        await loadFacilities();

                                        toast(
                                            'Facility deleted.'
                                        );
                                    }
                                );
                        }
                    };
        }
    );
}


const adminSearch =
    $('#admin-search');

if (adminSearch) {
    adminSearch.oninput =
        renderAdminFacilities;
}


// ============================================================
// OPEN ADMIN
// ============================================================

async function openAdmin() {

    const adminDialog =
        $('#admin-dialog');

    if (
        adminDialog &&
        !adminDialog.open
    ) {
        adminDialog.showModal();
    }

    try {

        const [
            stats,
            facilities,
            reports
        ] = await Promise.all([

            api(
                '/api/admin/stats'
            ),

            api(
                '/api/facilities'
            ),

            api(
                '/api/incidents?admin=1'
            )
        ]);

        state.adminFacilities =
            facilities.features;

        const facilityTotal =
            stats.facilities.reduce(
                (total, row) =>
                    total + row.count,
                0
            );

        const count =
            status =>
                stats.incidents
                    .find(
                        row =>
                            row.status === status
                    )
                    ?.count
                || 0;


        const adminStats =
            $('#admin-stats');

        if (adminStats) {

            adminStats.innerHTML =
                [
                    [
                        facilityTotal,
                        'Facilities'
                    ],

                    [
                        count('pending'),
                        'Pending review'
                    ],

                    [
                        count('verified')
                        +
                        count('responding'),

                        'Active incidents'
                    ],

                    [
                        count('resolved'),
                        'Resolved reports'
                    ]
                ]
                    .map(
                        ([number, label]) => `

                            <div class="stat">

                                <strong>
                                    ${number}
                                </strong>

                                <span>
                                    ${label}
                                </span>

                            </div>
                        `
                    )
                    .join('');
        }


        renderAdminFacilities();


        const adminReports =
            $('#admin-reports');

        if (adminReports) {

            adminReports.innerHTML =
                reports.features.length

                    ? reports.features
                        .map(
                            feature => {

                                const p =
                                    feature.properties;

                                return `

                                    <article class="report-review">

                                        <div class="review-top">

                                            <strong>
                                                #${p.id}
                                                ·
                                                ${escapeHTML(
                                                    p.incident_type
                                                )}
                                            </strong>

                                            ${statusBadge(
                                                p.status
                                            )}

                                            <select
                                                data-report-status="${p.id}"
                                                aria-label="Status of report ${p.id}"
                                            >

                                                ${
                                                    [
                                                        'pending',
                                                        'verified',
                                                        'responding',
                                                        'resolved'
                                                    ]
                                                        .map(
                                                            status => `

                                                                <option
                                                                    value="${status}"
                                                                    ${
                                                                        status === p.status
                                                                            ? 'selected'
                                                                            : ''
                                                                    }
                                                                >
                                                                    ${
                                                                        status
                                                                            .charAt(0)
                                                                            .toUpperCase()
                                                                        +
                                                                        status.slice(1)
                                                                    }
                                                                </option>
                                                            `
                                                        )
                                                        .join('')
                                                }

                                            </select>

                                        </div>

                                        <p>
                                            ${escapeHTML(
                                                p.description
                                            )}
                                        </p>

                                        <div class="review-meta">

                                            ${escapeHTML(
                                                p.barangay ||
                                                'Barangay not determined'
                                            )}

                                            ·

                                            ${escapeHTML(
                                                new Date(
                                                    p.reported_at
                                                ).toLocaleString()
                                            )}

                                        </div>

                                        ${
                                            p.has_photo

                                                ? `
                                                    <a
                                                        href="/api/incidents/${p.id}/photo"
                                                        target="_blank"
                                                        rel="noopener"
                                                    >
                                                        View submitted photo
                                                    </a>
                                                `

                                                : ''
                                        }

                                        <button
                                            class="text-button"
                                            data-report-map="${p.id}"
                                        >
                                            View location on map
                                        </button>

                                    </article>
                                `;
                            }
                        )
                        .join('')

                    : empty(
                        'No incident reports',
                        'Submitted reports will appear here for review.',
                        'inbox'
                    );
        }


        $$('[data-report-status]')
            .forEach(
                select => {

                    select.onchange =
                        async () => {

                            select.disabled =
                                true;

                            try {

                                await api(
                                    '/api/incidents/' +
                                    select.dataset.reportStatus,
                                    {
                                        method:
                                            'PATCH',

                                        body: {
                                            status:
                                                select.value
                                        }
                                    }
                                );

                                await openAdmin();

                                await loadIncidents();

                                toast(
                                    'Report status updated.'
                                );

                            } catch (error) {

                                toast(
                                    error.message
                                );

                                await openAdmin();

                            } finally {

                                select.disabled =
                                    false;
                            }
                        };
                }
            );


        $$('[data-report-map]')
            .forEach(
                button => {

                    button.onclick =
                        () => {

                            const feature =
                                reports.features
                                    .find(
                                        item =>
                                            item
                                                .properties
                                                .id
                                            ===
                                            +button.dataset.reportMap
                                    );

                            if (!feature) return;

                            if (adminDialog) {
                                adminDialog.close();
                            }

                            selectionLayer
                                .clearLayers();

                            const latlng =
                                [
                                    ...feature
                                        .geometry
                                        .coordinates
                                ].reverse();

                            L.circleMarker(
                                latlng,
                                {
                                    radius: 8,
                                    color: '#cf4b45'
                                }
                            ).addTo(
                                selectionLayer
                            );

                            map.setView(
                                latlng,
                                16
                            );

                            collapseMobile();
                        };
                }
            );

        refreshIcons();

    } catch (error) {

        toast(
            error.message
        );
    }
}


// ============================================================
// EDIT FACILITY
// ============================================================

function editFacility(
    feature = null
) {

    const form =
        $('#facility-form');

    if (!form) return;

    form.reset();

    feedback(
        '#facility-feedback',
        ''
    );

    const pointLabel =
        $('#facility-point-label');

    if (pointLabel) {
        pointLabel.textContent =
            'Click to choose on the map';
    }

    const title =
        $('#facility-form-title');

    if (title) {

        title.textContent =
            feature
                ? 'Edit facility'
                : 'Add facility';
    }

    if (feature) {

        const p =
            feature.properties;

        [
            'id',
            'name',
            'facility_type',
            'status',
            'address',
            'contact_number'
        ].forEach(
            key => {

                if (
                    form.elements[key]
                ) {

                    form.elements[key].value =
                        p[key] ?? '';
                }
            }
        );

        if (
            form.elements.longitude
        ) {

            form.elements.longitude.value =
                feature.geometry
                    .coordinates[0];
        }

        if (
            form.elements.latitude
        ) {

            form.elements.latitude.value =
                feature.geometry
                    .coordinates[1];
        }

        if (pointLabel) {

            pointLabel.textContent =
                p.barangay ||
                'Barangay not determined';
        }
    }

    const adminDialog =
        $('#admin-dialog');

    if (
        adminDialog &&
        adminDialog.open
    ) {
        adminDialog.close();
    }

    const facilityDialog =
        $('#facility-dialog');

    if (facilityDialog) {
        facilityDialog.showModal();
    }
}


const addFacilityButton =
    $('#add-facility');

if (addFacilityButton) {

    addFacilityButton.onclick =
        () => editFacility();
}


// ============================================================
// SAVE FACILITY
// ============================================================

const facilityForm =
    $('#facility-form');

if (facilityForm) {

    facilityForm.onsubmit =
        async event => {

            event.preventDefault();

            const button =
                event.submitter;

            if (button) {
                button.disabled = true;
            }

            const data =
                Object.fromEntries(
                    new FormData(
                        event.target
                    )
                );

            const id =
                data.id;

            delete data.id;

            try {

                await api(
                    '/api/facilities'
                    +
                    (
                        id
                            ? '/' + id
                            : ''
                    ),

                    {
                        method:
                            id
                                ? 'PATCH'
                                : 'POST',

                        body:
                            data
                    }
                );

                const dialog =
                    $('#facility-dialog');

                if (dialog) {
                    dialog.close();
                }

                await Promise.all([
                    loadFacilities(),
                    loadMeta()
                ]);

                await openAdmin();

                toast(
                    'Facility saved.'
                );

            } catch (error) {

                feedback(
                    '#facility-feedback',
                    error.message
                );

            } finally {

                if (button) {
                    button.disabled =
                        false;
                }
            }
        };
}


// ============================================================
// LOAD METADATA + GEOSERVER
// ============================================================

async function loadMeta() {

    state.meta =
        await api(
            '/api/meta'
        );

    const m =
        state.meta;

    const barangayFilter =
        $('#barangay-filter');

    if (barangayFilter) {

        const selected =
            barangayFilter.value;

        barangayFilter.innerHTML =
            '<option value="">All mapped barangays</option>'
            +
            m.barangays
                .map(
                    barangay => `
                        <option value="${barangay.id}">
                            ${escapeHTML(
                                barangay.name
                            )}
                        </option>
                    `
                )
                .join('');

        barangayFilter.value =
            selected;
    }


    const total =
        m.counts.reduce(
            (
                number,
                row
            ) =>
                number +
                row.count,
            0
        );


    const note =
        $('#map-data-note');

    if (note) {

        note.textContent =
            `${total} Google Places facilities · ` +
            `${m.boundary_count} available barangay boundaries`;
    }


    const provenance =
        $('#provenance');

    if (provenance) {

        provenance.innerHTML = `

            <h3>
                Google Places facilities
            </h3>

            <p>

                <a
                    href="https://developers.google.com/maps/documentation/places/web-service/overview"
                    target="_blank"
                    rel="noopener"
                >
                    Google Places documentation
                </a>
            </p>

            <div class="notice">

                The map shows Google Places hospitals,
                fire stations and police stations.
                Facility names, addresses and coordinates
                come from Google Places and may change.

            </div>

            <p>

                ${m.boundary_count}
                barangay boundary polygons are used only
                for geographic context and barangay assignment.
                Those boundary polygons come from the
                OpenStreetMap import.

            </p>

            <p>

                ${m.merged_source_count}
                duplicate source record(s) merged.

                Both source identities are
                retained in the database.

            </p>
        `;
    }


    // ========================================================
    // GEOSERVER
    // ========================================================

    if (
        m.geoserver_configured
    ) {

        const control =
            $('#geoserver-control');

        if (control) {
            control.hidden = false;
        }

        wmsLayer =
            L.tileLayer.wms(
                '/api/geoserver',
                {
                    layers:
                        'configured',

                    format:
                        'image/png',

                    transparent:
                        true,

                    version:
                        '1.1.1'
                }
            );
    }
}


// ============================================================
// INITIALIZE APPLICATION
// ============================================================

async function init() {

    refreshIcons();

    try {

        // Get CSRF token and login status
        Object.assign(
            state,
            await api(
                '/api/session'
            )
        );


        // Load all map/application data
        await Promise.all([

            loadFacilities(),

            loadIncidents(),

            loadMeta(),

            api(
                '/api/boundaries'
            ).then(
                data => {

                    // City boundary
                    cityLayer.addData({
                        ...data,

                        features:
                            data.features
                                .filter(
                                    feature =>
                                        feature
                                            .properties
                                            .kind
                                        ===
                                        'city'
                                )
                    });


                    // Barangay boundaries
                    barangayLayer.addData({
                        ...data,

                        features:
                            data.features
                                .filter(
                                    feature =>
                                        feature
                                            .properties
                                            .kind
                                        ===
                                        'barangay'
                                )
                    });
                }
            )
        ]);


        // If user opened /admin directly
        if (
            location.pathname
            === '/admin'
        ) {

            if (state.admin) {

                openAdmin();

            } else {

                const loginDialog =
                    $('#login-dialog');

                if (loginDialog) {
                    loginDialog.showModal();
                }
            }
        }


        console.log(
            'ResQGIS initialized successfully.'
        );


    } catch (error) {

        console.error(
            'ResQGIS initialization failed:',
            error
        );

        toast(
            error.message
        );
    }


    refreshIcons();
}


// ============================================================
// START RESQGIS
// ============================================================

init();

})().catch(error => {
    console.error('Google Maps initialization failed:', error);
    const banner = document.querySelector('#map-error');
    if (banner) {
        banner.hidden = false;
        banner.textContent = error.message || 'Google Maps could not load.';
    }
});
