"""
test_b2trading_inspector.py - Suíte de Testes Unitários de Segurança e Classificação
Valida todas as regras de sanitização, integridade de dados e segurança do b2trading_inspector.
"""

from __future__ import annotations

import json
from pathlib import Path
import pytest
import shutil

from b2trading_inspector import (
    B2TradingInspector,
    InspectionOutputManager,
    SanitizationEngine,
    TrafficClassifier,
)


class TestSanitizationEngine:
    """Testes de sanitização estática e dinâmica para evitar vazamento de credenciais."""

    def test_sanitize_url_with_token(self):
        """1. Testa mascaramento de parâmetros de query com token na URL."""
        url = "https://traderoom.b2trading.io/ws?token=secret12345&access_token=xyz987&asset=EURUSD"
        sanitized, redactions = SanitizationEngine.sanitize_url(url)

        assert "secret12345" not in sanitized
        assert "xyz987" not in sanitized
        assert "token=[TOKEN_REDACTED]" in sanitized
        assert "access_token=[TOKEN_REDACTED]" in sanitized
        assert "asset=EURUSD" in sanitized
        assert "query_token" in redactions

    def test_sanitize_jwt(self):
        """2. Testa mascaramento de tokens JWT padrão 'eyJ...'."""
        sample_jwt = (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ."
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        )
        text = f"User connected with payload: {sample_jwt} at timestamp 123"
        sanitized, redactions = SanitizationEngine.sanitize_text(text)

        assert sample_jwt not in sanitized
        assert "[JWT_REDACTED]" in sanitized
        assert "jwt" in redactions

    def test_sanitize_authorization_bearer(self):
        """3. Testa remoção de cabeçalhos Authorization Bearer."""
        auth_header_raw = "Authorization: Bearer mySecretTokenLongString12345"
        sanitized, redactions = SanitizationEngine.sanitize_text(auth_header_raw)

        assert "mySecretTokenLongString12345" not in sanitized
        assert "[TOKEN_REDACTED]" in sanitized or "[AUTH_REDACTED]" in sanitized
        assert any(r in redactions for r in ["bearer_token", "auth_header"])

    def test_sanitize_cookie_headers_and_fields(self):
        """4. Testa mascaramento de cabeçalhos e campos de Cookie e Set-Cookie."""
        cookie_text = "Cookie: session_id=abc12345; remember_me=true"
        sanitized, redactions = SanitizationEngine.sanitize_text(cookie_text)

        assert "session_id=abc12345" not in sanitized
        assert "[COOKIE_REDACTED]" in sanitized
        assert "cookie_header" in redactions

        json_cookie = '{"set-cookie": "token=ultra_secret_cookie_val; path=/"}'
        sanitized_json, red_json = SanitizationEngine.sanitize_text(json_cookie)
        assert "ultra_secret_cookie_val" not in sanitized_json
        assert "[COOKIE_REDACTED]" in sanitized_json
        assert "cookie_field" in red_json

    def test_sanitize_json_with_sensitive_fields(self):
        """5. Testa mascaramento em JSON de senhas, e-mails e tokens."""
        raw_json_str = json.dumps({
            "email": "trader.quant@millionbots.com",
            "password": "SuperSecretPassword#2026",
            "token": "tok_live_9988776655443322",
            "symbol": "BTCUSD"
        })
        sanitized, redactions = SanitizationEngine.sanitize_text(raw_json_str)

        assert "SuperSecretPassword#2026" not in sanitized
        assert "trader.quant@millionbots.com" not in sanitized
        assert "tok_live_9988776655443322" not in sanitized
        assert "[PASSWORD_REDACTED]" in sanitized
        assert "[EMAIL_REDACTED]" in sanitized
        assert "[TOKEN_REDACTED]" in sanitized
        assert "BTCUSD" in sanitized  # Dados de mercado legítimos permanecem intactos


