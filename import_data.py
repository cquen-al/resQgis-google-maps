"""
Butuan ResQGIS Spatial Data Importer

Sources:
- Barangay boundaries: GeoRiskPH / PSA GeoJSON
- Emergency facilities: OpenStreetMap
- City boundary: generated from barangay polygons

Requires:
- PostgreSQL
- PostGIS
- psycopg
"""

import json
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv

load_dotenv()


# ============================================================
# DATA DIRECTORY
# ============================================================

DATA = Path(__file__).parent / "data"


# ============================================================
# IMPORT BARANGAY BOUNDARIES
# ============================================================

def import_barangays(conn):

    print()
    print("Importing GeoRiskPH/PSA barangay boundaries...")

    file_path = DATA / "butuan_barangays.geojson"

    if not file_path.exists():
        raise FileNotFoundError(
            f"Missing data file: {file_path}"
        )

    data = json.loads(
        file_path.read_text(encoding="utf-8")
    )

    features = data.get("features", [])

    if not features:
        raise ValueError(
            "No features found in butuan_barangays.geojson"
        )

    # --------------------------------------------------------
    # Remove old boundary data
    # --------------------------------------------------------

    # Remove existing barangay assignments first so old
    # boundary IDs are not referenced.
    conn.execute(
        """
        UPDATE facilities
        SET barangay_id = NULL
        """
    )

    conn.execute(
        """
        UPDATE incident_reports
        SET barangay_id = NULL
        """
    )

    # Remove old city/barangay boundary records.
    conn.execute(
        """
        DELETE FROM boundaries
        WHERE kind IN ('city', 'barangay')
        """
    )

    imported = 0

    # --------------------------------------------------------
    # Import GeoRiskPH / PSA polygons
    # --------------------------------------------------------

    for feature in features:

        properties = feature.get("properties", {})
        geometry = feature.get("geometry")

        if not geometry:
            continue

        brgy_name = properties.get("brgy_name")
        brgy_code = properties.get("brgy_code")
        city_name = properties.get("city_name")

        # Safety check: only import Butuan City records.
        if not city_name or "butuan" not in city_name.lower():
            continue

        if not brgy_name:
            continue

        if not brgy_code:
            raise ValueError(
                f"Missing barangay code for {brgy_name}"
            )

        source_id = f"psa_barangay/{brgy_code}"

        conn.execute(
            """
            INSERT INTO boundaries(
                source_id,
                name,
                kind,
                source_url,
                geom
            )
            VALUES(
                %s,
                %s,
                'barangay',
                %s,

                ST_Multi(
                    ST_CollectionExtract(
                        ST_MakeValid(
                            ST_SetSRID(
                                ST_GeomFromGeoJSON(%s),
                                4326
                            )
                        ),
                        3
                    )
                )
            )

            ON CONFLICT(source_id)
            DO UPDATE SET
                name = EXCLUDED.name,
                kind = EXCLUDED.kind,
                source_url = EXCLUDED.source_url,
                geom = EXCLUDED.geom
            """,
            (
                source_id,
                brgy_name,
                (
                    "GeoRiskPH / PSA "
                    "Barangay Boundary"
                ),
                json.dumps(geometry),
            ),
        )

        imported += 1

    if imported == 0:
        raise RuntimeError(
            "No Butuan barangay boundaries were imported."
        )

    print(
        f"Imported {imported} "
        "Butuan barangay boundaries."
    )


# ============================================================
# GENERATE BUTUAN CITY BOUNDARY
# ============================================================

def generate_city_boundary(conn):

    print("Generating Butuan City boundary...")

    # Instead of relying on a second boundary dataset,
    # dissolve all barangay polygons into one city polygon.

    conn.execute(
        """
        INSERT INTO boundaries(
            source_id,
            name,
            kind,
            source_url,
            geom
        )

        SELECT
            'generated/butuan-city',
            'Butuan City',
            'city',
            'Derived from GeoRiskPH / PSA barangay boundaries',

            ST_Multi(
                ST_CollectionExtract(
                    ST_MakeValid(
                        ST_UnaryUnion(
                            ST_Collect(geom)
                        )
                    ),
                    3
                )
            )

        FROM boundaries

        WHERE kind = 'barangay'

        HAVING COUNT(*) > 0

        ON CONFLICT(source_id)
        DO UPDATE SET
            name = EXCLUDED.name,
            kind = EXCLUDED.kind,
            source_url = EXCLUDED.source_url,
            geom = EXCLUDED.geom
        """
    )

    print("Butuan City boundary generated.")


