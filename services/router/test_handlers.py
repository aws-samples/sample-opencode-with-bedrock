"""Tests for router HTTP handlers, content translation, and API key management."""

import asyncio
import base64
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_request(
    *,
    json_body=None,
    json_error=False,
    headers=None,
    match_info=None,
    request_id="test-req-id",
    user_sub=None,
    user_email=None,
):
    """Build a mock aiohttp request suitable for handler tests."""
    req = MagicMock()
    req.get = MagicMock(
        side_effect=lambda key, default=None: {
            "request_id": request_id,
            "user_sub": user_sub or "",
            "user_email": user_email or "",
        }.get(key, default)
    )

    if json_error:
        req.json = AsyncMock(side_effect=json.JSONDecodeError("bad", "", 0))
    elif json_body is not None:
        req.json = AsyncMock(return_value=json_body)
    else:
        req.json = AsyncMock(return_value={})

    req.headers = headers or {}
    req.match_info = match_info or {}
    req.path = "/test"
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


# ===========================================================================
# _translate_content — tool_calls, images, mixed, edge cases
# ===========================================================================


class TestTranslateContentToolCalls:
    """Verify _translate_content handles tool_calls append path correctly."""

    def test_append_tool_use_block(self):
        """Tool use blocks should be appendable to translated content."""
        import main

        content = [{"type": "text", "text": "Let me check."}]
        blocks = main._translate_content(content)
        # Simulate what translate_openai_to_converse does
        blocks.append(
            {
                "toolUse": {
                    "toolUseId": "call_123",
                    "name": "get_weather",
                    "input": {"city": "Seattle"},
                }
            }
        )
        assert len(blocks) == 2
        assert blocks[0] == {"text": "Let me check."}
        assert blocks[1]["toolUse"]["name"] == "get_weather"
        assert blocks[1]["toolUse"]["input"] == {"city": "Seattle"}

    def test_image_data_uri(self):
        """data: URI images should be decoded into Converse image blocks."""
        import main

        pixel_png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
        content = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{pixel_png}"},
            }
        ]
        blocks = main._translate_content(content)
        assert len(blocks) == 1
        assert "image" in blocks[0]
        assert blocks[0]["image"]["format"] == "png"
        assert blocks[0]["image"]["source"]["bytes"] == base64.b64decode(pixel_png)

    def test_image_jpg_format_normalised(self):
        """MIME type image/jpg should be normalised to jpeg."""
        import main

        pixel = base64.b64encode(b"\xff\xd8\xff\xe0fake").decode()
        content = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpg;base64,{pixel}"},
            }
        ]
        blocks = main._translate_content(content)
        assert blocks[0]["image"]["format"] == "jpeg"

    def test_image_regular_url_becomes_text(self):
        """Non-data URLs should be passed as text."""
        import main

        content = [
            {"type": "image_url", "image_url": {"url": "https://example.com/photo.png"}}
        ]
        blocks = main._translate_content(content)
        assert len(blocks) == 1
        assert "text" in blocks[0]
        assert "https://example.com/photo.png" in blocks[0]["text"]

    def test_mixed_text_and_image(self):
        """Mixed content types should produce multiple blocks."""
        import main

        pixel = base64.b64encode(b"fake").decode()
        content = [
            {"type": "text", "text": "Look at this:"},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{pixel}"},
            },
            {"type": "text", "text": "What do you see?"},
        ]
        blocks = main._translate_content(content)
        assert len(blocks) == 3
        assert blocks[0] == {"text": "Look at this:"}
        assert "image" in blocks[1]
        assert blocks[2] == {"text": "What do you see?"}

    def test_empty_list_returns_empty_text_block(self):
        """An empty list should return a single empty text block."""
        import main

        blocks = main._translate_content([])
        assert blocks == [{"text": ""}]

    def test_empty_string_returns_empty_text_block(self):
        """An empty string should return a single empty text block."""
        import main

        blocks = main._translate_content("")
        assert blocks == [{"text": ""}]

    def test_non_string_non_list_fallback(self):
        """Non-string, non-list content should fall through to str() conversion."""
        import main

        blocks = main._translate_content(42)
        assert blocks == [{"text": "42"}]

    def test_none_content_returns_empty_text(self):
        """None content should return empty text block."""
        import main

        blocks = main._translate_content(None)
        assert blocks == [{"text": ""}]

    def test_string_list_parts(self):
        """A list of plain strings should produce text blocks."""
        import main

        blocks = main._translate_content(["hello", "world"])
        assert blocks == [{"text": "hello"}, {"text": "world"}]


