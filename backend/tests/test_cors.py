"""CORS policy for native app shells and the hosted web client."""

from app.main import NATIVE_AND_WEB_ORIGINS, app
from fastapi.testclient import TestClient


def test_native_and_production_origins_receive_credentialed_cors_headers():
    with TestClient(app) as client:
        for origin in NATIVE_AND_WEB_ORIGINS:
            response = client.options(
                "/api/status",
                headers={
                    "Origin": origin,
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "content-type",
                },
            )

            assert response.status_code == 200
            assert response.headers["access-control-allow-origin"] == origin
            assert response.headers["access-control-allow-credentials"] == "true"
            assert "GET" in response.headers["access-control-allow-methods"]
            assert "content-type" in response.headers[
                "access-control-allow-headers"
            ].lower()


def test_untrusted_origin_is_not_granted_cors_access():
    with TestClient(app) as client:
        response = client.options(
            "/api/status",
            headers={
                "Origin": "https://attacker.example",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_localhost_with_an_unlisted_port_is_not_granted_cors_access():
    with TestClient(app) as client:
        response = client.get(
            "/api/status",
            headers={"Origin": "http://localhost:3000"},
        )

    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