# ============================================================
# IMPORT EMERGENCY FACILITIES
# ============================================================

def import_facilities(conn):

    print()
    print("Importing OpenStreetMap emergency facilities...")

    facility_file = DATA / "osm_facilities.json"

    if not facility_file.exists():
        raise FileNotFoundError(
            f"Missing data file: {facility_file}"
        )

    facility_data = json.loads(
        facility_file.read_text(encoding="utf-8")
    )

    imported = 0
    skipped = 0

    for element in facility_data.get("elements", []):

        tags = element.get("tags", {})

        amenity = tags.get("amenity")

        # ----------------------------------------------------
        # Only emergency facilities required by ResQGIS
        # ----------------------------------------------------

        if amenity not in (
            "hospital",
            "fire_station",
            "police",
        ):
            continue

        # OSM nodes have lat/lon directly.
        # Ways/relations generally have center coordinates
        # in our Overpass result.
        point = element.get("center", element)

        if "lon" not in point or "lat" not in point:
            skipped += 1
            continue

        lon = point["lon"]
        lat = point["lat"]

        source_id = (
            f'{element["type"]}/{element["id"]}'
        )

        # ----------------------------------------------------
        # Already imported?
        # ----------------------------------------------------

        existing = conn.execute(
            """
            SELECT id
            FROM facilities
            WHERE source_id = %s
            """,
            (source_id,),
        ).fetchone()

        if existing:
            continue

        # ----------------------------------------------------
        # Facility must be inside Butuan City
        # ----------------------------------------------------

        inside_butuan = conn.execute(
            """
            SELECT EXISTS(

                SELECT 1

                FROM boundaries

                WHERE kind = 'city'

                AND ST_Covers(
                    geom,

                    ST_SetSRID(
                        ST_MakePoint(%s, %s),
                        4326
                    )
                )
            ) AS inside
            """,
            (
                lon,
                lat,
            ),
        ).fetchone()

        if not inside_butuan["inside"]:
            skipped += 1
            continue

        # ----------------------------------------------------
        # Detect near-duplicate facilities
        # ----------------------------------------------------

        if tags.get("name"):

            duplicate = conn.execute(
                """
                SELECT id

                FROM facilities

                WHERE
                    lower(trim(name)) =
                    lower(trim(%s))

                AND facility_type = %s

                AND ST_DWithin(
                    geom::geography,

                    ST_SetSRID(
                        ST_MakePoint(%s, %s),
                        4326
                    )::geography,

                    20
                )

                ORDER BY id

                LIMIT 1
                """,
                (
                    tags["name"],
                    amenity,
                    lon,
                    lat,
                ),
            ).fetchone()

            if duplicate:

                conn.execute(
                    """
                    INSERT INTO facility_source_aliases(
                        source_id,
                        facility_id,
                        source_url,
                        reason
                    )

                    VALUES(
                        %s,
                        %s,
                        %s,
                        %s
                    )

                    ON CONFLICT(source_id)
                    DO NOTHING
                    """,
                    (
                        source_id,
                        duplicate["id"],
                        (
                            "https://www.openstreetmap.org/"
                            + source_id
                        ),
                        (
                            "Same normalized name and "
                            "facility type within 20 m."
                        ),
                    ),
                )

                continue

        # ----------------------------------------------------
        # Build facility address
        # ----------------------------------------------------

        address = ", ".join(
            tags[key]
            for key in [
                "addr:housenumber",
                "addr:street",
                "addr:suburb",
                "addr:city",
            ]
            if key in tags
        )

        # ----------------------------------------------------
        # Insert facility
        # ----------------------------------------------------

        row = conn.execute(
            """
            INSERT INTO facilities(
                name,
                facility_type,
                address,
                contact_number,
                geom,
                source_id,
                source_url,
                location_method
            )

            VALUES(
                %s,
                %s,
                %s,
                %s,

                ST_SetSRID(
                    ST_MakePoint(%s, %s),
                    4326
                ),

                %s,
                %s,
                %s
            )

            ON CONFLICT(source_id)
            DO NOTHING

            RETURNING id
            """,
            (
                tags.get("name")
                or (
                    "Unnamed "
                    + amenity.replace("_", " ")
                ),

                amenity,

                address,

                tags.get(
                    "contact:phone",
                    tags.get("phone", ""),
                ),

                lon,
                lat,

                source_id,

                (
                    "https://www.openstreetmap.org/"
                    + source_id
                ),

                (
                    "OSM node"
                    if element["type"] == "node"
                    else "OSM bounding-box center"
                ),
            ),
        ).fetchone()

        if row:
            imported += 1

    print(
        f"Imported {imported} new emergency facilities."
    )

    if skipped:
        print(
            f"Skipped {skipped} facilities "
            "without valid Butuan coordinates."
        )


