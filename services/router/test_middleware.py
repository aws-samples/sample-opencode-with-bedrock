"""Tests for router middleware: api_key_auth, version_gate, request_logging."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_request(
    *,
    path="/v1/chat/completions",
    method="POST",
    headers=None,
    match_info=None,
):
    """Build a mock aiohttp request for middleware tests."""
    req = MagicMock()
    req.path = path
    req.method = method
    req.headers = headers or {}
    req.match_info = match_info or {}
    # Support request[key] = value style (aiohttp MutableMapping)
    _store = {}
    req.__setitem__ = MagicMock(side_effect=lambda k, v: _store.__setitem__(k, v))
    req.__getitem__ = MagicMock(side_effect=lambda k: _store[k])
    req.get = MagicMock(side_effect=lambda k, d=None: _store.get(k, d))
    return req


def _run(coro):
    """Run an async coroutine synchronously."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _json_body(response):
    """Extract the JSON body from an aiohttp web.Response."""
    return json.loads(response.body)


def _make_handler(status=200):
    """Return an async handler mock that returns a simple response."""
    resp = web.json_response({"ok": True}, status=status)
    return AsyncMock(return_value=resp)


# ===========================================================================
# api_key_auth_middleware
# ===========================================================================


class TestApiKeyAuthMiddleware:
    """Verify api_key_auth_middleware covers all auth paths."""

    def test_health_endpoint_bypasses_auth(self):
        """Health endpoints should bypass auth entirely."""
        import main

        handler = _make_handler()
        req = _make_mock_request(path="/health")
        resp = _run(main.api_key_auth_middleware(req, handler))
        handler.assert_called_once_with(req)
        assert resp.status == 200

    def test_ready_endpoint_bypasses_auth(self):
        """Ready endpoint should bypass auth."""
        import main

        handler = _make_handler()
        req = _make_mock_request(path="/ready")
        resp = _run(main.api_key_auth_middleware(req, handler))
        handler.assert_called_once()

    def test_api_keys_endpoint_bypasses_api_key_auth(self):
        """API key management endpoints bypass API key auth (JWT-only)."""
        import main

        handler = _make_handler()
        req = _make_mock_request(path="/v1/api-keys")
        resp = _run(main.api_key_auth_middleware(req, handler))
        handler.assert_called_once()

    def test_update_endpoint_bypasses_auth(self):
        """Update endpoints bypass API key auth."""
        import main

        handler = _make_handler()
        req = _make_mock_request(path="/v1/update/config")
        resp = _run(main.api_key_auth_middleware(req, handler))
        handler.assert_called_once()

    def test_jwt_bearer_passthrough(self):
        """Valid JWT Bearer token should pass through with claims injected."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"Authorization": "Bearer some.jwt.token"})
        claims = {"sub": "user-123", "email": "user@test.com"}
        with patch("main.decode_jwt_payload", return_value=claims):
            resp = _run(main.api_key_auth_middleware(req, handler))
        handler.assert_called_once()
        # Verify claims were injected into request
        req.__setitem__.assert_any_call("auth_source", "jwt")
        req.__setitem__.assert_any_call("user_sub", "user-123")
        req.__setitem__.assert_any_call("user_email", "user@test.com")

    def test_jwt_bearer_invalid_still_passes_through(self):
        """Invalid JWT in Bearer header should still pass to handler (ALB validates)."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"Authorization": "Bearer bad.token"})
        with patch("main.decode_jwt_payload", return_value=None):
            resp = _run(main.api_key_auth_middleware(req, handler))
        handler.assert_called_once()

    def test_missing_api_key_returns_401(self):
        """No auth header and no API key should return 401."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={})
        resp = _run(main.api_key_auth_middleware(req, handler))
        assert resp.status == 401
        body = _json_body(resp)
        assert body["error"]["code"] == "missing_credentials"
        handler.assert_not_called()

    def test_api_key_wrong_prefix_returns_401(self):
        """API key without the correct prefix should return 401."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-API-Key": "bad_prefix_key"})
        resp = _run(main.api_key_auth_middleware(req, handler))
        assert resp.status == 401
        handler.assert_not_called()

    def test_api_key_dynamo_lookup_failure_returns_500(self):
        """DynamoDB lookup failure should return 500."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-API-Key": "oc_valid_key_here"})
        # Clear cache to force DynamoDB lookup
        main._api_key_cache.clear()
        with (
            patch("main.hash_api_key", return_value="somehash"),
            patch("main._lookup_api_key", side_effect=RuntimeError("dynamo down")),
        ):
            resp = _run(main.api_key_auth_middleware(req, handler))
        assert resp.status == 500
        body = _json_body(resp)
        assert body["error"]["code"] == "internal_error"

    def test_api_key_not_found_returns_401(self):
        """Unknown API key (not in DynamoDB) should return 401."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-API-Key": "oc_unknown_key12345"})
        main._api_key_cache.clear()
        with (
            patch("main.hash_api_key", return_value="unknownhash"),
            patch("main._lookup_api_key", return_value=None),
        ):
            resp = _run(main.api_key_auth_middleware(req, handler))
        assert resp.status == 401
        body = _json_body(resp)
        assert body["error"]["code"] == "invalid_api_key"

    def test_api_key_revoked_returns_401(self):
        """Revoked API key should return 401."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-API-Key": "oc_revoked_key12345"})
        main._api_key_cache.clear()
        item = {"key_hash": "h1", "status": "revoked", "user_sub": "u1"}
        with (
            patch("main.hash_api_key", return_value="revokedhash"),
            patch("main._lookup_api_key", return_value=item),
        ):
            resp = _run(main.api_key_auth_middleware(req, handler))
        assert resp.status == 401
        body = _json_body(resp)
        assert body["error"]["code"] == "revoked_api_key"

    def test_api_key_expired_returns_401(self):
        """Expired API key should return 401."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-API-Key": "oc_expired_key12345"})
        main._api_key_cache.clear()
        item = {
            "key_hash": "h1",
            "status": "active",
            "user_sub": "u1",
            "expires_at": "2020-01-01T00:00:00+00:00",
        }
        with (
            patch("main.hash_api_key", return_value="expiredhash"),
            patch("main._lookup_api_key", return_value=item),
        ):
            resp = _run(main.api_key_auth_middleware(req, handler))
        assert resp.status == 401
        body = _json_body(resp)
        assert body["error"]["code"] == "expired_api_key"

    def test_valid_api_key_succeeds_and_caches(self):
        """Valid API key should pass through, inject identity, and cache."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-API-Key": "oc_good_key_1234567"})
        main._api_key_cache.clear()
        item = {
            "key_hash": "goodhash",
            "status": "active",
            "user_sub": "user-789",
            "user_email": "good@test.com",
            "expires_at": "2099-01-01T00:00:00+00:00",
        }
        with (
            patch("main.hash_api_key", return_value="goodhash"),
            patch("main._lookup_api_key", return_value=item),
            patch("main._update_last_used"),
        ):
            resp = _run(main.api_key_auth_middleware(req, handler))
        assert resp.status == 200
        handler.assert_called_once()
        # Verify cache was populated
        assert "goodhash" in main._api_key_cache
        assert main._api_key_cache["goodhash"]["user_sub"] == "user-789"
        # Verify identity injected
        req.__setitem__.assert_any_call("auth_source", "api_key")
        req.__setitem__.assert_any_call("user_sub", "user-789")
        # Clean up
        main._api_key_cache.clear()

    def test_cached_api_key_skips_dynamo(self):
        """Cached API key should skip DynamoDB lookup."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-API-Key": "oc_cached_key_12345"})
        main._api_key_cache["cachedhash"] = {
            "user_sub": "cached-user",
            "user_email": "cached@test.com",
            "cache_expires": time.time() + 300,
        }
        with (
            patch("main.hash_api_key", return_value="cachedhash"),
            patch("main._lookup_api_key") as mock_lookup,
            patch("main._update_last_used"),
        ):
            resp = _run(main.api_key_auth_middleware(req, handler))
        assert resp.status == 200
        mock_lookup.assert_not_called()
        req.__setitem__.assert_any_call("user_sub", "cached-user")
        # Clean up
        main._api_key_cache.clear()


