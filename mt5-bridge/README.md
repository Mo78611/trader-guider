# MT5 Bridge (Windows)

Local Flask service connecting Trader Guider to your MetaTrader 5 terminal.

**Runs on your Windows PC** — the `MetaTrader5` Python package is Windows-only
and communicates with the MT5 terminal installed on the same machine.

```bat
cd mt5-bridge
pip install -r requirements.txt
copy .env.example .env
python app.py
```

Then the Trader Guider terminal (http://localhost:3000) shows
"MT5 bridge: connected" in the top bar, and the one-click panel works.

**Safety:** default `.env` has `DRY_RUN=true` — orders are logged only.
Arming live flow needs `DRY_RUN=false` + `LIVE_TRADING=true`, and real-money
accounts stay blocked unless `ALLOW_REAL_ACCOUNT=true`. Every live order
requires broker-side `sl` and `tp`.