class TestTrafficClassifier:
    """Testes de classificação de URLs e payloads de mercado."""

    def test_payload_with_ohlc(self):
        """6. Testa payload contendo open, high, low, close e volume."""
        payload = {
            "event": "candle_update",
            "symbol": "EURUSD",
            "resolution": "1",
            "data": {
                "time": 1727010180000,
                "open": 1.08520,
                "high": 1.08565,
                "low": 1.08510,
                "close": 1.08542,
                "volume": 142.5
            }
        }
        res = TrafficClassifier.classify_payload(payload)

        assert res["likely_market_data"] is True
        assert res["symbol_detected"] == "EURUSD"
        assert set(["open", "high", "low", "close"]).issubset(set(res["keys_found"]))
        assert any("Conjunto OHLC detectado" in ev for ev in res["evidence"])

    def test_payload_price_only_not_candle(self):
        """Regra de ouro: Não afirmar que algo é candle apenas porque contém um preço isolado."""
        payload = {
            "action": "fee_calculation",
            "price": 25.50
        }
        res = TrafficClassifier.classify_payload(payload)

        assert res["likely_market_data"] is False
        assert "price" in res["keys_found"]
        assert any("insuficiente para confirmar" in ev for ev in res["evidence"])

    def test_binary_arraybuffer_hex_preview(self):
        """7. Testa tratamento de payload binário (ArrayBuffer / bytes) gerando hex preview."""
        binary_data = bytes([0x1F, 0x8B, 0x08, 0x00, 0xDE, 0xAD, 0xBE, 0xEF])
        res = TrafficClassifier.classify_payload(binary_data)

        # Não deve estourar erro
        assert isinstance(res, dict)
        assert res["likely_market_data"] is False

    def test_classify_url_chart_iframe(self):
        """8. Testa classificação da URL do iframe chart.b2trading.io."""
        chart_url = "https://chart.b2trading.io/charting_library/static/bundles/library.js"
        classification = TrafficClassifier.classify_url(chart_url)
        assert classification == "chart"

        history_url = "https://chart.b2trading.io/charting_library/history?symbol=EURUSD&resolution=1"
        assert TrafficClassifier.classify_url(history_url) == "history"

    def test_classify_all_url_categories(self):
        """Testa cobertura das 10 categorias de classificação."""
        assert TrafficClassifier.classify_url("wss://traderoom.b2trading.io/ws") == "websocket"
        assert TrafficClassifier.classify_url("https://restapi.b2trading.io/api/v1/market/history") == "history"
        assert TrafficClassifier.classify_url("https://traderoom.b2trading.io/api/candles") == "candle"
        assert TrafficClassifier.classify_url("https://traderoom.b2trading.io/api/quote/latest") == "quote"
        assert TrafficClassifier.classify_url("https://traderoom.b2trading.io/api/ticks") == "tick"
        assert TrafficClassifier.classify_url("https://restapi.b2trading.io/api/v1/market/symbols") == "market"
        assert TrafficClassifier.classify_url("https://chart.b2trading.io/chart") == "chart"
        assert TrafficClassifier.classify_url("https://traderoom.b2trading.io/api/indicator-state") == "indicator"
        assert TrafficClassifier.classify_url("https://traderoom.b2trading.io/auth/login") == "auth_or_sensitive"
        assert TrafficClassifier.classify_url("https://traderoom.b2trading.io/favicon.ico") == "other"


class TestOutputAndHashing:
    """Testes de consistência de saída e anonimização de WebSocket."""

    def test_ws_hash_does_not_contain_token(self):
        """Garante que a identificação de conexões WebSocket não expõe tokens no hash."""
        inspector = B2TradingInspector(
            url="https://traderoom.b2trading.io/",
            profile_dir="./test-profile",
            output_dir="./test-output",
        )
        url_with_token1 = "wss://traderoom.b2trading.io/ws?token=SECRET_TOKEN_ABC_111"
        url_with_token2 = "wss://traderoom.b2trading.io/ws?token=SECRET_TOKEN_XYZ_999"

        hash1 = inspector._hash_ws_url(url_with_token1)
        hash2 = inspector._hash_ws_url(url_with_token2)

        # Como as URLs são sanitizadas para wss://.../ws?token=[TOKEN_REDACTED],
        # o hash resultante é estável e NÃO depende nem vaza o valor original do token!
        assert hash1 == hash2
        assert len(hash1) == 12

    @pytest.mark.asyncio
    async def test_output_manager_files_generation(self, tmp_path: Path):
        """Testa geração de todos os arquivos de saída no diretório temporário."""
        mgr = InspectionOutputManager(tmp_path)

        # Verifica README gerado
        readme_path = tmp_path / "README.txt"
        assert readme_path.exists()
        assert "SOMENTE LEITURA" in readme_path.read_text(encoding="utf-8")

        # Grava um evento
        await mgr.record_event(
            event_type="http_response",
            source="network_response",
            url="https://restapi.b2trading.io/api/v1/market/history?token=123",
            frame_url="https://chart.b2trading.io/",
            classification="history",
            data={"status": 200, "symbol_detected": "EURUSD"},
            is_relevant=True,
        )

        # Registra frame e WebSocket
        mgr.register_frame("chart_iframe", "https://chart.b2trading.io/", "https://traderoom.b2trading.io/")
        mgr.register_ws_connection("conn_test_01", "wss://traderoom.b2trading.io/ws")
        mgr.register_ws_frame("conn_test_01", "received", 128, symbol="EURUSD", is_market=True)
        mgr.flush_summaries()

        # Valida arquivos gerados
        events_lines = (tmp_path / "events.jsonl").read_text(encoding="utf-8").strip().splitlines()
        assert len(events_lines) == 1
        ev = json.loads(events_lines[0])
        assert ev["data"]["symbol_detected"] == "EURUSD"
        assert "token=123" not in ev["url"]
        assert "token=[TOKEN_REDACTED]" in ev["url"]

        relevant_lines = (tmp_path / "relevant-events.jsonl").read_text(encoding="utf-8").strip().splitlines()
        assert len(relevant_lines) == 1

        summary_data = json.loads((tmp_path / "summary.json").read_text(encoding="utf-8"))
        assert summary_data["last_detected_symbol"] == "EURUSD"
        assert "EURUSD" in summary_data["detected_symbols"]

        frames_data = json.loads((tmp_path / "frames.json").read_text(encoding="utf-8"))
        assert len(frames_data) == 1
        assert frames_data[0]["is_chart_frame"] is True

        ws_data = json.loads((tmp_path / "websocket-summary.json").read_text(encoding="utf-8"))
        assert len(ws_data) == 1
        assert ws_data[0]["conn_id"] == "conn_test_01"
