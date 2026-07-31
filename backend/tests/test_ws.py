"""WebSocket session control-plane tests (no live provider calls)."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_ws_connect_and_ping():
    with client.websocket_connect("/ws/session") as ws:
        hello = ws.receive_json()
        assert hello == {"type": "status", "state": "connected"}
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_ws_init_reports_ready():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()  # connected
        ws.send_json({
            "type": "init",
            "provider": "anthropic",
            "model": "claude-3-5-sonnet-20241022",
            "apiKey": "sk-ant-test",
        })
        status = ws.receive_json()
        assert status["state"] == "ready"
        assert status["provider"] == "anthropic"


def test_ws_frame_ack():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json({"type": "frame", "data": "QUJD"})
        assert ws.receive_json()["state"] == "frame_received"


def test_ws_prompt_without_init_errors():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json({"type": "prompt", "text": "hi"})
        err = ws.receive_json()
        assert err["type"] == "error"


def test_ws_unknown_type_errors():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json({"type": "bogus"})
        assert ws.receive_json()["type"] == "error"


def test_ws_malformed_json_is_reported_not_fatal():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_text("{not json")
        err = ws.receive_json()
        assert err["type"] == "error"
        # Session survives — a subsequent valid message still works.
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_ws_non_object_message_rejected():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json([1, 2, 3])
        assert ws.receive_json()["type"] == "error"


def test_ws_oversized_frame_rejected():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json({"type": "frame", "data": "A" * 12_000_001})
        assert ws.receive_json()["type"] == "error"


def test_ws_init_unknown_provider_errors():
    with client.websocket_connect("/ws/session") as ws:
        ws.receive_json()
        ws.send_json({"type": "init", "provider": "bogus", "model": "x", "apiKey": "k"})
        # First an error, then a status with state "error".
        first = ws.receive_json()
        assert first["type"] == "error"
        status = ws.receive_json()
        assert status["state"] == "error"
