'use strict';

// ============================================================
// ResQGIS Google Maps Compatibility Layer
// ============================================================
// This file allows the existing ResQGIS application to use
// Google Maps while preserving the L.* style API expected by
// the older application code.
//
// Coordinates at this boundary use:
//     { lat, lng }
// or:
//     [latitude, longitude]
// ============================================================

window.GIS = (() => {

    const position = p =>
        Array.isArray(p)
            ? {
                lat: p[0],
                lng: p[1]
            }
            : p;

    let maps;
    let geocoder;


    // ========================================================
    // HELPERS
    // ========================================================

    const plainText = html => {

        const node = document.createElement('div');

        node.innerHTML = html;

        return node.textContent;
    };


    function style(options = {}) {

        return {

            strokeColor:
                options.color || '#117d76',

            strokeWeight:
                options.weight ?? 2,

            strokeOpacity:
                options.opacity ?? 1,

            fillColor:
                options.fillColor ||
                options.color ||
                '#117d76',

            fillOpacity:
                options.fill === false
                    ? 0
                    : (options.fillOpacity ?? 0.2),

            clickable:
                options.interactive !== false
        };
    }


    // ========================================================
    // BASE LAYER AND LAYER GROUPS
    // ========================================================
    // Layer and GeoLayer translate the application's L.* calls into Google
    // Maps overlays. app.js owns which application layers are visible.

    class Layer {

        constructor() {

            this.map = null;

            this.objects = [];

            this.children = [];

            this.listeners = [];

            this.tooltips = [];
        }


        addTo(target) {

            if (target instanceof MapView) {

                this.setMap(target.native);

            } else {

                target.children.push(this);

                this.setMap(target.map);
            }

            return this;
        }


        setMap(map) {

            this.map = map;

            for (const object of this.objects) {

                if (
                    maps?.marker &&
                    object instanceof
                    maps.marker.AdvancedMarkerElement
                ) {

                    object.map = map;

                } else if (object.setMap) {

                    object.setMap(map);
                }
            }


            this.children.forEach(
                child => child.setMap(map)
            );


            if (!map && this.info) {

                this.info.close();
            }


            if (!map) {

                this.tooltips.forEach(
                    info => info.close()
                );
            }

            return this;
        }


        clearLayers() {

            this.children.forEach(
                child => child.dispose()
            );

            this.children = [];


            this.objects.forEach(object => {

                if (
                    maps?.marker &&
                    object instanceof
                    maps.marker.AdvancedMarkerElement
                ) {

                    object.map = null;

                } else if (object.setMap) {

                    object.setMap(null);
                }
            });

            this.objects = [];


            this.listeners.forEach(listener => {

                if (listener?.remove) {

                    listener.remove();
                }
            });

            this.listeners = [];


            if (this.info) {

                this.info.close();
            }


            this.tooltips.forEach(
                info => info.close()
            );

            this.tooltips = [];

            return this;
        }


        dispose() {

            this.setMap(null);

            this.clearLayers();
        }


        getLayers() {

            return [
                ...this.children,
                ...this.objects
            ];
        }


        // ----------------------------------------------------
        // Layer event compatibility
        // ----------------------------------------------------

        on(event, handler) {

            this.objects.forEach(object => {

                if (!object.addListener) {

                    return;
                }

                const listener =
                    object.addListener(
                        event,
                        googleEvent => {

                            let latlng = null;

                            if (googleEvent?.latLng) {

                                latlng = {
                                    lat:
                                        googleEvent
                                            .latLng
                                            .lat(),

                                    lng:
                                        googleEvent
                                            .latLng
                                            .lng()
                                };

                            } else if (
                                object.position
                            ) {

                                const p =
                                    object.position;

                                latlng = {

                                    lat:
                                        typeof p.lat ===
                                        'function'
                                            ? p.lat()
                                            : p.lat,

                                    lng:
                                        typeof p.lng ===
                                        'function'
                                            ? p.lng()
                                            : p.lng
                                };
                            }


                            handler({

                                latlng,

                                originalEvent:
                                    googleEvent
                            });
                        }
                    );


                this.listeners.push(listener);
            });

            return this;
        }


        bindTooltip(html) {

            const title =
                plainText(html);


            this.objects.forEach(object => {

                if (
                    maps?.marker &&
                    object instanceof
                    maps.marker.AdvancedMarkerElement
                ) {

                    object.title = title;

                } else {

                    const info =
                        new maps.InfoWindow({

                            content: html,

                            disableAutoPan: true
                        });


                    this.tooltips.push(info);


                    this.listeners.push(

                        object.addListener(
                            'mouseover',
                            event => {

                                info.setPosition(
                                    event.latLng ||
                                    this.map?.native?.getCenter()
                                );

                                info.open({
                                    map:
                                        this.map?.native ||
                                        this.map
                                });
                            }
                        )
                    );


                    this.listeners.push(

                        object.addListener(
                            'mouseout',
                            () => info.close()
                        )
                    );
                }
            });

            return this;
        }


        bindPopup(html) {

            this.info =
                new maps.InfoWindow({
                    content: html
                });


            this.objects.forEach(object => {

                if (!object.addListener) {

                    return;
                }


                this.listeners.push(

                    object.addListener(
                        'click',
                        event => {

                            // Keep one boundary popup open at a time so
                            // repeated clicks do not stack InfoWindows.
                            const mapView =
                                this.map;

                            if (
                                mapView &&
                                mapView.activeInfoWindow &&
                                mapView.activeInfoWindow !==
                                    this.info
                            ) {
                                mapView.activeInfoWindow.close();
                            }

                            const p =
                                object.position ||
                                event?.latLng;


                            if (p) {

                                this.info
                                    .setPosition(p);
                            }


                            this.info.open({
                                map: this.map
                            });

                            if (mapView) {
                                mapView.activeInfoWindow =
                                    this.info;
                            }
                        }
                    )
                );
            });

            return this;
        }


        setStyle(options) {

            this.children.forEach(
                child =>
                    child.setStyle(options)
            );


            for (
                const object
                of this.objects
            ) {

                if (object.setOptions) {

                    this.options = {

                        ...this.options,

                        ...options
                    };


                    object.setOptions(
                        style(this.options)
                    );
                }
            }

            return this;
        }


        getBounds() {

            const bounds =
                new maps.LatLngBounds();


            this.children.forEach(child => {

                const childBounds =
                    child.getBounds();


                if (
                    childBounds &&
                    !childBounds.isEmpty()
                ) {

                    bounds.union(
                        childBounds
                    );
                }
            });


            this.objects.forEach(object => {

                if (object.position) {

                    bounds.extend(
                        object.position
                    );

                } else if (
                    object.getPaths
                ) {

                    object
                        .getPaths()
                        .forEach(path => {

                            path.forEach(p => {

                                bounds.extend(p);
                            });
                        });

                } else if (
                    object.getPath
                ) {

                    object
                        .getPath()
                        .forEach(p => {

                            bounds.extend(p);
                        });
                }
            });


            return bounds;
        }
    }


    // ========================================================
    // GEOJSON LAYER
    // ========================================================

    class GeoLayer extends Layer {

        constructor(
            data,
            options = {}
        ) {

            super();

            this.options =
                options;

            if (data) {

                this.addData(data);
            }
        }


        addData(data) {

            const features =

                data.type ===
                'FeatureCollection'

                    ? data.features

                    : [
                        data.type ===
                        'Feature'

                            ? data

                            : {

                                type:
                                    'Feature',

                                geometry:
                                    data,

                                properties:
                                    {}
                            }
                    ];


            features.forEach(
                feature => {

                    if (
                        !feature.geometry
                    ) {

                        return;
                    }


                    const layer =
                        new Layer();


                    layer.options =

                        typeof
                        this.options.style ===
                        'function'

                            ? this.options
                                .style(feature)

                            : {
                                ...this.options
                                    .style
                            };


                    const settings = {

                        ...style(
                            layer.options
                        ),

                        clickable:
                            this.options
                                .interactive !==
                            false
                    };


                    const coords =
                        feature.geometry
                            .coordinates;


                    const points =
                        values =>

                            values.map(
                                p => ({

                                    lat:
                                        p[1],

                                    lng:
                                        p[0]
                                })
                            );


                    const polygon =
                        rings => {

                            layer.objects.push(

                                new maps.Polygon({

                                    ...settings,

                                    paths:
                                        rings.map(
                                            points
                                        )
                                })
                            );
                        };


                    const line =
                        values => {

                            layer.objects.push(

                                new maps.Polyline({

                                    ...settings,

                                    path:
                                        points(
                                            values
                                        )
                                })
                            );
                        };


                    switch (
                        feature.geometry.type
                    ) {

                        case 'Polygon':

                            polygon(coords);

                            break;


                        case 'MultiPolygon':

                            coords.forEach(
                                polygon
                            );

                            break;


                        case 'LineString':

                            line(coords);

                            break;


                        case 'MultiLineString':

                            coords.forEach(
                                line
                            );

                            break;


                        case 'Point':

                            layer.objects.push(

                                new maps.marker
                                    .AdvancedMarkerElement({

                                        position: {

                                            lat:
                                                coords[1],

                                            lng:
                                                coords[0]
                                        },

                                        gmpClickable:
                                            true
                                    })
                            );

                            break;


                        default:

                            console.warn(
                                'Unsupported geometry:',
                                feature.geometry.type
                            );

                            return;
                    }


                    if (
                        this.options
                            .onEachFeature
                    ) {

                        this.options
                            .onEachFeature(
                                feature,
                                layer
                            );
                    }


                    layer.addTo(this);
                }
            );


            return this;
        }
    }


    // ========================================================
    // GOOGLE MAP VIEW
    // ========================================================

    class MapView {

        constructor(
            id,
            options = {}
        ) {

            const element =
                document.getElementById(id);


            if (!element) {

                throw new Error(
                    `Map element #${id} was not found.`
                );
            }


            this.native =
                new maps.Map(
                    element,
                    {

                        center: {

                            lat:
                                8.947,

                            lng:
                                125.535
                        },

                        zoom:
                            13,

                        minZoom:
                            options.minZoom,

                        maxZoom:
                            options.maxZoom,

                        mapId:
                            document.body
                                .dataset
                                .googleMapId ||
                            'DEMO_MAP_ID',

                        disableDefaultUI:
                            true,

                        keyboardShortcuts:
                            true,

                        clickableIcons:
                            false,

                        gestureHandling:
                            'greedy'
                    }
                );


            // Store listeners so they can
            // be removed later if necessary.
            this.listeners = {};
        }


        setView(
            p,
            zoom
        ) {

            this.native
                .setCenter(
                    position(p)
                );


            if (
                zoom !== undefined &&
                zoom !== null
            ) {

                this.native
                    .setZoom(zoom);
            }

            return this;
        }


        flyTo(
            p,
            zoom
        ) {

            this.native
                .panTo(
                    position(p)
                );


            if (
                zoom !== undefined &&
                zoom !== null
            ) {

                this.native
                    .setZoom(zoom);
            }

            return this;
        }


        zoomIn() {

            this.native.setZoom(

                this.native.getZoom() +
                1
            );

            return this;
        }


        zoomOut() {

            this.native.setZoom(

                this.native.getZoom() -
                1
            );

            return this;
        }


        invalidateSize() {

            maps.event.trigger(
                this.native,
                'resize'
            );

            return this;
        }


        addLayer(layer) {

            layer.setMap(
                this.native
            );

            return this;
        }


        removeLayer(layer) {

            layer.setMap(null);

            return this;
        }


        fitBounds(
            bounds,
            options = {}
        ) {

            if (
                bounds &&
                !bounds.isEmpty()
            ) {

                let padding = 35;


                if (
                    Array.isArray(
                        options.padding
                    )
                ) {

                    padding =
                        options.padding[0] ??
                        35;

                } else if (
                    typeof
                    options.padding ===
                    'number'
                ) {

                    padding =
                        options.padding;
                }


                this.native.fitBounds(
                    bounds,
                    padding
                );
            }

            return this;
        }


        // ====================================================
        // IMPORTANT FIX:
        // Convert Google Maps click events into the
        // Leaflet-style event expected by app.js:
        //
        //     event.latlng.lat
        //     event.latlng.lng
        //
        // Google normally provides:
        //
        //     event.latLng.lat()
        //     event.latLng.lng()
        // ====================================================

        on(
            eventName,
            callback
        ) {

            if (!callback) {

                return this;
            }


            let fallbackClickAt = 0;

            const emit =
                googleEvent => {

                    let latlng = null;

                    if (
                        googleEvent &&
                        googleEvent.latLng
                    ) {
                        const lat =
                            typeof googleEvent.latLng.lat === 'function'
                                ? googleEvent.latLng.lat()
                                : googleEvent.latLng.lat;
                        const lng =
                            typeof googleEvent.latLng.lng === 'function'
                                ? googleEvent.latLng.lng()
                                : googleEvent.latLng.lng;

                        if (
                            Number.isFinite(lat) &&
                            Number.isFinite(lng)
                        ) {
                            latlng = { lat, lng };
                        }
                    }

                    if (latlng) {
                        callback({
                            latlng,
                            originalEvent: googleEvent
                        });
                    }
                };

            const listener =
                maps.event.addListener(
                    this.native,
                    eventName,
                    googleEvent => {

                        if (
                            Date.now() -
                            fallbackClickAt >
                            100
                        ) {
                            emit(googleEvent);
                        }
                    }
                );

            if (eventName === 'click') {
                const mapElement =
                    this.native.getDiv();

                mapElement.addEventListener(
                    'click',
                    event => {
                        if (
                            event.target.closest('button, a')
                        ) {
                            return;
                        }

                        const bounds =
                            this.native.getBounds();
                        const rect =
                            mapElement.getBoundingClientRect();

                        if (!bounds || !rect.width || !rect.height) {
                            return;
                        }

                        const north =
                            bounds.getNorthEast().lat();
                        const south =
                            bounds.getSouthWest().lat();
                        const east =
                            bounds.getNorthEast().lng();
                        const west =
                            bounds.getSouthWest().lng();
                        const x =
                            (event.clientX - rect.left) / rect.width;
                        const y =
                            (event.clientY - rect.top) / rect.height;

                        fallbackClickAt = Date.now();
                        emit({
                            latLng: {
                                lat: () => north - (north - south) * y,
                                lng: () => west + (east - west) * x
                            }
                        });
                    }
                );
            }


            if (
                !this.listeners[
                    eventName
                ]
            ) {

                this.listeners[
                    eventName
                ] = [];
            }


            this.listeners[
                eventName
            ].push(listener);


            return this;
        }


        // ====================================================
        // LEAFLET-COMPATIBLE OFF()
        // ====================================================

        off(
            eventName,
            callback = null
        ) {

            if (!eventName) {

                return this;
            }


            const listeners =
                this.listeners[
                    eventName
                ] || [];


            // Existing ResQGIS normally uses
            // map.off('click').
            //
            // Google Maps listener objects don't expose the
            // original callback cleanly, so when callback is
            // omitted we remove every listener of that type.

            if (!callback) {

                listeners.forEach(
                    listener => {

                        if (
                            listener &&
                            listener.remove
                        ) {

                            listener.remove();
                        }
                    }
                );


                this.listeners[
                    eventName
                ] = [];


                return this;
            }


            // Fallback for compatibility.
            maps.event.clearListeners(
                this.native,
                eventName
            );


            this.listeners[
                eventName
            ] = [];


            return this;
        }


        // ====================================================
        // LEAFLET-COMPATIBLE ONCE()
        // ====================================================

        once(
            eventName,
            callback
        ) {

            let listener = null;


            listener =
                this.native.addListener(
                    eventName,
                    googleEvent => {

                        if (
                            listener &&
                            listener.remove
                        ) {

                            listener.remove();
                        }


                        let latlng = null;


                        if (
                            googleEvent &&
                            googleEvent.latLng
                        ) {

                            latlng = {

                                lat:
                                    googleEvent
                                        .latLng
                                        .lat(),

                                lng:
                                    googleEvent
                                        .latLng
                                        .lng()
                            };
                        }


                        callback({

                            latlng,

                            originalEvent:
                                googleEvent
                        });
                    }
                );


            return this;
        }
    }


    // ========================================================
    // GEOSERVER WMS LAYER
    // ========================================================

    class WmsLayer extends Layer {

        constructor(url) {

            super();

            // GeoServer is consumed as a tiled WMS image overlay. The tile
            // bounds are calculated below in Web Mercator (EPSG:3857).
            this.overlay =
                new maps.ImageMapType({

                    tileSize:
                        new maps.Size(
                            256,
                            256
                        ),

                    name:
                        'GeoServer',


                    getTileUrl:
                        (
                            coord,
                            zoom
                        ) => {

                            const n =
                                2 ** zoom;


                            if (
                                coord.y < 0 ||
                                coord.y >= n
                            ) {

                                return '';
                            }


                            const x =

                                (
                                    (
                                        coord.x %
                                        n
                                    ) +
                                    n
                                ) %
                                n;


                            const world =
                                20037508.342789244;


                            const size =
                                (
                                    2 *
                                    world
                                ) /
                                n;


                            const west =
                                x *
                                size -
                                world;


                            const north =
                                world -
                                coord.y *
                                size;


                            return (
                                url +
                                '?' +
                                new URLSearchParams({

                                    bbox: [

                                        west,

                                        north -
                                            size,

                                        west +
                                            size,

                                        north

                                    ].join(','),

                                    width:
                                        256,

                                    height:
                                        256
                                })
                            );
                        }
                });
        }


        setMap(map) {

            if (this.map) {

                const overlays =
                    this.map
                        .overlayMapTypes;


                for (
                    let i =
                        overlays
                            .getLength() -
                        1;

                    i >= 0;

                    i--
                ) {

                    if (
                        overlays
                            .getAt(i) ===
                        this.overlay
                    ) {

                        overlays
                            .removeAt(i);
                    }
                }
            }


            this.map = map;


            if (map) {

                map.overlayMapTypes
                    .push(
                        this.overlay
                    );
            }

            return this;
        }
    }


    // ========================================================
    // MARKER
    // ========================================================

    function marker(
        p,
        options = {}
    ) {

        const layer =
            new Layer();


        const content =
            document.createElement(
                'div'
            );


        content.className =

            (
                options.icon
                    ?.className ||
                ''
            ) +

            ' google-marker';


        content.innerHTML =

            options.icon
                ?.html ||
            '';

        // Marker content is created outside the normal document query used by
        // lucide.createIcons(), so render its data-lucide icon explicitly.
        const iconElement =
            content.querySelector('[data-lucide]');

        if (
            iconElement &&
            window.lucide &&
            typeof window.lucide.createIcons === 'function'
        ) {
            const iconHost =
                document.createElement('span');

            iconHost.appendChild(
                iconElement.cloneNode(true)
            );
            document.body.appendChild(iconHost);
            window.lucide.createIcons();

            const renderedIcon =
                iconHost.firstElementChild;

            if (renderedIcon) {
                content.replaceChildren(
                    renderedIcon
                );
            }

            iconHost.remove();
        }


        const advancedMarker =

            new maps.marker
                .AdvancedMarkerElement({

                    position:
                        position(p),

                    content,

                    gmpClickable:
                        true
                });


        layer.objects.push(
            advancedMarker
        );


        return layer;
    }


    // ========================================================
    // CIRCLE MARKER
    // ========================================================

    function circleMarker(
        p,
        options = {}
    ) {

        const layer =
            new Layer();


        const dot =
            document.createElement(
                'div'
            );


        const radius =
            options.radius ||
            7;


        Object.assign(
            dot.style,
            {

                width:
                    radius *
                    2 +
                    'px',

                height:
                    radius *
                    2 +
                    'px',

                borderRadius:
                    '50%',

                background:
                    options.fillColor ||
                    options.color ||
                    '#117d76',

                border:
                    `${
                        options.weight ||
                        2
                    }px solid ${
                        options.color ||
                        '#fff'
                    }`,

                boxSizing:
                    'border-box'
            }
        );


        const advancedMarker =

            new maps.marker
                .AdvancedMarkerElement({

                    position:
                        position(p),

                    content:
                        dot,

                    gmpClickable:
                        true
                });


        layer.objects.push(
            advancedMarker
        );


        return layer;
    }


    // ========================================================
    // LOAD GOOGLE MAPS
    // ========================================================

    async function load() {

        const key =
            document.body
                .dataset
                .googleMapsKey;


        if (!key) {

            throw new Error(
                'Google Maps is not configured. ' +
                'Add GOOGLE_MAPS_API_KEY to .env ' +
                'and restart ResQGIS.'
            );
        }


        // Prevent loading Google Maps twice.
        if (
            window.google &&
            window.google.maps
        ) {

            maps =
                window.google.maps;

            geocoder =
                new maps.Geocoder();

            return;
        }


        await new Promise(
            (
                resolve,
                reject
            ) => {

                const timer =
                    setTimeout(
                        () => {

                            reject(
                                new Error(
                                    'Google Maps could not load. ' +
                                    'Check your connection and API key.'
                                )
                            );
                        },
                        20000
                    );


                window
                    .resqgisGoogleReady =
                    () => {

                        clearTimeout(
                            timer
                        );

                        resolve();
                    };


                window.gm_authFailure =
                    () => {

                        const banner =
                            document
                                .querySelector(
                                    '#map-error'
                                );


                        const message =
                            'Google Maps authorization failed. ' +
                            'Check the API key, enabled APIs, ' +
                            'application restrictions and billing.';


                        if (banner) {

                            banner.hidden =
                                false;

                            banner.textContent =
                                message;
                        }


                        clearTimeout(
                            timer
                        );


                        reject(
                            new Error(
                                message
                            )
                        );
                    };


                const script =
                    document
                        .createElement(
                            'script'
                        );


                script.src =
                    'https://maps.googleapis.com/maps/api/js?' +

                    new URLSearchParams({

                        key,

                        loading:
                            'async',

                        callback:
                            'resqgisGoogleReady',

                        v:
                            'weekly',

                        libraries:
                            'maps,marker,places,geocoding'
                    });


                script.async =
                    true;


                script.onerror =
                    () => {

                        clearTimeout(
                            timer
                        );


                        reject(
                            new Error(
                                'Unable to download Google Maps. ' +
                                'Check your internet connection.'
                            )
                        );
                    };


                document.head
                    .append(script);
            }
        );


        maps =
            google.maps;


        geocoder =
            new maps.Geocoder();
    }


    // ========================================================
    // REVERSE GEOCODING
    // ========================================================

    async function reverseGeocode(
        p
    ) {

        if (!geocoder) {

            throw new Error(
                'Google Geocoder is not initialized.'
            );
        }


        const {
            results
        } =

            await geocoder.geocode({

                location:
                    position(p)
            });


        return (
            results[0]
                ?.formatted_address ||

            'No address found at these coordinates.'
        );
    }


    // ========================================================
    // GOOGLE PLACES SEARCH
    // ========================================================

    async function installSearch(
        onSelect
    ) {

        const host =
            document.querySelector(
                '#place-search'
            );


        const output =
            document.querySelector(
                '#geocode-result'
            );


        if (!host) {

            console.warn(
                '#place-search was not found.'
            );

            return;
        }


        const autocomplete =

            new maps.places
                .PlaceAutocompleteElement({

                    includedRegionCodes:
                        ['ph'],

                    locationBias: {

                        north:
                            9.2,

                        south:
                            8.5,

                        east:
                            125.9,

                        west:
                            125.3
                    }
                });


        autocomplete
            .setAttribute(

                'placeholder',

                'Search places and landmarks'
            );


        autocomplete
            .setAttribute(

                'aria-label',

                'Search places and landmarks'
            );


        host.append(
            autocomplete
        );


        let requestId =
            0;


        const deliver =
            async (
                p,
                address,
                id
            ) => {

                if (
                    id !==
                    requestId
                ) {

                    return;
                }


                if (output) {

                    output.textContent =
                        address;
                }


                await onSelect(
                    p,
                    address
                );
            };


        autocomplete
            .addEventListener(

                'gmp-select',

                async (
                    {
                        placePrediction
                    }
                ) => {

                    const id =
                        ++requestId;


                    try {

                        const place =
                            placePrediction
                                .toPlace();


                        await place
                            .fetchFields({

                                fields: [

                                    'location',

                                    'formattedAddress',

                                    'displayName'
                                ]
                            });


                        if (
                            !place.location
                        ) {

                            throw new Error(
                                'This place has no map location.'
                            );
                        }


                        await deliver(

                            place.location
                                .toJSON(),

                            place
                                .formattedAddress ||

                            place
                                .displayName,

                            id
                        );

                    } catch (
                        error
                    ) {

                        console.error(
                            'Google Places search failed:',
                            error
                        );


                        if (
                            id ===
                            requestId &&
                            output
                        ) {

                            output.textContent =
                                'Place search failed. ' +
                                'Check Places API (New), billing, ' +
                                'and key restrictions, or choose ' +
                                'a location on the map.';
                        }
                    }
                }
            );


        autocomplete
            .addEventListener(

                'gmp-error',

                () => {

                    if (output) {

                        output.textContent =
                            'Place search is unavailable. ' +
                            'Check Places API (New) and ' +
                            'browser-key restrictions.';
                    }
                }
            );


        const geocodeForm =
            document.querySelector(
                '#geocode-form'
            );


        if (!geocodeForm) {

            return;
        }


        geocodeForm.onsubmit =
            async event => {

                event
                    .preventDefault();


                const id =
                    ++requestId;


                const input =
                    document
                        .querySelector(
                            '#geocode-query'
                        );


                const query =
                    input
                        ?.value
                        ?.trim() ||
                    '';


                const button =
                    event.target
                        .querySelector(
                            'button'
                        );


                if (button) {

                    button.disabled =
                        true;
                }


                try {

                    if (!query) {

                        throw new Error(
                            'Enter a location.'
                        );
                    }


                    const pair =
                        query.match(

                            /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/
                        );


                    let request;


                    if (pair) {

                        const p = {

                            lat:
                                Number(
                                    pair[1]
                                ),

                            lng:
                                Number(
                                    pair[2]
                                )
                        };


                        if (
                            Math.abs(
                                p.lat
                            ) >
                                90 ||

                            Math.abs(
                                p.lng
                            ) >
                                180
                        ) {

                            throw new Error(
                                'Invalid coordinates.'
                            );
                        }


                        request = {

                            location:
                                p
                        };

                    } else {

                        request = {

                            address:
                                query,

                            componentRestrictions: {

                                country:
                                    'PH'
                            },

                            bounds: {

                                north:
                                    9.2,

                                south:
                                    8.5,

                                east:
                                    125.9,

                                west:
                                    125.3
                            }
                        };
                    }


                    const {
                        results
                    } =

                        await geocoder
                            .geocode(
                                request
                            );


                    if (
                        !results.length
                    ) {

                        throw new Error(
                            'No address found.'
                        );
                    }


                    const selectedPosition =

                        request.location ||

                        results[0]
                            .geometry
                            .location
                            .toJSON();


                    await deliver(

                        selectedPosition,

                        results[0]
                            .formatted_address,

                        id
                    );

                } catch (
                    error
                ) {

                    console.error(
                        'Geocoding failed:',
                        error
                    );


                    if (
                        id ===
                        requestId &&
                        output
                    ) {

                        output.textContent =
                            'No location found. ' +
                            'Check the address or coordinates ' +
                            'and confirm that Geocoding API ' +
                            'is enabled.';
                    }

                } finally {

                    if (button) {

                        button.disabled =
                            false;
                    }
                }
            };
    }


    // ========================================================
    // PUBLIC COMPATIBILITY API
    // ========================================================

    return {

        load,

        installSearch,

        reverseGeocode,


        map:
            (
                id,
                options
            ) =>

                new MapView(
                    id,
                    options
                ),


        layerGroup:
            () =>
                new Layer(),


        geoJSON:
            (
                data,
                options
            ) =>

                new GeoLayer(
                    data,
                    options
                ),


        marker,

        circleMarker,


        divIcon:
            options =>
                options,


        polyline:
            (
                coords,
                options
            ) =>

                new GeoLayer(

                    {
                        type:
                            'LineString',

                        coordinates:
                            coords.map(
                                p => [
                                    p[1],
                                    p[0]
                                ]
                            )
                    },

                    {
                        style:
                            options
                    }
                ),


        tileLayer: {

            wms:
                url =>
                    new WmsLayer(
                        url
                    )
        }
    };

})();


// ============================================================
// COMPATIBILITY ALIAS
// ============================================================
// Your existing app.js was originally written using L.*.
// We keep that syntax, but L now points to the Google Maps
// compatibility layer above — NOT Leaflet.
// ============================================================

window.L = window.GIS;