# ===========================================================================
# version_gate_middleware
# ===========================================================================


class TestVersionGateMiddleware:
    """Verify version_gate_middleware covers all bypass/reject/allow paths."""

    def test_health_bypasses_version_check(self):
        """Health endpoints should bypass version check."""
        import main

        handler = _make_handler()
        req = _make_mock_request(path="/health")
        resp = _run(main.version_gate_middleware(req, handler))
        handler.assert_called_once()

    def test_update_endpoint_bypasses_version_check(self):
        """Update endpoints bypass version check so blocked clients can update."""
        import main

        handler = _make_handler()
        req = _make_mock_request(path="/v1/update/download-url")
        resp = _run(main.version_gate_middleware(req, handler))
        handler.assert_called_once()

    def test_missing_header_allows_through(self):
        """Missing X-Client-Version allows through for backward compat."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={})
        resp = _run(main.version_gate_middleware(req, handler))
        handler.assert_called_once()

    def test_dev_version_allows_through(self):
        """'dev' version string should always be allowed."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-Client-Version": "dev"})
        resp = _run(main.version_gate_middleware(req, handler))
        handler.assert_called_once()

    def test_no_minimum_version_allows_through(self):
        """If no version policy is configured, allow through."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-Client-Version": "1.0.0"})
        with patch("main._fetch_version_policy", return_value=None):
            resp = _run(main.version_gate_middleware(req, handler))
        handler.assert_called_once()

    def test_outdated_client_returns_426(self):
        """Client below minimum version should get 426 Upgrade Required."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-Client-Version": "1.0.0"})
        with patch("main._fetch_version_policy", return_value="2.0.0"):
            resp = _run(main.version_gate_middleware(req, handler))
        assert resp.status == 426
        body = _json_body(resp)
        assert body["error"]["code"] == "client_outdated"
        assert body["error"]["minimum_version"] == "2.0.0"
        handler.assert_not_called()

    def test_current_client_allows_through(self):
        """Client at or above minimum version should be allowed."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-Client-Version": "2.1.0"})
        with patch("main._fetch_version_policy", return_value="2.0.0"):
            resp = _run(main.version_gate_middleware(req, handler))
        handler.assert_called_once()

    def test_unparseable_version_allows_through(self):
        """Unparseable version strings should be allowed through."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-Client-Version": "not-a-version"})
        with patch("main._fetch_version_policy", return_value="2.0.0"):
            resp = _run(main.version_gate_middleware(req, handler))
        handler.assert_called_once()

    def test_426_includes_download_hint_when_domain_set(self):
        """426 response should include download hint when DISTRIBUTION_DOMAIN is set."""
        import main

        handler = _make_handler()
        req = _make_mock_request(headers={"X-Client-Version": "1.0.0"})
        with (
            patch("main._fetch_version_policy", return_value="2.0.0"),
            patch("main.DISTRIBUTION_DOMAIN", "download.example.com"),
        ):
            resp = _run(main.version_gate_middleware(req, handler))
        assert resp.status == 426
        body = _json_body(resp)
        assert "download.example.com" in body["error"]["message"]


