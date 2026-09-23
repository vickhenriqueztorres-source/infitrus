#!/usr/bin/env python3
"""
b2trading_inspector.py - Ferramenta Local de Diagnóstico e Inspeção de Mercado
Plataforma Alvo: https://traderoom.b2trading.io/

PROPÓSITO:
- Observador de rede e DOM em modo estritamente SOMENTE LEITURA (Read-Only).
- Captura requisições HTTP, Fetch, XHR, WebSockets, iframes e elementos do gráfico.
- Identifica feeds de cotações em tempo real e endpoints de histórico (OHLC / getBars / subscribeBars).
- Sanitiza dados confidenciais (tokens, JWT, cookies, e-mails, credenciais).
- Grava eventos em JSON e JSONL estruturados.

GARANTIAS DE SEGURANÇA INVIOLÁVEIS:
- NUNCA clica nos botões BUY ou SELL (#btnBuy, #btnSell).
- NUNCA altera ou preenche valores de negociação (#amountInput).
- NUNCA chama WebSocket.send() ou injeta frames.
- NUNCA faz chamadas ou replays de API para a corretora.
- NUNCA armazena ou expõe senhas, JWTs ou cookies de sessão.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import logging
from pathlib import Path
import re
import sys
from typing import Any, Dict, List, Optional, Set, Tuple
import uuid

# Garante suporte adequado a UTF-8 em consoles Windows sem quebrar em emojis
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from playwright.async_api import (
    BrowserContext,
    Frame,
    Page,
    Playwright,
    Request,
    Response,
    WebSocket,
    async_playwright,
)

# Palavras-chave de interesse para identificação de tráfego de mercado
MARKET_KEYWORDS: list[str] = [
    "candle",
    "candles",
    "tick",
    "ticks",
    "price",
    "quote",
    "quotes",
    "ohlc",
    "bar",
    "bars",
    "history",
    "market",
    "chart",
    "stream",
    "socket",
    "getbars",
    "subscribebars",
    "indicator-state",
]

# Expressões regulares compiladas para sanitização rigorosa
RE_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
RE_BEARER = re.compile(r"(?i)\b(bearer\s+)([A-Za-z0-9_\-\.\~]{10,})\b")
RE_URL_TOKEN_PARAM = re.compile(
    r"([?&](?:token|access_token|refresh_token|jwt|auth|api_key|apikey|session|sessionId)=)([^&\s#]+)"
)
RE_JSON_TOKEN_FIELDS = re.compile(
    r'(?i)(["\']?(?:token|access_token|refresh_token|auth_token|authToken)["\']?\s*[:=]\s*["\'])([^"\']*)(["\'])'
)
RE_PASSWORD_FIELDS = re.compile(
    r'(?i)(["\']?(?:password|passwd|pwd|secret|client_secret)["\']?\s*[:=]\s*["\'])([^"\']*)(["\'])'
)
RE_COOKIE_HEADER = re.compile(
    r'(?i)(["\']?(?:cookie|set-cookie)["\']?\s*[:=]\s*["\'])([^"\']*)(["\'])'
)
RE_RAW_COOKIE_LINE = re.compile(
    r"(?i)\b(set-cookie|cookie):\s*([^\r\n]+)"
)
RE_RAW_AUTH_LINE = re.compile(
    r"(?i)\b(authorization):\s*([^\r\n]+)"
)
RE_JSON_AUTH_FIELDS = re.compile(
    r'(?i)(["\']?authorization["\']?\s*[:=]\s*["\'])([^"\']*)(["\'])'
)
RE_EMAIL = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
)


class SanitizationEngine:
    """Motor de sanitização estática e dinâmica para evitar vazamento de credenciais."""

    @staticmethod
    def sanitize_text(text: str) -> tuple[str, list[str]]:
        """Remove e mascara tokens, JWTs, senhas, cookies e emails de textos ou JSONs."""
        if not text:
            return "", []

        redactions: list[str] = []
        result = text

        # 1. JWT (tokens que começam com eyJ...)
        if RE_JWT.search(result):
            result = RE_JWT.sub("[JWT_REDACTED]", result)
            redactions.append("jwt")

        # 2. Bearer Tokens
        if RE_BEARER.search(result):
            result = RE_BEARER.sub(r"\g<1>[TOKEN_REDACTED]", result)
            redactions.append("bearer_token")

        # 3. Query string tokens em URLs contidas no texto
        if RE_URL_TOKEN_PARAM.search(result):
            result = RE_URL_TOKEN_PARAM.sub(r"\g<1>[TOKEN_REDACTED]", result)
            redactions.append("query_token")

        # 4. Campos JSON com chave de token
        if RE_JSON_TOKEN_FIELDS.search(result):
            result = RE_JSON_TOKEN_FIELDS.sub(r"\g<1>[TOKEN_REDACTED]\g<3>", result)
            redactions.append("json_token")

        # 5. Senhas e campos de senha
        if RE_PASSWORD_FIELDS.search(result):
            result = RE_PASSWORD_FIELDS.sub(r"\g<1>[PASSWORD_REDACTED]\g<3>", result)
            redactions.append("password")

        # 6. Headers e campos de Cookies
        if RE_RAW_COOKIE_LINE.search(result):
            result = RE_RAW_COOKIE_LINE.sub(r"\g<1>: [COOKIE_REDACTED]", result)
            redactions.append("cookie_header")
        if RE_COOKIE_HEADER.search(result):
            result = RE_COOKIE_HEADER.sub(r"\g<1>[COOKIE_REDACTED]\g<3>", result)
            redactions.append("cookie_field")

        # 7. Headers e campos de Authorization
        if RE_RAW_AUTH_LINE.search(result):
            result = RE_RAW_AUTH_LINE.sub(r"\g<1>: [AUTH_REDACTED]", result)
            redactions.append("auth_header")
        if RE_JSON_AUTH_FIELDS.search(result):
            result = RE_JSON_AUTH_FIELDS.sub(r"\g<1>[AUTH_REDACTED]\g<3>", result)
            redactions.append("auth_field")

        # 8. E-mails
        if RE_EMAIL.search(result):
            result = RE_EMAIL.sub("[EMAIL_REDACTED]", result)
            redactions.append("email")

        return result, redactions

    @classmethod
    def sanitize_url(cls, url: str) -> tuple[str, list[str]]:
        """Sanitiza especificamente strings de URL."""
        if not url:
            return "", []
        return cls.sanitize_text(url)


class TrafficClassifier:
    """Classificador de endpoints, métodos e payloads de rede."""

    @staticmethod
    def classify_url(url: str) -> str:
        """Classifica uma URL de acordo com as categorias estabelecidas."""
        if not url:
            return "other"
        
        u = url.lower()

        # Sensível ou autenticação tem prioridade para descarte/cuidado
        if any(term in u for term in ["/auth", "/login", "/oauth", "/token", "/session", "/credentials", "/user/profile"]):
            return "auth_or_sensitive"

        # WebSockets
        if u.startswith(("ws://", "wss://")) or "/ws" in u or "/socket" in u or "/stream" in u:
            return "websocket"

        # Candles específicos
        if "candle" in u or "candles" in u:
            return "candle"

        # Ticks
        if "tick" in u or "ticks" in u:
            return "tick"

        # Quotes / Cotações
        if "quote" in u or "quotes" in u:
            return "quote"

        # Histórico de barras e TradingView datafeed
        if any(term in u for term in ["/history", "getbars", "/bars", "ohlc"]):
            return "history"

        # Indicadores
        if "indicator" in u or "indicator-state" in u:
            return "indicator"

        # Componentes do gráfico e iframe
        if any(term in u for term in ["charting_library", "chart.b2trading.io", "/chart"]):
            return "chart"

        # Informações gerais de mercado / ativos
        if any(term in u for term in ["/market", "/symbols", "/pairs"]):
            return "market"

        return "other"

    @staticmethod
    def classify_payload(payload: Any) -> dict[str, Any]:
        """
        Analisa e classifica o conteúdo de um payload textual ou JSON.
        Procura recursivamente termos de mercado como open, high, low, close, volume, etc.
        Garante que apenas ter 'price' NÃO seja rotulado como candle sem evidências adicionais.
        """
        result: dict[str, Any] = {
            "keys_found": [],
            "value_types": {},
            "symbol_detected": None,
            "likely_market_data": False,
            "evidence": [],
            "preview": "",
        }

        if payload is None:
            return result

        raw_str = ""
        parsed_json: Any = None

        if isinstance(payload, bytes):
            try:
                raw_str = payload.decode("utf-8", errors="replace")
            except Exception:
                raw_str = f"<binary {len(payload)} bytes>"
        elif isinstance(payload, str):
            raw_str = payload
        elif isinstance(payload, (dict, list)):
            parsed_json = payload
            try:
                raw_str = json.dumps(payload)
            except Exception:
                raw_str = str(payload)

        # Tentativa de parse JSON se ainda for string
        if parsed_json is None and raw_str:
            stripped = raw_str.strip()
            if (stripped.startswith("{") and stripped.endswith("}")) or (
                stripped.startswith("[") and stripped.endswith("]")
            ):
                try:
                    parsed_json = json.loads(stripped)
                except Exception:
                    parsed_json = None

        # Varredura recursiva de chaves se for JSON
        keys_found_set: set[str] = set()
        val_types: dict[str, str] = {}
        detected_symbols: list[str] = []

        target_keys = {
            "open",
            "high",
            "low",
            "close",
            "volume",
            "timestamp",
            "time",
            "price",
            "symbol",
            "pair",
            "resolution",
            "timeframe",
            "candle",
            "ohlc",
            "bars",
        }

        def _traverse(node: Any, depth: int = 0) -> None:
            if depth > 10:  # Limite de profundidade para evitar recursão infinita
                return
            if isinstance(node, dict):
                for k, v in node.items():
                    k_lower = str(k).lower()
                    if k_lower in target_keys:
                        keys_found_set.add(k_lower)
                        if k_lower not in val_types:
                            val_types[k_lower] = type(v).__name__
                        if k_lower in ("symbol", "pair") and isinstance(v, str) and v:
                            detected_symbols.append(v.upper())
                    # Caso de valor que seja nome de evento
                    if k_lower == "event" and isinstance(v, str):
                        v_lower = v.lower()
                        if any(kw in v_lower for kw in ["candle", "bar", "tick", "quote"]):
                            keys_found_set.add(f"event:{v}")
                    _traverse(v, depth + 1)
            elif isinstance(node, list):
                for item in node[:20]:  # Limita amostragem de listas longas
                    _traverse(item, depth + 1)

        if parsed_json is not None:
            _traverse(parsed_json)
        else:
            # Varredura por texto plano
            lower_text = raw_str.lower()
            for tk in target_keys:
                if re.search(rf"\b{re.escape(tk)}\b", lower_text):
                    keys_found_set.add(tk)

        result["keys_found"] = sorted(list(keys_found_set))
        result["value_types"] = val_types
        if detected_symbols:
            result["symbol_detected"] = detected_symbols[0]

        # Análise de Evidências Estatísticas/Mercadológicas
        evidence: list[str] = []
        ohlc_keys = {"open", "high", "low", "close"}
        found_ohlc = ohlc_keys.intersection(keys_found_set)

        if len(found_ohlc) >= 3:
            evidence.append(f"Conjunto OHLC detectado: {sorted(list(found_ohlc))}")

        if any(k in keys_found_set for k in ["candle", "ohlc", "bars"]):
            evidence.append("Presença explícita de chaves/termos de velas (candle/bars/ohlc)")

        if any(k in keys_found_set for k in ["resolution", "timeframe"]):
            evidence.append("Chave de granularidade temporal (resolution/timeframe)")

        if any(k.startswith("event:") for k in keys_found_set):
            evidence.append(f"Evento com nomenclatura de mercado: {[k for k in keys_found_set if k.startswith('event:')]}")

        if ("price" in keys_found_set or "tick" in keys_found_set) and any(
            t in keys_found_set for t in ["time", "timestamp"]
        ) and any(s in keys_found_set for s in ["symbol", "pair"]):
            evidence.append("Cotação em tempo real combinando preço, ativo e timestamp")

        # Regra de Segurança: Não afirmar que algo é candle apenas porque contém 'price'
        likely_market = False
        if len(found_ohlc) >= 3 or any(k in keys_found_set for k in ["candle", "ohlc", "bars"]):
            likely_market = True
        elif "price" in keys_found_set and ("symbol" in keys_found_set or "pair" in keys_found_set) and ("time" in keys_found_set or "timestamp" in keys_found_set):
            likely_market = True
        elif "price" in keys_found_set and not evidence:
            evidence.append("Contém termo 'price', porém insuficiente para confirmar dados de candle/mercado")

        result["likely_market_data"] = likely_market
        result["evidence"] = evidence

        # Sanitiza pré-visualização (máx 500 caracteres para preview estrutural)
        preview_text, _ = SanitizationEngine.sanitize_text(raw_str[:500])
        result["preview"] = preview_text

        return result


class InspectionOutputManager:
    """Gerencia a persistência assíncrona/atômica de arquivos e estatísticas."""

    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.events_file = self.output_dir / "events.jsonl"
        self.relevant_events_file = self.output_dir / "relevant-events.jsonl"
        self.summary_file = self.output_dir / "summary.json"
        self.frames_file = self.output_dir / "frames.json"
        self.ws_summary_file = self.output_dir / "websocket-summary.json"
        self.readme_file = self.output_dir / "README.txt"
        self.errors_file = self.output_dir / "errors.log"

        self.start_time = datetime.now(timezone.utc)
        self.stats = {
            "start_time": self.start_time.isoformat(),
            "end_time": None,
            "duration_seconds": 0,
            "total_requests": 0,
            "total_responses": 0,
            "failed_requests": 0,
            "relevant_responses": 0,
            "total_ws_connections": 0,
            "ws_frames_received": 0,
            "ws_frames_sent": 0,
            "detected_symbols": [],
            "last_detected_symbol": None,
            "last_event_time": None,
        }

        self.detected_frames: dict[str, dict[str, Any]] = {}
        self.ws_connections: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

        # Criação do README de diagnóstico
        self._write_readme()

    def _write_readme(self) -> None:
        content = (
            "================================================================================\n"
            "B2TRADING INSPECTOR - ARQUIVOS DE DIAGNÓSTICO DE REDE E MERCADO\n"
            "================================================================================\n\n"
            "AVISO IMPORTANTE:\n"
            "Estes arquivos contêm exclusivamente telemetria de tráfego capturada em modo\n"
            "SOMENTE LEITURA. Nenhuma ordem de negociação foi executada ou enviada.\n"
            "Todos os tokens, credenciais, JWTs, senhas e cookies foram devidamente mascarados.\n\n"
            "ESTRUTURA DOS ARQUIVOS GERADOS:\n\n"
            "1. events.jsonl\n"
            "   - Registro completo de todos os eventos HTTP, WebSocket, Frames e DOM capturados.\n"
            "   - Formato: 1 objeto JSON válido por linha.\n\n"
            "2. relevant-events.jsonl\n"
            "   - Subconjunto filtrado contendo apenas eventos de mercado (OHLC, candles, ticks,\n"
            "     cotações em tempo real e feeds identificados com likely_market_data = true).\n\n"
            "3. summary.json\n"
            "   - Sumário estatístico global: total de requisições, conexões WebSocket ativas,\n"
            "     ativos detectados e duração da sessão.\n\n"
            "4. frames.json\n"
            "   - Lista e árvore de iframes detectados na página (traderoom, chart, restapi).\n\n"
            "5. websocket-summary.json\n"
            "   - Conexões WebSocket mapeadas por hash seguro da URL sanitizada, volumes de frames\n"
            "     e ativos identificados nos streams.\n\n"
            "6. errors.log\n"
            "   - Log de erros toleráveis de rede (timeouts, respostas abortadas, etc.).\n\n"
            "Finalidade: Engenharia reversa ética e mapeamento de feed para o projeto Oracle Quant.\n"
        )
        self.readme_file.write_text(content, encoding="utf-8")

    def log_error(self, message: str, exc: Optional[Exception] = None) -> None:
        """Registra erro no errors.log de forma segura."""
        timestamp = datetime.now(timezone.utc).isoformat()
        err_msg = f"[{timestamp}] {message}"
        if exc:
            err_msg += f" - Exceção: {type(exc).__name__}: {exc}"
        err_msg += "\n"
        try:
            with open(self.errors_file, "a", encoding="utf-8") as f:
                f.write(err_msg)
        except Exception:
            pass

    async def record_event(
        self,
        event_type: str,
        source: str,
        url: str,
        frame_url: str = "",
        classification: str = "other",
        data: Optional[dict[str, Any]] = None,
        redactions: Optional[list[str]] = None,
        is_relevant: bool = False,
    ) -> dict[str, Any]:
        """Cria e persiste um evento estruturado nos arquivos jsonl."""
        now_iso = datetime.now(timezone.utc).isoformat()
        event_id = str(uuid.uuid4())

        sanitized_url, red_url = SanitizationEngine.sanitize_url(url)
        sanitized_frame_url, red_frame = SanitizationEngine.sanitize_url(frame_url)

        all_redactions = list(set((redactions or []) + red_url + red_frame))

        event = {
            "id": event_id,
            "timestamp": now_iso,
            "event_type": event_type,
            "source": source,
            "url": sanitized_url,
            "frame_url": sanitized_frame_url,
            "classification": classification,
            "data": data or {},
            "redactions_applied": sorted(all_redactions),
        }

        # Atualiza métricas
        self.stats["last_event_time"] = now_iso
        if data and "symbol_detected" in data and data["symbol_detected"]:
            sym = data["symbol_detected"]
            self.stats["last_detected_symbol"] = sym
            if sym not in self.stats["detected_symbols"]:
                self.stats["detected_symbols"].append(sym)

        line = json.dumps(event, ensure_ascii=False) + "\n"

        async with self._lock:
            try:
                with open(self.events_file, "a", encoding="utf-8") as f:
                    f.write(line)
                if is_relevant:
                    with open(self.relevant_events_file, "a", encoding="utf-8") as f:
                        f.write(line)
            except Exception as e:
                self.log_error("Erro ao escrever evento em disco", e)

        return event

    def register_frame(self, frame_name: str, frame_url: str, parent_url: str) -> None:
        """Registra metadados de iframe detectado."""
        sanitized_url, _ = SanitizationEngine.sanitize_url(frame_url)
        sanitized_parent, _ = SanitizationEngine.sanitize_url(parent_url)

        is_target_chart = "chart.b2trading.io" in sanitized_url
        is_target_traderoom = "traderoom.b2trading.io" in sanitized_url
        is_target_restapi = "restapi.b2trading.io" in sanitized_url

        self.detected_frames[sanitized_url] = {
            "name": frame_name or "<unnamed>",
            "url": sanitized_url,
            "parent_url": sanitized_parent,
            "is_chart_frame": is_target_chart,
            "is_traderoom_frame": is_target_traderoom,
            "is_restapi_frame": is_target_restapi,
            "last_seen": datetime.now(timezone.utc).isoformat(),
        }

    def register_ws_connection(self, conn_id: str, sanitized_url: str) -> None:
        """Registra nova conexão WebSocket."""
        if conn_id not in self.ws_connections:
            self.ws_connections[conn_id] = {
                "conn_id": conn_id,
                "url": sanitized_url,
                "opened_at": datetime.now(timezone.utc).isoformat(),
                "closed_at": None,
                "frames_received": 0,
                "frames_sent": 0,
                "bytes_received": 0,
                "bytes_sent": 0,
                "detected_symbols": [],
                "likely_market_data": False,
            }
            self.stats["total_ws_connections"] = len(self.ws_connections)

    def register_ws_frame(
        self, conn_id: str, direction: str, size: int, symbol: Optional[str] = None, is_market: bool = False
    ) -> None:
        """Registra contagem de frame para a conexão WebSocket."""
        if conn_id in self.ws_connections:
            ws_meta = self.ws_connections[conn_id]
            if direction == "received":
                ws_meta["frames_received"] += 1
                ws_meta["bytes_received"] += size
                self.stats["ws_frames_received"] += 1
            else:
                ws_meta["frames_sent"] += 1
                ws_meta["bytes_sent"] += size
                self.stats["ws_frames_sent"] += 1

            if symbol and symbol not in ws_meta["detected_symbols"]:
                ws_meta["detected_symbols"].append(symbol)
            if is_market:
                ws_meta["likely_market_data"] = True

    def close_ws_connection(self, conn_id: str) -> None:
        """Marca encerramento de WebSocket."""
        if conn_id in self.ws_connections:
            self.ws_connections[conn_id]["closed_at"] = datetime.now(timezone.utc).isoformat()

    def flush_summaries(self) -> None:
        """Salva summary.json, frames.json e websocket-summary.json."""
        now = datetime.now(timezone.utc)
        self.stats["end_time"] = now.isoformat()
        self.stats["duration_seconds"] = round((now - self.start_time).total_seconds(), 2)

        try:
            with open(self.summary_file, "w", encoding="utf-8") as f:
                json.dump(self.stats, f, indent=2, ensure_ascii=False)
        except Exception as e:
            self.log_error("Erro ao salvar summary.json", e)

        try:
            with open(self.frames_file, "w", encoding="utf-8") as f:
                json.dump(list(self.detected_frames.values()), f, indent=2, ensure_ascii=False)
        except Exception as e:
            self.log_error("Erro ao salvar frames.json", e)

        try:
            with open(self.ws_summary_file, "w", encoding="utf-8") as f:
                json.dump(list(self.ws_connections.values()), f, indent=2, ensure_ascii=False)
        except Exception as e:
            self.log_error("Erro ao salvar websocket-summary.json", e)


class B2TradingInspector:
    """Coordenador principal da inspeção Playwright."""

    def __init__(
        self,
        url: str,
        profile_dir: str,
        output_dir: str,
        duration: Optional[int] = None,
        slow_mo: Optional[int] = None,
        verbose: bool = False,
        no_wait: bool = False,
    ) -> None:
        self.target_url = url
        self.profile_dir = Path(profile_dir).resolve()
        self.output_dir = Path(output_dir).resolve()
        self.duration = duration
        self.slow_mo = slow_mo
        self.verbose = verbose
        self.no_wait = no_wait

        self.output_mgr = InspectionOutputManager(self.output_dir)
        self.stop_event = asyncio.Event()

        # Logger
        self.logger = logging.getLogger("b2trading_inspector")
        self.logger.setLevel(logging.DEBUG if verbose else logging.INFO)
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s: %(message)s", "%H:%M:%S"))
        self.logger.handlers = [handler]

    def _hash_ws_url(self, raw_url: str) -> str:
        """Gera um hash estável e anônimo da URL do WebSocket (sem expor tokens)."""
        sanitized_url, _ = SanitizationEngine.sanitize_url(raw_url)
        return hashlib.sha256(sanitized_url.encode("utf-8")).hexdigest()[:12]

    async def _handle_request(self, request: Request) -> None:
        """Trata requisições HTTP enviadas pelo navegador/frames."""
        try:
            raw_url = request.url
            method = request.method
            resource_type = request.resource_type
            frame_url = request.frame.url if request.frame else ""

            sanitized_url, red_url = SanitizationEngine.sanitize_url(raw_url)
            sanitized_frame_url, red_frame = SanitizationEngine.sanitize_url(frame_url)
            classification = TrafficClassifier.classify_url(sanitized_url)

            # Sanitização do corpo post_data (limitado a 5.000 chars)
            post_data_sanitized = ""
            red_post: list[str] = []
            try:
                raw_post = request.post_data
                if raw_post:
                    post_data_sanitized, red_post = SanitizationEngine.sanitize_text(raw_post[:5000])
            except Exception:
                post_data_sanitized = "<unreadable_post_data>"

            data = {
                "method": method,
                "resource_type": resource_type,
                "post_data": post_data_sanitized if post_data_sanitized else None,
            }

            self.output_mgr.stats["total_requests"] += 1
            await self.output_mgr.record_event(
                event_type="http_request",
                source="network_request",
                url=raw_url,
                frame_url=frame_url,
                classification=classification,
                data=data,
                redactions=red_url + red_frame + red_post,
            )

            if self.verbose:
                self.logger.debug(f"HTTP Req: {method} {resource_type} -> {sanitized_url[:80]}")
        except Exception as e:
            self.output_mgr.log_error("Erro no manipulador de request", e)

    async def _handle_response(self, response: Response) -> None:
        """Trata respostas HTTP recebidas pelo navegador/frames."""
        try:
            raw_url = response.url
            status = response.status
            headers = response.headers
            content_type = headers.get("content-type", "")
            frame_url = response.frame.url if response.frame else ""

            sanitized_url, red_url = SanitizationEngine.sanitize_url(raw_url)
            sanitized_frame_url, red_frame = SanitizationEngine.sanitize_url(frame_url)
            url_classification = TrafficClassifier.classify_url(sanitized_url)

            # Verifica se é candidata a dados de mercado
            url_lower = sanitized_url.lower()
            is_market_candidate = any(kw in url_lower for kw in MARKET_KEYWORDS)

            body_preview = ""
            payload_class: dict[str, Any] = {
                "likely_market_data": False,
                "evidence": [],
                "keys_found": [],
                "symbol_detected": None,
            }
            body_size = 0
            body_redactions: list[str] = []

            # Lê o corpo SOMENTE se a URL contiver palavras-chave de mercado
            if is_market_candidate:
                is_textual = any(
                    t in content_type.lower()
                    for t in ["json", "text", "javascript", "plain", "csv", "xml"]
                ) or not content_type

                if is_textual:
                    try:
                        raw_body = await response.text()
                        body_size = len(raw_body)
                        # Limita o corpo a 10.000 caracteres
                        truncated_body = raw_body[:10000]
                        body_preview, body_redactions = SanitizationEngine.sanitize_text(truncated_body)
                        payload_class = TrafficClassifier.classify_payload(truncated_body)
                    except Exception as e:
                        body_preview = f"<body_read_error: {type(e).__name__}>"
                        self.output_mgr.log_error(f"Erro ao ler corpo da resposta de {sanitized_url}", e)
                else:
                    body_preview = f"<{content_type}; binary_or_stream>"
                    try:
                        raw_bytes = await response.body()
                        body_size = len(raw_bytes)
                    except Exception:
                        body_size = 0

            self.output_mgr.stats["total_responses"] += 1
            is_relevant = payload_class.get("likely_market_data", False) or (
                is_market_candidate and url_classification in ["candle", "history", "tick", "quote"]
            )
            if is_relevant:
                self.output_mgr.stats["relevant_responses"] += 1

            data = {
                "status": status,
                "content_type": content_type,
                "body_size": body_size,
                "body_preview": body_preview if body_preview else None,
                "likely_market_data": payload_class.get("likely_market_data", False),
                "evidence": payload_class.get("evidence", []),
                "keys_found": payload_class.get("keys_found", []),
                "symbol_detected": payload_class.get("symbol_detected"),
            }

            all_redactions = red_url + red_frame + body_redactions
            await self.output_mgr.record_event(
                event_type="http_response",
                source="network_response",
                url=raw_url,
                frame_url=frame_url,
                classification=url_classification,
                data=data,
                redactions=all_redactions,
                is_relevant=is_relevant,
            )

            if is_relevant:
                self.logger.info(
                    f"📊 [RESPOSTA RELEVANTE] Status {status} | URL: {sanitized_url[:75]} | "
                    f"Ativo: {payload_class.get('symbol_detected') or 'N/A'} | Evidência: {payload_class.get('evidence')}"
                )
        except Exception as e:
            self.output_mgr.log_error("Erro no manipulador de response", e)

    async def _handle_request_failed(self, request: Request) -> None:
        """Captura falhas de conexão/requisições abortadas."""
        try:
            self.output_mgr.stats["failed_requests"] += 1
            raw_url = request.url
            failure = request.failure
            error_text = failure if failure else "Unknown failure"
            frame_url = request.frame.url if request.frame else ""

            await self.output_mgr.record_event(
                event_type="http_failed",
                source="network_request",
                url=raw_url,
                frame_url=frame_url,
                classification=TrafficClassifier.classify_url(raw_url),
                data={"failure_text": str(error_text), "method": request.method},
            )
        except Exception as e:
            self.output_mgr.log_error("Erro no manipulador de request_failed", e)

    def _setup_websocket_handlers(self, ws: WebSocket, frame_url: str) -> None:
        """Configura ouvintes de eventos para um canal WebSocket detectado."""
        raw_url = ws.url
        sanitized_url, red_url = SanitizationEngine.sanitize_url(raw_url)
        conn_id = self._hash_ws_url(raw_url)

        self.output_mgr.register_ws_connection(conn_id, sanitized_url)
        self.logger.info(f"🔌 [WEBSOCKET CONECTADO] ID: {conn_id} | URL: {sanitized_url[:80]}")

        # Registra evento de criação
        asyncio.create_task(
            self.output_mgr.record_event(
                event_type="ws_created",
                source="websocket",
                url=raw_url,
                frame_url=frame_url,
                classification="websocket",
                data={"conn_id": conn_id},
                redactions=red_url,
            )
        )

        def _on_frame(direction: str, payload: Any) -> None:
            """Handler interno e unificado para frames enviados/recebidos."""
            try:
                now_iso = datetime.now(timezone.utc).isoformat()
                is_binary = isinstance(payload, bytes)
                payload_type = "binary" if is_binary else "text"
                opcode = 2 if is_binary else 1
                size = len(payload)

                preview_text = ""
                red_frame_body: list[str] = []
                payload_analysis: dict[str, Any] = {
                    "likely_market_data": False,
                    "evidence": [],
                    "keys_found": [],
                    "symbol_detected": None,
                }

                if is_binary:
                    # Primeiros 128 bytes em formato hexadecimal legível
                    hex_slice = payload[:128].hex(" ")
                    preview_text = f"<hex {size} bytes>: {hex_slice}"
                else:
                    # Texto limitado a 4.000 caracteres e sanitizado
                    sanitized_text, red_frame_body = SanitizationEngine.sanitize_text(payload[:4000])
                    preview_text = sanitized_text
                    payload_analysis = TrafficClassifier.classify_payload(payload)

                is_market = payload_analysis.get("likely_market_data", False)
                symbol = payload_analysis.get("symbol_detected")

                # Atualiza resumo
                self.output_mgr.register_ws_frame(
                    conn_id=conn_id,
                    direction=direction,
                    size=size,
                    symbol=symbol,
                    is_market=is_market,
                )

                event_data = {
                    "conn_id": conn_id,
                    "direction": direction,
                    "opcode": opcode,
                    "payload_type": payload_type,
                    "size_bytes": size,
                    "preview": preview_text,
                    "likely_market_data": is_market,
                    "evidence": payload_analysis.get("evidence", []),
                    "keys_found": payload_analysis.get("keys_found", []),
                    "symbol_detected": symbol,
                }

                asyncio.create_task(
                    self.output_mgr.record_event(
                        event_type=f"ws_frame_{direction}",
                        source="websocket",
                        url=raw_url,
                        frame_url=frame_url,
                        classification="websocket",
                        data=event_data,
                        redactions=red_url + red_frame_body,
                        is_relevant=is_market,
                    )
                )

                if is_market:
                    self.logger.info(
                        f"⚡ [WS {direction.upper()} MARKET] Conn: {conn_id} | Ativo: {symbol or 'N/A'} | "
                        f"Evidência: {payload_analysis.get('evidence')}"
                    )
            except Exception as ex:
                self.output_mgr.log_error(f"Erro ao processar frame WS {conn_id}", ex)

        # Configuração dos ouvintes Playwright
        ws.on("framereceived", lambda data: _on_frame("received", data))
        ws.on("framesent", lambda data: _on_frame("sent", data))

        def _on_close() -> None:
            self.output_mgr.close_ws_connection(conn_id)
            self.logger.info(f"🔌 [WEBSOCKET FECHADO] Conn: {conn_id}")
            asyncio.create_task(
                self.output_mgr.record_event(
                    event_type="ws_closed",
                    source="websocket",
                    url=raw_url,
                    frame_url=frame_url,
                    classification="websocket",
                    data={"conn_id": conn_id},
                    redactions=red_url,
                )
            )

        def _on_error(err: Any) -> None:
            self.output_mgr.log_error(f"Erro no WebSocket {conn_id}: {err}")
            asyncio.create_task(
                self.output_mgr.record_event(
                    event_type="ws_error",
                    source="websocket",
                    url=raw_url,
                    frame_url=frame_url,
                    classification="websocket",
                    data={"conn_id": conn_id, "error": str(err)},
                    redactions=red_url,
                )
            )

        ws.on("close", _on_close)
        ws.on("socketerror", _on_error)

    async def _inspect_dom_passively(self, page: Page) -> None:
        """
        Inspeção passiva e segura de elementos do DOM.
        Apenas verifica existência e atributos estruturais. NUNCA clica ou altera valores.
        """
        try:
            dom_eval_script = """
            () => {
                const selectors = {
                    "btnBuy": ["#btnBuy", "[id*='btnBuy']", "[class*='btnBuy']", "button[data-testid*='buy']"],
                    "btnSell": ["#btnSell", "[id*='btnSell']", "[class*='btnSell']", "button[data-testid*='sell']"],
                    "amountInput": ["#amountInput", "input[name*='amount']", "input[class*='amount']"],
                    "tradingChart": ["#tradingChart", "[id*='tradingChart']", "[class*='tradingChart']"],
                    "iframes": ["iframe"],
                    "canvases": ["canvas"],
                    "svgs": ["svg"]
                };
                const results = {};
                for (const [key, selList] of Object.entries(selectors)) {
                    results[key] = { count: 0, matches: [] };
                    for (const sel of selList) {
                        try {
                            const found = document.querySelectorAll(sel);
                            if (found.length > 0) {
                                results[key].count += found.length;
                                for (let i = 0; i < Math.min(found.length, 3); i++) {
                                    const el = found[i];
                                    results[key].matches.push({
                                        selector: sel,
                                        tag: el.tagName.toLowerCase(),
                                        id: el.id || null,
                                        className: el.className || null,
                                        src: el.src ? el.src.substring(0, 150) : null
                                    });
                                }
                            }
                        } catch (e) {}
                    }
                }
                return results;
            }
            """
            dom_results = await page.evaluate(dom_eval_script)
            sanitized_url, _ = SanitizationEngine.sanitize_url(page.url)

            await self.output_mgr.record_event(
                event_type="dom_inspection",
                source="dom",
                url=page.url,
                classification="chart",
                data={
                    "page_title": await page.title(),
                    "dom_summary": dom_results,
                },
            )
        except Exception as e:
            self.output_mgr.log_error("Erro durante inspeção de DOM passiva", e)

    async def _frame_monitor_loop(self, page: Page) -> None:
        """Loop a cada 2 segundos para inspecionar hierarquia de iframes."""
        last_frame_count = 0
        while not self.stop_event.is_set():
            try:
                current_frames = page.frames
                if len(current_frames) != last_frame_count or self.verbose:
                    last_frame_count = len(current_frames)
                    if self.verbose:
                        self.logger.debug(f"🔍 Frames ativos no momento: {len(current_frames)}")

                for frame in current_frames:
                    f_url = frame.url
                    f_name = frame.name
                    p_url = frame.parent_frame.url if frame.parent_frame else ""
                    self.output_mgr.register_frame(f_name, f_url, p_url)

                # Salva snapshot periódico de frames
                self.output_mgr.flush_summaries()

            except Exception as e:
                self.output_mgr.log_error("Erro no loop de monitoramento de frames", e)

            try:
                await asyncio.sleep(2.0)
            except asyncio.CancelledError:
                break

    def print_terminal_banner(self) -> None:
        """Exibe o cabeçalho oficial com as garantias de segurança."""
        banner = (
            "\n"
            + "=" * 80 + "\n"
            "🚀 B2TRADING INSPECTOR — Observador Passivo de Mercado\n"
            "🔒 MODO SOMENTE LEITURA ATIVO | NENHUMA ORDEM SERÁ ENVIADA\n"
            "🛡️ REGRAS: Sem cliques em BUY/SELL, sem alteração de valor, sem injeção WS\n"
            "⚠️ LOGIN MANUAL NECESSÁRIO: Faça login no navegador aberto\n"
            + "=" * 80 + "\n"
            f"🎯 URL Alvo:           {self.target_url}\n"
            f"📁 Perfil Navegador:   {self.profile_dir}\n"
            f"💾 Diretório de Saída: {self.output_dir}\n"
            f"⏱️ Duração:            {f'{self.duration}s' if self.duration else 'Indeterminada (até Ctrl+C)'}\n"
            + "=" * 80 + "\n"
        )
        print(banner, flush=True)

    def print_terminal_status(self) -> None:
        """Imprime resumo do status atualizado no terminal."""
        stats = self.output_mgr.stats
        status_box = (
            "\n--- STATUS ATUAL DA INSPEÇÃO ---\n"
            f"📡 Requests Capturadas:      {stats['total_requests']}\n"
            f"📥 Respostas Capturadas:     {stats['total_responses']}\n"
            f"⭐ Respostas Relevantes:     {stats['relevant_responses']}\n"
            f"🔌 Conexões WebSocket:       {stats['total_ws_connections']} "
            f"(RX: {stats['ws_frames_received']} | TX: {stats['ws_frames_sent']})\n"
            f"🏷️ Último Ativo Detectado:   {stats['last_detected_symbol'] or 'Nenhum ainda'}\n"
            f"🕒 Último Evento:            {stats['last_event_time'] or 'Aguardando tráfego'}\n"
            f"📂 Arquivos:                 {self.output_dir}\n"
            "--------------------------------\n"
        )
        print(status_box, flush=True)

    async def run(self) -> None:
        """Execução orquestrada do inspetor."""
        self.print_terminal_banner()

        async with async_playwright() as playwright:
            self.logger.info("Iniciando Chromium visível com contexto persistente...")
            
            # Contexto persistente para manter a sessão após login manual
            context: BrowserContext = await playwright.chromium.launch_persistent_context(
                user_data_dir=str(self.profile_dir),
                headless=False,
                viewport={"width": 1920, "height": 1080},
                slow_mo=self.slow_mo or 0,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-default-browser-check",
                ],
            )

            # Usa a página existente ou abre nova
            page = context.pages[0] if context.pages else await context.new_page()

            # Configura interceptores e ouvintes de rede no contexto/página
            page.on("request", lambda req: asyncio.create_task(self._handle_request(req)))
            page.on("response", lambda res: asyncio.create_task(self._handle_response(res)))
            page.on("requestfailed", lambda req: asyncio.create_task(self._handle_request_failed(req)))
            page.on(
                "websocket",
                lambda ws: self._setup_websocket_handlers(ws, page.url),
            )

            # Navegação inicial
            self.logger.info(f"Navegando para {self.target_url}...")
            try:
                await page.goto(self.target_url, wait_until="domcontentloaded", timeout=60000)
            except Exception as e:
                self.output_mgr.log_error("Erro de navegação inicial (tolerável)", e)
                self.logger.warning(f"Navegação inicial teve aviso/timeout: {e}")

            # Identifica e exibe estado inicial
            await asyncio.sleep(2.0)
            curr_url = page.url
            curr_title = await page.title()
            sanitized_curr_url, _ = SanitizationEngine.sanitize_url(curr_url)
            print(f"\n📍 URL Atual:  {sanitized_curr_url}")
            print(f"📑 Título:     {curr_title}")
            print(f"🖼️ Frames Iniciais: {len(page.frames)}")
            for idx, fr in enumerate(page.frames):
                s_url, _ = SanitizationEngine.sanitize_url(fr.url)
                print(f"   [{idx}] Name: '{fr.name or '<unnamed>'}' | URL: {s_url}")

            # Inspeção inicial do DOM passivo
            await self._inspect_dom_passively(page)

            # Inicia tarefa em background de monitoramento de frames
            frame_task = asyncio.create_task(self._frame_monitor_loop(page))

            # Espera login manual se interativo
            if not self.no_wait and sys.stdin.isatty():
                print(
                    "\n"
                    "================================================================================\n"
                    "👉 INSTRUÇÃO: Faça seu login manualmente na janela do navegador.\n"
                    "👉 Quando o gráfico e a plataforma estiverem carregados, pressione [ENTER]\n"
                    "   aqui no terminal para continuar o monitoramento detalhado.\n"
                    "================================================================================\n",
                    flush=True,
                )
                try:
                    await asyncio.to_thread(input, "Pressione [ENTER] quando concluir o login manual: ")
                    print("\n✅ Login manual confirmado pelo operador. Continuando captura contínua...", flush=True)
                except Exception:
                    pass
            else:
                self.logger.info("Modo não-interativo ou --no-wait ativo. Prosseguindo captura diretamente.")

            # Segunda inspeção passiva pós-login
            await self._inspect_dom_passively(page)
            self.print_terminal_status()

            # Loop principal de monitoramento
            start_loop = asyncio.get_event_loop().time()
            try:
                while not self.stop_event.is_set():
                    elapsed = asyncio.get_event_loop().time() - start_loop
                    if self.duration and elapsed >= self.duration:
                        self.logger.info(f"⏱️ Duração limite de {self.duration}s atingida. Encerrando inspeção.")
                        break

                    await asyncio.sleep(5.0)
                    self.print_terminal_status()

            except (asyncio.CancelledError, KeyboardInterrupt):
                self.logger.info("Interrupção solicitada pelo usuário (Ctrl+C).")
            finally:
                self.stop_event.set()
                frame_task.cancel()
                try:
                    await frame_task
                except asyncio.CancelledError:
                    pass

                self.logger.info("Finalizando e persistindo sumários...")
                self.output_mgr.flush_summaries()

                try:
                    await context.close()
                except Exception as e:
                    self.output_mgr.log_error("Erro ao fechar contexto do navegador", e)

                self.print_terminal_status()
                print(f"\n🎉 Inspeção finalizada com sucesso! Todos os arquivos salvos em:\n   {self.output_dir}\n")


def parse_arguments() -> argparse.Namespace:
    """Configura o parser CLI da ferramenta."""
    parser = argparse.ArgumentParser(
        description="b2trading_inspector - Ferramenta segura e somente leitura para diagnóstico da B2Trading."
    )
    parser.add_argument(
        "--url",
        type=str,
        default="https://traderoom.b2trading.io/",
        help="URL alvo da plataforma (padrão: https://traderoom.b2trading.io/)",
    )
    parser.add_argument(
        "--profile",
        type=str,
        default="./browser-profile",
        help="Diretório de perfil persistente do navegador (padrão: ./browser-profile)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="./inspection-output",
        help="Diretório para gravação dos relatórios e logs (padrão: ./inspection-output)",
    )
    parser.add_argument(
        "--duration",
        type=int,
        default=None,
        help="Duração máxima da captura em segundos (opcional)",
    )
    parser.add_argument(
        "--slow-mo",
        type=int,
        default=None,
        help="Atraso intencional em milissegundos entre ações do Playwright",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Ativa mensagens detalhadas de log no console",
    )
    parser.add_argument(
        "--no-wait",
        action="store_true",
        help="Não aguarda a tecla Enter após abertura (útil para execuções automatizadas e testes)",
    )
    return parser.parse_args()


async def main_async() -> None:
    """Ponto de entrada assíncrono."""
    args = parse_arguments()
    inspector = B2TradingInspector(
        url=args.url,
        profile_dir=args.profile,
        output_dir=args.output,
        duration=args.duration,
        slow_mo=args.slow_mo,
        verbose=args.verbose,
        no_wait=args.no_wait,
    )
    await inspector.run()


def main() -> None:
    """Ponto de entrada síncrono compatível com CLI."""
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\n[Encerrado pelo usuário]")
    except Exception as e:
        print(f"\n[ERRO FATAL]: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
