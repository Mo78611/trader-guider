"""
Trader Guider — MT5 Bridge
==========================
Runs on the USER'S WINDOWS PC (the MetaTrader5 Python package is Windows-only
and talks to a locally-installed MT5 terminal on the same machine).

Install:
    pip install -r requirements.txt
    copy .env.example .env   (edit values)
    python app.py            -> http://127.0.0.1:5001

SAFETY MODEL (read before touching):
  * DRY_RUN=true (default): every order/close request is validated and LOGGED
    only. Nothing reaches the broker. This is the safe default.
  * LIVE_TRADING=true is required before ANY real order path is armed.
  * Even then, only DEMO accounts are allowed unless ALLOW_REAL_ACCOUNT=true
    is set explicitly. Real-money trading through this bridge needs your
    conscious, written-down decision — not a default.
  * Every market order sent through /api/mt5/order MUST include broker-side
    SL and TP (sl/tp are required fields; 0 is rejected for live orders).
"""
import os
import logging
from datetime import datetime
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format="%(asctime)s [mt5-bridge] %(message)s")
log = logging.getLogger("mt5-bridge")

DRY_RUN = os.environ.get("DRY_RUN", "true").lower() != "false"
LIVE_TRADING = os.environ.get("LIVE_TRADING", "false").lower() == "true"
ALLOW_REAL_ACCOUNT = os.environ.get("ALLOW_REAL_ACCOUNT", "false").lower() == "true"
PORT = int(os.environ.get("MT5_BRIDGE_PORT", "5001"))

app = Flask(__name__)

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    log.warning("MetaTrader5 package not installed (expected on non-Windows dev machines).")


def guard_live():
    """Returns (ok, error_response). Central safety gate for order paths."""
    if DRY_RUN:
        return False, (jsonify({"dryRun": True,
                                "note": "DRY_RUN=true — request logged only, nothing sent to broker."}), 200)
    if not LIVE_TRADING:
        return False, (jsonify({"error": "live_trading_disabled",
                                "detail": "Set LIVE_TRADING=true in .env to arm order execution."}), 403)
    if not MT5_AVAILABLE:
        return False, (jsonify({"error": "mt5_unavailable",
                                "detail": "MetaTrader5 package not importable on this machine."}), 500)
    if not mt5.initialize():
        return False, (jsonify({"error": "mt5_init_failed", "detail": str(mt5.last_error())}), 500)
    acc = mt5.account_info()
    if acc is None:
        return False, (jsonify({"error": "no_mt5_login", "detail": "Log in to MT5 terminal first."}), 500)
    # trade_mode: 0=demo, 1=contest, 2=real
    if acc.trade_mode == 2 and not ALLOW_REAL_ACCOUNT:
        return False, (jsonify({"error": "real_account_blocked",
                                "detail": "Real account detected. Set ALLOW_REAL_ACCOUNT=true only if you mean it."}), 403)
    return True, None


@app.get("/api/mt5/health")
def health():
    return jsonify({
        "ok": True, "service": "mt5-bridge",
        "dry_run": DRY_RUN, "live_trading": LIVE_TRADING and not DRY_RUN,
        "mt5_package": MT5_AVAILABLE,
        "time": datetime.utcnow().isoformat() + "Z",
    })


@app.get("/api/mt5/status")
def mt5_status():
    """Lightweight login state — used by the web UI status pill."""
    if not MT5_AVAILABLE:
        return jsonify({"terminal": False, "logged_in": False, "reason": "mt5_unavailable"})
    if not mt5.initialize():
        return jsonify({"terminal": False, "logged_in": False, "reason": "init_failed"})
    acc = mt5.account_info()
    if acc is None:
        return jsonify({"terminal": True, "logged_in": False})
    return jsonify({
        "terminal": True, "logged_in": True,
        "login": acc.login, "server": acc.server, "currency": acc.currency,
        "trade_mode": acc.trade_mode,  # 0 demo, 1 contest, 2 real
        "trade_allowed": bool(getattr(acc, "trade_allowed", True)),
    })


@app.post("/api/mt5/connect")
def mt5_connect():
    """Log the local MT5 terminal into an account.
    Body: {server, account_id, password}.
    The password is used ONLY for this login call — it is never stored,
    never logged, never returned."""
    body = request.get_json(force=True, silent=True) or {}
    server = str(body.get("server", "")).strip()
    try:
        login = int(body.get("account_id", 0) or 0)
    except (TypeError, ValueError):
        login = 0
    password = str(body.get("password", ""))
    if not server or not login or not password:
        return jsonify({"error": "server_account_password_required"}), 400
    if not MT5_AVAILABLE:
        return jsonify({"error": "mt5_unavailable"}), 500
    if not mt5.initialize():
        return jsonify({"error": "mt5_init_failed", "detail": str(mt5.last_error())}), 500
    ok = mt5.login(login, password=password, server=server)
    # drop the secret from memory as soon as the call is done
    password = None
    body = None
    if not ok:
        return jsonify({"error": "login_failed", "detail": str(mt5.last_error())}), 401
    acc = mt5.account_info()
    if acc is None:
        return jsonify({"error": "login_failed", "detail": "no account info after login"}), 401
    log.info("MT5 login ok: %s @ %s (mode=%s)", acc.login, acc.server, acc.trade_mode)
    return jsonify({"ok": True, "account": {
        "login": acc.login, "server": acc.server, "currency": acc.currency,
        "balance": acc.balance, "equity": acc.equity, "margin_free": acc.margin_free,
        "trade_mode": acc.trade_mode, "name": acc.name,
    }})


