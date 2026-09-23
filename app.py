import functools
import hashlib
import hmac
import io
import json
import math
import os
from pathlib import Path
import secrets
import time

import click
from flask import (
    Flask,
    abort,
    g,
    jsonify,
    render_template,
    request,
    session,
    send_from_directory
)
import psycopg
from psycopg.rows import dict_row
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.exceptions import HTTPException
from dotenv import load_dotenv
import google_services


# ============================================================
# CONFIGURATION
# ============================================================

ROOT = Path(__file__).parent

# Load environment variables from .env
load_dotenv(ROOT / '.env')

FACILITY_TYPES = {
    'hospital',
    'fire_station',
    'police'
}

INCIDENT_TYPES = {
    'flood',
    'fire',
    'accident',
    'medical',
    'other'
}

FACILITY_STATUS = {
    'active',
    'inactive'
}

REPORT_STATUS = {
    'pending',
    'verified',
    'responding',
    'resolved'
}


# ============================================================
# CREATE APPLICATION
# ============================================================

def create_app(test_config=None):

    app = Flask(__name__)

    app.config.update(
        SECRET_KEY=os.environ.get('SECRET_KEY'),
        DATABASE_URL=os.environ.get('DATABASE_URL'),
        MAX_CONTENT_LENGTH=6 * 1024 * 1024,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        SESSION_COOKIE_SECURE=(
            os.environ.get(
                'SESSION_COOKIE_SECURE',
                'false'
            ).lower() == 'true'
        ),
        UPLOAD_FOLDER=str(ROOT / 'instance/uploads')
    )

    if test_config:
        app.config.update(test_config)

    if not app.config['SECRET_KEY']:
        raise RuntimeError(
            'Set SECRET_KEY to a persistent random value before starting.'
        )


    # ========================================================
    # DATABASE
    # ========================================================

    def db():

        if 'db' not in g:

            if not app.config['DATABASE_URL']:
                abort(
                    503,
                    description='The spatial database is not configured.'
                )

            g.db = psycopg.connect(
                app.config['DATABASE_URL'],
                row_factory=dict_row,
                connect_timeout=5
            )

            g.db.execute(
                "SET statement_timeout = '15s'"
            )

        return g.db


    def rows(sql, params=()):
        return db().execute(sql, params).fetchall()


    def one(sql, params=()):
        return db().execute(sql, params).fetchone()


    @app.teardown_appcontext
    def close_db(error=None):

        conn = g.pop('db', None)

        if conn:
            conn.close()


    # ========================================================
    # ADMIN AUTHENTICATION
    # ========================================================

    def admin_required(fn):

        @functools.wraps(fn)
        def wrapped(*args, **kwargs):

            if not session.get('user_id'):
                abort(
                    401,
                    description='Sign in as an administrator to continue.'
                )

            if not one(
                'SELECT id FROM users WHERE id=%s',
                (session['user_id'],)
            ):
                session.clear()
                abort(401)

            return fn(*args, **kwargs)

        return wrapped


    # ========================================================
    # RATE LIMITING
    # ========================================================

    def limit(action, maximum, seconds):

        digest = hmac.new(
            app.secret_key.encode(),
            (request.remote_addr or 'unknown').encode(),
            hashlib.sha256
        ).hexdigest()

        bucket = f'{action}:{digest}'

        hit = one(
            '''
            INSERT INTO rate_limits(bucket)
            VALUES(%s)

            ON CONFLICT(bucket)
            DO UPDATE SET

            hits =
                CASE
                    WHEN rate_limits.started_at <
                         now()-(%s*interval '1 second')
                    THEN 1
                    ELSE rate_limits.hits+1
                END,

            started_at =
                CASE
                    WHEN rate_limits.started_at <
                         now()-(%s*interval '1 second')
                    THEN now()
                    ELSE rate_limits.started_at
                END

            RETURNING hits
            ''',
            (bucket, seconds, seconds)
        )

        db().commit()

        if hit['hits'] > maximum:
            abort(
                429,
                description='Too many attempts. Please try again later.'
            )


    # ========================================================
    # CSRF
    # ========================================================

    @app.before_request
    def csrf_check():

        if request.method in {
            'POST',
            'PATCH',
            'DELETE',
            'PUT'
        }:

            sent = request.headers.get(
                'X-CSRF-Token',
                ''
            )

            if (
                not sent
                or not hmac.compare_digest(
                    sent,
                    session.get('csrf', '')
                )
            ):
                abort(
                    403,
                    description=(
                        'Your session expired. '
                        'Refresh the page and try again.'
                    )
                )


    # ========================================================
    # SECURITY HEADERS
    # ========================================================

    @app.after_request
    def security_headers(response):

        response.headers[
            'X-Content-Type-Options'
        ] = 'nosniff'

        response.headers[
            'Referrer-Policy'
        ] = 'strict-origin-when-cross-origin'

        response.headers[
            'X-Frame-Options'
        ] = 'DENY'

        response.headers[
            'Content-Security-Policy'
        ] = (
            "default-src 'self'; "
            "script-src 'self' https://maps.googleapis.com https://maps.gstatic.com; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob: "
            "https://maps.googleapis.com https://maps.gstatic.com https://*.googleusercontent.com; "
            "connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com https://places.googleapis.com https://routes.googleapis.com; "
            "font-src 'self'; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "frame-ancestors 'none'; "
            "form-action 'self'"
        )

        if request.path.startswith('/api/'):
            response.headers[
                'Cache-Control'
            ] = 'no-store'

        return response


    # ========================================================
    # ERROR HANDLERS
    # ========================================================

    @app.errorhandler(HTTPException)
    def http_error(error):

        return jsonify(
            error=error.description
        ), error.code


    @app.errorhandler(psycopg.Error)
    def db_error(error):

        app.logger.exception(
            'Database operation failed'
        )

        return jsonify(
            error=(
                'The spatial database is temporarily unavailable. '
                'Please try again.'
            )
        ), 503


    # ========================================================
    # INPUT HELPERS
    # ========================================================

    def payload():

        data = request.get_json(
            silent=True
        )

        if not isinstance(data, dict):
            abort(
                400,
                description='Send a valid JSON object.'
            )

        return data


    def text(data, key, minimum=0, maximum=250):

        value = data.get(key, '')

        if (
            not isinstance(value, str)
            or not minimum <= len(value.strip()) <= maximum
        ):
            abort(
                400,
                description=(
                    f'{key.replace("_", " ").capitalize()} '
                    f'must be {minimum}–{maximum} characters.'
                )
            )

        return value.strip()


    def choice(data, key, allowed, default=None):

        value = data.get(
            key,
            default
        )

        if (
            not isinstance(value, str)
            or value not in allowed
        ):
            abort(
                400,
                description=(
                    f'Choose a valid '
                    f'{key.replace("_", " ")}.'
                )
            )

        return value


    def number(data, key, low, high, default=None):

        try:

            value = data.get(
                key,
                default
            )

            if isinstance(value, bool):
                raise ValueError()

            value = float(value)

            if (
                not math.isfinite(value)
                or not low <= value <= high
            ):
                raise ValueError()

        except (ValueError, TypeError):

            abort(
                400,
                description=(
                    f'{key} must be between '
                    f'{low} and {high}.'
                )
            )

        return value


    # ========================================================
    # LOCATION VALIDATION
    # ========================================================

    def location(data):

        lon = number(
            data,
            'longitude',
            -180,
            180
        )

        lat = number(
            data,
            'latitude',
            -90,
            90
        )

        city = one(
            """
            SELECT count(*) AS n
            FROM boundaries
            WHERE kind='city'
            """
        )

        if not city['n']:
            abort(
                503,
                description=(
                    'Import the Butuan boundary '
                    'before selecting locations.'
                )
            )

        inside = one(
            """
            SELECT id
            FROM boundaries
            WHERE kind='city'
            AND ST_Covers(
                geom,
                ST_SetSRID(
                    ST_MakePoint(%s,%s),
                    4326
                )
            )
            LIMIT 1
            """,
            (lon, lat)
        )

        if not inside:
            abort(
                422,
                description=(
                    'Select a location within the '
                    'imported Butuan City boundary.'
                )
            )

        matches = rows(
            """
            SELECT id,name
            FROM boundaries
            WHERE kind='barangay'
            AND ST_Covers(
                geom,
                ST_SetSRID(
                    ST_MakePoint(%s,%s),
                    4326
                )
            )
            ORDER BY name
            """,
            (lon, lat)
        )

        barangay = (
            matches[0]
            if len(matches) == 1
            else None
        )

        return (
            lon,
            lat,
            barangay,
            matches
        )


    # ========================================================
    # AUDIT
    # ========================================================

    def audit(action, record_id):

        db().execute(
            '''
            INSERT INTO audit_log(
                user_id,
                action,
                record_id
            )
            VALUES(%s,%s,%s)
            ''',
            (
                session.get('user_id'),
                action,
                record_id
            )
        )


    # ========================================================
    # GEOJSON
    # ========================================================

    def collection(records):

        features = []

        for record in records:

            record = dict(record)

            geom = record.pop(
                'geometry'
            )

            features.append({
                'type': 'Feature',
                'geometry': geom,
                'properties': record,
                'id': record.get('id')
            })

        return {
            'type': 'FeatureCollection',
            'features': features
        }


    facility_sql = '''
        SELECT
            f.id,
            f.name,
            f.facility_type,
            f.address,
            f.contact_number,
            f.status,
            f.barangay_id,
            b.name AS barangay,
            f.source_url,
            f.location_method,
            ST_AsGeoJSON(f.geom)::json AS geometry

        FROM facilities f

        LEFT JOIN boundaries b
            ON b.id=f.barangay_id
    '''


    # ========================================================
    # HOME
    # ========================================================

    @app.get('/')
    @app.get('/admin')
    def index():

        return render_template(
            'index.html',
            google_maps_api_key=os.environ.get(
                'GOOGLE_MAPS_API_KEY',
                ''
            ),
            google_map_id=os.environ.get(
                'GOOGLE_MAP_ID',
                'DEMO_MAP_ID'
            )
        )


    # ========================================================
    # SESSION
    # ========================================================

    @app.get('/api/session')
    def get_session():

        if 'csrf' not in session:
            session['csrf'] = (
                secrets.token_urlsafe(32)
            )

        return jsonify(
            csrf=session['csrf'],
            admin=bool(
                session.get('user_id')
            ),
            username=session.get(
                'username'
            )
        )


    # ========================================================
    # LOGIN
    # ========================================================

    @app.post('/api/login')
    def login():

        limit(
            'login',
            10,
            900
        )

        data = payload()

        username = text(
            data,
            'username',
            1,
            100
        )

        password = text(
            data,
            'password',
            1,
            250
        )

        user = one(
            '''
            SELECT *
            FROM users
            WHERE username=%s
            ''',
            (username,)
        )

        valid = check_password_hash(
            user['password_hash']
            if user
            else app.config['DUMMY_HASH'],
            password
        )

        if not user or not valid:
            abort(
                401,
                description=(
                    'Username or password '
                    'is incorrect.'
                )
            )

        session.clear()

        session.update(
            user_id=user['id'],
            username=user['username'],
            csrf=secrets.token_urlsafe(32)
        )

        return jsonify(
            csrf=session['csrf'],
            admin=True,
            username=user['username']
        )


    # ========================================================
    # LOGOUT
    # ========================================================

    @app.post('/api/logout')
    def logout():

        session.clear()

        return jsonify(
            ok=True
        )


    # ========================================================
    # HEALTH
    # ========================================================

    @app.get('/api/health')
    def health():

        return jsonify(
            status='ok',
            spatial_database=one(
                '''
                SELECT PostGIS_Version()
                AS version
                '''
            )['version']
        )


    # ========================================================
    # META
    # ========================================================

    @app.get('/api/meta')
    def meta():

        p = ROOT / 'data/provenance.json'

        provenance = (
            json.loads(
                p.read_text(
                    encoding='utf-8'
                )
            )
            if p.exists()
            else {}
        )

        return jsonify(

            barangays=rows(
                """
                SELECT id,name
                FROM boundaries
                WHERE kind='barangay'
                ORDER BY name
                """
            ),

            counts=rows(
                '''
                SELECT
                    facility_type,
                    count(*)::int AS count
                FROM facilities
                WHERE
                    (
                        LEFT(source_id, 7)='google:'
                        OR source_id IS NULL
                    )
                GROUP BY facility_type
                '''
            ),

            boundary_count=one(
                """
                SELECT count(*)::int
                AS count
                FROM boundaries
                WHERE kind='barangay'
                """
            )['count'],

            merged_source_count=one(
                '''
                SELECT count(*)::int
                AS count
                FROM facility_source_aliases
                '''
            )['count'],

            provenance=provenance,

            geoserver_configured=bool(
                os.environ.get(
                    'GEOSERVER_WMS_URL'
                )
                and
                os.environ.get(
                    'GEOSERVER_LAYER'
                )
            )
        )


    # ========================================================
    # BOUNDARIES
    # ========================================================

    # Map data endpoints: the frontend loads these GeoJSON features into the
    # cityLayer and barangayLayer declared in static/app.js.
    @app.get('/api/boundaries')
    def boundaries():

        return collection(
            rows(
                '''
                SELECT
                    id,
                    name,
                    kind,
                    source_url,
                    ST_AsGeoJSON(geom)::json
                    AS geometry
                FROM boundaries
                '''
            )
        )


    # ========================================================
    # FACILITIES
    # ========================================================

    # Facility endpoint: returns the records used by loadFacilities() and
    # renderFacilityMarkers() for the left list and map markers.
    @app.get('/api/facilities')
    def facilities():

        conditions = [
            "f.facility_type IN ('hospital','fire_station','police')",
            "(LEFT(f.source_id, 7)='google:' OR f.source_id IS NULL)"
        ]
        params = []

        if request.args.get('q'):

            conditions.append(
                '''
                (
                    f.name ILIKE %s
                    OR f.address ILIKE %s
                )
                '''
            )

            params.extend(
                [
                    '%' + request.args[
                        'q'
                    ][:200] + '%'
                ] * 2
            )

        for key in [
            'facility_type',
            'status',
            'barangay_id'
        ]:

            if request.args.get(key):

                value = request.args[key]

                if key == 'barangay_id':

                    value = int(
                        number(
                            request.args,
                            key,
                            1,
                            1e10
                        )
                    )

                elif key == 'facility_type':

                    value = choice(
                        request.args,
                        key,
                        FACILITY_TYPES
                    )

                else:

                    value = choice(
                        request.args,
                        key,
                        FACILITY_STATUS
                    )

                # Google Places records may not have a persisted barangay_id.
                # Fall back to PostGIS containment so the UI filter still
                # works from the authoritative facility coordinates.
                if key == 'barangay_id':

                    conditions.append(
                        '''
                        (
                            f.barangay_id=%s
                            OR EXISTS (
                                SELECT 1
                                FROM boundaries selected_barangay
                                WHERE
                                    selected_barangay.id=%s
                                    AND selected_barangay.kind='barangay'
                                    AND ST_Covers(
                                        selected_barangay.geom,
                                        f.geom
                                    )
                            )
                        )
                        '''
                    )

                    params.extend(
                        [value, value]
                    )

                    continue

                conditions.append(
                    'f.' + key + '=%s'
                )

                params.append(value)

        return collection(
            rows(
                facility_sql
                + ' WHERE '
                + ' AND '.join(
                    conditions
                )
                + ' ORDER BY f.name',
                params
            )
        )


    # ========================================================
    # DETECT LOCATION
    # ========================================================

    @app.post('/api/location')
    def detect_location():

        lon, lat, barangay, matches = (
            location(
                payload()
            )
        )

        return jsonify(
            longitude=lon,
            latitude=lat,
            barangay=barangay,
            candidates=matches,
            ambiguous=len(matches) > 1,

            message=(
                barangay['name']
                if barangay
                else (
                    'On a shared boundary; '
                    'review the location.'
                    if matches
                    else
                    'No barangay polygon available '
                    'for this location.'
                )
            )
        )


    # ========================================================
    # FACILITY VALUES
    # ========================================================

    def facility_values(data):

        name = text(
            data,
            'name',
            2,
            200
        )

        kind = choice(
            data,
            'facility_type',
            FACILITY_TYPES
        )

        status = choice(
            data,
            'status',
            FACILITY_STATUS,
            'active'
        )

        address = text(
            data,
            'address',
            0,
            500
        )

        contact = text(
            data,
            'contact_number',
            0,
            100
        )

        lon, lat, barangay, _ = (
            location(data)
        )

        return (
            name,
            kind,
            address,
            contact,
            status,
            barangay['id']
            if barangay
            else None,
            lon,
            lat
        )


    # ========================================================
    # ADD FACILITY
    # ========================================================

    @app.post('/api/facilities')
    @admin_required
    def add_facility():

        data = payload()

        vals = facility_values(
            data
        )

        row = one(
            '''
            INSERT INTO facilities(
                name,
                facility_type,
                address,
                contact_number,
                status,
                barangay_id,
                geom
            )
            VALUES(
                %s,%s,%s,%s,%s,%s,
                ST_SetSRID(
                    ST_MakePoint(%s,%s),
                    4326
                )
            )
            RETURNING id
            ''',
            vals
        )

        audit(
            'facility.create',
            row['id']
        )

        db().commit()

        return jsonify(row), 201


    # ========================================================
    # UPDATE FACILITY
    # ========================================================

    @app.patch(
        '/api/facilities/<int:fid>'
    )
    @admin_required
    def update_facility(fid):

        vals = facility_values(
            payload()
        )

        row = one(
            '''
            UPDATE facilities

            SET
                name=%s,
                facility_type=%s,
                address=%s,
                contact_number=%s,
                status=%s,
                barangay_id=%s,

                geom=ST_SetSRID(
                    ST_MakePoint(%s,%s),
                    4326
                ),

                location_method=
                    'admin map selection',

                updated_at=now()

            WHERE id=%s

            RETURNING id
            ''',
            (*vals, fid)
        )

        if not row:
            abort(
                404,
                description='Facility not found.'
            )

        audit(
            'facility.update',
            fid
        )

        db().commit()

        return jsonify(row)


    # ========================================================
    # DELETE FACILITY
    # ========================================================

    @app.delete(
        '/api/facilities/<int:fid>'
    )
    @admin_required
    def delete_facility(fid):

        if not one(
            '''
            DELETE FROM facilities
            WHERE id=%s
            RETURNING id
            ''',
            (fid,)
        ):
            abort(404)

        audit(
            'facility.delete',
            fid
        )

        db().commit()

        return jsonify(
            ok=True
        )


    # ========================================================
    # INCIDENTS
    # ========================================================

    # Incident endpoint: supplies the verified records rendered into
    # incidentLayer on the frontend.
    @app.get('/api/incidents')
    def incidents():

        admin = (
            request.args.get(
                'admin'
            ) == '1'
        )

        if (
            admin
            and not session.get(
                'user_id'
            )
        ):
            abort(401)

        condition = (
            'true'
            if admin
            else
            "r.status IN "
            "('verified','responding')"
        )

        return collection(
            rows(
                '''
                SELECT
                    r.id,
                    r.incident_type,
                    r.description,
                    r.status,
                    b.name AS barangay,
                    r.reported_at,

                    ST_AsGeoJSON(
                        r.geom
                    )::json AS geometry,

                    (
                        r.photo_path
                        IS NOT NULL
                    ) AS has_photo

                FROM incident_reports r

                LEFT JOIN boundaries b
                    ON r.barangay_id=b.id

                WHERE
                '''
                + condition +
                '''
                ORDER BY
                    reported_at DESC

                LIMIT 500
                '''
            )
        )


    # ========================================================
    # REPORT INCIDENT
    # ========================================================

    @app.post('/api/incidents')
    def report_incident():

        limit(
            'report',
            5,
            3600
        )

        data = (
            request.form.to_dict()
            if request.mimetype
            == 'multipart/form-data'
            else payload()
        )

        kind = choice(
            data,
            'incident_type',
            INCIDENT_TYPES
        )

        description = text(
            data,
            'description',
            10,
            2000
        )

        lon, lat, barangay, _ = (
            location(data)
        )

        photo_path = None

        if (
            'photo' in request.files
            and request.files[
                'photo'
            ].filename
        ):

            from PIL import (
                Image,
                UnidentifiedImageError
            )

            upload = request.files[
                'photo'
            ]

            raw = upload.read(
                5 * 1024 * 1024 + 1
            )

            if (
                len(raw)
                > 5 * 1024 * 1024
            ):
                abort(
                    413,
                    description=(
                        'Photo must be '
                        'smaller than 5 MB.'
                    )
                )

            try:

                with Image.open(
                    io.BytesIO(raw)
                ) as image:

                    if (
                        image.width
                        * image.height
                        > 20_000_000
                    ):
                        abort(
                            400,
                            description=(
                                'Photo dimensions '
                                'are too large.'
                            )
                        )

                    image.load()

                    image.thumbnail(
                        (1600, 1600)
                    )

                    photo_path = (
                        secrets.token_hex(
                            20
                        )
                        + '.jpg'
                    )

                    folder = Path(
                        app.config[
                            'UPLOAD_FOLDER'
                        ]
                    )

                    folder.mkdir(
                        parents=True,
                        exist_ok=True
                    )

                    image.convert(
                        'RGB'
                    ).save(
                        folder / photo_path,
                        'JPEG',
                        quality=85
                    )

            except (
                UnidentifiedImageError,
                OSError,
                Image.DecompressionBombError
            ):

                abort(
                    400,
                    description=(
                        'Choose a valid JPG, '
                        'PNG, or WebP image.'
                    )
                )

        try:

            row = one(
                '''
                INSERT INTO incident_reports(
                    incident_type,
                    description,
                    barangay_id,
                    geom,
                    photo_path
                )

                VALUES(
                    %s,
                    %s,
                    %s,

                    ST_SetSRID(
                        ST_MakePoint(%s,%s),
                        4326
                    ),

                    %s
                )

                RETURNING
                    id,
                    status
                ''',

                (
                    kind,
                    description,

                    barangay['id']
                    if barangay
                    else None,

                    lon,
                    lat,
                    photo_path
                )
            )

            db().commit()

        except Exception:

            if photo_path:

                (
                    Path(
                        app.config[
                            'UPLOAD_FOLDER'
                        ]
                    )
                    / photo_path
                ).unlink(
                    missing_ok=True
                )

            raise

        return jsonify(
            **row,
            message=(
                'Report received for review. '
                'It is not yet visible on '
                'the public map.'
            )
        ), 201


    # ========================================================
    # INCIDENT PHOTO
    # ========================================================

    @app.get(
        '/api/incidents/<int:rid>/photo'
    )
    @admin_required
    def photo(rid):

        row = one(
            '''
            SELECT photo_path
            FROM incident_reports
            WHERE id=%s
            ''',
            (rid,)
        )

        if (
            not row
            or not row['photo_path']
        ):
            abort(404)

        return send_from_directory(
            app.config[
                'UPLOAD_FOLDER'
            ],
            row['photo_path']
        )


    # ========================================================
    # UPDATE INCIDENT
    # ========================================================

    @app.patch(
        '/api/incidents/<int:rid>'
    )
    @admin_required
    def update_report(rid):

        status = choice(
            payload(),
            'status',
            REPORT_STATUS
        )

        row = one(
            '''
            UPDATE incident_reports

            SET
                status=%s,
                updated_at=now()

            WHERE id=%s

            RETURNING
                id,
                status
            ''',
            (
                status,
                rid
            )
        )

        if not row:
            abort(404)

        audit(
            'incident.' + status,
            rid
        )

        db().commit()

        return jsonify(row)


    # ========================================================
    # ADMIN STATS
    # ========================================================

    @app.get('/api/admin/stats')
    @admin_required
    def stats():

        return jsonify(

            facilities=rows(
                '''
                SELECT
                    facility_type,
                    count(*)::int AS count
                FROM facilities
                WHERE
                    (
                        LEFT(source_id, 7)='google:'
                        OR source_id IS NULL
                    )
                GROUP BY facility_type
                '''
            ),

            incidents=rows(
                '''
                SELECT
                    status,
                    count(*)::int AS count
                FROM incident_reports
                GROUP BY status
                '''
            )
        )


    # ========================================================
    # NEAREST FACILITY ANALYSIS
    # ========================================================

    # Analysis endpoints return route, buffer, and accessibility data that
    # app.js draws into analysisLayer.
    @app.post('/api/analysis/nearest')
    def nearest():

        data = payload()

        lon, lat, _, _ = (
            location(data)
        )

        kind = data.get('facility_type', 'hospital')
        if kind != 'all' and kind not in FACILITY_TYPES:
            abort(400, description='Invalid facility type.')

        count = int(
            number(
                data,
                'count',
                1,
                10,
                3
            )
        )

        statuses = ['active']

        candidates = rows(
            '''
            SELECT
                f.id,
                f.name,
                f.facility_type,
                f.status,
                b.name AS barangay,

                ST_AsGeoJSON(
                    f.geom
                )::json AS geometry,

                ST_Distance(
                    f.geom::geography,

                    ST_SetSRID(
                        ST_MakePoint(%s,%s),
                        4326
                    )::geography

                ) AS distance_m

            FROM facilities f

            LEFT JOIN boundaries b
                ON b.id=f.barangay_id

            WHERE
                f.facility_type=%s
                AND f.status=ANY(%s)
                AND (
                    LEFT(f.source_id, 7)='google:'
                    OR f.source_id IS NULL
                )

            ORDER BY
                distance_m,
                f.id

            LIMIT %s
            ''',

            (
                lon,
                lat,
                kind,
                statuses,
                count
            )
        )

        if not candidates:
            return jsonify(
                **collection([]),
                method=(
                    'Google Routes driving distance and '
                    'GeoJSON route geometry'
                )
            )

        key = os.environ.get(
            'GOOGLE_MAPS_API_KEY',
            ''
        )

        if not key:
            abort(
                503,
                description=(
                    'Google Maps is not configured for '
                    'driving routes.'
                )
            )

        routed = []

        for candidate in candidates:
            candidate = dict(candidate)
            point = candidate['geometry']
            dest_lon, dest_lat = point['coordinates']

            try:
                route = google_services.compute_route(
                    key,
                    lon,
                    lat,
                    dest_lon,
                    dest_lat
                )
            except google_services.GoogleRoutesError as error:
                abort(
                    error.status,
                    description=str(error)
                )

            if route is None:
                candidate['road_distance_m'] = None
                candidate['road_duration_s'] = None
                candidate['road_route_available'] = False
            else:
                distance, duration, geometry = route
                candidate['geometry'] = geometry
                candidate['road_distance_m'] = distance
                candidate['road_duration_s'] = duration
                candidate['road_route_available'] = True

            routed.append(candidate)

        routed.sort(
            key=lambda item: (
                item['road_distance_m'] is None,
                item['road_distance_m']
                if item['road_distance_m'] is not None
                else float('inf'),
                item['id']
            )
        )

        return jsonify(
            **collection(routed),

            method=(
                'Google Routes driving distance and '
                'GeoJSON route geometry'
            )
        )


    # ========================================================
    # COVERAGE ANALYSIS
    # ========================================================

    @app.post('/api/analysis/coverage')
    def coverage():

        data = payload()

        kind = data.get('facility_type', 'hospital')
        if kind != 'all' and kind not in FACILITY_TYPES:
            abort(400, description='Invalid facility type.')

        radius = (
            number(
                data,
                'radius_km',
                0.25,
                10,
                3
            )
            * 1000
        )

        statuses = ['active']

        return jsonify(

            **collection(
                rows(
                    '''
                    SELECT
                        id,
                        name,
                        status,

                        ST_AsGeoJSON(
                            ST_Buffer(
                                geom::geography,
                                %s
                            )::geometry
                        )::json
                        AS geometry

                    FROM facilities

                    WHERE
                        (%s='all' OR facility_type=%s)
                        AND status=ANY(%s)
                        AND (
                            LEFT(source_id, 7)='google:'
                            OR source_id IS NULL
                        )

                    ORDER BY id
                    ''',

                    (
                        radius,
                        kind,
                        kind,
                        statuses
                    )
                )
            ),

            radius_m=radius,

            method=(
                'PostGIS geography buffer; '
                'proximity only, not a '
                'travel-time or safety zone'
            )
        )


    # ========================================================
    # ACCESSIBILITY ANALYSIS
    # ========================================================

    @app.post(
        '/api/analysis/accessibility'
    )
    def accessibility():

        data = payload()

        kind = data.get('facility_type', 'hospital')
        if kind != 'all' and kind not in FACILITY_TYPES:
            abort(400, description='Invalid facility type.')

        radius = (
            number(
                data,
                'radius_km',
                0.25,
                10,
                3
            )
            * 1000
        )

        statuses = ['active']

        result = rows(
            '''
            SELECT
                b.id,
                b.name,
                ST_AsGeoJSON(b.geom)::json AS geometry,
                nearest.name AS nearest_facility,
                nearest.facility_type AS nearest_facility_type,
                nearest.distance_m AS nearest_m,
                CASE
                    WHEN nearest.distance_m IS NOT NULL
                         AND nearest.distance_m <= %s
                    THEN 100.0
                    WHEN nearest.distance_m IS NOT NULL
                    THEN 0.0
                    ELSE NULL
                END AS covered_percent

            FROM boundaries b

            LEFT JOIN LATERAL (
                SELECT
                    f.name,
                    f.facility_type,
                    -- Accessibility uses a consistent interior representative
                    -- point for each barangay, not road or polygon-edge distance.
                    ST_Distance(
                        f.geom::geography,
                        ST_PointOnSurface(b.geom)::geography
                    ) AS distance_m

                FROM facilities f

                WHERE
                    (%s='all' OR f.facility_type=%s)
                    AND f.status=ANY(%s)
                    AND (
                        LEFT(f.source_id, 7)='google:'
                        OR f.source_id IS NULL
                    )
                    AND f.geom IS NOT NULL

                ORDER BY distance_m, f.id
                LIMIT 1
            ) nearest ON TRUE

            WHERE
                b.kind='barangay'

            ORDER BY b.name
            ''',
            (
                radius,
                kind,
                kind,
                statuses
            )
        )

        return jsonify(

            results=result,

            maximum_distance_m=radius,
            method=(
                'Distance from each barangay polygon interior '
                'representative point to its nearest active '
                'selected facility; not a travel-time or '
                'capacity measure.'
            )
        )


    # ========================================================
    # GEOSERVER WMS PROXY
    # ========================================================

    # GeoServer endpoint: proxies WMS tile requests so the browser can use a
    # same-origin URL while the configured server/layer stays in .env.
    @app.get('/api/geoserver')
    def geoserver():

        import requests as http

        endpoint = os.environ.get(
            'GEOSERVER_WMS_URL'
        )

        layer = os.environ.get(
            'GEOSERVER_LAYER'
        )

        if not endpoint or not layer:

            abort(
                503,
                description=(
                    'GeoServer has not '
                    'been configured.'
                )
            )

        bounds = request.args.get(
            'bbox',
            ''
        ).split(',')

        if len(bounds) != 4:
            abort(400)

        try:

            if not all(
                math.isfinite(
                    float(x)
                )
                for x in bounds
            ):
                abort(400)

        except ValueError:
            abort(400)

        width = int(
            number(
                request.args,
                'width',
                1,
                1024,
                256
            )
        )

        height = int(
            number(
                request.args,
                'height',
                1,
                1024,
                256
            )
        )

        try:

            result = http.get(

                endpoint,

                params={
                    'service': 'WMS',
                    'request': 'GetMap',
                    'version': '1.1.1',

                    'layers': layer,

                    'styles': '',

                    'format':
                        'image/png',

                    'transparent':
                        'true',

                    'srs':
                        'EPSG:3857',

                    'bbox':
                        ','.join(bounds),

                    'width':
                        width,

                    'height':
                        height
                },

                timeout=15
            )

            result.raise_for_status()

            if not result.headers.get(
                'content-type',
                ''
            ).startswith('image/'):

                abort(502)

            return app.response_class(
                result.content,
                mimetype='image/png'
            )

        except http.RequestException:

            abort(
                502,
                description=(
                    'The GIS layer is '
                    'temporarily unavailable.'
                )
            )


    # ========================================================
    # FLASK CLI
    # ========================================================

    @app.cli.command('init-db')
    def init_db():

        db().execute(
            (
                ROOT /
                'schema.sql'
            ).read_text()
        )

        db().commit()

        click.echo(
            'Schema ready.'
        )


    @app.cli.command('create-admin')
    @click.option(
        '--username',
        prompt=True
    )
    @click.option(
        '--password',
        prompt=True,
        hide_input=True,
        confirmation_prompt=True
    )
    def create_admin(
        username,
        password
    ):

        if len(password) < 12:

            raise click.ClickException(
                'Use at least 12 characters.'
            )

        db().execute(
            '''
            INSERT INTO users(
                username,
                password_hash
            )
            VALUES(%s,%s)
            ''',

            (
                username,
                generate_password_hash(
                    password
                )
            )
        )

        db().commit()

        click.echo(
            'Administrator created.'
        )


    @app.cli.command('import-osm')
    def import_osm():

        from import_data import run

        run(
            db()
        )

        click.echo(
            'PSA/GeoRisk boundaries and legacy source data imported.'
        )


    @app.cli.command('import-google-places')
    def import_google_places():

        from google_places import import_places

        key = os.environ.get(
            'GOOGLE_MAPS_API_KEY',
            ''
        )

        if not key:
            raise click.ClickException(
                'Set GOOGLE_MAPS_API_KEY before importing Google Places.'
            )

        imported = import_places(
            db(),
            key
        )
        db().commit()

        click.echo(
            f'Imported or updated {imported} Google Places facilities.'
        )


    # Dummy password hash used during failed login attempts
    app.config[
        'DUMMY_HASH'
    ] = generate_password_hash(
        secrets.token_urlsafe(20)
    )

    return app


# ============================================================
# RUN DIRECTLY
# ============================================================

if __name__ == '__main__':

    from waitress import serve

    serve(
        create_app(),
        host='127.0.0.1',
        port=int(
            os.environ.get(
                'PORT',
                '8000'
            )
        )
    )