# ============================================================
# AUTOMATIC BARANGAY ASSIGNMENT
# ============================================================

def assign_barangays(conn):

    print()
    print("Assigning barangays automatically...")

    for table in (
        "facilities",
        "incident_reports",
    ):

        conn.execute(
            f"""
            UPDATE {table} AS f

            SET barangay_id = (

                SELECT MIN(b.id)

                FROM boundaries AS b

                WHERE
                    b.kind = 'barangay'

                AND ST_Covers(
                    b.geom,
                    f.geom
                )

                HAVING COUNT(*) = 1
            )
            """
        )

    print("Barangay assignment completed.")


# ============================================================
# VERIFY IMPORT
# ============================================================

def verify_import(conn):

    print()
    print("Verifying spatial data...")

    barangays = conn.execute(
        """
        SELECT COUNT(*) AS total
        FROM boundaries
        WHERE kind = 'barangay'
        """
    ).fetchone()["total"]

    cities = conn.execute(
        """
        SELECT COUNT(*) AS total
        FROM boundaries
        WHERE kind = 'city'
        """
    ).fetchone()["total"]

    facilities = conn.execute(
        """
        SELECT COUNT(*) AS total
        FROM facilities
        """
    ).fetchone()["total"]

    assigned_facilities = conn.execute(
        """
        SELECT COUNT(*) AS total
        FROM facilities
        WHERE barangay_id IS NOT NULL
        """
    ).fetchone()["total"]

    print("----------------------------------")
    print(f"Barangays:            {barangays}")
    print(f"City boundaries:      {cities}")
    print(f"Facilities:           {facilities}")
    print(
        "Facilities assigned: "
        f"{assigned_facilities}"
    )
    print("----------------------------------")

    if barangays == 0:
        raise RuntimeError(
            "Barangay import verification failed."
        )

    if cities != 1:
        raise RuntimeError(
            "Expected exactly one Butuan City boundary."
        )


# ============================================================
# MAIN IMPORT PROCESS
# ============================================================

def run(conn):

    conn.row_factory = dict_row

    print()
    print("Starting spatial data import...")

    # 1. Official barangay polygons
    import_barangays(conn)

    # 2. Derive Butuan City polygon
    generate_city_boundary(conn)

    # 3. OSM emergency facilities
    import_facilities(conn)

    # 4. Determine barangay for every point
    assign_barangays(conn)

    # 5. Verify
    verify_import(conn)

    conn.commit()

    print()
    print("Spatial data successfully committed.")


# ============================================================
# RUN IMPORTER
# ============================================================

if __name__ == "__main__":

    database_url = os.environ.get(
        "DATABASE_URL"
    )

    if not database_url:
        raise RuntimeError(
            "DATABASE_URL environment variable is not set."
        )

    print("=" * 60)
    print("Butuan ResQGIS - Spatial Data Import")
    print("=" * 60)

    print("Connecting to PostgreSQL/PostGIS...")

    try:

        with psycopg.connect(
            database_url
        ) as conn:

            print("Database connection successful.")

            run(conn)

        print()
        print("=" * 60)
        print("GIS DATA IMPORT COMPLETED SUCCESSFULLY")
        print("=" * 60)

    except Exception as error:

        print()
        print("=" * 60)
        print("GIS DATA IMPORT FAILED")
        print("=" * 60)

        print(
            f"{type(error).__name__}: {error}"
        )

        print("=" * 60)

        raise