@app.get("/api/mt5/account")
def account():
    if not MT5_AVAILABLE:
        return jsonify({"error": "mt5_unavailable"}), 500
    if not mt5.initialize():
        return jsonify({"error": "mt5_init_failed", "detail": str(mt5.last_error())}), 500
    acc = mt5.account_info()
    if acc is None:
        return jsonify({"error": "no_mt5_login"}), 500
    return jsonify({"account": {
        "login": acc.login, "server": acc.server, "currency": acc.currency,
        "balance": acc.balance, "equity": acc.equity, "margin_free": acc.margin_free,
        "trade_mode": acc.trade_mode,  # 0 demo, 1 contest, 2 real
        "name": acc.name,
    }})


@app.get("/api/mt5/positions")
def positions():
    if not MT5_AVAILABLE:
        return jsonify({"error": "mt5_unavailable"}), 500
    if not mt5.initialize():
        return jsonify({"error": "mt5_init_failed"}), 500
    poss = mt5.positions_get() or []
    return jsonify({"positions": [{
        "ticket": p.ticket, "symbol": p.symbol, "type": p.type,
        "volume": p.volume, "price_open": p.price_open, "price_current": p.price_current,
        "sl": p.sl, "tp": p.tp, "profit": p.profit, "comment": p.comment,
    } for p in poss]})


def _fill_order_request(symbol, action, volume, sl, tp):
    """Build a market order request with broker-side SL/TP. Returns (request, error)."""
    if action not in ("buy", "sell"):
        return None, "action must be 'buy' or 'sell'"
    if volume <= 0:
        return None, "volume must be > 0"
    if sl <= 0 or tp <= 0:
        return None, "sl and tp are REQUIRED (broker-side protection, no naked orders)"
    sym_info = mt5.symbol_info(symbol)
    if sym_info is None:
        return None, f"unknown symbol {symbol}"
    if not sym_info.visible:
        mt5.symbol_select(symbol, True)
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return None, f"no tick for {symbol}"
    order_type = mt5.ORDER_TYPE_BUY if action == "buy" else mt5.ORDER_TYPE_SELL
    price = tick.ask if action == "buy" else tick.bid
    # sanity: SL/TP on the correct side of entry
    if action == "buy" and (sl >= price or tp <= price):
        return None, "for BUY: sl < price < tp required"
    if action == "sell" and (sl <= price or tp >= price):
        return None, "for SELL: tp < price < sl required"
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(volume),
        "type": order_type,
        "price": price,
        "sl": float(sl),
        "tp": float(tp),
        "deviation": 20,
        "magic": 20261019,
        "comment": "trader-guider",
        "type_time": mt5.ORDER_TIME_GTC,
        # filling mode: try IOC, fallback handled by caller
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    return req, None


@app.post("/api/mt5/order")
def order():
    body = request.get_json(force=True, silent=True) or {}
    symbol = str(body.get("symbol", "")).upper()
    action = str(body.get("action", "")).lower()
    volume = float(body.get("volume", 0) or 0)
    sl = float(body.get("sl", 0) or 0)
    tp = float(body.get("tp", 0) or 0)

    if DRY_RUN:
        log.info("DRY_RUN order logged only: %s %s %s vol=%s sl=%s tp=%s",
                 action, symbol, volume, sl, tp)
        return jsonify({"dryRun": True, "order": body,
                        "note": "DRY_RUN=true — nothing sent to broker."})

    ok, err = guard_live()
    if not ok:
        return err
    req, req_err = _fill_order_request(symbol, action, volume, sl, tp)
    if req_err:
        return jsonify({"error": "invalid_order", "detail": req_err}), 400
    result = mt5.order_send(req)
    if result is None:
        # retry once with FOK filling (some brokers reject IOC)
        req["type_filling"] = mt5.ORDER_FILLING_FOK
        result = mt5.order_send(req)
    if result is None:
        return jsonify({"error": "order_send_failed", "detail": str(mt5.last_error())}), 502
    log.info("Order sent: retcode=%s ticket=%s", result.retcode, result.order)
    return jsonify({
        "retcode": result.retcode, "ticket": result.order, "deal": result.deal,
        "price": result.price, "volume": result.volume, "comment": result.comment,
    })