# ===========================================================================
# request_logging_middleware
# ===========================================================================


class TestRequestLoggingMiddleware:
    """Verify request_logging_middleware handles all paths."""

    def test_health_check_fast_path(self):
        """Health checks should be handled with minimal logging."""
        import main

        handler = _make_handler()
        req = _make_mock_request(path="/health", headers={})
        resp = _run(main.request_logging_middleware(req, handler))
        assert resp.status == 200
        assert "X-Request-ID" in resp.headers

    def test_normal_request_gets_request_id(self):
        """Normal requests should get a request ID assigned."""
        import main

        handler = _make_handler()
        req = _make_mock_request(
            path="/v1/chat/completions",
            headers={"X-Request-ID": "custom-id-123"},
        )
        resp = _run(main.request_logging_middleware(req, handler))
        assert resp.status == 200
        assert resp.headers["X-Request-ID"] == "custom-id-123"
        req.__setitem__.assert_any_call("request_id", "custom-id-123")

    def test_exception_propagates(self):
        """Exceptions from handler should be re-raised after logging."""
        import main

        async def failing_handler(request):
            raise RuntimeError("handler boom")

        req = _make_mock_request(
            path="/v1/chat/completions",
            headers={},
        )
        with pytest.raises(RuntimeError, match="handler boom"):
            _run(main.request_logging_middleware(req, failing_handler))


# ===========================================================================
# _parse_semver
# ===========================================================================


class TestParseSemver:
    """Verify _parse_semver handles edge cases."""

    def test_valid_semver(self):
        import main

        assert main._parse_semver("1.2.3") == (1, 2, 3)

    def test_leading_v(self):
        import main

        assert main._parse_semver("v1.2.3") == (1, 2, 3)

    def test_prerelease_suffix_stripped(self):
        import main

        assert main._parse_semver("1.2.3-beta.1") == (1, 2, 3)

    def test_build_metadata_stripped(self):
        import main

        assert main._parse_semver("1.2.3+build.42") == (1, 2, 3)

    def test_two_part_returns_none(self):
        import main

        assert main._parse_semver("1.2") is None

    def test_non_numeric_returns_none(self):
        import main

        assert main._parse_semver("a.b.c") is None

    def test_empty_returns_none(self):
        import main

        assert main._parse_semver("") is None


# ===========================================================================
# decode_jwt_payload
# ===========================================================================


class TestDecodeJwtPayload:
    """Verify decode_jwt_payload handles edge cases."""

    def test_valid_jwt(self):
        import main
        import base64

        payload = (
            base64.urlsafe_b64encode(
                json.dumps({"sub": "user-1", "email": "a@b.com"}).encode()
            )
            .rstrip(b"=")
            .decode()
        )
        token = f"header.{payload}.signature"
        claims = main.decode_jwt_payload(token)
        assert claims["sub"] == "user-1"  # type: ignore[index]
        assert claims["email"] == "a@b.com"  # type: ignore[index]

    def test_two_part_token_returns_none(self):
        import main

        assert main.decode_jwt_payload("header.payload") is None

    def test_invalid_base64_returns_none(self):
        import main

        assert main.decode_jwt_payload("h.!!!invalid!!!.s") is None

    def test_invalid_json_returns_none(self):
        import main
        import base64

        payload = base64.urlsafe_b64encode(b"not json").rstrip(b"=").decode()
        assert main.decode_jwt_payload(f"h.{payload}.s") is None
