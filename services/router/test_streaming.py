"""Tests for handle_anthropic_non_streaming and handle_anthropic_streaming."""

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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


def _make_converse_response(text="Hello!", input_tokens=10, output_tokens=5):
    """Build a minimal Converse API response dict."""
    return {
        "output": {
            "message": {
                "content": [{"text": text}],
                "role": "assistant",
            }
        },
        "usage": {
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
        },
        "stopReason": "end_turn",
    }


def _make_converse_response_with_cache(
    text="Hello!",
    input_tokens=100,
    output_tokens=20,
    cache_read=80,
    cache_write=0,
):
    """Build a Converse API response with cache metrics."""
    resp = _make_converse_response(text, input_tokens, output_tokens)
    resp["usage"]["cacheReadInputTokens"] = cache_read
    resp["usage"]["cacheWriteInputTokens"] = cache_write
    return resp


class _ValidationException(Exception):
    """Simulate a botocore ValidationException."""

    pass


_ValidationException.__name__ = "ValidationException"


# ===========================================================================
# handle_anthropic_non_streaming
# ===========================================================================


class TestHandleAnthropicNonStreaming:
    """Verify handle_anthropic_non_streaming covers all paths."""

    def test_success(self):
        """Successful Converse API call should return translated response."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        converse_resp = _make_converse_response("Hello!", 10, 5)
        mock_client = MagicMock()
        mock_client.converse.return_value = converse_resp

        with patch("main.get_bedrock_client", return_value=mock_client):
            resp = _run(main.handle_anthropic_non_streaming(body, "req-1"))

        assert resp.status == 200
        result = _json_body(resp)
        assert result["choices"][0]["message"]["content"] == "Hello!"
        assert result["usage"]["prompt_tokens"] == 10
        assert result["usage"]["completion_tokens"] == 5

    def test_success_with_cache_metrics(self):
        """Cache metrics should be surfaced in the response usage."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        converse_resp = _make_converse_response_with_cache(
            "Hello!", 100, 20, cache_read=80, cache_write=0
        )
        mock_client = MagicMock()
        mock_client.converse.return_value = converse_resp

        with patch("main.get_bedrock_client", return_value=mock_client):
            resp = _run(main.handle_anthropic_non_streaming(body, "req-cache"))

        result = _json_body(resp)
        assert result["usage"]["cache_read_input_tokens"] == 80
        assert result["usage"]["prompt_tokens_details"]["cached_tokens"] == 80

    def test_validation_exception_returns_400(self):
        """ValidationException from Bedrock should return 400."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        mock_client = MagicMock()
        mock_client.converse.side_effect = _ValidationException(
            "An error occurred (ValidationException) when calling the "
            "Converse operation: prompt is too long: 203265 tokens > 200000 maximum"
        )

        with patch("main.get_bedrock_client", return_value=mock_client):
            resp = _run(main.handle_anthropic_non_streaming(body, "req-val"))

        assert resp.status == 400
        result = _json_body(resp)
        assert result["error"]["code"] == "context_length_exceeded"
        assert "too long" in result["error"]["message"]

    def test_generic_exception_returns_502(self):
        """Generic exceptions from Bedrock should return 502."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        mock_client = MagicMock()
        mock_client.converse.side_effect = RuntimeError("connection timeout")

        with patch("main.get_bedrock_client", return_value=mock_client):
            resp = _run(main.handle_anthropic_non_streaming(body, "req-err"))

        assert resp.status == 502
        result = _json_body(resp)
        assert result["error"]["code"] == "bedrock_error"

    def test_request_id_in_response_headers(self):
        """Response should include X-Request-ID header."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        mock_client = MagicMock()
        mock_client.converse.return_value = _make_converse_response()

        with patch("main.get_bedrock_client", return_value=mock_client):
            resp = _run(main.handle_anthropic_non_streaming(body, "req-hdr"))

        assert resp.headers["X-Request-ID"] == "req-hdr"


# ===========================================================================
# handle_anthropic_streaming
# ===========================================================================


def _make_stream_events(events):
    """Create a mock Converse stream from a list of event dicts.

    Returns a dict with a 'stream' key containing an iterable of events.
    """
    return {"stream": iter(events)}


class TestHandleAnthropicStreaming:
    """Verify handle_anthropic_streaming covers key event types."""

    def _make_stream_request(self):
        """Create a mock request suitable for streaming handler."""
        req = MagicMock()
        req.get = MagicMock(
            side_effect=lambda k, d=None: {
                "user_sub": "",
                "user_email": "",
            }.get(k, d)
        )
        return req

    def test_basic_text_stream(self):
        """Basic text stream should produce SSE events with content."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        events = [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockDelta": {"delta": {"text": "Hello"}}},
            {"contentBlockDelta": {"delta": {"text": " world"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5}}},
        ]
        mock_client = MagicMock()
        mock_client.converse_stream.return_value = _make_stream_events(events)

        req = self._make_stream_request()
        # Capture what gets written to the StreamResponse
        written_chunks = []
        original_prepare = web.StreamResponse.prepare

        with (
            patch("main.get_bedrock_client", return_value=mock_client),
            patch.object(web.StreamResponse, "prepare", new_callable=AsyncMock),
            patch.object(
                web.StreamResponse,
                "write",
                new_callable=AsyncMock,
                side_effect=lambda data: written_chunks.append(data),
            ),
            patch.object(web.StreamResponse, "write_eof", new_callable=AsyncMock),
        ):
            resp = _run(main.handle_anthropic_streaming(body, "req-stream", req))

        # Parse the SSE frames
        sse_data = []
        for chunk in written_chunks:
            text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
            for line in text.strip().split("\n"):
                if line.startswith("data: ") and line != "data: [DONE]":
                    sse_data.append(json.loads(line[6:]))

        # Should have: role chunk, 2 content chunks, stop chunk, usage chunk
        content_chunks = [
            d
            for d in sse_data
            if d.get("choices", [{}])[0].get("delta", {}).get("content")
        ]
        assert len(content_chunks) == 2
        assert content_chunks[0]["choices"][0]["delta"]["content"] == "Hello"
        assert content_chunks[1]["choices"][0]["delta"]["content"] == " world"

        # Verify stop reason
        stop_chunks = [
            d for d in sse_data if d.get("choices", [{}])[0].get("finish_reason")
        ]
        assert len(stop_chunks) >= 1
        assert stop_chunks[0]["choices"][0]["finish_reason"] == "stop"

    def test_tool_use_stream(self):
        """Tool use events should produce tool_calls deltas."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Weather?"}],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "Get weather",
                        "parameters": {"type": "object"},
                    },
                }
            ],
        }
        events = [
            {"messageStart": {"role": "assistant"}},
            {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "call_1", "name": "get_weather"}}
                }
            },
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"city":'}}}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '"Seattle"}'}}}},
            {"messageStop": {"stopReason": "tool_use"}},
            {"metadata": {"usage": {"inputTokens": 20, "outputTokens": 10}}},
        ]
        mock_client = MagicMock()
        mock_client.converse_stream.return_value = _make_stream_events(events)

        req = self._make_stream_request()
        written_chunks = []

        with (
            patch("main.get_bedrock_client", return_value=mock_client),
            patch.object(web.StreamResponse, "prepare", new_callable=AsyncMock),
            patch.object(
                web.StreamResponse,
                "write",
                new_callable=AsyncMock,
                side_effect=lambda data: written_chunks.append(data),
            ),
            patch.object(web.StreamResponse, "write_eof", new_callable=AsyncMock),
        ):
            resp = _run(main.handle_anthropic_streaming(body, "req-tool", req))

        sse_data = []
        for chunk in written_chunks:
            text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
            for line in text.strip().split("\n"):
                if line.startswith("data: ") and line != "data: [DONE]":
                    sse_data.append(json.loads(line[6:]))

        # Find tool call chunks
        tool_chunks = [
            d
            for d in sse_data
            if d.get("choices", [{}])[0].get("delta", {}).get("tool_calls")
        ]
        assert len(tool_chunks) >= 1
        # First tool chunk should have tool name
        first_tool = tool_chunks[0]["choices"][0]["delta"]["tool_calls"][0]
        assert first_tool["function"]["name"] == "get_weather"

        # Stop reason should be tool_calls
        stop_chunks = [
            d for d in sse_data if d.get("choices", [{}])[0].get("finish_reason")
        ]
        assert stop_chunks[0]["choices"][0]["finish_reason"] == "tool_calls"

    def test_empty_stream_returns_done(self):
        """If stream has no events, should still send [DONE]."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        mock_client = MagicMock()
        mock_client.converse_stream.return_value = {"stream": None}

        req = self._make_stream_request()
        written_chunks = []

        with (
            patch("main.get_bedrock_client", return_value=mock_client),
            patch.object(web.StreamResponse, "prepare", new_callable=AsyncMock),
            patch.object(
                web.StreamResponse,
                "write",
                new_callable=AsyncMock,
                side_effect=lambda data: written_chunks.append(data),
            ),
            patch.object(web.StreamResponse, "write_eof", new_callable=AsyncMock),
        ):
            resp = _run(main.handle_anthropic_streaming(body, "req-empty", req))

        # Should have sent [DONE]
        done_found = any(b"[DONE]" in chunk for chunk in written_chunks)
        assert done_found

    def test_validation_exception_sends_error_sse(self):
        """ValidationException should be sent as an SSE error frame."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        mock_client = MagicMock()
        mock_client.converse_stream.side_effect = _ValidationException(
            "An error occurred (ValidationException) when calling the "
            "ConverseStream operation: prompt is too long"
        )

        req = self._make_stream_request()
        written_chunks = []

        with (
            patch("main.get_bedrock_client", return_value=mock_client),
            patch.object(web.StreamResponse, "prepare", new_callable=AsyncMock),
            patch.object(
                web.StreamResponse,
                "write",
                new_callable=AsyncMock,
                side_effect=lambda data: written_chunks.append(data),
            ),
            patch.object(web.StreamResponse, "write_eof", new_callable=AsyncMock),
        ):
            resp = _run(main.handle_anthropic_streaming(body, "req-val", req))

        # Should have an error frame
        sse_data = []
        for chunk in written_chunks:
            text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
            for line in text.strip().split("\n"):
                if line.startswith("data: ") and line != "data: [DONE]":
                    try:
                        sse_data.append(json.loads(line[6:]))
                    except json.JSONDecodeError:
                        pass

        error_frames = [d for d in sse_data if "error" in d]
        assert len(error_frames) >= 1
        assert error_frames[0]["error"]["code"] == "context_length_exceeded"
        assert "too long" in error_frames[0]["error"]["message"]

    def test_generic_exception_sends_error_sse(self):
        """Generic exceptions should be sent as SSE error frame with server_error type."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        mock_client = MagicMock()
        mock_client.converse_stream.side_effect = RuntimeError("connection lost")

        req = self._make_stream_request()
        written_chunks = []

        with (
            patch("main.get_bedrock_client", return_value=mock_client),
            patch.object(web.StreamResponse, "prepare", new_callable=AsyncMock),
            patch.object(
                web.StreamResponse,
                "write",
                new_callable=AsyncMock,
                side_effect=lambda data: written_chunks.append(data),
            ),
            patch.object(web.StreamResponse, "write_eof", new_callable=AsyncMock),
        ):
            resp = _run(main.handle_anthropic_streaming(body, "req-gen-err", req))

        sse_data = []
        for chunk in written_chunks:
            text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
            for line in text.strip().split("\n"):
                if line.startswith("data: ") and line != "data: [DONE]":
                    try:
                        sse_data.append(json.loads(line[6:]))
                    except json.JSONDecodeError:
                        pass

        error_frames = [d for d in sse_data if "error" in d]
        assert len(error_frames) >= 1
        assert error_frames[0]["error"]["code"] == "bedrock_error"

    def test_reasoning_content_stream(self):
        """Extended thinking (reasoningContent) should produce reasoning_content deltas."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Think about this"}],
        }
        events = [
            {"messageStart": {"role": "assistant"}},
            {
                "contentBlockDelta": {
                    "delta": {"reasoningContent": {"text": "Let me think..."}}
                }
            },
            {"contentBlockDelta": {"delta": {"text": "Here's my answer."}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 15, "outputTokens": 10}}},
        ]
        mock_client = MagicMock()
        mock_client.converse_stream.return_value = _make_stream_events(events)

        req = self._make_stream_request()
        written_chunks = []

        with (
            patch("main.get_bedrock_client", return_value=mock_client),
            patch.object(web.StreamResponse, "prepare", new_callable=AsyncMock),
            patch.object(
                web.StreamResponse,
                "write",
                new_callable=AsyncMock,
                side_effect=lambda data: written_chunks.append(data),
            ),
            patch.object(web.StreamResponse, "write_eof", new_callable=AsyncMock),
        ):
            resp = _run(main.handle_anthropic_streaming(body, "req-reason", req))

        sse_data = []
        for chunk in written_chunks:
            text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
            for line in text.strip().split("\n"):
                if line.startswith("data: ") and line != "data: [DONE]":
                    try:
                        sse_data.append(json.loads(line[6:]))
                    except json.JSONDecodeError:
                        pass

        reasoning_chunks = [
            d
            for d in sse_data
            if d.get("choices", [{}])[0].get("delta", {}).get("reasoning_content")
        ]
        assert len(reasoning_chunks) >= 1
        assert (
            reasoning_chunks[0]["choices"][0]["delta"]["reasoning_content"]
            == "Let me think..."
        )

    def test_usage_in_metadata_event(self):
        """Metadata event should produce a usage SSE chunk."""
        import main

        body = {
            "model": "us.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": "Hi"}],
        }
        events = [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockDelta": {"delta": {"text": "Hi"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {
                "metadata": {
                    "usage": {
                        "inputTokens": 50,
                        "outputTokens": 25,
                        "cacheReadInputTokens": 40,
                        "cacheWriteInputTokens": 0,
                    }
                }
            },
        ]
        mock_client = MagicMock()
        mock_client.converse_stream.return_value = _make_stream_events(events)

        req = self._make_stream_request()
        written_chunks = []

        with (
            patch("main.get_bedrock_client", return_value=mock_client),
            patch.object(web.StreamResponse, "prepare", new_callable=AsyncMock),
            patch.object(
                web.StreamResponse,
                "write",
                new_callable=AsyncMock,
                side_effect=lambda data: written_chunks.append(data),
            ),
            patch.object(web.StreamResponse, "write_eof", new_callable=AsyncMock),
        ):
            resp = _run(main.handle_anthropic_streaming(body, "req-usage", req))

        sse_data = []
        for chunk in written_chunks:
            text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
            for line in text.strip().split("\n"):
                if line.startswith("data: ") and line != "data: [DONE]":
                    try:
                        sse_data.append(json.loads(line[6:]))
                    except json.JSONDecodeError:
                        pass

        usage_chunks = [d for d in sse_data if d.get("usage")]
        assert len(usage_chunks) >= 1
        assert (
            usage_chunks[0]["usage"]["prompt_tokens"] == 90
        )  # 50 (non-cached) + 40 (cache_read)
        assert usage_chunks[0]["usage"]["completion_tokens"] == 25
        assert usage_chunks[0]["usage"]["cache_read_input_tokens"] == 40