# ===========================================================================
# translate_openai_to_converse — tool_calls in messages
# ===========================================================================


class TestTranslateToolCallsMessages:
    """Verify translate_openai_to_converse handles assistant tool_calls."""

    def test_tool_calls_with_valid_json_arguments(self):
        """Tool calls with valid JSON arguments should be parsed."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                {"role": "user", "content": "What's the weather?"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "get_weather",
                                "arguments": '{"city": "Seattle"}',
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "Sunny, 72F"},
                {"role": "user", "content": "Thanks!"},
            ],
        }
        params = main.translate_openai_to_converse(body)
        messages = params["messages"]
        # Find the assistant message
        assistant_msg = [m for m in messages if m["role"] == "assistant"][0]
        tool_use_block = [b for b in assistant_msg["content"] if "toolUse" in b][0]
        assert tool_use_block["toolUse"]["name"] == "get_weather"
        assert tool_use_block["toolUse"]["input"] == {"city": "Seattle"}

    def test_tool_calls_with_invalid_json_arguments(self):
        """Invalid JSON in tool_call arguments should fall back to raw wrapper."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                {"role": "user", "content": "Do something"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_2",
                            "type": "function",
                            "function": {
                                "name": "my_tool",
                                "arguments": "not valid json{{{",
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_2", "content": "result"},
                {"role": "user", "content": "ok"},
            ],
        }
        params = main.translate_openai_to_converse(body)
        messages = params["messages"]
        assistant_msg = [m for m in messages if m["role"] == "assistant"][0]
        tool_use_block = [b for b in assistant_msg["content"] if "toolUse" in b][0]
        assert tool_use_block["toolUse"]["input"] == {"raw": "not valid json{{{"}

    def test_empty_text_stripped_alongside_tool_use(self):
        """Empty text blocks should be stripped when tool_calls are present."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                {"role": "user", "content": "Hello"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_3",
                            "type": "function",
                            "function": {
                                "name": "noop",
                                "arguments": "{}",
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_3", "content": "done"},
                {"role": "user", "content": "ok"},
            ],
        }
        params = main.translate_openai_to_converse(body)
        messages = params["messages"]
        assistant_msg = [m for m in messages if m["role"] == "assistant"][0]
        # Should only have the toolUse block, empty text should be stripped
        text_blocks = [
            b for b in assistant_msg["content"] if "text" in b and not b["text"]
        ]
        assert len(text_blocks) == 0

    def test_empty_assistant_message_gets_placeholder(self):
        """An interrupted assistant message with empty content should get a placeholder, not blank text."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": ""},
                {"role": "user", "content": "Try again"},
            ],
        }
        params = main.translate_openai_to_converse(body)
        messages = params["messages"]
        assistant_msg = [m for m in messages if m["role"] == "assistant"][0]
        # Should NOT contain a blank text block
        blank_blocks = [
            b for b in assistant_msg["content"] if "text" in b and b["text"] == ""
        ]
        assert len(blank_blocks) == 0
        # Should have a placeholder instead
        assert len(assistant_msg["content"]) == 1
        assert assistant_msg["content"][0]["text"] == "."

    def test_empty_text_stripped_from_user_message(self):
        """Empty text blocks should be stripped from user messages too."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [
                {"role": "user", "content": "Hello"},
            ],
        }
        params = main.translate_openai_to_converse(body)
        messages = params["messages"]
        user_msg = messages[0]
        # Non-empty text should pass through fine
        assert user_msg["content"] == [{"text": "Hello"}]


# ===========================================================================
# ready handler
# ===========================================================================


class TestReadyHandler:
    """Verify the /ready handler covers all return paths."""

    def test_ready_token_valid(self):
        """ready() should return 200 when get_token() returns a truthy value."""
        import main

        req = _make_mock_request()
        with patch("main.get_token", return_value="valid-token"):
            resp = _run(main.ready(req))
        assert resp.status == 200
        body = _json_body(resp)
        assert body["status"] == "ready"
        assert body["token_status"] == "valid"

    def test_ready_token_empty(self):
        """ready() should return 503 when get_token() returns falsy value."""
        import main

        req = _make_mock_request()
        with patch("main.get_token", return_value=None):
            resp = _run(main.ready(req))
        assert resp.status == 503
        body = _json_body(resp)
        assert body["status"] == "not_ready"
        assert "empty" in body["error"].lower()

    def test_ready_token_empty_string(self):
        """ready() should return 503 when get_token() returns empty string."""
        import main

        req = _make_mock_request()
        with patch("main.get_token", return_value=""):
            resp = _run(main.ready(req))
        assert resp.status == 503

    def test_ready_token_exception(self):
        """ready() should return 503 when get_token() raises."""
        import main

        req = _make_mock_request()
        with patch("main.get_token", side_effect=RuntimeError("IAM fail")):
            resp = _run(main.ready(req))
        assert resp.status == 503
        body = _json_body(resp)
        assert body["status"] == "not_ready"
        assert "failed" in body["error"].lower()


# ===========================================================================
# health handler
# ===========================================================================


class TestHealthHandler:
    """Verify the /health handler."""

    def test_health_returns_200(self):
        """health() should always return 200 with status healthy."""
        import main

        req = _make_mock_request()
        resp = _run(main.health(req))
        assert resp.status == 200
        body = _json_body(resp)
        assert body["status"] == "healthy"
        assert body["service"] == "bedrock-router"


# ===========================================================================
# models handler
# ===========================================================================


class TestModelsHandler:
    """Verify the /v1/models handler."""

    def test_models_returns_list(self):
        """models() should return a list of all models from get_model_map()."""
        import main

        req = _make_mock_request()
        mock_map = {"model-a": "backend-a", "model-b": "backend-b"}
        with patch("main.get_model_map", return_value=mock_map):
            resp = _run(main.models(req))
        assert resp.status == 200
        body = _json_body(resp)
        assert body["object"] == "list"
        model_ids = {m["id"] for m in body["data"]}
        assert model_ids == {"model-a", "model-b"}


# ===========================================================================
# chat_completions — routing logic
# ===========================================================================


class TestChatCompletionsRouting:
    """Verify chat_completions routes to correct backend."""

    def test_invalid_json_returns_400(self):
        """chat_completions should return 400 for invalid JSON."""
        import main

        req = _make_mock_request(json_error=True)
        resp = _run(main.chat_completions(req))
        assert resp.status == 400

    def test_anthropic_model_non_streaming(self):
        """Anthropic models with stream=False should call handle_anthropic_non_streaming."""
        import main

        req = _make_mock_request(json_body={"model": "claude-sonnet", "stream": False})
        mock_resp = web.json_response({"choices": []})
        with (
            patch(
                "main.get_model_map",
                return_value={"claude-sonnet": "us.anthropic.claude-sonnet-4-6"},
            ),
            patch(
                "main.handle_anthropic_non_streaming",
                new_callable=AsyncMock,
                return_value=mock_resp,
            ) as mock_handler,
        ):
            resp = _run(main.chat_completions(req))
        mock_handler.assert_called_once()
        # First arg is the translated body
        call_body = mock_handler.call_args[0][0]
        assert call_body["model"] == "us.anthropic.claude-sonnet-4-6"

    def test_anthropic_model_streaming(self):
        """Anthropic models with stream=True should call handle_anthropic_streaming."""
        import main

        req = _make_mock_request(json_body={"model": "claude-sonnet", "stream": True})
        mock_resp = web.Response()
        with (
            patch(
                "main.get_model_map",
                return_value={"claude-sonnet": "us.anthropic.claude-sonnet-4-6"},
            ),
            patch(
                "main.handle_anthropic_streaming",
                new_callable=AsyncMock,
                return_value=mock_resp,
            ) as mock_handler,
        ):
            resp = _run(main.chat_completions(req))
        mock_handler.assert_called_once()

    def test_mantle_model_token_failure(self):
        """Mantle path should return 500 if get_token fails."""
        import main

        req = _make_mock_request(json_body={"model": "deepseek-v3", "stream": False})
        with (
            patch("main.get_model_map", return_value={"deepseek-v3": "deepseek.v3.2"}),
            patch("main.get_token", side_effect=RuntimeError("no token")),
        ):
            resp = _run(main.chat_completions(req))
        assert resp.status == 500


# ===========================================================================
# API key handlers
# ===========================================================================


class TestCreateApiKey:
    """Verify create_api_key handler."""

    def test_unauthenticated_returns_401(self):
        """create_api_key should return 401 when no JWT identity."""
        import main

        req = _make_mock_request()
        with patch("main._extract_jwt_identity", return_value=(None, None)):
            resp = _run(main.create_api_key(req))
        assert resp.status == 401

    def test_success_returns_201(self):
        """create_api_key should return 201 on success."""
        import main

        req = _make_mock_request(
            json_body={"description": "test key", "expires_in_days": 30}
        )
        with (
            patch(
                "main._extract_jwt_identity", return_value=("user-123", "user@test.com")
            ),
            patch("main._list_user_keys", return_value=[]),
            patch("main._put_api_key"),
            patch("main.generate_api_key", return_value="oc_testkey1234567890abcdef"),
            patch("main.hash_api_key", return_value="fakehash123"),
        ):
            resp = _run(main.create_api_key(req))
        assert resp.status == 201
        body = _json_body(resp)
        assert body["key"] == "oc_testkey1234567890abcdef"
        assert body["status"] == "active"

    def test_max_keys_returns_409(self):
        """create_api_key should return 409 when max keys reached."""
        import main

        req = _make_mock_request(json_body={})
        active_keys = [{"status": "active"} for _ in range(main.MAX_KEYS_PER_USER)]
        with (
            patch(
                "main._extract_jwt_identity", return_value=("user-123", "user@test.com")
            ),
            patch("main._list_user_keys", return_value=active_keys),
        ):
            resp = _run(main.create_api_key(req))
        assert resp.status == 409

    def test_invalid_expiry_returns_400(self):
        """create_api_key should return 400 for out-of-range expiry."""
        import main

        req = _make_mock_request(
            json_body={"description": "test", "expires_in_days": 9999}
        )
        with (
            patch(
                "main._extract_jwt_identity", return_value=("user-123", "user@test.com")
            ),
        ):
            resp = _run(main.create_api_key(req))
        assert resp.status == 400

    def test_dynamo_write_failure_returns_500(self):
        """create_api_key should return 500 if DynamoDB write fails."""
        import main

        req = _make_mock_request(json_body={"description": "test"})
        with (
            patch("main._extract_jwt_identity", return_value=("user-123", "u@t.com")),
            patch("main._list_user_keys", return_value=[]),
            patch("main._put_api_key", side_effect=RuntimeError("dynamo down")),
            patch("main.generate_api_key", return_value="oc_testkey1234567890abcdef"),
            patch("main.hash_api_key", return_value="fakehash"),
        ):
            resp = _run(main.create_api_key(req))
        assert resp.status == 500


class TestListApiKeys:
    """Verify list_api_keys handler."""

    def test_unauthenticated_returns_401(self):
        """list_api_keys should return 401 when no JWT identity."""
        import main

        req = _make_mock_request()
        with patch("main._extract_jwt_identity", return_value=(None, None)):
            resp = _run(main.list_api_keys(req))
        assert resp.status == 401

    def test_success_returns_keys(self):
        """list_api_keys should return 200 with formatted keys."""
        import main

        req = _make_mock_request()
        items = [
            {
                "key_prefix": "oc_abc",
                "description": "My key",
                "status": "active",
                "created_at": "2026-01-01T00:00:00",
                "expires_at": "2026-04-01T00:00:00",
            }
        ]
        with (
            patch("main._extract_jwt_identity", return_value=("user-123", "u@t.com")),
            patch("main._list_user_keys", return_value=items),
        ):
            resp = _run(main.list_api_keys(req))
        assert resp.status == 200
        body = _json_body(resp)
        assert len(body["keys"]) == 1
        assert body["keys"][0]["key_prefix"] == "oc_abc"

    def test_dynamo_failure_returns_500(self):
        """list_api_keys should return 500 if DynamoDB read fails."""
        import main

        req = _make_mock_request()
        with (
            patch("main._extract_jwt_identity", return_value=("user-123", "u@t.com")),
            patch("main._list_user_keys", side_effect=RuntimeError("dynamo error")),
        ):
            resp = _run(main.list_api_keys(req))
        assert resp.status == 500


class TestRevokeApiKey:
    """Verify revoke_api_key handler."""

    def test_unauthenticated_returns_401(self):
        """revoke_api_key should return 401 when no JWT identity."""
        import main

        req = _make_mock_request()
        with patch("main._extract_jwt_identity", return_value=(None, None)):
            resp = _run(main.revoke_api_key(req))
        assert resp.status == 401

    def test_missing_prefix_returns_400(self):
        """revoke_api_key should return 400 when key_prefix is missing."""
        import main

        req = _make_mock_request(match_info={})
        # match_info.get("key_prefix", "") returns ""
        with patch("main._extract_jwt_identity", return_value=("user-123", "u@t.com")):
            resp = _run(main.revoke_api_key(req))
        assert resp.status == 400

    def test_key_not_found_returns_404(self):
        """revoke_api_key should return 404 when key not found."""
        import main

        req = _make_mock_request(match_info={"key_prefix": "oc_notfound"})
        with (
            patch("main._extract_jwt_identity", return_value=("user-123", "u@t.com")),
            patch("main._list_user_keys", return_value=[]),
        ):
            resp = _run(main.revoke_api_key(req))
        assert resp.status == 404

    def test_already_revoked_returns_409(self):
        """revoke_api_key should return 409 when key already revoked."""
        import main

        req = _make_mock_request(match_info={"key_prefix": "oc_abc"})
        items = [{"key_prefix": "oc_abc", "key_hash": "h1", "status": "revoked"}]
        with (
            patch("main._extract_jwt_identity", return_value=("user-123", "u@t.com")),
            patch("main._list_user_keys", return_value=items),
        ):
            resp = _run(main.revoke_api_key(req))
        assert resp.status == 409

    def test_success_returns_200(self):
        """revoke_api_key should return 200 on success."""
        import main

        req = _make_mock_request(match_info={"key_prefix": "oc_abc"})
        items = [{"key_prefix": "oc_abc", "key_hash": "hash123", "status": "active"}]
        with (
            patch("main._extract_jwt_identity", return_value=("user-123", "u@t.com")),
            patch("main._list_user_keys", return_value=items),
            patch("main._revoke_api_key"),
        ):
            # Ensure _api_key_cache has the entry to verify pop behaviour
            main._api_key_cache["hash123"] = {"status": "active"}
            resp = _run(main.revoke_api_key(req))
        assert resp.status == 200
        body = _json_body(resp)
        assert body["status"] == "revoked"
        # Cache entry should have been removed
        assert "hash123" not in main._api_key_cache


# ===========================================================================
# update handlers
# ===========================================================================


class TestUpdateConfig:
    """Verify update_config handler."""

    def test_no_bucket_returns_500(self):
        """update_config should return 500 if DISTRIBUTION_BUCKET is empty."""
        import main

        req = _make_mock_request()
        with patch("main.DISTRIBUTION_BUCKET", ""):
            resp = _run(main.update_config(req))
        assert resp.status == 500

    def test_success_returns_json_body(self):
        """update_config should return the S3 object body as JSON."""
        import main

        req = _make_mock_request()
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=b'{"patch": true}'))
        }
        mock_boto3 = MagicMock()
        mock_boto3.client.return_value = mock_s3
        with (
            patch("main.DISTRIBUTION_BUCKET", "my-bucket"),
            patch("main.boto3", mock_boto3),
        ):
            resp = _run(main.update_config(req))
        assert resp.status == 200
        assert resp.text == '{"patch": true}'

    def test_no_such_key_returns_404(self):
        """update_config should return 404 if the S3 key does not exist."""
        import main

        req = _make_mock_request()
        mock_s3 = MagicMock()
        mock_s3.get_object.side_effect = Exception("An error occurred (NoSuchKey)")
        mock_boto3 = MagicMock()
        mock_boto3.client.return_value = mock_s3
        with (
            patch("main.DISTRIBUTION_BUCKET", "my-bucket"),
            patch("main.boto3", mock_boto3),
        ):
            resp = _run(main.update_config(req))
        assert resp.status == 404

    def test_s3_error_returns_500(self):
        """update_config should return 500 for other S3 errors."""
        import main

        req = _make_mock_request()
        mock_s3 = MagicMock()
        mock_s3.get_object.side_effect = Exception("AccessDenied")
        mock_boto3 = MagicMock()
        mock_boto3.client.return_value = mock_s3
        with (
            patch("main.DISTRIBUTION_BUCKET", "my-bucket"),
            patch("main.boto3", mock_boto3),
        ):
            resp = _run(main.update_config(req))
        assert resp.status == 500


class TestUpdateDownloadUrl:
    """Verify update_download_url handler."""

    def test_no_bucket_returns_500(self):
        """update_download_url should return 500 if DISTRIBUTION_BUCKET is empty."""
        import main

        req = _make_mock_request()
        with patch("main.DISTRIBUTION_BUCKET", ""):
            resp = _run(main.update_download_url(req))
        assert resp.status == 500

    def test_success_returns_presigned_url(self):
        """update_download_url should return a presigned URL."""
        import main

        req = _make_mock_request()
        mock_s3 = MagicMock()
        mock_s3.generate_presigned_url.return_value = "https://s3.example.com/signed"
        mock_boto3 = MagicMock()
        mock_boto3.client.return_value = mock_s3
        with (
            patch("main.DISTRIBUTION_BUCKET", "my-bucket"),
            patch("main.boto3", mock_boto3),
        ):
            resp = _run(main.update_download_url(req))
        assert resp.status == 200
        body = _json_body(resp)
        assert body["download_url"] == "https://s3.example.com/signed"
        assert body["expires_in"] == 3600

    def test_s3_error_returns_500(self):
        """update_download_url should return 500 on S3 failure."""
        import main

        req = _make_mock_request()
        mock_s3 = MagicMock()
        mock_s3.generate_presigned_url.side_effect = Exception("S3 error")
        mock_boto3 = MagicMock()
        mock_boto3.client.return_value = mock_s3
        with (
            patch("main.DISTRIBUTION_BUCKET", "my-bucket"),
            patch("main.boto3", mock_boto3),
        ):
            resp = _run(main.update_download_url(req))
        assert resp.status == 500


# ===========================================================================
# _extract_jwt_identity
# ===========================================================================


class TestExtractJwtIdentity:
    """Verify _extract_jwt_identity extracts user info from JWT."""

    def test_no_auth_header(self):
        """Should return (None, None) when Authorization header is missing."""
        import main

        req = _make_mock_request(headers={})
        sub, email = main._extract_jwt_identity(req)
        assert sub is None
        assert email is None

    def test_non_bearer_header(self):
        """Should return (None, None) for non-Bearer auth."""
        import main

        req = _make_mock_request(headers={"Authorization": "Basic abc123"})
        sub, email = main._extract_jwt_identity(req)
        assert sub is None
        assert email is None

    def test_valid_jwt(self):
        """Should extract sub and email from valid JWT claims."""
        import main

        claims = {"sub": "user-456", "email": "test@example.com"}
        req = _make_mock_request(headers={"Authorization": "Bearer some.jwt.token"})
        with patch("main.decode_jwt_payload", return_value=claims):
            sub, email = main._extract_jwt_identity(req)
        assert sub == "user-456"
        assert email == "test@example.com"

    def test_invalid_jwt(self):
        """Should return (None, None) if JWT decode fails."""
        import main

        req = _make_mock_request(headers={"Authorization": "Bearer bad.token.here"})
        with patch("main.decode_jwt_payload", return_value=None):
            sub, email = main._extract_jwt_identity(req)
        assert sub is None
        assert email is None