@app.post("/api/mt5/close")
def close():
    body = request.get_json(force=True, silent=True) or {}
    ticket = int(body.get("ticket", 0) or 0)
    if DRY_RUN:
        log.info("DRY_RUN close logged only: ticket=%s", ticket)
        return jsonify({"dryRun": True, "ticket": ticket,
                        "note": "DRY_RUN=true — nothing sent to broker."})
    ok, err = guard_live()
    if not ok:
        return err
    poss = mt5.positions_get(ticket=ticket)
    if not poss:
        return jsonify({"error": "position_not_found"}), 404
    p = poss[0]
    tick = mt5.symbol_info_tick(p.symbol)
    close_type = mt5.ORDER_TYPE_SELL if p.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask
    req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": p.volume,
           "type": close_type, "position": ticket, "price": price, "deviation": 20,
           "magic": 20261019, "comment": "trader-guider-close",
           "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC}
    result = mt5.order_send(req)
    if result is None:
        return jsonify({"error": "close_failed", "detail": str(mt5.last_error())}), 502
    return jsonify({"retcode": result.retcode, "ticket": ticket})


@app.post("/api/mt5/modify")
def modify():
    """Move SL/TP of an open position (auto break-even path).
    Body: {ticket, sl, tp?}. Goes through the same live-trading gate."""
    body = request.get_json(force=True, silent=True) or {}
    try:
        ticket = int(body.get("ticket", 0) or 0)
    except (TypeError, ValueError):
        ticket = 0
    sl = float(body.get("sl", 0) or 0)
    tp = float(body.get("tp", 0) or 0)
    if not ticket or sl <= 0:
        return jsonify({"error": "ticket_and_sl_required"}), 400
    if DRY_RUN:
        log.info("DRY_RUN modify logged only: ticket=%s sl=%s tp=%s", ticket, sl, tp)
        return jsonify({"dryRun": True, "ticket": ticket, "sl": sl,
                        "note": "DRY_RUN=true — nothing sent to broker."})
    ok, err = guard_live()
    if not ok:
        return err
    poss = mt5.positions_get(ticket=ticket)
    if not poss:
        return jsonify({"error": "position_not_found"}), 404
    p = poss[0]
    req = {"action": mt5.TRADE_ACTION_SLTP, "symbol": p.symbol,
           "position": ticket, "sl": sl,
           "magic": 20261019, "comment": "trader-guider-modify"}
    if tp > 0:
        req["tp"] = tp
    result = mt5.order_send(req)
    if result is None:
        return jsonify({"error": "modify_failed", "detail": str(mt5.last_error())}), 502
    log.info("Modified ticket=%s retcode=%s sl=%s", ticket, result.retcode, sl)
    return jsonify({"retcode": result.retcode, "ticket": ticket, "sl": sl})


@app.post("/api/mt5/close_partial")
def close_partial():
    """Close part of a position (auto-partial path). Body: {ticket, volume}."""
    body = request.get_json(force=True, silent=True) or {}
    try:
        ticket = int(body.get("ticket", 0) or 0)
    except (TypeError, ValueError):
        ticket = 0
    volume = float(body.get("volume", 0) or 0)
    if not ticket or volume <= 0:
        return jsonify({"error": "ticket_and_volume_required"}), 400
    if DRY_RUN:
        log.info("DRY_RUN close_partial logged only: ticket=%s volume=%s", ticket, volume)
        return jsonify({"dryRun": True, "ticket": ticket, "volume": volume,
                        "note": "DRY_RUN=true — nothing sent to broker."})
    ok, err = guard_live()
    if not ok:
        return err
    poss = mt5.positions_get(ticket=ticket)
    if not poss:
        return jsonify({"error": "position_not_found"}), 404
    p = poss[0]
    if volume >= p.volume:
        return jsonify({"error": "use_close_for_full", "detail": "volume >= position volume; use /close instead"}), 400
    tick = mt5.symbol_info_tick(p.symbol)
    close_type = mt5.ORDER_TYPE_SELL if p.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask
    req = {"action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": volume,
           "type": close_type, "position": ticket, "price": price, "deviation": 20,
           "magic": 20261019, "comment": "trader-guider-partial",
           "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC}
    result = mt5.order_send(req)
    if result is None:
        return jsonify({"error": "close_partial_failed", "detail": str(mt5.last_error())}), 502
    log.info("Partial close ticket=%s vol=%s retcode=%s", ticket, volume, result.retcode)
    return jsonify({"retcode": result.retcode, "ticket": ticket, "volume": volume})


if __name__ == "__main__":
    log.info("DRY_RUN=%s LIVE_TRADING=%s ALLOW_REAL_ACCOUNT=%s",
             DRY_RUN, LIVE_TRADING, ALLOW_REAL_ACCOUNT)
    app.run(host="127.0.0.1", port=PORT)
